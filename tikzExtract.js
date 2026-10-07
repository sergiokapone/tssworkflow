'use strict';
// Move tikzpicture / circuitikz environments out of a .tex file into tikz/<name>.tikz and put \localinput{<name>.tikz}
// in their place. The name comes from the \label of the enclosing figure (without the "tikz:" / "pic:" prefix).
const P = require('./pure');

const FIGURE_RE = /^[A-Za-z]*figure\*?$/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* ------------------------------ pure part ------------------------------ */
// every \begin{env} ... \end{env} (env in `envNames`) that is not commented out:
// [{ env, begin: {line, col}, end: {line, col} }]   col of `end` is just after \end{env}
function findPictures(lines, envNames) {
  const names = (envNames && envNames.length ? envNames : ['tikzpicture', 'circuitikz']).filter((n) => /^[A-Za-z*]+$/.test(n));
  if (!names.length) return [];
  const beginRe = new RegExp('\\\\begin\\{(' + names.map(esc).join('|') + ')\\}', 'g');
  const out = [];
  let line = 0;
  let col = 0;
  while (line < lines.length) {
    const code = P.codePart(lines[line]);
    beginRe.lastIndex = col;
    const m = beginRe.exec(code);
    if (!m) { line++; col = 0; continue; }
    const end = P.envEnd(lines, m[1], line, m.index + m[0].length);
    if (!end) { line++; col = 0; continue; }
    out.push({ env: m[1], begin: { line, col: m.index }, end: { line: end.line, col: end.col } });
    line = end.line;
    col = end.col;
  }
  return out;
}

const before = (a, b) => a.line < b.line || (a.line === b.line && a.col < b.col);

// inline pictures: \tikz[opts]{...} and \tikz \draw ...; (not \tikzset and the like): [{ env: 'tikz', inline: true, begin, end }].
// Those that sit inside one of `pics` (an environment picture) are left out: the environment is moved as a whole.
function findInlinePictures(lines, pics) {
  const text = lines.join('\n');
  const starts = [];
  let o = 0;
  for (const l of lines) { starts.push(o); o += l.length + 1; }
  const pos = (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo, col: off - starts[lo] };
  };
  const out = [];
  for (const [a, b] of P.tikzInlineRanges(text, [])) {
    if (!/^\\tikz(?![A-Za-z@])/.test(text.slice(a, a + 6))) continue;
    const begin = pos(a);
    const end = pos(b);
    if ((pics || []).some((p) => !before(begin, p.begin) && !before(p.end, end))) continue;
    out.push({ env: 'tikz', inline: true, begin, end });
  }
  return out;
}

// environment pictures and (with `inline`) inline \tikz pictures, in the order of the source
function allPictures(lines, envNames, inline) {
  const envs = findPictures(lines, envNames);
  if (!inline) return envs;
  return envs.concat(findInlinePictures(lines, envs)).sort((x, y) => (before(x.begin, y.begin) ? -1 : before(y.begin, x.begin) ? 1 : 0));
}

// innermost figure-like environment around position `pos`: { name, from: {line,col}, to: {line,col} } or null
function enclosingFigure(lines, pos) {
  const stack = [];
  const re = /\\(begin|end)\{([^{}]*)\}/g;
  for (let l = 0; l <= pos.line && l < lines.length; l++) {
    const code = P.codePart(lines[l]);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      if (l === pos.line && m.index >= pos.col) break;
      if (m[1] === 'begin') stack.push({ name: m[2], line: l, col: m.index, after: m.index + m[0].length });
      else {
        for (let k = stack.length - 1; k >= 0; k--) if (stack[k].name === m[2]) { stack.length = k; break; }
      }
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    if (!FIGURE_RE.test(stack[k].name)) continue;
    const e = P.envEnd(lines, stack[k].name, stack[k].line, stack[k].after);
    if (!e) continue;
    return { name: stack[k].name, from: { line: stack[k].line, col: stack[k].col }, to: { line: e.line, col: e.col } };
  }
  return null;
}

// \label names inside the figure but outside the picture itself (in the order of the source)
function figureLabels(lines, fig, pic) {
  const out = [];
  for (let l = fig.from.line; l <= fig.to.line; l++) {
    const code = P.codePart(lines[l]);
    const re = /\\label\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const at = { line: l, col: m.index };
      if (!before(at, pic.begin) && before(at, pic.end)) continue; // inside the picture
      out.push(m[1].trim());
    }
  }
  return out;
}

// "tikz:Efield" -> "Efield.tikz"; null when there is nothing usable
function nameFromLabel(label) {
  if (!label || /\\/.test(label)) return null; // \currfilebase and other macros
  let n = label.replace(/^[A-Za-z]+:/, '');
  n = n.replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^[._]+|[._]+$/g, '');
  if (!n) return null;
  return /\.tikz$/i.test(n) ? n : n + '.tikz';
}

// suggested file name of one picture
function suggestName(lines, pic) {
  const fig = enclosingFigure(lines, pic.begin);
  if (!fig) return { name: null, figure: null };
  const labels = figureLabels(lines, fig, pic).filter((l) => !/\\/.test(l));
  const pick = labels.find((l) => /^tikz:/i.test(l)) || labels[0];
  return { name: nameFromLabel(pick), figure: fig };
}

// the picture to work on at `pos`: the one that contains it, else the only picture of the enclosing figure
function pictureAt(lines, pictures, pos) {
  const hit = pictures.find((p) => !before(pos, p.begin) && !before(p.end, pos));
  if (hit) return { pic: hit };
  const fig = enclosingFigure(lines, pos);
  if (!fig) return { pic: null };
  const inside = pictures.filter((p) => !before(p.begin, fig.from) && !before(fig.to, p.end));
  if (inside.length === 1) return { pic: inside[0] };
  return { pic: null, many: inside.length > 1 };
}

// text of the .tikz file and the replacement for the range [begin, end)
function plan(lines, pic, name, eol) {
  eol = eol || '\n';
  const b = pic.begin;
  const e = pic.end;
  const block = [];
  for (let l = b.line; l <= e.line; l++) {
    let s = lines[l];
    if (l === e.line) s = s.slice(0, e.col);
    if (l === b.line) s = s.slice(b.col);
    block.push(s);
  }
  const lead = lines[b.line].slice(0, b.col);
  const indent = /^\s*$/.test(lead) ? lead : /^\s*/.exec(lead)[0];
  const dedented = block.map((s, i) => {
    if (i === 0) return s;
    if (indent && s.startsWith(indent)) return s.slice(indent.length);
    const own = /^\s*/.exec(s)[0].length;
    return s.slice(Math.min(own, indent.length));
  });
  while (dedented.length && !dedented[dedented.length - 1].trim()) dedented.pop();
  return { content: dedented.join(eol) + eol, replacement: '\\localinput{' + name + '}' };
}

const validName = (n) => /^[^\\/:*?"<>|\s]+$/.test(n) && !/^\.+$/.test(n);

/* ---------------------------- VS Code part ----------------------------- */
function register(context, helpers) {
  const vscode = require('vscode');
  const fs = require('fs');
  const path = require('path');
  const cfg = () => vscode.workspace.getConfiguration('tssworkflow');
  const info = (m, ...btn) => vscode.window.showInformationMessage(m, ...btn);
  const isTikzFile = (doc) => doc.uri.fsPath.toLowerCase().endsWith('.tikz');
  const docLines = (doc) => {
    const out = [];
    for (let i = 0; i < doc.lineCount; i++) out.push(doc.lineAt(i).text);
    return out;
  };
  const envNames = () => cfg().get('tikzExtractEnvs', ['tikzpicture', 'circuitikz']);
  const inlineOn = () => cfg().get('tikzExtractInline', true) !== false;
  const what = () => envNames().join(' / ') + (inlineOn() ? ' / \\tikz{…}' : '');
  const pictures = (lines) => allPictures(lines, envNames(), inlineOn());
  const tikzDir = (doc) => path.join(path.dirname(doc.uri.fsPath), 'tikz');
  const eolOf = (doc) => (doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');

  const askName = async (doc, suggested, why) => {
    const dir = tikzDir(doc);
    return vscode.window.showInputBox({
      prompt: why || "Ім'я файла для tikz/ (розширення .tikz можна не писати)",
      value: suggested ? suggested.replace(/\.tikz$/i, '') : '',
      validateInput: (v) => {
        const n = v.trim().replace(/\.tikz$/i, '');
        if (!n) return "Введи ім'я";
        if (!validName(n)) return "Недозволені символи в імені";
        if (fs.existsSync(path.join(dir, n + '.tikz'))) return 'Файл tikz/' + n + '.tikz уже існує';
        return null;
      }
    });
  };

  const openBtn = 'Відкрити';
  const offerOpen = async (msg, file) => {
    const pick = await info(msg, openBtn);
    if (pick === openBtn) await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)), { preview: false, preserveFocus: false });
  };

  async function extractOne() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || isTikzFile(ed.document) || ed.document.isUntitled) { info('Відкрий збережений .tex-файл з tikzpicture, circuitikz чи \\tikz{…}.'); return; }
    const doc = ed.document;
    const lines = docLines(doc);
    const pics = pictures(lines);
    if (!pics.length) { info('У файлі немає ' + what() + '.'); return; }
    const cur = ed.selection.active;
    const at = pictureAt(lines, pics, { line: cur.line, col: cur.character });
    if (!at.pic) { info(at.many ? 'У цьому рисунку кілька малюнків: постав курсор усередину потрібного.' : 'Постав курсор усередину ' + what() + '.'); return; }
    const pic = at.pic;
    const sug = suggestName(lines, pic);
    let name = sug.name;
    const dir = tikzDir(doc);
    if (!name || fs.existsSync(path.join(dir, name))) {
      const why = !name
        ? (sug.figure ? 'У рисунку немає \\label: ' : 'Малюнок не в figure: ') + "ім'я файла для tikz/"
        : 'Файл tikz/' + name + " уже існує: інше ім'я для tikz/";
      const typed = await askName(doc, name, why);
      if (!typed) return;
      name = typed.trim().replace(/\.tikz$/i, '') + '.tikz';
    }
    const p = plan(lines, pic, name, eolOf(doc));
    const target = path.join(dir, name);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, p.content, { encoding: 'utf8', flag: 'wx' });
    } catch (err) {
      vscode.window.showErrorMessage('Не вдалося створити ' + target + ': ' + (err && err.message ? err.message : err));
      return;
    }
    const ok = await ed.edit((b) => b.replace(new vscode.Range(pic.begin.line, pic.begin.col, pic.end.line, pic.end.col), p.replacement));
    if (!ok) { vscode.window.showErrorMessage('Файл ' + name + ' створено, але замінити код у документі не вдалося.'); return; }
    await offerOpen('Винесено в tikz/' + name + ' (Ctrl+Z повертає код у документ, файл лишається).', target);
  }

  async function extractAll() {
    const ed = vscode.window.activeTextEditor;
    if (!ed || isTikzFile(ed.document) || ed.document.isUntitled) { info('Відкрий збережений .tex-файл з tikzpicture, circuitikz чи \\tikz{…}.'); return; }
    const doc = ed.document;
    const lines = docLines(doc);
    let pics = pictures(lines);
    const sel = ed.selection;
    if (sel && !sel.isEmpty) pics = pics.filter((p) => p.begin.line >= sel.start.line && p.end.line <= sel.end.line);
    if (!pics.length) { info('Немає ' + what() + (sel && !sel.isEmpty ? ' у виділенні.' : ' у файлі.')); return; }
    const dir = tikzDir(doc);
    const used = new Set();
    const todo = [];
    const skipped = { nolabel: 0, taken: 0 };
    for (const pic of pics) {
      const name = suggestName(lines, pic).name;
      if (!name) { skipped.nolabel++; continue; }
      if (fs.existsSync(path.join(dir, name)) || used.has(name.toLowerCase())) { skipped.taken++; continue; }
      used.add(name.toLowerCase());
      todo.push({ pic, name });
    }
    if (!todo.length) { info('Нічого виносити: без мітки ' + skipped.nolabel + ', ім\'я зайняте ' + skipped.taken + '.'); return; }
    const msg = 'Винести ' + todo.length + ' з ' + pics.length + ' малюнків у tikz/ (' + todo.map((t) => t.name).slice(0, 6).join(', ') + (todo.length > 6 ? ', ...' : '') + ')?' +
      (skipped.nolabel + skipped.taken ? ' Пропущено: без мітки ' + skipped.nolabel + ", ім'я зайняте " + skipped.taken + '.' : '');
    const go = await vscode.window.showInformationMessage(msg, { modal: true }, 'Винести');
    if (go !== 'Винести') return;
    fs.mkdirSync(dir, { recursive: true });
    const eol = eolOf(doc);
    const edits = [];
    const written = [];
    for (const t of todo) {
      const p = plan(lines, t.pic, t.name, eol);
      try {
        fs.writeFileSync(path.join(dir, t.name), p.content, { encoding: 'utf8', flag: 'wx' });
        written.push(t.name);
        edits.push({ pic: t.pic, text: p.replacement });
      } catch (err) { skipped.taken++; }
    }
    const ok = await ed.edit((b) => {
      for (const e of edits) b.replace(new vscode.Range(e.pic.begin.line, e.pic.begin.col, e.pic.end.line, e.pic.end.col), e.text);
    });
    if (!ok) { vscode.window.showErrorMessage('Файли створено (' + written.length + '), але замінити код у документі не вдалося.'); return; }
    info('Винесено ' + written.length + ' малюнків у tikz/' + (skipped.nolabel + skipped.taken ? ' (пропущено: без мітки ' + skipped.nolabel + ", ім'я зайняте " + skipped.taken + ')' : '') + '. Ctrl+Z повертає код у документ, файли лишаються.');
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('tssworkflow.extractTikz', extractOne),
    vscode.commands.registerCommand('tssworkflow.extractTikzAll', extractAll)
  );
}

module.exports = { register, findPictures, findInlinePictures, allPictures, enclosingFigure, figureLabels, nameFromLabel, suggestName, pictureAt, plan, validName };
