# 🔬 Claude Observatory

[![CI](https://github.com/cell-observatory/claude-observatory/actions/workflows/ci.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/ci.yml)
&nbsp;·&nbsp; **[🔬 Live showcase →](https://cell-observatory.github.io/claude-observatory/)**

**Per-edit Keep / Undo for [Claude Code](https://claude.com/claude-code).** Every file change Claude makes
becomes a reviewable entry with its own surgical undo — in your **terminal**, **VS Code**, and **JetBrains
IDEs** — at **zero extra Claude tokens**. Like Cursor's "keep/undo each change," but standalone, shareable,
and git-free.

![The observatory in VS Code: Edits/Diffs in the sidebar, inline review in the editor, Observations · Timeline · Stats in the bottom panel, and the microscope scoreboard in the status bar](docs/media/layout.png)

## Why use it?

Claude can change dozens of files in a turn. On code that matters, you don't want to skim a giant diff at
the end — you want to **stay in the loop on every edit** and decide, one at a time, what to keep.

- **Surgical review of AI edits** — accept, undo, or diff each change individually; undo one edit while
  keeping later edits to the same file.
- **Critical-infrastructure work** — keep a human in the loop when Claude touches code you can't afford to
  get wrong.
- **Any surface** — the same store is read/written by the CLI, the VS Code sidebar, and the JetBrains
  plugin, so terminal and editor stay in sync (great for remote/SSH/devcontainers where Claude runs on a host).
- **Shareable & auditable** — a git-free content-addressed log of what the agent did and what you decided,
  that you own and can hand to a teammate.

Complements Claude Code's native `/rewind` (whole-turn) with **per-edit** control, and costs **zero extra
tokens** — capture runs in local hooks, entirely outside the model loop.

## Quickstart

**1 — Install** the CLI + editor extensions from the latest [release](https://github.com/cell-observatory/claude-observatory/releases)
(no build toolchain, no accounts):

```bash
curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash
```

**2 — Wire the capture hooks** — with **Claude Code closed** (it snapshots hooks at session start):

```bash
claude-observatory init          # add --with-statusline for the 5h/week Usage bars
```

**3 — Launch Claude Code** and start working. Every edit is captured automatically; open the **🔬 Claude
Observatory** view in your editor (or run `claude-observatory list`) to review.

**Prefer to let Claude install it?** Paste this prompt into a Claude Code session:

```text
Please install Claude Observatory (github.com/cell-observatory/claude-observatory) for me:
run its installer with
  curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash
then run `claude-observatory doctor` and show me the output. Note: the capture hooks only
take effect on a fresh session — after installing, tell me to quit you, run
`claude-observatory init` in a plain terminal, and relaunch you.
```

> Verify anytime with `claude-observatory doctor`. Update by re-running the one-liner or `claude-observatory update`.
> Full install options (Windows, build-from-source, per-editor, teams) are in [Install](#install) below;
> remote/SSH/devcontainer setup is in **[docs/REMOTE.md](docs/REMOTE.md)**.

## The observatory

Built for **surgical Claude usage on critical infrastructure**: you see every change in realtime and accept
/ edit / revert each one, while Claude accelerates the work. Every surface below ships in **both editors**
(and most in the terminal too).

**Review surfaces** — the left sidebar / tool window (icon-only tabs, 🔬 microscope badged with the pending count):

| View | What you get |
| --- | --- |
| **Edits** | Pending edits grouped **folder → file → class**, each with inline Keep / Undo. Click to open the file at the edit. |
| **Diffs** | The same tree; click any edit for a **before ⟷ after** diff, with title-bar Prev / Next stepping the file's edits. |
| **File History** | A flat, chronological list of just the **active file's** edits that **follows the editor** as you switch tabs — jump to an edit, keep/undo it, diff it, or step revisions. |

![Diffs: one edit opened as its own before ⟷ after diff tab, in git's colors, with Keep / Undo / Prev / Next on the title bar](docs/media/diffs.png)

![File History: the active file's edits, newest first, following the editor — kept edits struck through](docs/media/file-history.png)

**Observatory dashboards** — the bottom panel, side by side like Terminal / Problems:

| View | What you get |
| --- | --- |
| **Observations** | A **session recap** on top (Claude Code's own title — zero token; ✨ to refine via `claude -p --resume`), then a per-edit row with Claude's actual reasoning. Each row carries the observatory's **memory of that file** — cross-session accept/revert history and prior analyses; files whose edits get reverted repeatedly are flagged. |
| **Timeline** | Files ordered by most-recent activity, each expanding to its edits (id + a small dimmed time + delta); adjacent same-file edits coalesce into a run. |
| **Stats** | A live **review scoreboard** (pending / accepted / reverted + a progress bar), a **tokens** step-line plot (total / input / output, log axis, Today / 7 days / 30 days), and live **Usage** bars — context fill plus 5h / week plan usage (from [claude-statusline](https://github.com/cell-observatory/claude-statusline)). |

<p>
  <img src="docs/media/observations.png" width="55%" alt="Observations: session recap, per-edit reasoning, and cross-session file memory with revert-risk flags">
  <img src="docs/media/stats.png" width="43.5%" alt="Stats: review scoreboard, tokens step-line trends with a Today/7d/30d toggle, plus live usage bars">
</p>

**Inline review, right in the editor.** A **✨ gutter star** at each pending edit, a subtle green tint on
added lines and a red tint (removed text shown as red ghost text) on deletions — toned down so a
heavily-edited file doesn't drown in color — plus a **Claude-coral marker** on the scrollbar. Above each
edit sits an **inline menu**: **✨ #N · +A −R · view changes**, then **✓ Keep · ↩ Undo · 💬 Chat · ⧉ View
diff**. Kept edits grey out; reverted edits stay struck through everywhere.

![Inline review: the ✨ gutter star, a subtle green/red line tint, the inline menu (✨ #N view changes · Keep · Undo · Chat · View diff), and the edit's before ⟷ after with the reasoning in the title](docs/media/inline-review.png)

In **VS Code**, "view changes" opens an **inline review bubble** right at the edit — the diff in git's own
colors plus Claude's reasoning, with **Accept · Revert · Chat · Prev · Next** on its toolbar. In
**JetBrains**, the ✨ lens opens the edit's before ⟷ after as a **unified diff** (Keep / Undo / Chat / View
diff on the lens; reasoning in the title).

**More, mirrored in both editors:**

- **File heatmap** — dim every unmodified line so Claude's edits stand out (a spotlight). Toggle with the
  📄 button.
- **Revision navigation** — step a file's edit history in a *current-vs-revision* diff with **⌥⌘[** / **⌥⌘]**
  or the buttons atop **File History**.
- **Per-file review** — **Accept all / Revert all in this file** from the Edits toolbar, the editor banner,
  and the File-History toolbar.
- **Toggle inline review** — hide/show the whole overlay with one button (👁).

<p>
  <img src="docs/media/heatmap.png" width="57%" alt="File heatmap: every unmodified line dimmed so the edit is a spotlight">
  <img src="docs/media/conflict.png" width="41%" alt="Surgical undo: a genuine overlap conflict is refused, with --force offered as an explicit per-file restore">
</p>

**Realtime awareness:** a **status-bar 🔬** shows the pending count the moment Claude writes (amber while
anything awaits review); its tooltip is the review scoreboard, click jumps to the next pending edit. The
whole loop runs from the keyboard: **⌥⌘N** to the oldest pending edit, **⌥⌘Y** keep at cursor, **⌥⌘U** undo
— jump, decide, repeat.

**Opt-in deeper analysis** (spends tokens, your choice): _Analyze_ an observation or _Refresh recap_ prefer
`claude -p --resume <session>` so Claude reuses the session's already-cached context — cheaper and better
grounded — falling back to a self-contained prompt if the session can't be resumed.

## Terminal usage

The `claude-observatory` CLI is a first-class front-end — review without leaving the shell:

![The terminal front-end: status, list --pending, diff, and a surgical undo that preserves later edits to the same file](docs/media/cli.png)

```text
claude-observatory status          # hooks + hook-path health + active session + counts
claude-observatory sessions        # list all sessions in the store (● = current dir)
claude-observatory list            # edits in the active session (grouped by file, ±lines, status)
claude-observatory list --pending  # filters: --pending | --kept | --undone, and --file <substr>
claude-observatory diff <id>       # colored before/after for one edit
claude-observatory keep <id>       # mark reviewed; no disk change
claude-observatory undo <id>       # surgically undo one edit
claude-observatory undo <id> --force   # per-file restore fallback (used on overlap conflicts)
claude-observatory redo <id>       # re-apply an undone edit (--force to override later edits)
claude-observatory clean           # GC orphaned blobs; --resolved | --drop <id> | --older-than 30d | --all
claude-observatory uninstall       # remove the capture hooks
claude-observatory --version
```

The active session is resolved from your workspace; override with `--session <id>` or `CLAUDE_OBSERVATORY_SESSION`.

## Install

The one-liner in [Quickstart](#quickstart) covers most people. The details:

**Update** any time by re-running the one-liner, or `claude-observatory update`.

**Platforms:** macOS and Linux work as-is. On **Windows**, the CLI, capture hooks, and both editor plugins
run natively (npm's `.cmd` shims are handled) — but the installer and the bundled status line are bash, so
run them from **Git Bash** (`jq` needed for the status line) or use WSL.

**Build from source (contributors):**

```bash
./install.sh                 # deps → build → CLI on PATH → extension → status line → offer `init`
```

Or step by step:

```bash
npm install                  # workspace deps
npm run build                # build core + cli
npm i -g ./packages/cli      # put `claude-observatory` on PATH  (or: npm link in packages/cli)
claude-observatory init --with-statusline   # capture hooks + the bundled status line (backs settings up first)
```

The [claude-statusline](https://github.com/cell-observatory/claude-statusline) status line is **bundled**
— `claude-observatory statusline` installs/refreshes it with no network (it powers the Usage bars). Refresh
the vendored copy with `scripts/sync-statusline.sh`.

> **Important — install hooks _before_ launching Claude Code.** Claude Code snapshots your hooks at session
> start, so hooks added to a **running** session get reverted. Run `claude-observatory init` with Claude
> Code closed, then launch it. Verify with `claude-observatory status`.

**VS Code extension** (optional):

```bash
npm run build:vscode
cd packages/vscode && npm run package     # -> claude-observatory.vsix
code --install-extension claude-observatory.vsix
```

Fully quit VS Code (⌘Q) once after installing so the activity-bar icon refreshes.

**JetBrains / PyCharm plugin** (optional; needs JDK 21 + Gradle to build — or grab the `.zip` from a
[Release](https://github.com/cell-observatory/claude-observatory/releases)):

```bash
./scripts/install-jetbrains.sh   # build + install into your local JetBrains IDEs, then restart the IDE
```

Or manually: **Settings → Plugins → ⚙ → Install Plugin from Disk…** with the built/downloaded zip. Works in
every JetBrains IDE (platform-only APIs — PyCharm CE/Pro, IntelliJ, WebStorm, …). Details:
[packages/jetbrains/README.md](packages/jetbrains/README.md).

**Teams:** run `claude-observatory init --project` to write the hook into the repo's `./.claude/settings.json`
(checked in). Teammates then only need `claude-observatory` on their PATH.

**Remote development (SSH & devcontainers):** the extension runs on the **remote host** (where Claude, the
transcripts, and the store live). Full setup — Remote-SSH, JetBrains Gateway/Toolbox, the devcontainer
template, and relocating `CLAUDE_CONFIG_DIR` — is in **[docs/REMOTE.md](docs/REMOTE.md)**.

## How it works

| Piece | What it does |
| --- | --- |
| **Capture hook** (`capture`) | PreToolUse snapshots the file before an edit, PostToolUse commits before + after. Zero-dep, always `exit 0`, never writes to the model context. Captures `Edit` / `Write` / `MultiEdit` / `NotebookEdit`. |
| **Store** | `~/.claude/claude-observatory/<session_id>/` — `log.jsonl` (append-only) + content-addressed `blobs/`. No network. |
| **Undo engine** | Position-anchored 3-way line merge (base = the file right after the edit; sides = current on-disk content and the pre-edit content). Later edits to other lines survive; a genuine overlap → clear conflict + per-file restore. Anchoring on line positions (not fuzzy text search) keeps it safe against duplicated content. |
| **Observations** | Correlates each edit with Claude's real reasoning + to-dos parsed from the session transcript — zero token. |
| **Front-ends** | The CLI (in-process), the VS Code sidebar (in-process `core`), and the JetBrains plugin (over the CLI + store) — all on the same store + engine. |

Architecture deep-dive: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Performance

Built to add **zero overhead** to your Claude sessions:

- **Capture** runs in local hooks entirely outside the model loop — zero tokens, zero-dependency hot path.
- **Every render is cache-backed** — the extension memoizes the edit log, transcript reasoning, and blob
  reads on each file's `(mtime, size)`; a cache hit costs one `stat()` instead of re-parsing a multi-MB
  transcript.
- **Heavy scans never touch the UI thread** — Stats aggregation runs in a `claude-observatory stats`
  subprocess with an incremental on-disk cache (first scan ~0.4 s, steady-state ~0.05 s).
- **Refreshes are debounced** — a burst of capture events produces one re-render.

## Packages

- `packages/core` — capture + store + surgical undo + transcript observations + shared installer (pure TS;
  only runtime dep is `diff`). No model calls.
- `packages/cli` — the `claude-observatory` bin: installer + terminal review UI + the machine-readable
  `--json` surface other front-ends build on. Bundles the [claude-statusline](https://github.com/cell-observatory/claude-statusline) installer.
- `packages/vscode` — the VS Code extension (depends on core; bundled with esbuild).
- `packages/jetbrains` — the PyCharm/JetBrains plugin (Kotlin; a front-end over the CLI + store — see its
  [README](packages/jetbrains/README.md)).

## Contributing

New features **ship in every front-end** — CLI, VS Code, and JetBrains — with shared logic in core/CLI.
Start here:

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — the practical "add a feature across all platforms" guide, with
  the file-by-file steps, the build/test cheat-sheet, and the cross-platform parity checklist.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit: core → CLI `--json` → both editors.
- **Have an idea?** Open a [feature request](https://github.com/cell-observatory/claude-observatory/issues/new?template=feature_request.yml).

```bash
npm test          # core unit tests + the extension smoke test
npm run e2e       # end-to-end CLI + capture-hook integration harness
npm run release   # build shareable artifacts into ./release (CLI .tgz + .vsix + JetBrains .zip)
```

To cut a release: `git tag v0.5.0 && git push origin v0.5.0` — CI re-runs the suites (npm + e2e + Gradle)
and attaches the CLI `.tgz`, the VS Code `.vsix`, and the JetBrains `.zip` to a
[GitHub Release](https://github.com/cell-observatory/claude-observatory/releases). See
[docs/DEMO.md](docs/DEMO.md) for a feature-by-feature walkthrough, or the
**[visual showcase](https://cell-observatory.github.io/claude-observatory/showcase.html)**.

## Notes

- Binary and >5 MB files are skipped. **Bash-driven file changes are tracked too** — a Bash command
  snapshots the candidate tree under its cwd before/after and records one edit per changed file (bounded:
  skips vendor/build dirs, caps the file count). Opt out with `CLAUDE_OBSERVATORY_NO_BASH=1`.
- New-file creates are captured (undo deletes the file). No-op edits are not logged.
- Everything is local: no network calls, no telemetry. Deep analysis only runs the `claude` CLI you already
  have, and only when you ask.
