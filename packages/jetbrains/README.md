# Claude Observatory for JetBrains IDEs

Per-edit **Keep / Undo** for [Claude Code](https://claude.com/claude-code) in PyCharm, IntelliJ,
WebStorm, GoLand, and every other JetBrains IDE (platform-only APIs — no language plugin required).
The same store, engine, and review model as the CLI and the VS Code extension: all three front-ends
stay in sync because they read and write the same `~/.claude/claude-observatory` store.

![Claude Observatory in PyCharm](../../docs/media/pyc-layout.png)

See the full feature tour in the [main README](../../README.md#the-observatory); the notes below are
JetBrains-specific.

## Requirements

- A JetBrains IDE **2025.2+**
- The `claude-observatory` CLI on this machine (the plugin drives it for every store mutation —
  undo/redo correctness lives there, deliberately). Install it via the [one-command bootstrap](https://github.com/cell-observatory/claude-observatory#install), or from a release tarball: `npm i -g ./claude-observatory-<ver>.tgz`
- Capture hooks installed: `claude-observatory init --with-statusline` (with Claude Code closed;
  `--with-statusline` also enables the 5h/week Usage bars)

## Install

**From a GitHub Release:** download `claude-observatory-jetbrains-<ver>.zip` → Settings → Plugins →
⚙ → **Install Plugin from Disk…** → restart.

**From this repo:**

```bash
./scripts/install-jetbrains.sh   # builds + installs into every JetBrains IDE it finds, then restart the IDE
```

The script covers macOS (`~/Library/Application Support/JetBrains`), desktop Linux
(`~/.local/share/JetBrains`), Windows via Git Bash (`%APPDATA%\JetBrains`), and JetBrains Remote
Development backends (`~/.config/JetBrains/RemoteDev-*`), so it also works when run on an SSH host.

## Remote development (Gateway / Toolbox over SSH)

The plugin runs **on the host** — platform-only APIs, no JCEF — which is exactly where `~/.claude`,
the store, and Claude Code live; the tool windows and status bar are remoted to the JetBrains
Client. Install it on the host with the script above (in the remote terminal), and install the
CLI + hooks + status line on the remote too. One caveat: the backend isn't a login shell, so
`CLAUDE_CONFIG_DIR`/PATH exports in shell profiles don't reach it — if the CLI or store isn't
found, set both explicitly in **Settings → Tools → Claude Observatory**. Full walkthrough:
[main README → Remote development](../../README.md#remote-development-ssh--devcontainers).

## What you get

| Surface | Where |
| --- | --- |
| **Edits / Diffs / File History** trees (Edits/Diffs group folder → file → class → edit; **File History** is a flat, chronological list of just the active file's edits that follows the editor) — Keep/Undo/Redo/Diff via context menu | "Claude Observatory" tool window, left stripe |
| **Observations · Timeline · Stats** side-by-side panes (Stats leads with a live **review scoreboard** — pending / accepted / reverted counts + a progress bar — over the tokens plot) | "Claude Observatory Dashboards" tool window, bottom stripe |
| **Inline menu** — `✨ #N view changes` (opens the edit's inline diff) then `✓ Keep · ↩ Undo · 💬 Chat` on the lens above each pending edit; a **✨ gutter star** (click to open the diff), a subtle green/red line tint, a **Claude-coral error-stripe** marker | every editor |
| **Click → inline diff** — the edit's before ⟷ after opens **unified**, with Claude's reasoning in the title and `Keep · Undo · Chat` on the diff toolbar; **📄 file heatmap** dims unmodified lines (editor banner) | every editor |
| **🔬 scoreboard** — pending count, accept rate, oldest pending; click = review next | status bar |
| **Keyboard loop** — `⌥⌘N` review next · `⌥⌘Y` keep at cursor · `⌥⌘U` undo at cursor · `⌥⌘[` / `⌥⌘]` step file revisions in a diff (`Ctrl+Alt` on Windows/Linux) | global |

Both tool windows now carry **icon-only tabs (hover for the label)**, matching VS Code's icon-driven
views, and the tool-window stripe shows a **pending badge**. This release brings the plugin to full
**feature parity** with the VS Code extension: a toggle-inline button, **Accept/Revert this file** on
the Edits toolbar, revision-nav buttons, Timeline bulk actions, Observations clear/switch/doctor, and a
5th **⧉ View diff** lens segment.

Undo is surgical (position-anchored 3-way merge, via the CLI): reverting one edit preserves later
edits to the same file; genuine overlaps surface a conflict dialog with a **Force-restore** option.
Unsaved files prompt **Save & Continue** before any disk-writing operation.

## Settings

**Settings → Tools → Claude Observatory**: paths for the `claude-observatory` and `claude` CLIs
(blank = auto-detect), a `CLAUDE_CONFIG_DIR` override (for relocated config dirs, e.g. devcontainer
volumes), the inline-overlay toggle, and a **unified diff** toggle (open edit diffs in the inline
red/green viewer instead of side-by-side).

## Architecture (for contributors)

The plugin is a Kotlin **front-end over the TypeScript core**, never a re-implementation:

- **Mutations & diff-dependent reads** → the `claude-observatory` CLI (`undo/redo --json`,
  `locate` for live-buffer line mapping, `stats/usage/observe --json`). The 3-way undo engine is
  correctness-critical and lives in one place.
- **Cheap reads** → straight off disk (`log.jsonl` + status-op folding, content-addressed blobs,
  session resolution) — schemas match core's `store.ts`/`session.ts`, locked in by the unit tests
  in `src/test/kotlin` (`gradle test`).
- **Stats plots** → native Swing (no JCEF): step-line charts + usage bars that track pane width.

```bash
gradle test buildPlugin      # unit tests + build/distributions/claude-observatory-jetbrains-<ver>.zip
gradle runIde                # throwaway sandbox IDE with the plugin preloaded
./scripts/install-jetbrains.sh   # (from repo root) build + install into your real IDE
```
