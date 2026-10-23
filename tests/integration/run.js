'use strict';
// npm run test:vscode  - the tests of tests/integration/suite.js in a real VS Code. The first run downloads VS Code into .vscode-test/
// (VSCODE_TEST_VERSION: 'stable' by default, or e.g. '1.74.0' for the oldest version of engines). The workspace is a fresh copy of
// tests/integration/fixture, so that the edits of the tests never touch the repository. On Linux without a display: xvfb-run -a.
const path = require('path'), fs = require('fs'), os = require('os');
const { runTests } = require('@vscode/test-electron');

(async () => {
  const ext = path.resolve(__dirname, '..', '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-vscode-'));
  fs.cpSync(path.join(__dirname, 'fixture'), work, { recursive: true });
  try {
    await runTests({
      version: process.env.VSCODE_TEST_VERSION || 'stable',
      extensionDevelopmentPath: ext,
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      // no other extensions (LaTeX Workshop would add its own providers), a profile of its own, no telemetry or welcome page
      launchArgs: [work, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.join(work, '..', path.basename(work) + '-user')]
    });
  } catch (e) {
    console.error('VS Code tests failed: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(path.join(work, '..', path.basename(work) + '-user'), { recursive: true, force: true });
  }
})();
