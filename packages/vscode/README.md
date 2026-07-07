# Claude Observatory

A running list of every file change **Claude Code** makes — each with its own **Keep** / **Undo** — right in the VS Code sidebar. Git-free, surgical, and it costs **zero extra Claude tokens** (edits are captured by local hooks, outside the model loop).

Think of it as the Cursor "keep/undo each change" experience, but for Claude Code, and shareable with your team.

## Setup

1. Install the capture hooks once (this writes two entries into `~/.claude/settings.json`):

   ```bash
   claude-observatory init
   ```

   (Not installed globally yet? Run `node <repo>/packages/cli/dist/index.js init`. Install the hooks while Claude Code is **not** running, then launch it.)
2. Open the **Claude Observatory** view in the Activity Bar (the telescope icon, badged with the pending-edit count). As Claude edits files, they appear grouped by folder → file → class.

## Views

**Review surfaces** live in the activity bar; the **observatory dashboards** live side-by-side in the bottom panel (like Terminal/Problems). A **status-bar telescope** shows the pending count in realtime (amber while anything awaits review), with the full **review scoreboard** (pending · accepted · reverted · acceptance rate · oldest pending) in its tooltip. The review loop is fully keyboard-driven: **⌥⌘N** (`ctrl+alt+n`) jumps to the oldest pending edit, **⌥⌘Y** keeps the edit under the cursor, **⌥⌘U** undoes it.

Activity bar:

- **Edits** — pending edits grouped **folder → file → class**; click an edit to open the file and jump to it. In the editor: clickable **Keep · Undo · Diff** above each pending edit, a gutter change-bar on its lines, and a `✨ #N` marker with **Chat** on hover.
- **Diffs** — the same tree, but clicking an edit opens the before ⟷ after diff.

Bottom panel:

- **Observations** — a **session recap** on top (Claude Code's own session title — zero token; **✨** to refine via `claude -p --resume`), then a per-edit row with Claude's actual reasoning (click any row for a combined report; **✨ Analyze** for a deeper, context-grounded look). Rows also carry the observatory's **memory of the file** — cross-session accept/revert history + prior Claude analyses, with repeat-reverted files flagged for careful review.
- **Timeline** — files ordered by most-recent activity, each expanding to its edits (`#id` + a small dimmed time + delta); status by icon; click to reveal it in the editor.
- **Stats** — step-line plots with a **Today / 7 days / 30 days** toggle (Today hourly): **edits** split into pending / accepted / reverted, **tokens** into total / input / output (linear y-axis for edits, log for tokens). Below the plots: a **Review scoreboard** (pending · accepted · reverted · acceptance rate · oldest pending) and the live **Usage** bars (context fill + 5h / week plan usage with `~token` estimates from [claude-statusline](https://github.com/cell-observatory/claude-statusline)). The stats scan runs in a subprocess (`claude-observatory stats`) with an incremental cache, so the UI never blocks.

Across all views: **Accept all**, **Revert all**, and **Clear resolved** in the view title; reverted edits are struck through and accepted edits greyed; right-click an edit → **Chat about this edit** (copies a prompt + opens the Claude sidebar chat). Keep/Undo operate on the same store as the `claude-observatory` CLI, so the two stay in sync.

## What's captured

Tool edits only: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`. Binary and >5 MB files are skipped. Bash-driven file changes are intentionally not tracked.
