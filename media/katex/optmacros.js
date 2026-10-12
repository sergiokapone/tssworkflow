/* optmacros.js: macros of the project with an optional first argument for KaTeX.
 * KaTeX takes a macro as a string and a string cannot say "the first argument is optional": \newcommand{\E}[1][E]{\mathbf{#1}}.
 * The extension sends such a command as a description { n, def, body } (n = the number of arguments counting the optional one,
 * def = its default, body = the definition with #1 ... #n); window.tssKatexMacros(macros) turns the descriptions into
 * function macros and leaves the plain strings alone. \E -> body with #1 = def, \E[B] -> #1 = B; the other arguments (#2 ...)
 * stay arguments of the macro, KaTeX takes them from the formula. */
(function () {
  // tokens in the order they were read -> TeX text (a control word is followed by a space when a letter comes next)
  function text(tokens) {
    let s = '';
    for (const t of tokens) {
      const x = t.text;
      if (s && /\\[A-Za-z@]+$/.test(s) && /^[A-Za-z@]/.test(x)) s += ' ';
      s += x;
    }
    return s;
  }

  function make(d) {
    return function (ctx) {
      let opt = String(d.def == null ? '' : d.def);
      const next = ctx.future();
      if (next && next.text === '[') {
        ctx.popToken();
        const toks = [];
        let depth = 0;
        for (;;) {
          const t = ctx.popToken();
          if (!t || t.text === 'EOF') break;
          if (t.text === '{') depth++;
          else if (t.text === '}') depth--;
          else if (t.text === ']' && depth <= 0) break;
          toks.push(t);
        }
        opt = text(toks);
      }
      // #1 is the optional argument, #2 ... become #1 ... for the arguments that follow
      return String(d.body).replace(/##|#([1-9])/g, function (m, k) { return m === '##' ? m : (k === '1' ? opt : '#' + (Number(k) - 1)); });
    };
  }

  window.tssKatexMacros = function (macros) {
    const out = {};
    for (const k of Object.keys(macros || {})) {
      const v = macros[k];
      out[k] = v && typeof v === 'object' && typeof v.body === 'string' ? make(v) : v;
    }
    return out;
  };
})();
