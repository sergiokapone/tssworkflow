'use strict';
// node .github/release-notes.js <version> [out.md]  - the section "## <version>" of CHANGELOG.md (without its heading), the body of the
// GitHub release of the tag v<version> (ci.yml). Exits with 1 when the section is missing or empty: a tag without a changelog entry
// gets no release. tests/releaseNotes.test.js checks it against the current version.
const path = require('path'), fs = require('fs');

function section(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const a = lines.findIndex((l) => l.trim() === '## ' + version);
  if (a < 0) return null;
  let b = lines.findIndex((l, i) => i > a && /^## /.test(l));
  if (b < 0) b = lines.length;
  return lines.slice(a + 1, b).join('\n').trim() || null;
}

if (require.main === module) {
  const version = String(process.argv[2] || '').replace(/^v/, '');
  const text = section(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), version);
  if (!text) { console.error('CHANGELOG.md has no section "## ' + version + '"'); process.exit(1); }
  if (process.argv[3]) fs.writeFileSync(process.argv[3], text + '\n'); else console.log(text);
}

module.exports = { section };
