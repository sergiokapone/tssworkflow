'use strict';
/* corePure.js: one door to the pure text helpers. The code lives in the topical modules below; none of them needs vscode. */
module.exports = Object.assign(
  {},
  require('./texBasePure'), // splitting rows, code ranges no rule may touch, wrapping
  require('./typographyPure'), // typography rules, sentences
  require('./structurePure'), // tables, environments, labels, frames, headings
  require('./logPure'), // what the build prints: pplatex, texlogsieve, .log, hooks, passes
  require('./normalizePure'), // normalization, equation*, citations, figure checks, lint rules
  require('./workspacePure'), // project settings, main file, PATH search, \\documentclass, picture preview
);
