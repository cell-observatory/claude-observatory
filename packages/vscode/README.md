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

## Updates

The extension checks GitHub Releases in the background (at most once a day) and offers a one-click **Update now** when a newer version ships — no Marketplace required. Trigger it anytime from the Command Palette: **“Claude Observatory: Check for updates.”** The downloaded `.vsix` is sha256-verified before it installs. (The bundled `claude-observatory update` CLI updates this extension too.)

## Views

The **review surfaces** live in the Activity Bar (icon-only tabs; the microscope icon is badged with the pending count); the **observatory dashboards** live side-by-side in the bottom panel (like Terminal/Problems). A **status-bar microscope** shows the pending count in realtime (amber while anything awaits review), with the full **review scoreboard** in its tooltip.

- **Overview** (bottom panel) — the flagship **master–detail** view. A left nav of **Fleet** — every running agent across the repo's git **worktrees** (correlated git-free, without the git binary), each with a live phase (`~` marks an inferred one), an activity sparkline, ±lines, and risk, nested subagents included — then **Workflows** (orchestration runs), **Tasks** (Claude's own numbered to-dos, each with its ±lines / edits / pending rollup), **Processes** (background shells this session left running), and **Sessions** (this workspace's sessions, newest conversation first, the live one marked). Selecting a Sessions row pins what the whole observatory reviews; the other tabs re-point the panel alone. The right pane is the selected item's change map: a **Folders strip**, a churn-ranked **Files ledger** sized by ±lines, and a summary bar, over that selection's feed — a live tail while the agent, run, task, or shell is still working, an audit log once it has finished. Its two-row toolbar steps the pending edits on four review axes — **Diff · File · Folder · Prompt** — and carries the session controls, among them **Active only**: on by default, remembered across hides and restarts, and hiding finished agents, runs, shells, and fully-reviewed work.
- **Prompts** (bottom panel) — the session as your own turns, in order, each carrying the edits, files, folders, tokens, agents, workflows, tasks, and shells it produced. Selecting a prompt **scopes the whole Overview** to it, and the prompt-scoped **Accept Prompt**, **Reject Prompt**, and **Clear** act on exactly the work that ask caused.
- **Edits · Diffs · File History · Actions · Observations** (Activity Bar) — pending edits grouped **folder → file → class**, a diff tree, the active file's history, the zero-token **action timeline** (every tool call this session, with the risk + egress audits and the live cross-agent file conflicts), and the session recap + chronological change feed with per-edit reasoning and cross-session file memory. In the editor, each edit gets a **✨ gutter star**, a subtle green/red line tint, a coral ruler mark, and an inline **✦ #N · view changes** menu that opens an **inline review bubble** in git's own colors (reasoning + `+A −R`, with Keep/Undo/Chat/Prev/Next buttons).
- **Stats** (bottom panel) — a live **review scoreboard** over token/usage plots.
- **💬 Chat** — on any action, edit, subagent, or task: hands your own Claude a **context-preloaded** prompt (the target, Claude's reasoning, and the diff or command/result). **Zero-token** — Observatory never calls a model.

The review loop is keyboard-driven: **⌥⌘N** (`ctrl+alt+n`) jumps to the oldest pending edit, **⌥⌘Y** keeps it, **⌥⌘U** undoes it; **⌥⌘-** / **⌥⌘=** step a file's revisions. Keep/Undo operate on the same store as the `claude-observatory` CLI, so the two stay in sync.

Try it without Claude: `claude-observatory demo` replays a scripted session live through the real pipeline in an isolated `demo-*` session — every panel fills in, and review genuinely works. `claude-observatory demo --clean` removes every trace.

See the full feature tour in the [main README](../../README.md#the-observatory).

## What's captured

Tool edits (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) plus files changed by `Bash` commands (set `CLAUDE_OBSERVATORY_NO_BASH=1` to opt out). Binary and >5 MB files are skipped.
