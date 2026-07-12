#!/usr/bin/env bash
# End-to-end integration test: drives the ACTUAL bundled CLI + capture hook over an isolated store.
# Repo-relative + self-contained (temp HOME/workspace); run via `npm run e2e`.
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$REPO/packages/cli/dist/index.js"
CAPTURE="$REPO/packages/cli/dist/capture.js"
SETLINE="$REPO/test/setline.js"
if [ ! -f "$CLI" ] || [ ! -f "$CAPTURE" ]; then echo "build first: npm run build"; exit 1; fi

TMP="$(cd "$(mktemp -d)" && pwd -P)"   # canonical path (macOS /var -> /private/var) so mangle == process.cwd()
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"
unset CLAUDE_CONFIG_DIR   # isolation: stats/usage read transcripts from here if set
WS="$TMP/ws"
SESSION="e2eSess"
mkdir -p "$WS"
MANGLE=$(printf '%s' "$WS" | sed 's/[^a-zA-Z0-9]/-/g')
mkdir -p "$HOME/.claude/projects/$MANGLE"
: > "$HOME/.claude/projects/$MANGLE/$SESSION.jsonl"

pass=0; fail=0
ok(){ if eval "$2"; then echo "  ✅ $1"; pass=$((pass+1)); else echo "  ❌ $1"; fail=$((fail+1)); fi; }
hook(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"%s","tool_input":{"file_path":"%s"}}' \
  "$SESSION" "$WS" "$1" "$2" "$3" | node "$CAPTURE"; }
cc(){ ( cd "$WS" && node "$CLI" "$@" ); }   # run from workspace -> exercises resolveSessionId end-to-end

echo "════════ E2E 1: three non-overlapping edits, undo the MIDDLE (must NOT false-conflict) ════════"
F="$WS/main.js"
printf 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nL11\nL12\n' > "$F"
hook PreToolUse Edit "$F"; node "$SETLINE" "$F" 0  "TOP";  hook PostToolUse Edit "$F"   # #1
hook PreToolUse Edit "$F"; node "$SETLINE" "$F" 5  "MID";  hook PostToolUse Edit "$F"   # #2
hook PreToolUse Edit "$F"; node "$SETLINE" "$F" 11 "BOT";  hook PostToolUse Edit "$F"   # #3
cc list >/dev/null
ok "3 edits recorded"  "[ \$(cc status | grep -oE 'edits:[[:space:]]+[0-9]+' | grep -oE '[0-9]+') -eq 3 ]"
cc undo 2 >/dev/null; rc=$?
ok "undo #2 succeeded (no false conflict)" "[ $rc -eq 0 ]"
ok "middle reverted to L6"      "grep -qx 'L6' '$F'"
ok "MID gone"                   "! grep -q 'MID' '$F'"
ok "TOP (edit #1) preserved"    "grep -qx 'TOP' '$F'"
ok "BOT (edit #3) preserved"    "grep -qx 'BOT' '$F'"

echo "════════ E2E 2: undo remaining two, then re-undo is a noop ════════"
cc undo 1 >/dev/null; cc undo 3 >/dev/null
ok "all reverted to original (TOP/MID/BOT gone)" "! grep -qE 'TOP|MID|BOT' '$F'"
out=$(cc undo 2); ok "re-undo #2 reports already undone" "echo \"\$out\" | grep -qi 'already undone'"
ok "status shows 3 undone" "[ \$(cc status | grep -oE '[0-9]+ undone' | grep -oE '[0-9]+') -eq 3 ]"

echo "════════ E2E 3: keep leaves disk untouched + shows in list ════════"
G="$WS/keep.txt"; printf 'a\nb\n' > "$G"
hook PreToolUse Edit "$G"; node "$SETLINE" "$G" 0 "AA"; hook PostToolUse Edit "$G"   # #4
h1=$(shasum "$G"|awk '{print $1}'); cc keep 4 >/dev/null; h2=$(shasum "$G"|awk '{print $1}')
ok "keep #4 no disk change" "[ '$h1' = '$h2' ]"
ok "list shows kept"        "cc list | grep -q kept"

echo "════════ E2E 4: new-file create + later edit -> undo create CONFLICTS (data-loss guard) ════════"
N="$WS/created.ts"
hook PreToolUse Write "$N"; printf 'export const x=1\n' > "$N"; hook PostToolUse Write "$N"  # #5 create
hook PreToolUse Edit  "$N"; printf 'export const x=1\nexport const y=2\n' > "$N"; hook PostToolUse Edit "$N"  # #6
cc undo 5 >/dev/null; rc=$?
ok "undo #5 (create w/ later edit) CONFLICTS, exit!=0" "[ $rc -ne 0 ]"
ok "file NOT deleted on conflict"        "[ -f '$N' ]"
ok "edit #6 content intact"              "grep -q 'y=2' '$N'"
cc undo 5 --force >/dev/null
ok "undo #5 --force deletes the created file" "[ ! -e '$N' ]"

echo "════════ E2E 5: diff of a force-undone create still renders ════════"
ok "diff #5 renders" "cc diff 5 | grep -q 'export const x=1'"

echo "════════ E2E 6: numeric --session id must NOT be mistaken for the edit id ════════"
NS=7
hookS(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$NS" "$WS" "$1" "$2" | node "$CAPTURE"; }
NF="$WS/num.txt"; printf 'p\nq\nr\n' > "$NF"
hookS PreToolUse "$NF"; node "$SETLINE" "$NF" 0 "PP"; hookS PostToolUse "$NF"
hookS PreToolUse "$NF"; node "$SETLINE" "$NF" 2 "RR"; hookS PostToolUse "$NF"
out=$(node "$CLI" diff --session "$NS" 2 2>&1)
ok "diff --session 7 2 targets edit #2" "echo \"\$out\" | grep -q 'RR'"
ok "  did NOT try edit #7 (the session value)" "! echo \"\$out\" | grep -qi 'no edit #7'"

echo "════════ E2E 7: redo re-applies an undone edit (fresh session) ════════"
RS=redoSess
hookR(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$RS" "$WS" "$1" "$2" | node "$CAPTURE"; }
RF="$WS/redo.txt"; printf 'one\ntwo\n' > "$RF"
hookR PreToolUse "$RF"; node "$SETLINE" "$RF" 0 "ONE"; hookR PostToolUse "$RF"
node "$CLI" undo --session "$RS" 1 >/dev/null
ok "undo reverted to 'one'" "grep -qx 'one' '$RF'"
node "$CLI" redo --session "$RS" 1 >/dev/null
ok "redo re-applied 'ONE'" "grep -qx 'ONE' '$RF'"
ok "redo set status back to pending" "node \"$CLI\" list --session \"$RS\" --pending | grep -q '#1'"

echo "════════ E2E 8: clean GC, clear --resolved, drop session ════════"
out=$(node "$CLI" clean --session "$RS" 2>&1)
ok "clean --session reports GC" "echo \"\$out\" | grep -qi 'garbage-collected'"
node "$CLI" keep --session "$RS" 1 >/dev/null
out=$(node "$CLI" clean --resolved --session "$RS" 2>&1)
ok "clean --resolved clears the kept edit" "echo \"\$out\" | grep -qiE 'cleared 1'"
node "$CLI" clean --drop "$RS" >/dev/null
ok "clean --drop removed the session" "! node \"$CLI\" sessions | grep -q \"$RS\""

echo "════════ E2E 9: init installs hooks, status reports them, uninstall removes them ════════"
out=$(cc init 2>&1)
ok "init installs capture hooks"          "echo \"\$out\" | grep -qi 'installed capture hooks'"
ok "settings.json now carries our hook"   "grep -q 'claude-observatory-hook' '$HOME/.claude/settings.json'"
ok "init is idempotent (2nd run no-op)"   "cc init 2>&1 | grep -qi 'already installed'"
ok "status reports hooks installed"       "cc status | grep -qE 'hooks:[[:space:]]+installed'"
out=$(cc uninstall 2>&1)
ok "uninstall removes capture hooks"      "echo \"\$out\" | grep -qi 'removed capture hooks'"
ok "hook gone from settings.json"         "! grep -q 'claude-observatory-hook' '$HOME/.claude/settings.json'"
ok "status now reports not installed"     "cc status | grep -qi 'not installed'"

echo "════════ E2E 10: list filters + diff of a KEPT edit + sessions listing ════════"
LS=listSess
hookL(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"Edit","tool_input":{"file_path":"%s"}}' "$LS" "$WS" "$1" "$2" | node "$CAPTURE"; }
LF="$WS/list.txt"; printf 'a\nb\nc\n' > "$LF"
hookL PreToolUse "$LF"; node "$SETLINE" "$LF" 0 "AA"; hookL PostToolUse "$LF"   # #1
hookL PreToolUse "$LF"; node "$SETLINE" "$LF" 2 "CC"; hookL PostToolUse "$LF"   # #2
node "$CLI" keep --session "$LS" 1 >/dev/null
ok "list --pending shows the pending #2"  "node \"$CLI\" list --session \"$LS\" --pending | grep -q '#2'"
ok "list --pending hides the kept #1"     "! node \"$CLI\" list --session \"$LS\" --pending | grep -q '#1'"
ok "list --kept shows the kept #1"        "node \"$CLI\" list --session \"$LS\" --kept | grep -q '#1'"
ok "list --file filters by substring"     "node \"$CLI\" list --session \"$LS\" --file list.txt | grep -q '#2'"
ok "list --file miss -> no matching edits" "node \"$CLI\" list --session \"$LS\" --file nope.zzz | grep -qi 'no matching'"
ok "diff of the KEPT edit #1 renders"     "node \"$CLI\" diff --session \"$LS\" 1 | grep -q 'AA'"
ok "sessions lists the session"           "node \"$CLI\" sessions | grep -q \"$LS\""

echo "════════ E2E 11: error handling + exit codes ════════"
node "$CLI" boguscmd >/dev/null 2>&1; rc=$?
ok "unknown command exits non-zero"       "[ $rc -ne 0 ]"
( cd "$WS" && node "$CLI" undo ) >/dev/null 2>&1; rc=$?
ok "undo with no id exits non-zero"       "[ $rc -ne 0 ]"
node "$CLI" diff --session "$LS" 999 >/dev/null 2>&1; rc=$?
ok "diff of a nonexistent id exits !=0"   "[ $rc -ne 0 ]"
node "$CLI" keep --session "$LS" 999 >/dev/null 2>&1; rc=$?
ok "keep of a nonexistent id exits !=0"   "[ $rc -ne 0 ]"
out=$(node "$CLI" undo --session "$LS" 999 2>&1); rc=$?
ok "undo of a nonexistent id errors"      "echo \"\$out\" | grep -qi 'no edit'"
ok "  and exits non-zero"                 "[ $rc -ne 0 ]"

echo "════════ E2E 12: status stays graceful on a malformed (wrong-shape) settings.json ════════"
printf '{"hooks":{"PreToolUse":{"matcher":"Edit"}},"theme":"dark"}' > "$HOME/.claude/settings.json"
cc status >/dev/null 2>&1; rc=$?
ok "status does NOT crash on wrong-shape hooks" "[ $rc -eq 0 ]"
ok "status leaves the settings.json intact"     "grep -q theme '$HOME/.claude/settings.json'"

echo "════════ E2E 13: stats --json emits valid JSON (30 daily + 24 hourly buckets) ════════"
STATS=$(cc stats --json 2>/dev/null); rc=$?
ok "stats --json exits 0"            "[ $rc -eq 0 ]"
ok "output is valid JSON"            "printf '%s' \"\$STATS\" | jq -e . >/dev/null"
ok "daily series has 30 buckets"     "[ \$(printf '%s' \"\$STATS\" | jq '.daily | length') -eq 30 ]"
ok "hourly series has 24 buckets"    "[ \$(printf '%s' \"\$STATS\" | jq '.hourly | length') -eq 24 ]"
ok "today's window counts the session's edits" "[ \$(printf '%s' \"\$STATS\" | jq '.windows.day.edits') -ge 1 ]"
ok "human stats renders the table"   "cc stats | grep -q 'Claude usage stats'"
STATS2=$(cc stats --json 2>/dev/null)
ok "second run (warm cache) agrees"  "[ \"\$(printf '%s' \"\$STATS\" | jq -S '.daily')\" = \"\$(printf '%s' \"\$STATS2\" | jq -S '.daily')\" ]"

echo "════════ E2E 14: machine-readable surface (--json + blob/locate/observe/usage) ════════"
# Two chained same-line edits collapse into ONE review unit (#A a->X superseded by #B X->Y).
J="$WS/json.txt"; printf 'a\nb\nc\n' > "$J"
hook PreToolUse Edit "$J"; node "$SETLINE" "$J" 1 "X"; hook PostToolUse Edit "$J"
hook PreToolUse Edit "$J"; node "$SETLINE" "$J" 1 "Y"; hook PostToolUse Edit "$J"
LISTJ=$(cc list --json)
ok "list --json is valid JSON with deltas" "printf '%s' \"\$LISTJ\" | jq -e '.edits[0].added >= 0' >/dev/null"
ok "same-code edits collapse to one review unit" "[ \$(printf '%s' \"\$LISTJ\" | jq '[.edits[]|select(.file|endswith(\"json.txt\"))]|length') -eq 1 ]"
REP=$(printf '%s' "$LISTJ" | jq "[.edits[] | select(.file|endswith(\"json.txt\")) | .id] | .[0]")
ok "status --json reports the session + counts" "cc status --json | jq -e '.session == \"$SESSION\" and .counts.total >= 2' >/dev/null"
ok "sessions --json marks the active session"   "cc sessions --json | jq -e '.active == \"$SESSION\"' >/dev/null"
# undo the collapsed group --json: clean revert of the whole change back to the original, exit 0
UJ2=$(cc undo "$REP" --json); rc2=$?
ok "undo group --json -> status:undone, exit 0" "[ $rc2 -eq 0 ] && printf '%s' \"\$UJ2\" | jq -e '.status == \"undone\"' >/dev/null"
ok "undo group reverts to the original"         "head -1 \"$J\" | grep -q '^a\$'"
ok "redo group --json re-applies"               "cc redo \"$REP\" --json | jq -e '.status == \"redone\"' >/dev/null"
ok "keep group --json"                          "cc keep \"$REP\" --json | jq -e '.kept >= 1' >/dev/null"
ok "keep --all --json sweeps the rest"          "cc keep --all --json | jq -e '.kept >= 0' >/dev/null"
# Structured conflict path: a MANUAL change between two same-line edits breaks the chain, so they do
# NOT collapse; undoing the earlier one then reports a structured conflict (front-ends branch on .status).
K="$WS/conflict.txt"; printf 'p\nq\nr\n' > "$K"
hook PreToolUse Edit "$K"; node "$SETLINE" "$K" 0 "M1"; hook PostToolUse Edit "$K"   # E1: line 0 p->M1
printf 'M1\nQX\nr\n' > "$K"   # manual (non-hook) change to line 1 -> breaks the before/after chain
hook PreToolUse Edit "$K"; node "$SETLINE" "$K" 0 "M2"; hook PostToolUse Edit "$K"   # E2: line 0 M1->M2 (not chained)
CID=$(cc list --json | jq "[.edits[] | select(.file|endswith(\"conflict.txt\")) | .id] | min")
UJ=$(cc undo "$CID" --json); rc=$?
ok "undo --json non-chained overlap -> status:conflict" "printf '%s' \"\$UJ\" | jq -e '.status == \"conflict\" and .ok == false' >/dev/null"
ok "undo --json conflict exit code is 1"     "[ $rc -eq 1 ]"
# blob: raw bytes round-trip through the store
SHA=$(jq -r 'select(.afterBlob != null) | .afterBlob' "$HOME/.claude/claude-observatory/$SESSION/log.jsonl" | head -1)
ok "blob streams raw bytes"                  "[ -n \"\$(cc blob \"$SHA\")\" ]"
# locate: live-buffer text on stdin -> per-edit current line indices (prior edits were all kept, so re-edit)
hook PreToolUse Edit "$J"; node "$SETLINE" "$J" 2 "Z"; hook PostToolUse Edit "$J"
LOC=$(cc locate --file "$J" < "$J")
ok "locate emits placements for the pending edit" "printf '%s' \"\$LOC\" | jq -e '.placements | length >= 1' >/dev/null"
ok "locate maps the edit to its current line"     "printf '%s' \"\$LOC\" | jq -e '.placements[-1].lines | index(2) != null' >/dev/null"
# observe: one payload for the Observations view
OBS=$(cc observe)
ok "observe emits per-edit summaries"        "printf '%s' \"\$OBS\" | jq -e '.edits[0].summary | length > 0' >/dev/null"
ok "observe carries memory + flags fields"   "printf '%s' \"\$OBS\" | jq -e '.edits[0] | has(\"memory\") and has(\"flags\")' >/dev/null"
# usage: no statusline cache in this HOME -> statuslineCache false + shared staleness threshold
ok "usage reports cache-missing + staleMs"   "cc usage | jq -e '.statuslineCache == false and .staleMs == 300000' >/dev/null"

echo "════════ E2E 15: bundled statusline installs with no network ════════"
cc statusline >/dev/null 2>&1; rc=$?
ok "statusline command exits 0"               "[ $rc -eq 0 ]"
ok "statusline.sh written under ~/.claude"    "[ -x \"$HOME/.claude/statusline.sh\" ]"
ok "settings.json gained the statusLine entry" "jq -e '.statusLine.command | test(\"statusline.sh\")' \"$HOME/.claude/settings.json\" >/dev/null"
ok "existing settings keys preserved"          "jq -e '.theme == \"dark\"' \"$HOME/.claude/settings.json\" >/dev/null"
ok "idempotent on re-run"                      "cc statusline >/dev/null 2>&1"

echo "════════ E2E 16: folder/file scoped Accept/Revert/Clear (--under) ════════"
mkdir -p "$WS/pkgA/sub" "$WS/pkgB"
FA="$WS/pkgA/a.txt";     printf 'a1\n' > "$FA"
FSU="$WS/pkgA/sub/s.txt"; printf 's1\n' > "$FSU"
FBP="$WS/pkgB/b.txt";    printf 'b1\n' > "$FBP"
hook PreToolUse Edit "$FA";  node "$SETLINE" "$FA"  0 "A2"; hook PostToolUse Edit "$FA"    # pkgA/a
hook PreToolUse Edit "$FSU"; node "$SETLINE" "$FSU" 0 "S2"; hook PostToolUse Edit "$FSU"   # pkgA/sub/s
hook PreToolUse Edit "$FBP"; node "$SETLINE" "$FBP" 0 "B2"; hook PostToolUse Edit "$FBP"   # pkgB/b
# keep --under a FOLDER accepts every pending edit beneath it (pkgA/a + pkgA/sub/s), never the sibling pkgB.
KOUT=$(cc keep --under "$WS/pkgA")
ok "keep --under folder accepts both edits beneath it" "echo \"\$KOUT\" | grep -qiE 'kept 2'"
ok "sibling pkgB edit is left pending"                 "cc list --json | jq -e '[.edits[]|select((.file|endswith(\"pkgB/b.txt\")) and .status==\"pending\")]|length==1' >/dev/null"
# clean --resolved --under a folder drops only that folder's resolved edits.
COUT=$(cc clean --resolved --under "$WS/pkgA")
ok "clean --resolved --under folder clears the 2 kept"  "echo \"\$COUT\" | grep -qiE 'cleared 2'"
ok "pkgA edits gone from the log; pkgB still present"    "cc list --json | jq -e '([.edits[]|select(.file|contains(\"pkgA\"))]|length==0) and ([.edits[]|select(.file|endswith(\"pkgB/b.txt\"))]|length==1)' >/dev/null"
# undo --under an EXACT FILE reverts just that file's edit (folder-prefix rule matches the file itself).
UOUT=$(cc undo --under "$FBP")
ok "undo --under file reverts that file's edit"          "echo \"\$UOUT\" | grep -qiE 'reverted 1'"
ok "pkgB/b.txt restored to original 'b1'"                "grep -qx 'b1' '$FBP'"
# undo --under reverts PENDING edits only — an already-Accepted (kept) edit is left on disk.
mkdir -p "$WS/pkgC"
FCP="$WS/pkgC/p.txt"; FCK="$WS/pkgC/k.txt"
printf 'p1\n' > "$FCP"; printf 'k1\n' > "$FCK"
hook PreToolUse Edit "$FCP"; node "$SETLINE" "$FCP" 0 "P2"; hook PostToolUse Edit "$FCP"   # pkgC/p (stays pending)
hook PreToolUse Edit "$FCK"; node "$SETLINE" "$FCK" 0 "K2"; hook PostToolUse Edit "$FCK"   # pkgC/k (accepted)
cc keep --under "$FCK" >/dev/null                                                          # accept just k.txt
RUOUT=$(cc undo --under "$WS/pkgC")
ok "undo --under folder reverts only the 1 pending edit"  "echo \"\$RUOUT\" | grep -qiE 'reverted 1'"
ok "pending pkgC/p.txt restored to original 'p1'"          "grep -qx 'p1' '$FCP'"
ok "accepted pkgC/k.txt left on disk (K2)"                 "grep -q 'K2' '$FCK'"
ok "accepted pkgC/k.txt is still status=kept"              "cc list --json | jq -e '[.edits[]|select((.file|endswith(\"pkgC/k.txt\")) and .status==\"kept\")]|length==1' >/dev/null"
# undo --all is the session-wide bulk revert (mirror of keep --all) — emits the same scoped shape.
ok "undo --all --json emits {undone,conflicts,total}"      "cc undo --all --json | jq -e 'has(\"undone\") and has(\"conflicts\") and has(\"total\")' >/dev/null"

echo "════════════════════════════════════════════════════════"
echo "E2E RESULT: $pass passed, $fail failed"
[ $fail -eq 0 ]
