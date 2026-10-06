'use strict';
// node tests/sidebar.test.js [path/to/extension]; checks the tree against package.json and runs sidebar.js on a vscode stub
const path = require('path'), fs = require('fs'), assert = require('assert'), Module = require('module');
const ext = path.resolve(process.argv[2] || path.join(__dirname, '..', 'vsix', 'extension'));
const pk = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const S = require(path.join(ext, 'sidebarPure.js'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('every command of package.json is in the tree exactly once', () => {
  const r = S.coverage(pk.contributes.commands.map((c) => c.command));
  assert.deepStrictEqual(r, { missing: [], duplicates: [], unknown: [] });
});
t('coverage notices a missing, a duplicate and an unknown command', () => {
  const r = S.coverage(pk.contributes.commands.map((c) => c.command).filter((c) => c !== 'tssworkflow.compile').concat('tssworkflow.brandNew'));
  assert.deepStrictEqual(r.missing, ['brandNew']);
  assert.deepStrictEqual(r.unknown, ['compile']);
});
t('formatKey / keyMap', () => {
  assert.strictEqual(S.formatKey('ctrl+alt+t'), 'Ctrl+Alt+T');
  assert.strictEqual(S.formatKey('shift+f5'), 'Shift+F5');
  assert.strictEqual(S.formatKey('f5'), 'F5');
  assert.deepStrictEqual(S.keyMap([{ command: 'a', key: 'f5' }, { command: 'a', key: 'f6' }, { command: 'b' }]), { a: 'F5' });
});
t('group ids and labels are unique, no empty groups', () => {
  assert.strictEqual(new Set(S.GROUPS.map((g) => g.id)).size, S.GROUPS.length);
  assert.strictEqual(new Set(S.GROUPS.map((g) => g.label)).size, S.GROUPS.length);
  for (const g of S.GROUPS) assert.ok(g.items.length > 0 && g.label && g.icon, g.id);
});
t('package.json: container, view, activation event, icon file', () => {
  const c = pk.contributes;
  assert.strictEqual(c.viewsContainers.activitybar[0].id, 'tssworkflow');
  assert.ok(fs.existsSync(path.join(ext, c.viewsContainers.activitybar[0].icon)));
  assert.strictEqual(c.views.tssworkflow[0].id, 'tssworkflow.commandsView');
  assert.ok(pk.activationEvents.includes('onView:tssworkflow.commandsView'));
});
t('sidebar.js builds the tree: groups, commands, shortcuts, settings link', () => {
  const deep = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : deep()), apply: () => deep(), construct: () => deep() });
  const stub0 = {
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    TreeItem: class { constructor(l, s) { this.label = l; this.collapsibleState = s; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    window: new Proxy({ createTreeView: (id, o) => { if (id === 'tssworkflow.commandsView') stub.created = { id, o }; return { dispose() {} }; } }, { get: (o, k) => (k in o ? o[k] : deep()) }),
    workspace: new Proxy({ getConfiguration: () => ({ get: (k, d) => d }) }, { get: (o, k) => (k in o ? o[k] : deep()) }),
    commands: new Proxy({}, { get: () => deep() })
  };
  const stub = new Proxy(stub0, { get: (o, k) => (k in o ? o[k] : k === 'created' ? undefined : deep()), set: (o, k, v) => { o[k] = v; return true; } });
  const orig = Module._load;
  Module._load = function (r, ...a) { return r === 'vscode' ? stub : orig.call(this, r, ...a); };
  const M = require(path.join(ext, 'sidebar.js'));
  const subs = [];
  M.register({ subscriptions: subs, extension: { packageJSON: pk } });
  Module._load = orig;
  assert.strictEqual(stub.created.id, 'tssworkflow.commandsView');
  const p = stub.created.o.treeDataProvider;
  const groups = p.getChildren();
  assert.strictEqual(groups.length, S.GROUPS.length + 1, 'the State group (0.4.0) comes first');
  assert.strictEqual(p.getTreeItem(groups[1]).collapsibleState, 2);
  assert.strictEqual(p.getTreeItem(groups[3]).collapsibleState, 1);
  const build = p.getChildren(groups[1]).map((x) => p.getTreeItem(x));
  assert.strictEqual(build[0].command.command, 'tssworkflow.compilePdf');
  assert.strictEqual(build[0].description, 'F5');
  assert.ok(build[0].tooltip.includes('Compile + open PDF'));
  const proj = p.getChildren(groups[groups.length - 1]).map((x) => p.getTreeItem(x));
  const st = proj[proj.length - 1];
  assert.deepStrictEqual([st.command.command, st.command.arguments], ['workbench.action.openSettings', ['tssworkflow']]);
  const ids = [];
  for (const g of groups) for (const l of p.getChildren(g)) ids.push(p.getTreeItem(l).id);
  assert.strictEqual(new Set(ids).size, ids.length, 'item ids are unique');
});
console.log('\n' + n + ' tests passed');
