'use strict';
/* logPure.js: what comes out of the build: pplatex, texlogsieve, the .log parser, "Missing character", hooks, the pass counter. No vscode. */

/* --------------------------- pplatex output ------------------------- */
// `pplatex -i job.log` prints blocks like
//   ** Warning in ./test.tex: No file chapter.tex.
//   ** Error   in ./test.tex, Line 9:
//      Undefined control sequence Something \unknown
// (documented in the pplatex README; the exact BadBox / "Warning ..., Line N" shapes are parsed tolerantly)
// -> [{ kind: 'Error'|'Warning'|'BadBox', file, line (0-based or null), endLine, message }]
function parsePplatex(text, overfullThreshold) {
  const head = /^\*\*\s+(Error|Warning|Bad\s?Box)\s+in\s+((?:[A-Za-z]:)?[^:]*?)(?:,\s*Lines?\s+(\d+)(?:\s*[-\u2013]\s*(\d+))?)?\s*:\s*(.*)$/i;
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    const parts = m[5] ? [m[5].trim()] : [];
    let j = i + 1;
    while (j < lines.length && /^\s+\S/.test(lines[j]) && !/^\*\*/.test(lines[j])) { parts.push(lines[j].trim()); j++; }
    i = j - 1;
    const kind = /^bad/i.test(m[1]) ? 'BadBox' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const message = parts.join(' ').replace(/\s+/g, ' ').trim() || kind;
    if (kind === 'BadBox' && overfullThreshold) {
      const w = /Overfull .hbox \((\d+(?:\.\d+)?)pt too wide\)/.exec(message);
      if (w && parseFloat(w[1]) <= overfullThreshold) continue;
    }
    out.push({
      kind,
      file: m[2].trim(),
      line: m[3] ? Math.max(0, parseInt(m[3], 10) - 1) : null,
      endLine: m[4] ? Math.max(0, parseInt(m[4], 10) - 1) : m[3] ? Math.max(0, parseInt(m[3], 10) - 1) : null,
      message
    });
  }
  return out;
}

/* ---------------------- errors straight from the .log --------------- */
// -file-line-error lines in <job>.log:  ./Plasma/Plasma.tex:197: Undefined control sequence.  (+ `l.197 \eras` below)
function parseLogErrors(log) {
  const lines = String(log).split(/\r?\n/);
  const re = /^((?:[A-Za-z]:)?[^\s:][^:]*?\.(?:tex|tikz|sty|cls|def|cfg|lua|aux|bbl|toc|out|lof|lot|ldf|fd|clo|sto|cut|ltx|pgf|dtx|ins)):(\d+):\s*(.+)$/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let ctx = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
      const c = /^l\.\d+\s*(.*)$/.exec(lines[j]);
      if (c) { ctx = c[1].trim(); break; }
      if (re.test(lines[j])) break;
    }
    const ln = parseInt(m[2], 10) - 1;
    out.push({ kind: 'Error', file: m[1], line: ln, endLine: ln, message: m[3].trim() + (ctx ? '  [' + ctx + ']' : '') });
  }
  return out;
}

/* ------------------------- texlogsieve output ----------------------- */
// `texlogsieve job.log` prints blocks like
//   From file ./Plasma/Plasma.tex:
//   pg 4: Overfull \hbox (14.7pt too wide) in paragraph at lines 53--194
//         Offending text: ...
//   pg 4: ./Plasma/Plasma.tex:197: Undefined control sequence.
//         l.197 \eras
//   After last page:
//   ====  Summary:  ====
//   Missing characters:
//       char X (U+041D), font cmmi12 in page 6 (file ./Plasma/Plasma.tex)
// -> [{ kind: 'Error'|'Warning'|'BadBox'|'Missing', file, line (0-based or null), endLine, message }]
/* ------------- Missing character: line from the log, honest hint ------------- */
// text of the diagnostic; `line` (1-based) is where the log context points, or null
function missingCharMessage(g, line) {
  const shown = g.chars.slice(0, 12).join(' ') + (g.chars.length > 12 ? ' …' : '');
  let msg = 'Немає гліфів у шрифті ' + g.font + ' (стор. ' + g.page + '): ' + shown + '.';
  if (line) {
    msg += ' Приблизно рядок ' + line + ': там TeX закінчив абзац чи сторінку, а сам символ може бути в колонтитулі, фоні або плаваючому обʼєкті.';
  }
  if (g.chars.some((c) => /[\u0400-\u04FF]/.test(c))) {
    msg += ' Схоже на кирилицю в математичному режимі: загорни її в \\text{...} або винеси з $...$';
  } else if (g.font === 'nullfont') {
    msg += ' Символ набрано без шрифту (nullfont): зазвичай це код, що виконується при виводі сторінки (колонтитул, фон, TikZ-накладка), або пакет, що друкує до вибору шрифту. Додай \\tracinglostchars=3: тоді буде помилка з реальним рядком.';
  } else {
    msg += ' Заміни символ або шрифт, у якому цього гліфа немає.';
  }
  return msg;
}

// "Missing character: There is no ; (U+003B) in font nullfont!" followed by l.NNN in the context
function missingCharLines(logText) {
  const lines = String(logText).split(/\r?\n/);
  const RE = /^Missing character: There is no (.+?)(?: \(U\+([0-9A-Fa-f]+)\))? in (?:font )?(.+?)!\s*$/;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = RE.exec(lines[i]);
    if (!m) continue;
    const code = m[2] ? parseInt(m[2], 16) : (m[1].codePointAt(0) || 0);
    let line = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 200); j++) {
      if (RE.test(lines[j])) break;
      const l = /^l\.(\d+)\b/.exec(lines[j]);
      if (l) { line = parseInt(l[1], 10); break; }
    }
    out.push({ code, font: m[3], line });
  }
  return out;
}

// gives the 'Missing' items of parseTexlogsieve a line (0-based) and the matching message
function attachMissingLines(items, logText) {
  const found = missingCharLines(logText).filter((f) => f.line !== null);
  for (const it of items) {
    if (it.kind !== 'Missing' || !it.codes) continue;
    const hit = found.find((f) => f.font === it.font && it.codes.includes(f.code)) || found.find((f) => it.codes.includes(f.code));
    if (hit) { it.line = hit.line - 1; it.endLine = it.line; }
    it.message = missingCharMessage(it, hit ? hit.line : null);
  }
  return items;
}

// extra explanation for messages whose cause is well known (empty string when there is none)
function logHint(message) {
  const m = /graphics layer [`'‘]([^`'’]+)['’]/.exec(String(message));
  if (m) return 'Оголоси шар і додай його в список: \\pgfdeclarelayer{' + m[1] + '} \\pgfsetlayers{bg, background, ' + m[1] + ', main}';
  if (/pgf@layerbox/.test(String(message))) return 'Шар pgf у \\pgfsetlayers не оголошено: додай \\pgfdeclarelayer{назва_шару} перед \\pgfsetlayers';
  return '';
}

// output of \ShowHook from a log: [{hook, text}]
function parseShowHooks(logText) {
  const lines = String(logText).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    // `> The hook ...` or, in the log of a recent TeX Live, `-> The hook ...`
    const m = /^(?:-?> )?The hook '([^']+)'/.exec(lines[i]);
    if (!m) continue;
    const body = [lines[i].replace(/^-?> /, '')];
    for (let j = i + 1; j < lines.length; j++) {
      if (/^l\.\d+|^<recently read>|^<to be read again>|^!/.test(lines[j])) break;
      body.push(lines[j].replace(/^> ?/, ''));
    }
    out.push({ hook: m[1], text: body.join('\n').trim() });
  }
  return out;
}

/* ------------------- page output hooks: what to run and why nothing was found (0.3.13) ------------------- */
// the chapter (and figure) a file belongs to, like the compile button sees it; null: a file in the project root
// (main.tex, alone.tex, ...) or not a .tex/.tikz file. `rel` is the path from the project folder.
function hooksTarget(rel) {
  const parts = String(rel).split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  const file = parts[parts.length - 1];
  const m = /^(.*)\.(tex|tikz)$/i.exec(file);
  if (!m) return null;
  if (m[2].toLowerCase() === 'tikz' && parts.length >= 3 && parts[parts.length - 2].toLowerCase() === 'tikz') {
    return { chapter: parts[parts.length - 3], tikz: m[1] };
  }
  return { chapter: m[1], tikz: null };
}

// the argument of lualatex: optional \TargetChapter/\TargetTikz, the hook dump at the start of the document, the input file
function hooksInject(names, target, inputFile) {
  const pre = target ? '\\def\\TargetChapter{' + target.chapter + '}' + (target.tikz ? '\\def\\TargetTikz{' + target.tikz + '}' : '') : '';
  return pre + '\\AddToHook{begindocument/end}{' + names.map((n) => '\\ShowHook{' + n + '}').join('') + '\\csname@@end\\endcsname}\\input{' + inputFile + '}';
}

// why a log has no \ShowHook output: { empty, date, old, error }; `old` only when the LaTeX date is before 2021
function diagnoseHooksLog(logText) {
  const log = String(logText || '');
  if (!log.trim()) return { empty: true, date: null, old: false, error: null };
  const d = /LaTeX2e <(\d{4})-(\d\d)-(\d\d)/.exec(log);
  const date = d ? d[1] + '-' + d[2] + '-' + d[3] : null;
  let error = null;
  for (const line of log.split(/\r?\n/)) {
    if (/^! /.test(line) || /^[^\s:][^:]*:\d+: /.test(line)) { error = line.trim().slice(0, 200); break; }
  }
  return { empty: false, date, old: !!d && Number(d[1]) < 2021, error };
}

/* ------------------- pass counter of a latexmk build ------------------- */
// Every LaTeX run rewrites <job>.log from scratch, so a log that is fresh (written during this build) marks run 1
// and a log that becomes smaller than it was marks the next run. biber and the like do not touch it.
function makePassCounter(startedMs) {
  let pass = 0;
  let prev = -1;
  return {
    get pass() { return pass; },
    feed(size, mtimeMs) {
      if (mtimeMs < startedMs - 50) return pass; // the log of an earlier build
      if (pass === 0) pass = 1;
      else if (size < prev) pass++;
      prev = size;
      return pass;
    }
  };
}

function passWord(n) {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m10 === 1 && m100 !== 11) return 'прохід';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'проходи';
  return 'проходів';
}

function parseTexlogsieve(text, overfullThreshold) {
  const lines = String(text).replace(/\x1b\[[0-9;]*m/g, '').replace(/[^\n]\x08/g, '').replace(/\x08/g, '').split(/\r?\n/);
  const out = [];
  let curFile = null;
  let entry = null;
  const missing = new Map();
  let inSummary = false;
  let inMissing = false;

  const flush = () => {
    if (!entry) return;
    const e = entry;
    entry = null;
    const text1 = e.parts.join(' ').replace(/\s+/g, ' ').trim();
    const ctx = e.parts.map((x) => /^l\.(\d+)\s*(.*)$/.exec(x)).find(Boolean);
    let m = /^Overfull \\hbox \(([\d.]+)pt too wide\)/.exec(text1);
    if (!m) m = /^Underfull \\hbox \(badness (\d+)\)/.exec(text1);
    if (m) {
      const isOver = /^Overfull/.test(text1);
      if (isOver && overfullThreshold && parseFloat(m[1]) < overfullThreshold) return;
      const at = /(?:at )?lines (\d+)--(\d+)|at line (\d+)/.exec(text1);
      if (!at || !curFile) return; // e.g. "Underfull \vbox ... \output is active": no line to point at
      const l0 = parseInt(at[1] || at[3], 10) - 1;
      const l1 = at[2] ? parseInt(at[2], 10) - 1 : l0;
      out.push({ kind: 'BadBox', file: curFile, line: l0, endLine: l1, message: text1.replace(/\s*Offending text:.*$/, '') });
      return;
    }
    m = /^((?:[A-Za-z]:)?[^\s:][^:]*?\.(?:tex|tikz|sty|cls|def|cfg|lua|aux|bbl|toc|out|lof|lot|ldf|fd|clo|sto|cut|ltx|pgf|dtx|ins)):(\d+):\s*(.*)$/.exec(text1);
    if (m) {
      const first = e.parts[0].replace(/^[^:]*?\.(?:tex|tikz|sty|cls|def|cfg|lua|aux|bbl|toc|out|lof|lot|ldf|fd|clo|sto|cut|ltx|pgf|dtx|ins):\d+:\s*/, '');
      const msg = first + (ctx && ctx[2] ? '  [' + ctx[2].trim() + ']' : '');
      const ln = parseInt(m[2], 10) - 1;
      out.push({ kind: 'Error', file: m[1], line: ln, endLine: ln, message: msg });
      return;
    }
    m = /^! (.*)$/.exec(e.parts[0]);
    if (m && curFile) {
      const ln = ctx ? parseInt(ctx[1], 10) - 1 : null;
      out.push({ kind: 'Error', file: curFile, line: ln, endLine: ln, message: m[1].trim() + (ctx && ctx[2] ? '  [' + ctx[2].trim() + ']' : '') });
      return;
    }
    if (/^(?:LaTeX(?: Font)?|Package \S+|Class \S+) Warning:/.test(text1) && curFile) {
      const on = /on input line (\d+)/.exec(text1);
      const ln = on ? parseInt(on[1], 10) - 1 : null;
      out.push({ kind: 'Warning', file: curFile, line: ln, endLine: ln, message: text1.replace(/\(\w[\w-]*\)\s+/g, '') });
    }
    // everything else (Info, page numbers, chapter titles printed on the terminal) is ignored
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^=+\s+Summary:/.test(line)) { flush(); inSummary = true; continue; }
    if (inSummary) {
      const pg = /^\s+page \d+ \(file (.+?)\):\s*$/.exec(line);
      if (pg) { curFile = pg[1]; inMissing = false; continue; }
      if (/^\s+(?:Over|Under)full \\hbox/.test(line)) { curFile = curFile || null; entry = { parts: [line.trim()] }; flush(); continue; }
      if (/^Missing characters:/.test(line)) { inMissing = true; continue; }
      if (inMissing) {
        const mm = /^\s+char .*? \(U\+([0-9A-Fa-f]+)\), font (\S+) in page (\d+) \(file (.+?)\)\s*$/.exec(line);
        if (mm) {
          const key = mm[4] + '|' + mm[2] + '|' + mm[3];
          if (!missing.has(key)) missing.set(key, { file: mm[4], font: mm[2], page: mm[3], chars: [], codes: [] });
          missing.get(key).chars.push(String.fromCodePoint(parseInt(mm[1], 16)));
          missing.get(key).codes.push(parseInt(mm[1], 16));
        } else if (line.trim()) inMissing = false;
      }
      continue;
    }
    let m = /^From file (.+):\s*$/.exec(line);
    if (m) { flush(); curFile = m[1].trim(); continue; }
    if (/^After last page:/.test(line)) { flush(); curFile = null; continue; }
    if (/^-{5,}\s*$/.test(line) || !line.trim()) { flush(); continue; }
    m = /^pg (?:\d+|\?):\s?(.*)$/.exec(line);
    if (m) { flush(); entry = { parts: [m[1]] }; continue; }
    if (entry && /^\s+\S/.test(raw)) entry.parts.push(line.trim());
  }
  flush();
  for (const g of missing.values()) {
    out.push({
      kind: 'Missing', file: g.file, line: null, endLine: null,
      font: g.font, page: g.page, chars: g.chars, codes: g.codes,
      message: missingCharMessage(g, null)
    });
  }
  return out;
}

/* ------------------------------- log parser ------------------------- */
const LOG_FILE_RE = /^(?:\.{0,2}\/|[A-Za-z]:[\\/]|\/)?[^\s()]+\.(?:tex|tikz|sty|cls|def|cfg|clo|fd|aux|bbl|lua|ldf|cnf|cut|sto|out|toc|lof|lot|code\.tex)$/i;
const LOG_MSG_START = /^(?:Overfull|Underfull|LaTeX (?:Font )?(?:Warning|Info|Error)|Package|Class|Missing|Runaway|!|l\.\d|\[\]|\s*\\|\s*\(\w[\w-]*\)\s{2,})/;

// Extracts overfull boxes and undefined references / citations together with the source file.
// `log` should be produced with max_print_line=10000 (no wrapped lines).
function parseLog(log, minOverfull) {
  const lines = log.split(/\r?\n/);
  const stack = [];
  const issues = [];
  const top = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i] && /\.(tex|tikz)$/i.test(stack[i])) return stack[i];
    return null;
  };
  for (const line of lines) {
    let m = /^Overfull \\hbox \(([\d.]+)pt too wide\) (?:in paragraph at lines (\d+)--\d+|in alignment at lines (\d+)--\d+|detected at line (\d+)|in paragraph at lines (\d+))/.exec(line);
    if (m) {
      const pts = parseFloat(m[1]);
      const ln = parseInt(m[2] || m[3] || m[4] || m[5], 10);
      const f = top();
      if (f && pts >= minOverfull) issues.push({ file: f, line: ln - 1, severity: 'warning', message: 'Overfull \\hbox: ' + pts + 'pt завширшки' });
      continue;
    }
    m = /^LaTeX Warning: (Reference|Citation) `([^']*)' on page \S+ undefined on input line (\d+)\./.exec(line);
    if (m) {
      const f = top();
      if (f) issues.push({ file: f, line: parseInt(m[3], 10) - 1, severity: 'warning', message: (m[1] === 'Reference' ? 'Невизначене посилання «' : 'Невизначена цитата «') + m[2] + '» (за логом LaTeX)' });
      continue;
    }
    // biblatex: Package biblatex Warning: Citation 'key' undefined on input line N.
    // natbib:   Package natbib Warning: Citation `key' on page P undefined on input line N.
    m = /^Package (?:biblatex|natbib) Warning: Citation [`']([^'`]*)'(?: on page \S+)? undefined on input line (\d+)\./.exec(line);
    if (m) {
      const f = top();
      if (f) issues.push({ file: f, line: parseInt(m[2], 10) - 1, severity: 'warning', message: 'Невизначена цитата «' + m[1] + '» (за логом LaTeX)' });
      continue;
    }
    if (LOG_MSG_START.test(line)) continue;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '(') {
        const mm = /^[^\s()]+/.exec(line.slice(i + 1));
        const tok = mm ? mm[0] : '';
        stack.push(tok && LOG_FILE_RE.test(tok) ? tok : null);
      } else if (ch === ')') {
        if (stack.length) stack.pop();
      }
    }
  }
  return issues;
}

/* --------------- texlogsieve report for the Output channel ------------- */
// entries: [{ kind: 'Error'|'Warning'|'Missing'|'BadBox', file (shown as is), line (0-based or null), message }]
// opts: { job, time, outside }.  Returns an array of lines: sections by kind, sorted by file and line.
function formatTexlogsieveReport(entries, opts) {
  const o = opts || {};
  const SECTIONS = [
    ['Error', 'ПОМИЛКИ'],
    ['Warning', 'ПОПЕРЕДЖЕННЯ'],
    ['Missing', 'MISSING CHARACTERS'],
    ['BadBox', 'OVERFULL / UNDERFULL']
  ];
  const WIDTH = 72;
  const rule = (title) => {
    const head = '── ' + title + ' ';
    return head + '─'.repeat(Math.max(3, WIDTH - head.length));
  };
  const loc = (e) => e.file + (e.line === null || e.line === undefined ? '' : ':' + (e.line + 1));
  const by = (k) => entries.filter((e) => e.kind === k);
  const counts = SECTIONS.map(([k]) => by(k).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const head = '══ texlogsieve · ' + (o.job ? o.job + '.log' : 'log') + (o.time ? ' · ' + o.time : '') + ' ';
  const out = [head + '═'.repeat(Math.max(3, WIDTH - head.length))];
  const sum = [];
  if (counts[0]) sum.push('помилок: ' + counts[0]);
  if (counts[1]) sum.push('попереджень: ' + counts[1]);
  if (counts[2]) sum.push('missing characters: ' + counts[2]);
  if (counts[3]) sum.push('overfull/underfull: ' + counts[3]);
  out.push(total ? sum.join(' · ') : '✓ Проблем у файлах проєкту немає');
  if (o.outside) out.push('(ще ' + o.outside + ' попереджень з пакетів TeX-дерева відкинуто)');
  SECTIONS.forEach(([k, title], i) => {
    const list = by(k).slice().sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return (a.line === null || a.line === undefined ? -1 : a.line) - (b.line === null || b.line === undefined ? -1 : b.line);
    });
    if (!list.length) return;
    out.push('', rule(title + ' (' + list.length + ')'));
    const w = Math.min(60, Math.max.apply(null, list.map((e) => loc(e).length)));
    for (const e of list) {
      const l = loc(e);
      const msg = String(e.message).replace(/\s+/g, ' ').trim();
      out.push('  ' + l + ' '.repeat(Math.max(2, w - l.length + 2)) + msg);
    }
  });
  return out;
}

module.exports = {
  attachMissingLines,
  diagnoseHooksLog,
  formatTexlogsieveReport,
  hooksInject,
  hooksTarget,
  logHint,
  makePassCounter,
  missingCharLines,
  missingCharMessage,
  parseLog,
  parseLogErrors,
  parsePplatex,
  parseShowHooks,
  parseTexlogsieve,
  passWord,
};
