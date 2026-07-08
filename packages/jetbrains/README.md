# Claude Observatory for JetBrains IDEs

Per-edit **Keep / Undo** for [Claude Code](https://claude.com/claude-code) in PyCharm, IntelliJ,
WebStorm, GoLand, and every other JetBrains IDE (platform-only APIs — no language plugin required).
The same store, engine, and review model as the CLI and the VS Code extension: all three front-ends
stay in sync because they read and write the same `~/.claude/claude-observatory` store.

## Requirements

- A JetBrains IDE **2025.2+**
- The `claude-observatory` CLI on this machine (the plugin drives it for every store mutation —
  undo/redo correctness lives there, deliberately): `npm i -g claude-observatory`
- Capture hooks installed: `claude-observatory init --with-statusline` (with Claude Code closed;
  `--with-statusline` also enables the 5h/week Usage bars)

## Install

**From a GitHub Release:** download `claude-observatory-jetbrains-<ver>.zip` → Settings → Plugins →
⚙ → **Install Plugin from Disk…** → restart. Under JetBrains Remote Development, install it on the
**host** (Settings → Plugins (Host)).

**From this repo:**

```bash
./scripts/install-jetbrains.sh   # builds + installs into your local JetBrains IDEs, then restart the IDE
```

## What you get

| Surface | Where |
| --- | --- |
| **Edits / Diffs** trees (folder → file → class → edit; Keep/Undo/Redo/Diff via context menu) | "Claude Observatory" tool window, left stripe |
| **Observations · Timeline · Stats** side-by-side panes | "Claude Observatory Dashboards" tool window, bottom stripe |
| **Inline review** — lens (`✓ Keep · ↩ Undo · ⇄ Diff · 💬 Chat`) above each pending edit, diff-tinted lines, gutter telescope, `✨ #N` markers | every editor |
| **Hover card** — Claude's full reasoning + actions, on hover over any edited line or the ✨ marker | every editor |
| **🔭 scoreboard** — pending count, accept rate, oldest pending; click = review next | status bar |
| **Keyboard loop** — `⌥⌘N` review next · `⌥⌘Y` keep at cursor · `⌥⌘U` undo at cursor (`Ctrl+Alt` on Windows/Linux) | global |

Undo is surgical (position-anchored 3-way merge, via the CLI): reverting one edit preserves later
edits to the same file; genuine overlaps surface a conflict dialog with a **Force-restore** option.
Unsaved files prompt **Save & Continue** before any disk-writing operation.

## Settings

**Settings → Tools → Claude Observatory**: paths for the `claude-observatory` and `claude` CLIs
(blank = auto-detect), a `CLAUDE_CONFIG_DIR` override (for relocated config dirs, e.g. devcontainer
volumes), and the inline-overlay toggle.

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
