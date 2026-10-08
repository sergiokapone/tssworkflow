'use strict';
/* Pure helpers of TSS Workflow 0.4.0 (no VS Code API): the command tree of the Activity Bar view. */

const P = 'tssworkflow.';
// one entry: [command id without the prefix, label, codicon]; `raw: true` is a command of VS Code itself
const GROUPS = [
  { id: 'build', en: 'Build & PDF', label: 'Збірка й PDF', icon: 'play', expanded: true, items: [
    ['compilePdf', 'Зібрати розділ і відкрити PDF', 'play'],
    ['compile', 'Зібрати розділ (без PDF)', 'play-circle'],
    ['compileMainPdf', 'Зібрати весь документ і відкрити PDF', 'run-all'],
    ['compileMain', 'Зібрати весь документ (без PDF)', 'debug-start'],
    ['stopBuild', 'Зупинити збірку', 'debug-stop'],
    ['toggleCompileOnSave', 'Збірка при збереженні (вкл./викл.)', 'save'],
    ['openPdfExternal', 'PDF у зовнішній програмі', 'link-external'],
    ['externalForwardSearch', 'SyncTeX: показати рядок у PDF', 'go-to-file'],
    ['cleanAux', 'Видалити допоміжні файли (PDF лишити)', 'trash'],
    ['clean', 'Видалити допоміжні файли й PDF', 'trash'],
    ['buildParts', 'Зібрати лише вибрані частини (\\part)', 'layers'],
    ['showHooks', 'Хуки виводу сторінки (shipout)', 'debug-console']
  ] },
  { id: 'new', en: 'Templates & new files', label: 'Шаблони й нові файли', icon: 'new-file', expanded: true, items: [
    ['newFromTemplate', 'Новий документ із шаблона…', 'new-file'],
    ['insertTemplate', 'Вставити фрагмент шаблона…', 'insert'],
    ['makeTemplate', 'Зберегти як шаблон…', 'save-as'],
    ['manageTemplates', 'Керувати шаблонами…', 'library'],
    ['openTemplatesFolder', 'Тека моїх шаблонів', 'folder-opened'],
    ['newChapter', 'Новий розділ (папка, шапка, main.tex)', 'add']
  ] },
  { id: 'text', en: 'Text', label: 'Текст', icon: 'edit', items: [
    ['normalize', 'Нормалізувати файл (з переглядом змін)', 'tools'],
    ['normalizeOptions', 'Параметри нормалізації', 'settings-gear'],
    ['typography', 'Українська типографіка', 'symbol-text'],
    ['fixTypographyHints', 'Виправити типографічні зауваження у файлі', 'wand'],
    ['unwrap', 'Склеїти рядки абзацу', 'list-flat'],
    ['wrap', 'Розбити абзац за шириною', 'word-wrap'],
    ['sentences', 'Одне речення в рядок', 'list-ordered'],
    ['unicodeToLatex', 'Unicode → LaTeX', 'symbol-operator'],
    ['toggleIffalse', 'Обгорнути / зняти \\iffalse … \\fi', 'comment']
  ] },
  { id: 'structure', en: 'Structure, formulas, tables', label: 'Структура, формули, таблиці', icon: 'symbol-structure', items: [
    ['convertEnv', 'Змінити формульне середовище / мітку', 'symbol-namespace'],
    ['displayToEquation', '\\[ … \\] → equation*', 'symbol-numeric'],
    ['frameSections', 'Обрамити заголовки й формули', 'symbol-boolean'],
    ['reframeSections', 'Переобрамити заголовки й формули', 'refresh'],
    ['alignTable', 'Вирівняти таблицю по &', 'table'],
    ['formatTblr', 'Форматувати tblr / longtblr (параметри й клітинки)', 'table'],
    ['formatTikz', 'Розкласти \\tikz{…} по рядках (один оператор на рядок)', 'list-tree'],
    ['renumberBeamer', 'Пронумерувати слайди beamer', 'list-ordered'],
    ['tableOps', 'Дії з таблицею', 'table'],
    ['editTable', 'Редагувати таблицю візуально', 'table'],
    ['tableFromFile', 'Таблиця з CSV / XLSX / буфера в tblr', 'table'],
    ['extractTikz', 'Винести tikzpicture під курсором у tikz/', 'export'],
    ['extractTikzAll', 'Винести всі tikzpicture у tikz/', 'export']
  ] },
  { id: 'nav', en: 'Navigation', label: 'Навігація', icon: 'list-tree', items: [
    ['goToHeading', 'Перейти до заголовка (весь проєкт)', 'list-tree'],
    ['pickFile', 'Вибрати ім\u02bcя файла для \\localinput / \\includegraphics', 'file-code'],
    ['pictures', 'Панель рисунків', 'file-media'],
    ['pickRef', 'Вставити \\ref (вибір мітки)', 'symbol-key'],
    ['renameLabel', 'Перейменувати мітку (з усіма \\ref)', 'edit'],
    ['projectWordCount', 'Слова проєкту (за розділами й файлами)', 'pencil'],
    ['listEquations', 'Список усіх формул проєкту', 'symbol-numeric'],
    ['pickMacro', 'Перейти до макроса з .cls/.sty', 'symbol-method'],
    ['macroInfo', 'Де визначено макрос (діагностика)', 'question']
  ] },
  { id: 'checks', en: 'Checks', label: 'Перевірки', icon: 'checklist', items: [
    ['checkLabels', 'Мітки: дублі й невизначені', 'checklist'],
    ['checkCitations', 'Ключі \\cite у .bib', 'references'],
    ['unusedFiles', 'Файли без посилань (Pictures/, tikz/)', 'files'],
    ['unusedEquations', 'Нумеровані формули без посилань', 'symbol-numeric'],
    ['unusedPackages', 'Невикористані \\usepackage', 'package'],
    ['missingPackages', 'Відсутні пакети з логу (tlmgr)', 'cloud-download'],
    ['ltexDictionary', 'LTeX: додати слова у словник', 'book']
  ] },
  { id: 'biblio', en: 'Bibliography & versions', label: 'Бібліографія й версії', icon: 'git-compare', items: [
    ['bibFromDoi', 'BibTeX за DOI', 'library'],
    ['formatBib', 'Форматувати .bib (сортування, вирівнювання)', 'list-flat'],
    ['bibDuplicates', 'Дублі в .bib (DOI, назва)', 'files'],
    ['bibNormalizeKeys', 'Ключі .bib: прізвище+рік (і \\cite)', 'symbol-key'],
    ['savePdfCopy', 'Зберегти копію PDF з датою', 'save-as'],
    ['latexdiff', 'Зміни розділу від ревізії git (latexdiff)', 'git-compare']
  ] },
  { id: 'refactor', en: 'Refactoring & snapshots', label: 'Рефакторинг і знімки', icon: 'replace-all', items: [
    ['renameChapter', 'Перейменувати розділ (папка, файл, посилання)', 'edit'],
    ['replaceInProject', 'Замінити по проєкту (без коментарів і verbatim)', 'replace-all'],
    ['notationReport', 'Узгодженість позначень (\\varepsilon / \\epsilon …)', 'symbol-operator'],
    ['normalizeProject', 'Нормалізувати весь проєкт', 'tools'],
    ['makeSnapshot', 'Зберегти знімок проєкту', 'device-camera'],
    ['restoreSnapshot', 'Відновити знімок', 'history']
  ] },
  { id: 'info', en: 'Information', label: 'Інформація', icon: 'graph', items: [
    ['projectStats', 'Статистика проєкту', 'graph'],
    ['todoList', 'Список TODO / FIXME', 'tasklist']
  ] },
  { id: 'project', en: 'Project & settings', label: 'Проєкт і налаштування', icon: 'gear', items: [
    ['initProjectSettings', 'Створити .vscode/settings.json', 'file-add'],
    ['checkEnvironment', 'Doctor: перевірити середовище (latexmk, lualatex, …)', 'pulse'],
    ['reloadMacros', 'Перечитати макроси з .cls/.sty', 'refresh'],
    ['generateMathJax', 'Файл макросів для MathJax', 'symbol-misc'],
    ['@settings', 'Налаштування розширення', 'settings-gear', { raw: 'workbench.action.openSettings', args: ['tssworkflow'], en: 'Extension settings' }]
  ] }
];

// commands that stay out of the tree on purpose: they belong to the toolbar of the TODO view or to the
// buttons of the "Розділи" panel (they take the clicked chapter as an argument)
const EXCLUDED = ['todoRefresh', 'openChapter', 'buildChapter', 'chapterHooks', 'refreshChapters', 'moveChapterUp', 'moveChapterDown', 'refreshProblems', 'refreshLabels', 'labelsToggleFilter', 'insertRefFromLabel'];

// 'ctrl+alt+t' -> 'Ctrl+Alt+T', 'f5' -> 'F5', 'shift+f5' -> 'Shift+F5'
function formatKey(k) {
  return String(k).split('+').map((p) => {
    const t = p.trim();
    if (/^f\d{1,2}$/i.test(t)) return t.toUpperCase();
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
  }).join('+');
}

// command id (with prefix) -> shortcut, from the `keybindings` of package.json (the first one wins)
function keyMap(keybindings) {
  const m = {};
  for (const k of keybindings || []) if (k && k.command && k.key && !m[k.command]) m[k.command] = formatKey(k.key);
  return m;
}

// every command of the package must be in the tree exactly once (or be excluded on purpose)
function coverage(commandIds) {
  const ids = commandIds.map((c) => c.replace(/^tssworkflow\./, ''));
  const seen = {};
  for (const g of GROUPS) for (const it of g.items) { const o = it[3]; if (!(o && o.raw)) seen[it[0]] = (seen[it[0]] || 0) + 1; }
  return {
    missing: ids.filter((c) => !seen[c] && !EXCLUDED.includes(c)),
    duplicates: Object.keys(seen).filter((c) => seen[c] > 1),
    unknown: Object.keys(seen).filter((c) => !ids.includes(c))
  };
}

/* ------------------------- live state and languages ------------------------ */
const STATE_LABEL = { uk: 'Стан', en: 'State' };
const GROUP_ICON_STATE = 'pulse';

const lang = (l) => (l === 'en' ? 'en' : 'uk');
const groupLabel = (g, l) => (lang(l) === 'en' && g.en ? g.en : g.label);

// the label of a command row: Ukrainian from GROUPS, English from the command title of package.json
// ("TSS Workflow: Compile + open PDF" -> "Compile + open PDF"); `titles` maps the command id (with prefix) to its title
function itemLabel(it, l, titles) {
  const o = it[3];
  if (lang(l) !== 'en') return it[1];
  if (o && o.en) return o.en;
  const t = titles && titles[P + it[0]];
  return t ? String(t).replace(/^TSS Workflow:\s*/, '') : it[1];
}

// the rows of the "State" group: { id, label, icon, command?, tooltip }
// st = { building: {label} | null, target: {kind: 'chapter'|'figure'|'root', name, chapter?} | null, auto: boolean }
function stateItems(l, st) {
  const en = lang(l) === 'en';
  const out = [];
  if (st.building) {
    out.push({ id: 'building', label: (en ? 'Building: ' : 'Іде збірка: ') + st.building.label, icon: 'sync~spin', command: P + 'stopBuild',
      tooltip: en ? 'Click stops the build' : 'Клік зупиняє збірку' });
  } else {
    out.push({ id: 'building', label: en ? 'No build running' : 'Збірка не запущена', icon: 'circle-large-outline' });
  }
  const t = st.target;
  if (!t) {
    out.push({ id: 'target', label: en ? 'Open a chapter or a figure' : 'Відкрий розділ чи рисунок', icon: 'book' });
  } else if (t.kind === 'root') {
    out.push({ id: 'target', label: (en ? 'Root file: ' : 'Кореневий файл: ') + t.name, icon: 'book', command: P + 'compileMainPdf',
      tooltip: en ? 'Click builds the whole document and opens the PDF' : 'Клік збирає весь документ і відкриває PDF' });
  } else {
    const label = t.kind === 'figure'
      ? (en ? 'Figure: ' : 'Рисунок: ') + t.name + (t.chapter ? (en ? ' (chapter ' : ' (розділ ') + t.chapter + ')' : '')
      : (en ? 'Chapter: ' : 'Розділ: ') + t.name;
    out.push({ id: 'target', label, icon: 'book', command: P + 'compilePdf',
      tooltip: en ? 'Click builds it and opens the PDF' : 'Клік збирає і відкриває PDF' });
  }
  out.push({ id: 'auto', label: (en ? 'Build on save: ' : 'Збірка при збереженні: ') + (st.auto ? (en ? 'on' : 'вкл.') : (en ? 'off' : 'викл.')),
    icon: st.auto ? 'check' : 'circle-slash', command: P + 'toggleCompileOnSave', tooltip: en ? 'Click toggles' : 'Клік перемикає' });
  return out;
}

module.exports = { GROUPS, EXCLUDED, formatKey, keyMap, coverage, PREFIX: P, STATE_LABEL, GROUP_ICON_STATE, groupLabel, itemLabel, stateItems };
