# Claude Observatory

A running list of every file change **Claude Code** makes — each with its own **Keep** / **Undo** — right in the VS Code sidebar. Git-free, surgical, and it costs **zero extra Claude tokens** (edits are captured by local hooks, outside the model loop).

Think of it as the Cursor "keep/undo each change" experience, but for Claude Code, and shareable with your team.

## Setup

1. Install the capture hooks once (this writes two entries into `~/.claude/settings.json`):

   ```bash
   claude-observatory init
   ```

   (Not installed globally yet? Run `node <repo>/packages/cli/dist/index.js init`. Install the hooks while Claude Code is **not** running, then launch it.)
2. Open the **Claude Observatory** view in the Activity Bar (the microscope icon, badged with the pending-edit count). As Claude edits files, they appear grouped by folder → file → class.

> **Remote-SSH / devcontainers / WSL:** this extension runs on the **workspace host**, so install it — along with the `claude-observatory` CLI, the status line, and the capture hooks — **on the remote**, where `~/.claude` lives (not on your laptop). See the main repo's [Remote development guide](https://github.com/cell-observatory/claude-observatory#remote-development-ssh--devcontainers).

## Views

**Review surfaces** live in the activity bar; the **observatory dashboards** live side-by-side in the bottom panel (like Terminal/Problems). A **status-bar microscope** shows the pending count in realtime (amber while anything awaits review), with the full **review scoreboard** (pending · accepted · reverted · acceptance rate · oldest pending) in its tooltip. The review loop is fully keyboard-driven: **⌥⌘N** (`ctrl+alt+n`) jumps to the oldest pending edit, **⌥⌘Y** keeps the edit under the cursor, **⌥⌘U** undoes it.

Activity bar:

- **Edits** — pending edits grouped **folder → file → class**; click an edit to open the file and jump to it. In the editor, each edit gets a **✨ gutter star**, a **subtle** green/red line tint (toned down so a heavily edited file doesn't drown in color), a coral overview-ruler mark, and an **inline menu**: **✨ #N · +A −R · view changes** then **✓ Keep · ↩ Undo · 💬 Chat · ⧉ View diff**. Click **view changes** and an **inline review bubble** opens right at the edit — no tab — showing the diff in **git's own theme colors** (green/red text over the diff editor's translucent line fills) plus Claude's **reasoning** and the `+A −R` counts, with **Accept · Revert · Chat · Prev · Next** as real buttons on the bubble's toolbar (Prev/Next step through that file's edits). **⧉ View diff** opens the same edit as a full diff tab — always its own tab, with title-bar Prev/Next cycling the file's edits in place.
- **Diffs** — the same tree, but clicking an edit opens the before ⟷ after diff (in the unified inline view by default — the GitLens red/green look).
- **File History** — a flat, chronological list of just the **active file's** edits (id · time · status · reasoning) that **follows the editor** as you switch tabs; click a row to jump/keep/undo/diff, and step revisions from its toolbar.

Bottom panel:

- **Observations** — a **session recap** on top (Claude Code's own session title — zero token; **✨** to refine via `claude -p --resume`), then a per-edit row with Claude's actual reasoning (click any row for a combined report; **✨ Analyze** for a deeper, context-grounded look). Rows also carry the observatory's **memory of the file** — cross-session accept/revert history + prior Claude analyses, with repeat-reverted files flagged for careful review.
- **Timeline** — files ordered by most-recent activity, each expanding to its edits (`#id` + a small dimmed time + delta); status by icon; click to reveal it in the editor.
- **Stats** — a live **review scoreboard** on top (pending / accepted / reverted counts + a **progress bar** that fills as you review, updated live on every keep/undo), then a **tokens** step-line plot (total / input / output, log y-axis) with a **Today / 7 days / 30 days** toggle. Below: the live **Usage** bars (context fill + 5h / week plan usage with `~token` estimates from [claude-statusline](https://github.com/cell-observatory/claude-statusline)). The stats scan runs in a subprocess (`claude-observatory stats`) with an incremental cache, so the UI never blocks.

In the editor tab-bar (and the File-History toolbar): **prev / next pending edit**, **Accept all in this file** / **Revert all in this file**, **Search**, and **📄 file heatmap** (dim unmodified lines). Step a file's revisions in a current-vs-revision diff with **⌥⌘[** / **⌥⌘]**.

Across all views: **Accept all**, **Revert all**, and **Clear resolved** in the view title; reverted edits are struck through and accepted edits greyed; right-click an edit → **Chat about this edit** (copies a prompt + opens the Claude sidebar chat). Keep/Undo operate on the same store as the `claude-observatory` CLI, so the two stay in sync.

## What's captured

Tool edits only: `Edit`, `Write`, `MultiEdit`, `NotebookEdit`. Binary and >5 MB files are skipped. Bash-driven file changes are intentionally not tracked.
