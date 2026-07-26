# claude-observatory

Standalone, git-free, **per-edit Keep / Undo for [Claude Code](https://claude.com/claude-code)** on established and mission-critical codebases — a running list of every file change Claude makes, each with surgical undo. Works in the terminal and (with the companion extensions) the VS Code sidebar and JetBrains IDEs. Capture runs in local hooks, so it costs **zero extra Claude tokens**. Its `--json` output is the view API behind the editors' panels — including the 0.8.0 **real-time multi-agent** surfaces: the master–detail Overview (a fleet of running agents across git **worktrees** — correlated git-free — plus workflow runs) and the cross-agent task log.

![the terminal front-end](../../docs/media/cli.png)

## Install

```bash
# one command — installs the CLI + editor extensions from the latest release, then wires hooks
curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash
```

Or install just the CLI from a [release](https://github.com/cell-observatory/claude-observatory/releases) tarball:

```bash
npm i -g ./claude-observatory-<ver>.tgz
claude-observatory init --with-statusline   # run with Claude Code CLOSED, then launch it — sessions now capture
```

Update anytime with `claude-observatory update` (or re-run the bootstrap).

`--with-statusline` also installs the **bundled** [claude-statusline](https://github.com/cell-observatory/claude-statusline) (no download — it ships inside this package) so the editor sidebars can show 5h/week plan-usage bars. Install/refresh it any time with `claude-observatory statusline`.

## Commands

```text
claude-observatory status              # hooks + hook-path health + active session + counts
claude-observatory sessions            # this workspace's sessions, newest conversation first (● = the one this directory resolves to)
claude-observatory prompts             # the session as the list of things YOU asked for (--id <n> drills into one; --id <n> --response prints Claude's reply)
claude-observatory list [--pending|--kept|--undone] [--file <substr>]
claude-observatory diff <id>           # before/after for one edit
claude-observatory keep <id>           # mark reviewed (no disk change; --all / --file <substr> for bulk)
claude-observatory undo <id> [--force] # surgically undo one edit
claude-observatory redo <id> [--force] # re-apply an undone edit
claude-observatory task-keep <taskId>  # keep every pending edit in a task's strict in-progress span; --json
claude-observatory task-undo <taskId>  # revert every pending edit in that same strict span; --json
claude-observatory task-clear <taskId> # drop a task's resolved edits (--completed clears every settled task); --json
claude-observatory demo                # simulate a Claude session LIVE through the real pipeline (isolated demo-* session + folder) — review works for real; --fast for scripts; demo --clean removes every trace
claude-observatory clean               # GC orphaned blobs (--resolved [--under <path> | --ids <a,b,c>] | --drop <id> | --older-than 30d | --all)
claude-observatory statusline          # install/refresh the bundled status line (needs bash + jq)
claude-observatory init --project      # install the hook into a repo's ./.claude/settings.json (for teams)
```

A **task** is one of Claude Code's own numbered to-dos. `task-keep`, `task-undo`, and `task-clear` act only on the edits captured while that task was in progress. Edits that fall outside every in-progress window stay unassigned; the CLI never sweeps them into a neighboring task.

A **prompt** is one of your own turns. `prompts` lists them in order, each carrying the edits, files, folders, tokens, agents, workflows, tasks, and shells it produced. Attribution goes by start time: a shell a prompt launched stays that prompt's even if it exits during a later one.

**Machine-readable surface** — the view API the editor front-ends build on (the JetBrains plugin entirely); `list`/`status`/`sessions`/`keep`/`undo`/`redo` all take `--json`, plus:

```text
claude-observatory multitask --json    # real-time multi-agent view: every running agent across the repo's worktrees — phase · sparkline · ±diff · risk · subagents · workflows · conflicts, git-free
claude-observatory tasklog --json      # cross-agent task log: one row per stable taskId, unioned across worktrees + subagents
claude-observatory chat-context --json # zero-token, ready-to-paste chat prompt about an action/edit/subagent/task (--tool-use-id | --edit | --agent | --task)
claude-observatory changemap           # the Overview view-model: the per-prompt slices + per-file/per-folder churn rollups (per task/subagent/workflow/agent) as JSON
claude-observatory views --json        # several read-only views in ONE process: {name: payload}, each byte-identical to its own command (--views a,b,c to pick). One spawn per refresh instead of eight — what the JetBrains plugin drives its whole tick through
claude-observatory sessions --json     # {active, sessions:[{id, title, lastActiveMs, current}]} — built from directory stats + a cached title scan, never from a session's edit log
claude-observatory blob <sha>          # raw blob bytes to stdout
claude-observatory locate --file <f>   # per-pending-edit line indices in the LIVE buffer (text on stdin; JSON out)
claude-observatory observe             # recap + per-edit reasoning/flags/file-memory as JSON
claude-observatory usage               # ctx / 5h / week usage snapshot as JSON (incl. staleness metadata)
```

`undo/redo --json` return the structured result (`{ok, status, message}`) so callers can branch `conflict` → offer `--force` instead of parsing prose.

**Opt-in `claude -p` analysis** (spends tokens; returns the cached result unless `--fresh`):

```text
claude-observatory analyze <id>        # deep-analyze one edit     [--json --fresh --claude-bin <path>]
claude-observatory recap               # one-line session recap    [--json --fresh --claude-bin <path>]
claude-observatory suggest             # next steps + suggestions  [--json --fresh --claude-bin <path>]
```

Surgical undo reverts a single edit while preserving later edits to the same file (a position-anchored 3-way merge); genuine overlaps become a clear conflict with a per-file restore fallback.

See the full feature tour — plus the VS Code / JetBrains extensions and the full design — in the [main README](../../README.md#the-observatory).
