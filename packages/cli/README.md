# claude-observatory

Standalone, git-free, **per-edit Keep / Undo for [Claude Code](https://claude.com/claude-code)** — a running list of every file change Claude makes, each with surgical undo. Works in the terminal and (with the companion extension) the VS Code sidebar. Capture runs in local hooks, so it costs **zero extra Claude tokens**.

## Install

```bash
npm i -g claude-observatory
claude-observatory init      # run with Claude Code CLOSED, then launch it — sessions now capture automatically
```

## Commands

```text
claude-observatory status              # hooks + hook-path health + active session + counts
claude-observatory sessions            # list all sessions in the store
claude-observatory list [--pending|--kept|--undone] [--file <substr>]
claude-observatory diff <id>           # before/after for one edit
claude-observatory keep <id>           # mark reviewed (no disk change)
claude-observatory undo <id> [--force] # surgically undo one edit
claude-observatory redo <id> [--force] # re-apply an undone edit
claude-observatory clean               # GC orphaned blobs (--resolved | --drop <id> | --older-than 30d | --all)
claude-observatory init --project      # install the hook into a repo's ./.claude/settings.json (for teams)
```

Surgical undo reverts a single edit while preserving later edits to the same file (a position-anchored 3-way merge); genuine overlaps become a clear conflict with a per-file restore fallback.

See the [project README](https://github.com/cell-observatory/claude-observatory#readme) for the full design and the VS Code extension.
