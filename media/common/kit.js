/* kit.js: what the pages of the extension (preview of the selection, macro gallery, overview of formulas) share:
 * a formula drawn with KaTeX and the macros of the project, a formula copied as MathML or TeX, a short notice.
 * window.tssKit(vscode, getMacros) -> { draw, copyFormula, addCopy, click, dblclick, toast, tex } */
window.tssKit = function (vscode, getMacros) {
  const macrosFor = () => (window.tssKatexMacros || ((m) => Object.assign({}, m)))(getMacros() || {});
  const kopts = (display, throwOnError) => ({ displayMode: display, throwOnError, strict: 'ignore', output: 'html', trust: false, macros: macrosFor() });
  const texOf = (el) => el.getAttribute('data-plain') || el.getAttribute('data-tex') || '';

  // A formula: KaTeX with the macros of the project; what KaTeX cannot read is shown as red source (or, with `strict`, draw()
  // returns false and leaves the element empty so that the caller decides). A formula with coloured changes (a derivation)
  // falls back to its plain TeX when the coloured one is not accepted.
  function draw(el, texOverride, strict) {
    let tex = texOverride !== undefined ? texOverride : el.getAttribute('data-tex') || '';
    const display = el.getAttribute('data-d') === '1';
    try {
      if (!window.katex) throw new Error('no katex');
      if (/\\color\{#/.test(tex) && el.hasAttribute('data-plain')) {
        try { window.katex.render(tex, el, kopts(display, true)); el.classList.remove('err'); return true; } catch (e) { tex = el.getAttribute('data-plain') || ''; }
      }
      if (strict) { window.katex.render(tex, el, kopts(display, true)); el.classList.remove('err'); return true; }
      window.katex.render(tex, el, kopts(display, false));
      el.classList.remove('err');
      return true;
    } catch (e) {
      if (strict) { el.textContent = ''; return false; }
      el.textContent = tex;
      el.classList.add('err');
      return false;
    }
  }

  function toast(t) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = t;
    el.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('on'), 1600);
  }

  function mathml(el) {
    const display = el.getAttribute('data-d') === '1';
    try {
      const h = window.katex.renderToString(texOf(el), { displayMode: display, throwOnError: false, strict: 'ignore', output: 'mathml', trust: false, macros: macrosFor() });
      const m = /<math[\s\S]*<\/math>/.exec(h);
      return m ? m[0] : '';
    } catch (e) { return ''; }
  }

  function copy(text, html, what) {
    if (!text) { toast('Нічого копіювати'); return; }
    const fallback = () => vscode.postMessage({ type: 'copy', text, what });
    try {
      if (navigator.clipboard && window.ClipboardItem && html) {
        navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]).then(() => toast('Скопійовано: ' + what), fallback);
        return;
      }
    } catch (e) { /* the extension copies the text */ }
    fallback();
  }

  function copyFormula(el, kind) {
    if (kind === 'tex') copy(texOf(el), '', 'TeX');
    else { const m = mathml(el); copy(m, m ? '<html><body>' + m + '</body></html>' : '', 'MathML'); }
  }

  // two small buttons in the corner of a block formula (visible on hover)
  function addCopy(box) {
    if (box.querySelector(':scope > .cpb') || !box.querySelector('span.m')) return;
    const b = document.createElement('div');
    b.className = 'cpb';
    b.innerHTML = '<button data-cp="mathml" title="Копіювати формулу як MathML (для Word)">MathML</button><button data-cp="tex" title="Копіювати LaTeX формули">TeX</button>';
    box.appendChild(b);
  }

  // true when the click was on a copy button
  function click(e) {
    const c = e.target && e.target.closest ? e.target.closest('button[data-cp]') : null;
    if (!c) return false;
    const box = c.closest('.dm');
    const el = box && box.querySelector('span.m');
    if (el) copyFormula(el, c.getAttribute('data-cp'));
    return true;
  }
  // a double click on a formula copies it as MathML
  function dblclick(e) {
    const el = e.target && e.target.closest ? e.target.closest('span.m') : null;
    if (el) copyFormula(el, 'mathml');
  }
  return { draw, copyFormula, addCopy, click, dblclick, toast, tex: texOf };
};
