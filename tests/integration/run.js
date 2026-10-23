'use strict';
// npm run test:vscode  - the tests of tests/integration/suite.js in a real VS Code. Which VS Code:
//  1. VSCODE_TEST_PATH: the executable given (Code.exe, or the code binary on Linux);
//  2. VSCODE_TEST_VERSION ('stable', '1.74.0' - the oldest version of engines): downloaded into .vscode-test/ (CI does this);
//  3. otherwise, outside CI, the VS Code installed on this machine (Code.exe next to a `code` found on PATH), nothing is downloaded;
//  4. no installed VS Code (or in CI without a version): the current stable, downloaded into .vscode-test/.
// The workspace is a fresh copy of tests/integration/fixture, so that the edits of the tests never touch the repository.
// On Linux without a display: xvfb-run -a.
const path = require('path'), fs = require('fs'), os = require('os');
const { runTests } = require('@vscode/test-electron');

// the executable of the VS Code on PATH: Windows - Code.exe in a PATH folder, or one level above a PATH folder with code.cmd (bin/);
// Linux - bin/code (a script) next to the binary code one level up. null when there is none.
function installedVSCode() {
  const file = (p) => fs.existsSync(p) && fs.statSync(p).isFile();
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (process.platform === 'win32') {
      if (file(path.join(dir, 'Code.exe'))) return path.resolve(dir, 'Code.exe');
      if (file(path.join(dir, 'code.cmd')) && file(path.join(dir, '..', 'Code.exe'))) return path.resolve(dir, '..', 'Code.exe');
    } else if (path.basename(dir) === 'bin' && file(path.join(dir, 'code')) && file(path.join(dir, '..', 'code'))) {
      return path.resolve(dir, '..', 'code');
    }
  }
  return null;
}

(async () => {
  const ext = path.resolve(__dirname, '..', '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tss-vscode-'));
  fs.cpSync(path.join(__dirname, 'fixture'), work, { recursive: true });
  const exe = process.env.VSCODE_TEST_PATH || (!process.env.VSCODE_TEST_VERSION && !process.env.CI ? installedVSCode() : null);
  console.log(exe ? 'VS Code: ' + exe : 'VS Code: ' + (process.env.VSCODE_TEST_VERSION || 'stable') + ' (downloaded into .vscode-test/)');
  try {
    await runTests({
      ...(exe ? { vscodeExecutablePath: exe } : { version: process.env.VSCODE_TEST_VERSION || 'stable' }),
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
