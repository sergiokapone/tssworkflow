'use strict';
// A test that needs a dev dependency (typescript, jsdom, eslint) and does not find it: skipped locally, so that the tests run
// without npm ci too, but a FAILURE in CI (the variable CI, set by GitHub Actions) or with TSS_STRICT=1, where a missing package
// means a broken npm ci and the check would otherwise pass unnoticed.
module.exports = function skip(msg) {
  const strict = !!(process.env.CI || process.env.TSS_STRICT);
  console.log((strict ? 'FAIL: ' : 'skip: ') + msg + (strict ? ' (CI/TSS_STRICT: a missing dev dependency is an error)' : ''));
  process.exit(strict ? 1 : 0);
};
