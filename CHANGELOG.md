# Changelog

All notable changes to Claude Observatory are recorded here, following
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Per-tag release artifacts and auto-generated notes are on the
[Releases page](https://github.com/cell-observatory/claude-observatory/releases).

## [0.8.6] — Unreleased

A quality-of-life sweep across the CLI, core, both editors, and the docs.

### Added

- **JetBrains parity — the opt-in Claude-insight feature is now reachable**: "Refresh Recap (Claude)"
  on the Observations toolbar and "Analyze Edit with Claude" on an edit (previously the `analyze`/`recap`
  backend and the `claudeBin` setting were wired to nothing).
- **JetBrains parity — 10 session actions registered** (Setup Check, Export Review Summary, Switch
  Session, Clean Store, Install Hooks, Accept All, Revert All, Clear Resolved, Spotlight, Search), so
  they appear in Find Action and can be keybound.
- **JetBrains parity** — Previous/Next edit stepping from inside the diff viewer, and a "Pinned session"
  field in Settings → Tools → Claude Observatory.
- **CLI** — `clean --json`, per-command `--help`, and a `keep #<id> · undo #<id>` next-step footer after
  `diff`. `help` now documents the `chapter` command, `undo --ids`, the `trace`/`agents` aliases,
  `doctor --markdown`, `version --latest`, and `clean --session`.

### Changed

- **Consistent terminology & emoji-free copy** — unified the Keep/Undo verbs across the CLI and VS Code
  (the stored/JSON `status` value is unchanged), standardized the CLI warning glyph on `⚠`, and dropped
  decorative 🎉/✨/💡 from output and settings descriptions.
- **VS Code** — rebound `⌥⌘[` / `⌥⌘]` off the built-in Fold/Unfold (→ `⌥⌘-` / `⌥⌘=`); scoped
  `reviewNext/Prev` to `!terminalFocus`; hid context-only commands from the Command Palette; de-conflicted
  the review/spotlight/heatmap icons; fixed the blank "Revert all edits" icon and unified the revert-scope
  glyph; replaced a persistent inline-toggle toast with transient status text.
- **JetBrains** — routine Keep/Undo confirmations now use a transient status bar instead of piling
  balloons into the Event Log; the inline-lens Chat action got a glyph; File History's prev/next diff
  buttons are now directionally distinct.
- **Core robustness** — `settings.json` and the hooks file are written atomically (temp + rename);
  `usageLine` reads a bounded transcript tail instead of loading the whole file; the session-resolution
  caches are capped (like `fscache`); `stats` skips out-of-window sessions.
- **Docs** — documented the Node 18+ and `jq` prerequisites; the Remote/SSH guide now leads with the
  bootstrap one-liner; `bootstrap.sh` continues past an npm global-install permission error (instead of
  aborting the rest of the install) and only downloads the JetBrains plugin when a JetBrains IDE is present.

### Fixed

- **JetBrains: `claude-observatory update --check` no longer reports a current plugin as perpetually
  out of date.** The installed version is now read from the plugin's own jar
  (`lib/claude-observatory-jetbrains-<ver>.jar` — present for every install method: the bootstrap
  script, the IDE's **Install Plugin from Disk**, and `update`), instead of a `.observatory-version`
  sentinel that only `update` ever wrote. The sentinel remains a fallback.
- **CLI** — bulk `keep`/`undo` no longer print a false-green `✓ … 0 edit(s)` when nothing matched; an
  unexpected error in a synchronous command now surfaces as `claude-observatory: <message>` instead of a
  raw Node stack trace; and `stats`/`usage` validate a provided `--session` like the other commands.
- **Core** — a garbage-collected or externally-deleted blob no longer crashes the metrics / review /
  Overview rollups (it degrades to an empty diff, matching the other readers); unguarded
  `Math.min/max(...array)` at five sites are replaced with loop-based helpers, so a very large session
  can't blow the call stack while building the Overview; and `init` on a malformed `settings.json` points
  at the `.bak` instead of dumping a raw `SyntaxError`.
- **JetBrains** — session-wide **Revert All** and the Edits-tree **Clear Resolved** now report "Nothing
  to revert" / "No resolved edits to clear" instead of silently doing nothing (no-silent-fail parity).
- **Docs** — the "Remote development" guide link (referenced from the VS Code, JetBrains, and devcontainer
  READMEs) now resolves — its target is a real heading; the `status` sample output and a demo file-path
  inconsistency in DEMO.md are corrected.

## [0.8.5] — 2026-07-21

### Added

- **The self-hosted auto-update paths are now surfaced and wired — getting the latest is effortless on
  every surface, still with no marketplace.** The machinery already shipped; this release makes it
  discoverable and turns every install into an auto-updating one.
    - **JetBrains auto-update, documented at last.** The self-hosted plugin repository (regenerated and
      attached to every GitHub Release) is now printed by every install path — `scripts/bootstrap.sh`,
      `scripts/install-jetbrains.sh`, and `claude-observatory update` — and documented in the README,
      the JetBrains plugin README, and the docs site. Add
      `…/releases/latest/download/updatePlugins.xml` once under **Settings → Plugins → ⚙ → Manage Plugin
      Repositories** and the IDE keeps the plugin current like any Marketplace plugin.
    - **A once-a-day "update available" nudge in the CLI.** Any interactive command now checks (at most
      once per day, in a detached background process) whether a newer release exists and prints a single
      one-line notice — cache-first so it never delays a command, silent when offline, and skipped for
      the capture hot path, `--json` output, and non-interactive callers. Opt out with
      `CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1`.
    - **`claude-observatory version --check`** prints your installed version next to the latest release
      (a live check; bare `version` / `-v` / `--version` stay a plain one-line print for scripts).
    - A canonical **"Keeping up to date"** section in the README (with a direct `releases/latest` link)
      plus per-surface notes in the VS Code and JetBrains package READMEs and the docs site.

### Changed

- **The VS Code in-editor updater now verifies the download.** The one-click **Update now** notifier
  checks the `.vsix` against the release's published **sha256** before installing (parity with the CLI's
  integrity check) and refuses a mismatch. The notifier itself — a daily background check with
  **Update now** / **Check for updates** — is now documented outside the changelog.
- `claude-observatory update` is described accurately as refreshing the CLI **and** the installed editor
  extensions, not just the CLI.

### Fixed

- **PyCharm/JetBrains: the Overview toolbar no longer clips on a narrow tool window.** The top row
  (session + Accept All / Revert All / Clear Resolved / Export on the left; Search / Active Only /
  Spotlight / Refresh on the right) keeps its left/right split when there's room and now **wraps** the
  right cluster onto a second line when the window is too narrow — mirroring the VS Code toolbar's
  `flex-wrap`. A headless geometry test locks the fit-vs-wrap behavior in.

## [0.8.4] — 2026-07-17

### Fixed

- **Stub-proof session resolution** (both editors + CLI). Local commands (`/effort`, `/model`),
  interrupted commands, abandoned prompts, and `/resume` boot-orphans write transcript files with no
  assistant record; the newest-mtime rule let them displace the session under review, emptying every
  panel behind a misleading "Install the capture hooks" prompt. The active session is now the newest
  transcript **with an assistant record** — demoted, never skipped: an all-stub directory still falls
  back to newest, so first-turn projects and the demo fixture keep resolving.
- **Non-UTF-8 files can no longer be corrupted by a surgical undo/redo.** The 3-way merge path now
  verifies all three inputs round-trip UTF-8 and refuses (conflict, with the byte-exact `--force`
  restore offered) instead of silently rewriting bytes as U+FFFD.
- `doctor` no longer blames working hooks for a fresh or command-only session, and now surfaces
  symlinked subtrees (whose Bash-driven changes the tree diff skips for loop safety).
- Removed the last leftover Clear File wiring (declared removed in 0.8.3; JetBrains never had it).

### Added

- **Four review axes in the Overview nav bar** (both editors). The step-through nav bar grew from two
  axes to four — **Diff · File · Folder · Chapter** — so a reviewer can walk the pending edits at the
  granularity that fits the change:
    - **Folder axis** (new) steps between the changed directories (the change-map's folder buckets),
      shows the folder with its file/edit totals, and accepts or reverts that folder's edits only.
    - **Chapter axis** steps between the session's subtasks (chapters, from Claude's own to-dos/tasks),
      shows the chapter's folder/file/edit totals, and carries Review · Accept · Reject · Chat. The
      chapter's name is shown in the change-map's bottom summary rather than inline.
  The Diff axis gains **Chat** (hand this edit to your Claude) and **View diff** (a real side-by-side
  diff, not the floating lens) plus the edit's relative time; the File axis shows the filename and its
  edit count. Grouping is by chapter (Claude's to-dos/tasks, unified), which is total, and members
  come back in capture order; core adds `chapterForEditId` / `sessionChapters` and the CLI a
  `chapter --of-edit <id> --json` verb. Zero token.
- **The Overview nav bar is now two rows**: the review axes on the bottom, and on top the session
  selector (which now shows the session's **human-readable name**, not its id), the session-wide bulk
  actions (Accept All · Revert All · Clear Resolved · **Export**), and Search · Active only ·
  Spotlight · Refresh pinned right.
- **The change map is labeled and navigable.** Its three sections — **Chapters** (subtask chips),
  **Folders** (the proportional strip), and **Files** (the churn-ranked ledger) — now carry captions
  and hover descriptions, and clicking a folder tile or a chapter chip **navigates the matching nav-bar
  axis**. A **bottom summary bar** reports the pending / accepted / reverted edit counts plus file and
  folder totals for whatever is in scope, naming the current chapter (or folder filter).
- **Hover descriptions** throughout the Overview: the Fleet / Workflows / Tasks panes each open with a
  one-line description, and the tabs, sections, and usage rows explain themselves on hover.
- **Overview panels no longer clip row text** (VS Code): Fleet worktree names, subagent descriptions
  and current tasks, the Tasks list, and workflow agent names wrap to full text instead of ellipsis —
  matching the workflow-name treatment.
- **Honest empty states** (both editors): three mutually exclusive variants — hooks missing / fresh
  session with prior work / fresh workspace — with a one-click **Switch to previous session** for the
  newest same-workspace session that has edits. The Actions view gains an empty state in VS Code.
- **JetBrains whole-file review shortcuts**: `⌃⌥K` / `⌘⌥K` accepts and `⌃⌥R` / `⌘⌥R` reverts every
  pending edit in the active file (parity with VS Code).
- **Manifesto** — a new site page on the philosophy, audience, design decisions, and credits.

### Changed

- **Bash capture is memoized.** A per-session `(mtimeMs, size)` stat cache makes the before/after
  tree walks stat-only for unchanged files (binary verdicts cached too), with a GC-self-healing
  blob-presence guard and a racily-clean 2 s epsilon. Steady state ≈145 ms per Bash call, down from
  ≈200–260 ms; behavior (manifest, deletion detection, skip markers) is unchanged.
- **JetBrains worktree discovery is gated**: the ~10 s `multitask` scan runs only when a new project
  directory actually appears, not every 15 s.
- `clean` reclaims log-less stub-session directories (staging-guarded — an in-flight capture is
  never touched) and reports what it pruned.
- Relative times gain week/month buckets (`3w ago`, `2mo ago`) in both editors.
- Nav bars: grouped, labeled icons with full-width groups; status-bar parity; dark clear tint.
- **Stats** shows the session by name (id in the tooltip), and the Usage **5h / weekly** bars now
  report `~used / total`, projecting the 100% budget from the tokens observed against the reported
  percent.

## [0.8.3] — 2026-07-16

### Added

- **The Overview tracks Claude's task list — fully linked to chapters and edits** (CLI + both
  editors). A third left-nav tab — Fleet · Workflows · **Tasks** — shows the session's numbered tasks
  (Claude Code's newer TaskCreate/TaskUpdate system). Task events are mined from the transcript and
  merged into the same snapshot stream as the TodoWrite to-dos (todos win duplicate titles), so a
  task-planned session gets **real chapters with edit attribution and per-task Accept / Reject /
  Clear** — work that used to pile into the synthesized session chapter now lands under its task. Tab
  rows join their chapters (`chapterId`) to carry live `+added −removed · edits · pending` counts,
  statuses show with a done badge / spinner label / strikethrough, and the transcript history keeps
  archived tasks visible after the runtime prunes their files. `multitask --json` gains the `tasks`
  array (additive), TaskCreate/TaskUpdate classify under To-dos in the Actions timeline, and the
  bundled demo seeds three linked tasks (removed without residue by `demo --clean`). The tab lists
  newest first, completed tasks fold behind a "N done · show all" row (the fleet's dismiss pattern),
  and the Active-only toggle hides them outright. The chapter-row chip buttons also switched to the
  same codicons the Overview toolbar uses.

### Changed

- **Live conflicts moved to the Actions panel** (both editors): the cross-agent contested-files list
  now leads the session's audit surface — expanded by default, orange, click a file to open it — and
  the Overview's fleet nav dropped its conflicts strip. Fleet rows keep their per-agent ⛒ collision
  badges.
- **Revert All warns like it means it** (both editors): the confirmation is now a warning-grade
  dialog stating the full blast radius — "Revert N edit(s) across M file(s)… this rewrites the files
  on disk" — with an explicit count-bearing button, replacing the softer question-style prompt.
- **Nav-bar overhaul** (both editors — the review nav bar on every surface, the Overview toolbar,
  and every panel toolbar/context menu):
  - **Color-coded by action**: keep/accept green · undo/reject red · nav chevrons blue · clear
    orange · search/spotlight/chat purple (the shared chart palette), applied consistently wherever
    an action icon appears — toolbars, chapter chips, context menus, the editor banner, the floating
    lens.
  - **Labeled status bar**: every action button in the bottom status bar carries its short label
    beside its tinted icon; the chevrons stay arrow-only, framing the live File n/m / Diff n/m
    counters.
  - **One icon per action, no glyph reuse**: the session-wide bulk pair got their own glyphs —
    Accept All is now a checklist (VS Code `checklist`, JetBrains commit-check) and Revert All a
    history-rewind (`timeline-view-icon` / VCS history) — so they no longer share icons with the
    file-scoped Accept File (double-check) / Reject File (✕) or the per-edit Keep (✓) / Undo (↩).
    Chapter chips use the bulk glyphs (they ARE the bulk actions scoped to a chapter).
  - **Chat has a real icon**: `comment-discussion` in VS Code (chips, subagent rows, the CodeLens)
    and a speech balloon in JetBrains — replacing the 💬 emoji and JetBrains' lightbulb collision
    with Spotlight. Action icons no longer use emoji anywhere (the 🔬 brand mark stays).
  - **Clear File removed** everywhere: the session-wide Clear Resolved covers it (it was the only
    duplicate-icon action left, and redundant — kept/undone rows clear regardless of file).
  - **The Overview toolbar arranges into five spaced groups** (both editors): Search · session ·
    Active only | Diff axis · Keep · Undo | File axis · Accept/Reject File | Accept All · Revert All ·
    Clear Resolved | Spotlight · Refresh. The JetBrains status bar adopts VS Code's Diff-before-File
    order, and its toolbar-only fleet filters (Clear Completed · Show Hidden · Clear Done Chapters)
    are gone — Active only already hides completed rows, and chapter clearing lives in the chapter
    context menu.
  - **The JetBrains editor banner spells out its buttons**: the bare ↑ ↓ ◀ ▶ ✓ ↩ glyphs became
    labeled, tinted buttons — Search · Prev/Next Edit · Prev/Next File · Accept File · Reject File ·
    Clear · Spotlight — the same icons the nav bar wears.
  - **The Panels reference page shows panels only**: the status-bar / tab-bar / bubble glyph legends
    came off `panels.html` — the workspace map and the per-panel gallery remain, and the gallery
    gains dedicated **Fleet / Workflows / Tasks** figures plus the five-group toolbar in the
    Overview diagram.
  - **All site mockups and GIFs regenerated emoji-free**: the demo/media mockups draw the real
    codicon shapes (mini SVGs) with the product's labels, tints, and the current toolbar — no more
    emoji stand-ins (the 🔬 brand mark stays). The ledger's pending marker likewise switched from
    the ⏳ emoji to the monochrome ⧗ glyph in both editors.
- **Per-platform CI badges**: the CI matrix split into per-OS workflows (Linux · macOS · Windows)
  plus dedicated VS Code (.vsix build) and JetBrains (Gradle suite + plugin zip) workflows, so the
  README now carries live status badges for each platform and editor alongside CodeQL, Pages,
  Release, Dependabot, the latest release, and the license.

## [0.8.2] — 2026-07-16

Presentation fixes across the JetBrains Overview and the web demos.

### Fixed (JetBrains)

- **Spotlight works, everywhere it's offered**: the editor banner's icon-only buttons (Spotlight,
  Clear, and the new Search) rendered their icons but had no clickable hyperlink region — the toggle
  never fired from the banner. They now carry clickable text labels, the dim highlighter renders above
  the syntax layer, and toggling confirms itself with a notification (spotlight only dims files that
  have pending edits).
- **Sparklines and symbol buttons render properly**: activity sparklines are now custom-painted bars
  (the Unicode block glyphs fell back to giant placeholder boxes in IDE fonts), and the chapter ribbon's
  Accept / Reject / Clear mini-buttons, the done-chapters toggle, and the editor banner's search button
  (a tiny "⌕" text glyph) use platform icons instead of glyph text.
- **Fleet / Workflows rows carry the VS Code colors**: working/running blue, done green, awaiting
  orange, errored red, subagents purple, +added green / −removed red, and chart-blue sparklines — the
  same palette the VS Code webview reads from its chart tokens.
- **Workflows tab gets a real renderer**: run, phase, and agent rows are styled and elided like the
  Fleet tab (name in regular text, metrics grayed, painted sparkline) instead of raw clipped strings.
- **Overview toolbar shows text labels** on the same buttons VS Code labels (Keep, Undo, Accept /
  Reject / Clear File, Spotlight, Search, Accept All, Revert All, Clear Resolved, Refresh, Active
  only); the four step chevrons stay icon-only, and the status-bar nav bar stays compact.
- **Change-map detail is readable**: chapter titles, the done-toggle, and the readout move up to the
  standard label font; the chapter ribbon is height-capped and scrolls (a huge session no longer fills
  the panel with chapter rows).

### Changed (both editors)

- **Search Edits leads every nav bar** — the Overview toolbar, the status-bar nav, the editor banner,
  and the Edits tree toolbar all put Search first, in both editors.
- **Search now narrows the Overview ledger too** (it used to filter only the sidebar trees), with a
  readout naming the active query so a filtered-empty ledger never reads as a bug.
- **The module strip caps at 11 segments** — the churn-ranked tail merges into one gray "+K more"
  segment instead of squeezing dozens of unreadable slivers across the strip.
- **The dashboards default to Observations 10% · Overview 80% · Stats 10%** — the master-detail
  Overview is the centerpiece. JetBrains applies the split on every start; VS Code applies it where
  the panel hasn't been manually arranged yet (`initialSize` weights). The ribbon's per-chapter
  Accept / Reject / Clear buttons also grew to a comfortable click size in VS Code.
- **Live-conflict entries open the file**: click a conflict row (VS Code) or the conflict strip
  (JetBrains — a chooser when several files collide) to jump into the contested file.

### Changed (site)

- **The showcase lead demo is fully self-running**: it simulates the review clicks itself (the target
  control flashes as it "presses") and loops continuously; the transport row (dots / skip / pause /
  restart) stays for jumping around, and a gate reached while paused still resolves itself — the
  hands-on version lives on the demo page. Review and Tour left the nav.
- **The full demo got closer to the real editor**: a Claude Edits sidebar joins the IDE frame, the
  stage is wider with no inner scrollbars, and review gates now show a countdown and apply themselves
  if the visitor doesn't respond — interaction is optional everywhere.

## [0.8.1] — 2026-07-16

PyCharm parity fixes and an interactive web demo. No store or `--json` shape changes.

### Added

- **Interactive web demos**: the [showcase](https://cell-observatory.github.io/claude-observatory/)
  now leads with a compact, autoplaying in-browser replay of the bundled demo scenario (gates
  self-resolve while it autoplays; any click hands over control), and a detailed
  [demo page](https://cell-observatory.github.io/claude-observatory/demo.html) lays the same session
  out the way the panels sit in the editor — the file on top, the Observations / Overview
  (Fleet nav + chapter ribbon + module strip + churn ledger) / Stats dashboards docked below, with the
  visitor keeping one edit, reverting another, and accepting the rest. Pure client-side; nothing calls
  a model. The stale local `demo/` scratch folder is gone (the CLI simulator's `observatory-demo/`
  folder is unchanged).

### Changed

- **The demo scenario is now a Python training pipeline** everywhere it appears — the bundled
  `claude-observatory demo` simulator, both web demos, the site mockups, the recorded GIFs and
  screenshots, and the README / walkthrough examples: `src/features.py` gains z-score scaling,
  `src/train.py` wires it in, `src/models/dataset.py` gains `validate()`, a subagent writes
  `tests/test_pipeline.py`, and a workflow writes `docs/USAGE.md`.

### Fixed

- **Live workflow runs show real agent labels again** (CLI + both editors). Newer Claude Code runtimes
  journal only a content-hash key per agent — no label or phase — so a running fan-out degraded to
  `workflow-subagent <id>` rows until completion. Core now derives each live agent's label from its own
  prompt (the first line not shared with its siblings — fan-out prompts share a preamble and diverge at
  the task line), marked with the `~` heuristic convention; the runner's real labels still replace them
  when the run's state file lands.

### Fixed (JetBrains)

- **Blank Overview detail pane**: `JBList` wraps its cell renderer, so reading `cellRenderer` back and
  casting it threw a `ClassCastException` mid-construction and left the master–detail right side
  permanently empty. The renderer is now held directly, and a detail-render failure now paints a visible
  error label instead of a blank pane.
- **Invisible sidebar tabs**: the Edits / Diffs / File History / Actions tabs were icon-only (empty
  display name), which the new UI renders as blank tabs — they now carry their names.

### Changed (JetBrains, VS Code parity)

- **Stats navbar drops the Search-edits box** — VS Code's Stats bar names the session only; searching
  edits lives on the review nav bar (Overview toolbar + status bar).
- **Review nav bar reordered to the VS Code order** — File axis before Diff axis, then Keep / Undo,
  Accept / Reject File, a clear button, Spotlight, Search. The clear button is scoped per host, as in
  VS Code: the Overview title bar carries the new file-scoped **Clear File**, while the status bar keeps
  the session-wide Clear Resolved. The Overview toolbar now leads with the session selector and
  Active-only toggle, with bulk Accept / Revert / Clear Resolved and Refresh after the nav bar and the
  fleet filters last.

## [0.8.0] — 2026-07-15

Real-time multi-agent observability. Observatory now shows *everything Claude is doing across parallel
agents* — including agents running in separate git **worktrees** of the same repo — as it happens. Still
zero-token, local-only, git-free, and cross-editor (CLI + VS Code + JetBrains). No breaking changes: the
store format is unchanged, every existing `--json` shape is preserved (additively extended), and the new
commands are new. Two behavioral notes: the Change Map / Overview chapter id is now a stable content-hash
**taskId** (was positional `ch0`), and chapter attribution is now **total** — the Overview never shows an
"unassigned" bucket (see below). Both editors' renderers were updated in lockstep.

### Added — the Multitasking window (CLI + both editors)

A new bottom-panel view that answers *who is doing what, right now*. One row per running agent (unified
**across worktrees** — see below), each with a live **phase** (working · awaiting-input ·
**awaiting-permission** · idle · errored · done), its worktree + branch, an activity sparkline, its ±diff,
risk count, and a collision badge. Nested under each agent are its **subagents** with their type,
description, current task + to-dos, ±lines, and a chat button. A cross-agent **file-collisions** strip
flags any file two or more agents have touched. Backed by the new `multitask --json` command; both editors
are thin renderers. Real-time: VS Code rides its transcript watcher; JetBrains gained a new
**`TranscriptWatcher`** (per-directory `nio` registration with dynamic new-dir handling and an
ENOSPC→poll fallback) so *all* panels now refresh on any tool call, not only on edits.

### Added — git worktree correlation (git-free)

Claude Code keys its session storage by working directory, so two agents in two worktrees of one repo
land in different project folders that the old fleet view could never connect. Observatory now correlates
them by reading the worktree's `.git` pointer files (`gitdir:` → `commondir`) — **plain-file reads, never
the `git` binary** — and unions them into one logical fleet. Also new: **fleet conflict detection**
(`fleetConflicts`), computed over the *uncapped* file set so a busy agent's 21st shared file is never a
silent miss.

### Changed — the Overview view: master–detail across agents and workflows

The Overview (née Change Map) is now a master–detail panel: a left nav of **Fleet** (running agents
across worktrees, with nested subagents) and **Workflows** (runs), and a right detail showing the
selected item's change-map — chapter ribbon, module strip, and churn-ranked ledger. The old count/size
toggle is **gone** — it always sizes by ±lines now. An **Active only** toggle sits in the title bar
(both editors). And when a **new workflow run starts**, the nav auto-focuses it — switches to
Workflows, selects the run (VS Code pulses its row), and tracks its subagents, phases, and edits live;
the first payload after opening only seeds the seen-set, so opening the panel never steals focus.

### Changed — chapters are total: the Overview never shows "unassigned"

Every edit now belongs to a named chapter. Work done between to-dos fills forward to the nearest
preceding chapter; trailing work joins the final chapter; and a session with no to-dos at all gets a
single **synthesized session chapter**, titled from the session's own title or the first prompt — a goal,
never a bookkeeping bucket. Chapters carry an explicit strict `taskId` for the analytics join and the
💬 chat framing (`null` on the synthesized chapter and duplicate-content rows), and the strict
`unassigned` rollup stays in the JSON for scripts. Chapter review ops are **WYSIWYG**: Accept/Reject/Clear act on exactly
the edits the chapter row displays (`reviewEditIds`) — including gap-filled members and the synthesized
session chapter — so accepting a chapter never leaves stragglers behind, and a partial accept can never
strand edits the buttons can't reach. (Reverts remain conflict-guarded per edit — a mis-anchored undo
surfaces as a conflict, never a silent clobber.) Two to-dos with identical text also stopped
colliding on one ribbon row: the first occurrence keeps its stable id, later occurrences render
display-only. Workflow slices carry their own core-built chapter rollup, replacing both editors'
hand-rolled residual math (which double-counted in JetBrains).

### Added — `demo`: a live simulator that is also a test harness

`claude-observatory demo` replays a scripted session through the **real pipeline** — a genuine transcript,
edits captured by the same hook logic, a subagent with its own timeline, and a workflow run — inside an
isolated `demo-<hex>` session and an `observatory-demo/` folder. Open the Overview and watch chapters,
fleet rows, and observations fill in live; then review the edits for real (Accept/Reject genuinely work).
Nothing leaks: a fully reviewed demo session clears its own store, and `demo --clean` removes every trace.
`--fast` lands the whole scenario in under a second — the e2e suite drives every 0.8.0 `--json` surface
off it. The demo also records itself: `scripts/record-demo.mjs` snapshots the real `--json` payloads at
every beat, renders each through the actual Overview webview code in headless Chrome, and assembles
three recordings — the run (`demo-live.gif`), the workflow arc from the Workflows nav
(`demo-workflow.gif`), and the chapter-by-chapter review ending in the auto-clear (`demo-review.gif`) —
so the site's demo footage is the real UI fed by a real run, never a mock. A PyCharm counterpart
(`scripts/render-pyc-demo.mjs` → `demo-pyc.gif`) mirrors the same beats in the JetBrains panel's native
layout, and the **Getting started** page is built from these recordings end to end.

### Fixed — multi-agent tracking accuracy (stabilization pass)

- **Phase confidence is explicit.** `awaiting-permission` / `idle` / `done` have no transcript marker and
  are inferred from inactivity; agents, subagents, and siblings now carry `phaseConfidence`
  (`high`/`heuristic`) and both editors mark inferred phases with `~` instead of asserting them.
- **Workflows stopped flapping.** A workflow's `running` gate widened from the fleet's 60s freshness to a
  5-minute `WORKFLOW_ACTIVE_MS` (a long reasoning turn writes nothing for minutes); killed runs still age
  out, and a new `lastActivityMs` lets renderers say "active 3m ago".
- **Journal keys can't fake phases.** A key-derived phase is trusted only when it slug-matches a declared
  phase title or is shared by 2+ agents — a future hash format that slips past the regex can no longer
  render one bogus "phase" per agent. The script-meta parser is also string/comment-aware now, so braces
  inside a `description` can't mis-slice it.
- **Collisions include idle victims.** A file pending in two agents now flags when *either* is active
  (was: only when both were) — a live agent can trample an idle agent's unreviewed work. `activeAgents`
  names the moving side so renderers dim the rest.
- Dead code removed: the superseded `overviewTabs` prototype in the VS Code extension.

### Performance — the Overview loads ~2× faster

One Overview refresh used to re-read and re-parse the same multi-megabyte transcript ~6 times per view
(and per worktree-sibling). Core's pure parsers are now memoized per `(mtime, size)`, `changemap` no
longer builds the active session's map twice, and JetBrains panels share one throttled fetch per view
(≤1 CLI spawn per view per ~3s, mirroring VS Code's webview throttle) instead of ~4 spawns every 2s.
On an 18 MB transcript: `changemap` 0.63s → 0.30s, `multitask` 0.68s → 0.40s, before multi-agent gains.

### Added — three-level change tracking, honestly attributed

Every edit is now attributed per **task**, per **subagent**, and per **agent**. Task attribution uses
**strict** in-progress intervals (no edge-filling), so an edit made before the first to-do or after the
last one completes is honestly **unassigned** — never force-filed onto a neighbouring task. Subagent
attribution partitions the store by each subagent's action window; a same-file edit that can't be
unambiguously attributed is left unassigned on **both** sides rather than positionally guessed.

### Added — task-scoped keep/undo + a cross-agent task log

`task-keep`/`task-undo` resolve a taskId to exactly the edits inside its real in-progress intervals (a
destructive-safety invariant: a task's undo set never includes an edit that wasn't part of that task).
`tasklog --json` (`crossAgentTaskLog`) gives one row per task, unioned across every worktree-sibling and
subagent that contributed to it.

### Added — context-preloaded chat about any action

Chat with Claude about **any** action, edit, subagent, or task with the right context pre-assembled —
`chat-context --json` builds a ready-to-paste prompt (target + Claude's own reasoning + the before/after
diff or command/result + task/subagent framing) in core, and the editor hands it to your own Claude.
**Zero-token** — Observatory never calls a model. Replaces the old edit-only chat handoff on every surface
in both editors.

### Fixed — the store's single-writer id hazard

`nextId` read the log outside the append lock, so two concurrent subagent captures (they share one
session) could allocate duplicate ids. Ids are now allocated inside the lock, each record carries a
collision-proof `uid`, and `readLog` re-keys any residual duplicate — so parallel-agent captures can't
corrupt the byId fold, status ops, or undo targeting.

### Tests

Extensive new coverage across the layer: worktree resolution (subdir-launch walk-up, dir/file `.git`,
relative/absolute `commondir`, symlink realpath, bare-repo guard); repo-sibling union + the uncapped
collision regression; the store id-hazard reconciliation; live phase (incl. the stale-mtime
awaiting-permission heuristic) and subagent todos; the hardened linker (overlapping same-file windows →
both unassigned); strict-span taskId (head/tail edits → strictly unassigned, while the display chapter
stays total) + the `tasks[]`↔`rollupByTask` id-space join; the cross-agent task log; task-scoped undo's
destructive-safety invariant; the chat-context assembler (never spawns); chapter totality (no-to-do
sessions, gap/trailing edits, duplicate-content to-dos, ts-less edits); the parser-cache invalidation
contract; workflow freshness boundaries and journal-key trust rules. A new **fast contract rename-guard**
pins the key set of every 0.8.0 machine surface (`multitask`, `changemap`, `tasklog`, `chat-context`,
`observations`, `metrics`, `siblings --repo`) against a demo-simulator fixture, so an editor-breaking
rename fails `npm test`, not just the bash e2e. Plus a new e2e block driving the demo end-to-end
(attribution, auto-clear, `--clean`), VS Code smoke coverage of the master–detail Overview + total
chapters, and JetBrains port, `TranscriptWatcher`, and `MultitaskFilter` parity tests.

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
