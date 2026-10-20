/* media/common/i18n.js: T('Український текст {0}', arg) for a page of a webview. The texts of the language of the extension are in the JSON block
 * <script type="application/json" id="tss-i18n"> that the host puts into the HTML (webviewI18n.js); a text that is not there stays as written (Ukrainian). */
(function () {
  'use strict';
  var dict = {};
  try { dict = JSON.parse(document.getElementById('tss-i18n').textContent) || {}; } catch (e) { dict = {}; }
  window.T = function (key) {
    var s = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : key;
    var args = arguments;
    return args.length > 1 ? s.replace(/\{(\d+)\}/g, function (m, i) { return +i + 1 < args.length ? String(args[+i + 1]) : m; }) : s;
  };
})();
