const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./corePure');
const features = require('./features');
const { EXCLUDE, PIC_EXTS, debounce } = require('./util');
const build = require('./build');
const { setLang } = require('./i18n');

/* ------------------------------------------------------------------ *
 * 1. Clickable file names
 *    \localinput{name}                -> <dir of current file>/tikz/name
 *    \includegraphics[opts]{name}     -> <dir of current file>/Pictures/name
 * ------------------------------------------------------------------ */
const RULES = [
  { re: /\\localinput\{([^}]+)\}/g, sub: 'tikz', macro: '\\localinput', exts: ['.tikz', '.tex'] },
  {
    re: /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/g,
    sub: 'Pictures',
    macro: '\\includegraphics',
    exts: ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps', '.webp', '.gif', '.tif', '.tiff']
  }
];

// 0.7.0: folder of a legacy macro from the table tssworkflow.fileMacros (filesAndLabels.js)
function subOf(macro, fallback) {
  try { return require('./filesAndLabels').legacySub(macro, fallback); } catch (e) { return fallback; }
}

function resolveFile(dir, sub, name, exts) {
  const base = path.join(dir, sub, name);
  if (fs.existsSync(base)) return base;
  if (!path.extname(name)) {
    for (const e of exts) {
      if (fs.existsSync(base + e)) return base + e;
    }
  }
  return base; // let VS Code report "file not found"
}


/* ------------------------------------------------------------------ *
 * 3. Linked editing of \begin{env} / \end{env}
 *    (needs "editor.linkedEditing": true, enabled for [latex] by default)
 * ------------------------------------------------------------------ */
const ENV_TOKEN = /\\(begin|end)\{([^{}]*)\}/g;

function envTokens(doc) {
  const toks = [];
  for (let i = 0; i < doc.lineCount; i++) {
    const text = doc.lineAt(i).text;
    ENV_TOKEN.lastIndex = 0;
    let m;
    while ((m = ENV_TOKEN.exec(text)) !== null) {
      // skip commented-out tokens (unescaped %)
      if (text.slice(0, m.index).replace(/\\./g, '').includes('%')) continue;
      const start = m.index + m[0].indexOf('{') + 1;
      toks.push({ type: m[1], name: m[2], range: new vscode.Range(i, start, i, start + m[2].length) });
    }
  }
  return toks;
}

// pair by nesting (not by name), so it keeps working while the name is being edited
function envPartner(toks, idx) {
  const stack = [];
  const pair = new Map();
  toks.forEach((t, i) => {
    if (t.type === 'begin') stack.push(i);
    else if (stack.length) {
      const b = stack.pop();
      pair.set(b, i);
      pair.set(i, b);
    }
  });
  return pair.get(idx);
}

const linkedEnv = {
  provideLinkedEditingRanges(doc, pos) {
    const toks = envTokens(doc);
    const idx = toks.findIndex((t) => t.range.contains(pos));
    if (idx < 0) return undefined;
    const partner = envPartner(toks, idx);
    if (partner === undefined) return undefined;
    return new vscode.LinkedEditingRanges([toks[idx].range, toks[partner].range], /[^{}\\\s]+/);
  }
};

/* ------------------------------------------------------------------ *
 * 4. Ctrl+click / F12 on \ref{label}, \eqref{label} ... -> \label{label}
 * ------------------------------------------------------------------ */
const REF_RE = new RegExp('\\\\(?:' + P.REF_CMDS + ')\\*?\\{([^}]*)\\}', 'g');

function labelAt(doc, pos) {
  const text = doc.lineAt(pos.line).text;
  REF_RE.lastIndex = 0;
  let m;
  while ((m = REF_RE.exec(text)) !== null) {
    const argStart = m.index + m[0].indexOf('{') + 1;
    const argEnd = argStart + m[1].length;
    if (pos.character < argStart || pos.character > argEnd) continue;
    let off = argStart;
    for (const part of m[1].split(',')) {
      const s = off;
      const e = off + part.length;
      if (pos.character >= s && pos.character <= e) {
        const name = part.trim();
        const lead = part.length - part.trimStart().length;
        return { name, range: new vscode.Range(pos.line, s + lead, pos.line, s + lead + name.length) };
      }
      off = e + 1;
    }
  }
  return null;
}

function findLabelIn(text, name, base) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\\\label\\{' + (base && name === base ? '(?:' + esc + '|\\\\currfilebase)' : esc) + '\\}');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m && !lines[i].slice(0, m.index).replace(/\\./g, '').includes('%')) {
      return new vscode.Position(i, m.index);
    }
  }
  return null;
}

const refDefinition = {
  async provideDefinition(doc, pos) {
    const hit = labelAt(doc, pos);
    if (!hit) return undefined;
    // 1) current file
    const here = findLabelIn(doc.getText(), hit.name, path.basename(doc.uri.fsPath, path.extname(doc.uri.fsPath)));
    if (here) return new vscode.Location(doc.uri, here);
    // 2) other .tex/.tikz files of the workspace (same folder first)
    const files = await vscode.workspace.findFiles('**/*.{tex,tikz}', EXCLUDE, 1000);
    const dir = path.dirname(doc.uri.fsPath);
    files.sort((a, b) => Number(b.fsPath.startsWith(dir)) - Number(a.fsPath.startsWith(dir)));
    for (const f of files) {
      if (f.fsPath === doc.uri.fsPath) continue;
      let txt;
      try { txt = fs.readFileSync(f.fsPath, 'utf8'); } catch (e) { continue; }
      const p = findLabelIn(txt, hit.name, path.basename(f.fsPath, path.extname(f.fsPath)));
      if (p) return new vscode.Location(f, p);
    }
    return undefined;
  }
};

/* ------------------------------------------------------------------ *
 * 5. File-name completion inside \localinput{...} and \includegraphics[..]{...}
 *    \localinput      -> files of <dir of current file>/tikz  (with extension)
 *    \includegraphics -> files of <dir of current file>/Pictures (without extension)
 * ------------------------------------------------------------------ */
const COMPLETE = [
  { re: /\\localinput\{([^}]*)$/, macro: '\\localinput', sub: 'tikz', exts: ['.tikz', '.tex'], stripExt: false },
  { re: /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)$/, macro: '\\includegraphics', sub: 'Pictures', exts: PIC_EXTS, stripExt: true }
];

function listFiles(root, exts, depth, rel) {
  rel = rel || '';
  let out = [];
  let entries;
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (depth > 0) out = out.concat(listFiles(root, exts, depth - 1, r));
    } else if (exts.includes(path.extname(e.name).toLowerCase())) {
      out.push(r);
    }
  }
  return out;
}

let LOG = null; // output channel "TSS Workflow"

const fileCompletion = {
  provideCompletionItems(doc, pos) {
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    if (LOG && /\\(localinput|includegraphics)/.test(before)) LOG.appendLine('completion asked: ' + before.slice(-60));
    for (const c of COMPLETE) {
      const m = c.re.exec(before);
      if (!m) continue;
      const range = new vscode.Range(pos.line, pos.character - m[1].length, pos.line, pos.character);
      const dir = path.join(path.dirname(doc.uri.fsPath), subOf(c.macro, c.sub));
      const seen = new Set();
      const items = [];
      for (const rel of listFiles(dir, c.exts, 3)) {
        const text = c.stripExt ? rel.slice(0, rel.length - path.extname(rel).length) : rel;
        if (seen.has(text)) continue;
        seen.add(text);
        const it = new vscode.CompletionItem(text, vscode.CompletionItemKind.File);
        it.detail = c.sub + '/' + rel;
        it.range = range;
        it.filterText = text;
        it.sortText = '0_' + text;
        items.push(it);
      }
      if (LOG) LOG.appendLine('  -> ' + items.length + ' items from ' + dir);
      return items;
    }
    return undefined;
  }
};

/* ------------------------------------------------------------------ *
 * 6. Command: pick a file name from a list (Ctrl+Alt+I) for the argument
 *    of \localinput{...} / \includegraphics[...]{...} under the cursor
 * ------------------------------------------------------------------ */
const ARG_RULES = [
  { re: /\\localinput\{([^}]*)\}/g, c: COMPLETE[0] },
  { re: /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g, c: COMPLETE[1] }
];

function argContext(text, col) {
  for (const r of ARG_RULES) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(text)) !== null) {
      const start = m.index + m[0].lastIndexOf('{') + 1;
      const end = start + m[1].length;
      if (col >= start && col <= end) return { c: r.c, start, end };
    }
  }
  return null;
}

async function pickFile() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const pos = ed.selection.active;
  const ctx = argContext(ed.document.lineAt(pos.line).text, pos.character);
  if (!ctx) {
    vscode.window.showInformationMessage('Постав курсор усередину {...} у \\localinput або \\includegraphics.');
    return;
  }
  const dir = path.join(path.dirname(ed.document.uri.fsPath), subOf(ctx.c.macro, ctx.c.sub));
  const seen = new Set();
  const items = [];
  for (const rel of listFiles(dir, ctx.c.exts, 3)) {
    const text = ctx.c.stripExt ? rel.slice(0, rel.length - path.extname(rel).length) : rel;
    if (seen.has(text)) continue;
    seen.add(text);
    items.push({ label: text, description: ctx.c.sub + '/' + rel });
  }
  if (!items.length) {
    vscode.window.showWarningMessage('У папці ' + dir + ' немає підхожих файлів.');
    return;
  }
  const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Файл із ' + ctx.c.sub + '/' });
  if (!picked) return;
  await ed.edit((b) => b.replace(new vscode.Range(pos.line, ctx.start, pos.line, ctx.end), picked.label));
}

/* ------------------------------------------------------------------ *
 * 7. Align table columns at & (like TeXstudio)
 *    - selection      -> aligns the selected lines
 *    - no selection   -> aligns the rows of the innermost tblr/tabular/align/... around the cursor
 *    Only rows that sit on ONE physical line and end with \\ (or are the last row) are touched.
 * ------------------------------------------------------------------ */
function envPairs(toks) {
  const stack = [];
  const pairs = [];
  toks.forEach((t, i) => {
    if (t.type === 'begin') stack.push(i);
    else if (stack.length) pairs.push([stack.pop(), i]);
  });
  return pairs;
}

async function alignTable() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  let startLine;
  let endLine;
  if (!ed.selection.isEmpty) {
    startLine = ed.selection.start.line;
    endLine = ed.selection.end.line;
    if (ed.selection.end.character === 0 && endLine > startLine) endLine--;
  } else {
    const toks = envTokens(doc);
    const cur = ed.selection.active.line;
    let best = null;
    for (const [b, e] of envPairs(toks)) {
      if (!P.ALIGN_ENVS.has(toks[b].name)) continue;
      if (toks[b].range.start.line > cur || toks[e].range.start.line < cur) continue;
      if (!best || toks[b].range.start.line >= toks[best[0]].range.start.line) best = [b, e];
    }
    if (!best) {
      vscode.window.showInformationMessage('Постав курсор усередину таблиці (tblr, tabular, align...) або виділи рядки.');
      return;
    }
    const bt = toks[best[0]];
    const et = toks[best[1]];
    // skip the arguments of \begin{env}: [..] and {..} groups (they may span several lines)
    const text = doc.getText();
    let off = doc.offsetAt(new vscode.Position(bt.range.end.line, bt.range.end.character + 1));
    for (;;) {
      let o = off;
      while (text[o] === ' ' || text[o] === '\t') o++;
      const c = text[o];
      if (c !== '{' && c !== '[') break;
      const close = c === '{' ? '}' : ']';
      let d = 0;
      let k = o;
      for (; k < text.length; k++) {
        const ch = text[k];
        if (ch === '\\') { k++; continue; }
        if (ch === c) d++;
        else if (ch === close) { d--; if (d === 0) break; }
      }
      off = k + 1;
    }
    startLine = doc.positionAt(off).line + 1;
    endLine = et.range.start.line - 1;
  }
  if (endLine < startLine) {
    vscode.window.showInformationMessage('У таблиці немає рядків для вирівнювання.');
    return;
  }
  const oldLines = [];
  for (let i = startLine; i <= endLine; i++) oldLines.push(doc.lineAt(i).text);
  const newLines = P.alignLines(oldLines);
  if (newLines.every((l, i) => l === oldLines[i])) {
    vscode.window.setStatusBarMessage('Таблицю вже вирівняно', 2000);
    return;
  }
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const range = new vscode.Range(startLine, 0, endLine, oldLines[oldLines.length - 1].length);
  await ed.edit((b) => b.replace(range, newLines.join(eol)));
}

/* ------------------------------------------------------------------ *
 * 8. Join hard line breaks inside a paragraph (unwrap), like TeXstudio "hard line breaks"
 *    - selection      -> unwraps all paragraphs inside the selected lines
 *    - no selection   -> unwraps the paragraph around the cursor
 *    Never joins across: blank lines, comment lines, lines with a trailing % comment,
 *    lines ending with \\, table rows (&), \begin/\end, sectioning commands, \[ \].
 *    A line starting with \item or \caption may begin a joined block but is never glued to the previous line.
 * ------------------------------------------------------------------ */
async function unwrapParagraph() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const doc = ed.document;
  let startLine;
  let endLine;
  if (!ed.selection.isEmpty) {
    startLine = ed.selection.start.line;
    endLine = ed.selection.end.line;
    if (ed.selection.end.character === 0 && endLine > startLine) endLine--;
  } else {
    const cur = ed.selection.active.line;
    if (P.lineKind(doc.lineAt(cur).text) === 'hard') {
      vscode.window.showInformationMessage('Постав курсор в абзац або виділи рядки.');
      return;
    }
    startLine = cur;
    endLine = cur;
    while (startLine > 0 && P.canJoin(doc.lineAt(startLine - 1).text, doc.lineAt(startLine).text)) startLine--;
    while (endLine + 1 < doc.lineCount && P.canJoin(doc.lineAt(endLine).text, doc.lineAt(endLine + 1).text)) endLine++;
  }
  const oldLines = [];
  for (let i = startLine; i <= endLine; i++) oldLines.push(doc.lineAt(i).text);
  const newLines = P.unwrapLines(oldLines);
  if (newLines.length === oldLines.length) {
    vscode.window.setStatusBarMessage('Немає рядків для об\'єднання', 2000);
    return;
  }
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  const range = new vscode.Range(startLine, 0, endLine, oldLines[oldLines.length - 1].length);
  await ed.edit((b) => b.replace(range, newLines.join(eol)));
}

/* ------------------------------------------------------------------ */
// asks once per start for each workspace folder that has .tex files and no .vscode/settings.json
async function offerProjectSettings(context) {
  if (!vscode.workspace.getConfiguration('tssworkflow').get('offerProjectSettings', true)) return;
  for (const f of vscode.workspace.workspaceFolders || []) {
    if (fs.existsSync(path.join(f.uri.fsPath, '.vscode', 'settings.json'))) continue;
    const key = 'tssworkflow.noSettingsPrompt:' + f.uri.fsPath.toLowerCase();
    if (context.globalState.get(key)) continue;
    const tex = await vscode.workspace.findFiles(new vscode.RelativePattern(f, '**/*.tex'), EXCLUDE, 1);
    if (!tex.length) continue;
    const pick = await vscode.window.showInformationMessage(
      'У «' + f.name + '» немає .vscode/settings.json. Створити його із шаблону?',
      'Створити', 'Не питати для цієї папки'
    );
    if (pick === 'Створити') await vscode.commands.executeCommand('tssworkflow.initProjectSettings', f.uri.fsPath);
    else if (pick === 'Не питати для цієї папки') await context.globalState.update(key, true);
  }
}

function activate(context) {
  // the language of the messages and reports (i18n.js): the setting tssworkflow.language, "auto" follows the language of VS Code
  const applyLanguage = () => setLang(vscode.workspace.getConfiguration('tssworkflow').get('language', 'uk'), vscode.env.language);
  applyLanguage();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow.language')) applyLanguage(); }));
  const provider = {
    provideDocumentLinks(doc) {
      const links = [];
      const dir = path.dirname(doc.uri.fsPath);
      for (let i = 0; i < doc.lineCount; i++) {
        const text = doc.lineAt(i).text;
        for (const rule of RULES) {
          rule.re.lastIndex = 0;
          let m;
          while ((m = rule.re.exec(text)) !== null) {
            const name = m[1].trim();
            const start = m.index + m[0].lastIndexOf('{') + 1;
            const range = new vscode.Range(i, start, i, start + m[1].length);
            const link = new vscode.DocumentLink(range, vscode.Uri.file(resolveFile(dir, subOf(rule.macro, rule.sub), name, rule.exts)));
            link.tooltip = 'Open ' + name;
            links.push(link);
          }
        }
      }
      return links;
    }
  };

  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider([{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }], provider)
  );

  LOG = vscode.window.createOutputChannel('TSS Workflow');
  context.subscriptions.push(LOG);
  build.register(context, { channel: LOG }); // the build commands, the status bar and its buttons
  const SEL = [{ language: 'latex' }, { language: 'tex' }, { pattern: '**/*.tikz' }];
  context.subscriptions.push(
    vscode.languages.registerLinkedEditingRangeProvider(SEL, linkedEnv),
    vscode.languages.registerDefinitionProvider(SEL, refDefinition),
    // this selector (language + scheme + pattern) is the one that worked in 0.0.9 (Ctrl+Space)
    vscode.languages.registerCompletionItemProvider(
      [
        { language: 'latex', scheme: 'file', pattern: '**/*.tex' },
        { language: 'latex', scheme: 'file', pattern: '**/*.tikz' },
        { language: 'tex', scheme: 'file', pattern: '**/*.tex' },
        { scheme: 'file', pattern: '**/*.tikz' }
      ],
      fileCompletion,
      '{',
      '/'
    ),
    vscode.commands.registerCommand('tssworkflow.pickFile', pickFile),
    vscode.commands.registerCommand('tssworkflow.alignTable', alignTable),
    vscode.commands.registerCommand('tssworkflow.unwrap', unwrapParagraph),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || e.document !== ed.document || !e.contentChanges.length) return;
      if (!e.contentChanges[0].text) return; // deletion
      const id = e.document.languageId;
      if (id !== 'latex' && id !== 'tex' && !e.document.uri.fsPath.toLowerCase().endsWith('.tikz')) return;
      const pos = ed.selection.active;
      if (!argContext(e.document.lineAt(pos.line).text, pos.character)) return;
      debounce('suggest', 30, () => vscode.commands.executeCommand('editor.action.triggerSuggest'));
    })
  );

  features.register(context, { onSave: build.compileOnSave });
  require('./authoring').register(context);
  require('./templates').register(context);
  require('./sidebar').register(context);
  require('./chapters').register(context);
  require('./environment').register(context);
  require('./projectRefactor').register(context, { frameSettings: features.frameSettings });
  require('./formatters').register(context, { applyWithPreview: features.applyWithPreview });
  require('./filesAndLabels').register(context, { applyWithPreview: features.applyWithPreview });
  require('./wordCount').register(context);
  require('./tableEditor').register(context, { log: (m) => LOG && LOG.appendLine(m) });
  require('./start').register(context);
  // 0.19.0: the jump to a line in the PDF is checked against the synctex file; the builds as VS Code tasks; LaTeX Workshop settings that get in the way
  require('./synctex').register(context, { activePdf: build.activePdf });
  require('./buildTasks').register(context, { run: build.runForTask, outcome: build.outcome, stop: build.stopBuild });
  require('./lwCompat').register(context);
  // 0.20.1: the report with the numbers that grow when something leaks
  require('./debugState').register(context);
  // a project with .tex files but without .vscode/settings.json: offer to create it from the template
  debounce('extension.offerProjectSettings', 3000, () => offerProjectSettings(context).catch(() => {}));
}

exports.activate = activate;
exports.compile = build.compile;
