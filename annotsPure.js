'use strict';
/* annotsPure.js: the notes a reviewer left in a PDF (sticky notes, highlights, underlines, text boxes ...). No VS Code API.
 * A small reader of the PDF structure, enough for annotations: the objects of the file (also those in compressed object
 * streams and in the incremental updates a viewer appends when it saves the notes; a later object replaces an earlier one with
 * the same number), the tree of pages, the /Annots of each page, the text strings (PDFDocEncoding, UTF-16 with BOM, UTF-8).
 * Encrypted PDFs are not read. Where a note points in the source is found by synctex.js-free means in annots.js (synctex edit). */
const zlib = require('zlib');
const { tr } = require('./i18n');

const WS = /[\0\t\n\f\r ]/;
const DELIM = /[()<>[\]{}/%]/;

// one PDF value at s[i]: numbers, refs { r }, names { n }, strings { s } (bytes as latin1), arrays, dictionaries (objects)
function parseValue(s, i0) {
  let i = i0;
  const skip = () => {
    for (;;) {
      while (i < s.length && WS.test(s[i])) i++;
      if (s[i] === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      return;
    }
  };
  const value = (depth) => {
    if (depth > 60) throw new Error('too deep');
    skip();
    const c = s[i];
    if (c === '<' && s[i + 1] === '<') {
      i += 2;
      const d = {};
      for (;;) {
        skip();
        if (s[i] === '>' && s[i + 1] === '>') { i += 2; return d; }
        if (s[i] !== '/') throw new Error('dict key at ' + i);
        const k = value(depth + 1).n;
        d[k] = value(depth + 1);
      }
    }
    if (c === '[') {
      i++;
      const a = [];
      for (;;) {
        skip();
        if (s[i] === ']') { i++; return a; }
        if (i >= s.length) throw new Error('array');
        a.push(value(depth + 1));
      }
    }
    if (c === '(') {
      i++;
      let out = '';
      let nest = 0;
      while (i < s.length) {
        const ch = s[i++];
        if (ch === '\\') {
          const e = s[i++];
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (map[e] !== undefined) out += map[e];
          else if (/[0-7]/.test(e)) { let o = e; while (o.length < 3 && /[0-7]/.test(s[i])) o += s[i++]; out += String.fromCharCode(parseInt(o, 8) & 255); }
          else if (e === '\r') { if (s[i] === '\n') i++; } else if (e === '\n') { /* a line continuation */ } else out += e;
          continue;
        }
        if (ch === '(') nest++;
        else if (ch === ')') { if (nest === 0) break; nest--; }
        out += ch;
      }
      return { s: out };
    }
    if (c === '<') {
      const end = s.indexOf('>', i);
      let hex = s.slice(i + 1, end).replace(/[^0-9A-Fa-f]/g, '');
      if (hex.length % 2) hex += '0';
      i = end + 1;
      return { s: Buffer.from(hex, 'hex').toString('latin1') };
    }
    if (c === '/') {
      i++;
      let n = '';
      while (i < s.length && !WS.test(s[i]) && !DELIM.test(s[i])) n += s[i++];
      return { n: n.replace(/#([0-9A-Fa-f]{2})/g, (a, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    const num = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 32));
    if (num) {
      i += num[0].length;
      const ref = /^\s+(\d+)\s+R(?![A-Za-z])/.exec(s.slice(i, i + 24));
      if (ref && /^\d+$/.test(num[0])) { i += ref[0].length; return { r: +num[0] }; }
      return parseFloat(num[0]);
    }
    const kw = /^(true|false|null)/.exec(s.slice(i, i + 5));
    if (kw) { i += kw[0].length; return kw[0] === 'null' ? null : kw[0] === 'true'; }
    throw new Error('value at ' + i);
  };
  const v = value(0);
  return { v, i };
}

const isDict = (v) => v && typeof v === 'object' && !Array.isArray(v) && v.n === undefined && v.s === undefined && v.r === undefined;
const nameOf = (v) => (v && v.n !== undefined ? v.n : null);

function inflate(buf) {
  try { return zlib.inflateSync(buf); } catch (e) { return zlib.inflateSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); }
}

// the decoded bytes of a stream (FlateDecode only; anything else is returned as it is when it has no filter)
function decodeStream(dict, raw) {
  const f = dict.Filter;
  const filters = (Array.isArray(f) ? f : f ? [f] : []).map(nameOf);
  if (!filters.length) return raw;
  if (filters.length === 1 && filters[0] === 'FlateDecode') return inflate(raw);
  return null;
}

/* every object of the file: Map number -> value; objects of later updates replace earlier ones; null for an encrypted PDF */
function readObjects(buf) {
  const s = buf.toString('latin1');
  // an encrypted file: the trailer (or the cross-reference stream that replaces it) names /Encrypt
  if (/trailer\s*<<[\s\S]{0,4000}?\/Encrypt[\s/<\d]/.test(s) || /\/Type\s*\/XRef[^>]{0,2000}\/Encrypt[\s/<\d]/.test(s)) return null;
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const num = +m[1];
    let parsed;
    try { parsed = parseValue(s, m.index + m[0].length); } catch (e) { continue; }
    let p = parsed.i;
    const v = parsed.v;
    const st = /^[\0\t\f\r\n ]*stream\r?\n/.exec(s.slice(p, p + 40));
    if (st && isDict(v)) {
      const start = p + st[0].length;
      const len = typeof v.Length === 'number' ? v.Length : -1;
      const end = len >= 0 && /^\s*endstream/.test(s.slice(start + len, start + len + 32)) ? start + len : s.indexOf('endstream', start);
      if (end < 0) break;
      const raw = Buffer.from(s.slice(start, end), 'latin1');
      p = end + 9;
      re.lastIndex = p;
      if (nameOf(v.Type) === 'ObjStm') {
        let data = null;
        try { data = decodeStream(v, raw); } catch (e) { data = null; }
        if (data) {
          const t = data.toString('latin1');
          const first = v.First | 0;
          const head = t.slice(0, first).trim().split(/\s+/).map(Number);
          for (let k = 0; k + 1 < head.length; k += 2) {
            try { objs.set(head[k], parseValue(t, first + head[k + 1]).v); } catch (e) { /* a broken object is skipped */ }
          }
        }
        continue;
      }
      objs.set(num, v);
      continue;
    }
    objs.set(num, v);
    re.lastIndex = p;
  }
  return objs;
}

// a PDF text string: UTF-16 BE / LE with BOM, UTF-8 with BOM (PDF 2.0) or valid UTF-8, else PDFDocEncoding (taken as Latin-1)
function pdfText(v) {
  if (!v || v.s === undefined) return '';
  const b = Buffer.from(v.s, 'latin1');
  let t;
  if (b[0] === 0xfe && b[1] === 0xff) {
    const be = Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1))); // a copy of even length: swap16 turns it into UTF-16 LE
    t = be.swap16().toString('utf16le');
  }
  else if (b[0] === 0xff && b[1] === 0xfe) t = b.subarray(2).toString('utf16le');
  else if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) t = b.subarray(3).toString('utf8');
  else {
    const u = b.toString('utf8');
    t = /[\x80-\xff]/.test(v.s) && !u.includes('�') ? u : v.s;
  }
  return t.replace(/\r\n?/g, '\n').replace(/\0/g, '');
}

const SKIP = new Set(['Link', 'Popup', 'Widget', 'PrinterMark', 'TrapNet', 'Watermark', '3D', 'Sound', 'Movie', 'Screen', 'RichMedia']);

/* the notes of a PDF: [{ page (1-based), type, author, text, rect: [x1,y1,x2,y2], quads: [[x1,y1,...,x4,y4]], box: [mediabox],
 * reply (true for an answer to another note) }], pages: the number of pages; or { error } */
function readAnnotations(buf) {
  const objs = readObjects(buf);
  if (!objs) return { error: 'encrypted' };
  const get = (v, d) => { let x = v; for (let k = 0; x && x.r !== undefined && k < 8; k++) x = objs.get(x.r); return x === undefined ? (d === undefined ? null : d) : x; };
  let catalog = null;
  for (const v of objs.values()) if (isDict(v) && nameOf(v.Type) === 'Catalog') catalog = v;
  if (!catalog) return { error: 'no catalog' };
  const pages = [];
  const seen = new Set();
  const walk = (ref, box, depth) => {
    const key = ref && ref.r;
    if (depth > 40 || (key !== undefined && seen.has(key))) return;
    if (key !== undefined) seen.add(key);
    const node = get(ref);
    if (!isDict(node)) return;
    const mb = get(node.MediaBox) || box;
    const kids = get(node.Kids);
    if (Array.isArray(kids) && nameOf(node.Type) !== 'Page') { for (const k of kids) walk(k, mb, depth + 1); return; }
    pages.push({ node, box: Array.isArray(mb) ? mb.map((x) => get(x)) : [0, 0, 595, 842] });
  };
  walk(catalog.Pages, null, 0);
  const out = [];
  pages.forEach((pg, idx) => {
    const annots = get(pg.node.Annots, []);
    if (!Array.isArray(annots)) return;
    for (const a of annots) {
      const d = get(a);
      if (!isDict(d)) continue;
      const type = nameOf(d.Subtype) || '';
      if (SKIP.has(type)) continue;
      const nums = (v) => (Array.isArray(get(v)) ? get(v).map((x) => Number(get(x))) : null);
      const q = nums(d.QuadPoints);
      const quads = [];
      if (q) for (let k = 0; k + 7 < q.length; k += 8) quads.push(q.slice(k, k + 8));
      out.push({
        page: idx + 1, type, author: pdfText(get(d.T)), text: pdfText(get(d.Contents)).trim(), rect: nums(d.Rect) || [0, 0, 0, 0],
        quads, box: pg.box, reply: !!d.IRT
      });
    }
  });
  return { annotations: out, pages: pages.length };
}

// the rectangle of the marked text (all quads) in the coordinates of pdftotext -x -y -W -H: from the top left corner, 72 dpi
function cropOf(a) {
  const pts = a.quads.length ? a.quads.flat() : a.rect.length === 4 ? [a.rect[0], a.rect[1], a.rect[2], a.rect[3]] : [];
  if (!pts.length) return null;
  const xs = pts.filter((v, k) => k % 2 === 0), ys = pts.filter((v, k) => k % 2 === 1);
  const [x0, , , y1] = a.box;
  const left = Math.min(...xs) - x0, right = Math.max(...xs) - x0, top = y1 - Math.max(...ys), bottom = y1 - Math.min(...ys);
  return { x: Math.max(0, Math.floor(left)), y: Math.max(0, Math.floor(top)), w: Math.ceil(right - left) + 1, h: Math.ceil(bottom - top) + 1 };
}

// the point for synctex edit (page:x:y, from the top left corner): the start of the marked text, or the middle of the note
function pointOf(a) {
  const [x0, , , y1] = a.box;
  if (a.quads.length) { const q = a.quads[0]; return { x: Math.min(q[0], q[4]) - x0 + 2, y: y1 - (Math.max(q[1], q[3]) + Math.min(q[5], q[7])) / 2 }; }
  const r = a.rect;
  return { x: (Math.min(r[0], r[2]) + Math.max(r[0], r[2])) / 2 - x0, y: y1 - (Math.min(r[1], r[3]) + Math.max(r[1], r[3])) / 2 };
}

// `synctex edit` output -> { input, line } of the first answer, or null
function parseSynctexEdit(text) {
  const inp = /^Input:(.*)$/m.exec(String(text || ''));
  const ln = /^Line:(-?\d+)$/m.exec(String(text || ''));
  if (!inp || !ln || +ln[1] < 1) return null;
  return { input: inp[1].replace(/\r$/, '').trim(), line: +ln[1] };
}

// the name of a kind of note for the report, in the language of the moment (the keys are literals for tests/i18n.test.js)
const TYPES = {
  Text: () => tr('примітка'), FreeText: () => tr('напис'), Highlight: () => tr('виділення'), Underline: () => tr('підкреслення'),
  StrikeOut: () => tr('закреслення'), Squiggly: () => tr('хвиляста лінія'), Caret: () => tr('вставка'), Square: () => tr('рамка'),
  Circle: () => tr('овал'), Ink: () => tr('від руки'), Line: () => tr('лінія'), Polygon: () => tr('многокутник'), Stamp: () => tr('штамп')
};
const typeName = (t) => (TYPES[t] ? TYPES[t]() : t);

// one line of a TeX comment: `% TODO: [author, p. 5] the note «the marked text»`
function todoComment(a, o) {
  const opt = o || {};
  const one = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const text = one(a.text), quote = one(a.quote);
  const who = [one(a.author), opt.pageWord ? opt.pageWord + ' ' + a.page : ''].filter(Boolean).join(', ');
  const kind = a.type === 'StrikeOut' && !text ? opt.strike || '' : '';
  let body = [who ? '[' + who + ']' : '', kind, text, quote ? '«' + quote + '»' : ''].filter(Boolean).join(' ');
  if (body.length > 400) body = body.slice(0, 397) + '…';
  return '% ' + (opt.keyword || 'TODO') + ': ' + body.trim();
}

module.exports = { parseValue, readObjects, pdfText, readAnnotations, cropOf, pointOf, parseSynctexEdit, todoComment, typeName };
