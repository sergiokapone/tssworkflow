'use strict';
// node build.js [patch|minor|major|X.Y.Z]
// Оновлює версію в package.json у корені проєкту.
const fs = require('fs');
const path = require('path');

const root = __dirname;
const pkgFile = path.join(root, 'package.json');
const args = process.argv.slice(2);
const how = args.find(a => !a.startsWith('--'));
const die = (m) => { console.error('build: ' + m); process.exit(1); };

const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
const cur = pkg.version;
if (!cur) die('no "version" in package.json');

function nextVersion(v, how) {
  if (!how) return cur;
  if (/^\d+\.\d+\.\d+$/.test(how)) return how;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) die('cannot parse version "' + v + '"');
  const [a, b, c] = [+m[1], +m[2], +m[3]];
  if (how === 'patch') return a + '.' + b + '.' + (c + 1);
  if (how === 'minor') return a + '.' + (b + 1) + '.0';
  if (how === 'major') return (a + 1) + '.0.0';
  return die('unknown argument "' + how + '": patch, minor, major or X.Y.Z');
}

const version = nextVersion(cur, how);
if (version === cur) {
  console.log('build: version ' + cur + ' (unchanged)');
} else {
  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  console.log('build: version ' + cur + ' -> ' + version);
}