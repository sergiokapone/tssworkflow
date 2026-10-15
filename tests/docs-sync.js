'use strict';
// node tests/docs-sync.js [path/to/extension] [LaTeX-VSCode-setup.md] [--write]
// Keeps the mechanical parts of the reference (sections 7 and 8) in step with package.json, so that they cannot drift:
//   - the sentences "Усього N ключів" / "Усього N команд" and the version in "(з `package.json` X;";
//   - a setting or a command that package.json has and the tables do not: a stub row `**ЗАПОВНИТИ ОПИС**` (with the key / the id, the type,
//     the default, the title and the version from package.json), appended to the last table of the section. docs.test.js fails
//     while a stub is left, so a row is never forgotten and never published unwritten.
// The descriptions are written by hand and are never touched; a row of a setting that is gone is only reported (never deleted).
// Without --write it only reports and exits 1 when something is out of step.
const path = require('path'), fs = require('fs');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const write = process.argv.includes('--write');
const ext = path.resolve(args[0] || path.join(__dirname, '..', 'vsix', 'extension'));
const docPath = path.resolve(args[1] || [path.join(__dirname, '..', 'LaTeX-VSCode-setup.md'), path.join(__dirname, '..', '..', 'LaTeX-VSCode-setup.md')].find((p) => fs.existsSync(p)) || 'LaTeX-VSCode-setup.md');
const pk = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8'));
const raw = fs.readFileSync(docPath, 'utf8');
const crlf = raw.includes('\r\n');
const lines = raw.split(crlf ? '\r\n' : '\n');

const props = {};
for (const blk of [].concat(pk.contributes.configuration)) Object.assign(props, blk.properties);
const keys = Object.keys(props).filter((k) => k.startsWith('tssworkflow.')).map((k) => k.slice('tssworkflow.'.length));
const cmds = pk.contributes.commands.map((c) => ({ id: c.command.replace(/^tssworkflow\./, ''), title: String(c.title || '').replace(/^TSS Workflow:\s*/, '') }));
const keyOf = {};
for (const kb of pk.contributes.keybindings || []) { const id = kb.command.replace(/^tssworkflow\./, ''); if (!keyOf[id]) keyOf[id] = kb.key; }

const idxOf = (prefix, from) => lines.findIndex((l, i) => i >= (from || 0) && l.startsWith(prefix));
const s7 = idxOf('## 7.'), s8 = idxOf('## 8.'), s9 = idxOf('## 9.');
if (s7 < 0 || s8 < s7 || s9 < s8) { console.error('sections 7 / 8 / 9 not found in ' + docPath); process.exit(2); }
const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const settingRows = () => lines.slice(s7, s8).filter((l) => /^\|\s*`[A-Za-z][A-Za-z0-9.]*`\s*\|/.test(l)).map(cells).filter((r) => !/^`(ltex|workbench)\./.test(r[0]));
const commandRows = () => lines.slice(s8, s9).filter((l) => /^\|\s*`[^`]+`\s*\|\s*`[A-Za-z][A-Za-z0-9]*`\s*\|/.test(l)).map(cells);

const typeWord = (p) => ({ boolean: 'булевий', string: 'рядок', integer: 'ціле', number: 'число', array: 'масив', object: "об'єкт" }[p.type] || String(p.type));
const dflt = (p) => (['boolean', 'number', 'string'].includes(typeof p.default) ? '`' + String(p.default) + '`' : p.default === undefined ? '—' : '`' + JSON.stringify(p.default) + '`');
const todo = '**ЗАПОВНИТИ ОПИС**';

const report = [];
const docKeys = new Set(settingRows().map((r) => r[0].replace(/`/g, '')));
const docIds = new Set(commandRows().map((r) => r[1].replace(/`/g, '')));
const missingKeys = keys.filter((k) => !docKeys.has(k));
const missingCmds = cmds.filter((c) => !docIds.has(c.id));
const goneKeys = [...docKeys].filter((k) => !keys.includes(k));
const goneIds = [...docIds].filter((i) => !cmds.some((c) => c.id === i));
missingKeys.forEach((k) => report.push('settings: no row for ' + k));
missingCmds.forEach((c) => report.push('commands: no row for ' + c.id));
goneKeys.forEach((k) => report.push('settings: the row of ' + k + ' is not in package.json (delete it by hand)'));
goneIds.forEach((i) => report.push('commands: the row of ' + i + ' is not in package.json (delete it by hand)'));

// insertion point: after the last table line of the section
const lastTableLine = (from, to) => { let last = -1; for (let i = from; i < to; i++) if (lines[i].startsWith('|')) last = i; return last; };
const newSettingRow = (k) => '| `' + k + '` | ' + typeWord(props['tssworkflow.' + k]) + ' | ' + dflt(props['tssworkflow.' + k]) + ' | ' + (Array.isArray(props['tssworkflow.' + k].enum) ? props['tssworkflow.' + k].enum.map((e) => '`' + e + '`').join(', ') : '—') + ' | ' + todo + ' ' + String(props['tssworkflow.' + k].description || props['tssworkflow.' + k].markdownDescription || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim().slice(0, 200) + ' | ' + pk.version + ' |';
const newCommandRow = (c) => '| `' + c.title.replace(/`/g, "'") + '` | `' + c.id + '` | ' + (keyOf[c.id] ? '`' + keyOf[c.id] + '`' : '—') + ' | палітра команд | ' + todo + ' | ' + pk.version + ' |';

// counts and version
const countFix = [];
const fixCount = (from, to, re, n, what) => {
  for (let i = from; i < to; i++) {
    const m = re.exec(lines[i]);
    if (m && +m[1] !== n) { countFix.push(what + ': the text says ' + m[1] + ', package.json has ' + n); return { i, was: m[1] }; }
    if (m) return null;
  }
  return null;
};
const nKeys = keys.length, nCmds = cmds.length;
const fk = fixCount(s7, s8, /Усього (\d+) ключів/, nKeys, 'settings count');
const fc = fixCount(s8, s9, /Усього (\d+) команд/, nCmds, 'commands count');
let fv = null;
for (let i = s8; i < s9; i++) { const m = /\(з `package\.json` (\d+\.\d+\.\d+)/.exec(lines[i]); if (m) { if (m[1] !== pk.version) { countFix.push('version in the commands sentence: ' + m[1] + ', package.json has ' + pk.version); fv = { i, was: m[1] }; } break; } }
countFix.forEach((x) => report.push(x));

if (!report.length) { console.log('docs-sync: the reference is in step with package.json (' + nKeys + ' settings, ' + nCmds + ' commands, ' + pk.version + ')'); process.exit(0); }
report.forEach((r) => console.log((write ? 'fix   ' : 'DIFF  ') + r));
if (!write) { console.log('\nrun with --write to fix the counts and to add stub rows');  process.exit(1); }

// apply from the bottom up, so that the indexes stay valid
const edits = [];
if (missingCmds.length) edits.push({ at: lastTableLine(s8, s9) + 1, rows: missingCmds.map(newCommandRow) });
if (missingKeys.length) edits.push({ at: lastTableLine(s7, s8) + 1, rows: missingKeys.map(newSettingRow) });
for (const e of edits.sort((a, b) => b.at - a.at)) lines.splice(e.at, 0, ...e.rows);
const reFind = (re, from) => { for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i; return -1; };
const s8b = reFind(/^## 8\./, 0), s9b = reFind(/^## 9\./, 0);
if (fk) { const i = reFind(/Усього \d+ ключів/, reFind(/^## 7\./, 0)); lines[i] = lines[i].replace(/Усього \d+ ключів/, 'Усього ' + nKeys + ' ключів'); }
if (fc) { const i = reFind(/Усього \d+ команд/, s8b); lines[i] = lines[i].replace(/Усього \d+ команд/, 'Усього ' + nCmds + ' команд'); }
if (fv) { const i = reFind(/\(з `package\.json` \d+\.\d+\.\d+/, s8b); lines[i] = lines[i].replace(/\(з `package\.json` \d+\.\d+\.\d+/, '(з `package.json` ' + pk.version); }
void s9b;
fs.writeFileSync(docPath, lines.join(crlf ? '\r\n' : '\n'));
console.log('\nwritten: ' + docPath + (missingKeys.length + missingCmds.length ? '; ' + (missingKeys.length + missingCmds.length) + ' stub row(s) marked ' + todo + ': write the descriptions, docs.test.js fails until then' : ''));
