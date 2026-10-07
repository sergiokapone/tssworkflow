# TeXstudio-style Workflow

A VS Code extension for large LaTeX projects (books, lecture notes) with many chapters, figures, and TikZ diagrams: standalone chapter or whole-document builds, navigation, checks, Ukrainian typography, and project-wide refactoring. Full documentation in Ukrainian: see `LaTeX-VSCode-setup.md` in the repository.

*Українською: розширення VS Code для великих LaTeX-проєктів — збірка розділу чи всього документа, навігація, перевірки, українська типографіка, рефакторинг по проєкту.*

## Features

**Build.** `F5`: compile the current file (a chapter or a figure) standalone and open the PDF; `Shift+F5`: the whole document. Compile on save, stop, clean auxiliary files, SyncTeX in an external viewer, a "Chapters" panel with per-chapter builds or selected `\part`s.

**Navigation.** Clickable file names in `\input`, `\includegraphics`, `\localinput`; go to macros defined in `.cls`/`.sty`; go to any heading in the whole project; outline and panels in the Activity Bar.

**Labels, references, bibliography.** Project-wide label completion and rename, duplicate and undefined label checks, equations nobody refers to, completion and hover for `\cite{…}` from `.bib` files (author, year, title), add an entry from a DOI.

**Text and formulas.** Ukrainian typography (non-breaking spaces, dashes, «guillemets»), table alignment, `Format tblr` for `tblr`/`longtblr`/`talltblr` (options one per line, cells in a grid), `Renumber Beamer Slides`, column operations, normalize a file or the whole project, frames around headings and formulas, formula environment conversion, Unicode → LaTeX.

**Refactoring.** Rename and reorder chapters with updates to lists, paths, and references; project-wide replace that skips comments and `verbatim`; notation consistency checks (`\varepsilon`/`\epsilon`, etc.); project snapshots with restore.

**New in 0.7.** A configurable table *macro → folder* (`tssworkflow.fileMacros`) for `\\input`/`\\include`/`\\subfile`/`\\localinput`; a root-relative check for `\\input` in chapters; references updated when a file is renamed; Quick Fix `tlmgr install` for missing packages; the "Labels" panel (unused labels, insert `\\ref`); unused `\\usepackage`; table from CSV/XLSX/clipboard in `tblr`; `.bib` format, duplicates and key normalisation; list of equations; word count; PDF copy with a date; **Doctor** with hints.

**Other.** Document and fragment templates, extracting `tikzpicture` into separate files, project statistics, a TODO list, chapter changes against a git revision (`latexdiff`), a "Problems" panel from the build log, environment check.

## Requirements

- TeX Live (or MiKTeX) with `latexmk`; LuaLaTeX for Cyrillic templates.
- Optional: `texlogsieve` for the problem report, `latexdiff`, `git`, SumatraPDF (Windows) for the external viewer. The **Check environment** command shows what is found and what is missing.
- VS Code 1.60 or newer (the Problems panel badge counter: 1.72+).

## Important: which conventions are assumed

Some features assume the author's project layout: chapters in `X/X.tex` folders with `Pictures/` and `tikz/` inside, the main file including chapters via the `\includechapter{X}` and `\multiinclude{A, B}` macros, and chapters using `\localinput` and `\currfilebase`. Macro names and the main file are configurable (`tssworkflow.mainFile`, `tssworkflow.chapterIncludeMacro`, `tssworkflow.chapterListMacros`). The remaining features (typography, tables, labels, `\cite`, checks) do not depend on this.

## Getting started

1. Open your project folder. If it has no `.tex` files yet, click **New from template** or **Create project settings** in the extension panel.
2. The **Create project settings** command creates `.vscode/settings.json` with the main file and the required parameters.
3. All commands: the Command Palette (`Ctrl+Shift+P`), the `TSS Workflow` prefix, or the extension panel in the Activity Bar. Settings: `Settings → tssworkflow`.

## Privacy

The extension does not collect or send any data. The only network request: the **Add BibTeX entry from DOI** command contacts `doi.org` with the DOI you enter.

## Safety of changes

Commands that modify many files (chapter rename, project-wide replace, project normalize, notation unification) take a snapshot of the project sources in the extension storage before running; it can be restored with the **Restore snapshot** command. This complements git, not replaces it.

## Known limitations

Chapter names for the rename command: Latin letters, digits, `_`, `-` only. Batch commands should first be tried on a copy of a large project.
