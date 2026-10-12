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
const b = X.builtinCounters({ questionEnvs: [] }); // the title mode; the quizlist mode is tested below
eq(Object.keys(b), ['Задач', 'Контр. запитань']);
const t = X.stripComments('\\begin{problem}a\\end{problem}\n% \\begin{problem}hidden\\end{problem}\n\\begin{problem*}b\\end{problem*}\n\\begin{problems}no\\end{problems}');
eq(b['Задач'](t), 2, 'comments and problems are not problem');
eq(Object.keys(X.builtinCounters({ problemEnvs: [] })), ['Контр. запитань'], 'no problem environments: no column');
eq(X.builtinCounters({ problemEnvs: ['exercise', 'task'] })['Задач']('\\begin{exercise}\\end{exercise}\\begin{task}\\end{task}\\begin{problem}\\end{problem}'), 2);
eq(X.builtinCounters({ questionEnvs: [], questionTitle: '(' })['Контр. запитань']('\\section{Контрольні запитання}\n' + list), 3, 'a broken regex falls back to the default');
eq(X.builtinCounters({ questionEnvs: [], questionTitle: 'тест' })['Контр. запитань']('\\section{Тест}\n' + list + '\\section{Контрольні запитання}\n' + list), 3, 'own title');

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

// 0.16.1: the control questions are the items of quizlist (stats.questionEnvs); the section title is the fallback of an empty list
const QL = '\\begin{quizlist}\n\\item a\n\\item b \\begin{enumerate}\\item x\\item y\\end{enumerate}\n\\item c\n\\end{quizlist}\n';
eq(X.countEnvItems(QL, ['quizlist']), 3, 'items of quizlist, nested ones are not counted');
eq(X.countEnvItems(QL + QL, ['quizlist']), 6, 'two environments');
eq(X.countEnvItems('\\begin{quizlist*}\\item a\\end{quizlist*}', ['quizlist']), 1, 'the star variant');
eq(X.countEnvItems('\\begin{quizlist}\\item a\\begin{quizlist}\\item inner\\end{quizlist}\\item b\\end{quizlist}', ['quizlist']), 2, 'quizlist inside quizlist: the outer one');
eq(X.countEnvItems(QL, ['exam']), 0, 'another environment');
eq(X.countEnvItems(QL, []), 0, 'no environments');
eq(X.countEnvItems('\\begin{quizlist}\\item a', ['quizlist']), 0, 'not closed');
eq(X.countEnvItems('\\begin{enumerate}\\item a\\end{enumerate}', ['quizlist']), 0, 'a plain list is not a quiz');
{
  const c = X.builtinCounters({})['Контр. запитань'];
  eq(c('\\section{Контрольні запитання}\n' + QL), 3, 'quizlist in the default: its items');
  eq(c('\\section{Контрольні запитання}\n' + list), 0, 'a plain list under the title is not counted now: the questions are in quizlist');
  eq(c('\\section{Теорія}\n' + QL), 3, 'quizlist anywhere, the title does not matter');
  eq(X.builtinCounters({ questionEnvs: ['exam', 'quizlist'] })['Контр. запитань']('\\begin{exam}\\item a\\end{exam}' + QL), 4, 'several environments');
  eq(X.builtinCounters({ questionEnvs: [] })['Контр. запитань']('\\section{Контрольні запитання}\n' + list), 3, 'empty list: the title again');
  const fq = X.fileStats('\\chapter{A}\n\\section{Теорія}\ntext\n\\section{Контрольні запитання}\n' + QL, {}, X.builtinCounters({}));
  eq(fq.total.extra['Контр. запитань'], 3, 'in the statistics of a file');
  eq(fq.rows.find((r) => r.title === 'Контрольні запитання').st.extra['Контр. запитань'], 3, 'and in its section');
}
// stats.exclude: files and folders that are not in the statistics
const E = X.excludedPath;
eq(E('Preface/Preface.tex', ['Preface']), true, 'a folder: everything inside');
eq(E('Book/Preface/x.tex', ['Preface']), true, 'a name without a slash: at any depth');
eq(E('Book/Preface/x.tex', ['/Preface']), false, 'a leading slash: from the root only');
eq(E('Preface/x.tex', ['/Preface', './x']), true);
eq(E('Preface.tex', ['Preface']), true, 'a file without .tex');
eq(E('Preface.tex', ['Preface.tex']), true, 'a file with .tex');
eq(E('Preface.tex', ['Preface/']), false, 'a closing slash: a folder only');
eq(E('Preface/x.tex', ['Preface/']), true);
eq(E('a/b/c.tex', ['a/b/c.tex']), true, 'a path from the root');
eq(E('x/a/b/c.tex', ['a/b/c.tex']), false, 'with a slash inside: from the root');
eq(E('a/b/c.tex', ['a/*/c.tex']), true, '*');
eq(E('a/b/d/c.tex', ['a/*/c.tex']), false, '* does not cross folders');
eq(E('a/b/d/c.tex', ['a/**/c.tex']), true, '**');
eq(E('x/y/test1.tex', ['test?']), true, '?');
eq(E('CHARGES/x.tex', ['charges']), true, 'the case does not matter');
eq(E('a\\b\\c.tex', ['a/b']), true, 'Windows separators');
eq(E('Ch/Ch.tex', ['Appendix', '']), false, 'nothing matches; an empty pattern is ignored');
eq(E('Ch/Ch.tex', ['(', '[']), false, 'a strange pattern does not break');
eq(E('Ch/Ch.tex', undefined), false, 'no patterns');
eq(E('', ['a']), false, 'no path');
eq(E('Ch/Ch.tex', ['Ch']), true, 'a chapter whose folder has the name of the file');
eq(E('Chapter2/Ch.tex', ['Ch']), true, 'the file Ch.tex without the extension');
eq(E('Chapter2/Chap.tex', ['Ch']), false, 'but not a longer name');

// **/ is zero or more folders, as in .gitignore (0.17.0): the root is a folder level too
eq(E('draft1.tex', ['**/draft*.tex']), true, '**/ also matches in the project root');
eq(E('a/b/draftX.tex', ['**/draft*.tex']), true, '**/ at any depth');
eq(E('a/mydraft.tex', ['**/draft*.tex']), false, 'the name itself still has to start with draft');
eq([E('a/b.tex', ['a/**/b.tex']), E('a/x/b.tex', ['a/**/b.tex']), E('a/x/y/b.tex', ['a/**/b.tex']), E('b.tex', ['a/**/b.tex'])], [true, true, true, false], 'a/**/b.tex: zero or more folders between');
eq([E('Ch/a.tex', ['Ch/**']), E('Ch/x/a.tex', ['Ch/**']), E('Other/a.tex', ['Ch/**'])], [true, true, false], 'Ch/** leaves out everything inside');
eq([E('Tests/t.tex', ['**/Tests/']), E('a/Tests/t.tex', ['**/Tests/'])], [true, true], '**/Tests/ at any depth, also in the root');
eq(E('draft1xtex', ['draft1.tex']), false, 'a dot in a pattern is a dot');

console.log('projectStats: ' + n + ' checks passed');
