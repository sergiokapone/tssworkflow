'use strict';
// node build.js [patch|minor|major|X.Y.Z] [--no-tests] [--out folder]
// One call: raises the version in extension/package.json and extension.vsixmanifest (only when an argument is given),
// runs tests/run-all.js (a failure restores both versions and stops), then packs vsix/ into
// tssworkflow-X_Y_Z.vsix (next to this file or in --out). No external programs: the zip is written here.
// Layout:  build.js  tests/  vsix/{[Content_Types].xml, extension.vsixmanifest, extension/}
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');

const root = __dirname;
const vsix = path.join(root, 'vsix');
const pkgFile = path.join(vsix, 'extension', 'package.json');
const manFile = path.join(vsix, 'extension.vsixmanifest');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : root);
const bump = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
const die = (m) => { console.error('build: ' + m); process.exit(1); };

/* ------------------------------- version ------------------------------- */
const pkgText = fs.readFileSync(pkgFile, 'utf8');
const manText = fs.readFileSync(manFile, 'utf8');
const cur = (/"version"\s*:\s*"([^"]+)"/.exec(pkgText) || [])[1];
const curMan = (/<Identity[^>]*\sVersion="([^"]+)"/.exec(manText) || [])[1];
if (!cur) die('no "version" in extension/package.json');
if (!curMan) die('no Identity Version in extension.vsixmanifest');
if (cur !== curMan) console.log('build: versions differ (package.json ' + cur + ', manifest ' + curMan + '): both are set to the target version');

function nextVersion(v, how) {
  if (!how) return cur;
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) die('cannot raise version "' + v + '"');
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  if (how === 'patch') return a + '.' + b + '.' + (c + 1);
  if (how === 'minor') return a + '.' + (b + 1) + '.0';
  if (how === 'major') return (a + 1) + '.0.0';
  return die('unknown argument "' + how + '": patch, minor, major or X.Y.Z');
}
const version = nextVersion(cur, bump);
const setVersions = (v) => {
  fs.writeFileSync(pkgFile, pkgText.replace(/("version"\s*:\s*")[^"]+(")/, '$1' + v + '$2'));
  fs.writeFileSync(manFile, manText.replace(/(<Identity[^>]*\sVersion=")[^"]+(")/, '$1' + v + '$2'));
};
const restore = () => { fs.writeFileSync(pkgFile, pkgText); fs.writeFileSync(manFile, manText); };
setVersions(version);
console.log('build: version ' + cur + (version === cur ? ' (unchanged)' : ' -> ' + version));

/* -------------------------------- tests -------------------------------- */
if (!flag('--no-tests')) {
  const runAll = path.join(root, 'tests', 'run-all.js');
  if (!fs.existsSync(runAll)) { restore(); die('tests/run-all.js not found (use --no-tests to skip)'); }
  const r = spawnSync(process.execPath, [runAll, path.join(vsix, 'extension')], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) { restore(); die('tests failed: versions restored, nothing packed'); }
}

/* ---------------------------------- zip -------------------------------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

function listFiles(dir, rel) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name === '.DS_Store' || e.name === 'Thumbs.db' || e.name === 'node_modules' || e.name.endsWith('.vsix')) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) out = out.concat(listFiles(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

function makeZip(entries) { // [{ name, data: Buffer }] -> Buffer
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.data, { level: 9 });
    const useDeflate = deflated.length < e.data.length;
    const body = useDeflate ? deflated : e.data;
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(useDeflate ? 8 : 0, 8); lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(useDeflate ? 8 : 0, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([cd, end]));
}

// reads the zip back (central directory) and compares names and contents with `entries`
function verifyZip(buf, entries) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count !== entries.length) throw new Error('entry count ' + count + ' != ' + entries.length);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central header');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26), lxlen = buf.readUInt16LE(off + 28);
    const raw = buf.slice(off + 30 + lnlen + lxlen, off + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (name !== entries[i].name) throw new Error('order/name mismatch: ' + name);
    if (crc32(data) !== crc || !data.equals(entries[i].data)) throw new Error('content mismatch: ' + name);
    p += 46 + nlen + xlen + clen;
  }
}

const first = ['[Content_Types].xml', 'extension.vsixmanifest'];
for (const f of first) if (!fs.existsSync(path.join(vsix, f))) { restore(); die('vsix/' + f + ' not found'); }
const rest = listFiles(path.join(vsix, 'extension'), 'extension');
const entries = first.concat(rest).map((name) => ({ name, data: fs.readFileSync(path.join(vsix, name)) }));
const zip = makeZip(entries);
try { verifyZip(zip, entries); } catch (e) { restore(); die('self-check of the archive failed: ' + e.message); }
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'tssworkflow-' + version.replace(/\./g, '_') + '.vsix');
fs.writeFileSync(outFile, zip);
console.log('build: ' + outFile + '  (' + entries.length + ' files, ' + Math.round(zip.length / 1024) + ' KB)');
