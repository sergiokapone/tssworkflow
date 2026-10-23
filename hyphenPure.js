'use strict';
/* hyphenPure.js: words that stick into the margin (Overfull \hbox) and how to let TeX break them. No VS Code API.
 * The log shows an overfull line with the points where TeX may break each word (`Ана-лі-ти-чно`); a word without such
 * points, or a compound word with an explicit hyphen (TeX never breaks its parts), is what the line could not get rid of.
 * The source tells an explicit hyphen from a hyphenation point. The suggested points follow the syllables (Ukrainian rules,
 * also used for Latin words as a first guess); the user edits them before anything is written. */

const VOWELS = /[аеєиіїоуюяыэёaeiouyAEIOUYАЕЄИІЇОУЮЯЫЭЁ]/;
const STICKY = /[йьъЙЬЪ'’ʼ]/; // stays with the letter before it
const LETTER = /[\p{L}'’ʼ]/u;

// the text of the box without font switches (`\TU/Name(0)/m/n/14 `), math, `[]` and other commands
function plainBox(box) {
  return String(box || '')
    .replace(/\\[A-Z0-9]+\/[^/]+\/[^/\s]+\/[^/\s]+\/[\d.]+ ?/g, '')
    .replace(/\$[^$]*\$/g, ' ')
    .replace(/\[\]/g, ' ')
    .replace(/\\[A-Za-z@]+/g, ' ');
}

// the words of the box in order, as TeX shows them (with its hyphenation points); punctuation around a word is dropped
function boxWords(box) {
  return plainBox(box).split(/\s+/).map((w) => w.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}-]+$/u, '')).filter((w) => /\p{L}/u.test(w));
}

const lettersOf = (w) => String(w).replace(/\\-|"=|"-|\\hyp\{\}|-/g, '');

// how the word is written in the source: the token whose letters are the same (case-insensitive), with its explicit hyphens
function sourceSpelling(letters, source) {
  const want = letters.toLowerCase();
  const re = /[\p{L}'’ʼ](?:[\p{L}'’ʼ-]|\\-|"=)*/gu;
  let m;
  while ((m = re.exec(String(source || ''))) !== null) {
    if (lettersOf(m[0]).toLowerCase() === want) return m[0];
  }
  return null;
}

/* The words of an overfull line worth a look: the last word that TeX did not break (the line ends with it), and any long word
 * without a single hyphenation point. -> [{ shown, letters, source, compound }] (source: the spelling in the source or null) */
function candidates(box, source, o) {
  const minLen = (o && o.minLen) || 6;
  const words = boxWords(box);
  const out = [];
  const seen = new Set();
  words.forEach((w, i) => {
    if (w.endsWith('-')) return; // TeX broke the line in this word: it can be hyphenated
    const letters = lettersOf(w);
    if (letters.length < minLen || seen.has(letters.toLowerCase())) return;
    const src = sourceSpelling(letters, source);
    const explicit = src ? (src.replace(/\\-|"=/g, '').match(/-/g) || []).length : 0;
    const texPoints = (w.match(/-/g) || []).length - explicit;
    const compound = explicit > 0;
    const last = i === words.length - 1;
    // a compound word: TeX breaks it only at the explicit hyphen, never inside its parts
    const longPart = compound && src.split('-').some((p) => lettersOf(p).length >= 5);
    if (texPoints > 0 && !longPart) return;
    if (!last && letters.length < 10 && !longPart) return;
    seen.add(letters.toLowerCase());
    out.push({ shown: w, letters, source: src, compound });
  });
  return out;
}

// hyphenation points of one word after the syllables: V-CV, VC-CV, VC-CCV; й, ь, ' stay with the letter before;
// at least two letters on each side (lefthyphenmin / righthyphenmin of Ukrainian babel)
const D_PREFIX = ['від', 'під', 'над', 'од', 'пред', 'перед', 'серед', 'понад', 'попід'];
function syllablePoints(word) {
  const ch = [...String(word)];
  const lower = String(word).toLowerCase();
  const v = [];
  ch.forEach((c, i) => { if (VOWELS.test(c)) v.push(i); });
  const pts = [];
  for (let k = 0; k + 1 < v.length; k++) {
    const a = v[k], b = v[k + 1];
    const c = b - a - 1;
    let p = c <= 1 ? a + 1 : a + 2;
    // дж, дз are one sound: not split (до-слі-джен-ня, ку-ку-ру-дза), except where a prefix ends in д (від-зна-чи-ти, під-жи-ви-ти)
    if (p - 1 > a && /[дД]/.test(ch[p - 1]) && /[жзЖЗ]/.test(ch[p] || '') && !D_PREFIX.some((x) => x.length === p && lower.startsWith(x))) p--;
    while (p < b && STICKY.test(ch[p])) p++;
    if (p >= 2 && ch.length - p >= 2 && !pts.includes(p)) pts.push(p);
  }
  return pts;
}

const withPoints = (word, pts, mark) => { const ch = [...word]; return ch.map((c, i) => (pts.includes(i) ? mark : '') + c).join(''); };

// the suggestion for \hyphenation: `фі-зи-ка`; a compound word keeps its explicit hyphen and gets points inside its parts
function suggest(word) {
  return String(word).split('-').map((part) => withPoints(part, syllablePoints(part), '-')).join('-');
}

// the form for the source: the points of `edited` (letters with - between them) written as \- into the source spelling
// (an explicit hyphen stays a hyphen); null when the letters do not match
function softHyphens(sourceWord, edited) {
  const src = String(sourceWord);
  const want = [...lettersOf(src)];
  const ed = [...String(edited).replace(/\s+/g, '')];
  const pts = new Set();
  let n = 0;
  for (const c of ed) { if (c === '-') pts.add(n); else n++; }
  if (lettersOf(ed.join('')).toLowerCase() !== want.join('').toLowerCase()) return null;
  // the explicit hyphens of the source are also "-" in the edited form: they stay as they are
  const explicitAt = new Set();
  let k = 0;
  for (const c of src.replace(/\\-|"=/g, '')) { if (c === '-') explicitAt.add(k); else k++; }
  let out = '';
  let i = 0;
  for (const c of src.replace(/\\-|"=/g, '')) {
    if (c === '-') { out += '-'; continue; }
    if (i > 0 && pts.has(i) && !explicitAt.has(i)) out += '\\-';
    out += c;
    i++;
  }
  return out;
}

// the edited form for \hyphenation: letters and hyphens only, the same letters as the word
function hyphenationEntry(word, edited) {
  const e = String(edited).trim().toLowerCase();
  if (!/^[\p{L}'’ʼ-]+$/u.test(e) || /^-|-$|--/.test(e)) return null;
  return e.replace(/-/g, '') === lettersOf(word).toLowerCase() ? e : null;
}

/* adds entries to \hyphenation{...} of the preamble (the first one before \begin{document}), or writes a new line
 * `\hyphenation{...}` just before \begin{document}. -> { text, added: [entries], line } or null without \begin{document} */
function addHyphenation(text, entries) {
  const s = String(text);
  const begin = /^[ \t]*\\begin\{document\}/m.exec(s);
  if (!begin) return null;
  const pre = s.slice(0, begin.index);
  // comments become spaces of the same length, so that an offset in `code` is the same offset in `s`
  const code = pre.split('\n').map((l) => l.replace(/(^|[^\\])(%.*)$/, (a, p, c) => p + ' '.repeat(c.length))).join('\n');
  const m = /\\hyphenation\s*\{/.exec(code);
  if (m) {
    const open = m.index + m[0].length;
    const close = s.indexOf('}', open);
    if (close < 0 || close > begin.index) return null;
    const have = new Set(s.slice(open, close).split(/\s+/).filter(Boolean).map((x) => x.toLowerCase()));
    const add = entries.filter((e) => !have.has(e.toLowerCase()));
    const line = s.slice(0, open).split('\n').length - 1;
    if (!add.length) return { text: s, added: [], line };
    // after the last entry, before the spaces / line break that precede the closing brace
    const body = s.slice(open, close);
    const at = open + body.replace(/\s+$/, '').length;
    return { text: s.slice(0, at) + (body.trim() ? ' ' : '') + add.join(' ') + s.slice(at), added: add, line };
  }
  const line = '\\hyphenation{' + entries.join(' ') + '}\n';
  return { text: s.slice(0, begin.index) + line + s.slice(begin.index), added: entries.slice(), line: pre.split('\n').length - 1 };
}

// the place of the word in the lines of the paragraph (the last occurrence: the overfull line is usually the end of a long one)
function findInLines(lines, from, to, sourceWord) {
  for (let i = Math.min(to, lines.length - 1); i >= Math.max(0, from); i--) {
    const code = String(lines[i]).replace(/(^|[^\\])%.*$/, '$1');
    let at = -1, j = -1;
    while ((j = code.indexOf(sourceWord, j + 1)) >= 0) {
      const before = code[j - 1], after = code[j + sourceWord.length];
      if ((before === undefined || !LETTER.test(before)) && (after === undefined || !LETTER.test(after))) at = j;
    }
    if (at >= 0) return { line: i, col: at };
  }
  return null;
}

module.exports = { plainBox, boxWords, lettersOf, sourceSpelling, candidates, syllablePoints, suggest, softHyphens, hyphenationEntry, addHyphenation, findInLines };
