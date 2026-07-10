# Claude Observatory

A running list of every file change **Claude Code** makes — each with its own **Keep** / **Undo** — right in the VS Code sidebar. Git-free, surgical, and it costs **zero extra Claude tokens** (edits are captured by local hooks, outside the model loop).

Think of it as the Cursor "keep/undo each change" experience, but for Claude Code, and shareable with your team.

![Claude Observatory in VS Code](../../docs/media/layout.png)

## Setup

1. Install the capture hooks once (this writes two entries into `~/.claude/settings.json`):

   ```bash
   claude-observatory init
   ```

   (Not installed globally yet? Run `node <repo>/packages/cli/dist/index.js init`. Install the hooks while Claude Code is **not** running, then launch it.)
2. Open the **Claude Observatory** view in the Activity Bar (the microscope icon, badged with the pending-edit count). As Claude edits files, they appear grouped by folder → file → class.

> **Remote-SSH / devcontainers / WSL:** this extension runs on the **workspace host**, so install it — along with the `claude-observatory` CLI, the status line, and the capture hooks — **on the remote**, where `~/.claude` lives (not on your laptop). See the main repo's [Remote development guide](https://github.com/cell-observatory/claude-observatory#remote-development-ssh--devcontainers).

## Views

The **review surfaces** live in the Activity Bar (icon-only tabs; the microscope icon is badged with the pending count); the **observatory dashboards** live side-by-side in the bottom panel (like Terminal/Problems). A **status-bar microscope** shows the pending count in realtime (amber while anything awaits review), with the full **review scoreboard** in its tooltip.

- **Edits · Diffs · File History** (Activity Bar) — pending edits grouped **folder → file → class**, plus a diff tree and the active file's history. In the editor, each edit gets a **✨ gutter star**, a subtle green/red line tint, a coral ruler mark, and an inline **✨ #N · view changes** menu that opens an **inline review bubble** in git's own colors (reasoning + `+A −R`, with Accept/Revert/Chat/Prev/Next buttons).
- **Observations · Timeline · Stats** (bottom panel) — the session recap + per-edit reasoning and cross-session file memory; a collapsed change feed; and a live **review scoreboard** over token/usage plots.

The review loop is keyboard-driven: **⌥⌘N** (`ctrl+alt+n`) jumps to the oldest pending edit, **⌥⌘Y** keeps it, **⌥⌘U** undoes it; **⌥⌘[** / **⌥⌘]** step a file's revisions. Keep/Undo operate on the same store as the `claude-observatory` CLI, so the two stay in sync.

See the full feature tour in the [main README](../../README.md#the-observatory).

## What's captured

Tool edits only: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`. Binary and >5 MB files are skipped. Bash-driven file changes are intentionally not tracked.
