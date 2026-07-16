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
# changemap: the Change Map view-model — core does every rollup so both editors render it as given
CM=$(cc changemap)
ok "changemap emits summary/edits/chapters/files/modules" "printf '%s' \"\$CM\" | jq -e 'has(\"summary\") and has(\"edits\") and has(\"chapters\") and has(\"files\") and has(\"modules\")' >/dev/null"
ok "changemap file rows carry the core-computed rollup"   "printf '%s' \"\$CM\" | jq -e '.files[0] | has(\"churn\") and has(\"status\") and has(\"maxId\") and has(\"moduleLabel\")' >/dev/null"
ok "changemap module rows carry a label + churn"          "printf '%s' \"\$CM\" | jq -e '.modules[0] | has(\"label\") and has(\"churn\") and has(\"status\")' >/dev/null"
ok "changemap churn is conserved from files up to modules" "printf '%s' \"\$CM\" | jq -e '([.files[].churn]|add) == ([.modules[].churn]|add)' >/dev/null"
ok "changemap files are ranked churn-desc"                "printf '%s' \"\$CM\" | jq -e '[.files[].churn] == ([.files[].churn]|sort|reverse)' >/dev/null"
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

echo "════════ E2E 17: 0.8.0 multi-agent (multitask / tasklog / siblings --repo / changemap agents / chat-context / task-keep|undo) ════════"
# A plain .git DIRECTORY makes commonDir resolve (git-free — no git binary), so listRepoSiblings can
# group worktree-siblings by repo. Two sessions launched from $WS share this repo key.
mkdir -p "$WS/.git"
MTA=mtAgent; MTB=mtBgent
CONTENT="implement shared feature"
# Transcripts: a first user line carrying cwd+gitBranch (so firstCwdLine/listRepoSiblings resolve the
# repo), then TWO TodoWrite snapshots of the SAME in_progress to-do bracketing "now" — a REAL strict
# in_progress interval so the edits captured below fall inside it and get a stable taskId (§2.1).
node -e '
  const fs=require("fs");
  const [proj, ws, mta, mtb, content]=process.argv.slice(1);
  const TA=new Date(Date.now()-3600000).toISOString();
  const TB=new Date(Date.now()+3600000).toISOString();
  const cwdLine=(sid,br)=>JSON.stringify({type:"user",sessionId:sid,cwd:ws,gitBranch:br,timestamp:TA});
  const todoLine=(ts)=>JSON.stringify({type:"assistant",timestamp:ts,message:{role:"assistant",content:[{type:"tool_use",id:"tu_"+ts,name:"TodoWrite",input:{todos:[{content,status:"in_progress"}]}}]}});
  // A Task (subagent-spawn) action in agent A only — so the multitask Actions section can prove it
  // DROPS the "agent" (Subagents) category (those are the fleet rows above), while `cc actions` keeps it.
  const agentLine=(ts)=>JSON.stringify({type:"assistant",timestamp:ts,message:{role:"assistant",content:[{type:"tool_use",id:"ag_"+ts,name:"Task",input:{description:"spawn helper",subagent_type:"general-purpose"}}]}});
  for (const [sid,br] of [[mta,"feat/a"],[mtb,"feat/b"]]) {
    const lines=[cwdLine(sid,br), todoLine(TA), todoLine(TB)];
    if (sid===mta) lines.push(agentLine(TA));
    fs.writeFileSync(proj+"/"+sid+".jsonl", lines.join("\n")+"\n");
  }
' "$HOME/.claude/projects/$MANGLE" "$WS" "$MTA" "$MTB" "$CONTENT"
# One subagent under agent A, with its OWN in_progress TodoWrite (so subagentTodos.currentTask is set).
mkdir -p "$HOME/.claude/projects/$MANGLE/$MTA/subagents"
node -e '
  const fs=require("fs");
  const [dir, content]=process.argv.slice(1);
  const line=JSON.stringify({type:"assistant",isSidechain:true,timestamp:new Date().toISOString(),agentId:"suba",sessionId:"mtAgent",message:{role:"assistant",content:[{type:"tool_use",id:"stu1",name:"TodoWrite",input:{todos:[{content,status:"in_progress"}]}}]}});
  fs.writeFileSync(dir+"/agent-suba.jsonl", line+"\n");
' "$HOME/.claude/projects/$MANGLE/$MTA/subagents" "subagent task alpha"
# A WORKFLOW RUN (0.8.0) under agent A: <session>/subagents/workflows/wf_<id>/ (journal + one agent
# transcript + meta sidecar), plus the rich per-run STATE FILE <session>/workflows/wf_<id>.json (0.8.0 r2,
# the PRIMARY source: informative name/summary, real phase titles, labeled agents). Two tool_use turns 2h
# apart, BRACKETING now (T0=now-1h, T1=now+1h) with usage + an Edit → the run surfaces per-agent + run-level
# tokens/durationMs/edits, and its ts-window contains the shared.txt store edit captured below, so changemap
# can attribute that edit to this workflow (0.8.0 r2, §C/§D).
node -e '
  const fs=require("fs"), path=require("path");
  const [sessDir]=process.argv.slice(1);
  const T0=new Date(Date.now()-3600000).toISOString(), T1=new Date(Date.now()+3600000).toISOString();
  const wf=path.join(sessDir,"subagents","workflows","wf_e2e"); fs.mkdirSync(wf,{recursive:true});
  const scripts=path.join(sessDir,"workflows","scripts"); fs.mkdirSync(scripts,{recursive:true});
  fs.writeFileSync(path.join(scripts,"e2e-flow-wf_e2e.js"),
    "export const meta = {\n  name: '"'"'E2E Flow'"'"',\n  description: '"'"'an e2e workflow'"'"',\n  phases: [{ title: '"'"'Do'"'"' }],\n}\n");
  fs.writeFileSync(path.join(sessDir,"workflows","wf_e2e.json"),JSON.stringify({
    workflowName:"E2E Flow", summary:"an informative e2e workflow that ships in both editors",
    phases:[{title:"Do",detail:"the work"}],
    workflowProgress:[{type:"workflow_phase",index:0,title:"Do"},
      {type:"workflow_agent",label:"S1-do",phaseTitle:"Do",phaseIndex:0,agentId:"wfa",tokens:400,toolCalls:2,state:"completed",durationMs:7200000}],
    totalTokens:400, totalToolCalls:2, durationMs:7200000, status:"completed", startTime:T0, agentCount:1}));
  fs.writeFileSync(path.join(wf,"journal.jsonl"),
    [{type:"started",key:"k1",agentId:"wfa"},{type:"result",key:"k1",agentId:"wfa",result:{ok:true}}].map(o=>JSON.stringify(o)).join("\n"));
  fs.writeFileSync(path.join(wf,"agent-wfa.meta.json"),JSON.stringify({agentType:"workflow-subagent",spawnDepth:1}));
  fs.writeFileSync(path.join(wf,"agent-wfa.jsonl"),
    [ {timestamp:T0,message:{role:"assistant",id:"w1",usage:{input_tokens:100,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:200},content:[{type:"tool_use",id:"we1",name:"Edit",input:{file_path:"/f.ts",old_string:"a\nb\n",new_string:"a\nb\nc\n"}}]}},
      {message:{role:"user",content:[{type:"tool_result",tool_use_id:"we1",is_error:false}]}},
      {timestamp:T1,message:{role:"assistant",id:"w2",usage:{input_tokens:50,cache_read_input_tokens:0,cache_creation_input_tokens:0,output_tokens:50},content:[{type:"tool_use",id:"we2",name:"Read",input:{file_path:"/g.ts"}}]}} ].map(o=>JSON.stringify(o)).join("\n"));
' "$HOME/.claude/projects/$MANGLE/$MTA"
# Both agents edit the SAME file $WS/shared.txt (A first, then B) → a cross-agent collision + a task
# both agents contribute to. Chain the edits so B is the newest edit on the file (clean task-undo below).
mthook(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"%s","tool_input":{"file_path":"%s"}}' "$1" "$WS" "$2" "$3" "$4" | node "$CAPTURE"; }
SF="$WS/shared.txt"; printf 'base\n' > "$SF"
mthook "$MTA" PreToolUse Edit "$SF"; node "$SETLINE" "$SF" 0 "A_X"; mthook "$MTA" PostToolUse Edit "$SF"   # A: base->A_X
mthook "$MTB" PreToolUse Edit "$SF"; node "$SETLINE" "$SF" 0 "B_Y"; mthook "$MTB" PostToolUse Edit "$SF"   # B: A_X->B_Y

# --- multitask: one payload for the whole fleet, aggregated in core/CLI (renderers stay thin) ---
MT=$(cc multitask --session "$MTA" 2>/dev/null)
ok "multitask --json is valid JSON"                     "printf '%s' \"\$MT\" | jq -e . >/dev/null"
ok "multitask carries agents/collisions/worktrees/summary" "printf '%s' \"\$MT\" | jq -e 'has(\"agents\") and has(\"collisions\") and has(\"worktrees\") and has(\"summary\")' >/dev/null"
ok "multitask groups BOTH worktree-siblings as agents"  "[ \$(printf '%s' \"\$MT\" | jq '.agents|length') -ge 2 ]"
ok "multitask agent row carries phase/phaseConfidence/sparkline(20)/diff/risk" "printf '%s' \"\$MT\" | jq -e '.agents[0] | has(\"phase\") and has(\"phaseConfidence\") and (.sparkline|length==20) and (.diff|has(\"added\") and has(\"removed\")) and has(\"risk\")' >/dev/null"
# 0.8.0 r3 (M1): each fleet sibling gains tokens + wall-clock (durationMs) — the SAME metric style Workflows
# already show. The two agent transcripts span TA→TB (2h), so durationMs>0; tokens is present (0 here — those
# lines carry no usage block).
ok "multitask agent row carries tokens + durationMs (fleet metrics)" "printf '%s' \"\$MT\" | jq -e '.agents[0] | has(\"tokens\") and has(\"durationMs\") and (.durationMs>0)' >/dev/null"
ok "multitask subagents carry todos + currentTask"      "printf '%s' \"\$MT\" | jq -e '[.agents[].subagents[] | select(has(\"todos\") and has(\"currentTask\"))]|length>=1' >/dev/null"
ok "multitask subagent currentTask extracted (in_progress todo)" "printf '%s' \"\$MT\" | jq -e '[.agents[].subagents[] | select(.currentTask==\"subagent task alpha\")]|length>=1' >/dev/null"
ok "multitask collisions come from the UNCAPPED set (shared.txt, 2 agents)" "printf '%s' \"\$MT\" | jq -e '[.collisions[] | select((.file|endswith(\"shared.txt\")) and (.agents|length>=2))]|length==1' >/dev/null"
ok "multitask summary reports the conflict"             "printf '%s' \"\$MT\" | jq -e '.summary.conflicts>=1' >/dev/null"
# 0.8.0 r2 (B): a collision is a LIVE overlap — shared.txt is PENDING in 2 BOTH-active agents (not just
# a historically-shared path). anyPending is by-definition true; the named agents are the active ones.
ok "multitask collision is a live pending overlap (anyPending)" "printf '%s' \"\$MT\" | jq -e '[.collisions[] | select((.file|endswith(\"shared.txt\")) and .anyPending==true)]|length==1' >/dev/null"

# --- 0.8.0: workflow-run tracking — one level above subagents, aggregated in core (renderers stay thin) ---
ok "multitask carries a workflows array"                "printf '%s' \"\$MT\" | jq -e '.workflows|type==\"array\"' >/dev/null"
ok "multitask workflow run carries agents+tokens+durationMs+edits" "printf '%s' \"\$MT\" | jq -e '[.workflows[] | select((.agents|type==\"array\") and has(\"tokens\") and has(\"durationMs\") and has(\"edits\"))]|length>=1' >/dev/null"
ok "multitask workflow name/phases resolved from the script meta" "printf '%s' \"\$MT\" | jq -e '[.workflows[] | select(.name==\"E2E Flow\" and (.phases==[\"Do\"]))]|length==1' >/dev/null"
ok "multitask workflow surfaces summed tokens>0/durationMs>0/edits>=1" "printf '%s' \"\$MT\" | jq -e '[.workflows[] | select(.tokens>0 and .durationMs>0 and .edits>=1)]|length>=1' >/dev/null"
ok "multitask workflow agent carries per-agent tokens/durationMs/edits" "printf '%s' \"\$MT\" | jq -e '[.workflows[].agents[] | select(has(\"tokens\") and has(\"durationMs\") and has(\"edits\"))]|length>=1' >/dev/null"
# 0.8.0 r2: the rich state file is the PRIMARY source — informative description (summary), real per-phase
# grouping (phaseGroups), and labeled agents carrying a REAL phase title (not the journal hash).
ok "multitask workflow carries an informative description (state summary)" "printf '%s' \"\$MT\" | jq -e '[.workflows[] | select(.id==\"wf_e2e\" and (.description|test(\"informative e2e workflow\")))]|length==1' >/dev/null"
ok "multitask workflow carries phaseGroups (Do done 1/1)"  "printf '%s' \"\$MT\" | jq -e '[[.workflows[]|select(.id==\"wf_e2e\")][0].phaseGroups[] | select(.title==\"Do\" and .done==1 and .total==1)]|length==1' >/dev/null"
ok "multitask workflow agent carries label + real phase title" "printf '%s' \"\$MT\" | jq -e '[.workflows[].agents[] | select(.label==\"S1-do\" and .phase==\"Do\")]|length==1' >/dev/null"

# --- 0.8.0 (A): Actions folded into Multitasking — a curated tool-call timeline + egress for the ACTIVE
#     session, MINUS the fleet/subagent (agent) category (already the fleet rows above) ---
ok "multitask carries an actions section (groups + egress)" "printf '%s' \"\$MT\" | jq -e '.actions | has(\"groups\") and has(\"egress\")' >/dev/null"
ok "multitask actions has ≥1 curated group"             "printf '%s' \"\$MT\" | jq -e '.actions.groups|length>=1' >/dev/null"
ok "multitask actions DROPS the subagent (agent) group" "printf '%s' \"\$MT\" | jq -e '[.actions.groups[] | select(.category==\"agent\")]|length==0' >/dev/null"
# Proof the drop is real: the standalone `actions` view DOES surface the agent group for this session.
ok "actions view (unfolded) still shows the agent group" "cc actions --session \"$MTA\" --json | jq -e '[.groups[] | select(.category==\"agent\")]|length>=1' >/dev/null"

# --- subagents: each subagent now carries running/phase + sidecar-ish todos/currentTask (S4/S5) ---
SA=$(cc subagents --session "$MTA" --json 2>/dev/null)
ok "subagents --json subagent carries running/phase/todos/currentTask" "printf '%s' \"\$SA\" | jq -e '[.subagents[] | select(has(\"running\") and has(\"phase\") and has(\"todos\") and has(\"currentTask\"))]|length>=1' >/dev/null"

# --- tasklog: one row per stable taskId, unioned across worktree-siblings ---
TL=$(cc tasklog 2>/dev/null)
ok "tasklog --json is an array"                         "printf '%s' \"\$TL\" | jq -e 'type==\"array\"' >/dev/null"
ok "tasklog row carries taskId/agentIds/edits/added/removed/status" "printf '%s' \"\$TL\" | jq -e '.[0] | has(\"taskId\") and has(\"agentIds\") and has(\"edits\") and has(\"added\") and has(\"removed\") and has(\"status\")' >/dev/null"
ok "tasklog unions ONE task across BOTH agents (2 agentIds)" "printf '%s' \"\$TL\" | jq -e '[.[] | select(.agentIds|length>=2)]|length>=1' >/dev/null"

# --- siblings --repo: worktree-scoped, each sibling gains worktree/gitBranch/phase; summary.conflicts ---
SR=$(cc siblings --repo --session "$MTA" --json 2>/dev/null)
ok "siblings --repo siblings carry worktree/gitBranch/phase" "printf '%s' \"\$SR\" | jq -e '[.siblings[] | select(has(\"worktree\") and has(\"gitBranch\") and has(\"phase\"))]|length>=1' >/dev/null"
ok "siblings --repo summary carries conflicts (uncapped)" "printf '%s' \"\$SR\" | jq -e '.summary.conflicts>=1' >/dev/null"

# --- changemap: additive keys (removing nothing) — agents[] per-sibling builds + unassigned bucket ---
CM2=$(cc changemap --session "$MTA" 2>/dev/null)
ok "changemap still carries summary/edits/chapters/files/modules" "printf '%s' \"\$CM2\" | jq -e 'has(\"summary\") and has(\"edits\") and has(\"chapters\") and has(\"files\") and has(\"modules\")' >/dev/null"
ok "changemap adds rollupByAgent/agents/unassigned"     "printf '%s' \"\$CM2\" | jq -e 'has(\"rollupByAgent\") and has(\"agents\") and has(\"unassigned\")' >/dev/null"
ok "changemap agents[] is a per-sibling change-map build (both worktrees)" "printf '%s' \"\$CM2\" | jq -e '[.agents[] | select(has(\"summary\") and has(\"edits\") and has(\"rollupByTask\"))]|length>=2' >/dev/null"
ok "changemap per-edit carries taskId (strict spans)"   "printf '%s' \"\$CM2\" | jq -e '.edits[0] | has(\"taskId\")' >/dev/null"
ok "changemap unassigned bucket has taskId null"        "printf '%s' \"\$CM2\" | jq -e '.unassigned.taskId==null' >/dev/null"

# --- 0.8.0 r2 (C/D): workflow→edit attribution + the Overview per-workflow dimension ---
ok "changemap adds rollupByWorkflow + workflows[] + per-edit workflowId" "printf '%s' \"\$CM2\" | jq -e 'has(\"rollupByWorkflow\") and (.workflows|type==\"array\") and (.edits[0]|has(\"workflowId\"))' >/dev/null"
ok "changemap attributes MTA's in-window store edit to wf_e2e" "printf '%s' \"\$CM2\" | jq -e '[.edits[] | select(.workflowId==\"wf_e2e\")]|length>=1' >/dev/null"
ok "changemap workflows[] has the wf_e2e tab (named, ≥1 edit, ≥1 file)" "printf '%s' \"\$CM2\" | jq -e '[.workflows[] | select(.id==\"wf_e2e\" and .name==\"E2E Flow\" and .rollup.edits>=1 and (.files|length>=1))]|length==1' >/dev/null"
ok "changemap rollupByWorkflow has the wf_e2e row"      "printf '%s' \"\$CM2\" | jq -e '[.rollupByWorkflow[] | select(.workflowId==\"wf_e2e\")]|length==1' >/dev/null"

# --- chat-context: a zero-token, ready-to-paste prompt; assembled from plain files, NO model spawn ---
EID=$(cc list --session "$MTA" --json | jq '.edits[0].id')
CX=$(cc chat-context --session "$MTA" --edit "$EID" 2>/dev/null); rc=$?
ok "chat-context exits 0 (no model, no network)"        "[ $rc -eq 0 ]"
ok "chat-context returns a non-empty prompt"            "printf '%s' \"\$CX\" | jq -e '.prompt|length>0' >/dev/null"
ok "chat-context prompt carries the edit before/after"  "printf '%s' \"\$CX\" | jq -e '.prompt|test(\"before\")' >/dev/null"
TID=$(printf '%s' "$CM2" | jq -r '[.edits[] | select(.taskId!=null) | .taskId][0]')
ok "an edit resolved to a strict-span taskId"           "[ -n \"$TID\" ] && [ \"$TID\" != null ]"
ok "chat-context --task frames the task (no model call)" "cc chat-context --session \"$MTA\" --task \"$TID\" | jq -e '.prompt|test(\"task\")' >/dev/null"

# --- task-keep / task-undo: resolve taskId -> STRICT-span edit set -> keep/undo (destructive, last) ---
TK=$(cc task-keep --session "$MTA" "$TID" --json)
ok "task-keep --json keeps agent A's strict-span edit(s)" "printf '%s' \"\$TK\" | jq -e '.kept>=1 and (.ids|length>=1)' >/dev/null"
TU=$(cc task-undo --session "$MTB" "$TID" --json)
ok "task-undo --json reverts agent B's strict-span edit(s)" "printf '%s' \"\$TU\" | jq -e '.undone>=1 and (.conflicts==0)' >/dev/null"
ok "task-undo restored shared.txt to A's content (A_X)"  "grep -qx 'A_X' '$SF'"

# --- 0.8.0 (C): task-clear — drop a chapter's RESOLVED (kept/undone) strict-span edits; --completed
#     clears every SETTLED chapter. Agent B's TID edit is now UNDONE; agent A's TID edit is now KEPT. ---
TC=$(cc task-clear --session "$MTB" "$TID" --json)
ok "task-clear --json drops agent B's resolved (undone) edit" "printf '%s' \"\$TC\" | jq -e '.cleared>=1 and (.ids|length>=1)' >/dev/null"
ok "task-clear actually removed the edit from B's log"    "[ \$(cc list --session \"$MTB\" --json | jq '.edits|length') -eq 0 ]"
TCC=$(cc task-clear --session "$MTA" --completed --json)
ok "task-clear --completed clears the settled (all-kept) chapter" "printf '%s' \"\$TCC\" | jq -e '.cleared>=1' >/dev/null"
ok "task-clear --completed reports the settled chapter's taskId" "printf '%s' \"\$TCC\" | jq -e --arg t \"$TID\" '[.chapters[] | select(.taskId==\$t)]|length>=1' >/dev/null"
ok "task-clear --completed removed agent A's kept edit"   "[ \$(cc list --session \"$MTA\" --json | jq '.edits|length') -eq 0 ]"

echo "════════ E2E 18: 0.8.0 Observations view-model (timeline runs + reasoning + recap + next steps) ════════"
OBSESS=obsSess
: > "$HOME/.claude/projects/$MANGLE/$OBSESS.jsonl"
OBF="$WS/obs.txt"; printf 'x\n' > "$OBF"
# A transcript with Claude's reasoning TEXT preceding an Edit tool_use on obs.txt (so reasoningByEdit
# correlates), an open TodoWrite (→ nextSteps), and an ai-title recap (→ recap).
node -e '
  const fs=require("fs");
  const [proj, sess, file]=process.argv.slice(1);
  const now=new Date().toISOString();
  const title=JSON.stringify({type:"ai-title",aiTitle:"Observations recap line",timestamp:now});
  const edit=JSON.stringify({type:"assistant",timestamp:now,message:{role:"assistant",content:[
    {type:"text",text:"Reasoned about the obs edit."},
    {type:"tool_use",id:"oe1",name:"Edit",input:{file_path:file}}]}});
  const todo=JSON.stringify({type:"assistant",timestamp:now,message:{role:"assistant",content:[
    {type:"tool_use",id:"ot1",name:"TodoWrite",input:{todos:[{content:"ship observations",status:"pending"}]}}]}});
  fs.writeFileSync(proj+"/"+sess+".jsonl", [title, edit, todo].join("\n")+"\n");
' "$HOME/.claude/projects/$MANGLE" "$OBSESS" "$OBF"
# TWO adjacent edits to obs.txt → they coalesce into ONE ×2 run with a combined delta.
obhook(){ printf '{"session_id":"%s","cwd":"%s","hook_event_name":"%s","tool_name":"%s","tool_input":{"file_path":"%s"}}' "$OBSESS" "$WS" "$1" "$2" "$3" | node "$CAPTURE"; }
obhook PreToolUse Edit "$OBF"; node "$SETLINE" "$OBF" 0 "OBS1"; obhook PostToolUse Edit "$OBF"
obhook PreToolUse Edit "$OBF"; node "$SETLINE" "$OBF" 0 "OBS2"; obhook PostToolUse Edit "$OBF"
OBSV=$(cc observations --session "$OBSESS" 2>/dev/null)
ok "observations --json carries recap/runs/nextSteps"    "printf '%s' \"\$OBSV\" | jq -e 'has(\"recap\") and has(\"runs\") and has(\"nextSteps\")' >/dev/null"
ok "observations recap is the session title"             "printf '%s' \"\$OBSV\" | jq -e '.recap==\"Observations recap line\"' >/dev/null"
ok "observations coalesces adjacent same-file edits ×N"  "printf '%s' \"\$OBSV\" | jq -e '[.runs[] | select((.file|endswith(\"obs.txt\")) and .count>=2)]|length==1' >/dev/null"
ok "observations run carries combined delta + per-edit rows" "printf '%s' \"\$OBSV\" | jq -e '.runs[0] | has(\"added\") and has(\"removed\") and (.edits|length>=1) and .edits[0].status!=null' >/dev/null"
ok "observations edit carries Claude's reasoning"        "printf '%s' \"\$OBSV\" | jq -e '[.runs[].edits[] | select(.reasoning!=null)]|length>=1' >/dev/null"
ok "observations nextSteps includes the open to-do"      "printf '%s' \"\$OBSV\" | jq -e '[.nextSteps[] | select(test(\"ship observations\"))]|length>=1' >/dev/null"

echo "════════ E2E 19: 0.8.0 demo simulator (real pipeline end-to-end, total chapters, no-residue lifecycle) ════════"
# The demo replays a scripted session through the REAL pipeline (transcript + captured edits + a
# subagent + a workflow) in an isolated demo-* session + folder — then every 0.8.0 surface is asserted
# against it, and the lifecycle (accept-all auto-clear, --clean) must leave zero residue.
DEMOWS="$WS/demo-e2e"; mkdir -p "$DEMOWS/.git"
DEMOJ=$( ( cd "$DEMOWS" && node "$CLI" demo --fast --json ) )
DSESS=$(printf '%s' "$DEMOJ" | jq -r '.session')
ok "demo --fast --json reports its isolated session + workspace" "printf '%s' \"\$DEMOJ\" | jq -e '(.session|test(\"^demo-[0-9a-f]{8}$\")) and .edits==5 and (.workspace|endswith(\"observatory-demo\"))' >/dev/null"
DCM=$( ( cd "$DEMOWS" && node "$CLI" changemap --session "$DSESS" --json ) )
ok "demo changemap: the chapter dimension is TOTAL (no null chapter)"  "printf '%s' \"\$DCM\" | jq -e '[.edits[] | select(.chapter==null or .chapter==\"\")]|length==0' >/dev/null"
ok "demo changemap: three NAMED chapters (no synthetic needed)"        "printf '%s' \"\$DCM\" | jq -e '(.chapters|length)==3 and ([.chapters[]|select(.synthetic)]|length)==0' >/dev/null"
ok "demo changemap: chapters carry taskId + synthetic (0.8.0 keys)"    "printf '%s' \"\$DCM\" | jq -e '.chapters[0] | has(\"taskId\") and has(\"synthetic\")' >/dev/null"
ok "demo changemap: subagent edit attributed (rollupBySubagent)"       "printf '%s' \"\$DCM\" | jq -e '[.rollupBySubagent[] | select(.subagentId==\"demosub1\" and .edits==1)]|length==1' >/dev/null"
ok "demo changemap: workflow slice carries its own chapter rollup"     "printf '%s' \"\$DCM\" | jq -e '.workflows[0] | .id==\"wf_demo\" and (.chapters|length>=1)' >/dev/null"
DMT=$( ( cd "$DEMOWS" && node "$CLI" multitask --session "$DSESS" --json ) )
ok "demo multitask: the demo agent + its subagent + the workflow"      "printf '%s' \"\$DMT\" | jq -e '(.agents|length)>=1 and (.agents[0].subagents|length)==1 and (.workflows[0].id==\"wf_demo\")' >/dev/null"
ok "demo multitask: subagent rows carry phaseConfidence (0.8.0)"       "printf '%s' \"\$DMT\" | jq -e '.agents[0].subagents[0] | has(\"phaseConfidence\")' >/dev/null"
DTL=$( ( cd "$DEMOWS" && node "$CLI" tasklog --session "$DSESS" ) )
ok "demo tasklog: one row per named task"                              "printf '%s' \"\$DTL\" | jq -e 'length==3 and ([.[]|select(.content==\"Validate user input\")]|length)==1' >/dev/null"
DOBS=$( ( cd "$DEMOWS" && node "$CLI" observations --session "$DSESS" ) )
ok "demo observations: runs + reasoning + next steps"                  "printf '%s' \"\$DOBS\" | jq -e '(.runs|length)>=4 and ([.runs[].edits[]|select(.reasoning!=null)]|length)>=3 and (.nextSteps|length)>=1' >/dev/null"
# No-residue lifecycle: accepting everything auto-clears a demo session's store…
( cd "$DEMOWS" && node "$CLI" keep --all --session "$DSESS" ) >/dev/null
ok "demo accept-all leaves an EMPTY store (auto-clear, demo-only)"     "( cd \"\$DEMOWS\" && node \"\$CLI\" list --session \"\$DSESS\" --json ) | jq -e '.edits|length==0' >/dev/null"
ok "demo files stay on disk after accept (only the STORE clears)"      "[ -f \"\$DEMOWS/observatory-demo/docs/USAGE.md\" ]"
# …and --clean removes the session, its store, and the marked workspace folder.
( cd "$DEMOWS" && node "$CLI" demo --clean ) >/dev/null
ok "demo --clean removes the demo session from sessions"               "( cd \"\$DEMOWS\" && node \"\$CLI\" sessions --json ) | jq -e '[.sessions[] | select(.id==\"'\$DSESS'\")]|length==0' >/dev/null"
ok "demo --clean removes the workspace folder (marker-gated)"          "[ ! -d \"\$DEMOWS/observatory-demo\" ]"
ok "demo --clean removes the store dir"                                "[ ! -d \"\$HOME/.claude/claude-observatory/\$DSESS\" ]"

echo "════════════════════════════════════════════════════════"
echo "E2E RESULT: $pass passed, $fail failed"
[ $fail -eq 0 ]
