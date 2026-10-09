'use strict';
/* TSS Workflow 0.4.0: the "Команди" panel of the Activity Bar - the "State" group (running build, the chapter that
 * a click builds, build on save) and all commands in groups, like the panel of LaTeX Workshop. The list of groups
 * is in sidebarPure.js. A click runs the command on the editor that was active last. */
const vscode = require('vscode');
const path = require('path');
const S = require('./sidebarPure');
const P = require('./corePure');
const { cfg } = require('./util');


let provider = null;
let building = null; // { label, job } while a build runs

// what the panel shows about the file in the editor: a chapter, a figure, a root file, or nothing
function currentTarget() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  const file = ed.document.uri.fsPath;
  const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri);
  if (!folder || !/\.(tex|tikz)$/i.test(file)) return null;
  const t = P.hooksTarget(path.relative(folder.uri.fsPath, file));
  if (t) return t.tikz ? { kind: 'figure', name: t.tikz, chapter: t.chapter } : { kind: 'chapter', name: t.chapter };
  return { kind: 'root', name: path.basename(file) };
}

class Provider {
  constructor(keys, titles) {
    this.keys = keys;
    this.titles = titles;
    this._em = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._em.event;
  }
  refresh() { this._em.fire(); }
  getTreeItem(el) { return el.item; }
  getChildren(el) {
    if (el) return el.children || [];
    const l = cfg().get('panelLanguage', 'uk');
    return [this.stateGroup(l)].concat(S.GROUPS.map((g) => this.group(g, l)));
  }
  stateGroup(l) {
    const item = new vscode.TreeItem(S.STATE_LABEL[l === 'en' ? 'en' : 'uk'], vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'tssworkflow.group.state';
    item.iconPath = new vscode.ThemeIcon(S.GROUP_ICON_STATE);
    item.contextValue = 'group';
    const rows = S.stateItems(l, { building, target: currentTarget(), auto: !!cfg().get('compileOnSave', false) });
    return { item, children: rows.map((r) => this.stateRow(r)) };
  }
  stateRow(r) {
    const item = new vscode.TreeItem(r.label, vscode.TreeItemCollapsibleState.None);
    item.id = 'tssworkflow.state.' + r.id;
    item.iconPath = new vscode.ThemeIcon(r.icon);
    if (r.command) item.command = { command: r.command, title: r.label };
    if (r.tooltip) item.tooltip = r.tooltip;
    item.contextValue = 'state';
    return { item };
  }
  group(g, l) {
    const item = new vscode.TreeItem(S.groupLabel(g, l), g.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.id = 'tssworkflow.group.' + g.id;
    item.iconPath = new vscode.ThemeIcon(g.icon);
    item.contextValue = 'group';
    // "stop build" is shown only while a build runs
    const items = g.items.filter((it) => it[0] !== 'stopBuild' || building);
    return { item, children: items.map((it) => this.leaf(it, l)) };
  }
  leaf(it, l) {
    const [id, , icon, o] = it;
    const label = S.itemLabel(it, l, this.titles);
    const raw = o && o.raw;
    const cmd = raw || S.PREFIX + id;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = 'tssworkflow.item.' + id;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.command = { command: cmd, title: label, arguments: (o && o.args) || [] };
    const key = this.keys[cmd];
    if (key) item.description = key;
    item.tooltip = (this.titles[cmd] || label) + (key ? '  (' + key + ')' : '');
    item.contextValue = 'command';
    return { item };
  }
}

// called by extension.js when a build starts (info = { label, job }) and ends (null)
function setBuilding(info) {
  building = info || null;
  if (provider) provider.refresh();
}

function register(context) {
  const pkg = (context.extension && context.extension.packageJSON) || {};
  const contrib = pkg.contributes || {};
  const titles = {};
  for (const c of contrib.commands || []) titles[c.command] = c.title;
  provider = new Provider(S.keyMap(contrib.keybindings), titles);
  context.subscriptions.push(
    vscode.window.createTreeView('tssworkflow.commandsView', { treeDataProvider: provider, showCollapseAll: true }),
    vscode.window.onDidChangeActiveTextEditor(() => provider.refresh()),
    vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('tssworkflow')) provider.refresh(); })
  );
}

exports.register = register;
exports.setBuilding = setBuilding;
exports.Provider = Provider;
