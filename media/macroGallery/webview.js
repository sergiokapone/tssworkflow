const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let macros = {};
let items = [];
let mjFile = false;
const kit = window.tssKit(vscode, () => macros);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MJ = {
  ok: ['MathJax: є у файлі', 'ok'], differs: ['MathJax: у файлі інше означення', 'warn'], missing: ['MathJax: немає у файлі', 'bad'],
  skip: ['MathJax цього не виразить', 'muted'], nofile: ['файла макросів MathJax немає', 'muted'], na: ['', '']
};

// the first call is drawn by KaTeX; when KaTeX does not know the command, a text command is drawn by the converter of the panel
// "Preview selection" (the HTML the extension made), else the card says that it is not drawn
function paint(card, it) {
  let katexOk = null;
  it.examples.forEach((ex, k) => {
    const row = card.querySelector('.res[data-k="' + k + '"]');
    row.innerHTML = '';
    let shown = false;
    if (ex.tex) {
      const span = document.createElement('span');
      span.className = 'm';
      span.setAttribute('data-d', '0');
      span.setAttribute('data-tex', ex.tex);
      row.appendChild(span);
      const ok = kit.draw(span, undefined, true);
      if (k === 0) katexOk = ok;
      if (ok) { shown = true; row.classList.add('k'); } else row.removeChild(span);
    }
    if (!shown && ex.html) {
      const d = document.createElement('div');
      d.className = 'txt';
      d.innerHTML = ex.html;
      d.querySelectorAll('span.m').forEach((el) => kit.draw(el));
      row.appendChild(d);
      shown = true;
    }
    if (!shown) { row.textContent = 'не відтворюється'; row.classList.add('nr'); }
  });
  const isEnv = it.kind === 'env';
  card.setAttribute('data-k', isEnv ? 'na' : katexOk ? '1' : '0');
  const kb = card.querySelector('.kb');
  if (isEnv) { kb.textContent = 'середовище'; kb.className = 'kb badge muted'; } else if (katexOk) { kb.textContent = 'KaTeX: відтворюється'; kb.className = 'kb badge ok'; } else { kb.textContent = 'не відтворюється в KaTeX'; kb.className = 'kb badge bad'; }
}

function cardHtml(it) {
  const mj = MJ[it.mj] || MJ.na;
  const ex = it.examples.map((e, k) => '<div class="exrow"><code class="call">' + esc(e.call) + '</code>' + (e.note ? '<span class="note">' + esc(e.note) + '</span>' : '') + '<div class="res" data-k="' + k + '"></div></div>').join('');
  return '<article class="mc" data-i="' + it.i + '" data-mj="' + it.mj + '" data-kind="' + it.kind + '">' +
    '<header><code class="nm">' + esc(it.kind === 'env' ? it.name : '\\' + it.name) + '</code><code class="sig">' + esc(it.sig) + '</code><span class="kb badge"></span>' + (mj[0] ? '<span class="badge ' + mj[1] + '" title="' + esc(it.mjNote) + '">' + esc(mj[0]) + '</span>' : '') + '</header>' +
    (it.doc ? '<div class="doc">' + esc(it.doc) + '</div>' : '') + (it.alias ? '<div class="doc">Те саме, що <code>\\' + esc(it.alias) + '</code></div>' : '') +
    '<div class="exs">' + ex + '</div>' +
    '<details><summary>означення</summary><pre>' + esc(it.src) + '</pre></details>' +
    '<a class="go" href="#" data-go="' + it.i + '" title="Відкрити означення">' + esc(it.fileName) + ':' + it.line + '</a></article>';
}

function build() {
  const list = $('list');
  let html = '';
  let cur = null;
  for (const it of items) {
    if (it.fileName !== cur) { if (cur !== null) html += '</section>'; html += '<section><h2>' + esc(it.fileName) + '</h2>'; cur = it.fileName; }
    html += cardHtml(it);
  }
  if (cur !== null) html += '</section>';
  list.innerHTML = html || '<p class="empty">Макросів не знайдено: .cls/.sty беруться з \\documentclass і \\usepackage преамбули main.tex (або з налаштування macroFiles).</p>';
  const cards = Array.from(list.querySelectorAll('.mc'));
  cards.forEach((c) => paint(c, items[Number(c.getAttribute('data-i'))]));
  list.querySelectorAll('div.dm').forEach(kit.addCopy);
  filter();
}

function stat() {
  const cmds = items.filter((x) => x.kind === 'cmd');
  const cards = Array.from(document.querySelectorAll('.mc'));
  const notK = cards.filter((c) => c.getAttribute('data-k') === '0').length;
  const mjBad = items.filter((x) => x.mj === 'missing' || x.mj === 'differs').length;
  const skip = items.filter((x) => x.mj === 'skip').length;
  $('stat').textContent = 'Команд: ' + cmds.length + ', середовищ: ' + (items.length - cmds.length) + '. Не відтворюються в KaTeX: ' + notK + (mjFile ? '. У mathjax-macros.tex немає або інше: ' + mjBad + '. MathJax не виразить: ' + skip : '. Файла макросів MathJax немає (команда «Файл макросів для MathJax»)') + '.';
}

function filter() {
  const q = $('q').value.trim().toLowerCase();
  const fK = $('fK').checked;
  const fM = $('fM').checked;
  const t = $('fT').value;
  let shown = 0;
  document.querySelectorAll('.mc').forEach((c) => {
    const it = items[Number(c.getAttribute('data-i'))];
    let ok = true;
    if (t && it.kind !== t) ok = false;
    if (ok && fK && c.getAttribute('data-k') !== '0') ok = false;
    if (ok && fM && !(it.mj === 'missing' || it.mj === 'differs')) ok = false;
    if (ok && q && !(it.name.toLowerCase().includes(q) || it.doc.toLowerCase().includes(q) || it.src.toLowerCase().includes(q))) ok = false;
    c.hidden = !ok;
    if (ok) shown++;
  });
  document.querySelectorAll('#list section').forEach((s) => { s.hidden = !s.querySelector('.mc:not([hidden])'); });
  stat();
  $('stat').textContent += ' Показано: ' + shown + '.';
}

window.addEventListener('message', function (e) {
  const m = e.data;
  if (!m) return;
  if (m.type === 'copied') { kit.toast('Скопійовано: ' + (m.what || '')); return; }
  if (m.type !== 'items') return;
  macros = m.macros || {};
  items = m.items || [];
  mjFile = !!m.mjFile;
  const y = window.scrollY;
  build();
  window.scrollTo(0, y);
});

document.addEventListener('click', function (e) {
  if (kit.click(e)) return;
  const g = e.target && e.target.closest ? e.target.closest('a[data-go]') : null;
  if (g) { e.preventDefault(); vscode.postMessage({ type: 'goto', i: Number(g.getAttribute('data-go')) }); }
});
document.addEventListener('dblclick', kit.dblclick);
['q', 'fK', 'fM', 'fT'].forEach((id) => $(id).addEventListener(id === 'q' ? 'input' : 'change', filter));
$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
vscode.postMessage({ type: 'ready' });
