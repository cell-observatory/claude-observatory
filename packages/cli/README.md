# claude-observatory

Standalone, git-free, **per-edit Keep / Undo for [Claude Code](https://claude.com/claude-code)** — a running list of every file change Claude makes, each with surgical undo. Works in the terminal and (with the companion extensions) the VS Code sidebar and JetBrains IDEs. Capture runs in local hooks, so it costs **zero extra Claude tokens**.

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
claude-observatory sessions            # list all sessions in the store
claude-observatory list [--pending|--kept|--undone] [--file <substr>]
claude-observatory diff <id>           # before/after for one edit
claude-observatory keep <id>           # mark reviewed (no disk change; --all / --file <substr> for bulk)
claude-observatory undo <id> [--force] # surgically undo one edit
claude-observatory redo <id> [--force] # re-apply an undone edit
claude-observatory clean               # GC orphaned blobs (--resolved | --drop <id> | --older-than 30d | --all)
claude-observatory statusline          # install/refresh the bundled status line (needs bash + jq)
claude-observatory init --project      # install the hook into a repo's ./.claude/settings.json (for teams)
```

**Machine-readable surface** — the API that non-Node front-ends (e.g. the JetBrains plugin) build on; `list`/`status`/`sessions`/`keep`/`undo`/`redo` all take `--json`, plus:

```text
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

See the [project README](https://github.com/cell-observatory/claude-observatory#readme) for the full design and the VS Code / JetBrains extensions.
