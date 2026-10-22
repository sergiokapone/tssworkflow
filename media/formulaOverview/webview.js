const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let macros = {};
let files = [];
let entries = [];
const kit = window.tssKit(vscode, () => macros);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let io = null;

// a formula is drawn when it comes into view (a book has thousands of them)
function lazy(el) {
  if (!io) {
    io = new IntersectionObserver((list) => {
      for (const x of list) {
        if (!x.isIntersecting) continue;
        const box = x.target;
        io.unobserve(box);
        box.querySelectorAll('span.m').forEach((m) => kit.draw(m));
        box.querySelectorAll('div.dm').forEach(kit.addCopy);
        box.style.minHeight = '';
      }
    }, { rootMargin: '600px 0px' });
  }
  io.observe(el);
}

function itemHtml(e, i) {
  const search = (e.labels.join(' ') + ' ' + e.num + ' ' + e.snippet + ' ' + files[e.f] + ' ' + e.env).toLowerCase();
  const badges = (e.unused ? '<span class="badge bad" title="' + esc(T('Жодна з міток не згадана в \\ref, \\eqref, \\cref…')) + '">' + T('не використовується') + '</span>' : '') +
    (e.numbered && e.noLabel ? '<span class="badge muted">' + T('без мітки') + '</span>' : '') + (!e.numbered ? '<span class="badge muted">' + T('без номера') + '</span>' : '');
  const labs = e.labels.map((l) => '<code class="lab" title="' + esc(T('Копіювати \\eqref{{0}}', l)) + '" data-eqref="' + esc(l) + '">' + esc(l) + '</code>').join(' ');
  return '<div class="it" data-i="' + i + '" data-s="' + esc(search) + '" data-u="' + (e.unused ? 1 : 0) + '" data-nl="' + (e.noLabel ? 1 : 0) + '" data-n="' + (e.numbered ? 1 : 0) + '">' +
    '<div class="ih"><span class="num">' + (e.num ? '(' + esc(e.num) + ')' : '—') + '</span>' + labs + badges + '<span class="env">' + esc(e.env) + '</span><a class="go" href="#" data-go="' + i + '">' + esc(files[e.f]) + ':' + e.line + '</a></div>' +
    '<div class="fx" style="min-height:2.6em">' + e.html + '</div></div>';
}

function build() {
  let html = '';
  let cur = -1;
  entries.forEach((e, i) => {
    if (e.f !== cur) { if (cur >= 0) html += '</section>'; html += '<section data-f="' + e.f + '"><h2>' + esc(files[e.f]) + '</h2>'; cur = e.f; }
    html += itemHtml(e, i);
  });
  if (cur >= 0) html += '</section>';
  $('list').innerHTML = html || '<p class="empty">' + T('У проєкті немає формул (відкрий папку проєкту).') + '</p>';
  if (io) { io.disconnect(); io = null; }
  document.querySelectorAll('#list .fx').forEach(lazy);
  filter();
}

function filter() {
  const words = $('q').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const fU = $('fU').checked;
  const fL = $('fL').checked;
  const fN = $('fN').checked;
  let shown = 0;
  document.querySelectorAll('#list .it').forEach((it) => {
    let ok = true;
    if (!fN && it.getAttribute('data-n') !== '1') ok = false;
    if (ok && fU && it.getAttribute('data-u') !== '1') ok = false;
    if (ok && fL && it.getAttribute('data-nl') !== '1') ok = false;
    if (ok && words.length) { const s = it.getAttribute('data-s'); ok = words.every((w) => s.includes(w)); }
    it.hidden = !ok;
    if (ok) shown++;
  });
  document.querySelectorAll('#list section').forEach((s) => { s.hidden = !s.querySelector('.it:not([hidden])'); });
  const numbered = entries.filter((e) => e.numbered).length;
  const unused = entries.filter((e) => e.unused).length;
  const noLabel = entries.filter((e) => e.numbered && e.noLabel).length;
  $('stat').textContent = T('Нумерованих: {0}, не використовуються: {1}, без мітки: {2}. Показано: {3} з {4}.', numbered, unused, noLabel, shown, entries.length);
}

window.addEventListener('message', function (e) {
  const m = e.data;
  if (!m) return;
  if (m.type === 'copied') { kit.toast(T('Скопійовано: {0}', m.what || '')); return; }
  if (m.type !== 'data') return;
  macros = m.macros || {};
  files = m.files || [];
  entries = m.entries || [];
  const y = window.scrollY;
  build();
  window.scrollTo(0, y);
});

document.addEventListener('click', function (e) {
  if (kit.click(e)) return;
  const t = e.target && e.target.closest ? e.target : null;
  if (!t) return;
  const l = t.closest('code[data-eqref]');
  if (l) { vscode.postMessage({ type: 'copy', text: '\\eqref{' + l.getAttribute('data-eqref') + '}', what: '\\eqref' }); return; }
  const g = t.closest('a[data-go]');
  if (g) { e.preventDefault(); const en = entries[Number(g.getAttribute('data-go'))]; if (en) vscode.postMessage({ type: 'goto', f: en.f, line: en.line, endLine: en.endLine }); }
});
document.addEventListener('dblclick', kit.dblclick);
['q', 'fU', 'fL', 'fN'].forEach((id) => $(id).addEventListener(id === 'q' ? 'input' : 'change', filter));
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
vscode.postMessage({ type: 'ready' });
