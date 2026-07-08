# Claude Observatory

[![CI](https://github.com/cell-observatory/claude-observatory/actions/workflows/ci.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/ci.yml)

Per-edit **Keep / Undo** for [Claude Code](https://claude.com/claude-code) — a running log of every file change Claude makes, each with its own surgical undo. Like the Cursor "keep/undo each change" experience, but:

- **Standalone & shareable** — a small package you own and hand to teammates.
- **Git-free** — snapshots each edit to a local content-addressed store (the same trick Cursor uses).
- **Cross-surface** — works whether Claude Code runs in the **terminal**, **VS Code**, or a **JetBrains IDE** (PyCharm, IntelliJ, …); the CLI and both editor sidebars read/write the same store and stay in sync.
- **Surgical undo** — revert one edit while keeping later edits to the same file.
- **Live dashboards** — a **Timeline** change feed (edits coalesced per file, with Claude's own change summaries) and **Stats** trends (edits + tokens over Today / 7 days / 30 days) with live plan-usage bars, right in the editor's bottom panel.
- **Zero extra Claude tokens** — capture runs in local hooks, entirely outside the model loop.

Complements Claude Code's native `/rewind` (whole-turn) with per-edit control.

![The observatory in VS Code: Edits/Diffs in the sidebar, inline review in the editor, Observations · Timeline · Stats in the bottom panel, and the telescope scoreboard in the status bar](docs/media/layout.png)

![The same observatory in PyCharm: the Claude Observatory tool window, the inline lens + hover card with Claude's reasoning, and the Dashboards window (Observations | Timeline | Stats) at the bottom](docs/media/pyc-layout.png)

## Install

```bash
./install.sh                 # deps → build → CLI on PATH → extension → status line → offer `init`
```

Or by hand:

```bash
npm install                  # workspace deps
npm run build                # build core + cli
npm i -g ./packages/cli      # put `claude-observatory` on PATH  (or: npm link in packages/cli)
claude-observatory init --with-statusline   # capture hooks + the bundled status line (backs settings up first)
```

The [claude-statusline](https://github.com/cell-observatory/claude-statusline) status line is
**bundled with the CLI** — `claude-observatory statusline` installs/refreshes it with no network
and no second repo (it powers the sidebar's 5h/week Usage bars). The upstream repo remains the
standalone home for people who want just the status line. Refresh the vendored copy with
`scripts/sync-statusline.sh`.

> **Important — install hooks _before_ launching Claude Code.** Claude Code snapshots your hooks at
> session start and reconciles `~/.claude/settings.json` from that snapshot, so hooks added to a
> **running** session get reverted and don't take effect. Run `claude-observatory init` from a terminal
> with Claude Code closed, then launch it — every session after that captures automatically. Verify
> anytime with `claude-observatory status` (it reports whether the hook is installed and its path is valid).

To share with a team, run `claude-observatory init --project` to write the hook into the repo's
`./.claude/settings.json` (checked in). Teammates then only need `claude-observatory` on their PATH.

**VS Code sidebar** (optional):

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

Or manually: **Settings → Plugins → ⚙ → Install Plugin from Disk…** with the built/downloaded zip
(under JetBrains Remote Development, install on the **host**: Settings → Plugins (Host)). The plugin
drives the same `claude-observatory` CLI and store as the CLI/VS Code front-ends, so all three stay
in sync, and it works in every JetBrains IDE (platform-only APIs — PyCharm CE/Pro, IntelliJ,
WebStorm, …). Details: [packages/jetbrains/README.md](packages/jetbrains/README.md).

## Remote development (SSH & devcontainers)

The extension is declared `extensionKind: workspace`, so on **Remote-SSH, devcontainers, and WSL it
runs on the remote host** — because that's where Claude Code, your transcripts, the edit store, and
the statusline usage cache live. Everything therefore installs **on the remote**, not your laptop.

**Over SSH (no container):**

1. Connect the Remote-SSH window to the host.
2. In the **remote** terminal, install the CLI + hooks: clone and run `./install.sh` (or copy a
   release `.tgz` and `npm i -g ./claude-observatory-<ver>.tgz`), then run `claude-observatory init`
   with Claude Code closed.
3. Install the status line **on the remote** so the Usage bars populate — it's bundled with the
   CLI: `claude-observatory statusline` in the remote terminal (no network needed).
4. Install the extension **into the remote**: Extensions view → the `.vsix` → **"Install in SSH:
   \<host\>"**, or run `code --install-extension claude-observatory.vsix` in the remote terminal
   (VS Code puts `code` on the remote PATH there).

**Inside a devcontainer:** copy the ready-to-use template in
[docs/devcontainer/](docs/devcontainer/) into your `.devcontainer/`. It sets `TZ` (so Stats bucket
correctly), points `CLAUDE_CONFIG_DIR` at a **persistent volume** (so Edits/Stats survive rebuilds),
and provisions the CLI + status line + hooks via `postCreateCommand`.

**Relocating the config dir.** Everything the observatory reads/writes lives under
`CLAUDE_CONFIG_DIR` (default `~/.claude`) — the edit store, transcripts, capture hooks, and the
statusline cache all follow it. Point it at a mounted volume to persist history across container
rebuilds; just set the **same** value for Claude Code, the status line, and the extension host (a
container-level env var covers all three).

**Two gotchas:**

- The `claude-observatory` CLI (Stats) and `claude` (opt-in Analyze) must be on the **remote** PATH.
  The Stats tab shows an install hint if the CLI is missing, and the Usage bars show one if the
  status line isn't writing on that host.
- Set `TZ` on the remote, or the Stats plots bucket by the remote's timezone (usually UTC in a
  container) instead of yours.

## The observatory

Built for **surgical Claude usage on critical infrastructure**: the developer stays in the loop, seeing every change in realtime and accepting / editing / reverting each one — while Claude accelerates the work.

**Review surfaces** (activity bar, telescope icon badged with the pending count):

| View | What you get |
| --- | --- |
| **Edits** | Pending edits grouped **folder → file → class**, each with inline Keep / Undo. Click to open the file at the edit. |
| **Diffs** | The same tree; click any edit for a before ⟷ after diff. |

**Observatory dashboards** (bottom panel, side by side — like Terminal/Problems):

| View | What you get |
| --- | --- |
| **Observations** | A **session recap** on top (Claude Code's own title — zero token; ✨ to refine via `claude -p --resume`), then a per-edit row with Claude's actual reasoning (click for a combined report). Each row also carries the observatory's **memory of that file** — its cross-session accept/revert history and prior Claude analyses; files whose edits get reverted repeatedly are flagged for careful review. |
| **Timeline** | Files ordered by most-recent activity, each expanding to its edits (id + a small dimmed time + delta); status by icon. |
| **Stats** | Step-line plots with a **Today / 7 days / 30 days** toggle (Today hourly): **edits** split into pending / accepted / reverted, **tokens** into total / input / output (linear y-axis for edits, log for tokens). Below them: the live **Usage** bars — context fill plus 5h / week plan usage with `~token` estimates (from [claude-statusline](https://github.com/cell-observatory/claude-statusline)). |

**Realtime awareness:** a **status-bar telescope** shows the pending-edit count the moment Claude writes (amber while anything awaits review); its tooltip is the **review scoreboard** (pending · accepted · reverted · acceptance rate · oldest pending). The whole review loop runs from the keyboard: **⌥⌘N** (`ctrl+alt+n`) jumps to the oldest pending edit, **⌥⌘Y** keeps the edit under the cursor, **⌥⌘U** undoes it — jump, decide, repeat.

Plus an **inline overlay** in the editor: clickable **Keep / Undo / Diff** above each pending edit, a gutter change-bar on its lines, and a `✨ #N` marker with a Chat action on hover. Kept edits grey out; reverted edits stay struck through across every view. View-title buttons do **Accept all**, **Revert all**, and **Clear resolved**.

![Inline review: CodeLens Keep/Undo/Diff above the edit, highlighted lines, and the hover card with Claude's reasoning](docs/media/inline-review.png)

<p>
  <img src="docs/media/observations.png" width="55%" alt="Observations: session recap, per-edit reasoning, and cross-session file memory with revert-risk flags">
  <img src="docs/media/stats.png" width="43.5%" alt="Stats: edits and tokens step-line trends with a Today/7d/30d toggle, plus live usage bars">
</p>

**Opt-in, deeper analysis** (spends tokens, your choice): _Analyze_ on any observation and _Refresh recap_ both prefer `claude -p --resume <session>` so Claude reuses the session's **already-cached context** instead of re-sending code — cheaper and better grounded — falling back to a self-contained prompt if the session can't be resumed.

## Terminal usage

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

## How it works

| Piece | What it does |
| --- | --- |
| **Capture hook** (`capture`) | PreToolUse snapshots the file before an edit, PostToolUse commits before + after. Zero-dep, always `exit 0`, never writes to the model context. Captures `Edit` / `Write` / `MultiEdit` / `NotebookEdit`. |
| **Store** | `~/.claude/claude-observatory/<session_id>/` — `log.jsonl` (append-only) + content-addressed `blobs/`. No network. |
| **Undo engine** | Position-anchored 3-way line merge (base = the file right after the edit; sides = current on-disk content and the pre-edit content). Later edits to other lines survive; a genuine overlap → clear conflict + per-file restore. Anchoring on line positions (not fuzzy text search) keeps it safe against duplicated content. |
| **Observations** | Correlates each edit with Claude's real reasoning + to-dos parsed from the session transcript — zero token. |
| **Front-ends** | The `claude-observatory` CLI and the VS Code sidebar, both over the same store + engine. |

## Performance

Built to add **zero overhead** to your Claude sessions:

- **Capture** runs in local hooks entirely outside the model loop — zero tokens, zero-dependency hot path, always `exit 0`.
- **Every render is cache-backed.** The extension memoizes the edit log, transcript reasoning, and blob reads on each source file's `(mtime, size)` — a cache hit costs one `stat()` instead of re-parsing a multi-MB transcript (~40 ms) per tree node. Inline decorations, CodeLens, and hovers share one placement computation per document version.
- **Heavy scans never touch the UI thread.** Stats aggregation (potentially GBs of transcripts) runs in a `claude-observatory stats` subprocess with an incremental on-disk cache — only changed files are re-parsed (first scan ~0.4 s, steady-state ~0.05 s).
- **Refreshes are debounced** — a burst of capture events produces one re-render.

## Packages

- `packages/core` — capture + store + surgical undo + transcript observations + shared installer (pure TS; only runtime dep is `diff`). No model calls.
- `packages/cli` — the `claude-observatory` bin: installer + terminal review UI + the machine-readable `--json` surface other front-ends build on. Bundles the [claude-statusline](https://github.com/cell-observatory/claude-statusline) installer (`claude-observatory statusline`).
- `packages/vscode` — the VS Code extension (depends on core; bundled with esbuild).
- `packages/jetbrains` — the PyCharm/JetBrains plugin (Kotlin; a front-end over the CLI + store — see its [README](packages/jetbrains/README.md)).

## Develop & share

```bash
npm test          # core unit tests + the extension smoke test
npm run e2e       # end-to-end CLI + capture-hook integration harness
npm run release   # build shareable artifacts into ./release (CLI .tgz + .vsix)
```

To cut a release: `git tag v0.2.0 && git push origin v0.2.0` — CI re-runs the suites (npm + e2e +
Gradle) and attaches the CLI `.tgz`, the VS Code `.vsix`, and the JetBrains `.zip` to a
[GitHub Release](https://github.com/cell-observatory/claude-observatory/releases). Teammates install
with `npm i -g ./claude-observatory-<ver>.tgz`, `code --install-extension <file>.vsix`, and
Settings → Plugins → Install Plugin from Disk for the `.zip` (no tokens or registry setup needed).

See [docs/DEMO.md](docs/DEMO.md) for a feature-by-feature walkthrough, or the
**[visual showcase](https://cell-observatory.github.io/claude-observatory/showcase.html)** — rendered
in your browser via GitHub Pages (source: [docs/showcase.html](docs/showcase.html)).

## Notes

- Binary and >5 MB files are skipped. Bash-driven file changes are intentionally not tracked (a workspace watcher could add that later).
- New-file creates are captured (undo deletes the file). No-op edits are not logged.
- Everything is local: no network calls, no telemetry. Deep analysis only runs the `claude` CLI you already have, and only when you ask.
