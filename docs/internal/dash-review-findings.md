# `dash` review findings — carried forward

An adversarial review of the uncommitted three-window terminal dashboard covered five dimensions (errors, truncation/fidelity, parity, performance, tests). Each finding was then
handed to a refuter whose job was to kill it by reading the code and reproducing the failure.
**52 were raised, 7 refuted, 45 survived.**

This file exists because the backend may be rewritten. These are defects in *behaviour and
contract*, not in syntax — every one of them is a decision a reimplementation has to make too,
so they are written to be portable across languages rather than as a patch list.

Reviewed 2026-07-31 against the uncommitted tree.

## Resolved before this document was written

| # | Severity | Finding | Where |
|---|---|---|---|
| R1 | high | `/` opens a filter that cannot be typed into — every keystroke falls through to the destructive keymap | `packages/cli/src/dash.ts:777` |
| R2 | high | The `[y/n]` confirmation cannot be answered — bulk keep/undo is unreachable | `packages/cli/src/dash.ts:298` |
| R3 | high | The pane body scrolls in wrapped VISUAL lines while the cursor math is in LOGICAL rows sized to the whole terminal — the selection leaves the screen and still takes destructive verbs | `packages/cli/src/dash.ts:261` |
| R4 | high | A click in a pane body selects a different row than the one drawn there whenever anything above it wrapped | `packages/cli/src/dash.ts:466` |
| R5 | high | The [y/n] confirm has no y or n handler — A/U bulk keep/undo can never complete | `packages/cli/src/dash.ts:298` |
| R6 | high | The `/` filter opens nothing, and every destructive key stays live while it is 'open' | `packages/cli/src/dash.ts:776` |
| R7 | high | paneBody wraps EVERY row of the whole list on every frame — the frame got 15–18x slower and a real session now blocks the key loop for 155 ms per repaint | `packages/core/src/dashframe.ts:459` |
| R8 | high | clampCursor clamps `scroll` in ROW units against the whole terminal while paneBody uses it as an offset into WRAPPED VISUAL lines — after 100 j presses the selected row is off screen and no cursor is drawn at all | `packages/cli/src/dash.ts:261` |
| R9 | high | A body click selects the wrong edit: onMouse maps wrapped visual lines as if they were rows | `packages/cli/src/dash.ts:466` |
| R10 | high | clampCursor scrolls against the whole-frame body height, so j/k walks the cursor off the pane and a/u act on an invisible selection | `packages/cli/src/dash.ts:261` |
| R11 | medium | An empty pane renders as blank space — the 'nothing here' message was lost in the pane compositor | `packages/core/src/dashframe.ts:465` |

The cluster R3–R8 was one root cause: the body rendered *visual* lines while the cursor and
scroll math counted *logical* rows sized to the whole terminal. It is recorded as one lesson in
the section below, because a rewrite can get it wrong the same way.

## Open — 34 findings

### HIGH (9)

#### H1. With Detail focused, j/k and a/u act on the Traces edit list while the only visible cursor is elsewhere
- **Where:** `packages/cli/src/dash.ts:407`  ·  **Dimension:** errors
- **Evidence:** Detail's default tab is Diff, whose `TAB_SCREEN` entry is `'diff'`, and every focus/tab path guards with `if (sc !== 'diff') state.screen = sc` (:407, :460, :750). So focusing Detail leaves `state.screen` at the PREVIOUS pane's screen while `state.cursor` is swapped to Detail's own counter (:404) — and `selectionIds`/`openSelected`/`onMouse` all read `state.screen` + `state.cursor`. RUN, live runtime: pressed `0` (Detail focused, confirmed by `>0 Detail` on the title row), then 4 × `j`; the Traces pane still drew its band on `#1`; Enter opened `diff #6`. `a`/`u` there keep or undo #6 while the screen highlights #1. Clicking Detail's blank body does the same — :464-476 runs the identical logi
- **Fix:** Give the Diff face its own screen identity instead of leaving `state.screen` stale, and make `mutateScope`/`openSelected`/`onMouse` resolve their row set from the FOCUSED pane's selected tab explicitly. When the focused face has no rows (Diff), refuse with a message — the same 'observations, not edits' treatment `mutateScope` already gives audit/feed/agents (:290-293).
- **Why it survived refutation:** SURVIVES — reproduced in a real pty against the real session, and the destructive variant reproduced against a sandboxed copy of the store. The reviewer's mechanism is exactly right. The code at packages/cli/src/dash.ts:407 (`focusPane`) is `if (sc !== 'diff') state.screen = sc as typeof state.screen;`. `TAB_SCREEN.detail` is `['diff','map','feed']` (packages/core/src/tui/layout.ts:151) and Detail

#### H2. Detail's Map face silently clips every file and folder name — no ellipsis, no marker
- **Where:** `packages/core/src/tui/changemap.ts:194`  ·  **Dimension:** truncation
- **Evidence:** renderMapRow sizes the name column as `Math.max(8, cols - prefix - suffix)` and then calls `fitVisible(row.label, nameWidth)`, which CLIPS when the label is wider. The header comment two lines above claims "nothing here ellipsises: the name column is sized to fit, not the name clipped to the column" — the floor of 8 falsifies that. RAN `node packages/cli/dist/index.js dash --once --cols 120 --rows 36 --no-color` and rendered Detail on the Map tab at the DEFAULT 120x36 layout (Detail resolves to 38 columns, inner 37). The pane printed:   `package-loc`  (package-lock.json)   `CHANGELOG.m`  (CHANGELOG.md)   `CONTRIBUTIN`  `CODE_OF_CON`  `package.jso`  `tsconfig.ba`  `claude-obse`  `(outside th`
- **Fix:** Do not clip in renderMapRow. Either return the row with its full label and let paneBody's pushWrapped wrap it (drop the `Math.max(8, …)` floor so the row's true width is honest), or wrap the label inside renderMapRow onto continuation rows carrying `g.wrap`. Add a test that renders every real map row at cols 30..120 and asserts `stripSgr(line).includes(row.label)`.
- **Why it survived refutation:** Reproduced with the real renderer, the real session payload, and the real layout resolver. At the documented default 120x36, Detail resolves to 40 columns (inner 39) and renderMapRow's `fitVisible(row.label, cols - prefix - suffix)` clips 9 of the 21 folded map rows with no ellipsis and no marker: `package-loc`, `CHANGELOG.m`, `CONTRIBUTIN`, `CODE_OF_CON`, `package.jso`, `tsconfig.ba`, `claude-obs

#### H3. The diff overlay silently cuts diff content at the terminal width
- **Where:** `packages/core/src/dashframe.ts:586`  ·  **Dimension:** truncation
- **Evidence:** The overlay body does `out.push(fitVisible(marked, cols))` — a hard clip, no wrap, no marker, and the overlay has no horizontal scroll. Enter on a Traces row routes here (dash.ts:627-628), so this is the ONLY way a diff is ever seen. Measured real diff line widths for this session: edit #40 max 123 cols, #60 116, #80 117, #120 135, #200 172. RAN the overlay through renderDashFrame at cols=120 with the real output of `diff 200`: source line `--- <scratch>` (132 cols) renders as `… /scratchpad/skep` — the tail `/observe.cjs` is gone. A real ADDED line from edit #40, `+# Staged road to the big 0.10.0 — 
- **Fix:** Wrap overlay lines the way paneBody does — wrapVisible to `cols - 3` with a `g.wrap` continuation — instead of fitVisible. The overlay already tracks `scroll`, so extra visual lines cost nothing structurally; only the scroll bounds at dash.ts:655 need to count visual lines rather than source lines.
- **Why it survived refutation:** FAILED TO REFUTE — reproduced end-to-end with real data. Every refutation angle I tried died: 1. "Pre-existing, not this change." DEAD. `git ls-tree -r HEAD packages/core/src packages/cli/src` shows HEAD contains NO dashframe.ts, dash.ts, textwidth.ts or tui/ at all, and `git grep renderDashFrame HEAD -- packages` returns nothing. The entire dash TUI ships with this uncommitted change, so no pre-e

#### H4. Detail's Diff face can never render a diff, and says something false while it doesn't
- **Where:** `packages/cli/src/dash.ts:104`  ·  **Dimension:** truncation
- **Evidence:** `state.diffLines` is initialised to `[]` at dash.ts:104 and is NEVER assigned anywhere. `grep -rn diffLines packages test scripts docs` (excluding dist) returns exactly four hits: the declaration (dashframe.ts:62), the read (dashframe.ts:441), this initialiser, and a test fixture (core.test.js:9063) that also sets `[]`. The `diff` verb's output goes to `state.overlay` (dash.ts:627-628), which renderDashFrame renders INSTEAD of the panes (`if (state.panes && !state.overlay)`, line 556). Diff is `PANE_SPECS.detail.tabs[0]`, i.e. the centre pane's DEFAULT face — the one layout.ts's header calls the whole reason the centre exists. RAN the 120x36 one-shot: Traces shows the cursor on edit #1 (`>? 
- **Fix:** Populate `state.diffLines` when the Traces cursor moves and Detail is on Diff (reuse `backend.diff(id, session)`, split on newline, cache by edit id), or — if the pane diff is out of scope for this change — remove the Diff tab from PANE_SPECS rather than shipping a tab that opens onto nothing, which layout.ts:132's own comment forbids.
- **Why it survived refutation:** Reproduced at three levels and could not be refuted. (1) STATIC: `state.diffLines` has exactly one write in the entire tree — the initialiser `diffLines: []` at <repo>/packages/cli/src/dash.ts:104. The only read is `const lines = state.diffLines ?? [];` at <repo>/packages/core/src/dashframe.ts:441. The grep was positive-controlled a

#### H5. Prompt rows render the pre-ellipsised 96-char title, so `…` reaches a wrapping pane
- **Where:** `packages/core/src/dashframe.ts:157`  ·  **Dimension:** truncation
- **Evidence:** `rowsFor` uses `str(p.title) \|\| str(p.text)` — `title` wins, and prompts.ts:160 builds it as `a.text.length > 96 ? a.text.slice(0, 95) + '…' : a.text`. The payload carries the FULL prompt in `p.text` alongside it. Counted on the real payload: 14 of 37 prompt titles end in `…`. RAN the 120x36 one-shot — the Timeline pane prints `>  ▸mea…` and `>  ▸like …` as wrapped continuation rows, i.e. the ellipsis reaches a pane that was wrapping precisely so it would not have to truncate. Scanned every pane/tab at cols 60/80/100/120/200, both tiers, colour on and off: `timeline/prompts` shows an ellipsis at EVERY width. The repo's own test asserts the opposite intent — core.test.js:7494: `assert.equal
- **Fix:** Flip the preference to `str(p.text) \|\| str(p.title)` in rowsFor — the pane wraps, so the full ask costs only continuation rows. Add a frame test asserting no body row of any pane contains `…` for the real fixture.
- **Why it survived refutation:** Reproduced end-to-end; every refutation angle failed. (1) The code reads as claimed: dashframe.ts:157 is `const title = str(p.title) \|\| str(p.text)` and the JSON payload demonstrably carries both `text` (full ask) and `title` (95 chars + '…' from prompts.ts:160). (2) NOT pre-existing: `git ls-tree -r HEAD` shows packages/core/src/dashframe.ts, packages/core/src/tui/*, packages/cli/src/dash.ts an

#### H6. `tail()` throws away all but the last two path segments at every width, including on the outside-writes risk rows
- **Where:** `packages/core/src/dashframe.ts:103`  ·  **Dimension:** truncation
- **Evidence:** `tail()` is width-independent and is applied to Traces file paths (line 145), Agent labels (line 223) and the audit's outside-workspace WRITE rows (line 244). RENDERED Traces zoomed at cols=200 — with ~150 columns of empty space per row it still prints `notes/an-unusually-long-generated-filename.md`; the real value is `~/notes/an-unusually-long-generated-filename.md`. Applied `tail()` to all 1,698 real edit paths: 669 distinct labels, 12 of them AMBIGUOUS — `src/index.ts` stands for BOTH `/…/packages/core/src/index.ts` and `/…/packages/cli/src/index.ts`; `index/indices.config` stands for two different IntelliJ sandboxes. In a tool whose verb is per-edit revert, two different files sh
- **Fix:** Pass the full path through and let pushWrapped wrap it — that is what the wrapping body was built for (dashframe.ts:401-405 argues exactly this). If a shortened form is wanted for the common case, shorten only when the full path exceeds the pane's inner width, and never on the audit/outside-writes rows where the location is the payload.
- **Why it survived refutation:** REPRODUCED — the finding survives, with two corrections to its scope. WHAT I TRIED TO REFUTE, AND FAILED 1. "Pre-existing, not this change." Dead. `git cat-file -e HEAD:packages/core/src/dashframe.ts` -> "exists on disk, but not in 'HEAD'". `git grep -n "function tail" HEAD -- '*.ts'` finds only `feed.ts:78` (an unrelated `tail<T>(all, limit)` list-cap helper). `git grep -ln "renderDashFrame\|rows

#### H7. Every overlay repaints the frame as the retired EIGHT-screen dashboard
- **Where:** `packages/core/src/dashframe.ts:556`  ·  **Dimension:** parity
- **Evidence:** `renderDashFrame` takes the pane path only when `state.panes && !state.overlay`; with an overlay it falls through to the legacy renderer (navRow at 314, hints at 636-638). Rendered directly against packages/core/dist with panes set and a session-picker overlay (cols 120, rows 14), row 2 and the last row printed verbatim:   " 1 Edits  2 Map  3 Prompts  4 Tasks  5 Flows  6 Agents  7 Feed  8 Audit"   "1-8 screens · j/k move · enter open · a keep · u undo · A/U all · / filter · e $EDITOR · ? keys · q quit" This is one keystroke away at all times: `s`, a click on the session bar, `M`, or Enter on an edit. Keys 4-8 have no handler (the jump map at 692 covers 0/1/2/3 only) and there is no `case 'e'
- **Fix:** Draw the overlay INSIDE the pane frame (keep sessionBar + attention + windowBar and the pane key hints, replace only the body grid), then delete `navRow`, `SCREENS`-as-a-tab-strip and the `1-8 screens`/`e $EDITOR` hint list. Extend the existing 'panes: every frame fills the terminal exactly' test to a state with an overlay.
- **Why it survived refutation:** REPRODUCED at three levels; every refutation avenue failed. CODE: packages/core/src/dashframe.ts:555 reads `if (state.panes && !state.overlay)`. Any overlay falls through to the legacy renderer, which unconditionally pushes navRow (line 568, the SCREENS tab strip built at 313-318) and the `1-8 screens … e $EDITOR` hint list (634-639). The finding cited line 556; the condition is actually 555 (556 

#### H8. `?` — the key the frame itself advertises — prints the old six-screen key list
- **Where:** `packages/cli/src/dash.ts:781`  ·  **Dimension:** parity
- **Evidence:** Verified live under a pty on the real session (pressed `?`, captured the status row): "keys: 1-6 screens · Tab next · j/k move · a keep · u undo · A/U all listed · R redo · / filter · r r" (fitted to the 100-col budget). Six screens have not existed since PANE_SPECS; it names none of 0/1/2/3, Tab, m, z, =, [ ], s or M. The frame's own hint row ends with "? keys", so this is the documented way to ask what the keys are.
- **Fix:** Replace the string with the current keymap (0/1/2/3 windows · Tab · [ ] tabs · m/z/= layout · j/k · a/u · A/U · R · enter · s · M · / · r · q), or better, derive it from the same array dashframe.ts uses for the hint row so the two cannot drift again.
- **Why it survived refutation:** Reproduced live under a real pty on the real session; every refutation angle failed. (1) NOT pre-existing: packages/cli/src/dash.ts does not exist at HEAD (git cat-file -e HEAD:packages/cli/src/dash.ts fails), and HEAD's packages/cli/src/index.ts has no dash command at all — its only case-insensitive "dash" hits are the word "dash" inside an "invalid session id (letters, digits, dot, dash, undersc

#### H9. The latch test guards a simulation written in the test body, not the product; the paint path still lurches
- **Where:** `packages/core/test/core.test.js:8971`  ·  **Dimension:** tests
- **Evidence:** The test implements the latch itself (`if (latch) for (const id of lay.forced) minimized.add(id)`), so all it proves is that resolveLayout REPORTS `forced` — I confirmed that by deleting `forced.push('dashboards')`, which made it fail with `[{at:28,from:22,to:16}]`. But the product's latch lives in dash.ts `layout()` (line 373), which is called only from `ask()` (a 3000ms setInterval, line 312) and `onMouse()` (line 425). The resize handler (line 230) calls only `refreshSize(); schedulePaint()`, and `paint()` calls `core.renderDashFrame`, which resolves its OWN layout from `state.panes.minimized` (dashframe.ts:557) and ignores `forced` entirely. I simulated the real paint path — start 80x30 
- **Fix:** Apply the latch on the render path: either have renderDashFrame accept the resolved Layout from dash.ts's layout() (which already latches) instead of resolving its own, or fold `forced` into state.panes.minimized inside the resize handler before schedulePaint(). Then re-point the test at that seam — drive the resize entry point and assert the rendered Traces height is monotonic, rather than re-implementing the latch in the assertion.
- **Why it survived refutation:** CONFIRMED — I reproduced the lurch by driving the real `runDash` runtime through its real `process.stdout.on('resize')` handler, not by re-deriving arithmetic. WHAT I TRIED TO REFUTE, AND WHY EACH ATTEMPT FAILED: 1. "Maybe paint() latches somewhere I haven't seen." It does not. `paint()` (<repo>/packages/cli/src/dash.ts:189-203) calls `core.renderDashFrame`, which 

### MEDIUM (16)

#### M1. Minimizing the focused pane from the window bar, or resetting the layout with `=`, leaves focus on a pane that has no box
- **Where:** `packages/cli/src/dash.ts:432`  ·  **Dimension:** errors
- **Evidence:** The `m` handler re-homes focus after minimizing (:723-724: resolve, then `focusPane(open[0].id)` if the focused pane has no box). The window-bar twig branch (:432-441) and the `=` reset (:733-739) mutate `minimized` and do not. RUN, live runtime: clicked the Traces twig while Traces was focused → window bar showed `1 ▸Traces` (closed) and NO pane carried the `>` focus marker; Enter still opened `diff #1`, i.e. j/k/a/u continued to act on the hidden Traces list. Separately at 90x36: pressed `3` (Timeline), then `=` → `defaultMinimized(90,36)` re-minimizes Timeline, the bar showed `3 ▸Timeline`, and again no `>` anywhere on screen; Enter produced nothing.
- **Fix:** Extract the `m` guard into one helper and call it from all three mutation sites: after changing `minimized`, resolve the layout and `focusPane(boxes[0].id)` when the focused pane has no box.
- **Why it survived refutation:** REPRODUCED at both claimed sites on the live runtime, so the finding survives — but two of the reviewer's three evidence claims are wrong and the severity rests on the wrong reason. WHAT IS REAL. Driving the real `dash` on a real pty (python pty.fork, real SGR mouse bytes, frames reconstructed from the dash's own paint protocol): - 120x36, Traces focused, click the Traces twig (\x1b[<0;3;3M = row 

#### M2. Prompt rows are displayed truncated with `…` although the untruncated text is in the same payload
- **Where:** `packages/core/src/dashframe.ts:156`  ·  **Dimension:** errors
- **Evidence:** `const title = str(p.title) \|\| str(p.text)` prefers the pre-truncated `title`. RUN: the live Timeline pane wraps prompt #1 across five lines and still ends `▸mea…`. Inspecting the payload the pane rendered from: `title` is 96 chars ending in `…`, `text` is 236 chars and complete (`"<the ask, 236 characters, complete>"`). 14 of the session's 37 prompts have an ellipsised title. The pane already goes to the trouble of wrapping, so the ellipsis buys nothing and violates the standing no-truncated-text rule.
- **Fix:** Prefer `str(p.text) \|\| str(p.title)`, or fall back to `text` when `title` ends in `…`. The wrapper already reclaims the pane's full width for continuations.
- **Why it survived refutation:** Reproduced, and every refutation angle failed. (1) Not pre-existing: `git ls-tree HEAD` contains neither packages/core/src/dashframe.ts nor packages/cli/src/dash.ts, and `git show HEAD:packages/cli/src/index.ts \| grep dash` matches only the id-validation phrase "dot, dash, underscore" — the whole dash surface is new in this change. (2) The full text IS in the payload the pane renders from: `promp

#### M3. Enter on a Timeline/Prompts row silently does nothing unless the prompt has exactly one edit
- **Where:** `packages/cli/src/dash.ts:509`  ·  **Dimension:** errors
- **Evidence:** `openSelected` ends with `if (row.ids.length === 1) showDiff(row.ids[0]);` — a prompt row carrying 0 or 6 edit ids falls off the end with no status change and no overlay. RUN, live runtime at 90x36 with the Timeline screen active: pressed Enter on prompt #1 (6 edits, as the row itself prints) — no overlay appeared and the status row did not change. The Timeline pane's primary drill-in gesture is a no-op on most of its rows, and says nothing.
- **Fix:** Say what happened rather than returning: e.g. `this prompt produced 6 edits — a/u review them, or press 1 for Traces`, matching the 'never a silent no-op' treatment `mutateScope` already gives (:288-295).
- **Why it survived refutation:** Reproduced exactly, with positive controls, and every refutation route failed. CODE: packages/cli/src/dash.ts:498-510 — openSelected has two exits (row.openPath toggle; row.ids.length===1 -> showDiff) and falls off the end for anything else. Prompt rows get ids = p.editIds (packages/core/src/dashframe.ts:159) and no openPath, so a 0-edit or multi-edit prompt row hits no branch. RUN (real interacti

#### M4. The session picker hard-slices titles at 44 characters with no ellipsis and no wrap
- **Where:** `packages/cli/src/dash.ts:591`  ·  **Dimension:** truncation
- **Evidence:** `const title = String(x.title \|\| '').slice(0, 44) \|\| String(x.id).slice(0, 8);` — a raw `.slice`, so unlike every other surface there is not even an ellipsis to signal loss, and the overlay renderer (dashframe.ts:577-587) neither wraps nor scrolls horizontally. Applied to the real `sessions` view: 41 sessions carry a title, 12 of them are cut. `"Improve code lens visibility with floating navbar"` renders as `"Improve code lens visibility with floating n"`; `"Debug /effort command and optimize codebase performance"` renders as `"Debug /effort command and optimize codebase "`. The picker is drawn at the full terminal width — at 120 columns the row uses ~70 and there are ~50 free.
- **Fix:** Size the title column from the terminal width (`cols - 25` or so) instead of the constant 44, and wrap the remainder onto a continuation line with `g.wrap` — the picker's cursor already tracks `o.cursor` against `lines`, so continuation rows need the same row-tagging paneBody uses.
- **Why it survived refutation:** SURVIVED — reproduced end-to-end in the running product, and every refutation path failed. CODE CONFIRMED. packages/cli/src/dash.ts:591 is exactly as quoted: `const title = String(x.title \|\| '').slice(0, 44) \|\| String(x.id).slice(0, 8);` — a raw slice with no ellipsis. The overlay renderer at packages/core/src/dashframe.ts:577-587 emits one `fitVisible(marked, cols)` per line: no wrap, no hori

#### M5. wrapVisible's hard break slices an SGR-bearing word by VISIBLE length, duplicating characters and leaking escape litter
- **Where:** `packages/core/src/textwidth.ts:177`  ·  **Dimension:** truncation
- **Evidence:** `rest = rest.slice(head.replace(SGR, '').length)` — the index is the count of VISIBLE JS chars, but `rest` still contains the escape bytes, so the slice lands inside the sequence. RAN wrapVisible on `'\x1b[38;5;173mnotes/an-unusually-long-generated-filename.md\x1b[0m'`: at width 40 the parts are `['…notes/an-unusually-long-generated-filenam', 'ed-filename.md']` — reassembling gives `notes/an-unusually-long-generated-filenamed-filename.md`, eleven characters duplicated into a path that does not exist. At width 8 the parts leak the escape as visible text: `['…notes/an', '73mnotes', '/there-s', …]`. REACHABILITY, measured end-to-end: scanning every screen at every pane width with depth='256' 
- **Fix:** Slice by the consumed source length rather than the visible length — have fitVisible return the number of input characters it consumed (or re-scan `rest` with the same SGR-aware walk fitVisible uses) and slice by that. Add a losslessness test: for coloured input, `stripSgr(wrapVisible(s, w).join('')).replace(/ /g,'') === stripSgr(s).replace(/ /g,'')`.
- **Why it survived refutation:** SURVIVES — reproduced by execution at three levels, and the file is new in this change (`git log -- packages/core/src/textwidth.ts` is empty; git status shows `A`), so it is not pre-existing. MECHANISM (confirmed, <repo>/packages/core/src/textwidth.ts:177). `rest = rest.slice(head.replace(SGR, '').length)` computes an index in VISIBLE characters and applies it to `

#### M6. wrapVisible does not terminate when the width is 1 and the text contains a wide character — renderDashFrame hangs 50s then throws
- **Where:** `packages/core/src/textwidth.ts:174`  ·  **Dimension:** truncation
- **Evidence:** `while (displayWidth(rest) > cols)` calls `fitVisible(rest, 1)`, which drops a straddling wide char whole and returns only padding; after `.replace(/ +$/, '')` the head is `''`, so `rest.slice(0)` returns `rest` unchanged and the loop pushes empty strings forever. RAN the loop by hand with a 50-step budget on `'漢字テスト'` at cols=1: every step yields `head=""`, `rest="漢字テスト"` — no progress, budget exhausted. RAN it end-to-end through the public renderer: `core.renderDashFrame(state, { cols: 5, rows: 20, … })` with one CJK filename in `list.edits` spun for 51,699 ms and then threw `RangeError: Invalid array length`; cols 6,7,8,10,20,40,80 all return 20 rows with zero over-wide lines. paneBody re
- **Fix:** Guarantee progress in the hard-break loop: if `head` is empty, take one code point unconditionally (`rest = rest.slice(String.fromCodePoint(rest.codePointAt(0)).length)`) so a wide char at width 1 emits a lone row rather than looping. A `if (cols < 2) cols = 2` guard in paneBody would also close the caller but leaves the primitive unsafe for other callers.
- **Why it survived refutation:** CONFIRMED — could not refute. The hard-break loop at packages/core/src/textwidth.ts:174-178 makes zero progress when cols===1 and the remaining word starts with a wide character: fitVisible(rest,1) drops the straddling wide char whole and returns ' ', .replace(/ +$/,'') empties it, so rest.slice(0) returns rest unchanged and lines.push('') runs until the array length overflows. Reachability is rea

#### M7. Timeline drops Observations without declaring it, and the doc that exists to declare drops says 'two views'
- **Where:** `packages/core/src/tui/layout.ts:144`  ·  **Dimension:** parity
- **Evidence:** PANE_SPECS gives timeline `tabs: ['Prompts','Actions']`. Both editors ship THREE peer views in the window the terminal is mirroring: packages/vscode/src/extension.ts:4125 `var TABS=[['prompts','Prompts'],['observations','Observations'],['actions','Actions']]`, and packages/jetbrains/.../model/NavGrouping.kt:64 `val TIMELINE_MEMBERS: List<String> = listOf(PROMPTS, OBSERVATIONS, ACTIONS)` rendered by TimelinePanel.kt:164. README:25 itself describes "the Observatory Timeline panel (Prompts · Observations · Actions)", then README:469 says "Two views the editors carry do not render in the terminal yet — Traces' File History and Dashboards' Stats". Observations is a third, and `observations` is al
- **Fix:** Either add an Observations tab to timeline (the view is already servable) or name it in the layout.ts:135-140 comment and in README:469 alongside File History and Stats. Do not leave the count at 'two'.
- **Why it survived refutation:** SURVIVES — I tried five refutation routes and every one failed against executed evidence. 1. "Maybe the terminal does render Observations somewhere." Refuted by execution. `node packages/cli/dist/index.js dash --once --cols 120 --rows 36 --no-color --session <session>-…` renders the Timeline strip as literally `[Prompts] Actions`. There is no observations screen anywhere in the runtime: `ScreenId` 

#### M8. Dashboards drops Processes without declaring it, though the CLI already serves that view
- **Where:** `packages/core/src/tui/layout.ts:145`  ·  **Dimension:** parity
- **Evidence:** Terminal Dashboards is `tabs: ['Tasks','Flows','Agents']`, mirroring three of the editors' five Overview nav members. NavGrouping.kt:17-21 declares SESSIONS, FLEET, WORKFLOWS, TASKS, PROCESSES, and extension.ts:6678 builds a `['processes','Processes', …]` tab. Sessions is covered by the terminal's session bar and `s`; Processes has no home in the terminal at all — TAB_SCREEN has no 'processes' entry and rowsFor (dashframe.ts:130-251) has no processes branch. It is servable today: `node packages/cli/dist/index.js processes --json --session <session>…` printed {"session":"…","summary":{"total":0,"running":0,"failed":0},"processes":[]}, and 'processes' is in runView's allow-list (index.ts:2341).
- **Fix:** Add a Processes tab to dashboards (rowsFor branch + TAB_SCREEN + VIEWS_FOR entry — the payload already exists), or name it in the layout.ts declaration comment and README:469 as a third absent view.
- **Why it survived refutation:** NOT REFUTED — reproduced end to end, though two parts of the reviewer's framing are wrong and should be corrected. WHAT IS TRUE AND VERIFIED BY EXECUTION: 1. The terminal has no Processes anywhere. Rendered frame at 120x30 for a session with ten real background shells: the Dashboards strip reads `[Tasks] Flows  Agents` and nothing in the frame mentions a shell. `grep -n "processes\\|shell" package

#### M9. README documents ↑ / ↓ for moving the selection; dash.ts has no arrow handler
- **Where:** `README.md:451`  ·  **Dimension:** parity
- **Evidence:** README:451 reads "\| `j` / `k`, `↑` / `↓` \| move the selection **in the focused window** \|". packages/core/src/tui/input.ts:77 decodes CSI A/B into `key: 'up'\|'down'`, but `grep -n "case 'up'\\|case 'down'" packages/cli/src/dash.ts` finds nothing — the switch falls to `default: return`. Verified live under a pty on the real session, two runs with identical timing: sending '\033[B' three times left the Traces cursor on `>? #1` in every captured frame; sending 'jjj' moved it `>? #1` → `>? #4`.
- **Fix:** Add `case 'up': return move(-1); case 'down': return move(1);` (and pgup/pgdn~/… while there, since the decoder already emits them) next to `case 'j'` at dash.ts:703 — or delete the arrows from README:451.
- **Why it survived refutation:** Could not refute — reproduced under a real pty with a positive control and a mutation test. (1) NOT pre-existing. `git show HEAD:README.md` contains zero `↑` (grep exit 1) while the current README contains one (grep exit 0, positive control). The entire key table at README.md:445-455 is an added (`+`) block in `git diff HEAD`, including line 451. `packages/cli/src/dash.ts` is a new file (git statu

#### M10. The non-TTY --once frame identifies the session by hex id where the interactive frame names it
- **Where:** `packages/cli/src/dash.ts:119`  ·  **Dimension:** parity
- **Evidence:** Diffed the interactive steady-state frame (captured under a pty, --no-color, 100x30) against `dash --once --cols 100 --rows 30 --no-color`, same session. Beyond the expected status row, row 1 differs: live prints `🔬 Research standalone GUI and CLI dashboard ▾` and --once prints `🔬 <session> ▾`. Cause: `sessionBar` (dashframe.ts:280) uses `state.sessionTitle \|\| state.session.slice(0,8)`; the interactive path sets `state.sessionTitle` from `changemap.summary.title` in backend.onData (dash.ts:249), the --once path at 118-121 assigns `state.views` and never sets it. The title IS in the payload the once path already fetched: `views --views changemap --json` returns summary.title = "Research st
- **Fix:** In the --once callback (dash.ts:118-121) set `state.sessionTitle = (views?.changemap as any)?.summary?.title \|\| ''` before rendering — the same one line onData already runs. Assert it in test/e2e.sh E2E 25.
- **Why it survived refutation:** I could not kill it. I tried all four refutation routes and each failed against executed evidence. **1. Misreading? No — reproduced by execution.** `node packages/cli/dist/index.js dash --once --cols 100 --rows 30 --no-color --session <session>-…` prints row 1 as: `🔬 <session> ▾                                            41 sessions · s to switch` Captured the interactive path under a real pty (`sc

#### M11. The keep/undo refusal lies on Tasks/Flows/Map and names 'audit', a surface the UI never shows
- **Where:** `packages/cli/src/dash.ts:292`  ·  **Dimension:** parity
- **Evidence:** Verified live under a pty on the real session. Pressed `2` (Dashboards → Tasks, a row visibly selected: `>▸ pending  0 edits  +0 −0  765aaa3cc707`) then `a` → status printed `nothing selected`. That is false; a row is selected, it just is not an edit. rowsFor gives `ids: []` to tasks (dashframe.ts:182), workflows (199) and map (153) rows, but the explanatory branch at dash.ts:291 covers only 'audit', 'feed' and 'agents', so those three fall through to the generic message. Then pressed `3` `]` (Timeline → Actions) and `a` → `audit rows are observations, not edits — use Edits or Prompts to keep`. The tab is labelled "Actions" (PANE_SPECS timeline tabs); "audit" is an internal TAB_SCREEN identi
- **Fix:** Key the message off the visible tab label rather than `state.screen` (PANE_SPECS[focus].tabs[tab]), and add tasks/workflows/map to the explaining branch — each with what it would take ("Tasks rows roll up edits; open the task's edits in Traces to keep them").
- **Why it survived refutation:** SURVIVES — I could not refute it; I reproduced both halves live on a real pty against the real session, and the change's own test file states the contract the runtime breaks. WHAT I RAN. `python3 <scratch>` drives the real interactive `dash` on a genuine pty (Python `pty.openpty()` + `TIOCSWINSZ` 40x120, so `process.stdin.isTTY && process.stdout.isTTY` ar

#### M12. The pane body drops sanitizeCell, so untrusted cell text reaches the terminal raw — a planted ESC[2J in a file path clears the dashboard
- **Where:** `packages/core/src/dashframe.ts:467`  ·  **Dimension:** perf
- **Evidence:** The old single-screen path calls `sanitizeCell(r.cells)` (dashframe.ts:610) before fitting. `paneBody` never calls it: pushWrapped -> wrapVisible -> gut -> fitVisible, and fitVisible only recognises SGR (`ESC[…m`); a non-SGR ESC falls through as an ordinary width-1 character. POSITIVE CONTROL (the instrument is proven to work — the old path catches the same input):   edits[0].file = '/a/b/\x1b[2J\x1b[1;1HPWNED.ts'   NEW pane path contains raw ESC[2J : true   OLD single-screen contains raw ESC[2J: false The repo's own fixture already plants this exact string (core.test.js:2095, `src/\x1b[2J\x1b[1;1Hevil.ts`), so the data shape is one the project already treats as reachable — but no pane test 
- **Fix:** Sanitize at the one place every pane row enters the frame: `pushWrapped(sanitizeCell(r.cells), i)` in dashframe.ts:459 (sanitize BEFORE measuring/wrapping, so the widths the wrapper computes are the widths that get drawn). Extend the existing evil-path fixture assertion to the pane path.
- **Why it survived refutation:** Reproduced, not refutable. (1) The code reads as claimed: dashframe.ts:459 does `rowsFor(...).forEach((r,i) => pushWrapped(r.cells, i))` with no sanitize, while the sibling single-screen path at dashframe.ts:610 does `const text = sanitizeCell(r.cells)`. rowsFor builds `cells` straight from transcript values (`str(e.file)`, prompt titles, task labels) and deliberately leaves sanitizing to its call

#### M13. 'A minimized pane genuinely stops being fetched' is false for three of the four panes — minimizing Detail or Dashboards saves exactly 0 bytes
- **Where:** `packages/cli/src/dash.ts:47`  ·  **Dimension:** perf
- **Evidence:** Measured the real byte cost of every layout's view set against the 2d9176cf payload by running viewsForLayoutOf over resolveLayout at 120x36 and summing the actual serialized views:   default (all four open)        11,197,942 B   minimize Dashboards            11,197,942 B   delta 0   minimize Detail                11,197,942 B   delta 0   minimize Timeline              11,154,455 B   delta -43,487 B  (-0.39%)   minimize Traces                 9,323,326 B   delta -1,874,616 B (-16.7%)   zoom to a single pane           9,279,839 B   — still 9.28 MB Reason: TAB_SCREEN.dashboards -> tasks/workflows/agents, all of which map to BASE; TAB_SCREEN.detail's default tab 'diff' has no VIEWS_FOR entry a
- **Fix:** Either make the claim true or delete it. Concretely: give Detail's Diff/Map and Dashboards' tabs their own view keys so minimizing them drops something, and split `changemap` so the always-on chrome (attention() needs only `changemap.summary`) does not drag `files[]`+`edits[]` — a `changemap-summary` view would cut the floor from 9.28 MB to well under 1 MB for every layout that is not showing the Map. Until then, reword the comment to say which pane actually saves what.
- **Why it survived refutation:** SURVIVES, but narrower than claimed and for a different reason than the reviewer's headline arithmetic. WHAT I TRIED TO KILL IT WITH, AND WHY EACH FAILED 1. "Pre-existing behaviour." Dead end. `git grep -l "renderDashFrame\\|runDash" HEAD` returns nothing and `packages/cli/src/dash.ts` is a 809-line ADD in the staged tree. `BASE`/`VIEWS_FOR`/`viewsForLayoutOf` and the comment at lines 46-50 are al

#### M14. wrapVisible's hard-break loop is O(L²) in the length of a single space-free token, and this change puts unbounded row text through it on the frame path for the first time
- **Where:** `packages/core/src/textwidth.ts:174`  ·  **Dimension:** perf
- **Evidence:** `while (displayWidth(rest) > cols) { const head = fitVisible(rest, cols)…; rest = rest.slice(…) }` — `displayWidth(rest)` is O(len(rest)) and allocates a stripSgr copy of it on every iteration, so a token of length L costs O(L²/cols) time and O(L²/cols) bytes. Measured at cols=32:     2,000 chars     0.93 ms     8,000 chars    10.54 ms   (4x length -> 11x time)    32,000 chars   160.97 ms   (4x -> 15x)   128,000 chars  2,523.61 ms  (4x -> 16x) Clean quadratic. Before this change wrapVisible had no caller in dashframe.ts (the captured diff adds it to the import); the old body path used fitVisible, which is O(cols) and cannot blow up. Now every row of every pane goes through it, and the row te
- **Fix:** Make the hard-break loop advance a cursor instead of re-measuring a shrinking tail: track a start index into `s`, call fitVisible from that index (or a width-aware slice), and never call displayWidth on the remainder. That makes it O(L). Cheap and independent of the other fixes.
- **Why it survived refutation:** SURVIVES — reproduced end to end. (1) The quadratic is real: textwidth.ts:174 `while (displayWidth(rest) > cols)` re-measures and stripSgr-copies the whole shrinking remainder every iteration; a 120,018-char space-free token at the production wrap width (29) takes 2,414 ms. (2) Not pre-existing: `git cat-file -e HEAD:packages/core/src/textwidth.ts` and `HEAD:packages/core/src/dashframe.ts` both fa

#### M15. The tab-strip test's "names the count" half is unasserted — a strip that reports 0 hidden tabs passes the whole suite
- **Where:** `packages/core/test/core.test.js:9046`  ·  **Dimension:** tests
- **Evidence:** The test asserts only that labels are intact and that the selected tab is drawn; it never inspects `tabMore`. I mutated layout.ts so both overflow markers lie — `hidden: from` -> `hidden: 0` and `hidden: p.tabs.length - to` -> `hidden: 0` — rebuilt, and ran the FULL suite: `tests 317 / pass 314 / fail 0`. The renderer draws these numbers directly (`tint("-${pre.hidden} ")` / `" +${post.hidden}"`, dashframe.ts:389,394), so the reader would see `-0` next to a strip that is in fact hiding tabs. Also, the test's own premise is stale: its comment says "Dashboards has six tabs" but PANE_SPECS gives it three ('Tasks','Flows','Agents'), and `tab: {dashboards: 5}` clamps to the LAST tab, so the strip
- **Fix:** Assert the counts and both directions: at a width where the strip overflows, check `pre.hidden + drawn + post.hidden === tabs.length`, and drive a selected tab at the START of the strip (e.g. `tab: {dashboards: 0}` at a narrow width) so `post` is exercised. Fix the comment's tab count while there.
- **Why it survived refutation:** CONFIRMED — I could not refute it. (1) The test at packages/core/test/core.test.js:9046 asserts only label integrity and that the selected tab is drawn; no test anywhere in the repo references `tabMore` (grep over core.test.js, packages/vscode/test/smoke.test.js, test/e2e.sh returns nothing; instrument verified — the same grep matches "hidden" in ~20 other test contexts). (2) Mutation test reprodu

#### M16. The E2E "names every window" check is satisfied by the status row, so it passes with the window bar broken
- **Where:** `test/e2e.sh:819`  ·  **Dimension:** tests
- **Evidence:** The check greps the whole frame for Traces/Timeline/Dashboards to prove "a minimized window keeps its chip, its jump key and its counter". But at the 96x14 size it uses, `Timeline` and `Dashboards` each appear on TWO rows: row 2 (the window bar) and row 12 (the blocked status row, "Timeline needs 98 cols · Dashboards needs 23 body rows"). I mutated dashframe.ts so the bar drops every minimized chip (`lay.bar` -> `lay.bar.filter(c => c.open)`), rebuilt core+cli, and rendered the real frame:   1 ▾Traces   0 ▾Detail                       <-- Timeline and Dashboards gone from the bar   E2E CHECK 1: **PASSES** against the broken product   E2E CHECK 4 (flags alone still open it, greps 'Timeline'):
- **Fix:** Anchor the grep to the window-bar row rather than the whole frame — e.g. `printf '%s\n' "$DASH" \| sed -n '3p' \| grep -qE '1 .Traces.*0 .Detail.*3 .Timeline.*2 .Dashboards'` — so the chip, not the status message, is what satisfies it. For check 4, grep for the bar row or a pane title instead of a bare window name.
- **Why it survived refutation:** SURVIVES on its headline claim; the secondary claim about line 824 is refuted. PART A (line 819) — REPRODUCED, and worse than claimed. At 96x14 the blocked status row is `at this size: Timeline needs 98 cols · Dashboards needs 23 body rows`, so `Timeline` and `Dashboards` each appear on TWO rows (row 3 window bar, row 13 status). I applied the reviewer's mutation at ~/…

### LOW (9)

#### L1. `?` prints a help string for a keymap that no longer exists
- **Where:** `packages/cli/src/dash.ts:781`  ·  **Dimension:** errors
- **Evidence:** Line 781 sets the status to `'keys: 1-6 screens · Tab next · j/k move · a keep · u undo · A/U all listed · R redo · / filter · r refresh · q quit'`. There are no 1-6 screens in this build — `jump` (:692-694) binds 1/2/3 to windows and 0 to Detail — and `m`, `z`, `=`, `[`/`]`, `M` and `s` are all unlisted. The frame's own keys row (dashframe.ts renderPanes) prints the correct `1-3 window · 0 detail · Tab · m min · z zoom · = reset · [ ] tab · …`, so the two surfaces of the same keymap disagree.
- **Fix:** Derive the `?` status from the same measured hint list `renderPanes` picks from, so one edit updates both.
- **Why it survived refutation:** Could not refute — reproduced on the real binary in a real pty. (1) Not pre-existing: HEAD 286a0a2 contains no dash at all (`git ls-tree -r --name-only HEAD \| grep -iE "dash\|tui"` → empty; `git grep "all listed" HEAD` → empty), and packages/cli/src/dash.ts is status A, so this change introduces the string. (2) Reachable: input.ts:152 emits key('?') for any plain printable char and onKey (dash.ts

#### L2. While an overlay is open the frame reverts to the legacy chrome and advertises the removed 8-screen keymap
- **Where:** `packages/core/src/dashframe.ts:556`  ·  **Dimension:** errors
- **Evidence:** `if (state.panes && !state.overlay)` sends every overlay to the pre-rework single-screen renderer, which draws `navRow` and the old key hints. RUN, live runtime: with the app menu open, row 2 read `1 Edits  2 Map  3 Prompts  4 Tasks  5 Flows  6 Agents  7 Feed  8 Audit` and row 35 read `1-8 screens · j/k move · enter open · a keep · u undo · A/U all · / filter · e $EDITOR · ? keys · q quit`; same with the session picker open. Digits 4-8 are unbound in this build, and `e` is bound nowhere in dash.ts (no `case 'e'`). The reader is shown a tab strip and a key list that do nothing.
- **Fix:** Keep the window bar and the pane keys row while an overlay is up (draw the overlay into the body region only), or at minimum print the current keymap on the overlay path.
- **Why it survived refutation:** Could not refute — reproduced end-to-end on the real binary. (1) NOT pre-existing: `git cat-file -e HEAD:packages/core/src/dashframe.ts` fails ("exists on disk, but not in HEAD"), `git grep "1-8 screens" HEAD` returns zero hits, and HEAD has no `dash` verb at all — the entire dash TUI and this hint string are authored by this uncommitted change. (2) NOT unreachable: packages/cli/src/dash.ts:96 alw

#### L3. The status row silently drops the tail of a captured child error, contradicting "shown, never discarded"
- **Where:** `packages/core/src/dashframe.ts:537`  ·  **Dimension:** truncation
- **Evidence:** `out.push(fitVisible(status, cols))` clips at the terminal width; the same clip is at line 628 for the single-screen path. `DashState.error` is documented at dashframe.ts:46 as "Captured child stderr. Shown, never discarded", and backend.ts deliberately pipes stderr so the reason is not swallowed. RENDERED a realistic 227-char spawn failure at cols=120: the row ends `…open '~/…` and 108 characters are gone, including the rest of the failing path and `at Object.openSync (node:fs:561:18)`. There is no scroll, no wrap, and no indication the message continued.
- **Fix:** Either wrap the error across the two chrome rows the frame already reserves at the bottom, or append a fixed marker plus a key that opens the full text in the existing overlay (`state.overlay` already renders arbitrary line arrays) so the message is reachable rather than deleted.
- **Why it survived refutation:** Could not refute — reproduced end-to-end in the real interactive dash. (1) Not pre-existing: `git cat-file -e HEAD:packages/core/src/dashframe.ts` reports the file is absent from HEAD and `git log --all` has no earlier copy, so the whole dash runtime is new in this change. (2) `state.error` is rendered at exactly two sites (dashframe.ts:532-533 and 625-626), both ending in `fitVisible(status, cols

#### L4. dash.ts still opens by declaring itself six screens
- **Where:** `packages/cli/src/dash.ts:4`  ·  **Dimension:** parity
- **Evidence:** File header line 4: "Six screens over one session, with the same review operations the editors have." The file it heads resolves four panes with eleven tabs and contains no screen switcher. layout.ts:148 has the same era's phrasing but is accurate (all eight screens are absorbed by TAB_SCREEN — verified: edits, map, feed, prompts, audit, tasks, workflows, agents).
- **Fix:** Replace with the three-windows-plus-Detail description the module actually implements.
- **Why it survived refutation:** SURVIVES — reproduced by execution, and the change authored the line. VERIFIED FACTS: 1. Line 4 says exactly: " * Six screens over one session, with the same review operations the editors have. Everything that can" (awk 'NR==4'). 2. NOT pre-existing. <repo>/packages/cli/src/dash.ts does not exist in HEAD (git cat-file -e HEAD:packages/cli/src/dash.ts -> "exists on 

#### L5. Dead helpers for the retired screen switcher are still compiled into the CLI
- **Where:** `packages/cli/src/dash.ts:480`  ·  **Dimension:** parity
- **Evidence:** `grep -n "tabAt(\\|gotoScreen(" packages/cli/src/dash.ts` matches only the definitions at 480 and 490 — neither is called; the mouse now routes through `core.hitTest` (425) and digits through the jump map (692). Both still compute against `core.SCREENS`, the eight-screen model, and `tabAt` reads the retired `frameCols >= 88` tab geometry. `const BODY_TOP = 3` at 413 is likewise unreferenced. All three survive the build (`npm run build` passes), so nothing flags them.
- **Fix:** Delete tabAt, gotoScreen and BODY_TOP with the legacy renderer, or enable noUnusedLocals for this package so the next retirement is caught by tsc.
- **Why it survived refutation:** Could not refute — reproduced under execution. (1) Repo-wide git grep over packages/scripts/test (excluding dist) matches tabAt, gotoScreen and BODY_TOP only at their definitions in packages/cli/src/dash.ts:413/480/490; instrument control passes, since the same query finds navRow's definition, its call site at dashframe.ts:569, and a comment mention. (2) Not tree-shaken: after a clean `npm run bui

#### L6. Nothing in the suite can fail on frame cost: the pane fixtures carry 3 edits, so a 15x regression and a 22,429-line-per-frame wrap pass are both green
- **Where:** `packages/core/test/core.test.js:9059`  ·  **Dimension:** perf
- **Evidence:** `paneFixture()` (core.test.js:9059) spreads `dashFixture()` (core.test.js:2088), whose `views.list.edits` has exactly 3 entries, `prompts.prompts` 1, `changemap.files` 1. The pane tests that exist assert geometry only — 'every frame fills the terminal exactly' (9066) checks line count and column budget; 'a wrapped row reassembles to its row text' checks characters. `grep -n 'hrtime\|budget' packages/core/test/core.test.js` finds one timing test (line 8255) and it is about syscall counts elsewhere, not the frame. test/e2e.sh:816 checks the `--once` frame's column budget only. So every measurement in this report — 113 ms frames, 22,429 visual lines built to draw 33, 25.4 MB of garbage per fram
- **Fix:** Add one test that builds a synthetic `list.edits` of ~5,000 rows and asserts (a) the number of visual lines paneBody produces is O(body height), not O(rows) — assert it directly by exposing a count or by wall-clock with a generous ceiling (e.g. < 15 ms at 120x36), and (b) that the focused pane contains exactly one cursor mark after N simulated moves. Both fail today and both pass with the windowed fix; a wall-clock ceiling that generous is stable on CI and still catches a 15x regression.
- **Why it survived refutation:** I could not kill it — I reproduced it with a positive control. DECISIVE EXPERIMENT. I extracted the staged tree to an isolated copy (`git checkout-index -a --prefix=…`), so no other agent's in-flight edits could contaminate it, and applied a pure cost regression to `paneBody` in `<repo>/packages/core/src/dashframe.ts:459` — 14 extra `rowsFor(...)+wrapVisible(...)` 

#### L7. The wrap test claims "character for character" but asserts one substring, so corruption outside the path is invisible
- **Where:** `packages/core/test/core.test.js:9080`  ·  **Dimension:** tests
- **Evidence:** The assertion is `got.includes(shown)` where `shown` is only the abbreviated path tail; the row's other half (state glyph, `#id`, relative time, `+12 −3`) is never checked. I mutated dashframe.ts to drop the last character of the non-continuation part of every wrapped row (`visual.push({ text: parts[0] ?? '', row })` -> `(parts[0] ?? '').slice(0, -1)`), rebuilt, and ran the FULL suite: `tests 317 / pass 314 / fail 0`, and the named test alone also passed. So a wrap regression that eats the review-state glyph or mangles the edit id is silently accepted. Worth stating clearly: the test IS strong on the defect it was written for — I reintroduced the exact historical two-pass `join(' ')` weld an
- **Fix:** Compare the reassembly against the full row text rather than a substring: build the expected row with `core.rowsFor(st, box.rect.w - 1, ...)` [0].cells, strip escapes, and assert equality after removing the layout's own padding — then the title's claim and the assertion match.
- **Why it survived refutation:** The finding SURVIVES, but the reviewer's stated evidence does not — I had to build a different mutant to prove their own conclusion. WHAT I KILLED — the cited experiment is an equivalent mutant, so the green suite was correct, not blind. In `rowsFor` (packages/core/src/dashframe.ts:141) the delta cell is `pad(`+A −R`, 12)`, so for an edits row `wrapVisible` always breaks inside that padding run an

#### L8. The measured key-hint degradation ladder has no test; replacing it with "always the longest" passes the whole suite
- **Where:** `packages/core/src/dashframe.ts:547`  ·  **Dimension:** tests
- **Evidence:** The change description lists "measured key hints" as new behaviour: four progressively shorter hint strings, with `.find((s) => displayWidth(s) <= budget)` picking the widest that fits. I mutated that to `[0]` (always the 118-column variant), rebuilt, and ran the FULL suite: `tests 317 / pass 314 / fail 0`. Nothing fails because the row is passed through `fitVisible(..., budget)` afterwards, which simply truncates it — at 60 columns the hints are cut mid-word, which is the same class the product's own no-truncation rule forbids. The frame-fills-terminal test only checks width, never that the hint row is a complete sentence.
- **Fix:** Assert the selection, not just the width: at cols in {60, 80, 120} check the rendered keys row equals one of the four declared variants exactly (after stripping the dim escape), so a truncated hint row fails.
- **Why it survived refutation:** SURVIVED — reproduced end to end in an isolated clean clone. I tried five refutation routes and every one failed. 1. "A test catches the mutation" — FALSE. Note first that the shared tree was being concurrently mutated by other refuters (I found `/* MUTANT: latch deleted */` in packages/cli/src/dash.ts, a `if (out) return out; // MUTANT` in packages/core/src/tui/layout.ts, and a `lay.bar.filter((c

#### L9. defaultMinimized, Backend.check, the app menu, focusPane and the twig toggle have no test at all
- **Where:** `packages/cli/src/dash.ts:399`  ·  **Dimension:** tests
- **Evidence:** Grepped packages/core/test/core.test.js, packages/vscode/test/smoke.test.js and test/e2e.sh: `defaultMinimized` appears 0 times, and nothing references onMouse, MENU/menuMode, focusPane, or backend.check. `core.hitTest` is tested only as a pure function (core.test.js:9028-9043) — never dash.ts's dispatch on it, so the twig cell toggling minimize while the rest of the chip focuses (dash.ts:433-442) is asserted in geometry but never in behaviour. E2E 25 renders one static frame and sends no keys or mouse reports. defaultMinimized decides the first paint (dash.ts:97) and the `=` reset key (dash.ts:736) and is untested in both roles. Backend.check I verified works by hand today — `node packages/
- **Fix:** Export the pane reducer from dash.ts (or move it to core beside layout.ts, which is where the parity rule wants it) so key/mouse dispatch is a pure function of (state, event) and can be unit-tested: assert the twig toggles while the chip focuses, that focusPane restores a minimized pane and swaps in its own cursor, that `=` returns to defaultMinimized, and that check() reports the fallback string when the child produces nothing.
- **Why it survived refutation:** SURVIVES — reproduced by mutation testing, not by reading. I sabotaged all five surfaces at once and the whole pipeline stayed green: `npm test` 318 tests / 315 pass / 0 fail / 3 skipped, and `bash test/e2e.sh` 307 passed / 0 failed. The mutations were (1) `defaultMinimized` made a total no-op (returns an empty Set at every size), (2) `backend.check()` spawning `['verzion','--chek']` instead of `[

---

## The lessons that survive a rewrite

The list above is specific to one TypeScript implementation. These are the underlying rules. A
reimplementation in any language gets these wrong by default unless it decides otherwise on purpose.

### 1. Visual lines and logical rows are different things, and both need names

The single largest cluster (six findings) came from one mistake: the body wrapped long rows onto
continuation lines, so a *row* began occupying several *lines* — while the cursor, the scroll offset,
the click handler and the clamp all kept counting rows, against the height of the whole terminal
rather than of the pane.

The symptoms looked unrelated: `j`/`k` walked the selection off the bottom of the window; a click
selected a different edit than the one under the pointer; scrolling jumped. They were one bug.

**The rule:** exactly one function converts a face into displayed lines, and it returns each line
tagged with the logical row it belongs to. The renderer draws from it, the hit-tester reads from it,
and the clamp is bounded by the *pane's* height. Any second place that computes geometry is a place
the glyph and the mouse can disagree — and the reader has no way to detect that they have.

### 2. In a tool that reverts code, a text-input mode must be a wall, not a filter

The keymap binds single letters to destructive verbs: `u` surgically reverts a file on disk. Opening
the `/` filter set a flag but never routed typed keys into it, so every keystroke fell through to
that keymap. Typing `readme` ran refresh, **keep**, and minimize — and keep actually mutated the
store. The mode was also invisible: the prompt rendered only once the buffer was non-empty, so the
frame was byte-identical to normal mode.

**The rule:** a mode that reads text consumes *every* key it does not explicitly handle, and it is
visible the instant it opens — before a single character exists. The same applies to a pending
confirmation: it owns the keyboard until answered, or Enter opens something underneath the question.

### 3. A confirmation that cannot be answered is worse than none

`A`/`U` set a confirm state and rendered `[y/n]`, but no handler bound `y` or `n`. The bulk verbs
were unreachable, and the only exit was Escape. The prompt was a promise the runtime did not keep.

**The rule:** the keys a prompt advertises are bound in the same change that renders the prompt, and
a test presses them. This one shipped through a full test suite because every test rendered the
frame and none pressed a key.

### 4. Never truncate content — and "content" is wider than it looks

The standing rule is that content text wraps rather than being cut. Nine findings are variations of
breaking it: the change map clips file and folder names with no marker, the diff overlay cuts diff
content at the terminal width, `tail()` throws away all but the last two path segments at *every*
width, and the prompt row renders a title the data layer already truncated to 96 characters with an
ellipsis — so `…` reaches a pane that was built to wrap.

Worse than truncation is *silent corruption*: an early wrap implementation rejoined hard-broken
pieces with a space and rendered `handler.md` as `handle r.md` — a path that does not exist, which
the reader cannot tell is wrong. Truncation at least announces itself.

**The rule:** wrapping is lossless and must be tested by reassembling the rendered lines and
comparing to the source *without normalising whitespace*. A comparison that squashes spaces passes
the exact bug it was written to catch.

### 5. A pure seam is worth more than the code it costs

`resolveLayout`, `hitTest` and `renderDashFrame` take no clock, no filesystem, no terminal. That is
the only reason a 60-column degradation, a tab-strip overflow and a wrap boundary can be asserted in
a unit test. Every finding that a test *did* catch was caught on that seam.

It is also where the tests were weakest: the latch test asserted a simulation written in the test
body rather than the product's own path, and the tab-strip test never asserted the "names the count"
half. **A test that passes against a mutated product is worse than no test**, because it is counted
as coverage.

### 6. "Not measured" and "measured zero" must never render alike

An empty pane rendered as blank space, which is indistinguishable from a pane that failed to load.
Minimized windows keep their chip and their counter for the same reason — a layout that silently
drops a window is a silent failure. Where a window genuinely cannot fit, the status row says what it
would take (`Timeline needs 98 cols`).

### 7. Measure the frame, and measure it at real cardinality

The wrap-everything implementation was 15–18× slower per frame, invisible in a test suite whose
fixtures carry three edits. At 22,429 rows it mattered; at 3 it could not. The fix — wrap only the
visible window — brought it to 1.78× at 421 rows and 0.93× (faster than the old path) at 22,429.

The residual cost is `rowsFor` building every row each frame, which is **O(n) in both the old and
new paths** and therefore predates this work. Recorded so it is not mistaken for a regression.

---

## Language datapoints for the rewrite (verified 2026-07-31)

| Agent CLI | Language | How it ships | Evidence |
|---|---|---|---|
| **OpenAI Codex** | **Rust** | native binary | GitHub API `language: Rust`, 102,875 stars |
| **Anthropic Claude Code** | **TypeScript/JS** | Bun-compiled single native binary | the shipped 245 MB Mach-O contains 905 `JavaScriptCore` strings, 942 `WebKit`, the literal `Bun v1.4.0`, 558 `napi_` symbols, and **zero** CPython symbols |
| **Google Gemini CLI** | **TypeScript** | `bundle/gemini.js` on Node ≥20, plus a `sea/` dir (Node Single Executable Application) | 20.2 MB TypeScript, npm workspaces `packages/*` — the same monorepo shape as this project |

**GitHub labels `anthropics/claude-code` as Python. That label is wrong for the product.** The repo
has no `src/`, `lib/`, `cli/`, `packages/` or `app/` (all 404); every `.py` file is in
`plugins/hookify/` and `plugins/security-guidance/` — example plugin hooks, not the agent.

So two of the three major agent CLIs are TypeScript, and both are moving toward single-executable
distribution rather than a language change.

### Where this project's time actually goes (measured, same day)

Every view is **CPU-bound** — user time ≈ real time, so a faster language can help; this is not an
I/O wall. Cold profile of the dominant path (8.61 s):

| Function | Self time | Share |
|---|---|---|
| `execEditLength` (Myers diff, inside the `diff` npm package) | 2,588 ms | **30.2%** |
| `parseTranscriptActionsUncached` | 912 ms | 10.7% |
| `parseToolUses` | 861 ms | 10.1% |
| `readFileUtf8` (native) | 791 ms | 9.2% |

Process startup is 0.05 s — **~1.8% of wall clock** on that path, so single-binary distribution buys
startup latency, not throughput.

**The largest single cost is one dependency, not our code.** That is replaceable on its own — a Rust
diff (`imara-diff`, `similar`) behind a sidecar or napi-rs — without touching the orchestration or
losing the pure-function seam that makes any of the above testable. Prior wins in this codebase were
algorithmic and larger than a language change typically delivers: Overview 14.25 s → 0.71 s from one
over-broad cache stamp; `observe --json` 5.92 s → 2.57 s and heap 803 MB → 13.5 MB from moving three
regexes inside a memo; 29,003 `stat` calls collapsed by batching.

### The measurement that decides the rewrite question

Independently reproduced on the cold path (the state a live dashboard pays continuously, because
every captured edit invalidates the change-map cache):

| `views changemap` | reads | files touched | bytes read | unique bytes | amplification |
|---|---|---|---|---|---|
| warm cache | 236 | 169 | 17.6 MiB | 15.0 MiB | 1.17× |
| **cold cache** | **7,443** | **2,147** | **1,942 MiB** | **490 MiB** | **3.96×** |

One transcript is opened and read **46 times** in a single invocation. 1,412 of 2,147 files are read
more than once. The cause is structural, not linguistic: the file cache memoizes derived *values*
per `(path, mtime, size)`, and there is no shared raw-text layer beneath it, so ten derivations of
the same transcript each re-read and re-split it from disk.

Two instrument failures produced a false negative here first, and both are worth recording. A hook
that patched only `readFileSync` missed 12 `openSync`/`readSync` call sites and under-reported by
two orders of magnitude. And measuring the *warm* path hid the effect entirely — 1.17× looks
healthy. **Verify the negative:** an amplification figure near 1.0 from a partially blind instrument
on the wrong cache state is indistinguishable from a clean result.

Collapsing the re-reads is a ~3.9× reduction in bytes touched, in TypeScript, with no new toolchain —
larger than any published Rust-behind-JavaScript factor for this class of work.

**Done, and measured after:** a shared `readText`/`readLines` layer keyed `(mtimeMs:size:ino)` took
the cold path from 1,942 MiB to 528.5 MiB and amplification from 3.96× to 1.05×; the transcript read
46 times is now read 4 times.

Equivalence was settled with a second working tree that has the layer reverted, not a build toggle —
two earlier attempts at a toggle failed to compile, so `dist` never updated and the comparison was a
build against itself. Both were caught, the second because the "bypassed" run implausibly reported
*fewer* reads than the cached one. With a real second tree: `list`, `prompts`, `risk`, `egress`,
`multitask` (428 KB) and `processes` are byte-identical. `changemap` differs in one field, `.agents` —
and the control shows two runs of the *same* build differ in exactly that field and no other, so it is
the live fleet moving between runs, not the layer.


---

## Closed since the review ran

| finding | how |
|---|---|
| `/` filter accepted no typed input while destructive keys stayed live | modal gate; every key it does not handle is swallowed, and the `/_` prompt appears the moment the mode opens |
| `[y/n]` confirm had no `y`/`n` handler — A/U were dead verbs | modal gate ahead of the jump table; verified on a fixture store that `y` undoes and `n` cancels |
| visual-line vs logical-row cluster (cursor, click mapping, clamp, 15–18× frame cost) | `paneVisible`/`paneRowCount` as the one shared map; `scroll` is a ROW index; only the visible window wraps |
| every overlay repainted as the retired eight-screen chrome | overlays keep the window bar |
| the overlay cut diff content at the terminal width | wraps onto a continuation reclaiming full width |
| `?` printed a six-screen keymap that never existed in this build | real help overlay, and `?` toggles it closed |
| `a`/`u` with Detail focused acted on the Traces list | guarded at the mutation site; the navbar's buttons resolve against the shown edit directly |
| Detail's Diff face never rendered | wired to the selection, debounced, late arrivals dropped |
| empty panes rendered as blank space | they name themselves |
| arrow keys did nothing though the README documented them | bound, with PageUp/PageDown and left/right for tabs |
| three of four seams could not be dragged | seams carry `target`/`sign`; the flex centre is never the target; both axes exist; an explicit drag outranks `COL_FLOOR` |
| Observations rendered `(0)` against a payload with 124 runs | `VIEWS_FOR` had no entry for the new screens, so the view was never requested — a missing allow-list entry and a genuinely empty result look identical on screen |
| Feed became unreachable in the five-region model | a Dashboards tab, with the other "what is running" surfaces |
| wrapped diff lines lost their leading indentation | hard wrap, byte-exact — word wrap changes what Python code MEANS |

Still open: the Map face clips names, `tail()` drops path segments, and the latch test asserts a
simulation rather than the product's own path.
