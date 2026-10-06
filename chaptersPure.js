'use strict';
/* Pure helpers of TSS Workflow 0.4.2 (no VS Code API): the chapters of a project for the "Розділи" panel. */

const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// a line without its comment (the part after an unescaped %)
function stripComment(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '%') return line.slice(0, i);
  }
  return line;
}

const clean = (t) => String(t).replace(/\\label\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();

// "a, b,\n c" -> ['a', 'b', 'c']; empty items and macros (\Chapters) are dropped
const splitList = (t) => String(t).split(',').map((x) => x.trim()).filter((x) => x && !/[\\{}\s]/.test(x));

// The chapters of the main file in the order of the file, grouped by \part:
//   `\includechapter{X}`            one chapter per macro (`macro`, tssworkflow.chapterIncludeMacro)
//   `\multiinclude{A, B, C}[]`      a comma list, may span lines (`listMacros`, tssworkflow.chapterListMacros)
// Returns [{ title: string|null, names: [...] }]; title is null for chapters before the first \part. Commented lines
// are skipped, a name that is repeated is listed once, parts without chapters are dropped.
function chapterStructure(mainText, macro, listMacros) {
  const code = String(mainText).split(/\r?\n/).map(stripComment).join('\n');
  const events = [];
  let m;
  const partRe = /\\part\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  while ((m = partRe.exec(code))) events.push({ i: m.index, part: clean(m[1]) });
  const one = new RegExp(escRe(macro || '\\includechapter') + '(?![A-Za-z])\\s*\\{\\s*([^{}\\s]+)\\s*\\}', 'g');
  while ((m = one.exec(code))) events.push({ i: m.index, names: [m[1]] });
  for (const lm of listMacros || []) {
    if (!lm) continue;
    const re = new RegExp(escRe(lm) + '(?![A-Za-z])\\s*\\{([^{}]*)\\}', 'g');
    while ((m = re.exec(code))) events.push({ i: m.index, names: splitList(m[1]) });
  }
  events.sort((a, b) => a.i - b.i);
  const parts = [];
  const seen = new Set();
  let cur = { title: null, names: [] };
  for (const e of events) {
    if (e.part !== undefined) {
      if (cur.names.length) parts.push(cur);
      cur = { title: e.part, names: [] };
    } else {
      for (const n of e.names) if (!seen.has(n)) { seen.add(n); cur.names.push(n); }
    }
  }
  if (cur.names.length) parts.push(cur);
  return parts;
}

// the names only (see chapterStructure)
function chapterNames(mainText, macro, listMacros) {
  return [].concat(...chapterStructure(mainText, macro, listMacros).map((p) => p.names));
}

/* ------------------- adding a chapter to a \multiinclude list (0.4.2) ------------------- */
// the text with every comment (from an unescaped % to the end of the line) replaced by spaces: same length, same offsets
function maskComments(text) {
  return String(text).split('\n').map((line) => {
    const code = stripComment(line);
    return code + ' '.repeat(line.length - code.length);
  }).join('\n');
}

// The comma lists of the main file, in file order: [{ part, macro, open, close, names }]. `open` and `close` are the
// offsets of the `{` and `}` of the list in the text; `part` is the title of the last \part before it (or null).
function listSlots(mainText, listMacros) {
  const text = String(mainText);
  const masked = maskComments(text);
  const events = [];
  let m;
  const partRe = /\\part\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
  while ((m = partRe.exec(masked))) events.push({ i: m.index, part: clean(m[1]) });
  for (const lm of listMacros || []) {
    if (!lm) continue;
    const re = new RegExp(escRe(lm) + '(?![A-Za-z])\\s*\\{([^{}]*)\\}', 'g');
    while ((m = re.exec(masked))) {
      events.push({ i: m.index, macro: lm, open: m.index + m[0].indexOf('{'), close: m.index + m[0].length - 1, names: splitList(m[1]) });
    }
  }
  events.sort((a, b) => a.i - b.i);
  const out = [];
  let part = null;
  for (const e of events) {
    if (e.part !== undefined) part = e.part;
    else out.push({ part, macro: e.macro, open: e.open, close: e.close, names: e.names });
  }
  return out;
}

// `name` at the end of the list `slot` (from listSlots), in the style of the list: a new line with the indent of the
// last item when the list is written one item per line (with a comma after it if the other items have one),
// `, name` when the whole list is on one line. Comments after the last item stay where they are.
function addToListAt(mainText, slot, name) {
  const text = String(mainText);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const masked = maskComments(text).slice(slot.open + 1, slot.close);
  const last = masked.search(/\S\s*$/);
  if (last < 0) return text.slice(0, slot.open + 1) + name + text.slice(slot.open + 1); // an empty list or only comments: nothing is removed
  const abs = slot.open + 1 + last;
  const comma = masked[last] === ',';
  const lineStart = text.lastIndexOf('\n', abs);
  let ins;
  if (lineStart < slot.open) {
    ins = comma ? ' ' + name + ',' : ', ' + name; // the list is on one line
  } else {
    const indent = /^[ \t]*/.exec(text.slice(lineStart + 1, abs + 1))[0];
    ins = (comma ? '' : ',') + eol + indent + name + (comma ? ',' : '');
  }
  return text.slice(0, abs + 1) + ins + text.slice(abs + 1);
}

// the title in the first \chapter{...} / \chapter*{...} of a file (empty when there is none)
function chapterTitle(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const code = stripComment(line);
    const m = /\\chapter\*?\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/.exec(code);
    if (m) return m[1].replace(/\\label\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
  }
  return '';
}

module.exports = { chapterNames, chapterStructure, chapterTitle, stripComment, splitList, maskComments, listSlots, addToListAt };
