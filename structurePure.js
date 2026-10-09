'use strict';
/* structurePure.js: tables, environments, labels, syntax checks, frames of headings and formulas, align-all, outline. No vscode. */
const { alignLines, codePart, splitRow } = require('./texBasePure');

/* -------------------------- table operations ----------------------- */
const ALIGN_ENVS = new Set([
  'tblr', 'longtblr', 'talltblr', 'tabular', 'tabular*', 'tabularx', 'tabulary', 'longtable', 'array',
  'matrix', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix', 'Bmatrix', 'smallmatrix',
  'align', 'align*', 'aligned', 'alignat', 'alignat*', 'alignedat', 'flalign', 'flalign*',
  'eqnarray', 'eqnarray*', 'split', 'cases'
]);

function parseRows(lines) {
  let lastContent = -1;
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t && !t.startsWith('%')) lastContent = i;
  });
  return lines.map((l, i) => {
    const r = splitRow(l);
    if (!r || r.cells.length < 2) return null;
    if (r.tail === null && i !== lastContent) return null;
    r.indent = /^\s*/.exec(l)[0];
    return r;
  });
}

// index of the column (number of top-level & before the cursor)
function colAt(line, ch) {
  let depth = 0;
  let n = 0;
  const end = Math.min(ch, line.length);
  for (let i = 0; i < end; i++) {
    const c = line[i];
    if (c === '\\') { i++; continue; }
    if (c === '%') break;
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '&' && depth === 0) n++;
  }
  return n;
}

function tableOp(lines, op, col) {
  const rows = parseRows(lines);
  const idx = [];
  rows.forEach((r, i) => { if (r) idx.push(i); });
  if (!idx.length) return { error: 'У блоці немає рядків таблиці (потрібні рядки з & в одному рядку).' };
  const build = (indent, tail, comment, cells) =>
    indent + cells.join(' & ') + (tail !== null ? ' ' + tail : comment ? ' ' + comment : '');
  const out = lines.slice();
  if (op === 'addRight' || op === 'addLeft') {
    for (const i of idx) {
      const r = rows[i];
      const cells = r.cells.slice();
      cells.splice(Math.min(op === 'addRight' ? col + 1 : col, cells.length), 0, '');
      out[i] = build(r.indent, r.tail, r.comment, cells);
    }
  } else if (op === 'delete') {
    for (const i of idx) {
      const r = rows[i];
      const cells = r.cells.slice();
      if (col < cells.length) cells.splice(col, 1);
      out[i] = build(r.indent, r.tail, r.comment, cells.length ? cells : ['']);
    }
  } else if (op === 'sort') {
    const slots = idx.slice(1); // the first table row is treated as a header
    if (slots.length < 2) return { error: 'Замало рядків для сортування.' };
    const coll = new Intl.Collator('uk', { numeric: true, sensitivity: 'base' });
    const sorted = slots.map((i) => rows[i]).sort((a, b) => coll.compare(a.cells[col] || '', b.cells[col] || ''));
    slots.forEach((slot, k) => {
      const s = rows[slot];
      out[slot] = build(s.indent, s.tail, s.comment, sorted[k].cells);
    });
  } else if (op === 'transpose') {
    const nonBlank = lines.filter((l) => l.trim()).length;
    if (nonBlank !== idx.length) return { error: 'Транспонувати можна лише таблицю, де всі рядки це рядки з &.' };
    const n = rows[idx[0]].cells.length;
    if (idx.some((i) => rows[i].cells.length !== n)) return { error: 'Рядки мають різну кількість комірок.' };
    const indent = rows[idx[0]].indent;
    const res = [];
    for (let j = 0; j < n; j++) {
      res.push(indent + idx.map((i) => rows[i].cells[j]).join(' & ') + (j < n - 1 ? ' \\\\' : ''));
    }
    return { lines: res };
  } else {
    return { error: 'Невідома дія: ' + op };
  }
  return { lines: out };
}

/* ---------------------------- environments ------------------------- */
function envTokensPure(lines) {
  const toks = [];
  const re = /\\(begin|end)\{([^{}]*)\}/g;
  lines.forEach((line, i) => {
    const code = codePart(line);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      toks.push({
        type: m[1], name: m[2], line: i,
        col: m.index + m[0].indexOf('{') + 1, len: m[2].length,
        tokStart: m.index, tokEnd: m.index + m[0].length
      });
    }
  });
  return toks;
}

function pairEnvsPure(toks) {
  const stack = [];
  const pairs = [];
  const problems = [];
  toks.forEach((t, i) => {
    if (t.type === 'begin') { stack.push(i); return; }
    if (!stack.length) { problems.push({ i, code: 'end-without-begin', msg: '\\end{' + t.name + '} без \\begin' }); return; }
    const top = stack[stack.length - 1];
    if (toks[top].name === t.name) { stack.pop(); pairs.push([top, i]); return; }
    let k = -1;
    for (let s = stack.length - 1; s >= 0; s--) if (toks[stack[s]].name === t.name) { k = s; break; }
    if (k >= 0) {
      for (let s = stack.length - 1; s > k; s--) problems.push({ i: stack[s], code: 'missing-end', msg: 'Немає \\end{' + toks[stack[s]].name + '}' });
      const b = stack[k];
      stack.length = k;
      pairs.push([b, i]);
    } else {
      stack.pop();
      pairs.push([top, i]);
      problems.push({ i, code: 'end-mismatch', msg: '\\end{' + t.name + '} не відповідає \\begin{' + toks[top].name + '}', expect: toks[top].name });
    }
  });
  stack.forEach((i) => problems.push({ i, code: 'missing-end', msg: 'Немає \\end{' + toks[i].name + '}' }));
  return { pairs, problems };
}

// first body line of an environment: skips [..] and {..} arguments (they may span lines)
function bodyStartLine(lines, line, col) {
  let l = line;
  let c = col;
  for (;;) {
    while (lines[l] !== undefined && (lines[l][c] === ' ' || lines[l][c] === '\t')) c++;
    const ch = lines[l] && lines[l][c];
    if (ch !== '{' && ch !== '[') break;
    const close = ch === '{' ? '}' : ']';
    let d = 0;
    let done = false;
    while (l < lines.length && !done) {
      while (c < lines[l].length) {
        const x = lines[l][c];
        if (x === '\\') { c += 2; continue; }
        if (x === ch) d++;
        else if (x === close) { d--; if (d === 0) { c++; done = true; break; } }
        c++;
      }
      if (!done) { l++; c = 0; }
    }
  }
  return l + 1;
}

// lines of the innermost table/align-like environment around line `cur`
function tableBlockLines(lines, cur) {
  const toks = envTokensPure(lines);
  const { pairs } = pairEnvsPure(toks);
  let best = null;
  for (const [b, e] of pairs) {
    if (!ALIGN_ENVS.has(toks[b].name)) continue;
    if (toks[b].line > cur || toks[e].line < cur) continue;
    if (!best || toks[b].line >= toks[best[0]].line) best = [b, e];
  }
  if (!best) return null;
  const bt = toks[best[0]];
  const et = toks[best[1]];
  return { startLine: bodyStartLine(lines, bt.line, bt.tokEnd), endLine: et.line - 1 };
}

const CONVERTIBLE = [
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'flalign', 'flalign*'
];
const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*',
  'eqnarray', 'eqnarray*', 'displaymath', 'flalign', 'flalign*', 'alignat', 'alignat*'
]);

// choice: new environment name, '+label' or '-label'
function convertEnv(lines, cur, choice) {
  const toks = envTokensPure(lines);
  const { pairs } = pairEnvsPure(toks);
  let best = null;
  for (const [b, e] of pairs) {
    if (!CONVERTIBLE.includes(toks[b].name)) continue;
    if (toks[b].line > cur || toks[e].line < cur) continue;
    if (!best || toks[b].line >= toks[best[0]].line) best = [b, e];
  }
  if (!best) return { error: 'Курсор не всередині equation / align / gather / multline.' };
  const bt = toks[best[0]];
  const et = toks[best[1]];
  const labelRe = /\\label\{[^}]*\}\s?/;
  if (choice === '+label' || choice === '-label') {
    for (let ln = bt.line; ln <= et.line; ln++) {
      const m = labelRe.exec(codePart(lines[ln]));
      if (m) {
        if (choice === '+label') return { error: 'У цьому середовищі вже є \\label.' };
        return { edits: [{ line: ln, col: m.index, len: m[0].length, text: '' }] };
      }
    }
    if (choice === '-label') return { error: '\\label не знайдено.' };
    return { edits: [{ line: bt.line, col: bt.tokEnd, len: 0, text: '\\label{eq:}' }] };
  }
  return {
    edits: [
      { line: bt.line, col: bt.col, len: bt.len, text: choice },
      { line: et.line, col: et.col, len: et.len, text: choice }
    ]
  };
}

/* ------------------------------- labels ---------------------------- */
const REF_CMDS = 'ref|eqref|autoref|cref|Cref|crefrange|Crefrange|labelcref|cpageref|Cpageref|pageref|nameref|vref|Vref|vrefrange|vpageref|autopageref|subref';

const CURRFILE = '\\currfilebase';
const SEC_LINE_RE = /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/;

// adds the comma-separated names of one reference argument that starts at column `off`
function pushRefs(refs, arg, line, off) {
  for (const part of arg.split(',')) {
    const name = part.trim();
    if (name && !name.includes('\\')) {
      const lead = part.length - part.trimStart().length;
      refs.push({ name, line, col: off + lead, len: name.length });
    }
    off += part.length + 1;
  }
}

// fileBase: base name of the file (without extension); \label{\currfilebase} is resolved to it.
// Other labels / refs that contain a macro (a backslash) are ignored.
function scanLabelsAndRefs(text, fileBase) {
  const labels = [];
  const refs = [];
  const labelRe = /\\label\{([^}]*)\}/g;
  const refRe = new RegExp('\\\\(?:' + REF_CMDS + ')\\*?\\{([^}]*)\\}', 'g');
  const envRe = /\\(begin|end)\{([^{}]*)\}/g;
  const hyperRe = /\\hyperref\[([^\]]*)\]/g;
  const rangeRe = /\\(?:[cC]refrange|vrefrange|Vrefrange)\*?\{[^}]*\}\{([^}]*)\}/g;
  let lastCtx = '';
  let lastSec = -100;
  const stack = [];
  const all = text.split(/\r?\n/);
  all.forEach((line, i) => {
    const code = codePart(line);
    if (SEC_LINE_RE.test(code)) lastSec = i;
    const ctxHere = code.replace(labelRe, '').replace(/\\(begin|end)\{[^}]*\}/g, '').trim();
    if (ctxHere) lastCtx = ctxHere.slice(0, 90);
    // environment events of this line, in order
    const ev = [];
    let m;
    envRe.lastIndex = 0;
    while ((m = envRe.exec(code)) !== null) ev.push({ pos: m.index, type: m[1], name: m[2].replace(/\*$/, ''), line: i });
    let ei = 0;
    const applyEnvUpTo = (pos) => {
      while (ei < ev.length && ev[ei].pos < pos) {
        const e = ev[ei++];
        if (e.type === 'begin') stack.push({ name: e.name, line: e.line });
        else {
          for (let s = stack.length - 1; s >= 0; s--) if (stack[s].name === e.name) { stack.length = s; break; }
        }
      }
    };
    labelRe.lastIndex = 0;
    while ((m = labelRe.exec(code)) !== null) {
      applyEnvUpTo(m.index);
      let name = m[1].trim();
      const lead = m[1].length - m[1].trimStart().length;
      let macro = false;
      if (name === CURRFILE) {
        if (!fileBase) continue;
        name = fileBase;
        macro = true;
      } else if (name.includes('\\')) continue;
      const envs = stack.map((s) => s.name);
      if (!stack.length || i - lastSec <= 2) { if (i - lastSec <= 2 && !stack.some((s) => /^(equation|align|gather|multline|eqnarray|flalign|alignat|displaymath)$/.test(s.name))) envs.push('section'); }
      labels.push({
        name, line: i, col: m.index + m[0].indexOf('{') + 1 + lead, len: m[1].trim().length,
        ctx: ctxHere || lastCtx, macro, envs, envLine: stack.length ? stack[stack.length - 1].line : -1
      });
    }
    applyEnvUpTo(Infinity);
    refRe.lastIndex = 0;
    while ((m = refRe.exec(code)) !== null) {
      pushRefs(refs, m[1], i, m.index + m[0].indexOf('{') + 1);
    }
    // \hyperref[label]{text}
    hyperRe.lastIndex = 0;
    while ((m = hyperRe.exec(code)) !== null) pushRefs(refs, m[1], i, m.index + m[0].indexOf('[') + 1);
    // second argument of \crefrange{a}{b}
    rangeRe.lastIndex = 0;
    while ((m = rangeRe.exec(code)) !== null) pushRefs(refs, m[1], i, m.index + m[0].lastIndexOf('{') + 1);
  });
  for (const lb of labels) {
    if (lb.ctx) continue;
    for (let k = lb.line + 1; k < all.length && k < lb.line + 6; k++) {
      const t = codePart(all[k]).replace(/\\(begin|end)\{[^}]*\}/g, '').trim();
      if (t) { lb.ctx = t.slice(0, 90); break; }
    }
  }
  return { labels, refs };
}

function labelAtPos(line, col) {
  const { labels, refs } = scanLabelsAndRefs(line);
  for (const x of labels.concat(refs)) if (col >= x.col && col <= x.col + x.len) return x;
  return null;
}

function renamePositions(text, oldName) {
  const { labels, refs } = scanLabelsAndRefs(text);
  return labels.concat(refs).filter((x) => x.name === oldName && !x.macro);
}

/* --------------------------- syntax checks -------------------------- */
// exists(kind, name) -> boolean, kind is 'tikz' or 'pic'
function syntaxChecks(lines, exists) {
  const out = [];
  const bs = /(?<![\\A-Za-z@])(begin|end)\{([A-Za-z]+\*?)\}/g;
  lines.forEach((line, i) => {
    const code = codePart(line);
    let m;
    bs.lastIndex = 0;
    while ((m = bs.exec(code)) !== null) {
      out.push({ line: i, col: m.index, len: m[0].length, severity: 'error', code: 'missing-backslash', message: 'Пропущено «\\» перед ' + m[1] + '{' + m[2] + '}' });
    }
  });
  const toks = envTokensPure(lines);
  const { pairs, problems } = pairEnvsPure(toks);
  problems.forEach((p) => {
    const t = toks[p.i];
    out.push({ line: t.line, col: t.tokStart, len: t.tokEnd - t.tokStart, severity: 'error', code: p.code, expect: p.expect, message: p.msg });
  });
  pairs.forEach(([b, e]) => {
    if (!MATH_ENVS.has(toks[b].name)) return;
    for (let ln = toks[b].line + 1; ln < toks[e].line; ln++) {
      if (lines[ln].trim() === '') {
        out.push({ line: ln, col: 0, len: 1, severity: 'error', code: 'blank-in-math', message: 'Порожній рядок усередині формули (це \\par), LaTeX видасть помилку' });
      }
    }
  });
  if (exists) {
    const lin = /\\localinput\{([^}]*)\}/g;
    const inc = /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g;
    lines.forEach((line, i) => {
      const code = codePart(line);
      for (const [re, kind, prefix] of [[lin, 'tikz', 'tikz/'], [inc, 'pic', 'Pictures/']]) {
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(code)) !== null) {
          const name = m[1].trim();
          if (!name) continue;
          if (!exists(kind, name)) {
            const lead = m[1].length - m[1].trimStart().length;
            out.push({ line: i, col: m.index + m[0].lastIndexOf('{') + 1 + lead, len: name.length, severity: 'warning', code: 'file-missing-' + kind, message: 'Файл не знайдено: ' + prefix + name });
          }
        }
      }
    });
  }
  return out;
}


/* --------------------- frames: headings and formulas ---------------- */
const FRAME_RULE = '%% ' + '-'.repeat(56);     // around \section etc.
const FRAME_EQ_RULE = '% ' + '='.repeat(56);   // around formula environments
const SECTION_RE = /^(\s*)\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(\[[^\]]*\])?\s*\{/;
const FRAME_EQ_ENVS = ['equation', 'align', 'gather', 'multline', 'eqnarray', 'flalign', 'alignat', 'displaymath'];
const EQ_BEGIN_RE = new RegExp('^(\\s*)\\\\begin\\{(' + FRAME_EQ_ENVS.join('|') + ')(\\*?)\\}');
const VERB_BEGIN_RE = /^\s*\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|tcblisting)\}/;
const isRuleLine = (l) => /^\s*%+\s*[-=*#_~.]{8,}\s*$/.test(l);

// closing position of the {...} argument opening at (line, col); null if unbalanced
function braceEnd(lines, line, col) {
  let d = 0;
  for (let l = line; l < lines.length && l < line + 8; l++) {
    const s = lines[l];
    for (let c = l === line ? col : 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === '\\') { c++; continue; }
      if (ch === '%') break;
      if (ch === '{') d++;
      else if (ch === '}') { d--; if (d === 0) return { line: l, col: c + 1 }; }
    }
  }
  return null;
}

// end of \begin{name} ... \end{name} that starts at (line, col after \begin{name}); nesting of the same name counted
function envEnd(lines, name, line, col) {
  const re = new RegExp('\\\\(begin|end)\\{' + name.replace(/\*/g, '\\*') + '\\}', 'g');
  let depth = 1;
  for (let l = line; l < lines.length; l++) {
    const s = lines[l].replace(/(^|[^\\])%.*$/, '$1');
    re.lastIndex = l === line ? col : 0;
    let m;
    while ((m = re.exec(s))) {
      depth += m[1] === 'begin' ? 1 : -1;
      if (depth === 0) return { line: l, col: m.index + m[0].length, text: s };
    }
  }
  return null;
}

// regex of the formula environments to frame: the built-in ones plus `extra` (names from tssworkflow.frameEnvironments)
function eqReFor(extra) {
  const names = FRAME_EQ_ENVS.slice();
  for (const n of Array.isArray(extra) ? extra : []) {
    const k = String(n).trim().replace(/\*$/, '');
    if (/^[A-Za-z@][A-Za-z0-9@]*$/.test(k) && !names.includes(k)) names.push(k);
  }
  return new RegExp('^(\\s*)\\\\begin\\{(' + names.join('|') + ')(\\*?)\\}');
}

// Frames every sectioning command (except \part) with "%% ----" lines plus blank lines, and every
// formula environment with "% ====" lines. Blocks that already have a rule-comment line next to them
// are left alone; run-in headings and formulas followed by text on the same line are skipped.
// opts: { blank: bool, envs: [extra environment names], replace: bool }
// With opts.replace the existing rule lines next to a block are swapped for the current ones (re-framing).
function frameSections(lines, rules, opts) {
  rules = rules || {};
  const blank = !opts || opts.blank !== false;
  const replace = !!(opts && opts.replace);
  const eqRe = eqReFor(opts && opts.envs);
  const isStart = (l) => SECTION_RE.test(l) || eqRe.test(l);
  // rule line for a block: per-command / per-environment key, else the "headings" / "formulas" default
  // (extra environments: "environments" first); '' switches it off
  const ruleFor = (kind, name) => {
    let v = rules[name];
    if (v === undefined && kind === 'eq' && !FRAME_EQ_ENVS.includes(name)) v = rules.environments;
    if (v === undefined) v = kind === 'sec' ? rules.headings : rules.formulas;
    if (v === undefined) v = kind === 'sec' ? FRAME_RULE : FRAME_EQ_RULE;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const ranges = [];
  const stat = { sections: 0, equations: 0, already: 0, skipped: 0, found: 0, replaced: 0 };
  for (let i = 0; i < lines.length; i++) {
    const vb = VERB_BEGIN_RE.exec(lines[i]);
    if (vb) {
      const e = envEnd(lines, vb[1], i, vb[0].length);
      if (!e) break;
      i = e.line;
      continue;
    }
    const m = SECTION_RE.exec(lines[i]);
    if (m) {
      const rule = ruleFor('sec', m[2]);
      if (!rule) continue;
      stat.found++;
      const end = braceEnd(lines, i, m[0].length - 1);
      if (!end) { stat.skipped++; continue; }
      const tail = lines[end.line].slice(end.col).trim();
      if (tail && !tail.startsWith('%') && !/^(\\(label|hypertarget)\{[^}]*\}(\{[^}]*\})?\s*)+(%.*)?$/.test(tail)) { stat.skipped++; i = end.line; continue; }
      let s = i;
      let e = end.line;
      while (s > 0 && /^\s*\\hypertarget\{[^}]*\}(\{[^}]*\})?\s*$/.test(lines[s - 1])) s--;
      while (e + 1 < lines.length && /^\s*\\(label|hypertarget)\{[^}]*\}(\{[^}]*\})?\s*(%.*)?$/.test(lines[e + 1])) e++;
      ranges.push({ kind: 'sec', s, e, indent: m[1], rule });
      i = e;
      continue;
    }
    const q = eqRe.exec(lines[i]);
    if (q) {
      const rule = ruleFor('eq', q[2]);
      if (!rule) continue;
      stat.found++;
      const end = envEnd(lines, q[2] + q[3], i, q[0].length);
      if (!end) { stat.skipped++; continue; }
      const tail = end.text.slice(end.col).trim();
      if (tail) { stat.skipped++; i = end.line; continue; }
      ranges.push({ kind: 'eq', s: i, e: end.line, indent: q[1], rule });
      i = end.line;
    }
  }
  const out = [];
  let k = 0;
  for (const r of ranges) {
    const above = r.s > 0 && isRuleLine(lines[r.s - 1]);
    // a rule right below belongs to this block unless it is the top rule of the next block
    const below = r.e + 1 < lines.length && isRuleLine(lines[r.e + 1]) && !(r.e + 2 < lines.length && isStart(lines[r.e + 2]));
    let dropAbove = false;
    let dropBelow = false;
    if (above || below) {
      if (!replace) { stat.already++; continue; }
      // re-framing: nothing to do when both rules are already exactly the wanted ones
      if (above && below && lines[r.s - 1].trim() === r.rule && lines[r.e + 1].trim() === r.rule) { stat.already++; continue; }
      dropAbove = above && r.s - 1 >= k;
      dropBelow = below;
      stat.replaced++;
    }
    for (let x = k; x < r.s; x++) {
      if (dropAbove && x === r.s - 1) continue;
      out.push(lines[x]);
    }
    const rule = r.indent + r.rule;
    if (blank && r.kind === 'sec' && out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(rule);
    for (let x = r.s; x <= r.e; x++) out.push(lines[x]);
    out.push(rule);
    const nxt = r.e + 1 + (dropBelow ? 1 : 0);
    if (blank && r.kind === 'sec' && nxt < lines.length && lines[nxt].trim() !== '') out.push('');
    k = nxt;
    if (r.kind === 'sec') stat.sections++; else stat.equations++;
  }
  for (let x = k; x < lines.length; x++) out.push(lines[x]);
  return { lines: out, count: stat.sections + stat.equations, stat };
}


/* ------------------------------ headings ---------------------------- */
const HEADING_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*(?:\[[^\]]*\])?\s*\{/;
const HEADING_LEVEL = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };

function cleanTitle(s) {
  return s
    .replace(/\\label\{[^}]*\}/g, '')
    .replace(/\\(?:texorpdfstring)\{([^{}]*)\}\{[^{}]*\}/g, '$1')
    .replace(/\\[A-Za-z]+\*?/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scanHeadings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const vb = VERB_BEGIN_RE.exec(lines[i]);
    if (vb) {
      const e = envEnd(lines, vb[1], i, vb[0].length);
      if (!e) break;
      i = e.line;
      continue;
    }
    const m = HEADING_RE.exec(lines[i]);
    if (!m) continue;
    const end = braceEnd(lines, i, m[0].length - 1);
    let raw;
    if (end) {
      const parts = [];
      for (let l = i; l <= end.line; l++) {
        const from = l === i ? m[0].length : 0;
        const to = l === end.line ? end.col - 1 : lines[l].length;
        parts.push(lines[l].slice(from, to));
      }
      raw = parts.join(' ');
    } else raw = lines[i].slice(m[0].length);
    out.push({ kind: m[1], level: HEADING_LEVEL[m[1]], star: !!m[2], title: cleanTitle(raw) || '(без назви)', line: i });
  }
  return out;
}

/* --------------------------- align all tables ----------------------- */
// aligns every outermost table-like environment of the file; returns { lines, count }
function alignAllTables(lines) {
  const toks = envTokensPure(lines);
  const { pairs } = pairEnvsPure(toks);
  const blocks = [];
  for (const [b, e] of pairs) {
    if (!ALIGN_ENVS.has(toks[b].name)) continue;
    const s = bodyStartLine(lines, toks[b].line, toks[b].tokEnd);
    const en = toks[e].line - 1;
    if (en >= s) blocks.push({ s, e: en, bl: toks[b].line, el: toks[e].line });
  }
  blocks.sort((x, y) => x.s - y.s);
  const top = [];
  for (const bl of blocks) {
    const last = top[top.length - 1];
    if (last && bl.bl >= last.bl && bl.el <= last.el) continue; // nested: the outer one is aligned
    top.push(bl);
  }
  const out = lines.slice();
  let count = 0;
  for (const bl of top) {
    const old = lines.slice(bl.s, bl.e + 1);
    const neu = alignLines(old);
    if (neu.some((l, i) => l !== old[i])) {
      count++;
      for (let i = 0; i < neu.length; i++) out[bl.s + i] = neu[i];
    }
  }
  return { lines: out, count };
}

/* ------------------------- suggestions, outline --------------------- */
function editDistance(a, b) {
  const x = Array.from(a);
  const y = Array.from(b);
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[y.length];
}

// up to `max` candidates close to `name` (typos, different case, one is the beginning of the other)
function suggest(name, candidates, max) {
  const low = name.toLowerCase();
  const limit = Math.max(2, Math.floor(name.length / 4));
  const scored = [];
  const seen = new Set();
  for (const c of candidates) {
    if (c === name || seen.has(c)) continue;
    seen.add(c);
    const cl = c.toLowerCase();
    let d = editDistance(low, cl);
    if (low.length >= 3 && (cl.startsWith(low) || low.startsWith(cl))) d = Math.min(d, 1);
    if (d <= limit) scored.push({ c, d });
  }
  scored.sort((p, q) => p.d - q.d || p.c.localeCompare(q.c));
  return scored.slice(0, max || 3).map((x) => x.c);
}

// nested tree of headings for the Outline view: [{ title, kind, level, line, endLine, children }]
function outlineTree(lines) {
  const heads = scanHeadings(lines);
  const root = { level: -1, children: [] };
  const stack = [root];
  for (const h of heads) {
    const node = { title: h.title, kind: h.kind, star: h.star, level: h.level, line: h.line, endLine: lines.length - 1, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].level >= node.level) {
      const done = stack.pop();
      done.endLine = Math.max(done.line, node.line - 1);
    }
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

module.exports = {
  ALIGN_ENVS,
  CONVERTIBLE,
  EQ_BEGIN_RE,
  FRAME_EQ_RULE,
  FRAME_RULE,
  MATH_ENVS,
  REF_CMDS,
  VERB_BEGIN_RE,
  alignAllTables,
  bodyStartLine,
  braceEnd,
  colAt,
  convertEnv,
  editDistance,
  envEnd,
  envTokensPure,
  frameSections,
  isRuleLine,
  labelAtPos,
  outlineTree,
  pairEnvsPure,
  parseRows,
  pushRefs,
  renamePositions,
  scanHeadings,
  scanLabelsAndRefs,
  suggest,
  syntaxChecks,
  tableBlockLines,
  tableOp,
};
