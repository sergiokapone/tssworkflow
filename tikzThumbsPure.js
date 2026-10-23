'use strict';
/* tikzThumbsPure.js (0.25.0): thumbnails of the figures X/tikz/name.tikz for the hover on \localinput (no VS Code API).
 * A figure is built through the driver of the project (tssworkflow.driver: the same \TargetChapter / \TargetTikz as the figure
 * build) into a cache folder, with the package preview (active, tightpage): every tikzpicture / circuitikz becomes a page cropped
 * to it. pdftocairo turns the pages into PNG. tikzThumbs.js runs the programs and keeps the cache. */
const path = require('path');
const crypto = require('crypto');

const PREVIEW_ENVS = ['tikzpicture', 'circuitikz'];
const MAX_PAGES = 6; // the hover shows at most this many pictures of one file
const DPI = 110;

// the TeX code before the driver: the target of the driver and the cropping (preview is loaded at the end of the preamble)
function pretex(chapter, tikz) {
  return '\\def\\TargetChapter{' + chapter + '}\\def\\TargetTikz{' + tikz + '}' +
    '\\AddToHook{begindocument/before}{\\RequirePackage[active,tightpage]{preview}' +
    PREVIEW_ENVS.map((e) => '\\PreviewEnvironment{' + e + '}').join('') + '}';
}

// lualatex: one pass, stops at the first error, no shell escape (the build starts by itself, on a hover)
function latexArgs({ chapter, tikz, driver, outDir, job }) {
  return ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-output-directory=' + outDir, '-jobname=' + job,
    pretex(chapter, tikz) + '\\input{' + driver + '}'];
}

// pdftocairo: every page into <prefix>-<n>.png on white (not -transp: black lines would vanish on the dark hover of a dark theme)
const cairoArgs = (pdf, prefix, dpi) => ['-png', '-r', String(dpi || DPI), pdf, prefix];

// a figure of the project: X/<sub>/name.tikz under the root -> { chapter: 'X', tikz: 'name', rel }, else null
function figureOf(root, file, sub) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const parts = rel.split('/');
  if (parts.length !== 3 || parts[1].toLowerCase() !== String(sub || 'tikz').toLowerCase() || !/\.tikz$/i.test(parts[2])) return null;
  return { chapter: parts[0], tikz: parts[2].replace(/\.tikz$/i, ''), rel };
}

// the folder of a figure in the cache (stable for the figure) and the key of its current picture: the figure, the driver and the
// classes / packages of the root, each by its path, time and size (a change of any of them makes the thumbnail stale)
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const folderOf = (rel) => hash(rel.toLowerCase());
const keyOf = (stamps) => hash(JSON.stringify(stamps.map((s) => [s.path, Math.round(s.mtimeMs || 0), s.size || 0])));

// the pictures pdftocairo wrote (prefix-1.png or prefix-01.png ...), in the order of the pages, at most MAX_PAGES
function pages(names, prefix) {
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '-(\\d+)\\.png$', 'i');
  return names.map((n) => { const m = re.exec(n); return m ? { n, k: Number(m[1]) } : null; })
    .filter(Boolean).sort((a, b) => a.k - b.k).slice(0, MAX_PAGES).map((x) => x.n);
}

// the reason of a failed build from the .log: the first "! ..." line (or file:line: error with -file-line-error) and the line after it
function logError(log) {
  const lines = String(log || '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^! /.test(l) || /^[^:\s][^:]*:\d+: /.test(l));
  if (i < 0) return '';
  return lines.slice(i, i + 2).map((l) => l.trim()).filter(Boolean).join(' ').slice(0, 300);
}

module.exports = { PREVIEW_ENVS, MAX_PAGES, DPI, pretex, latexArgs, cairoArgs, figureOf, folderOf, keyOf, pages, logError };
