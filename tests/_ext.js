'use strict';
// The folder of the extension that the tests check when no path is given: vsix/extension/ (an unpacked .vsix) when it exists,
// else the root of this project (the files lie beside tests/). run-all.js and every *.test.js use it.
const path = require('path'), fs = require('fs');
const vsix = path.join(__dirname, '..', 'vsix', 'extension');
module.exports = fs.existsSync(path.join(vsix, 'package.json')) ? vsix : path.join(__dirname, '..');
