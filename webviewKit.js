'use strict';
/* webviewKit.js: what the panels with their own page share (macro gallery, overview of formulas): the HTML shell with KaTeX,
 * the macros of the project and kit.js (media/common/kit.js), a strict content security policy with a nonce, and the
 * clipboard fallback of the page. The page of the panel "Preview selection" has its own shell (selectionPreview.js). */
const vscode = require('vscode');

const nonce = () => { let t = ''; const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; for (let i = 0; i < 32; i++) t += c[Math.floor(Math.random() * c.length)]; return t; };

// opts: { lang, title, body (HTML of the page, trusted), css: ['macroGallery/webview.css'], js: ['macroGallery/webview.js'] }
function shell(webview, extUri, opts) {
  const n = nonce();
  const asset = (p) => webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'media', ...p.split('/'))).toString();
  const csp = "default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; script-src 'nonce-" + n + "' " + webview.cspSource + '; font-src ' + webview.cspSource + '; img-src ' + webview.cspSource + ' data:;';
  const css = ['katex/katex.min.css'].concat(opts.css || []).map((p) => '<link rel="stylesheet" href="' + asset(p) + '">').join('');
  const js = ['katex/katex.min.js', 'katex/mhchem.min.js', 'katex/optmacros.js', 'common/kit.js'].concat(opts.js || []).map((p) => '<script nonce="' + n + '" src="' + asset(p) + '"></script>').join('');
  return '<!DOCTYPE html><html lang="uk"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '"><meta name="viewport" content="width=device-width, initial-scale=1">' + css + '</head><body>' + opts.body + '<div id="toast"></div>' + js + '</body></html>';
}

// the page could not use the clipboard itself: the text goes through the extension
function copyText(panel, m) {
  if (!m || typeof m.text !== 'string' || m.text.length > 2000000) return;
  Promise.resolve(vscode.env.clipboard.writeText(m.text)).then(() => { if (panel) panel.webview.postMessage({ type: 'copied', what: String(m.what || '').slice(0, 40) }); }, () => {});
}

module.exports = { shell, copyText, nonce };
