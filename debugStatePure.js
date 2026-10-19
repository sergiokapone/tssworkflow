'use strict';
/* debugStatePure.js: the text of the state report (command tssworkflow.debugState). No vscode here: the numbers come in as a
 * plain object, so the report can be tested. The point of the report is to look for leaks on the real project instead of
 * guessing: open and close a panel ten times, call the command again, and the numbers of the second report must be back where
 * they were (the report shows the change since the previous call). */

const { tr } = require('./i18n');
const mb = (b) => (typeof b === 'number' ? (b / 1048576).toFixed(1) + tr(' МБ') : '—');
const sign = (d) => (d > 0 ? '+' + d : String(d));
const secs = (s) => {
  const x = Math.round(s || 0);
  const h = Math.floor(x / 3600), m = Math.floor((x % 3600) / 60);
  return h ? tr('{0} год {1} хв', h, m) : m ? tr('{0} хв {1} с', m, x % 60) : tr('{0} с', x);
};
const cell = (v) => String(v).replace(/\|/g, '\\|');

/* what is compared between two calls: the numbers that must not grow while the user does nothing */
function counters(s) {
  const index = s.index || {};
  return {
    subscriptions: s.subscriptions || 0,
    timers: (s.timers || []).length,
    findCache: s.findCache || 0,
    docMap: s.docMap || 0,
    index: Object.values(index).reduce((a, b) => a + b, 0),
    panels: Object.values(s.panels || {}).filter(Boolean).length,
    heapUsed: (s.memory && s.memory.heapUsed) || 0,
    rss: (s.memory && s.memory.rss) || 0
  };
}

// prev: counters() of the previous call, or null
function report(s, prev) {
  const c = counters(s);
  const d = (k) => (prev ? ' (' + sign(c[k] - prev[k]) + ')' : '');
  const dm = (k) => (prev ? ' (' + (c[k] - prev[k] >= 0 ? '+' : '−') + mb(Math.abs(c[k] - prev[k])) + ')' : '');
  const lines = [];
  lines.push(tr('# TSS Workflow: стан розширення'));
  lines.push('');
  lines.push(tr('Версія {0} · VS Code {1} · {2} · Node {3} · процес розширень працює {4}', s.version || '?', s.vscodeVersion || '?', s.platform || '?', s.node || '?', secs(s.uptimeSec)));
  lines.push('');
  lines.push(prev ? tr('У дужках: зміна відтоді, як команду викликали минулого разу.') : tr('Це перший виклик: викличте команду ще раз після роботи (відкрийте й закрийте панелі кілька разів), і в дужках з\'явиться зміна.'));
  lines.push('');
  lines.push(tr('## Що може текти'));
  lines.push('');
  lines.push(tr('| Показник | Значення |'));
  lines.push('| --- | --- |');
  lines.push('| ' + tr('`context.subscriptions` (слухачі й команди розширення)') + ' | ' + c.subscriptions + d('subscriptions') + ' |');
  lines.push('| ' + tr('Очікуючі таймери (`util.debounce`)') + ' | ' + c.timers + d('timers') + (c.timers ? ': ' + cell((s.timers || []).slice().sort().join(', ')) : '') + ' |');
  lines.push('| ' + tr('Відкриті панелі webview') + ' | ' + c.panels + d('panels') + (c.panels ? ': ' + cell(Object.keys(s.panels).filter((k) => s.panels[k]).join(', ')) : '') + ' |');
  lines.push('| ' + tr('Відкриті документи в VS Code') + ' | ' + (s.openDocs == null ? '—' : s.openDocs) + ' |');
  lines.push('');
  lines.push(tr('## Кеші'));
  lines.push('');
  lines.push(tr('| Кеш | Записів |'));
  lines.push('| --- | --- |');
  lines.push('| ' + tr('Кеш увімкнено (`util.initCaches`, спостерігач файлів)') + ' | ' + (s.caching ? tr('так') : tr('**ні** (усе читається з диска щоразу)')) + ' |');
  lines.push('| ' + tr('Списки файлів проєкту (`findCached`)') + ' | ' + c.findCache + d('findCache') + ' |');
  lines.push('| ' + tr('Відкриті документи за шляхом (`openDocByPath`)') + ' | ' + (s.docMap == null ? tr('ще не побудовано') : c.docMap + d('docMap')) + ' |');
  const kinds = Object.keys(s.index || {}).sort();
  lines.push('| ' + tr('Індекс проєкту (`projectIndex`), усього') + ' | ' + c.index + d('index') + (kinds.length ? ': ' + cell(kinds.map((k) => k + ' ' + s.index[k]).join(', ')) : '') + ' |');
  lines.push('');
  lines.push(tr('## Пам\'ять процесу розширень (усі розширення разом)'));
  lines.push('');
  lines.push(tr('| Показник | Значення |'));
  lines.push('| --- | --- |');
  lines.push('| RSS | ' + mb(s.memory && s.memory.rss) + dm('rss') + ' |');
  lines.push('| ' + tr('Купа JS (використано з {0})', mb(s.memory && s.memory.heapTotal)) + ' | ' + mb(s.memory && s.memory.heapUsed) + dm('heapUsed') + ' |');
  lines.push('| ' + tr('Зовнішня (буфери)') + ' | ' + mb(s.memory && s.memory.external) + ' |');
  lines.push('');
  lines.push(tr('## Як читати'));
  lines.push('');
  lines.push(tr('- `context.subscriptions` має лишатися сталим, коли ви тільки відкриваєте й закриваєте панелі. Зростання на кожне відкриття означає слухачі, які не знімаються.'));
  lines.push(tr('- Очікуючі таймери: коли ви нічого не друкуєте, їх має бути 0–3 (разові відкладені перевірки, що ще не спрацювали). Якщо їх багато й ключі повторюються з різними документами, щось планує роботу швидше, ніж встигає її робити.'));
  lines.push(tr('- Відкриті панелі: прихована панель з `retainContextWhenHidden` тримає живий webview (десятки МБ).'));
  lines.push(tr('- Пам\'ять: купа росте й спадає після збирання сміття; про витік говорить лише стійке зростання після кількох викликів.'));
  lines.push('');
  return lines.join('\n');
}

module.exports = { report, counters, mb, secs };
