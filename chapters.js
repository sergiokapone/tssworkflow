'use strict';
/* TSS Workflow 0.4.1: the "Розділи" panel of the Activity Bar - the chapters of the project (from `\includechapter{X}` and
 * `\multiinclude{A, B}` lines of the main file, grouped by \part, plus folders X/X.tex that are not included), with the
 * figures X/tikz/*.tikz inside each.
 * Click opens the file; the buttons build the chapter or show its page output hooks. Both build commands open the
 * file first, because the build commands act on the active editor. The logic without VS Code: chaptersPure.js. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const C = require('./chaptersPure');
const { cfg, projectRoot } = require('./util');



const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } };

// the chapters in the order of the main file with the title of their \part, then the folders X/X.tex that it does not include
function listChapters(root) {
  const mainFile = cfg().get('mainFile', 'main.tex') || 'main.tex';
  const macro = cfg().get('chapterIncludeMacro', '\\includechapter') || '\\includechapter';
  const lists = cfg().get('chapterListMacros', ['\\multiinclude']);
  const main = readText(path.join(root, mainFile));
  const structure = main ? C.chapterStructure(main, macro, Array.isArray(lists) ? lists : []) : [];
  const out = [];
  for (const p of structure) for (const name of p.names) out.push({ name, included: true, part: p.title });
  const names = out.map((c) => c.name);
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => !d.startsWith('.')); } catch (e) { /* no folder */ }
  for (const d of dirs.sort((a, b) => a.localeCompare(b))) {
    if (names.includes(d)) continue;
    if (fs.existsSync(path.join(root, d, d + '.tex'))) out.push({ name: d, included: false, part: null });
  }
  return out.map((c) => {
    const file = path.join(root, c.name, c.name + '.tex');
    const text = readText(file);
    return Object.assign(c, { file, exists: text !== null, title: text ? C.chapterTitle(text) : '' });
  });
}

function figuresOf(root, name) {
  const dir = path.join(root, name, 'tikz');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.tikz$/i.test(f)); } catch (e) { /* none */ }
  return files.sort((a, b) => a.localeCompare(b)).map((f) => ({ kind: 'figure', name: path.basename(f, path.extname(f)), file: path.join(dir, f) }));
}

class Provider {
  constructor() {
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() { this._em.fire(); }
  getTreeItem(el) { return el.item; }
  getChildren(el) {
    if (el) return el.children || [];
    const root = projectRoot();
    if (!root) return [];
    const all = listChapters(root);
    const inc = all.filter((c) => c.included);
    const orphans = all.filter((c) => !c.included);
    if (!inc.some((c) => c.part)) return all.map((c) => this.chapter(root, c, false));
    // the project has \part: the chapters are grouped by it, the chapters outside of any \part stay at the top
    const nodes = [];
    let group = null;
    for (const c of inc) {
      if (!c.part) { group = null; nodes.push(this.chapter(root, c, false)); continue; }
      if (!group || group.title !== c.part) {
        group = this.group('part' + nodes.length, c.part, 'folder-library', vscode.TreeItemCollapsibleState.Expanded);
        group.title = c.part;
        nodes.push(group);
      }
      group.children.push(this.chapter(root, c, true));
    }
    for (const g of nodes) if (g.kind === 'group') g.item.description = String(g.children.length);
    if (orphans.length) {
      const g = this.group('orphans', 'Не підключені в головному файлі', 'circle-slash', vscode.TreeItemCollapsibleState.Collapsed);
      g.item.description = String(orphans.length);
      for (const c of orphans) g.children.push(this.chapter(root, c, true));
      nodes.push(g);
    }
    return nodes;
  }
  group(id, label, icon, state) {
    const item = new vscode.TreeItem(label, state);
    item.id = 'tssworkflow.chaptergroup.' + id;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = 'part';
    return { kind: 'group', item, children: [] };
  }
  chapter(root, c, grouped) {
    const figs = figuresOf(root, c.name);
    const item = new vscode.TreeItem(c.name, figs.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = 'tssworkflow.chapter.' + c.name;
    const note = !c.included && !grouped ? 'не підключено в головному файлі' : '';
    item.description = !c.exists ? 'немає ' + c.name + '/' + c.name + '.tex' : note + (c.title ? (note ? ' · ' : '') + c.title : '');
    item.description = item.description || undefined;
    item.iconPath = new vscode.ThemeIcon(!c.exists ? 'warning' : c.included ? 'book' : 'circle-slash');
    item.contextValue = c.exists ? 'chapter' : 'chapterMissing';
    item.tooltip = c.file;
    if (c.exists) item.command = { command: 'tssworkflow.openChapter', title: 'Відкрити', arguments: [{ file: c.file }] };
    const el = { kind: 'chapter', name: c.name, file: c.file, item };
    el.children = figs.map((f) => this.figure(f));
    return el;
  }
  figure(f) {
    const item = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
    item.id = 'tssworkflow.figure.' + f.file;
    item.iconPath = new vscode.ThemeIcon('graph');
    item.contextValue = 'figure';
    item.tooltip = f.file;
    item.command = { command: 'tssworkflow.openChapter', title: 'Відкрити', arguments: [{ file: f.file }] };
    return { kind: 'figure', name: f.name, file: f.file, item };
  }
}

const fileOf = (arg) => (arg && (arg.file || arg.fsPath)) || null;

async function openFile(file) {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  return vscode.window.showTextDocument(doc, { preview: false });
}

function register(context) {
  const provider = new Provider();
  context.subscriptions.push(vscode.window.createTreeView('tssworkflow.chaptersView', { treeDataProvider: provider, showCollapseAll: true }));

  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(() => provider.refresh(), 500); };
  const isTex = (p) => /\.(tex|tikz)$/i.test(p);
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((d) => { if (isTex(d.fileName)) later(); }),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow')) later(); })
  );
  if (vscode.workspace.createFileSystemWatcher) {
    const w = vscode.workspace.createFileSystemWatcher('**/*.{tex,tikz}');
    context.subscriptions.push(w, w.onDidCreate(later), w.onDidDelete(later));
  }

  const cmd = (id, fn) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    cmd('tssworkflow.refreshChapters', () => provider.refresh()),
    cmd('tssworkflow.openChapter', async (arg) => { const f = fileOf(arg); if (f) await openFile(f); }),
    cmd('tssworkflow.buildChapter', async (arg) => {
      const f = fileOf(arg);
      if (!f) return;
      await openFile(f);
      await vscode.commands.executeCommand('tssworkflow.compilePdf');
    }),
    cmd('tssworkflow.chapterHooks', async (arg) => {
      const f = fileOf(arg);
      if (!f) return;
      await openFile(f);
      await vscode.commands.executeCommand('tssworkflow.showHooks');
    })
  );
}

exports.register = register;
exports.Provider = Provider;
