# Changelog

All notable changes to Claude Observatory are recorded here, following
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Per-tag release artifacts and auto-generated notes are on the
[Releases page](https://github.com/cell-observatory/claude-observatory/releases).

## [0.7.6] — 2026-07-14

A polish pass over the 0.7.5 Change Map and the review toolbars: the view is renamed **Overview**, its
module strip is honest and clickable, Actions updates live, and the same **Diff n/m · File i/k** position
now shows everywhere you review — plus a new **Panels** interface reference. No breaking changes; the store
format is unchanged. `changemap --json` keeps the same command and `files[]` shape; only `modules[]` changes
— it is now grouped by module **label** (one row per label, `module === label`), which both editors already
read.

### Renamed — Change Map is now "Overview"

The bottom-panel view reads **Overview** in both editors. The `claudeObservatory.changemap` view id, the
command ids, and the `changemap --json` command are all unchanged, so nothing scripted or docked breaks.

### Changed — the Overview module strip

- **Equal-width segments.** Every module Claude touched gets the same slice, so a low-churn module is a
  clickable segment instead of an unhittable sliver. (It was churn-proportional.)
- **One segment per module label.** `packages/vscode` and `packages/vscode/src` used to render as two
  identically-named `vscode` segments; the rollup now groups by label **in `core`**, so they merge into
  one. Both renderers stay dumb — each changed a single file filter (raw path → label).

### Fixed — chapter attribution

The `in_progress` windows are now disjoint and the first extends back to the session start, so an edit is
no longer double-counted across a revisited to-do, and edits made before the first to-do are attributed
instead of dropped. An edit outside every window is still left **unassigned** rather than mis-filed.

### Changed — Actions

- **Live updates on every tool call.** A transcript watcher refreshes the Actions tree whenever Claude
  does anything — not only on edits — so Reads, Bash runs, and searches appear as they happen (VS Code).
- **No more doubled Subagents.** The raw Subagents category is dropped when the subagent submenu is
  present, so subagents live in exactly one place (both editors).

### Renamed — Spotlight (was Heatmap)

The dim-unmodified-lines toggle is now **Spotlight** in its command title, the tab-bar toolbar, and the
status message (both editors).

### Added — the review position, everywhere you review

The **Diff n/m · File i/k** counters from the status-bar navigation bar now also appear in the **inline
CodeLens** on each edit and in the **inline review bubble** title (both editors). The editor tab bar and
comment-thread toolbars can only render icon buttons, so the counters live where text is allowed — and
they now agree across every surface.

### Changed — the review toolbars

**Switch session** is on every review bar. The Overview toolbar icons are spread out. Per-file
**Accept / Revert all** moved off the Claude Edits sidebar's top bar (too easy to hit by accident) onto the
tab bar and status bar; **Clear resolved** and **Spotlight** join the tab-bar toolbar.

### Added — the Panels interface reference

`docs/panels.html` — a named map of every window, tab, and toolbar button: a master annotated workspace
mockup, a per-pane diagram for each of the five Overview panels, an annotated inline-review bubble, and the
three review toolbars, each control numbered and named. Linked from the showcase nav.

### Docs

Regenerated the VS Code + JetBrains hero screenshots for the five-pane panel and added the annotated
mockups above; the showcase slideshow gains Overview / Spotlight frames with the caption below each image.

### Tests

- Core `changemap (0.7.6)` test — the module-label merge (two `packages/vscode*` files collapse to one
  `vscode` row) and the disjoint-span attribution, including extend-to-start and the gap → unassigned case.
- VS Code smoke test — the CodeLens position counter, the bubble's dual-axis label, and an Overview
  webview block that asserts a hidden view spawns no subprocess.

## [0.7.5] — 2026-07-14

Adds the **Change Map** — a new bottom-panel view that answers the one question the flat lists can't:
*where did this session's work land, and what still needs my eyes?* Zero-token and local like the rest,
and cross-editor from day one (CLI + VS Code + JetBrains). No breaking changes — the store format is
unchanged and every existing `--json` shape is unchanged; `changemap --json` is a new command.

### Added — Change Map (CLI + both editors)

The whole session as one picture, drilling to the same per-edit review as everywhere else. Three layers:
**chapters** (Claude's own to-dos — click one to brush the map down to just the files that goal produced),
a one-row **module proportion strip** (click a segment to filter), and every file **ranked by churn**
with a bar. Colour is **worst-unreviewed-wins**, so a module never reads reviewed while something under
it is still pending. Hover a row for the class touched and Claude's reasoning; click to open the real diff.

Chapter attribution is an honest heuristic, not a guess: a to-do flipping to `in_progress` opens a window
that runs until the next one does, and an edit falling outside every window is left **unassigned** rather
than mis-filed onto the wrong goal.

- **CLI**: `claude-observatory changemap [--root <d>] [--json]` — backed by a new `core` module,
  `changemap.ts`, deriving purely from the transcript + the content-addressed store.
- **Both editors**: a **Change Map** pane beside Observations / Timeline / Actions / Stats — a webview in
  VS Code, a natively-painted Swing pane in the JetBrains Dashboards window.
- **One implementation, two renderers**: `changemap --json` ships the *rendered* rollups
  (`files[]` / `modules[]` — churn-sorted, pre-labelled, status already resolved), so neither editor
  aggregates anything of its own. There is no second implementation to drift.

### Changed — the sidebar container is now "Claude Edits"

The activity-bar container and the bottom panel were **both** titled "Claude Observatory", so docking them
together showed two identically-named tabs with no way to tell them apart. The review sidebar
(Edits / Diffs / File History) is now **Claude Edits**; the bottom panel keeps **Claude Observatory**.

### Changed — the Stats view drops its Search box

Search now has one home: the **Search edits** action in the Edits / Diffs title bar (unchanged). The
duplicate box in the Stats navbar is gone, along with the internal `searchWith` command that only existed
to drive it. The Stats navbar keeps the active session and the clickable pending count.

### Added — a feature tour on the showcase page

`docs/showcase.html` gains a slideshow over all seventeen features — keyboard- and swipe-navigable,
autoplaying only while on screen and never when the visitor prefers reduced motion.

### Tests

- `changemap:` core test — file/module rollups, the pending > undone > kept precedence, module labels,
  chapter windows, and the unassigned-edit case.
- `ChangeMapParser` port-fidelity test (JetBrains), pinning every field the Kotlin panel reads.
- A Change Map webview block in the VS Code smoke test — asserts a hidden view spawns no subprocess and
  that a ledger row drills via `viewChanges`.
- Five `changemap --json` shape assertions in `test/e2e.sh`, including churn conservation
  (`files[].churn` sums to `modules[].churn`) and churn-desc ranking.

## [0.7.0] — 2026-07-13

Turns the observatory from a single-agent into a **multi-agent** view: subagents, sibling sessions,
and a rolled-up metrics command — all zero-token, local, and cross-editor (VS Code + JetBrains + CLI),
mined from the Claude Code transcript and the content-addressed store (no model calls, no network).
No breaking changes — the store format is unchanged and every existing `--json` shape is unchanged; the
`actions --json` payload gains additive `subagents` / `subagentsSummary` / `fleet` / `fleetSummary` fields.

### Added — Subagent tracking (CLI + both editors)

Every subagent Claude spawns (the Task / Agent tool) now gets its **own nested action timeline** plus
**per-subagent metrics** — duration, tokens, tool-use count, status. Mined zero-token from
`~/.claude/projects/<proj>/<session>/subagents/agent-<id>.jsonl` and correlated back to the spawning tool
call via the transcript's `toolUseResult` (which carries `agentId` + `totalDurationMs` + `totalTokens` +
`totalToolUseCount` + `status`).

- **CLI**: `claude-observatory subagents` (alias `agents`) — a human feed or `--json`.
- **Both editors**: a **Subagents** node in the Actions view — each subagent expands into its own
  reads / edits / bash / web calls.

### Added — Fleet / cross-agent awareness (CLI + both editors)

The **other** Claude Code sessions working in the **same project**: active/idle status (from transcript
freshness — active = touched within ~60s), pending edits, files touched, and risk-flag counts.
**Read-only and path-only** — no file contents ever cross between agents, so it can't leak one agent's
secrets to another.

- **CLI**: `claude-observatory siblings` (alias `fleet`) — an agent-facing digest an agent can call
  mid-run to see what its siblings are touching and adjust in real time. `--json` defaults to siblings
  only (excludes self); `--all` includes self.
- **Both editors**: a **Fleet** node in the Actions view.
- An optional MCP server for the same digest is noted as future; 0.7.0 ships the CLI digest.

### Added — Metrics command (CLI)

`claude-observatory metrics` (`--json`) rolls up the session's numbers: per-edit diff stats
(+added / −removed lines), action + error counts, per-subagent duration/tokens, and **tool latency**
(median / p95 / max, computed from each `tool_use` → `tool_result` timestamp gap).

### Added — governance files

`CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) and `SECURITY.md` (private vulnerability reporting via
GitHub Security advisories + `cell_observatory@berkeley.edu`; latest-release-line support policy) at the
repo root.

## [0.6.5] — 2026-07-13

QoL + observability polish on top of the Action Timeline. No breaking changes — the store format and
every existing `--json` shape are unchanged (the `actions --json` payload gains an additive `egress`
field and a per-action `risk`).

### Added — Risk + Egress audit (CLI + both editors)

Two zero-token audits mined from the action timeline (adapted from CortexIDE):

- **Risk** — flags the shell commands Claude ran that can **destroy data** (`rm -rf`, `git reset --hard`,
  force push), **execute remote code** (`curl | sh`), **escalate privilege** (`sudo`), or **touch
  credentials** — as ⚠ high/med badges on those rows in the Actions view, plus `claude-observatory risk`.
  Guarded against string/path false positives (the risky token must be a real command, not text).
- **Egress** — "what did this session touch off-machine?": WebFetch hosts, MCP servers, and
  network-shell commands, each marked **remote** or **unknown** — an **Egress** node pinned atop the
  Actions view, plus `claude-observatory egress`.

### Added — Stats top navbar (both editors)

A bar across the top of the Stats view: the **active session**, a **Search-edits** box (drives the same
filter as the Edits/Diffs trees), and the scoreboard's **pending count is now clickable** — click it to
jump to the first (oldest) edit to review.

### Changed — the inline edit highlight is now clearly visible

The whole-line green/red background over Claude's edited section was a deliberately faint 10% tint; it's
now **~0.30** with a bold **green** change-bar on added lines and a **red** one on removed lines, so an
edited region reads at a glance (both editors).

## [0.6.0] — 2026-07-13

Grows Claude Observatory from an *edit*-review layer into a *session* observatory: a new **Actions
timeline** surfaces every tool call Claude made — not just the file edits the store captures. No
breaking changes — the store format and every existing `--json` shape are unchanged; `actions` is additive.

### Added — Actions timeline (CLI + VS Code + JetBrains)

A zero-token, typed timeline of every tool call in the session — reads, greps, shell commands, web
fetches, subagent spawns, and to-do updates — mined from the Claude Code transcript and correlated with
each call's result (ok / error). File-edit actions link to their store record, so you can jump straight
to the review from the timeline.

- **CLI**: `claude-observatory actions` (alias `trace`) — a human feed or `--json`
  (`{ session, summary, actions, groups }`); filters `--category <c>`, `--errors`, `--limit <n>`, `--all`.
- **Both editors**: a new **Actions** view/panel, grouped by category (Edits, Commands, Web, Subagents,
  To-dos…). Curated by default — high-signal categories plus any errors — with a toggle to show all
  (reads/searches/meta). Errored calls are flagged; edit rows open the review.

## [0.5.5] — 2026-07-13

Adds a review **navigation bar** to the status bar in both editors — adopted from the review toolbar in
the [Void](https://github.com/voideditor/void) / [CortexIDE](https://github.com/OpenCortexIDE/cortexide)
editors. No breaking changes — the `--json` contract and on-disk store format are unchanged.

### Added — status-bar navigation bar (VS Code + JetBrains)

Beside the 🔬 scoreboard, a compact review toolbar now appears while edits await review, with two
stepping axes and inline actions:

- **Diff axis** — `▲ Diff n/m ▼` steps through the open file's pending edits (the counter opens the
  current edit's diff).
- **File axis** — `◀ File n/m ▶` steps across every file with pending edits (the counter opens the
  Edits view).
- **Keep** / **Undo** the current edit (surgical, per-edit), **Accept File** / **Reject File** (the
  whole open file), **Clear resolved**, a **Spotlight** toggle (dims unedited lines so Claude's changes
  stand out), and **Search edits**.

The bar is two-tier: the File axis, Clear, Spotlight, and Search show whenever anything is pending; the
Diff axis and per-edit / per-file actions show only when the open file has pending edits. Every button
reuses existing commands, so behavior matches the tree views and keybindings exactly. The counters track
the active editor, updating as you switch tabs or resolve edits.

### Added — the floating review bubble is now the full nav bar

The inline review bubble (opened from the ✨ marker, or by clicking the status bar's `Diff n/m`) carries
the Diff/File counters in its header and a complete toolbar: **Diff axis**, **File axis**, **Keep/Undo**
this edit, **Accept/Reject File**, and **Chat**. There is only ever one bubble — stepping an axis moves
it in place (it never spawns a second).

### Added — nav bar in the editor tab bar

The editor's top-right action row (VS Code `editor/title`) and the top-of-editor banner (JetBrains) now
surface the nav bar for the open file — Diff axis, File axis, Keep/Undo, Accept/Reject File, Clear, and
Spotlight — so the review controls are reachable without leaving the editor.

### Changed — one "spotlight" (heatmap) icon everywhere

The dim-unedited-lines toggle now uses a single lightbulb icon across every surface (status bar, editor
toolbar, and the JetBrains banner). Accept/Reject **File** use the `check-all` / `close-all` icons so
they read distinctly from the single-edit Keep/Undo.

## [0.5.3] — 2026-07-12

Bug-fix: `update` now actually refreshes the VS Code extension, and never skips an installed extension
in silence.

### Fixed — `update` silently skipped the installed VS Code extension

`claude-observatory update` detected the VS Code extension only when the `code` CLI was on PATH — which
on macOS it usually isn't — so it skipped VS Code entirely, and said nothing, even with the extension
installed. It now detects the extension by its install directory (the way it already detects JetBrains
plugin dirs) and resolves the `code` / `cursor` / `codium` / `windsurf` CLI from app-bundle locations
when it's off PATH, so it can apply the update. If an extension is installed but no CLI can be found to
update it, `update` prints an actionable fix (install the shell `code` command, or the `.vsix` from the
release) and **exits non-zero** — never a silent skip. The same "surface it, don't swallow it" rule now
applies to the JetBrains path too (missing `unzip` / asset / a failed extract is reported and non-zero,
not a quiet success).

### Changed — in-editor "Update now" no longer needs the `code` CLI

The VS Code notifier's one-click **Update now** installs the downloaded `.vsix` via VS Code's own
extension service (`workbench.extensions.installExtension`) instead of shelling out to `code`, so it
works regardless of PATH.

## [0.5.2] — 2026-07-11

Streamlines the marketplace-free update path and tightens revert semantics. No breaking changes — the
`--json` contract and on-disk store format are unchanged.

### Changed — `update` refreshes the installed editor extensions, not just the CLI

`claude-observatory update` previously reinstalled only the CLI (and exited early as "up to date"
before it even mentioned the extensions). It now refreshes everything installed on the machine from
the latest GitHub Release — no marketplace required:

- **CLI** — self-updates via `npm i -g` as before (integrity-checked against the release's sha256).
- **VS Code** — if the `code` CLI (or `cursor` / `codium` / `windsurf`) is on PATH and already has the
  extension, downloads the `.vsix` and `code --install-extension --force`s it.
- **JetBrains** — unzips the plugin into every detected IDE plugin dir that already has it (macOS,
  Linux, Remote-Dev backends, Windows), then prompts for the required full IDE restart. Idempotent via
  a `.observatory-version` sentinel written beside the plugin.

New flags: `--cli-only` (old behavior) and `--force` (reinstall even if current); `--check` now
reports the status of the CLI and both extensions and installs nothing. The VS Code update notifier
also gains a real one-click **Update now** (download + install + reload), falling back to the browser +
"Install from VSIX…" flow when the `code` CLI isn't available.

### Changed — bulk / scoped Revert acts on pending edits only

"Revert All" (session) and folder- and file-scoped Revert now revert only **pending** edits and leave
already-**Accepted** (kept) changes on disk — revert an accepted edit individually if you want it gone.
Applies identically across the CLI (`undo --under`), VS Code, and JetBrains.

### Added — `undo` bulk flags + a palette command

- `claude-observatory undo` gains `--all` (revert every pending edit in the session) and
  `--file <substr>`, matching `keep`'s bulk surface. Every bulk/scoped revert (CLI, VS Code, and
  JetBrains) now runs through one shared `core.undoScope` implementation, so the three front-ends
  can't drift.
- VS Code exposes **Claude Observatory: Show suggestions** in the command palette (previously
  reachable only by clicking a suggestion row).

### Fixed — force-restore keeps review status consistent with disk

A `--force` per-file restore (and its redo mirror) drops later edits to the same file from disk, but
those edits kept their old `pending`/`kept` status — so the tree showed a live edit whose change was
gone, and a later per-edit undo/redo computed against a mismatched file. Those dropped later edits are
now marked `undone`, so recorded status always matches what's on disk.

## [0.5.1] — 2026-07-10

Two review-workflow additions. No breaking changes — the `--json` contract only gains a field, and the
on-disk store format is unchanged.

### Added — folder- and file-scoped Accept / Revert / Clear

The edits bar can now act on a whole **folder** or a single **file** at once, not just one edit:

- **VS Code** — hover a folder or file row in the Edits/Diffs tree for inline icons: Accept all
  (`✓`), Revert all (`⟲`), and Clear resolved (`⌫`). Files already had Accept/Revert; both now also
  get Clear.
- **JetBrains** — the tree's right-click menu gains *Accept / Revert / Clear Resolved in Folder* and
  *Clear Resolved in File* (the tool window has no per-row hover icons; the context menu is the parity
  equivalent).
- **CLI** — `keep --under <path>`, `undo --under <path>`, and `clean --resolved --under <path>` scope
  each operation to a file (exact match) or folder (everything beneath it) with one shared path rule,
  so a sibling like `src/api-v2/` never gets swept by an action on `src/api/`.

Shared in `core`: each tree folder now carries an absolute `path`, `clearResolved` takes an optional
scope, and `isUnderPath` is the single file/folder-prefix predicate every surface uses.

### Added — marketplace-free update notifier (VS Code)

VS Code has no custom-repository mechanism like JetBrains', so the extension now does a throttled
(once-a-day) background check of GitHub Releases and, when a newer version exists, offers to download
the `.vsix` (with *Skip this version*). Also available on demand via **Claude Observatory: Check for
updates**. JetBrains gets real auto-update instead — add the plugin repository
`https://github.com/cell-observatory/claude-observatory/releases/latest/download/updatePlugins.xml`
under Settings → Plugins → ⚙ → Manage Plugin Repositories.

## [0.5.0] — 2026-07-10

A big review-experience upgrade on top of a full-project correctness/security/parity audit. No
breaking changes — the `--json` contract is additive only, and the on-disk store format is unchanged.

### Added — collapse same-code edits into one review unit (headline)

You can't sensibly keep or revert an edit whose result a later edit already overwrote. Successive edits
to the **same code** now collapse into a single review unit, represented by the **most-recent** edit;
edits to different regions of a file stay separate and independently reviewable. The logic lives in
`core` (`pendingGroups`/`reviewEdits`/`keepGroup`/`undoGroup`/`redoGroup`), so the CLI, VS Code, and
JetBrains all collapse identically: the Edits tree and `list` show one net rep per group, keep/undo/redo
act on the whole unit (undo runs newest-first — a clean sequential revert to the group's earliest
before-state), and the inline lens shows one action-row per line. The full per-edit sequence still lives
in the Timeline.

### Fixed — data integrity & correctness (core engine)

- **Undo no longer corrupts non-UTF-8 files.** The restore engine now writes the exact stored bytes
  on every whole-file path and compares state by sha256 instead of round-tripping through UTF-8
  (which silently rewrote latin-1 / invalid-UTF-8 files as `U+FFFD`, even on the clean-revert path).
- **The append-only store is now actually race-safe.** `clearResolved`/GC run under a per-session
  advisory lock (stale-broken so it can't wedge capture), and GC treats in-flight staging +
  `__bash__` manifest blobs as referenced — closing a window where a concurrent capture record could
  be dropped or point at a GC'd blob.
- **Stats no longer over-count tokens/messages ~2.3–2.9×.** Assistant turns are deduplicated by
  `message.id` (current Claude Code emits one JSONL line per content block with identical usage).
- **"Why Claude made this edit" is attributed correctly** — a `Bash` record (e.g. `prettier --write`)
  no longer shifts every later same-file edit's reasoning to the wrong entry.
- Blob writes are atomic (tmp + rename); the stats cache is invalidated on a timezone change; the
  "current session" stats card is internally consistent; JetBrains `listSessions` orders by log mtime
  (matching the CLI) instead of max edit-ts.

### Added — features & parity (CLI + VS Code + JetBrains)

- **CLI:** `insights` (human Observations view), `timeline` (chronological feed), and a real
  `uninstall --all` (reverts the bundled status line only if it's ours; `--purge-store` to delete
  captured edits).
- **Both editors:** a "Next steps" suggestions group, and store maintenance (reclaim disk / drop
  session) — previously CLI-only.
- **JetBrains:** an "Install capture hooks" action, and Project-view badges (`●N`) on files with
  pending edits (parity with the VS Code file decorations).
- **Dropped captures are surfaced** — files too large/binary, or a Bash tree over the cap, record a
  `skip` marker so `status` shows "not captured: N change(s)" instead of silently doing nothing.

### Changed

- **Inline review shows only the _latest_ edit per line.** Stacking a keep/undo menu per edit on a
  shared line was noisy and ambiguous; older same-line edits now live in the Timeline (undoing the
  latest surgically reveals the previous state). Consistent across VS Code and JetBrains.
- **JetBrains performance:** memoized session resolution, blob reads moved off the EDT, faster macOS
  store watching (~2 s vs ~10 s), a StatsPanel timer/listener leak fixed, and a `locate` subprocess
  hang/deadlock guarded with a timeout.
- **Onboarding accuracy:** correct `npm prefix -g` guidance (was the removed `npm bin -g`), a
  working `status` hook-health check for the portable hook, and honest Bash-capture docs.

### Security

- Store directories are created `0700` and blobs/log `0600`; the Bash full-tree walk skips
  secret-bearing names (`.env`, `*.pem`, `id_rsa`, `.npmrc`, …) so it never vacuums them into the store.
- Fixed a ReDoS in the observations "next steps" parsing (O(n²) on transcript-mined text).
- Session ids are validated before any store path, closing `clean --drop ../…` arbitrary deletion.
- Self-update verifies the release asset's sha256 before `npm i -g`, and downloads to a private
  `0700` temp dir.

### Build / CI

- `version:set` now updates `package-lock.json` (and `version:check` verifies it), so a bump can't
  redden `npm ci`. Release + CI use the pinned Gradle wrapper (`./gradlew`). Added Dependabot and a
  guarded `npm publish --provenance` release step.

### Tests

- A regression test ships with every fix, plus a `--json` contract golden test (rename-guard for both
  editors) and JetBrains port-fidelity tests (`TreeParser`/`ObserveParser` + a discriminating
  `listSessions` test).

[0.5.0]: https://github.com/cell-observatory/claude-observatory/releases/tag/v0.5.0
