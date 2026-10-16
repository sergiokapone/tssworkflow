'use strict';
/* i18n.js: the language of the messages, reports and labels of the extension (no vscode: the pure modules use it too).
 *   tr(key, ...args)   the key is the Ukrainian text, written in the code as it is; {0}, {1}, ... are replaced with the arguments
 *                      (in the key and in the translation). In "en" the English text of i18nEn.js is used; a key that has none stays Ukrainian.
 *   setLang(setting, displayLanguage)   setting: "uk" | "en" | "auto" (auto: English unless the language of VS Code is Ukrainian)
 * Data that is written into the project (the names of the snapshots) is translated too, but what is already on the disk stays as it was written. */
const EN = require('./i18nEn');

let lang = 'uk';
const setLang = (setting, displayLanguage) => {
  lang = setting === 'en' || (setting === 'auto' && !/^uk\b/i.test(String(displayLanguage || ''))) ? 'en' : 'uk';
  return lang;
};
const getLang = () => lang;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function tr(key, ...args) {
  const s = lang === 'en' && has(EN, key) ? EN[key] : key;
  return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (+i < args.length ? String(args[+i]) : m)) : s;
}

module.exports = { tr, setLang, getLang, EN };
