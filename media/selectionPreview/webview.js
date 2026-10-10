const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
let macros = {};

// a formula: KaTeX with the macros of the project; what KaTeX cannot read is shown as red source
function draw(el) {
  const tex = el.getAttribute('data-tex') || '';
  const display = el.getAttribute('data-d') === '1';
  try {
    if (!window.katex) throw new Error('no katex');
    window.katex.render(tex, el, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html', trust: false, macros: Object.assign({}, macros) });
  } catch (e) {
    el.textContent = tex;
    el.classList.add('err');
  }
}

window.addEventListener('message', function (e) {
  const m = e.data;
  if (!m || m.type !== 'render') return;
  macros = m.macros || {};
  const wrap = $('wrap');
  const y = wrap.scrollTop;
  const out = $('out');
  out.innerHTML = m.html || '<p class="empty">Виділи фрагмент у файлі: тут з\u2019явиться його вигляд.</p>';
  out.querySelectorAll('span.m').forEach(draw);
  $('what').textContent = m.what || '';
  $('where').textContent = m.where || '';
  $('notes').textContent = m.notes && m.notes.length ? 'Не відтворено (є лише в PDF): ' + m.notes.slice(0, 12).join(', ') + (m.notes.length > 12 ? '…' : '') : '';
  wrap.scrollTop = y;
});

vscode.postMessage({ type: 'ready' });
