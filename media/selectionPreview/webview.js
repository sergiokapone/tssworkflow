const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const attr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); // a text inside an attribute of the markup built below
let macros = {};
const stepAt = []; // per derivation block (by its order in the page): 0 = all rows, k = rows 1..k; kept while the text is edited

const kit = window.tssKit(vscode, () => macros);
const draw = kit.draw;

/* ------------------------- a derivation, row by row ------------------------- */
function stepsOf(el) {
  try { const a = JSON.parse(el.getAttribute('data-steps') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
function paintSteps(box, idx) {
  const el = box.querySelector('span.m');
  const n = Number(el.getAttribute('data-n')) || 0;
  const steps = stepsOf(el);
  const k = stepAt[idx] || 0;
  if (k > 0 && steps[k - 1]) draw(el, steps[k - 1]); else draw(el);
  const lab = box.querySelector('.stpn');
  if (lab) lab.textContent = !steps.length ? T('рядків: {0} (покроково лише до 24)', n) : k ? T('Крок {0} з {1}', k, n) : T('Усі {0} рядків', n);
  box.querySelectorAll('.stpbar button[data-step]').forEach((b) => { b.disabled = !steps.length; });
}
function addSteps(box, idx) {
  if (box.querySelector('.stpbar')) return;
  const bar = document.createElement('div');
  bar.className = 'stpbar';
  bar.innerHTML = '<button data-step="prev" title="' + attr(T('Попередній крок')) + '">◀</button><span class="stpn"></span><button data-step="next" title="' + attr(T('Наступний крок')) + '">▶</button><button data-step="all" title="' + attr(T('Усі рядки зі змінами')) + '">' + T('Усе') + '</button>';
  box.appendChild(bar);
  paintSteps(box, idx);
}

window.addEventListener('message', function (e) {
  const m = e.data;
  if (m && m.type === 'copied') { kit.toast(T('Скопійовано: {0}', m.what || '')); return; }
  if (!m || m.type !== 'render') return;
  macros = m.macros || {};
  const wrap = $('wrap');
  const y = wrap.scrollTop;
  const out = $('out');
  out.innerHTML = m.html || '<p class="empty">' + T('Виділи фрагмент у файлі: тут з\u2019явиться його вигляд.') + '</p>';
  out.querySelectorAll('span.m').forEach((el) => { if (!el.closest('.stp')) draw(el); });
  const blocks = out.querySelectorAll('.stp');
  stepAt.length = Math.min(stepAt.length, blocks.length);
  blocks.forEach((box, i) => addSteps(box, i));
  out.querySelectorAll('div.dm').forEach(kit.addCopy);
  $('what').textContent = m.what || '';
  $('where').textContent = m.where || '';
  $('notes').textContent = m.notes && m.notes.length ? T('Не відтворено (є лише в PDF): {0}', m.notes.slice(0, 12).join(', ') + (m.notes.length > 12 ? '…' : '')) : '';
  wrap.scrollTop = y;
});

document.addEventListener('click', function (e) {
  const t = e.target && e.target.closest ? e.target : null;
  if (!t) return;
  const s = t.closest('button[data-step]');
  if (s) {
    const box = s.closest('.stp');
    const all = Array.from($('out').querySelectorAll('.stp'));
    const idx = all.indexOf(box);
    const n = Number(box.querySelector('span.m').getAttribute('data-n')) || 0;
    const k = stepAt[idx] || 0;
    const what = s.getAttribute('data-step');
    stepAt[idx] = what === 'all' ? 0 : what === 'next' ? (k === 0 ? 1 : Math.min(n, k + 1)) : (k === 0 ? n : Math.max(1, k - 1));
    paintSteps(box, idx);
    return;
  }
  if (kit.click(e)) return;
  const r = t.closest('a[data-ref]');
  if (r) { e.preventDefault(); vscode.postMessage({ type: 'ref', name: r.getAttribute('data-ref') || '' }); return; }
  // a frame of a tikz file (\localinput, \input): a click asks the extension to open the file
  const a = t.closest('a[data-open]');
  if (!a) return;
  e.preventDefault();
  vscode.postMessage({ type: 'open', name: a.getAttribute('data-open') || '', via: a.getAttribute('data-via') || '' });
});
document.addEventListener('dblclick', kit.dblclick);

vscode.postMessage({ type: 'ready' });
