# Changelog

All notable changes to Claude Observatory are recorded here, following
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Per-tag release artifacts and auto-generated notes are on the
[Releases page](https://github.com/cell-observatory/claude-observatory/releases).

## [0.8.9] — 2026-07-25

**Demo mode, in both editors.** The demo simulator has existed since 0.8.0, but only in the terminal —
neither editor had a way to reach it. It is now one command away in both: **Start Demo Mode** replays a
scripted Claude Code session through the real capture pipeline while you watch the panels fill, then
opens a **guided tour** that walks every surface, one step at a time, activating the panel it is
describing and ringing the control it names. Starting the demo again **resets** it, the
replay is **cancellable**, and **Exit Demo** removes every trace it wrote. Nothing calls a model, and the
capture hooks need not be installed — which makes it the first thing a new reader can try.

### Added

- **Demo mode in VS Code and JetBrains.** `Start Demo Mode`, `Restart demo`, `Guided tour`, `Exit demo
  mode` — in the command palette, on the Edits and Overview title bars, and in every empty state, so a
  workspace with no Claude session yet offers the demo instead of only explaining why it is empty. In
  JetBrains the same three verbs sit on the Edits panel's toolbar and in Find Action, and the Edits empty
  state offers the demo too. The replay runs in-process in VS Code and as a streamed background task in
  JetBrains, narrating each beat.
- **The guided tour.** Forty-one steps covering every panel the product ships and every named
  feature — the five Overview tabs, the change map's Folders strip, Files ledger, summary bar and feed,
  the four review axes, the Edits **and Diffs** trees, inline review, Spotlight, File History and
  revision navigation, search and Active only, the chat handoff, export, the status bar, the Explorer
  badges, the Risk and Egress audits, context sources, file memory, and Stats. It opens with a choice of
  **Essentials** (13 steps) or **Everything** (41); finishing the short one offers the other 28 as its
  own track, in both editors. All
  three are filters over the same list, so they can never tell different stories. The script lives in core (`demoTour()`), so the terminal, VS Code and
  JetBrains all show the same tour in the same order; `claude-observatory demo --tour [--essentials]`
  prints it as prose.
- **The tour plays itself.** Each step holds long enough to read it — derived from its own text, three
  and a half to nine seconds — and any control that moves the tour (Next, Back, a step jump) hands you
  the wheel, with a transport button to resume. Docking or floating the window does not.
  A **YOUR TURN** step shows a countdown and, if you do nothing, performs the action itself and says so,
  so a reader who only watches still sees Keep and Undo actually happen. VS Code honours
  `prefers-reduced-motion` and starts paused; the JetBrains platform exposes no such signal, so it starts
  playing and the button is the control.
- **The tour docks beside your code**, and detaches into a window of its own when you would rather have
  it on a second screen. The choice is remembered.
- **The demo is offered on a first install and once after an update** — one notification, four seconds
  after startup, with **Never ask** on it. Skipped while a Claude session is live in that project, in an
  untrusted workspace, and once a demo is already recorded there.
- **The tour holds the Overview's Active only filter open** while it runs, because five of the demo's six
  tasks are completed and the filter hides completed tasks by default — so a step that says "accept task
  1" now names a row that is on screen. Your own filter and your own tab come back when the tour ends.
- **The control a step names is ringed.** The step's text lives in the tour window; the control it points
  at is outlined in place — a CSS outline in VS Code, a glass-pane painter in JetBrains, neither of which
  reflows the panel being pointed at. Neither editor can draw over IDE chrome it does not own — the
  activity bar, the tab strip, the status bar — so for those the step's text names the control instead.
- **A scenario that leaves no panel empty.** The simulated session now runs to **three prompts, six
  tasks and nine edits**, and adds the cases whose surfaces could previously only render an empty state:
  a **second agent in a sibling worktree** with a live **file collision**, a **deletion** captured through
  the Bash tree-diff path, a **failed tool call**, a **write outside the workspace** for the Risk audit, a
  third **background shell** that exits non-zero, a **three-phase workflow**, and a second edit to one
  file in its own region, so "undo one edit and keep the later edits to the same file" is demonstrable.
- **The demo hides itself from git.** It writes into your own repository, so its folder now carries a
  self-ignoring `.gitignore` — it never appears in `git status` and `git add -A` cannot sweep it in.
- **`demo --status`, and an exit that stays reachable.** Session resolution follows the newest
  transcript, so one real Claude turn after a demo used to take Exit Demo away while the folder and both
  sessions were still on disk. Both editors now offer Exit whenever a demo *exists* for the folder, not
  only while one is the session under review.
- **`demo --tour`, `demo --touch`, `demo --no-fleet`.** The tour's script as text or JSON; a heartbeat
  that keeps a running demo inside the fleet's 60-second active window while a tour explains it (mtime
  only — nothing is written); and an opt-out from the sibling agent.

### Changed

- **Starting the demo resets it.** A run clears any previous demo for that folder before replaying, so
  Start and Restart are one operation and a second run cannot stack a stale, half-reviewed session beside
  the fresh one. `runDemo({ reset: false })` opts out.
- **One name for the audience.** The project described who it is for four different ways ("established
  codebases", "critical infrastructure", "code that matters", "code you cannot afford to get wrong").
  Every intro surface — the README, the site, both marketplace descriptions, every package description —
  now says **established and mission-critical codebases**, per `docs/STYLE.md` X2.

### Fixed

- **Demo task attribution under a fast replay.** The simulator's transcript clock advances a millisecond
  per line and so ran ahead of wall time, while the store stamps captures with the real clock — far
  enough ahead, in the longer scenario, that a task's in-progress span no longer contained its own edit
  and the Tasks tab lost a row. Each beat now waits for wall time to catch up.
- **Orphaned usage cursors.** A transcript's incremental usage cursor is keyed by path, so
  `removeSession` could not reach it and every demo run left one behind for good. `demo --clean` now
  drops them (`removeUsageCursor`).
- **`demo --dir` could destroy the directory it was pointed at.** The demo planted its ownership
  sentinel into whatever folder `--dir` named, so the sentinel proved nothing: the first run overwrote
  any file whose path the scenario reuses, and — since a run now resets — the second run deleted the
  whole directory. `--dir` is refused unless the folder is empty or already a demo workspace.
- **A symlinked `--dir` stranded the sibling session.** The workspace path was resolved through the
  symlink in one place and not in another, minting two project dirs; the sibling landed in one and every
  later `--clean`, `--touch` and status scan looked in the other, while cleanup reported success. One
  normalization now serves all four.
- **Exit Demo could strand its own folder.** The tour opens a demo file; a buffer saved after Exit
  deleted the tree recreated a file inside it — along with the sentinel that authorizes deletion, so no
  command could ever remove that folder again. Both editors now close the demo's editors first.
- **Cleanup no longer claims more than it did.** Removal is best-effort per item, but both editors
  reported a fixed "removed the folder and the report" regardless; they now name what actually came
  back, and say "nothing to remove" when that is the truth.
- **A demo with no CLI on PATH says so first.** The replay runs in-process in VS Code and works without
  the CLI, but the Overview, Prompts and Stats panels read their data through it — and 26 of the tour's
  41 steps are about those three. Starting the demo without it now warns before, not after — and the
  check **spawns** the CLI rather than statting a path, because the PATH fallback is a bare name and
  statting it declared every install outside a fixed candidate list broken.

## [0.8.8] — 2026-07-25

A subtraction and a speed-up. The **chapters** display layer is gone: it partitioned a session's edits
across Claude's plan, filling the gaps with a synthesized session chapter so every edit had a row, and in
practice nobody reviewed by it. What organizes review now is what you asked for — **prompts**, renamed
from requests and used as the vocabulary everywhere — and what Claude planned, which survives as
**tasks** under strict attribution and nothing else. A new **Sessions** tab lists this workspace's
sessions, the session picker no longer parses a single edit log to open, and a session with thousands of
edits renders in a fraction of the time it used to.

### Added

- **Sessions tab.** The Overview's left nav gains a fifth tab in both editors: every Claude Code session
  recorded for this workspace, led by Claude's own title for it and ordered by when its *conversation*
  was last active. The live session is marked. Selecting a row is a change of subject rather than of
  view — it pins the session every window reviews, the same choice Switch Session makes.
- **`sessions --json` reports the workspace listing.** `{ active, sessions: [{ id, title, lastActiveMs,
  current }] }`, built from directory stats plus a bounded title scan cached in a per-session sidecar.
  Each row also carries what that session did — edits captured, files touched, how many still pending —
  from a per-session sidecar keyed to the store log, so the listing re-reads only logs that changed.
- **`clean --resolved --ids <a,b,c>`.** Clears the resolved edits of an explicit id set — the scope one
  prompt names, which no `--under <path>` can express, since a single prompt edits whatever it edits.
- **Prompt-scoped bulk review in JetBrains.** With a prompt picked in the Prompts window, Accept All,
  Reject All, and Clear Resolved retarget to that prompt, as they already did in VS Code.
- **The Folders strip expands.** The change map's strip leads with the eleven folders that moved most
  and folds the rest behind a **+K more** tile. That tile is now a control: it opens the strip to every
  folder — wrapped onto further rows, capped at five and scrolling, so the file ledger stays in view —
  and **show fewer** folds it back. Before, the tail was an inert label and the folders behind it could
  not be reached from the strip at all. Tiles also hold a readable floor width instead of shrinking, so
  a narrow panel gets more rows rather than slivers.
- **The Overview's panes resize.** A gutter between the left nav and the change map drags in VS Code
  (double-click restores the default), and JetBrains remembers where you left its splitter. Both keep a
  separate position for each layout, because below about 620 px the panel stacks the two panes instead
  of splitting them side by side — and the nav bar there gives each review axis its own row.
- **Per-task review in both editors.** The Tasks tab now offers Accept, Reject, and Clear on each row —
  chips in VS Code, a context menu in JetBrains — over that task's strict span. The CLI verbs existed
  before; nothing in either editor reached them.

### Changed

- **Requests are now prompts.** The dock window is **Prompts**, the verb is `prompts`, the change-map key
  is `prompts[]`, and the review axis is **Prompt**. The old `requests` verb is **gone**, not aliased: a
  script that called it exits non-zero with `unknown command "requests"` instead of quietly printing a
  payload whose array is now named something else. In VS Code the view identifier changed with the name, so the Prompts window
  returns to its default dock position once; drag it back and it stays.
- **Task review is strict, and says so.** `task-keep`, `task-undo`, and `task-clear` act on a task's
  **strict in-progress span**: the edits captured while that to-do was actually in progress. Nothing is
  swept in from the gaps around it, and an edit that fits no interval is reported in the explicit
  unassigned bucket. `task-clear --completed` clears every settled task's resolved edits.
- **The review axes are four**: Diff · File · Folder · Prompt.
- **The Overview's change map is two sections** — the Folders strip over the churn-ranked Files ledger,
  with the summary bar naming the picked prompt or folder filter.
- **Dropping a session drops its derived copies.** 0.8.8 caches a session's title and its whole change
  map — which carries its prompt text — on disk. `clean --drop`, `clean --all`, `clean --older-than`,
  `demo --clean`, `uninstall --purge-store`, and either editor's Drop action remove those with the
  session, and a routine `clean` never mistakes the caches themselves for reclaimable sessions.
- **Active only defaults on, and is remembered.** The Overview opens showing work that still awaits
  review; the toggle survives hiding the panel, reopening the project, and restarting the IDE.
- **The session picker was rebuilt.** Rows lead with the session's title, order the live session first
  and the rest by conversation recency, open with the session you are currently reviewing preselected,
  and match on the raw id as you type. Pending counts are gone from it by design.
- **Documentation.** The panels reference is merged into the concepts page as an annotated tour of each
  surface (`panels.html` redirects), the feature reference is ordered by what a reader reaches for first
  and gains Prompts and Sessions sections, and the landing page opens with an abstract.

### Removed

- **The chapters display layer, in full**: the ribbon, the Chapter review axis, the synthesized session
  chapter, the `chapter --of-edit` query, the `chapters[]` / `edits[].chapter` / `chapterIds` /
  `afterChapterId` JSON keys, and the editor commands and keybindings that drove them — VS Code's
  `claudeObservatory.navChapterPrev` / `navChapterNext` (with their <kbd>ctrl/⌥⌘ ,</kbd> / <kbd>.</kbd>
  bindings, now free) and `claudeObservatory.clearCompletedChapters`, and the JetBrains
  `ClaudeObservatory.ReviewPrevInChapter` / `ReviewNextInChapter` actions on the same chord.

  | 0.8.7 | 0.8.8 |
  | --- | --- |
  | `task-keep <id>` over the chapter's **displayed** edits | `task-keep <taskId>` over the task's **strict** in-progress span |
  | `task-undo <id>` over the chapter's displayed edits | `task-undo <taskId>` over that same strict span |
  | `task-clear <id>` (`--completed` = settled chapters) | `task-clear <taskId>` (`--completed` = settled tasks) |
  | `chapter --of-edit <n>` | `changemap --json` → `tasks[]` + `rollupByTask` |
  | `changemap --json` → `chapters[]`, `edits[].chapter`, `chapterIds`, `afterChapterId` | `tasks[]`, `rollupByTask`, `unassigned`, `prompts[]` |
  | `multitask --json` → `tasks[].chapterId` | `tasks[].taskId` (the strict 12-hex task id) |
  | `requests` (verb, window, `requests[]`) | `prompts`, `prompts[]` — the old verb is removed |
  | `sessions --json` → `{active, sessions:[{id,title,edits,pending,lastMs}]}` (whole store) | `{active, sessions:[{id,title,lastActiveMs,current}]}` (this workspace) |
  | VS Code command `claudeObservatory.showRequests` | `claudeObservatory.showPrompts` |
  | VS Code view id `claudeObservatory.requests` | `claudeObservatory.prompts` |

  The same three task verbs kept their names and changed their meaning: they used to act on the edits a
  chapter row *displayed* (a total partition, so every edit was in one), and now act on a task's strict
  in-progress span. On a session whose plan covered the work, the sets are identical; where they differ,
  the edits that fall outside every in-progress window are reported unassigned instead of being swept in.

### Performance

Measured on a synthetic session of 3,000 edits across 150 files (Node v26.4.0, macOS, warm meaning a
second call with the store unchanged), before and after this release:

| Operation | 0.8.7 | 0.8.8 |
| --- | --- | --- |
| `appendLog` (one capture, including id allocation) | 2.1 ms | 0.3 ms |
| `readLog` × 100 (warm) | 184.1 ms | 7.2 ms |
| `buildEditTree` (warm) | 245.6 ms | 7.3 ms |
| `buildChangeMap` (warm) | 358.0 ms | 148.9 ms |
| `buildChangeMap` (cold) | 549.5 ms | 353.0 ms |
| session listing | 1.9 ms | 0.1 ms |

On this project's own store — 37 sessions, 31 of them for this workspace — the listing the picker opens
with fell from 717 ms to 4 ms, and to 1 ms once each session's title sidecar is warm. The two listings
are not identical: the old one parsed every session's transcript for a title and every session's log for
counts, and returned the whole store; the new one stats directories, reads a cached title, and returns
only this workspace's sessions.
The capture path is no longer quadratic in a session's size — the next edit id is read from the tail of
the log rather than by parsing all of it. In the editors, the VS Code status item indexes its records
instead of scanning them per edit, inline placements are cached per file and no longer recomputed on
every keystroke, and the store watcher only wakes for this workspace; the JetBrains plugin coalesces its
refresh fan-out into one repaint, bounds tree expansion at 300 nodes, and waits for a buffer to settle
before spawning a `locate`.

### Fixed

- **The store's caches were world-readable.** SECURITY.md has always described the store as 0700
  directories and 0600 files, but the derived caches added in 0.8.5–0.8.7 (`stats-cache.json`,
  `usage-cursors/`, the sibling-overview cache) were written with default permissions, and on a shared
  host that is readable by every other account. All of them, and every cache this release adds, now
  carry the store's own modes.
- **Accept All was quadratic, and at real scale that is a hang, not a slow path.** Each per-edit status
  write resolved its record through the folded log, whose memo the write then invalidated — so accepting
  N edits re-parsed the log N times. On a 26,000-edit session it took **8 minutes**; it now takes **8 ms**
  (`setStatusMany`: one parse, one lock, one append, and no-ops skipped so a second Accept All writes
  nothing). Every bulk verb goes through it — Accept All, a file, a folder, a task, a prompt — and the
  JetBrains plugin, which had been spawning one CLI process per edit, now sends the whole set at once
  (`keep --ids <a,b,c>`).
- **Switching sessions was slow in proportion to the session you switched TO.** Three causes, all fixed:
  `changemap --json` had no on-disk memo at all, so a fresh process rebuilt an unchanged map every tick
  (4.1 s → 0.78 s); `multitask --json` rebuilt "the active session" unconditionally, which is right for
  the live conversation and wrong for a pinned one that can never change again (4.8 s → 1.0 s); and every
  sibling's transcript was re-parsed for its risk tally on every refresh (`listRepoSiblings` 684 ms →
  37 ms). A warm switch on this project's own store now costs **0.18 s of process time, against roughly
  8 s before**. Selecting a session also takes effect immediately in the panel, which used to keep
  showing the previous session's edits under the new session's name until the payload landed.
- The Tasks tab joins each row to its strict rollup, so a task's ± and edit counts describe the work
  captured while it was in progress rather than a display grouping's totals.
- Ordering sessions by conversation recency rather than by store writes: accepting a batch of old edits
  no longer moves a finished session back to the top of the list.

## [0.8.7] — 2026-07-23

Follow-up to 0.8.6, and largely a subtraction: the separate capability panel folds into the Risk and
Egress audits, the context-per-turn chart goes away, and what remains is sharper — background
**Processes**, a **live feed** for whatever you click, switching sessions actually switching the
Overview, and two more optimization passes. A full adversarial review of the batch produced 58 verified
findings, and the fixes for them are in here too.

### Added

- **Requests — the session as the conversation you actually had.** Every other view organizes the work
  the way the *agent* saw it: worktrees, runs, its own to-dos, files. This one is one row per thing
  **you** asked for, in order, each carrying what that ask produced — its edits, the subagents and
  workflow runs it spawned, the background shells it launched, the compactions it suffered. Work belongs
  to the ask that **started** it, never the one that happened to be current when it finished: a shell
  launched by request #4 stays #4's even when it exits during #7. `claude-observatory requests` prints
  the list; `--id <n>` prints one ask with everything it caused.
- **Selecting a request scopes everything.** In both editors, Requests is now its own window in the
  bottom dock, immediately left of the Overview — so the list of asks stays visible while you read what
  one of them produced. Picking a row narrows the Overview beside it: its fleet (the subagents that ask
  spawned), its workflow runs, its tasks, its background shells, and the whole change map — chapters,
  folders, files. The bulk actions retarget to it ("Accept All in #18"), and every pane that dropped
  rows says how many and why. Each ask's files and folders are aggregated in core, so both editors
  render the same numbers without re-deriving anything.
- **A Request axis on the review nav bar**, beside Diff · File · Folder · Chapter: step between your own
  asks, and accept or revert everything one of them produced.
- **Every request carries its own headline stats** — edits, files, folders, tokens, subagents, workflow
  runs, tasks worked, background shells, and time. Tokens are the main-chain assistant total for the
  window (deduped by message id, the same figure the Stats panel sums); files/folders are the distinct
  paths the ask's edits touched; tasks are the to-dos it worked. `requests --id <n>` lists them all.
- **Expand any request to read Claude's reply.** Each row opens a log of Claude's actual response to
  that ask — its prose, with the tool calls stripped out, so you get the narrative (the plan, the
  explanations, the summary). Fetched on demand because it can be large, and shown whole, wrapped, never
  clipped. From the shell: `claude-observatory requests --id <n> --response`.
- **Collapse All on the sidebar trees.** Edits, Diffs and Actions gain the file-Explorer's Collapse-All
  affordance — VS Code's native tree button, and its IntelliJ toolbar equivalent — so a deep
  folder → file → class tree folds to its top level in one click.
- **Risk and Egress now answer the whole "what did it touch" question.** `risk` reports the edits that
  landed **outside the workspace** alongside the shell commands it already flagged — writing outside the
  boundary you gave the agent is the same class of fact, and the edits ledger cannot state it because it
  shows every path workspace-relative. `egress` reports the files **read** from outside the workspace as
  channels beside web hosts, MCP servers and network shell — reading outside the boundary is reach,
  exactly like a fetch. Egress scopes gained `local`, rendered as its own label: `local` is a fact,
  `unknown` is an admission that a destination could not be classified, and collapsing the first into
  the second would be a lie.
- **Processes — the background shells Claude left running.** A new tab beside Fleet · Workflows · Tasks,
  and `claude-observatory processes`. Each shell shows its runtime, its exit code, and how much output it
  has produced; `--id <shell>` prints the full command it is running plus a tail of that output. There is
  deliberately no OS process id: the transcript never records one, and inferring it from local processes
  would be wrong the moment the agent runs over SSH or in a devcontainer, so the harness's own shell id
  is the identity — which is also what the agent uses to read or kill it.
- **A live feed for whatever you click** — an agent, a workflow run, a task, a background shell, or the
  session itself — read from the file that thing writes as it works, via `claude-observatory feed`. A
  feed means a different thing depending on whether its source is still going, so core decides and both
  editors agree: **live** while it is still writing (follow the tail, and report the age from real
  evidence rather than claiming realtime), **audit** once it has finished, because a completed run is a
  record, not a stream — and a finished thing stops being polled. Capped feeds always say how many
  earlier entries they did not show.

### Changed

- **The bottom dock is Requests · Overview · Stats; Observations moved to the sidebar.** Three windows
  side by side instead of two-plus-a-list: the Requests window needs to be visible *while* you look at
  what it scopes, which a tab inside the Overview could never do. Observations joined Edits · Diffs ·
  File History · Actions in the sidebar window, where the rest of the read-and-review surface already
  lives. Nothing was removed — everything is where the review work happens.
- **Long text wraps everywhere instead of being clipped.** A prompt, a workflow name, a to-do: these
  render whole, over as many lines as they need, in both editors and in `requests` on the terminal. An
  ellipsis throws away the only copy of what was actually said.
- **The Requests window is a clean list for picking an ask.** The scope it sets is shown where it
  matters — the Overview's panes note what they hid, the bulk buttons read "…in #N", and the bottom
  summary names the ask — so the redundant banner that repeated the ask inside the Overview is gone, as
  are the per-row Review/Accept/Revert icons (those live on the Overview's Request axis once an ask is
  selected).

### Fixed

- **"Active only" now hides exited background shells too.** Fleet, Workflows and Tasks already scoped to
  what is still going when the toggle is on; the Processes pane was the outlier and kept showing finished
  shells. It now shows only running ones, and when that empties the list it says so — "No running
  shells — clear Active only to see the N that have exited" — rather than looking blank.
- **Revealing the Requests window after an upgrade.** When a view container's contents change, VS Code
  keeps the pre-upgrade panel layout and does not surface a newly-added view, so upgraders into 0.8.7
  did not see the new Requests window. A one-time, dismissible prompt now points at it, and a
  **"Claude Observatory: Show Requests window"** command reveals it on demand. (A fresh install shows it
  already; JetBrains was never affected — it builds the pane unconditionally.)
- **The separate capability/footprint panel is gone — folded into Risk and Egress.** It shipped in
  0.8.6 as a six-facet badge row, and most of it restated audits that already existed: risky commands
  are Risk, MCP servers and web hosts are Egress, subagent spawns are the Subagents view. Only two of
  its facts were unique, and those are the two that moved. One audit surface instead of two. The
  `footprint` and `capabilities` commands still run, printing both audits with a note on stderr.
- **The file-edit facet is gone** — edits already have the ledger, the Overview and the review
  scoreboard; repeating them here added a number without adding a fact.

### Removed

- **`claude-observatory capabilities` is now `claude-observatory footprint`.** The old verb still works
  and forwards, printing a one-line deprecation notice on **stderr** so anything piping `--json` is
  unaffected. The JSON key changed with it (`capabilities` → `footprint` in `changemap --json` and
  `multitask --json`) — a deliberate exception to the "add fields, don't rename them" contract, recorded
  here because a version-skewed editor drops the whole footprint row silently rather than erroring.
- **`changemap --json` no longer repeats a full edit list per sibling session** (`agents[].edits`).
  It was 1.95 MB of a 3.30 MB payload that both editors re-parsed on every refresh and neither read;
  the whole payload is now 1.43 MB. The active session's own top-level `edits` is unchanged. Removing a
  shipped field is against this project's "add fields, don't remove them" rule, so it is stated here.
- **The context-per-turn chart** in the Stats panel, along with the per-turn series that fed it. The
  compaction data it visualised stays: compactions remain a curated group in the Actions timeline and
  markers between the Overview's chapters.

### Fixed

- **Switching sessions now changes the Overview's detail pane.** The fleet lists every sibling session
  in the repo, so a selection made against the previous session still resolved after the switch and the
  detail kept rendering the old session's change map — the label changed, the content did not. Both
  editors now re-point the selection when the active session changes, in the same place they already
  reset their dismissed sets.
- **A long session's activity sparkline can no longer blow the call stack** — the fleet histogram used
  `Math.min(...timestamps)`, which throws once a session accumulates enough tool calls to overflow the
  argument list. It now uses the loop-based min/max the rest of core already switched to.

### Performance

A second sweep, measured the same way (real 53.5 MB transcript, 27 sibling sessions).

- **The new views cost nothing to poll.** `sessionProcesses` re-read the whole transcript on every call
  (122 ms on a 53.5 MB session) — fatal for a tab that refreshes; its transcript half is now memoized,
  **122 ms → 0 ms**, while runtime and output size stay deliberately uncached, since those are exactly
  the two numbers that must keep moving. The feed is a bounded tail by construction (~2 ms warm for a
  session, ~0 ms for an agent).
- **The Overview's remaining per-sibling re-parsing is gone.** 0.8.6 cached each finished sibling's
  change map on disk, but the fleet row also derived an activity sparkline and a to-do list per sibling,
  each re-reading that transcript in a fresh process every refresh. Both now ride the same cached entry:
  `multitask --json` **2.3 s → 1.8 s**, and the full Overview refresh (both spawns) is now **~2.9 s**,
  down from ~29 s before the 0.8.6 sweep.

## [0.8.6] — 2026-07-22

A quality-of-life sweep across the CLI, core, both editors, and the docs, plus four new lenses on a
session: what it ran on, what happened to its context, what it reached for, and what shaped it.

### Added

- **The session's model and reasoning effort, beside its name (both editors)** — the Stats panel now
  says what the session is actually running on: `Opus 4.8 · max effort`. The model comes from the
  assistant turns themselves (sidechain turns are excluded — a subagent may run a different model —
  and synthetic records are skipped), so a session that switched models mid-flight shows the current
  one and flags that it switched, with the full per-model turn counts in the tooltip. Effort is read
  from the structural field current Claude Code stamps on every turn, falling back to the `/effort`
  command echo on older transcripts; a session that never declared one shows nothing rather than a
  guessed default. Backed by `core.sessionVitals`, which rides the same incremental byte cursor
  `sessionUsage` already advances — asking for both costs one `stat()`. Exposed as `usage --json`'s
  new `vitals` object.
- **Compactions are visible everywhere (both editors)** — when the harness runs out of context it
  summarizes the conversation and continues, which is the single most consequential thing that can
  happen to a session: everything above that line reaches later turns as a summary, not as what was
  actually said. Until now the observatory drew nothing. Now each compaction is a first-class
  **Actions** row in its own curated *Compactions* group (`auto · 1M→14k · 986k dropped · 2m 5s`), a
  **marker between chapters** in the Overview, and a **context-fill meter** in the Stats panel whose
  saw-tooth is the session's context filling and being dropped. The per-event drop is derived as
  `pre − post`; the harness's own `cumulativeDroppedTokens` is a running session total, so quoting it
  per event would overstate every compaction after the first.
- **Capability footprint badges (both editors)** — a glanceable row on the Overview for what a session
  actually reached for: file reads and edits (split by whether they landed **outside the workspace**),
  shell commands with their risk tiers, MCP servers, network hosts, and subagent spawns. Also
  `claude-observatory capabilities [--json]` and a per-agent footprint on every fleet row. These count
  what was **exercised, never what was approved**: Claude Code writes nothing to the transcript when it
  prompts for permission, so auto-approved and hand-approved are indistinguishable from the outside —
  the badges say what ran, and the UI says so too.
- **Context sources — what shaped this session (both editors)** — a Context section in Observations
  listing the skills it invoked, the plans it wrote, the memory it read, and whether it was resumed
  from a compaction, alongside the instruction files present where Claude Code auto-loads them. Each
  row is labelled with how we know: `transcript` for things the session demonstrably did,
  `file-present` for files that merely exist in a loaded location — because current builds inject
  CLAUDE.md and memory system-prompt-side, leaving no per-session trace. Claiming those as observed
  would be false; hiding them would omit the biggest influence on the session, so they are listed and
  labelled. Rows with a file open it on click. Exposed as `observations --json`'s new `context` object.
- **The Tasks tab tracks the new task system (both editors)** — current Claude Code builds replaced the
  numbered TaskCreate/TaskUpdate list with background **Agent runs** (task-notifications + per-agent
  transcripts), which left the tab permanently empty. Each agent run is now a task row — subject from
  its spawn description, live status from its own transcript's phase, the agent's in-progress todo as
  the active label — unioned with the legacy numbered rows so either harness generation works
  (`core.allSessionTaskRows`, riding the existing `multitask --json`).
- **Session pickers show session names** — the switch-session dropdown in both editors (and
  `claude-observatory sessions`) now leads with each session's human-readable title (its `ai-title`,
  else the first prompt), with the raw id demoted to the description line. Backed by
  `core.listSessionsWithTitles` and a `title` field in `sessions --json`; the JetBrains chooser now
  builds off the EDT from that JSON, falling back to raw ids if the CLI is missing.
- **Session tokens on the Stats panel (both editors)** — a new section right under the session title
  shows the session's cumulative tokens split the way the API bills them: **input** (uncached),
  **output**, **cached** reads, and the **cache hit rate** (reads ÷ all context sent; cache writes in
  the tooltip). The review scoreboard now sits under its own **Edits** heading. Backed by
  `core.sessionUsage`, which now returns the full split and follows the transcript with an incremental
  byte cursor — a refresh parses only newly appended lines (a no-change refresh is a single `stat()`),
  instead of re-reading a potentially 50 MB transcript. Exposed to the editors via `usage --json`'s new
  `sessionTokens` object (the JetBrains panel now pins it to the visible session with `--session`).
- **Bulk "redo all" across every surface** — the forward mirror of Revert All: `claude-observatory redo
  --all` (plus `--file <substr>` / `--under <path>` / `--ids <a,b,c>` and `--json`, matching `undo`), a
  **Redo all edits** command + toolbar button in VS Code, and a **Redo All Edits** action in JetBrains
  (also registered for Find Action), all backed by a shared `core.redoScope` (oldest-first re-apply).
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

### Performance

A sweep over the whole read path, measured against a real 53.5 MB transcript in a repo with 27 sibling
sessions. Nothing here changes what any surface reports — every number was diffed against the
un-optimized output first.

- **The Overview refresh went from ~29 s of work to ~4.6 s.** It builds a full change map for every
  sibling session in the repo, nearly all of which are *finished* sessions whose transcript and store
  log will never change again — and it does that in a fresh CLI process every few seconds, where the
  in-process memo can never help. Finished siblings are now memoized on disk, keyed by their
  (transcript, log) stamps: `changemap --json` **14.5 s → 1.6 s**, `multitask --json` **14.9 s → 3.0 s**.
  The session actually being viewed is always rebuilt, since its transcript is still growing and its
  live counts are the ones being watched.
- **The parse cache was thrashing to a ~0 % hit rate.** Its per-kind cap was 128 entries with
  oldest-inserted eviction, but a single session's `subagents/` directory holds 150+ transcripts after a
  big workflow run — so every pass evicted exactly the entries the next pass needed, and each
  "memoized" parser re-ran every time. The cap now fits the real working set and eviction is
  least-recently-*used*: warm `buildChangeMap` **126 ms → 29 ms**.
- **The status line and the JetBrains stats poll no longer re-read the whole transcript.** Both run a
  fresh CLI process per tick, so the in-memory usage cursor never survived for them; it is now persisted
  and resumed, turning a full re-parse into a delta: `usage --json` **160 ms → 50 ms** on that 53.5 MB
  session. Token dedup still carries the complete seen-set — duplicate message ids recur hundreds of
  lines apart in resumed sessions, so a cheaper shortcut would double-count.
- **`metrics` stopped re-reading the transcript for tool latencies** (the last unmemoized full scan in
  that module): **127 ms → 17 ms** warm.
- **VS Code no longer refreshes for other repos' sessions.** The transcript watcher pattern spans
  `~/.claude/projects`, i.e. every project on the machine, so unrelated Claude activity was waking this
  window for a full refresh; arrivals are now filtered to this workspace and its worktree siblings.
  Subagent and workflow transcripts nested under a watched session still count, so a live agent fleet
  keeps updating in real time.

### Changed

- **Status line: three rows, session-first** (bundled `claude-observatory statusline`, vendored from
  claude-statusline) — a new top row carries the clock, the git **branch** (when in a repo), and the
  `~`-abbreviated **path**; the middle row is the session: its **title** (folder name until one
  exists), the model + attributes with a `◷` duration, and **`↑in ↓out ↺cached` token counters**
  (from `usage --json` — the same split as the Stats panel; omitted when the CLI is absent); the
  usage bars stay the last row.
- **VS Code extension publisher is now `cell-observatory`** (was `claude-observatory`), matching the
  GitHub org — the extension id is therefore `cell-observatory.claude-observatory-vscode`. Existing
  installs migrate automatically: `claude-observatory update` installs the renamed extension and removes
  the old-id copy, and the extension itself cleans up a lingering pre-rename duplicate on activation.
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

- **A compacted session no longer renames itself "This session is being continued…".** The summary the
  harness injects after a compaction is a synthesized *user* turn, and it slipped past the guards that
  skip command wrappers — so on any long session it became the first user prompt, and from there the
  session title, the synthetic chapter's title, and the label in both editors' session pickers.
- **A session running background agents or a workflow fleet no longer reads as `done` / `awaiting
  permission` while its agents churn.** The phase classifier's staleness clock now spans the child
  agent transcripts (`subagents/*.jsonl` and `subagents/workflows/*/*.jsonl`), not just the main one —
  so a live 100-agent workflow run keeps its session `working`, visible under the Overview's
  "Active only" filter instead of being dropped as finished.
- **Workflow phase titles parse again on current Claude Code builds.** Newer harnesses serialize the
  script meta's phases with quoted keys (`{"title":"Scope",…}`), which the fallback parser flattened
  into a title/detail string soup; the Workflows pane now shows the real phase names.
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
- **JetBrains: the Overview's review-axes row (Diff · File · Folder · Chapter) now wraps** onto
  additional centered lines when the pane is too narrow, instead of the axis toolbars collapsing into a
  "…" overflow — completing the toolbar-wrap fix (the top controls row already wrapped as of 0.8.5).
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
