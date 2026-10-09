'use strict';
// used by tests/lint.test.js; no plugins or packages needed beyond eslint itself
const g = (names) => Object.fromEntries(names.split(' ').map((n) => [n, 'readonly']));
const NODE = g('process console Buffer setTimeout clearTimeout setInterval clearInterval setImmediate URL TextDecoder TextEncoder AbortController');
const BROWSER = g('window document console setTimeout clearTimeout setInterval clearInterval requestAnimationFrame navigator getComputedStyle Node Event KeyboardEvent MouseEvent ClipboardEvent DOMParser acquireVsCodeApi');
const rules = {
  'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
  'no-unreachable': 'error', 'no-dupe-keys': 'error', 'no-redeclare': 'error', 'no-dupe-args': 'error',
  'no-func-assign': 'error', 'no-const-assign': 'error', 'no-self-assign': 'error', 'no-unsafe-finally': 'error',
};
module.exports = [
  { ignores: ['media/katex/**', 'node_modules/**'] },
  { files: ['**/*.js'], ignores: ['media/tableEditor/**'], languageOptions: { sourceType: 'commonjs', ecmaVersion: 2022, globals: NODE }, rules },
  { files: ['media/tableEditor/**/*.js'], languageOptions: { sourceType: 'script', ecmaVersion: 2022, globals: BROWSER }, rules },
];
