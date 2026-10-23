'use strict';
// node tests/releaseNotes.test.js  - .github/release-notes.js: the body of a GitHub release is the CHANGELOG.md section of its version
const path = require('path'), fs = require('fs'), assert = require('assert');
const root = path.join(__dirname, '..');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const script = path.join(root, '.github', 'release-notes.js');
if (!fs.existsSync(script) || !fs.existsSync(path.join(root, 'CHANGELOG.md'))) { console.log('skip: no .github/release-notes.js or CHANGELOG.md (a packaged tree)'); process.exit(0); }
const { section } = require(script);

t('a section ends at the next "## " heading, CRLF or LF, without its own heading', () => {
  const log = '# Changelog\r\n\r\n## 1.0.1\r\nfix\r\n- a\r\n\r\n## 1.0.0\r\nfirst\r\n';
  assert.strictEqual(section(log, '1.0.1'), 'fix\n- a');
  assert.strictEqual(section(log, '1.0.0'), 'first');
});

t('a missing or empty section is null (the release job fails instead of an empty release)', () => {
  assert.strictEqual(section('## 1.0.0\nx\n', '1.0.10'), null);
  assert.strictEqual(section('## 1.0.1\n\n## 1.0.0\nx\n', '1.0.1'), null);
});

t('CHANGELOG.md has a section for the version of package.json (a tag of it would have no release otherwise)', () => {
  const v = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  assert.ok(section(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'), v), 'no "## ' + v + '" in CHANGELOG.md');
});

console.log('\n' + n + ' tests passed');
