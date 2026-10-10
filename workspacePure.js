'use strict';
/* workspacePure.js: project .vscode/settings.json, the main file and PATH search, \documentclass in a file, the picture preview in the hover. No vscode. */
const { codePart } = require('./texBasePure');

/* ------------------- project .vscode/settings.json template --------- */
// What a project should carry itself (style of the text, build job). Machine-specific values (paths to programs,
// the log parser tool, themes, LaTeX Workshop tools) stay in the user settings.
const PROJECT_SETTINGS_TEMPLATE = {
  'tssworkflow.jobname': 'main',
  'tssworkflow.driver': 'alone.tex',
  'tssworkflow.pdfBeside': true,
  'tssworkflow.forceRebuild': true,
  'tssworkflow.normalizeLineBreaks': 'wrap',
  'tssworkflow.blankLinesParagraph': 1,
  'tssworkflow.blankLinesHeading': 3,
  'tssworkflow.normalizeFrames': false,
  'tssworkflow.normalizeTables': false,
  'tssworkflow.normalizeTypography': true,
  'tssworkflow.displayMathToEquation': true,
  'tssworkflow.normalizeBlankLines': true,
  'tssworkflow.quoteStyle': 'enquote',
  'tssworkflow.frameRules': {
    headings: '%% --------------------------------------------------------',
    section: '%% --------------------------------------------------------',
    formulas: '% ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    align: '% ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~'
  }
};

// comments out of JSONC text (string-aware)
function stripJsonc(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  let inStr = false;
  while (i < n) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c;
    i++;
  }
  return out;
}

// trailing commas before } or ] (string-aware); expects comment-free text
function dropTrailingCommas(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] || ''; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += c;
  }
  return out;
}

// index of the last code character (not whitespace, not inside a comment) before `end`
function lastCodeIndex(text, end) {
  let last = -1;
  let inStr = false;
  for (let i = 0; i < end; i++) {
    const c = text[i];
    if (inStr) {
      last = i;
      if (c === '\\') { i++; last = i; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; last = i; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < end && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < end && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    if (!/\s/.test(c)) last = i;
  }
  return last;
}

// Adds the keys of `template` that the settings text lacks (top-level keys only, existing ones are never touched);
// comments and formatting of the existing text are kept. -> { text, added: [keys] } or { error }
function mergeMissingSettings(existing, template, comments) {
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  // `comments`: { 'top.key': { 'nested key': '// comment line put above that nested key' } }
  const entry = (k) => {
    let v = JSON.stringify(template[k], null, 2);
    const cm = comments && comments[k];
    if (cm) {
      v = v.split('\n').map((line) => {
        const m = /^(\s*)("(?:[^"\\]|\\.)*"):/.exec(line);
        let key = null;
        if (m) { try { key = JSON.parse(m[2]); } catch (e) { key = null; } }
        return key !== null && cm[key] ? m[1] + cm[key] + '\n' + line : line;
      }).join('\n');
    }
    return '  ' + JSON.stringify(k) + ': ' + v.replace(/\n/g, '\n  ');
  };
  if (!existing.trim()) {
    const keys = Object.keys(template);
    return { text: '{' + eol + keys.map(entry).join(',' + eol).replace(/\n/g, eol) + eol + '}' + eol, added: keys };
  }
  let obj;
  try { obj = JSON.parse(dropTrailingCommas(stripJsonc(existing.replace(/^\uFEFF/, '')))); } catch (e) { return { error: 'не вдалося розібрати існуючий settings.json' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: 'settings.json має бути JSON-об\'єктом' };
  const missing = Object.keys(template).filter((k) => !Object.prototype.hasOwnProperty.call(obj, k));
  if (!missing.length) return { text: existing, added: [] };
  const close = existing.lastIndexOf('}');
  if (close < 0) return { error: 'у settings.json немає закриваючої }' };
  const last = lastCodeIndex(existing, close);
  if (last < 0) return { error: 'не вдалося знайти місце вставки' };
  const needComma = existing[last] !== ',' && existing[last] !== '{';
  const body = missing.map(entry).join(',' + eol).replace(/\r?\n/g, eol);
  let lineEnd = existing.indexOf('\n', last);
  if (lineEnd < 0 || lineEnd > close) {
    // the closing brace is on the same line: insert right after the last code character
    const text = existing.slice(0, last + 1) + (needComma ? ',' : '') + eol + body + eol + existing.slice(last + 1);
    return { text, added: missing };
  }
  if (existing[lineEnd - 1] === '\r') lineEnd--;
  const text = existing.slice(0, last + 1) + (needComma ? ',' : '') + existing.slice(last + 1, lineEnd) + eol + body + existing.slice(lineEnd);
  return { text, added: missing };
}

/* ----------- 0.4.3: main file, built-in settings, PATH search ---------- */
// The settings object of a settings.json text: {} for an empty text, null if it cannot be parsed.
function parseSettings(text) {
  if (!String(text).trim()) return {};
  try {
    const o = JSON.parse(dropTrailingCommas(stripJsonc(String(text).replace(/^\uFEFF/, ''))));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch (e) { return null; }
}

// Which root .tex file is the main one. `names`: file names of the project root. The driver (alone.tex) is not a
// candidate unless it is the only file. -> { file, source: 'single'|'main'|'default' } or { choose: [names] }
function pickMainTex(names, driver) {
  let tex = (names || []).filter((n) => /\.tex$/i.test(n)).sort((a, b) => a.localeCompare(b));
  const drv = String(driver || 'alone.tex').toLowerCase();
  const rest = tex.filter((n) => n.toLowerCase() !== drv);
  if (rest.length) tex = rest;
  if (!tex.length) return { file: 'main.tex', source: 'default' };
  if (tex.length === 1) return { file: tex[0], source: 'single' };
  const m = tex.find((n) => n.toLowerCase() === 'main.tex');
  if (m) return { file: m, source: 'main' };
  return { choose: tex };
}

// comment lines put above some keys of the generated settings (see mergeMissingSettings)
const PROJECT_SETTINGS_COMMENTS = {
  'files.exclude': { '**/desktop.ini': '// --- Файли ---', '**/.archive': '// --- Папки ---' }
};

// The settings.json of a new project: the style of the text, the build job, the formula preview and the files
// hidden in the Explorer. o: { mainFile, macroFiles: [paths], texlogsieve: bool (the program was found) }
function buildProjectSettings(o) {
  const opt = o || {};
  const mainFile = opt.mainFile || 'main.tex';
  const s = {};
  s['tssworkflow.mainFile'] = mainFile;
  s['tssworkflow.jobname'] = mainFile.replace(/\.[^./\\]*$/, '');
  if (opt.macroFiles && opt.macroFiles.length) s['tssworkflow.macroFiles'] = opt.macroFiles.slice();
  Object.assign(s, {
    'tssworkflow.pdfBeside': true,
    'tssworkflow.forceRebuild': true,
    'tssworkflow.normalizeLineBreaks': 'wrap',
    'tssworkflow.blankLinesParagraph': 1,
    'tssworkflow.blankLinesHeading': 3,
    'tssworkflow.normalizeFrames': false,
    'tssworkflow.normalizeTables': false,
    'tssworkflow.normalizeTypography': true,
    'tssworkflow.displayMathToEquation': true,
    'tssworkflow.normalizeBlankLines': true,
    'tssworkflow.quoteStyle': 'enquote',
    'tssworkflow.singlePass': false
  });
  if (opt.texlogsieve) {
    s['tssworkflow.logParser'] = 'texlogsieve';
    s['tssworkflow.texlogsieveTerminal'] = 'always';
  }
  s['tssworkflow.frameRules'] = PROJECT_SETTINGS_TEMPLATE['tssworkflow.frameRules'];
  s['latex-workshop.hover.preview.newcommand.newcommandFile'] = 'mathjax-macros.tex';
  s['latex-workshop.hover.preview.mathjax.extensions'] = ['boldsymbol'];
  s['files.exclude'] = {
    '**/desktop.ini': true, '**/google*.html': true, '**/descript.ion': true,
    '**/*.bak*': true, '**/*.out': true, '**/*.aux': true, '**/*.log': true, '**/*.gz': true,
    '**/*.bbl': true, '**/*.blg': true, '**/*.bcf': true, '**/*.toc': true, '**/*.idx': true,
    '**/*.ind': true, '**/*.ilg': true, '**/*.nlg': true, '**/*.nlo': true, '**/*.nls': true,
    '**/*.snm': true, '**/*.nav': true, '**/*.fdb_latexmk': true, '**/*.fls': true,
    '**/*.run.xml': true, '**/*.table': true, '**/*.gnuplot': true, '**/*.thm': true,
    '**/*.bbl-*': true, '**/*.bcf-*': true,
    '**/.archive': true, '**/build': true, '**/out': true, '**/.vscode': false, '**/__pycache__': true
  };
  return s;
}

// Finds a program like the shell would. `cmd` is a name or a path. o: { env, platform, exists(file) } (for tests).
// -> the full path or null
function findInPath(cmd, o) {
  const opt = o || {};
  const path = require('path');
  const env = opt.env || process.env;
  const platform = opt.platform || process.platform;
  const win = platform === 'win32';
  const pp = win ? path.win32 : path.posix;
  const exists = opt.exists || ((f) => { try { return require('fs').statSync(f).isFile(); } catch (e) { return false; } });
  const name = String(cmd || '').trim().replace(/^"(.*)"$/, '$1');
  if (!name) return null;
  const exts = win ? [''].concat(String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)) : [''];
  const tryIn = (base) => {
    for (const e of exts) {
      const f = base + (e && !base.toLowerCase().endsWith(e.toLowerCase()) ? e : '');
      if (exists(f)) return f;
    }
    return null;
  };
  if (/[\\/]/.test(name)) return tryIn(name);
  const dirs = String(env.PATH || env.Path || '').split(win ? ';' : ':').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const d of dirs) {
    const r = tryIn(pp.join(d, name));
    if (r) return r;
  }
  return null;
}

// Markdown report of "Check environment". rows: [{ name, what, state: 'ok'|'missing'|'optional', detail }]
function formatEnvReport(rows, o) {
  const opt = o || {};
  const mark = { ok: '✅', missing: '❌', optional: '○' };
  const lines = ['# TSS Workflow: Doctor (перевірка середовища)', ''];
  if (opt.folder) lines.push('Папка: `' + opt.folder + '`', '');
  const hints = rows.some((r) => r.hint && r.state !== 'ok');
  lines.push(hints ? '| Що | Стан | Де / версія | Навіщо | Що робити |' : '| Що | Стан | Де / версія | Навіщо |', hints ? '|---|---|---|---|---|' : '|---|---|---|---|');
  for (const r of rows) {
    lines.push('| ' + r.name + ' | ' + mark[r.state] + ' | ' + (r.detail || '') + ' | ' + (r.what || '') + ' |' + (hints ? ' ' + (r.state === 'ok' ? '' : (r.hint || '')) + ' |' : ''));
  }
  const bad = rows.filter((r) => r.state === 'missing');
  lines.push('');
  lines.push(bad.length
    ? '**Бракує потрібного (' + bad.length + '):** ' + bad.map((r) => r.name).join(', ') + '. Додай програму в `PATH` (і перезапусти VS Code) або вкажи повний шлях у налаштуванні розширення.'
    : '**Усе потрібне для поточних налаштувань знайдено.**');
  lines.push('', '✅ знайдено · ❌ немає, а потрібно за поточними налаштуваннями · ○ немає, але зараз не потрібно');
  return lines.join('\n') + '\n';
}

/* ---------------- \documentclass in a file ------------------------------ */
// true if the text declares \documentclass: outside comments, verbatim-like environments and \verb / \lstinline
// class / package / style files: they are loaded by a document and cannot be built on their own
// (neither as a chapter in the driver nor as a document)
function isPackageFile(fileName) {
  return /\.(?:cls|sty|clo|def|cfg|ldf|bbx|cbx|lbx|fd|bst)$/i.test(String(fileName || ''));
}

/* The build of a document on its own (a file with \documentclass): where latexmk runs, the arguments, the job name.
 *   file: absolute path; wsFolder: the workspace folder of the file (or null)
 *   opts: { workDir: 'file' | 'workspace', engine: 'lualatex' | 'pdflatex' | 'xelatex', force: boolean (-g) }
 * 'file': it runs in the folder of the file, the PDF stands next to it; 'workspace' (and the file is in a workspace folder):
 * it runs in that folder and the file is given by its relative path, like the whole document. */
function standalonePlan(file, wsFolder, opts) {
  const nodePath = require('path');
  const o = Object.assign({ workDir: 'file', engine: 'lualatex', force: true }, opts || {});
  const flags = { lualatex: '-lualatex', pdflatex: '-pdf', xelatex: '-xelatex' };
  const cwd = o.workDir === 'workspace' && wsFolder ? wsFolder : nodePath.dirname(file);
  return {
    cwd,
    job: nodePath.basename(file, nodePath.extname(file)),
    args: [
      ...(o.force ? ['-g'] : []),
      flags[o.engine] || flags.lualatex, '-interaction=nonstopmode', '-synctex=1', '-file-line-error', '-shell-escape',
      nodePath.relative(cwd, file)
    ]
  };
}

function hasDocumentClass(text) {
  const BEGIN = /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|tcblisting)\}/;
  const INLINE = /\\(?:verb\*?|lstinline(?:\[[^\]]*\])?)(.)(.*?)\1/g;
  const DOCCLASS = /(?:^|[^\\])(?:\\\\)*\\documentclass(?![A-Za-z@])/;
  let endRe = null;
  for (const raw of String(text).split(/\r?\n/)) {
    if (endRe) {
      if (endRe.test(raw)) endRe = null;
      continue;
    }
    const line = codePart(raw.replace(INLINE, ''));
    const m = BEGIN.exec(line);
    if (m) {
      if (DOCCLASS.test(line.slice(0, m.index))) return true;
      const name = m[1].replace(/\*/g, '\\*');
      const endLocal = new RegExp('\\\\end\\{' + name + '\\}');
      if (!endLocal.test(line.slice(m.index + m[0].length))) endRe = endLocal;
      continue;
    }
    if (DOCCLASS.test(line)) return true;
  }
  return false;
}

/* ------------------- image preview in the hover ------------------------- */
// 91 KB -> "91 КБ", 2.4 MB -> "2,4 МБ"
function formatFileSize(n) {
  if (n < 1048576) return Math.max(1, Math.round(n / 1024)) + ' КБ';
  return (n / 1048576).toFixed(1).replace('.', ',') + ' МБ';
}
// largest file shown as a data: URI; a markdown string with a longer base64 body was printed as raw text instead of an image
const DATA_URI_MAX = 64 * 1024;
// what the hover on \includegraphics shows: 'file' (image by file: URI), 'data' (base64 image), 'link' (only the open link),
// 'too-big' (over imagePreviewMaxMB), 'data-too-big' (mode data, file over DATA_URI_MAX)
function imagePreviewPlan(size, mode, maxMB) {
  const mb = Number.isFinite(Number(maxMB)) ? Number(maxMB) : 1;
  if (mode === 'link' || mb <= 0) return { kind: 'link' };
  if (size > mb * 1048576) return { kind: 'too-big', limitMB: mb };
  if (mode === 'data') return size > DATA_URI_MAX ? { kind: 'data-too-big' } : { kind: 'data' };
  return { kind: 'file' };
}

module.exports = {
  DATA_URI_MAX,
  PROJECT_SETTINGS_COMMENTS,
  PROJECT_SETTINGS_TEMPLATE,
  buildProjectSettings,
  dropTrailingCommas,
  findInPath,
  formatEnvReport,
  formatFileSize,
  hasDocumentClass,
  standalonePlan,
  imagePreviewPlan,
  isPackageFile,
  mergeMissingSettings,
  parseSettings,
  pickMainTex,
  stripJsonc,
};
