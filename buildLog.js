'use strict';
/* buildLog.js: warnings from the build log, the texlogsieve report in a terminal tab. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const P = require('./corePure');
const { cfg } = require('./util');

/* ------------------------- build log warnings ------------------------ */
const diagLog = vscode.languages.createDiagnosticCollection('tssworkflow-log');

const outLog = vscode.window.createOutputChannel('TSS Workflow');
// the second argument (VS Code 1.63+) gives the channel the language `tssreport`, coloured by syntaxes/tssreport.tmLanguage.json
const tlsLog = vscode.window.createOutputChannel('texlogsieve', 'tssreport');
let pplatexWarned = false;

function setLogDiagnostics(folder, items) {
  // logWarnings = false: keep only errors, whatever the log parser is
  if (!cfg().get('logWarnings', true)) items = items.filter((x) => x.severity === vscode.DiagnosticSeverity.Error);
  const by = new Map();
  const seen = new Set();
  const absent = new Set();
  let shown = 0;
  for (const it of items) {
    const fp = path.resolve(folder, it.file);
    const l0 = it.line === null || it.line === undefined ? 0 : it.line;
    // errors may span several lines; warnings (Overfull ... in paragraph at lines 31--319) mark only the first line
    const l1 = it.severity !== vscode.DiagnosticSeverity.Error || it.endLine === null || it.endLine === undefined ? l0 : Math.max(l0, it.endLine);
    const hint = P.logHint(it.message);
    const text = hint && !it.message.includes(hint) ? it.message + '. ' + hint : it.message;
    const key = fp + ':' + l0 + ':' + text;
    if (seen.has(key)) continue;
    if (!fs.existsSync(fp)) { absent.add(it.file); continue; }
    seen.add(key);
    shown++;
    const d = new vscode.Diagnostic(new vscode.Range(l0, 0, l1, 1000), text, it.severity);
    d.source = it.source;
    if (!by.has(fp)) by.set(fp, []);
    by.get(fp).push(d);
  }
  for (const [fp, ds] of by) diagLog.set(vscode.Uri.file(fp), ds);
  outLog.appendLine('[Problems] показано ' + shown + ' у ' + by.size + ' файлах' +
    (absent.size ? '; пропущено, бо файла немає на диску: ' + [...absent].slice(0, 5).join(', ') : ''));
}

// builtin: our own log parser (Overfull, undefined references); pplatex: output of `pplatex -i job.log`
function builtinLog(folder, job) {
  let log;
  try { log = fs.readFileSync(path.join(folder, job + '.log'), 'utf8'); } catch (e) { outLog.appendLine('[builtin] немає ' + job + '.log'); return; }
  const items = P.parseLog(log, cfg().get('overfullThreshold', 5)).map((it) => ({
    file: it.file, line: it.line, message: it.message, severity: vscode.DiagnosticSeverity.Warning, source: 'LaTeX log'
  }));
  // errors are read from the log as well, not only from the terminal output of latexmk
  for (const it of P.parseLogErrors(log)) {
    items.push({ file: it.file, line: it.line, endLine: it.endLine, message: it.message, severity: vscode.DiagnosticSeverity.Error, source: 'LaTeX log' });
  }
  outLog.appendLine('[builtin] ' + job + '.log: ' + items.length + ' записів');
  setLogDiagnostics(folder, items);
}

function pplatexLog(folder, job) {
  return new Promise((resolve) => {
    const cmd = String(cfg().get('pplatexCommand', 'ppluatex') || 'ppluatex').trim();
    const logPath = path.join(folder, job + '.log');
    if (!fs.existsSync(logPath)) { outLog.appendLine('[pplatex] немає ' + logPath + ': нічого розбирати'); resolve(); return; }
    cp.execFile(cmd, ['-i', logPath], { cwd: folder, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err && (err.code === 'ENOENT' || !stdout)) {
        if (!pplatexWarned) {
          pplatexWarned = true;
          vscode.window.showWarningMessage('pplatex не запустився («' + cmd + '»: ' + (err.message || err) +
            '). Використовую вбудований розбір логу. Перевір PATH або tssworkflow.pplatexCommand.');
        }
        builtinLog(folder, job);
        resolve();
        return;
      }
      const bb = cfg().get('pplatexBadBoxes', 'information');
      const sevOf = {
        hint: vscode.DiagnosticSeverity.Hint,
        information: vscode.DiagnosticSeverity.Information,
        warning: vscode.DiagnosticSeverity.Warning
      };
      const items = [];
      for (const it of P.parsePplatex(stdout, cfg().get('overfullThreshold', 5))) {
        let severity;
        if (it.kind === 'Error') severity = vscode.DiagnosticSeverity.Error;
        else if (it.kind === 'Warning') severity = vscode.DiagnosticSeverity.Warning;
        else if (bb === 'off') continue;
        else severity = sevOf[bb] === undefined ? vscode.DiagnosticSeverity.Information : sevOf[bb];
        items.push({ file: it.file, line: it.line, endLine: it.endLine, message: it.message, severity, source: 'pplatex' });
      }
      setLogDiagnostics(folder, items);
      resolve();
    });
  });
}

let texlogsieveWarned = false;

function texlogsieveLog(folder, job) {
  return new Promise((resolve) => {
    const cmd = String(cfg().get('texlogsieveCommand', 'texlogsieve') || 'texlogsieve').trim();
    const logPath = path.join(folder, job + '.log');
    if (!fs.existsSync(logPath)) { outLog.appendLine('[texlogsieve] немає ' + logPath + ': нічого розбирати'); resolve(); return; }
    let args = cfg().get('texlogsieveArgs', ['${log}']);
    if (!Array.isArray(args)) args = ['${log}'];
    args = args.map((a) => String(a).replace(/\$\{log\}/g, logPath));
    if (!args.some((a) => a === logPath)) args.push(logPath);
    cp.execFile(cmd, args, { cwd: folder, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err && (err.code === 'ENOENT' || !stdout)) {
        if (!texlogsieveWarned) {
          texlogsieveWarned = true;
          vscode.window.showWarningMessage('texlogsieve не запустився («' + cmd + '»: ' + (err.message || err) +
            '). Використовую вбудований розбір логу. Перевір PATH або tssworkflow.texlogsieveCommand.');
        }
        builtinLog(folder, job);
        resolve();
        return;
      }
      const bb = cfg().get('pplatexBadBoxes', 'information');
      const sevOf = {
        hint: vscode.DiagnosticSeverity.Hint,
        information: vscode.DiagnosticSeverity.Information,
        warning: vscode.DiagnosticSeverity.Warning
      };
      const inside = (fp) => { const r = path.relative(folder, fp); return r && !r.startsWith('..') && !path.isAbsolute(r); };
      const items = [];
      const report = [];
      let outside = 0;
      const parsed = P.parseTexlogsieve(stdout, cfg().get('overfullThreshold', 5));
      try { P.attachMissingLines(parsed, fs.readFileSync(logPath, 'utf8')); } catch (e) { /* no log: the page number is enough */ }
      for (const it of parsed) {
        // warnings from packages in the TeX tree (biblatex, microtype ...) are noise: keep project files only.
        // Errors are never dropped, wherever they were reported.
        if (it.kind !== 'Error' && !inside(path.resolve(folder, it.file))) { outside++; continue; }
        let severity;
        if (it.kind === 'Error') severity = vscode.DiagnosticSeverity.Error;
        else if (it.kind === 'Warning' || it.kind === 'Missing') severity = vscode.DiagnosticSeverity.Warning;
        else if (bb === 'off') continue;
        else severity = sevOf[bb] === undefined ? vscode.DiagnosticSeverity.Information : sevOf[bb];
        items.push({ file: it.file, line: it.line, endLine: it.endLine, message: it.message, severity, source: 'texlogsieve' });
        report.push({ kind: it.kind, file: it.file, line: it.line, message: it.message });
      }
      if (!items.some((x) => x.severity === vscode.DiagnosticSeverity.Error)) {
        // texlogsieve gave no errors: take them from the log itself
        try {
          for (const it of P.parseLogErrors(fs.readFileSync(logPath, 'utf8'))) {
            items.push({ file: it.file, line: it.line, endLine: it.endLine, message: it.message, severity: vscode.DiagnosticSeverity.Error, source: 'LaTeX log' });
            report.push({ kind: 'Error', file: it.file, line: it.line, message: it.message });
          }
        } catch (e) { /* no log */ }
      }
      outLog.appendLine('[texlogsieve] ' + cmd + ' ' + args.join(' ') + ' -> розібрано ' + parsed.length + ', показано ' + items.length +
        (outside ? ', відкинуто попереджень поза проєктом: ' + outside : '') + (err ? ', код виходу ' + err.code : ''));
      if (!parsed.length) outLog.appendLine('--- початок виводу texlogsieve ---\n' + String(stdout).slice(0, 1500) + '\n---');
      setLogDiagnostics(folder, items);
      showReportInTerminal(stdout, items);
      showReportInOutput(folder, job, report, outside);
      resolve();
    });
  });
}

// the same problems as in Problems, grouped by kind, in their own Output channel (file:line is clickable)
function showReportInOutput(folder, job, report, outside) {
  const mode = cfg().get('texlogsieveOutput', 'always');
  if (mode === 'off') return;
  const rel = (fp) => {
    const abs = path.resolve(folder, fp);
    const r = path.relative(folder, abs);
    return (r && !r.startsWith('..') && !path.isAbsolute(r)) ? r.split(path.sep).join('/') : abs;
  };
  const entries = report.map((e) => ({ kind: e.kind, file: rel(e.file), line: e.line, message: e.message }));
  const time = new Date().toTimeString().slice(0, 8);
  const lines = P.formatTexlogsieveReport(entries, { job, time, outside });
  tlsLog.clear();
  tlsLog.appendLine(lines.join('\n'));
  if (mode === 'always' || entries.length) tlsLog.show(true);
}

/* ---------------- texlogsieve report in a terminal tab --------------- */
let tlsTerm; let tlsEmitter; let tlsReady = false; let tlsPending = '';

function tlsTerminal() {
  if (tlsTerm && tlsTerm.exitStatus === undefined) return tlsTerm;
  const emitter = new vscode.EventEmitter();
  tlsEmitter = emitter;
  tlsReady = false;
  const pty = {
    onDidWrite: emitter.event,
    open: () => { tlsReady = true; if (tlsPending) { emitter.fire(tlsPending); tlsPending = ''; } },
    close: () => { tlsTerm = undefined; tlsReady = false; }
  };
  tlsTerm = vscode.window.createTerminal({ name: 'texlogsieve', pty });
  return tlsTerm;
}

function tlsWrite(text, reset) {
  if (reset) tlsPending = '';
  const data = (reset ? '\x1b[2J\x1b[3J\x1b[H' : '') + text;
  if (tlsReady && tlsEmitter) tlsEmitter.fire(data); else tlsPending += data;
}

// light colouring: banners cyan, errors red, warnings and bad boxes yellow
function colorReport(text) {
  const RED = '\x1b[31m'; const YEL = '\x1b[33m'; const CYA = '\x1b[36m'; const BLD = '\x1b[1m'; const RST = '\x1b[0m';
  return text.split('\n').map((ln) => {
    if (/^From file /.test(ln) || /^=+\s+Summary:/.test(ln) || /^After last page:/.test(ln)) return BLD + CYA + ln + RST;
    if (/^pg (?:\d+|\?): ! /.test(ln)) return RED + ln + RST;
    if (/(?:Warning|Overfull|Underfull|Missing characters)/.test(ln)) return YEL + ln + RST;
    return ln;
  }).join('\n');
}

function showReportInTerminal(stdout, items) {
  const mode = cfg().get('texlogsieveTerminal', 'always');
  if (mode === 'off') return;
  const nErr = items.filter((x) => x.severity === vscode.DiagnosticSeverity.Error).length;
  const nWarn = items.filter((x) => x.severity === vscode.DiagnosticSeverity.Warning).length;
  const problems = nErr + nWarn > 0;
  if (mode === 'onProblems' && !problems && !(tlsTerm && tlsTerm.exitStatus === undefined)) return;
  const head = '\x1b[1m texlogsieve: ' + (nErr ? '\x1b[31m' + nErr + ' помилок' : '\x1b[32m0 помилок') +
    '\x1b[0m\x1b[1m, ' + nWarn + ' попереджень (у Problems)\x1b[0m\n\n';
  const body = String(stdout).replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').replace(/\s+$/, '');
  const text = (head + (body ? colorReport(body) : 'texlogsieve нічого не виводить.') + '\n').replace(/\n/g, '\r\n');
  const term = tlsTerminal();
  tlsWrite(text, true);
  if (mode === 'always' || problems) term.show(true);
}

function onBuildFinished(folder, job) {
  diagLog.clear();
  outLog.appendLine('--- збірка завершена, logParser = ' + cfg().get('logParser', 'builtin') + ' ---');
  if (cfg().get('logParser', 'builtin') === 'pplatex') return pplatexLog(folder, job);
  if (cfg().get('logParser', 'builtin') === 'texlogsieve') return texlogsieveLog(folder, job);
  if (!cfg().get('logWarnings', true)) return undefined;
  builtinLog(folder, job);
  return undefined;
}

module.exports = {
  diagLog,
  onBuildFinished,
  outLog,
};
