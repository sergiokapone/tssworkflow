'use strict';
/* Tests of the built-in counters of "Project statistics": problems and control questions (projectInfoPure.js).
 * Run from the repository root: node tests/projectStats.test.js [extension] */
const assert = require('assert');
const path = require('path');
const EXT = path.resolve(__dirname, process.env.TSS_EXT || process.argv[2] || '../extension');
const X = require(path.join(EXT, 'projectInfoPure.js'));

let n = 0;
const eq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n++; };
const titleRe = new RegExp(X.DEFAULT_QUESTION_TITLE, 'iu');

// items: \item of the outermost list only, \question anywhere, nothing outside a list
eq(X.countListItems('\\begin{enumerate}\\item a\\item b\\end{enumerate}'), 2);
eq(X.countListItems('\\begin{enumerate}\\item a \\begin{itemize}\\item x\\item y\\end{itemize}\\item b\\end{enumerate}'), 2, 'nested items are not counted');
eq(X.countListItems('\\item stray'), 0);
eq(X.countListItems('\\begin{questions}\\question one\\question two\\end{questions}'), 2);
eq(X.countListItems('\\begin{itemize}\\itemsep=0pt\\item a\\end{itemize}'), 1, '\\itemsep is not an \\item');
eq(X.countListItems('\\begin{enumerate}\\item a\\end{enumerate}\\begin{itemize}\\item b\\item c\\end{itemize}'), 3, 'two lists');

const q = (text) => X.countQuestionItems(text, titleRe);
const list = '\\begin{enumerate}\n\\item a\n\\item b\n\\item c\n\\end{enumerate}\n';
eq(q('\\section{Теорія}\ntext\n\\section{Контрольні запитання}\n' + list + '\\section{Далі}\n\\begin{itemize}\\item z\\end{itemize}'), 3, 'ends at the next section');
eq(q('\\section{Теорія}\n' + list), 0, 'no such section');
eq(q('\\section*{Питання для самоперевірки}\n' + list), 3, 'starred, another title');
eq(q('\\section{Контрольні питання}\n' + list), 3);
eq(q('\\section{Запитання до розділу}\n' + list), 3);
eq(q('\\section{Review questions}\n' + list), 3);
eq(q('\\section{Контрольні запитання до розділу 5}\n' + list), 3, 'longer title');
eq(q('\\section{Задачі}\n' + list), 0, 'other title');
eq(q('\\section{Контрольні запитання}\n' + list + '\\subsection{Додатково}\n\\begin{itemize}\\item x\\end{itemize}\n\\section{Інше}'), 4, 'a subsection stays inside the section');
eq(q('\\section{A}\n\\subsection{Контрольні запитання}\n' + list + '\\subsection{B}\n\\begin{itemize}\\item z\\end{itemize}'), 3, 'a subsection ends at the next subsection');
eq(q('\\chapter{X}\n\\section{Контрольні запитання}\n' + list + '\\section{Питання для самоперевірки}\n' + list), 6, 'two sections add up');
eq(q('\\section{Контрольні запитання}\n\\subsection{Питання для самоперевірки}\n' + list), 3, 'nested matching sections are counted once');
eq(q(''), 0);

// built-in counters
const b = X.builtinCounters({});
eq(Object.keys(b), ['Задач', 'Контр. запитань']);
const t = X.stripComments('\\begin{problem}a\\end{problem}\n% \\begin{problem}hidden\\end{problem}\n\\begin{problem*}b\\end{problem*}\n\\begin{problems}no\\end{problems}');
eq(b['Задач'](t), 2, 'comments and problems are not problem');
eq(Object.keys(X.builtinCounters({ problemEnvs: [] })), ['Контр. запитань'], 'no problem environments: no column');
eq(X.builtinCounters({ problemEnvs: ['exercise', 'task'] })['Задач']('\\begin{exercise}\\end{exercise}\\begin{task}\\end{task}\\begin{problem}\\end{problem}'), 2);
eq(X.builtinCounters({ questionTitle: '(' })['Контр. запитань']('\\section{Контрольні запитання}\n' + list), 3, 'a broken regex falls back to the default');
eq(X.builtinCounters({ questionTitle: 'тест' })['Контр. запитань']('\\section{Тест}\n' + list + '\\section{Контрольні запитання}\n' + list), 3, 'own title');

// in file statistics: per section, in the total, and the old call is unchanged
const file = '\\chapter{Поле}\n\\section{Теорія}\n\\begin{problem}A\\end{problem}\n% \\begin{problem}hidden\\end{problem}\n\\begin{problem}B\\end{problem}\n\\section{Контрольні запитання}\n' + list + '\\section{Інше}\nслово';
const fs = X.fileStats(file, {}, b);
eq(fs.total.extra, { 'Задач': 2, 'Контр. запитань': 3 });
eq(fs.rows.map((r) => [r.title, r.st.extra['Задач'], r.st.extra['Контр. запитань']]),
  [['Поле', 0, 0], ['Теорія', 2, 0], ['Контрольні запитання', 0, 3], ['Інше', 0, 0]]);
eq(X.fileStats(file, {}).total.extra, {}, 'without counters nothing is added');
eq(X.textStats('\\begin{problem}\\end{problem}', { 'Свої': '\\\\begin\\{problem\\}' }, b).extra, { 'Задач': 1, 'Контр. запитань': 0, 'Свої': 1 }, 'built-in and own counters together');
const sum = X.addStats(fs.rows[1].st, fs.rows[2].st);
eq(sum.extra, { 'Задач': 2, 'Контр. запитань': 3 });
eq(X.addStats(X.emptyStats(), fs.total).extra, fs.total.extra);

console.log('projectStats: ' + n + ' checks passed');
