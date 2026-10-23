'use strict';
/* dstuPure.js: a .bib against ДСТУ 8302:2015 (the bibliographic reference). No VS Code API.
 * What a reference of each type must name (the author, the title, the place and the publisher of a book; the journal, the
 * volume or the issue and the pages of an article; the date of access of an online source ...), checked on the fields of
 * biblatex with their BibTeX names as aliases (journaltitle / journal, location / address, institution / school, date / year).
 * Also what breaks the printed reference: authors joined by commas instead of `and`, a page range with one hyphen,
 * a Cyrillic title without `langid` (biblatex-gost then prints "p." and sorts it as English), letters of two alphabets in a word. */
const { tr } = require('./i18n');
const FL = require('./filesAndLabelsPure');

const ALIASES = {
  author: ['author'], editor: ['editor'], title: ['title'], date: ['date', 'year'], journal: ['journaltitle', 'journal'],
  location: ['location', 'address'], publisher: ['publisher'], pages: ['pages'], volume: ['volume'], number: ['number', 'issue'],
  booktitle: ['booktitle'], institution: ['institution', 'school'], url: ['url'], urldate: ['urldate'], pagetotal: ['pagetotal'],
  type: ['type'], holder: ['holder']
};
// the field and how it is named in the report (the BibTeX name in brackets when it differs)
const shown = (k) => ALIASES[k].length > 1 && ALIASES[k][0] !== k ? ALIASES[k][0] + ' (' + ALIASES[k].slice(1).join(', ') + ')' : ALIASES[k].length > 1 ? k + ' (' + ALIASES[k].slice(1).join(', ') + ')' : k;

// [required, recommended]; an entry of a group (`author|editor`) is satisfied by either field
const RULES = {
  article: [['author', 'title', 'journal', 'date', 'volume|number', 'pages'], []],
  book: [['author|editor', 'title', 'location', 'publisher', 'date'], ['pagetotal']],
  mvbook: [['author|editor', 'title', 'location', 'publisher', 'date'], []],
  inbook: [['author', 'title', 'booktitle', 'location', 'publisher', 'date', 'pages'], []],
  incollection: [['author', 'title', 'booktitle', 'location', 'publisher', 'date', 'pages'], ['editor']],
  bookinbook: [['author', 'title', 'booktitle', 'location', 'publisher', 'date', 'pages'], []],
  inproceedings: [['author', 'title', 'booktitle', 'date', 'pages'], ['location', 'publisher']],
  conference: [['author', 'title', 'booktitle', 'date', 'pages'], ['location', 'publisher']],
  proceedings: [['title', 'location', 'publisher', 'date'], ['editor', 'pagetotal']],
  collection: [['title', 'location', 'publisher', 'date'], ['editor', 'pagetotal']],
  thesis: [['author', 'title', 'institution', 'date'], ['type', 'location', 'pagetotal']],
  phdthesis: [['author', 'title', 'institution', 'date'], ['location', 'pagetotal']],
  mastersthesis: [['author', 'title', 'institution', 'date'], ['location', 'pagetotal']],
  report: [['author|institution', 'title', 'institution', 'location', 'date'], ['number']],
  techreport: [['author|institution', 'title', 'institution', 'location', 'date'], ['number']],
  online: [['title', 'url', 'urldate'], ['author', 'date']],
  electronic: [['title', 'url', 'urldate'], ['author', 'date']],
  www: [['title', 'url', 'urldate'], ['author', 'date']],
  patent: [['author|holder', 'title', 'number', 'date'], []],
  unpublished: [['author', 'title', 'date'], []],
  misc: [['title', 'date'], []],
  manual: [['title', 'date'], ['location', 'publisher']]
};

const CYR = /[а-яіїєґё]/i;
const LAT = /[a-z]/i;
const CYR_LANGS = /^(ukrainian|russian|ukrainian_new|uk|ru|belarusian|bulgarian|serbian)$/i;

const value = (e, k) => { for (const n of ALIASES[k] || [k]) { const v = FL.fieldValue(e, n); if (v) return v; } return ''; };
const has = (e, k) => !!value(e, k);
const hasGroup = (e, g) => g.split('|').some((k) => has(e, k));
const groupName = (g) => g.split('|').map(shown).join(tr(' або '));

// the text of a field without the TeX markup that is not a letter (braces, commands, math)
const plain = (s) => String(s || '').replace(/\$[^$]*\$/g, ' ').replace(/\\[A-Za-z@]+/g, ' ').replace(/[{}]/g, '');

/* e: an entry of filesAndLabelsPure.parseBib -> { errors: [text], warnings: [text] } */
function checkEntry(e) {
  const errors = [], warnings = [];
  const type = e.type.toLowerCase();
  const rule = RULES[type];
  if (rule) {
    const miss = rule[0].filter((g) => !hasGroup(e, g));
    if (miss.length) errors.push(tr('немає {0}', miss.map(groupName).join(', ')));
    const rec = rule[1].filter((g) => !hasGroup(e, g));
    if (rec.length) warnings.push(tr('бажано {0}', rec.map(groupName).join(', ')));
  } else warnings.push(tr('тип @{0} не має правил ДСТУ в цій перевірці', type));
  // an online source anywhere: the date of access is required
  if (has(e, 'url') && !has(e, 'urldate') && !(rule && rule[0].includes('urldate'))) errors.push(tr('є url, але немає urldate (дата звернення)'));
  // authors: "Іваненко І. І., Петренко П. П." is read by BibTeX as one strange name
  for (const k of ['author', 'editor']) {
    const v = value(e, k);
    if (v && !/\sand\s/.test(v) && (v.match(/,/g) || []).length >= 2) errors.push(tr('{0}: імена через кому; розділяй їх словом and', k));
  }
  const pages = value(e, 'pages');
  if (pages && /\d\s*(?:-|–|—)\s*\d/.test(pages) && !/\d\s*--\s*\d/.test(pages)) warnings.push(tr('pages: діапазон пиши через -- ({0})', pages));
  const date = value(e, 'date');
  if (date && !/^\d{4}/.test(date.trim())) warnings.push(tr('рік «{0}» не починається з чотирьох цифр', date));
  // language: biblatex-gost prints "с." / "p." and sorts by it
  const title = plain(value(e, 'title'));
  const lang = FL.fieldValue(e, 'langid') || FL.fieldValue(e, 'language') || FL.fieldValue(e, 'hyphenation');
  if (title && CYR.test(title) && !lang) warnings.push(tr('назва кирилицею, а langid немає'));
  else if (title && lang && CYR.test(title) && !LAT.test(title) && !CYR_LANGS.test(lang.trim())) warnings.push(tr('назва кирилицею, а langid = {0}', lang));
  else if (title && lang && !CYR.test(title) && CYR_LANGS.test(lang.trim())) warnings.push(tr('назва латиницею, а langid = {0}', lang));
  // a word with letters of both alphabets (a Latin "i" or "o" in a Ukrainian word): wrong sorting, search, hyphenation
  for (const k of ['author', 'title']) {
    const mixed = plain(value(e, k)).split(/[^\p{L}]+/u).filter((w) => CYR.test(w) && LAT.test(w));
    if (mixed.length) warnings.push(tr('{0}: кирилиця й латиниця в одному слові: {1}', k, mixed.slice(0, 3).join(', ')));
  }
  for (const f of e.fields) if (!FL.fieldValue(e, f.name.toLowerCase())) warnings.push(tr('порожнє поле {0}', f.name));
  return { errors, warnings };
}

// files: [{ rel, text }] -> { md, entries, withErrors, withWarnings }
function dstuReport(files, o) {
  const opt = o || {};
  const out = [];
  let entries = 0, withErrors = 0, withWarnings = 0;
  const parts = [];
  for (const f of files) {
    const lines = [];
    for (const e of FL.parseBib(f.text)) {
      if (e.special || (opt.only && !opt.only.has(e.key))) continue;
      entries++;
      const r = checkEntry(e);
      if (r.errors.length) withErrors++;
      else if (r.warnings.length) withWarnings++;
      else continue;
      if (opt.errorsOnly && !r.errors.length) continue;
      const line = f.text.slice(0, e.start).split('\n').length;
      lines.push('- ' + f.rel + ':' + line + ' `' + e.key + '` (@' + e.type.toLowerCase() + ')' +
        (r.errors.length ? ' — ✗ ' + r.errors.join('; ') : '') + (r.warnings.length ? (r.errors.length ? '; ' : ' — ') + '⚠ ' + r.warnings.join('; ') : ''));
    }
    if (lines.length) parts.push('## ' + f.rel, '', ...lines, '');
  }
  out.push(tr('# ДСТУ 8302:2015 — бібліографія'), '');
  if (opt.only) out.push(tr('Лише записи, цитовані в проєкті ({0} ключів).', opt.only.size), '');
  out.push(tr('Записів: {0} у {1} файлах .bib. З помилками (✗, у посиланні бракуватиме обов\'язкового елемента): {2}. Лише з попередженнями (⚠): {3}.', entries, files.length, withErrors, withWarnings), '');
  out.push(tr('Поля названо як у biblatex (у дужках назва BibTeX, що теж підходить). Правила — для стилю biblatex-gost / ДСТУ 8302:2015; інший стиль може вимагати іншого.'), '');
  if (!withErrors && !withWarnings) out.push(tr('Зауважень немає.'), '');
  return { md: out.concat(parts).join('\n'), entries, withErrors, withWarnings };
}

module.exports = { RULES, checkEntry, dstuReport };
