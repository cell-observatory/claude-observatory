# Architecture

The "how it really works" companion to [CONTRIBUTING.md](../CONTRIBUTING.md). CONTRIBUTING tells you
*where to put code*; this file tells you *why the pieces fit together* — the dependency graph, the
on-disk store, the shared view-models, the hand-mirrored Kotlin ports, and the exact `--json`
contract the machine-readable surface guarantees. Every claim below is grounded in the real files.

## Dependency graph

```
   packages/core  ──(re-exported from src/index.ts)──►  packages/cli
   pure TS engine                                        `claude-observatory` bin
   only runtime dep: `diff`                              main() = switch(argv[0]) → emitJson
        │                                                        │
        │ import * as core                                       │ subprocess:  … --json
        ▼  (in-process)                                          ▼
   packages/vscode                                        packages/jetbrains (Kotlin)
   renders core's view-models directly;                   never imports core.
   spawns `stats --json` for the heavy scan               • mutations + diff-reads → ObservatoryCli (over CLI)
                                                           • store reads → StoreReader/SessionResolver (off disk)
```

- **`core` → `cli`.** The CLI imports `@claude-observatory/core` and is the single source of truth
  both editors consume. `packages/cli/src/index.ts` is one `main()` with a `switch` on `argv[0]`;
  each `case` calls a `core` function and, for the machine surface, serializes with
  `emitJson(v) = process.stdout.write(JSON.stringify(v))`.
- **`cli` → `vscode` (in-process).** `packages/vscode/src/extension.ts` does
  `import * as core from '@claude-observatory/core'` and calls `core.buildEditTree`,
  `core.undoEdit`, `core.setStatus`, `core.readLog`, `core.fileMemory`, … directly. It only *spawns*
  the CLI for `stats --json` (potentially GBs of transcripts — kept off the UI thread).
- **`cli` → `jetbrains` (over the CLI).** The Kotlin plugin never links `core`. It shells out to
  `claude-observatory … --json` via `core/ObservatoryCli.kt` for every **mutation**
  (`keep`/`undo`/`redo`/`clean`) and every **diff-dependent read** (`locate`, `tree`, `observe`,
  `stats`), and reads the raw store **off disk** via Kotlin ports (`StoreReader`, `SessionResolver`,
  `ClaudePaths`). The undo engine's correctness deliberately lives in exactly one place — the TS core.

## The store

Everything lives under `CLAUDE_CONFIG_DIR` (default `~/.claude`), resolved by
`claudeConfigDir()` in `packages/core/src/paths.ts`. Per session
(`packages/core/src/store.ts`):

```
~/.claude/claude-observatory/<session_id>/
  log.jsonl            append-only: EditRecord lines + status-op lines
  blobs/<sha256>       whole-file snapshots, content-addressed (deduped)
  staging/<pathHash>   transient "before" snapshot between PreToolUse and PostToolUse
```

- `rootDir()` = `<config>/claude-observatory`; `storeDir(session)` = `<root>/<session_id>`;
  `logPath(session)` = `<storeDir>/log.jsonl`.
- **Blobs are content-addressed:** `writeBlob` hashes the bytes with sha256 and writes
  `blobs/<sha>` only if absent — identical file states dedupe automatically. `readBlob(session, sha)`
  returns the raw `Buffer` (the `blob <sha>` CLI command streams it).
- **Staging** is the two-phase capture handshake: `PreToolUse` writes a `StagingRecord` (the file's
  pre-edit `beforeBlob`); `PostToolUse` reads it, snapshots the after state, appends the `EditRecord`,
  and deletes the staging file. Bash-driven changes use a `__bash__.json` manifest instead.

### Why append-only

From the header of `store.ts`:

> The log is strictly append-only — status changes are appended as ops and folded in on read, so a
> front-end updating a status never rewrites the file and so cannot race-drop a record the capture
> hook appends concurrently.

A status change is a one-line op, not an in-place edit:

```jsonc
{"op":"status","id":3,"status":"kept","ts":1710000000000}
```

`readLog(session)` streams the file, pushes each `EditRecord`, and folds each `{op:"status"}` line
onto the matching record (last op wins). Because writers only ever *append*, the capture hook and an
editor marking an edit "kept" can run concurrently without either clobbering the other. `setStatus`
appends the op (skipping a redundant no-op) and never rewrites — the one rewrite path is
`clearResolved`, which compacts the log to just the pending records and GCs the orphaned blobs.

## Core data shapes

### `EditRecord` — one captured edit (`store.ts`)

```ts
interface EditRecord {
  id: number;              // monotonic per-session integer — typeable for `diff <id>` / `undo <id>`
  ts: number;              // ms epoch, committed at PostToolUse
  tool: string;            // Edit | Write | MultiEdit | NotebookEdit
  file: string;            // absolute path
  beforeBlob: string | null; // sha256 before (null = new-file Write)
  afterBlob: string | null;  // sha256 after  (null = the edit deleted the file)
  status: EditStatus;      // 'pending' | 'kept' | 'undone'
}
```

### `EditTree` — the folder → file → class → edit view-model (`tree.ts`)

The single structure both editors render, built by
`buildEditTree(session, { root?, filter? }): EditTree`. Folder-chain compaction (`src/utils/…`),
class grouping (line geometry from `ranges.ts` + `classes.ts`), exact `added`/`removed` deltas, and
Search filtering are **all computed here** so neither editor reimplements them:

```ts
interface TreeEdit  { id; ts; tool; file; status; beforeBlob; afterBlob; added; removed }
interface TreeClass { name: string; edits: TreeEdit[] }
interface TreeFile  { rel: string; file: string; classes: TreeClass[]; loose: TreeEdit[] }
interface TreeFolder{ label: string; folders: TreeFolder[]; files: TreeFile[] }
interface EditTree  { folders: TreeFolder[]; files: TreeFile[] }
```

### The observe payload (`cmdObserve` in the CLI, over `observe.ts`)

One JSON blob for an Observations-style view — `{ session, recap, insights, suggestions, edits[] }`,
where each edit carries `{ id, ts, tool, file, status, summary, reasoning, flags, memory, analysis }`.
`reasoning`/`insights` are parsed from the Claude Code session transcript (zero tokens); `memory` is
the observatory's cross-session accept/revert history for the file; `flags` mark revert-risk.

### `StatsResult` — usage trends (`stats.ts`)

```ts
interface StatsResult {
  daily: DayStat[];   // last 30 days, oldest → newest
  hourly: HourStat[]; // today, 24 local-hour buckets
  windows: { session: StatMetrics; day: StatMetrics; week: StatMetrics; month: StatMetrics };
  generatedAt: number;
}
```

Computed by `computeStats(session?)` with an incremental on-disk cache keyed on each transcript's
`(mtime, size)` — only changed files are re-parsed. Meant to run in the `stats` subprocess.

## The hand-mirrored Kotlin models

The JetBrains plugin **hand-mirrors** the TS types field-for-field (Gson has no shared schema), so
they must never drift. The mirrors:

| TS source | Kotlin mirror | What it holds |
| --- | --- | --- |
| `core/src/store.ts` (`EditRecord`, `readLog`, blobs) | `core/StoreReader.kt` + `model/Models.kt` | reads `log.jsonl` off disk, folds `{op:"status"}` ops, reads blobs |
| `core/src/session.ts` (`resolveSessionId`, `mangleCwd`) | `core/SessionResolver.kt` | cwd-mangle → newest `<session>.jsonl` → parent-dir walk |
| `core/src/paths.ts` (`claudeConfigDir`) | `core/ClaudePaths.kt` | resolves the config dir + store paths |
| `core/src/tree.ts` (`EditTree` et al.) | `model/Tree.kt` (`EditTree` + `TreeParser`) | parses `tree --json` into `TreeFolderNode`/`TreeFileNode`/`TreeClassNode`/`TreeEditNode` |
| `cmdObserve` payload | `model/Observe.kt` (`ObservePayload` + `ObserveParser`) | parses `observe` |

**Port-fidelity tests** guard the mirrors — "the Kotlin reader must never drift":

- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/core/StoreReaderTest.kt` —
  asserts append-only `log.jsonl` semantics: `EditRecord` lines + `{op:"status"}` folding (last op
  wins), tolerance of unparseable lines, and blob reads, against fixtures written in the TS format.
- `packages/jetbrains/src/test/kotlin/com/cellobservatory/observatory/core/SessionResolverTest.kt` —
  asserts `session.ts` behaviour: cwd mangling, newest-`.jsonl` selection, and the parent-dir walk.

If you change a store or session read, update the port **and** these tests in the same PR.

## The CLI `--json` contract

The machine-readable surface. Field names are a **stable contract** — the JetBrains parsers and the
VS Code renderers key on them by name. Add fields; don't rename them. (`emitJson` writes compact
`JSON.stringify` to stdout; commands below all take `--session <id>` to target a session.)

| Command | JSON shape | Primary consumer |
| --- | --- | --- |
| `list --json` | `{ session, edits: [{ id, ts, tool, file, status, added, removed }] }` | scripts / terminal; JetBrains reads the same records off-disk via `StoreReader` |
| `status --json` | `{ hooksInstalled, hookScript, session, store, lastCaptureTs, counts: { total, pending, kept, undone } }` | doctor / scripts / setup checks |
| `sessions --json` | `{ active, sessions: [{ id, edits, pending, lastMs }] }` | Switch-session pickers |
| `tree [--root <d>] [--filter <q>]` | `EditTree` (`{ folders[], files[] }` → folder → file → class → edit w/ `added`/`removed`) | **both editors** — VS Code via in-process `buildEditTree`, JetBrains via `ObservatoryCli.treeJson` → `TreeParser` → `EditsTreePanel` |
| `observe` | `{ session, recap, insights, suggestions, edits: [{ id, ts, tool, file, status, summary, reasoning, flags, memory, analysis }] }` | Observations panel (JetBrains `ObserveParser`; VS Code builds the equivalent in-process) |
| `actions [--all]` | `{ session, summary{ total, byCategory, errors, firstTs, lastTs }, actions: [{ ts, tool, category, target, detail, ok, isError, reasoning, editId }], groups: [{ category, label, count, errors, actions[] }], subagents, subagentsSummary, fleet, fleetSummary }` | Actions timeline — **both editors** — VS Code in-process `parseActions`/`buildActionGroups`; JetBrains `ObservatoryCli.actionsJson` → `ActionsParser` → `ActionsPanel`. `groups` is curated by default; `--all` includes reads/searches/meta. `subagents`/`subagentsSummary`/`fleet`/`fleetSummary` are additive 0.7.0 fields (same shapes as the `subagents`/`siblings` commands); existing parsers ignore them |
| `subagents [--json]` (alias `agents`) | `{ session, summary, subagents: [{ agentId, agentType, description, status, ts, durationMs, tokens, toolUseCount, actions[], edits, summary }] }` | Subagents node in the Actions view — **both editors**; each subagent's nested timeline is mined zero-token from `subagents/agent-<id>.jsonl` and correlated via the spawning tool call's `toolUseResult` |
| `siblings [--json]` (alias `fleet`) | `{ session, summary, siblings: [{ id, self, active, lastMs, edits, pending, files[], moreFiles, risk{ total, high } }] }` | Fleet node in the Actions view — **both editors** — plus an agent-facing digest a run can poll mid-flight; READ-ONLY / PATH-ONLY (no file contents cross agents). `--json` = siblings only; `--all` includes self |
| `metrics [--json]` | `{ session, spanMs, actions{ total, errors, byCategory }, edits{ count, added, removed, pending, kept, undone }, subagents{…}, toolLatency{ count, medianMs, p95Ms, maxMs } }` | Session metrics roll-up — diff stats, action/error counts, per-subagent duration/tokens, and tool latency (from each `tool_use`→`tool_result` timestamp gap) |
| `locate --file <f>` (buffer on stdin) | `{ file, placements: [{ id, lines: [int] }] }` | inline overlays — JetBrains `ObservatoryCli.locate`; VS Code computes in-process via `core.locateEditInCurrent` |
| `usage` | `{ ...UsageLine, staleMs }` (`staleMs` = `USAGE_STALE_MS`, 300000) | the 5h/week Usage bars |
| `stats --json` | `StatsResult` (`{ daily[30], hourly[24], windows{session,day,week,month}, generatedAt }`) | Stats panel (both spawn a subprocess) |
| `keep <id> --json` / `keep --all --json` | `{ kept, ids: [int] }` | JetBrains `ObservatoryCli.keep` / `keepAll` |
| `undo <id> --json` / `redo <id> --json` | `{ ok, status, message }` — `status` ∈ `undone` \| `redone` \| `conflict` \| `noop` \| `error` | JetBrains `ObservatoryCli.undo` / `redo` → `UndoResult`; front-ends branch on `.status`, never on prose |
| `blob <sha>` | raw bytes (not JSON) | diff panes / chat prompts |

The undo/redo `--json` exit codes mirror the human path exactly: `conflict` → exit 1, `ok` → 0. A
front-end branches on the structured `status` to, e.g., offer `--force` on a conflict instead of
string-matching the message. The e2e harness (`test/e2e.sh`, section 14) asserts each of these shapes
with `jq`.

The three 0.7.0 commands are backed by new `core` modules — `subagents.ts`, `fleet.ts`, and
`metrics.ts` — each deriving purely from the Claude Code transcript + the content-addressed store
(no model calls, no network). `parseActions` was refactored to share `parseTranscriptActions`, so
every subagent's `subagents/agent-<id>.jsonl` transcript parses through exactly the same code as the
main session's action timeline.

## See also

- [CONTRIBUTING.md](../CONTRIBUTING.md) — the step-by-step "add a feature across all platforms" guide.
- `packages/jetbrains/README.md` — the plugin's own install/remote-dev notes.
- The root `README.md` — user-facing overview, install, and the feature tour.
