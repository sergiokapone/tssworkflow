'use strict';
/* Completion, hover, go-to-definition and signature help for macros defined in the
 * project's own class / package files (ConspectBook.cls, *.sty, preamble \input files). */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const M = require('./macrosPure');

const SELECTOR = [{ scheme: 'file', pattern: '**/*.{tex,tikz,cls,sty,ltx}' }];
const cfg = () => vscode.workspace.getConfiguration('tssworkflow');

let EXCLUDE = '{**/build/**,**/.archive/**,**/node_modules/**,**/.git/**}';
let log = () => {};

/* ------------------------------ sources ------------------------------ */
let sourcesCache = null; // { at, files: [fsPath] }
const fileCache = new Map(); // fsPath -> { key, macros }
const SOURCES_TTL = 30000;

function invalidate() { sourcesCache = null; fileCache.clear(); }

function openDoc(fsPath) { return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath); }

function macrosOfFile(fsPath) {
  const od = openDoc(fsPath);
  let key; let text;
  if (od) { key = 'v' + od.version; text = od.getText(); } else {
    let st; try { st = fs.statSync(fsPath); } catch (e) { return []; }
    key = 'm' + st.mtimeMs + ':' + st.size;
    const c = fileCache.get(fsPath);
    if (c && c.key === key) return c.macros;
    try { text = fs.readFileSync(fsPath, 'utf8'); } catch (e) { return []; }
  }
  const c = fileCache.get(fsPath);
  if (c && c.key === key) return c.macros;
  const macros = M.scanMacros(text).map((m) => Object.assign(m, { file: fsPath }));
  fileCache.set(fsPath, { key, macros });
  return macros;
}

function textOfFile(fsPath) {
  const od = openDoc(fsPath);
  if (od) return od.getText();
  try { return fs.readFileSync(fsPath, 'utf8'); } catch (e) { return ''; }
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (e) { return false; } };

// files named by \documentclass, \usepackage, \RequirePackage, \LoadClass, \input (preamble only)
function referencedNames(text, preambleOnly) {
  let t = M.stripComments(text);
  if (preambleOnly) { const k = t.indexOf('\\begin{document}'); if (k >= 0) t = t.slice(0, k); }
  const names = [];
  const re = /\\(documentclass|usepackage|RequirePackage|RequirePackageWithOptions|LoadClass|LoadClassWithOptions|input|include|InputIfFileExists)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(t))) {
    for (const n of m[2].split(',')) {
      const nm = n.trim();
      if (nm) names.push({ cmd: m[1], name: nm });
    }
  }
  return names;
}

async function resolveName(ref, baseDir, root) {
  const exts = /^(?:input|include|InputIfFileExists)$/.test(ref.cmd) ? ['', '.tex', '.sty', '.cls'] : ref.cmd === 'documentclass' || /Class/.test(ref.cmd) ? ['.cls'] : ['.sty'];
  for (const dir of [baseDir, root]) {
    for (const e of exts) {
      const p = path.resolve(dir, ref.name + (ref.name.toLowerCase().endsWith(e) ? '' : e));
      if (e !== '' && isFile(p)) return p;
      if (e === '' && isFile(p)) return p;
    }
  }
  // somewhere else in the project (class kept in a subfolder)
  if (/^(?:documentclass|usepackage|RequirePackage|RequirePackageWithOptions|LoadClass|LoadClassWithOptions)$/.test(ref.cmd)) {
    const base = path.basename(ref.name);
    const found = await vscode.workspace.findFiles('**/' + base + (ref.cmd === 'documentclass' || /Class/.test(ref.cmd) ? '.cls' : '.sty'), EXCLUDE, 3);
    if (found.length) return found[0].fsPath;
  }
  return null;
}

async function collectSources(folder) {
  const root = folder.uri.fsPath;
  const files = [];
  const seen = new Set();
  const add = (p) => { if (p && !seen.has(p)) { seen.add(p); files.push(p); return true; } return false; };

  // explicit list from the settings
  for (const item of cfg().get('macroFiles', []) || []) {
    if (typeof item !== 'string' || !item.trim()) continue;
    if (/[*?{]/.test(item)) {
      for (const u of await vscode.workspace.findFiles(item, EXCLUDE, 200)) add(u.fsPath);
    } else add(path.resolve(root, item));
  }

  const walk = async (fp, depth, preambleOnly) => {
    if (depth > 4) return;
    const text = textOfFile(fp);
    for (const ref of referencedNames(text, preambleOnly)) {
      const p = await resolveName(ref, path.dirname(fp), root);
      if (p && add(p)) await walk(p, depth + 1, false);
    }
  };
  const mainName = cfg().get('mainFile', 'main.tex') || 'main.tex';
  for (const rootFile of [mainName, 'alone.tex']) {
    const mp = path.join(root, rootFile);
    if (isFile(mp)) await walk(mp, 0, true);
  }
  // the explicit files may reference more local packages too
  for (const f of files.slice()) await walk(f, 1, false);
  return files;
}

async function getSourceFiles() {
  const ed = vscode.window.activeTextEditor;
  const folder = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) return [];
  if (sourcesCache && Date.now() - sourcesCache.at < SOURCES_TTL && sourcesCache.folder === folder.uri.fsPath) return sourcesCache.files;
  const files = await collectSources(folder);
  sourcesCache = { at: Date.now(), folder: folder.uri.fsPath, files };
  log('[macros] джерела: ' + (files.length ? files.map((f) => path.relative(folder.uri.fsPath, f)).join(', ') : 'не знайдено (вкажіть tssworkflow.macroFiles)'));
  return files;
}

// all known macros visible from `doc`: project class/packages + the file itself
async function allMacros(doc) {
  const files = await getSourceFiles();
  const cmds = new Map();
  const envs = new Map();
  const put = (e) => {
    const m = e.kind === 'env' ? envs : cmds;
    m.set(e.name, e);
  };
  for (const f of files) for (const e of macrosOfFile(f)) put(e);
  if (doc && doc.uri.scheme === 'file' && !files.includes(doc.uri.fsPath)) for (const e of macrosOfFile(doc.uri.fsPath)) put(e);
  return { cmds, envs };
}

/* ------------------------------ rendering ---------------------------- */
const relName = (f) => path.basename(f);

function sourceLink(e) {
  const uri = vscode.Uri.file(e.file).with({ fragment: 'L' + (e.line + 1) });
  return '[' + relName(e.file) + ':' + (e.line + 1) + '](' + uri.toString() + ')';
}

function docMarkdown(e, call) {
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**' + (e.kind === 'env' ? 'середовище' : 'команда') + '**');
  md.appendCodeblock(M.signature(e), 'latex');
  if (e.doc) md.appendMarkdown(e.doc.replace(/\n/g, '  \n') + '\n\n');
  if (e.theorem) md.appendMarkdown('_' + e.body + '_\n\n');
  if (call && call.complete && e.body && e.kind === 'cmd' && !e.op && !e.alias) {
    md.appendMarkdown('Розгортається в:');
    md.appendCodeblock(M.expand(e, call.args), 'latex');
  } else if (e.op) {
    md.appendMarkdown('Оператор: `' + e.body + '`' + (e.starred ? ' (зі `*` межі йдуть під/над)' : '') + '\n\n');
  } else if (e.alias) {
    md.appendMarkdown('Те саме, що `\\' + e.alias + '`\n\n');
  }
  md.appendMarkdown('Визначено в ' + sourceLink(e) + '\n\n');
  md.appendCodeblock(e.src, 'latex');
  return md;
}

function snippetFor(e, prefix, mode) {
  const s = new vscode.SnippetString();
  s.appendText(prefix);
  if (mode !== 'none' && e.kind === 'cmd' && !e.op) {
    e.tokens.forEach((t, idx) => {
      if (t.t === 's' || t.t === 't' || t.t === 'e' || t.t === 'E' || t.t === 'v') return;
      if (t.optional && mode !== 'all') return;
      s.appendText(t.open || '').appendPlaceholder('#' + (idx + 1)).appendText(t.close || '');
    });
  }
  s.appendTabstop(0);
  return s;
}

/* ----------------------------- providers ----------------------------- */
const completion = {
  async provideCompletionItems(doc, pos) {
    if (!cfg().get('macros', true)) return undefined;
    const before = doc.lineAt(pos.line).text.slice(0, pos.character);
    const code = M.stripComments(before);
    const envCtx = /\\(begin|end)\{([A-Za-z@*]*)$/.exec(code);
    const { cmds, envs } = await allMacros(doc);
    if (envCtx) {
      const range = new vscode.Range(pos.line, pos.character - envCtx[2].length, pos.line, pos.character);
      return [...envs.values()].map((e) => {
        const it = new vscode.CompletionItem({ label: e.name, description: M.signature(e).slice(e.name.length) || undefined }, vscode.CompletionItemKind.Struct);
        it.detail = relName(e.file) + (e.doc ? ' · ' + e.doc.split('\n')[0] : '');
        it.documentation = docMarkdown(e);
        it.range = range;
        it.insertText = e.name;
        it.sortText = '0' + e.name;
        return it;
      });
    }
    const m = /\\([A-Za-z@]*)$/.exec(code);
    if (!m) return undefined;
    let k = 0;
    while (m.index - 1 - k >= 0 && code[m.index - 1 - k] === '\\') k++;
    if (k % 2 === 1) return undefined; // \\ is a line break, not a command
    const range = new vscode.Range(pos.line, m.index, pos.line, pos.character);
    const mode = cfg().get('macroSnippetArgs', 'mandatory');
    return [...cmds.values()].map((e) => {
      const kind = e.op ? vscode.CompletionItemKind.Operator : vscode.CompletionItemKind.Function;
      const sig = M.signature(e);
      const it = new vscode.CompletionItem({ label: '\\' + e.name, description: sig.slice(e.name.length + 1) || undefined }, kind);
      it.detail = relName(e.file) + (e.doc ? ' · ' + e.doc.split('\n')[0] : '');
      it.documentation = docMarkdown(e);
      it.range = range;
      it.filterText = '\\' + e.name;
      it.sortText = '0' + e.name;
      it.insertText = snippetFor(e, '\\' + e.name, mode);
      return it;
    });
  }
};

function symbolAt(doc, pos) {
  const line = doc.lineAt(pos.line).text;
  const code = M.stripComments(line);
  let m;
  const envRe = /\\(?:begin|end)\{([^}]*)\}/g;
  while ((m = envRe.exec(code))) {
    const s = m.index + m[0].indexOf('{') + 1;
    if (pos.character >= s && pos.character <= s + m[1].length) return { kind: 'env', name: m[1], start: s, end: s + m[1].length, code };
  }
  const re = /\\([A-Za-z@]+)(\*?)/g;
  while ((m = re.exec(code))) {
    if (pos.character >= m.index && pos.character <= m.index + m[0].length - m[2].length) {
      return { kind: 'cmd', name: m[1], start: m.index, end: m.index + 1 + m[1].length, after: m.index + m[0].length, code };
    }
  }
  return null;
}

const hover = {
  async provideHover(doc, pos) {
    if (!cfg().get('macros', true)) return undefined;
    const sym = symbolAt(doc, pos);
    if (!sym) return undefined;
    const { cmds, envs } = await allMacros(doc);
    const e = (sym.kind === 'env' ? envs : cmds).get(sym.name);
    if (!e) return undefined;
    let call = null;
    if (sym.kind === 'cmd' && e.tokens.length) call = M.readCall(sym.code, sym.after, e.tokens);
    return new vscode.Hover(docMarkdown(e, call), new vscode.Range(pos.line, sym.start, pos.line, sym.end));
  }
};

const definition = {
  async provideDefinition(doc, pos) {
    if (!cfg().get('macros', true)) return undefined;
    const sym = symbolAt(doc, pos);
    if (!sym) return undefined;
    const { cmds, envs } = await allMacros(doc);
    const e = (sym.kind === 'env' ? envs : cmds).get(sym.name);
    if (!e) return undefined;
    const link = {
      originSelectionRange: new vscode.Range(pos.line, sym.start, pos.line, sym.end),
      targetUri: vscode.Uri.file(e.file),
      targetRange: new vscode.Range(e.line, 0, e.endLine, 1000),
      targetSelectionRange: new vscode.Range(e.line, 0, e.line, 1000)
    };
    return [link];
  }
};

const signatureHelp = {
  async provideSignatureHelp(doc, pos) {
    if (!cfg().get('macros', true)) return undefined;
    const from = Math.max(0, pos.line - 3);
    const text = doc.getText(new vscode.Range(from, 0, pos.line, pos.character));
    const ctx = M.callContext(text);
    if (!ctx) return undefined;
    const { cmds } = await allMacros(doc);
    const e = cmds.get(ctx.name);
    if (!e || !e.tokens.length) return undefined;
    const parts = M.signatureParts(e);
    // match the groups already written to tokens, then find the one being typed
    const nextOf = (from, type) => {
      for (let q = from; q < e.tokens.length; q++) {
        const t = e.tokens[q];
        if (t.t === 's' || t.t === 't') continue;
        if (t.open === type) return q;
      }
      return -1;
    };
    let p = 0;
    for (const type of ctx.types) {
      const q = nextOf(p, type);
      p = q < 0 ? p : q + 1;
    }
    let active = nextOf(p, ctx.type);
    if (active < 0) active = Math.min(p, e.tokens.length - 1);
    if (active >= e.tokens.length) active = e.tokens.length - 1;
    const info = new vscode.SignatureInformation(parts.label, e.doc ? new vscode.MarkdownString(e.doc) : undefined);
    info.parameters = parts.params.map((r) => new vscode.ParameterInformation([r[0], r[1]]));
    const help = new vscode.SignatureHelp();
    help.signatures = [info];
    help.activeSignature = 0;
    help.activeParameter = active;
    return help;
  }
};

/* ------------------------------ commands ----------------------------- */
async function pickMacro() {
  const ed = vscode.window.activeTextEditor;
  const { cmds, envs } = await allMacros(ed && ed.document);
  const all = [...cmds.values(), ...envs.values()];
  if (!all.length) {
    vscode.window.showInformationMessage('Макросів не знайдено. Перевір, що в main.tex є \\documentclass{...} із локальним .cls, або задай tssworkflow.macroFiles.');
    return;
  }
  const items = all.sort((a, b) => a.name.localeCompare(b.name)).map((e) => ({
    label: (e.kind === 'env' ? '$(symbol-struct) ' : e.op ? '$(symbol-operator) ' : '$(symbol-function) ') + (e.kind === 'env' ? e.name : '\\' + e.name),
    description: M.signature(e).slice((e.kind === 'env' ? e.name : '\\' + e.name).length),
    detail: relName(e.file) + ':' + (e.line + 1) + (e.doc ? ' · ' + e.doc.split('\n')[0] : ''),
    e
  }));
  const pick = await vscode.window.showQuickPick(items, { matchOnDescription: true, matchOnDetail: true, placeHolder: 'Макроси з класу й пакетів проєкту (' + all.length + ')' });
  if (!pick) return;
  const pos = new vscode.Position(pick.e.line, 0);
  await vscode.window.showTextDocument(vscode.Uri.file(pick.e.file), { selection: new vscode.Range(pos, pos) });
}

async function reload() {
  invalidate();
  const ed = vscode.window.activeTextEditor;
  const { cmds, envs } = await allMacros(ed && ed.document);
  const files = sourcesCache ? sourcesCache.files : [];
  vscode.window.showInformationMessage('Макроси оновлено: ' + cmds.size + ' команд, ' + envs.size + ' середовищ у ' + files.length + ' файлах.');
}

/* ------------- macros file for the LaTeX Workshop math preview ------------ */
function mathjaxTarget(folder) {
  const rel = String(cfg().get('mathjaxMacrosFile', 'mathjax-macros.tex') || 'mathjax-macros.tex');
  const dir = path.dirname(path.resolve(folder.uri.fsPath, cfg().get('mainFile', 'main.tex') || 'main.tex'));
  return { rel, abs: path.resolve(dir, rel) };
}

function activeFolder() {
  const ed = vscode.window.activeTextEditor;
  return (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
}

async function writeMathJaxFile(folder) {
  const files = await getSourceFiles();
  const entries = [];
  for (const f of files) for (const e of macrosOfFile(f)) entries.push(e);
  const t = mathjaxTarget(folder);
  const g = M.toMathJaxMacros(entries, 'Generated by TSS Workflow from ' + (files.map((f) => path.basename(f)).join(', ') || 'nothing'));
  fs.writeFileSync(t.abs, g.text, 'utf8');
  log('[macros] MathJax: ' + t.abs + ': ' + g.count + ' макросів' + (g.skipped.length ? ', пропущено ' + g.skipped.length + ': ' + g.skipped.join(', ') : ''));
  return { t, g, files };
}

async function generateMathJax() {
  const folder = activeFolder();
  if (!folder) { vscode.window.showWarningMessage('Відкрий папку проєкту (workspace).'); return; }
  const files = await getSourceFiles();
  if (!files.length) {
    vscode.window.showWarningMessage('Не знайдено .cls/.sty проєкту. Перевір \\documentclass у main.tex або задай tssworkflow.macroFiles.');
    return;
  }
  const { t, g } = await writeMathJaxFile(folder);
  const lw = vscode.workspace.getConfiguration('latex-workshop', folder.uri);
  const have = lw.get('hover.preview.newcommand.newcommandFile', '');
  const ext = lw.get('hover.preview.mathjax.extensions', []) || [];
  const ready = have === t.rel && ext.includes('boldsymbol');
  const msg = 'Записано ' + path.basename(t.abs) + ': ' + g.count + ' макросів' + (g.skipped.length ? ', пропущено ' + g.skipped.length + ' (' + g.skipped.slice(0, 6).join(', ') + (g.skipped.length > 6 ? ', …' : '') + ')' : '') + '.';
  if (ready) { vscode.window.showInformationMessage(msg + ' LaTeX Workshop уже налаштовано.'); return; }
  const act = 'Налаштувати LaTeX Workshop';
  const pick = await vscode.window.showInformationMessage(msg + ' Щоб превʼю формул їх бачило, потрібні два налаштування LaTeX Workshop.', act);
  if (pick !== act) return;
  await lw.update('hover.preview.newcommand.newcommandFile', t.rel, vscode.ConfigurationTarget.Workspace);
  const next = Array.from(new Set([...ext, 'boldsymbol']));
  await lw.update('hover.preview.mathjax.extensions', next, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage('Налаштовано (налаштування робочого простору). Наведи курсор на формулу, щоб перевірити.');
}

// regenerate silently when the class changes, but only if the file was generated before
async function autoMathJax() {
  if (!cfg().get('mathjaxAutoUpdate', true)) return;
  const folder = activeFolder();
  if (!folder) return;
  const t = mathjaxTarget(folder);
  if (!fs.existsSync(t.abs)) return;
  try { await writeMathJaxFile(folder); } catch (e) { log('[macros] MathJax: ' + (e && e.message ? e.message : e)); }
}

function register(context, api) {
  if (api && api.log) log = api.log;
  if (api && api.exclude) EXCLUDE = api.exclude;
  const subs = context.subscriptions;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{cls,sty}');
  subs.push(
    watcher,
    watcher.onDidCreate(invalidate), watcher.onDidDelete(invalidate), watcher.onDidChange(() => fileCache.clear()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow')) invalidate(); }),
    vscode.workspace.onDidSaveTextDocument((d) => {
      const f = d.uri.fsPath.toLowerCase();
      if (/\.(cls|sty)$/.test(f) || path.basename(f) === String(cfg().get('mainFile', 'main.tex')).toLowerCase()) {
        sourcesCache = null;
        if (/\.(cls|sty)$/.test(f)) autoMathJax();
      }
    }),
    vscode.commands.registerCommand('tssworkflow.generateMathJax', generateMathJax),
    vscode.commands.registerCommand('tssworkflow.pickMacro', pickMacro),
    vscode.commands.registerCommand('tssworkflow.reloadMacros', reload),
    vscode.languages.registerCompletionItemProvider(SELECTOR, completion, '\\', '{'),
    vscode.languages.registerHoverProvider(SELECTOR, hover),
    vscode.languages.registerDefinitionProvider(SELECTOR, definition),
    vscode.languages.registerSignatureHelpProvider(SELECTOR, signatureHelp, { triggerCharacters: ['{', '['], retriggerCharacters: ['}', ']', ','] })
  );
}

module.exports = { register, _allMacros: allMacros, _getSourceFiles: getSourceFiles };
