'use strict';
/* checksHovers.js: quick error checks, hovers, the heading navigator. */
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const P = require('./corePure');
const X = require('./projectInfoPure');
const { PIC_EXTS, baseOf, cfg, docLines, info, isTexDoc, texFiles, textOf } = require('./util');
const { buildIndex } = require('./labels');

/* --------------------------- quick error checks ---------------------- */
const X5sub = (m, d) => { try { return require('./filesAndLabels').legacySub(m, d); } catch (e) { return d; } };
const diagSyntax = vscode.languages.createDiagnosticCollection('tssworkflow');

function existsFor(doc) {
  const dir = path.dirname(doc.uri.fsPath);
  if (path.basename(dir).toLowerCase() === 'tikz') return undefined; // paths inside tikz files are not resolved here
  return (kind, name) => {
    if (kind === 'tikz') {
      const b = path.join(dir, X5sub('\\localinput', 'tikz'), name);
      return fs.existsSync(b) || (!path.extname(name) && (fs.existsSync(b + '.tikz') || fs.existsSync(b + '.tex')));
    }
    const b = path.join(dir, X5sub('\\includegraphics', 'Pictures'), name);
    if (fs.existsSync(b)) return true;
    return !path.extname(name) && PIC_EXTS.some((e) => fs.existsSync(b + e));
  };
}

const SEV = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
  hint: vscode.DiagnosticSeverity.Hint
};

function checkSyntax(doc) {
  if (!isTexDoc(doc) || !cfg().get('diagnostics', true)) { diagSyntax.delete(doc.uri); return; }
  const lines = docLines(doc);
  const issues = P.syntaxChecks(lines, existsFor(doc));
  // figure without \caption / \label, and the user's own rules (tssworkflow.lintRules)
  const figSev = cfg().get('figureChecks', 'information');
  if (SEV[figSev] !== undefined) P.figureChecks(lines).forEach((x) => issues.push(Object.assign({ severity: figSev }, x)));
  issues.push(...P.lintRules(lines, cfg().get('lintRules', []), doc.uri.fsPath));
  const typoSev = cfg().get('typographyChecks', 'hint');
  if (SEV[typoSev] !== undefined) {
    X.typographyChecks(lines, { mixedMacros: cfg().get('mixedMacros', [['vec', 'vect']]) })
      .forEach((x) => issues.push(Object.assign({ severity: typoSev }, x)));
  }
  diagSyntax.set(
    doc.uri,
    issues.map((x) => {
      const d = new vscode.Diagnostic(
        new vscode.Range(x.line, x.col, x.line, x.col + x.len),
        x.message,
        SEV[x.severity] !== undefined ? SEV[x.severity] : vscode.DiagnosticSeverity.Warning
      );
      d.source = 'TSS Workflow';
      d.code = x.code;
      return d;
    })
  );
}

/* --------------------------------- hovers ---------------------------- */
function labelPreviewMd(file, l, aux) {
  const lines = textOf(vscode.Uri.file(file)).split(/\r?\n/);
  const md = new vscode.MarkdownString();
  md.appendMarkdown('**' + l.name + '**' + (aux ? '  ·  № ' + aux.num + (aux.page ? ', стор. ' + aux.page : '') : '') + '  \n' + path.basename(file) + ':' + (l.line + 1) + '\n\n');
  let body = null;
  if (l.envLine >= 0 && lines[l.envLine]) {
    const m = /\\begin\{([^{}]*)\}/.exec(lines[l.envLine]);
    if (m) {
      const end = P.envEnd(lines, m[1], l.envLine, m.index + m[0].length);
      if (end) {
        const block = lines.slice(l.envLine, end.line + 1);
        if (P.MATH_ENVS.has(m[1])) body = block.slice(0, 14);
        else {
          const ci = block.findIndex((x) => /\\caption/.test(x));
          body = ci >= 0 ? block.slice(ci, ci + 3) : block.slice(0, 4);
        }
      }
    }
  }
  if (!body) body = [l.ctx || ''];
  md.appendCodeblock(body.join('\n'), 'latex');
  return md;
}

const IMG_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

function argAt(code, re, col) {
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(code)) !== null) {
    const start = m.index + m[0].lastIndexOf('{') + 1;
    const len = m[1].length;
    if (col >= start && col <= start + len) return { name: m[1].trim(), start, len };
  }
  return null;
}

// hover on \includegraphics: name, size, a thumbnail (tssworkflow.imagePreviewMode / imagePreviewMaxMB) and a link that opens the file
function imageHoverMd(file) {
  const cfg = vscode.workspace.getConfiguration('tssworkflow');
  const ext = path.extname(file).toLowerCase();
  const size = fs.statSync(file).size;
  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: ['vscode.open'] };
  md.appendMarkdown('**' + path.basename(file) + '**  ·  ' + P.formatFileSize(size) + '\n\n');
  const cmdArgs = encodeURIComponent(JSON.stringify([vscode.Uri.file(file)]));
  const open = '[Відкрити зображення](command:vscode.open?' + cmdArgs + ')';
  if (!IMG_MIME[ext]) {
    md.appendMarkdown('Попередній перегляд для ' + ext + ' недоступний.  \n[Відкрити файл](command:vscode.open?' + cmdArgs + ')');
    return md;
  }
  const plan = P.imagePreviewPlan(size, cfg.get('imagePreviewMode', 'file'), cfg.get('imagePreviewMaxMB', 1));
  if (plan.kind === 'file') {
    md.appendMarkdown('![](' + vscode.Uri.file(file).toString() + ')\n\n' + open);
  } else if (plan.kind === 'data') {
    md.appendMarkdown('![](data:' + IMG_MIME[ext] + ';base64,' + fs.readFileSync(file).toString('base64') + ')\n\n' + open);
  } else if (plan.kind === 'too-big') {
    md.appendMarkdown('Завеликий для превʼю: ' + P.formatFileSize(size) + ', ліміт ' + String(plan.limitMB).replace('.', ',') + ' МБ (`tssworkflow.imagePreviewMaxMB`).  \n' + open);
  } else if (plan.kind === 'data-too-big') {
    md.appendMarkdown('У режимі `data` показуються лише файли до ' + P.formatFileSize(P.DATA_URI_MAX) + '. Постав `tssworkflow.imagePreviewMode` = `file`.  \n' + open);
  } else {
    md.appendMarkdown(open);
  }
  return md;
}

const hoverProvider = {
  async provideHover(doc, pos) {
    const line = doc.lineAt(pos.line).text;
    const base = baseOf(doc.uri.fsPath);
    const ref = P.scanLabelsAndRefs(line, base).refs.find((r) => pos.character >= r.col && pos.character <= r.col + r.len);
    if (ref) {
      let found = P.scanLabelsAndRefs(doc.getText(), base).labels.find((l) => l.name === ref.name);
      let file = doc.uri.fsPath;
      if (!found) {
        const idx = await buildIndex(false);
        for (const [fp, data] of idx) {
          const l = data.labels.find((x) => x.name === ref.name);
          if (l) { found = l; file = fp; break; }
        }
      }
      const range = new vscode.Range(pos.line, ref.col, pos.line, ref.col + ref.len);
      if (!found) return new vscode.Hover('Мітку «' + ref.name + '» не знайдено в проєкті', range);
      return new vscode.Hover(labelPreviewMd(file, found, require('./projectInfo').auxInfo(doc.uri, ref.name)), range);
    }
    const code = P.codePart(line);
    const dir = path.dirname(doc.uri.fsPath);
    const inc = argAt(code, /\\includegraphics(?:\[[^\]]*\])?\{([^}]*)\}/g, pos.character);
    if (inc && inc.name) {
      const b = path.join(dir, X5sub('\\includegraphics', 'Pictures'), inc.name);
      const file = [b].concat(PIC_EXTS.map((e) => b + e)).find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
      const range = new vscode.Range(pos.line, inc.start, pos.line, inc.start + inc.len);
      if (!file) return new vscode.Hover('Файл не знайдено: Pictures/' + inc.name, range);
      return new vscode.Hover(imageHoverMd(file), range);
    }
    const lin = argAt(code, /\\localinput\{([^}]*)\}/g, pos.character);
    if (lin && lin.name) {
      const b = path.join(dir, X5sub('\\localinput', 'tikz'), lin.name);
      const file = [b, b + '.tikz', b + '.tex'].find((c) => { try { return fs.statSync(c).isFile(); } catch (e) { return false; } });
      const range = new vscode.Range(pos.line, lin.start, pos.line, lin.start + lin.len);
      if (!file) return new vscode.Hover('Файл не знайдено: tikz/' + lin.name, range);
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      const md = new vscode.MarkdownString();
      md.appendMarkdown('**' + path.basename(file) + '**  (' + lines.length + ' рядків)\n\n');
      md.appendCodeblock(lines.slice(0, 15).join('\n') + (lines.length > 15 ? '\n...' : ''), 'latex');
      return new vscode.Hover(md, range);
    }
    return undefined;
  }
};

/* -------------------------- heading navigator ------------------------ */
async function goToHeading() {
  const ed = vscode.window.activeTextEditor;
  const folder = (ed && vscode.workspace.getWorkspaceFolder(ed.document.uri)) || (vscode.workspace.workspaceFolders || [])[0];
  if (!folder) { info('Відкрий папку проєкту.'); return; }
  const root = folder.uri.fsPath;
  const items = [];
  const seen = new Set();
  const walk = (fp) => {
    if (seen.has(fp) || !fs.existsSync(fp)) return;
    seen.add(fp);
    const lines = textOf(vscode.Uri.file(fp)).split(/\r?\n/);
    const events = P.scanHeadings(lines).map((h) => ({ line: h.line, h }));
    lines.forEach((l, i) => {
      const m = /^\s*\\includechapter\{([^}]*)\}/.exec(P.codePart(l));
      if (m) events.push({ line: i, inc: m[1].trim() });
    });
    events.sort((a, b) => a.line - b.line);
    for (const ev of events) {
      if (ev.h) items.push({ file: fp, h: ev.h });
      else walk(path.join(root, ev.inc, ev.inc + '.tex'));
    }
  };
  walk(path.join(root, (cfg().get('jobname', 'main') || 'main') + '.tex'));
  const rest = (await texFiles()).map((u) => u.fsPath).filter((p) => !seen.has(p) && p.startsWith(root)).sort();
  for (const fp of rest) walk(fp);
  if (!items.length) { info('Заголовків не знайдено.'); return; }
  const picks = items.map((it) => ({
    label: '\u00a0\u00a0'.repeat(Math.max(0, it.h.level - 1)) + it.h.title,
    description: it.h.kind + (it.h.star ? '*' : '') + ' · ' + path.relative(root, it.file).replace(/\\/g, '/') + ':' + (it.h.line + 1),
    it
  }));
  const pick = await vscode.window.showQuickPick(picks, { matchOnDescription: true, placeHolder: 'Перейти до заголовка (весь проєкт)' });
  if (!pick) return;
  const pos = new vscode.Position(pick.it.h.line, 0);
  await vscode.window.showTextDocument(vscode.Uri.file(pick.it.file), { selection: new vscode.Range(pos, pos) });
}

module.exports = {
  SEV,
  checkSyntax,
  diagSyntax,
  goToHeading,
  hoverProvider,
  imageHoverMd,
};
