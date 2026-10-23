'use strict';
/* projectIndex.js: what is computed from a file is computed once per change of that file, not once per request.
 *  - get(kind, abs, compute): data derived from the text of one file, kept while the file is unchanged. The stamp of an
 *    open document is its version (plus an id of the document object, so a closed and reopened file never matches an old
 *    stamp), of a closed file its mtime and size. Saving one chapter of a project of 80 files rescans that one chapter
 *    and stat()s the other 79 instead of reading and scanning all 80.
 *  - mapOver(kind, uris, compute): the same for a list of files, forgetting the files that are gone.
 *  - diagSetter(collection): writes diagnostics only for the files whose set of problems changed, so Problems does not
 *    redraw the whole project after every save.
 * The cache works only after util.initCaches() (the file watcher is alive); without it every call recomputes, which is
 * what the stub tests rely on. The returned data is shared: callers must not modify it. */
const fs = require('fs');
const vscode = require('vscode');
const U = require('./util');

const kinds = new Map(); // kind -> Map(fsPath -> { stamp, data })
const ids = new WeakMap();
let nextId = 1;

function stampOf(abs) {
  const d = U.openDocByPath(abs);
  if (d) {
    let id = ids.get(d);
    if (!id) { id = nextId++; ids.set(d, id); }
    return 'v' + id + '.' + d.version;
  }
  try { const st = fs.statSync(abs); return 'm' + st.mtimeMs + ':' + st.size; } catch (e) { return null; }
}

// compute(text, abs) -> data; a missing file is computed from '' (like util.textOf) and not cached
function get(kind, abs, compute) {
  if (!U.cachingOn()) return compute(U.textOf({ fsPath: abs }), abs);
  const stamp = stampOf(abs);
  let m = kinds.get(kind);
  if (!m) { m = new Map(); kinds.set(kind, m); }
  const c = m.get(abs);
  if (stamp !== null && c && c.stamp === stamp) return c.data;
  const data = compute(U.textOf({ fsPath: abs }), abs);
  if (stamp !== null) m.set(abs, { stamp, data }); else m.delete(abs);
  return data;
}

function prune(kind, live) {
  const m = kinds.get(kind);
  if (!m || m.size <= live.size) return;
  for (const k of [...m.keys()]) if (!live.has(k)) m.delete(k);
}

// Map fsPath -> data for the given uris (or objects with fsPath)
function mapOver(kind, uris, compute) {
  const out = new Map();
  for (const u of uris) out.set(u.fsPath, get(kind, u.fsPath, compute));
  prune(kind, out);
  return out;
}

function drop(kind) { if (kind) kinds.delete(kind); else kinds.clear(); }
// every kind with the number of files kept (for the state report)
function stats() { const o = {}; for (const [k, m] of kinds) o[k] = m.size; return o; }
function size(kind) { const m = kinds.get(kind); return m ? m.size : 0; }

/* -------------------------- diagnostics by diff -------------------------- */
// entries of one file are equal when they have the same fields in the same order (no string building: 12000 entries take a few ms)
function sameEntries(a, b) {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x.line !== y.line || x.col !== y.col || x.len !== y.len || x.severity !== y.severity || x.code !== y.code || x.message !== y.message || x.relKey !== y.relKey) return false;
  }
  return true;
}

function toDiagnostic(e) {
  const d = new vscode.Diagnostic(new vscode.Range(e.line, e.col, e.line, e.col + e.len), e.message, e.severity);
  d.source = 'TSS Workflow';
  d.code = e.code;
  // other places of the same problem (a duplicate label: where the other definitions are); only when this VS Code has the classes
  if (e.related && e.related.length && vscode.Location && vscode.DiagnosticRelatedInformation) {
    d.relatedInformation = e.related.map((r) => new vscode.DiagnosticRelatedInformation(
      new vscode.Location(vscode.Uri.file(r.file), new vscode.Range(r.line, r.col, r.line, r.col + r.len)), r.message));
  }
  return d;
}

// entries: { line, col, len, message, severity (vscode.DiagnosticSeverity), code, related?: [{ file, line, col, len, message }], relKey? (the string that tells whether related changed) }
function diagSetter(collection) {
  const last = new Map(); // fsPath -> the entries that are shown now
  return {
    // byFile: Map fsPath -> entries[]. Returns the number of files rewritten.
    set(byFile) {
      let changed = 0;
      for (const [file, entries] of byFile) {
        if (sameEntries(entries, last.get(file))) continue;
        collection.set(vscode.Uri.file(file), entries.map(toDiagnostic));
        last.set(file, entries);
        changed++;
      }
      for (const file of [...last.keys()]) {
        if (byFile.has(file)) continue;
        collection.delete(vscode.Uri.file(file));
        last.delete(file);
        changed++;
      }
      return changed;
    },
    clear() { collection.clear(); last.clear(); }
  };
}

module.exports = { get, mapOver, prune, drop, size, stats, stampOf, diagSetter };
