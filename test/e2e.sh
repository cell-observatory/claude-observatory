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

echo "════════════════════════════════════════════════════════"
echo "E2E RESULT: $pass passed, $fail failed"
[ $fail -eq 0 ]
