# Changelog

All notable changes to Claude Observatory are recorded here, following
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Per-tag release artifacts and auto-generated notes are on the
[Releases page](https://github.com/cell-observatory/claude-observatory/releases).

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
