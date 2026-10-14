'use strict';
/* lwGuardPure.js: is LaTeX Workshop (or any other tool: a latexmk in a terminal) building the same document right now?
 * No VS Code API. LaTeX Workshop does not tell other extensions that it is compiling (its API is not exported outside its own
 * tests), so the answer comes from the list of processes: its recipes start `latexmk ... "<abs path of the root file>"` /
 * `pdflatex ... "<abs path>"` with the absolute path of the document, and that path is what is matched against the job of the
 * build that is about to start (<cwd>/<job>: the files that both builds would write: .aux, .log, .pdf, .synctex.gz).
 * Children of latexmk (the engine run by it) get a relative file name and are not matched: the parent process lives as long as
 * the whole build, so it is enough. A command line that cannot be attributed to a project is never a reason to block. */

// the programs of a TeX build; everything else in the list is ignored (editors, shells, the listing command itself)
const TEX_PROGRAMS = new Set([
  'latexmk', 'pdflatex', 'lualatex', 'xelatex', 'latex', 'platex', 'uplatex', 'pdftex', 'luatex', 'luahbtex', 'xetex', 'tectonic',
  'biber', 'bibtex', 'bibtex8', 'bibtexu', 'makeindex', 'makeglossaries', 'xindy', 'texindy', 'dvipdfmx', 'dvips'
]);
// latexmk is a perl script: `perl /usr/bin/latexmk ...` (also behind sh / env wrappers)
const WRAPPERS = new Set(['perl', 'sh', 'bash', 'dash', 'zsh', 'env', 'runscript', 'texlua', 'texlua.exe']);

const isWin = (platform) => platform === 'win32';
// the same file system comparison on both sides: slashes, no trailing slash, lower case where paths are case-insensitive
function normPath(p, platform) {
  let s = String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
  if (isWin(platform) || platform === 'darwin') s = s.toLowerCase();
  return s;
}

// `ps -eo pid=,command=` -> [{ pid, args }]
function parsePs(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ pid: +m[1], args: m[2] });
  }
  return out;
}

// Get-CimInstance ... | ConvertTo-Json: nothing, one object or an array; CommandLine may be null (a process we may not read)
function parseCim(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  let j;
  try { j = JSON.parse(s); } catch (e) { return null; }
  const list = Array.isArray(j) ? j : [j];
  return list.filter((x) => x && typeof x === 'object').map((x) => ({ pid: Number(x.ProcessId) || 0, args: String(x.CommandLine || ''), name: String(x.Name || '') }));
}

// the program of a command line: the first token (quoted or not), without path and extension; behind perl / sh / env the next one
function programOf(args) {
  const toks = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while (toks.length < 4 && (m = re.exec(String(args || ''))) !== null) toks.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  const base = (t) => String(t || '').replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|pl|bat|cmd)$/, '');
  for (let i = 0; i < toks.length; i++) {
    const b = base(toks[i]);
    if (WRAPPERS.has(b) || b.startsWith('-') || b.includes('=')) continue; // `env FOO=1 latexmk`, `perl -w latexmk`
    return b;
  }
  return '';
}

const BOUND = '(?=$|[\\s"\'.])'; // after <dir>/<job> comes the end, a space, a quote or an extension (.tex, .pdf), not another letter

/* procs: [{ pid, args }]; want: { cwd, job, folder, scope: 'job' | 'project', platform, selfPids }
 * -> [{ pid, program, args }] the builds of the same document (scope 'job') or of any file under `folder` (scope 'project') */
function findBusy(procs, want) {
  const platform = want.platform || process.platform;
  const dir = normPath(want.cwd || want.folder, platform);
  const folder = normPath(want.folder || want.cwd, platform);
  const job = normPath(want.job, platform);
  const self = new Set(want.selfPids || []);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const jobRe = dir && job ? new RegExp(esc(dir + '/' + job) + BOUND) : null;
  const folderRe = folder ? new RegExp(esc(folder) + '(?=/|$|[\\s"\'])') : null;
  const found = [];
  for (const p of procs || []) {
    if (!p || self.has(p.pid)) continue;
    const program = programOf(p.args);
    if (!TEX_PROGRAMS.has(program)) continue;
    const line = normPath(p.args, platform);
    const hit = want.scope === 'project' ? !!folderRe && folderRe.test(line) : !!jobRe && jobRe.test(line);
    if (hit) found.push({ pid: p.pid, program, args: p.args });
  }
  return found;
}

// what to say: which program builds what
function describe(busy, job) {
  const names = [...new Set(busy.map((b) => b.program))].join(', ');
  return 'зараз збирає «' + job + '» (' + names + (busy.length === 1 ? ', PID ' + busy[0].pid : ', процесів: ' + busy.length) + ')';
}

// the command that lists the processes: [program, args] (the output goes to parsePs / parseCim)
function listCommand(platform) {
  if (isWin(platform)) {
    // WQL in a single-quoted PowerShell string (quotes doubled): no double quotes, so nothing to escape on the way through the command line
    const filter = "Name like ''%tex%'' or Name like ''latexmk%'' or Name like ''biber%'' or Name like ''bibtex%'' or Name like ''makeindex%'' or Name like ''xindy%'' or Name like ''tectonic%'' or Name like ''dvi%''";
    const script = "Get-CimInstance Win32_Process -Filter '" + filter + "' | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], parse: parseCim };
  }
  return { cmd: 'ps', args: [platform === 'darwin' ? '-axo' : '-eo', 'pid=,command='], parse: parsePs };
}

module.exports = { TEX_PROGRAMS, normPath, parsePs, parseCim, programOf, findBusy, describe, listCommand };
