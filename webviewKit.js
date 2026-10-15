'use strict';
/* webviewKit.js: what the panels with their own page share. createPanelController (below) is the frame of ALL four panels
 * (macro gallery, overview of formulas, preview of the selection, table editor): the panel and its `ready` / `seq` state, the
 * deferred update, the handshake `ready`, the clipboard message `copy`, the listeners that live exactly as long as the panel
 * (util.panelScope) and the reset when it is closed. A module gives only what is its own: the HTML, the data, its messages.
 * The HTML shell with KaTeX (macro gallery, overview of formulas):
 * the macros of the project and kit.js (media/common/kit.js), a strict content security policy with a nonce, and the
 * clipboard fallback of the page. The page of the panel "Preview selection" has its own shell (selectionPreview.js). */
const vscode = require('vscode');
const { cancelTimer, debounce, panelScope } = require('./util');

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

/* createPanelController(o): one webview panel of the extension.
 *   o.id            'macroGallery' -> viewType 'tssworkflow.macroGallery', timer key 'macroGallery.update'
 *   o.title         the title of the tab;  o.viewColumn (default Beside), o.preserveFocus (default false)
 *   o.html(webview, extUri, context) -> the HTML of the page
 *   o.roots(context) -> extra localResourceRoots besides media/   (optional)
 *   o.collect(ctl) -> data and o.render(data, ctl): the standard update (nothing before `ready`; an answer that is no longer
 *                     the last one, or arrives after the panel was closed, is dropped);  or o.update(ctl) instead, when the module
 *                     does its own (it then uses ctl.begin() / ctl.live(token))
 *   o.onReady(ctl)  default: schedule(0);   o.onRefresh(ctl): the page sent 'refresh' (when given);   o.onMessage(m, ctl): the rest
 *   o.onViewState(e, ctl), o.onReveal(ctl, panel) (default: reveal and schedule(0)), o.onReset(ctl) (state of the module, runs on close)
 *   o.timers        more timer keys to cancel on close;   o.noCopy: the page does not send 'copy'
 * ctl: panel, ready, isOpen(), open(context), post(msg), schedule(ms), begin(), live(token), update(), dispose() */
function createPanelController(o) {
  let panel = null;
  let ready = false;
  let seq = 0;
  const key = o.id + '.update';
  const ctl = {
    get panel() { return panel; },
    get ready() { return ready; },
    isOpen: () => !!panel,
    post: (m) => (panel ? panel.webview.postMessage(m) : undefined),
    begin: () => ++seq,
    live: (token) => !!panel && token === seq,
    dispose() { if (panel) panel.dispose(); },
    schedule(delay) {
      if (!panel) return;
      debounce(key, delay, () => { const p = ctl.update(); if (p && typeof p.catch === 'function') p.catch(() => {}); });
    },
    async update() {
      if (o.update) return o.update(ctl);
      if (!panel || !ready) return undefined;
      const mine = ++seq;
      let r;
      try { r = await o.collect(ctl); } catch (e) { return undefined; }
      if (!ctl.live(mine)) return undefined;
      return o.render(r, ctl);
    },
    open(context) {
      if (panel) {
        if (o.onReveal) o.onReveal(ctl, panel); else { panel.reveal(undefined, false); ctl.schedule(0); }
        return panel;
      }
      const extUri = context.extensionUri;
      panel = vscode.window.createWebviewPanel('tssworkflow.' + o.id, o.title, { viewColumn: o.viewColumn || vscode.ViewColumn.Beside, preserveFocus: !!o.preserveFocus },
        { enableScripts: true, retainContextWhenHidden: o.retainContextWhenHidden !== false, localResourceRoots: [vscode.Uri.joinPath(extUri, 'media')].concat(o.roots ? o.roots(context) : []) });
      ready = false;
      panel.webview.html = o.html(panel.webview, extUri, context);
      const subs = panelScope(panel, () => {
        cancelTimer(key);
        (o.timers || []).forEach((k) => cancelTimer(k));
        try { if (o.onReset) o.onReset(ctl); } finally { panel = null; ready = false; seq++; }
      });
      panel.webview.onDidReceiveMessage((m) => {
        if (!m) return;
        if (m.type === 'ready') { ready = true; if (o.onReady) o.onReady(ctl); else ctl.schedule(0); return; }
        if (m.type === 'copy' && !o.noCopy) { copyText(panel, m); return; }
        if (m.type === 'refresh' && o.onRefresh) { o.onRefresh(ctl); return; }
        if (o.onMessage) o.onMessage(m, ctl);
      }, null, subs);
      if (o.onViewState) panel.onDidChangeViewState((e) => o.onViewState(e, ctl), null, subs);
      return panel;
    }
  };
  return ctl;
}

module.exports = { shell, copyText, nonce, createPanelController };
