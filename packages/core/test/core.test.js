/* Core correctness tests — run with `node --test`. Uses isolated temp HOME dirs; never touches
   the real ~/.claude. Requires the built dist (npm test builds first). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const core = require('../dist/index.js');
const CAPTURE = path.resolve(__dirname, '../../cli/dist/capture.js');
const CLI = path.resolve(__dirname, '../../cli/dist/index.js');

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows, HOME elsewhere
  return home;
}
function tmpWork() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-work-'));
}
function seedEdit(session, file, before, after) {
  core.ensureStore(session);
  const b = before === null ? null : core.writeBlob(session, Buffer.from(before));
  const a = after === null ? null : core.writeBlob(session, Buffer.from(after));
  const id = core.nextId(session);
  core.appendLog(session, { id, ts: id * 1000, tool: 'Edit', file, beforeBlob: b, afterBlob: a, status: 'pending' });
  return id;
}

test('store: writeBlob dedupes identical content', () => {
  freshHome();
  const S = 'dedupe';
  core.ensureStore(S);
  const a = core.writeBlob(S, Buffer.from('same bytes'));
  const b = core.writeBlob(S, Buffer.from('same bytes'));
  assert.equal(a, b);
  assert.equal(fs.readdirSync(path.join(core.storeDir(S), 'blobs')).length, 1);
});

test('store: nextId increments and setStatus flips one record', () => {
  freshHome();
  const S = 'ids';
  const F = path.join(tmpWork(), 'f.txt');
  const id1 = seedEdit(S, F, 'a\n', 'b\n');
  const id2 = seedEdit(S, F, 'b\n', 'c\n');
  assert.equal(id1, 1);
  assert.equal(id2, 2);
  core.setStatus(S, 1, 'kept');
  assert.equal(core.findRecord(S, 1).status, 'kept');
  assert.equal(core.findRecord(S, 2).status, 'pending');
});

test('undo: surgical undo preserves later edits to the same file', () => {
  freshHome();
  const S = 'surgical';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L1\nL2\nL3\nL4\n', 'TOP\nL2\nL3\nL4\n'); // #1 top
  seedEdit(S, F, 'TOP\nL2\nL3\nL4\n', 'TOP\nL2\nL3\nBOT\n'); // #2 bottom
  fs.writeFileSync(F, 'TOP\nL2\nL3\nBOT\n'); // both applied on disk
  const r = core.undoEdit(S, 1);
  assert.equal(r.status, 'undone');
  const now = fs.readFileSync(F, 'utf8');
  assert.ok(now.startsWith('L1\n'), 'top reverted');
  assert.ok(now.includes('BOT'), 'bottom preserved');
  assert.equal(core.findRecord(S, 1).status, 'undone');
});

test('undo: duplicated-block scenario is NOT silently corrupted (position-anchored merge)', () => {
  // Regression for the fuzzy-patch corruption: two identical blocks, a later edit disturbs the TOP
  // block's context. Undoing edit #1 must revert the TOP block and leave the identical BOTTOM block
  // untouched — a content-searching patch would revert the wrong block and report success.
  freshHome();
  const S = 'dup';
  const F = path.join(tmpWork(), 'dup.js');
  const before1 = 'ctx-a\nctx-b\nVALUE_ORIG\nctx-c\nctx-d\nfiller\nctx-a\nctx-b\nVALUE_MOD\nctx-c\nctx-d\n';
  const after1 = 'ctx-a\nctx-b\nVALUE_MOD\nctx-c\nctx-d\nfiller\nctx-a\nctx-b\nVALUE_MOD\nctx-c\nctx-d\n'; // #1: L3 ORIG->MOD
  const current = 'ctx-a\nctx-b-EDIT\nVALUE_MOD\nctx-c\nctx-d\nfiller\nctx-a\nctx-b\nVALUE_MOD\nctx-c\nctx-d\n'; // #2: L2 disturbed
  seedEdit(S, F, before1, after1); // #1 (the one we undo)
  seedEdit(S, F, after1, current); // #2 (later edit)
  fs.writeFileSync(F, current);
  const r = core.undoEdit(S, 1);
  assert.equal(r.status, 'undone');
  const lines = fs.readFileSync(F, 'utf8').split('\n');
  assert.equal(lines[2], 'VALUE_ORIG', 'TOP block correctly reverted');
  assert.equal(lines[8], 'VALUE_MOD', 'BOTTOM (identical) block untouched — no corruption');
  assert.equal(lines[1], 'ctx-b-EDIT', 'later edit #2 preserved');
});

test('undo: adjacent later edit (gap=1) still undoes cleanly (no false conflict)', () => {
  freshHome();
  const S = 'adjacent';
  const F = path.join(tmpWork(), 'adj.txt');
  seedEdit(S, F, 'a\nb\nc\nd\ne\n', 'a\nX\nc\nd\ne\n'); // #1: b->X (line 2)
  seedEdit(S, F, 'a\nX\nc\nd\ne\n', 'a\nX\nY\nd\ne\n'); // #2: c->Y (line 3, adjacent)
  fs.writeFileSync(F, 'a\nX\nY\nd\ne\n');
  const r = core.undoEdit(S, 1);
  assert.equal(r.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'a\nb\nY\nd\ne\n', 'X->b undone, adjacent Y preserved');
});

test('undo: middle of three spaced edits merges cleanly (no false conflict)', () => {
  // Guards against a patch-level merge that spuriously conflicts when edits are within a few lines.
  freshHome();
  const S = 'spaced';
  const F = path.join(tmpWork(), 'spaced.txt');
  const orig = 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nL11\nL12\n';
  seedEdit(S, F, orig, 'TOP\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nL11\nL12\n'); // #1 line1
  seedEdit(S, F, 'TOP\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nL11\nL12\n', 'TOP\nL2\nL3\nL4\nL5\nMID\nL7\nL8\nL9\nL10\nL11\nL12\n'); // #2 line6
  seedEdit(S, F, 'TOP\nL2\nL3\nL4\nL5\nMID\nL7\nL8\nL9\nL10\nL11\nL12\n', 'TOP\nL2\nL3\nL4\nL5\nMID\nL7\nL8\nL9\nL10\nL11\nBOT\n'); // #3 line12
  fs.writeFileSync(F, 'TOP\nL2\nL3\nL4\nL5\nMID\nL7\nL8\nL9\nL10\nL11\nBOT\n');
  const r = core.undoEdit(S, 2); // undo the MIDDLE edit
  assert.equal(r.status, 'undone');
  assert.equal(
    fs.readFileSync(F, 'utf8'),
    'TOP\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\nL10\nL11\nBOT\n',
    'MID reverted to L6, TOP + BOT preserved'
  );
});

test('undo: overlapping edit conflicts; --force per-file restore recovers', () => {
  freshHome();
  const S = 'conflict';
  const F = path.join(tmpWork(), 'c.txt');
  seedEdit(S, F, 'A\nB\nC\n', 'A\nX\nC\n'); // #1 B->X
  seedEdit(S, F, 'A\nX\nC\n', 'A\nY\nC\n'); // #2 X->Y overlaps #1
  fs.writeFileSync(F, 'A\nY\nC\n');
  const r = core.undoEdit(S, 1);
  assert.equal(r.status, 'conflict');
  assert.equal(fs.readFileSync(F, 'utf8'), 'A\nY\nC\n', 'file untouched on conflict');
  const r2 = core.restoreFile(S, 1);
  assert.equal(r2.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'A\nB\nC\n', 'restored to pre-edit-1 state');
});

test('undo --force: restoreFile marks dropped later same-file edits undone; other files untouched', () => {
  // Regression: a --force restore drops later edits to the same file from disk. Those edits must be
  // marked `undone` so recorded status matches disk (a pending/kept edit whose change is gone lies to
  // the tree and makes a later per-edit undo/redo compute against a mismatched file).
  freshHome();
  const S = 'force-status';
  const F = path.join(tmpWork(), 'c.txt');
  const OTHER = path.join(path.dirname(F), 'other.txt');
  seedEdit(S, F, 'A\nB\nC\n', 'A\nX\nC\n'); // #1 F: B->X
  seedEdit(S, OTHER, 'p\n', 'q\n'); // #2 OTHER (different file, id between #1 and #3)
  seedEdit(S, F, 'A\nX\nC\n', 'A\nY\nC\n'); // #3 F: X->Y overlaps #1
  core.setStatus(S, 3, 'kept'); // the later edit was accepted
  fs.writeFileSync(F, 'A\nY\nC\n');
  fs.writeFileSync(OTHER, 'q\n');
  const r = core.restoreFile(S, 1); // conflict path -> drops #3 (later, same file)
  assert.equal(r.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'A\nB\nC\n', 'F restored to pre-#1');
  assert.equal(core.findRecord(S, 1).status, 'undone', '#1 undone');
  assert.equal(core.findRecord(S, 2).status, 'pending', '#2 (other file) untouched');
  assert.equal(core.findRecord(S, 3).status, 'undone', '#3 dropped from disk -> undone (was kept)');
});

test('redo --force: reapplyFile marks dropped later same-file edits undone', () => {
  freshHome();
  const S = 'force-redo-status';
  const F = path.join(tmpWork(), 'c.txt');
  seedEdit(S, F, 'A\nB\nC\n', 'A\nX\nC\n'); // #1 F: B->X
  seedEdit(S, F, 'A\nX\nC\n', 'A\nY\nC\n'); // #2 F: X->Y (later)
  core.setStatus(S, 1, 'undone'); // #1 previously undone
  core.setStatus(S, 2, 'kept'); // #2 accepted, still on disk
  fs.writeFileSync(F, 'A\nY\nC\n');
  const r = core.reapplyFile(S, 1); // force redo #1 -> writes after_#1 wholesale, drops #2
  assert.equal(r.status, 'redone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'A\nX\nC\n', 'file = after-edit-1 (later edit dropped)');
  assert.equal(core.findRecord(S, 1).status, 'pending', '#1 re-applied -> pending');
  assert.equal(core.findRecord(S, 2).status, 'undone', '#2 dropped from disk -> undone (was kept)');
});

test('undoScope: reverts pending only, honoring under / fileSubstr / whole-session', () => {
  // The single scoped-revert implementation behind CLI `undo --all|--file|--under` and the editors'
  // folder/file/session Revert. Accepted (kept) edits are never swept; a sibling folder is never swept.
  freshHome();
  const S = 'scope';
  const dir = tmpWork();
  const A = path.join(dir, 'pkg', 'a.txt');
  const B = path.join(dir, 'pkg', 'sub', 'b.txt');
  const C = path.join(dir, 'other', 'c.txt');
  seedEdit(S, A, 'a1\n', 'a2\n'); // #1 pending, under pkg/
  seedEdit(S, B, 'b1\n', 'b2\n'); // #2 pending, under pkg/sub/
  seedEdit(S, C, 'c1\n', 'c2\n'); // #3 pending, under other/
  core.setStatus(S, 2, 'kept'); // #2 accepted -> excluded from every scope
  for (const [f, v] of [[A, 'a2\n'], [B, 'b2\n'], [C, 'c2\n']]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, v);
  }
  // Folder scope pkg/: only #1 is pending under it (#2 is kept); #3 is a sibling folder.
  const r1 = core.undoScope(S, { under: path.join(dir, 'pkg') });
  assert.deepEqual([r1.undone, r1.total], [1, 1], 'pkg/ scope reverts only the 1 pending edit under it');
  assert.equal(fs.readFileSync(A, 'utf8'), 'a1\n', 'A reverted');
  assert.equal(core.findRecord(S, 2).status, 'kept', 'accepted #2 left kept + on disk');
  assert.equal(fs.readFileSync(C, 'utf8'), 'c2\n', 'C (sibling folder) untouched');
  // fileSubstr scope: matches c.txt only.
  const r2 = core.undoScope(S, { fileSubstr: 'c.txt' });
  assert.deepEqual([r2.undone, r2.total], [1, 1], 'fileSubstr reverts the matching pending edit');
  assert.equal(fs.readFileSync(C, 'utf8'), 'c1\n', 'C reverted by fileSubstr');
  // Whole session: nothing pending remains (#1,#3 undone; #2 kept).
  const r3 = core.undoScope(S);
  assert.deepEqual([r3.undone, r3.total], [0, 0], 'no pending left session-wide');
});

test('undo: new-file create is deleted; second undo is a noop', () => {
  freshHome();
  const S = 'newfile';
  const F = path.join(tmpWork(), 'new.txt');
  fs.writeFileSync(F, 'hello\n');
  seedEdit(S, F, null, 'hello\n'); // beforeBlob null = created
  const r = core.undoEdit(S, 1);
  assert.equal(r.status, 'deleted');
  assert.ok(!fs.existsSync(F));
  assert.equal(core.undoEdit(S, 1).status, 'noop');
});

test('undo: create WITH a later edit conflicts (never deletes); --force deletes', () => {
  freshHome();
  const S = 'createlater';
  const F = path.join(tmpWork(), 'c.txt');
  seedEdit(S, F, null, 'line1\n'); // #1 create
  seedEdit(S, F, 'line1\n', 'line1\nline2\n'); // #2 append
  fs.writeFileSync(F, 'line1\nline2\n'); // both applied on disk
  const r = core.undoEdit(S, 1);
  assert.equal(r.status, 'conflict', 'must NOT silently delete the file + edit #2');
  assert.ok(fs.existsSync(F), 'file preserved on conflict');
  assert.equal(fs.readFileSync(F, 'utf8'), 'line1\nline2\n');
  assert.equal(core.restoreFile(S, 1).status, 'deleted');
  assert.ok(!fs.existsSync(F));
});

// Seed one edit from raw before/after Buffers (bypasses seedEdit's Buffer.from(string)).
function seedEditBytes(session, file, beforeBuf, afterBuf) {
  core.ensureStore(session);
  const b = beforeBuf === null ? null : core.writeBlob(session, beforeBuf);
  const a = afterBuf === null ? null : core.writeBlob(session, afterBuf);
  const id = core.nextId(session);
  core.appendLog(session, { id, ts: id * 1000, tool: 'Edit', file, beforeBlob: b, afterBlob: a, status: 'pending' });
  return id;
}

test('undo: clean revert preserves EXACT bytes of a non-UTF-8 file (no UTF-8 round-trip)', () => {
  freshHome();
  const S = 'bytes';
  const F = path.join(tmpWork(), 'latin1.txt');
  const before = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "caf<0xE9>\n" — 0xE9 is invalid standalone UTF-8
  const after = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]); // + "!"
  const id = seedEditBytes(S, F, before, after);
  fs.writeFileSync(F, after); // file currently at "after" (clean-revert path: current === after)
  const r = core.undoEdit(S, id);
  assert.equal(r.status, 'undone');
  assert.equal(Buffer.compare(fs.readFileSync(F), before), 0, 'restored to exact before-bytes, not U+FFFD');
});

test('redo: clean re-apply preserves EXACT bytes of a non-UTF-8 file', () => {
  freshHome();
  const S = 'bytes2';
  const F = path.join(tmpWork(), 'latin1.txt');
  const before = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
  const after = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]);
  const id = seedEditBytes(S, F, before, after);
  fs.writeFileSync(F, after);
  core.undoEdit(S, id); // now at `before` (byte-exact, tested above)
  assert.equal(Buffer.compare(fs.readFileSync(F), before), 0);
  const r = core.redoEdit(S, id);
  assert.equal(r.status, 'redone');
  assert.equal(Buffer.compare(fs.readFileSync(F), after), 0, 're-applied to exact after-bytes');
});

test('undo: --force restore of a deleted non-UTF-8 file preserves exact bytes', () => {
  freshHome();
  const S = 'bytes3';
  const F = path.join(tmpWork(), 'bin.txt');
  const before = Buffer.from([0x80, 0x81, 0x82, 0x0a]); // high bytes, invalid UTF-8
  const id = seedEditBytes(S, F, before, null); // edit deleted the file
  // file is absent now (after === null); undo restores it
  const r = core.undoEdit(S, id);
  assert.equal(r.status, 'undone');
  assert.equal(Buffer.compare(fs.readFileSync(F), before), 0, 'deleted file restored byte-exact');
});

test('groups: consecutive same-line edits collapse into one review unit (keep the latest)', () => {
  freshHome();
  const S = 'grp';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n'); // #1: line 2 A->B
  seedEdit(S, F, 'L1\nB\nL3\n', 'L1\nC\nL3\n'); // #2: line 2 B->C (chained; #1's "B" is superseded)
  const groups = core.pendingGroups(S);
  assert.equal(groups.size, 1, 'the two same-line edits collapse into ONE group');
  const [rep, members] = [...groups.entries()][0];
  assert.equal(rep, 2, 'represented by the most-recent edit');
  assert.deepEqual(members, [1, 2]);
  assert.deepEqual(core.groupMembers(S, 1), [1, 2], 'membership resolves from either id');
});

test('groups: edits to different regions of a file stay separate', () => {
  freshHome();
  const S = 'grp2';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L1\nL2\nL3\nL4\nL5\n', 'X1\nL2\nL3\nL4\nL5\n'); // #1: line 1
  seedEdit(S, F, 'X1\nL2\nL3\nL4\nL5\n', 'X1\nL2\nL3\nL4\nX5\n'); // #2: line 5 (chained, non-overlapping)
  assert.equal(core.pendingGroups(S).size, 2, 'different regions -> two independent groups');
  assert.deepEqual(core.groupMembers(S, 1), [1]);
  assert.deepEqual(core.groupMembers(S, 2), [2]);
});

test('groups: undoGroup reverts to the earliest before; redoGroup rebuilds; keepGroup keeps all', () => {
  freshHome();
  const S = 'grp3';
  const F = path.join(tmpWork(), 'f.txt');
  const A = 'L1\nA\nL3\n', B = 'L1\nB\nL3\n', C = 'L1\nC\nL3\n';
  seedEdit(S, F, A, B); // #1
  seedEdit(S, F, B, C); // #2
  fs.writeFileSync(F, C); // current on disk = the latest state
  const u = core.undoGroup(S, 2);
  assert.equal(u.status, 'undone');
  assert.deepEqual([...u.ids].sort((a, b) => a - b), [1, 2]);
  assert.equal(fs.readFileSync(F, 'utf8'), A, 'reverted the whole chain back to the earliest before-state');
  assert.equal(core.findRecord(S, 1).status, 'undone');
  assert.equal(core.findRecord(S, 2).status, 'undone');
  const r = core.redoGroup(S, 2);
  assert.equal(r.status, 'redone');
  assert.equal(fs.readFileSync(F, 'utf8'), C, 're-applied the whole chain');
  const k = core.keepGroup(S, 1);
  assert.equal(k.kept, 2, 'keepGroup keeps every member');
  assert.equal(core.findRecord(S, 1).status, 'kept');
  assert.equal(core.findRecord(S, 2).status, 'kept');
});

test('groups: a three-edit chain on the same line collapses transitively into one unit', () => {
  freshHome();
  const S = 'g4';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'x\nA\ny\n', 'x\nB\ny\n'); // #1
  seedEdit(S, F, 'x\nB\ny\n', 'x\nC\ny\n'); // #2
  seedEdit(S, F, 'x\nC\ny\n', 'x\nD\ny\n'); // #3
  const g = core.pendingGroups(S);
  assert.equal(g.size, 1, 'all three collapse');
  assert.deepEqual([...g.get(3)], [1, 2, 3], 'rep is #3; members are 1-3');
});

test('groups: same-line edits group while a different-region edit stays a separate unit', () => {
  freshHome();
  const S = 'g5';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L0\nL1\nL2\nL3\nL4\n', 'A\nL1\nL2\nL3\nL4\n'); // #1 line 0
  seedEdit(S, F, 'A\nL1\nL2\nL3\nL4\n', 'B\nL1\nL2\nL3\nL4\n'); // #2 line 0 (groups with #1)
  seedEdit(S, F, 'B\nL1\nL2\nL3\nL4\n', 'B\nL1\nL2\nL3\nX\n'); // #3 line 4 (separate region)
  assert.equal(core.pendingGroups(S).size, 2, 'two independent groups');
  assert.deepEqual(core.groupMembers(S, 1), [1, 2]);
  assert.deepEqual(core.groupMembers(S, 3), [3]);
});

test('groups: undoGroup reverts its region ONLY, surgically preserving an unrelated edit in the same file', () => {
  freshHome();
  const S = 'g6';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L0\nL1\nL2\nL3\nL4\n', 'A\nL1\nL2\nL3\nL4\n'); // #1 line 0
  seedEdit(S, F, 'A\nL1\nL2\nL3\nL4\n', 'B\nL1\nL2\nL3\nL4\n'); // #2 line 0 (group)
  seedEdit(S, F, 'B\nL1\nL2\nL3\nL4\n', 'B\nL1\nL2\nL3\nX\n'); // #3 line 4 (separate)
  fs.writeFileSync(F, 'B\nL1\nL2\nL3\nX\n');
  const res = core.undoGroup(S, 2);
  assert.equal(res.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'L0\nL1\nL2\nL3\nX\n', 'line 0 reverted; line 4 (#3) preserved');
  assert.equal(core.findRecord(S, 3).status, 'pending', 'the unrelated edit is untouched');
});

test('groups: a resolved (kept) edit never drags into a later pending same-line group', () => {
  freshHome();
  const S = 'g7';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'x\nA\ny\n', 'x\nB\ny\n'); // #1
  core.setStatus(S, 1, 'kept'); // resolve #1
  seedEdit(S, F, 'x\nB\ny\n', 'x\nC\ny\n'); // #2 pending (chained after #1)
  assert.deepEqual(core.groupMembers(S, 2), [2], 'only the pending edit is in the group');
  assert.equal(core.keepGroup(S, 2).kept, 1);
  assert.equal(core.findRecord(S, 1).status, 'kept', 'the already-kept edit is unchanged');
});

test('groups: a new-file create + an immediate same-line edit collapse (before=null chain)', () => {
  freshHome();
  const S = 'g8';
  const F = path.join(tmpWork(), 'new.txt');
  seedEdit(S, F, null, 'hello\n'); // #1 create
  seedEdit(S, F, 'hello\n', 'HELLO\n'); // #2 edit
  assert.equal(core.pendingGroups(S).size, 1, 'create + edit collapse');
  assert.deepEqual(core.groupMembers(S, 1), [1, 2]);
  fs.writeFileSync(F, 'HELLO\n');
  const res = core.undoGroup(S, 2);
  assert.ok(res.ok, 'undoing the whole unit succeeds');
  assert.ok(!fs.existsSync(F), 'reverting the group removes the created file');
});

test('groups: undoGroup then redoGroup round-trips to the exact final state', () => {
  freshHome();
  const S = 'g9';
  const F = path.join(tmpWork(), 'f.txt');
  const A = 'p\nA\nq\n', B = 'p\nB\nq\n', C = 'p\nC\nq\n';
  seedEdit(S, F, A, B);
  seedEdit(S, F, B, C);
  fs.writeFileSync(F, C);
  core.undoGroup(S, 2);
  assert.equal(fs.readFileSync(F, 'utf8'), A, 'undo -> earliest before');
  core.redoGroup(S, 2);
  assert.equal(fs.readFileSync(F, 'utf8'), C, 'redo -> exact final state');
  assert.equal(core.findRecord(S, 1).status, 'pending');
  assert.equal(core.findRecord(S, 2).status, 'pending');
});

test('groups: identical edits to two different files never group across files', () => {
  freshHome();
  const S = 'g10';
  const dir = tmpWork();
  seedEdit(S, path.join(dir, 'a.txt'), 'x\n', 'y\n'); // #1 file A
  seedEdit(S, path.join(dir, 'b.txt'), 'x\n', 'y\n'); // #2 file B
  assert.equal(core.pendingGroups(S).size, 2, 'different files -> different groups');
});

test('groups: reviewEdits collapses pending to one net rep (earliest before -> latest after)', () => {
  freshHome();
  const S = 'g11';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\nX\nb\n', 'a\nY\nb\n'); // #1 line 1
  seedEdit(S, F, 'a\nY\nb\n', 'a\nZ\nb\n'); // #2 line 1 (group)
  const rev = core.reviewEdits(S);
  assert.equal(rev.length, 1, 'one collapsed review record');
  assert.equal(rev[0].id, 2, 'rep carries the most-recent id');
  const d = core.lineDelta(S, rev[0]);
  assert.equal(d.added, 1, 'net delta is earliest-before -> latest-after (X -> Z)');
  assert.equal(d.removed, 1);
  // resolved edits stay individual (history) alongside a new pending rep
  core.setStatus(S, 1, 'kept');
  core.setStatus(S, 2, 'kept'); // the group is now resolved
  seedEdit(S, F, 'a\nZ\nb\n', 'a\nW\nb\n'); // #3 pending, chained after the kept group
  const rev2 = core.reviewEdits(S);
  assert.equal(rev2.length, 3, 'both kept edits stay individual; the new pending edit is its own rep');
});

test('undo: fileBaseline reverts all pending edits (quick-diff baseline)', () => {
  freshHome();
  const S = 'baseline';
  const F = path.join(tmpWork(), 'app.js');
  seedEdit(S, F, 'a\nb\n', 'a\nX\nb\n'); // #1: insert X
  seedEdit(S, F, 'a\nX\nb\n', 'a\nX\nb\nY\n'); // #2: append Y
  const current = 'a\nX\nb\nY\n';
  assert.equal(core.fileBaseline(S, F, current), 'a\nb\n', 'baseline reverts both pending edits');
  // a kept edit stays in the baseline; only the pending one is reverted
  core.setStatus(S, 1, 'kept');
  assert.equal(core.fileBaseline(S, F, current), 'a\nX\nb\n', 'kept #1 stays; only pending #2 reverted');
  // a file Claude never touched has no baseline delta
  assert.equal(core.fileBaseline(S, '/other/none.js', 'z\n'), 'z\n', 'untouched file: baseline == current');
});

test('redo: re-applies an undone edit, preserving later edits, then noop', () => {
  freshHome();
  const S = 'redo';
  const F = path.join(tmpWork(), 'r.txt');
  seedEdit(S, F, 'a\nb\nc\n', 'A\nb\nc\n'); // #1 top
  seedEdit(S, F, 'A\nb\nc\n', 'A\nb\nC\n'); // #2 bottom
  fs.writeFileSync(F, 'A\nb\nC\n');
  core.undoEdit(S, 1);
  assert.equal(fs.readFileSync(F, 'utf8'), 'a\nb\nC\n');
  const r = core.redoEdit(S, 1);
  assert.equal(r.status, 'redone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'A\nb\nC\n', 're-applied #1, #2 preserved');
  assert.equal(core.findRecord(S, 1).status, 'pending');
  assert.equal(core.redoEdit(S, 1).status, 'noop', 'redo of a live edit is a noop');
});

test('redo: re-creates a file whose creation was undone', () => {
  freshHome();
  const S = 'redocreate';
  const F = path.join(tmpWork(), 'n.txt');
  fs.writeFileSync(F, 'hi\n');
  seedEdit(S, F, null, 'hi\n'); // #1 create
  core.undoEdit(S, 1);
  assert.ok(!fs.existsSync(F), 'undo deleted the created file');
  assert.equal(core.redoEdit(S, 1).status, 'redone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'hi\n', 're-created');
  assert.equal(core.findRecord(S, 1).status, 'pending');
});

test('clean: gcSession removes only unreferenced blobs; removeSession deletes the dir', () => {
  freshHome();
  const S = 'gc';
  core.ensureStore(S);
  const F = path.join(tmpWork(), 'f.txt');
  const keep = core.writeBlob(S, Buffer.from('referenced'));
  core.appendLog(S, { id: 1, ts: 1000, tool: 'Edit', file: F, beforeBlob: null, afterBlob: keep, status: 'pending' });
  const orphan = core.writeBlob(S, Buffer.from('orphan-not-referenced'));
  const res = core.gcSession(S);
  assert.equal(res.removed, 1);
  assert.ok(res.bytes > 0);
  const blobs = fs.readdirSync(path.join(core.storeDir(S), 'blobs'));
  assert.ok(blobs.includes(keep) && !blobs.includes(orphan));
  core.removeSession(S);
  assert.ok(!fs.existsSync(core.storeDir(S)));
});

test('clean: gcSession keeps blobs referenced by an in-flight staging record (not yet committed)', () => {
  freshHome();
  const S = 'gcstage';
  core.ensureStore(S);
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\n', 'b\n'); // a committed edit (its blobs are referenced)
  // A PreToolUse that already snapshotted a before-blob but whose PostToolUse hasn't appended yet.
  const stagedBlob = core.writeBlob(S, Buffer.from('staged-before\n'));
  const key = core.pathKey('/some/other.txt');
  core.writeStaging(S, key, { file: '/some/other.txt', tool: 'Edit', beforeBlob: stagedBlob });
  core.gcSession(S);
  assert.ok(
    fs.existsSync(path.join(core.storeDir(S), 'blobs', stagedBlob)),
    'staged before-blob must survive GC (else the imminent edit is unrecoverable)'
  );
});

test('clean: gcSession keeps blobs referenced by the __bash__ manifest', () => {
  freshHome();
  const S = 'gcbash';
  core.ensureStore(S);
  const blob = core.writeBlob(S, Buffer.from('bash-before\n'));
  core.writeBashManifest(S, { files: { '/x/y.txt': blob }, ts: 1000 });
  core.gcSession(S);
  assert.ok(fs.existsSync(path.join(core.storeDir(S), 'blobs', blob)), 'manifest before-blob survives GC');
});

// --- scoped folder/file operations (--under): the one path rule shared by keep/undo/clean ---------
test('scope: isUnderPath matches an exact file + folder prefix, never a shared-prefix sibling', () => {
  const root = path.join(path.sep, 'root');
  const api = path.join(root, 'src', 'api');
  assert.ok(core.isUnderPath(api, api), 'exact path is under itself (file scope)');
  assert.ok(core.isUnderPath(path.join(api, 'x.ts'), api), 'a file beneath the folder matches');
  assert.ok(core.isUnderPath(path.join(api, 'deep', 'y.ts'), api), 'a nested file matches');
  assert.ok(!core.isUnderPath(path.join(root, 'src', 'api-v2', 'z.ts'), api), 'sibling sharing a name prefix must NOT match');
  assert.ok(!core.isUnderPath(path.join(root, 'src', 'other.ts'), api), 'unrelated file must NOT match');
});

test('scope: clearResolved(session, folder) drops resolved edits under the folder only', () => {
  freshHome();
  const S = 'scopeclear';
  core.ensureStore(S);
  const W = tmpWork();
  const src = path.join(W, 'src');
  const a = path.join(src, 'a.ts'); // resolved, under src → cleared
  const b = path.join(src, 'util', 'b.ts'); // resolved (nested), under src → cleared
  const c = path.join(W, 'lib', 'c.ts'); // resolved, OUTSIDE src → preserved
  const ia = seedEdit(S, a, 'a1\n', 'a2\n');
  const ib = seedEdit(S, b, 'b1\n', 'b2\n');
  const ic = seedEdit(S, c, 'c1\n', 'c2\n');
  const ip = seedEdit(S, a, 'a2\n', 'a3\n'); // pending, under src → preserved (never cleared)
  core.setStatus(S, ia, 'kept');
  core.setStatus(S, ib, 'undone');
  core.setStatus(S, ic, 'kept');
  const removed = core.clearResolved(S, src);
  assert.equal(removed, 2, 'only the two resolved edits under src are cleared');
  const survivors = core.readLog(S).map((r) => r.id).sort((x, y) => x - y);
  assert.deepEqual(survivors, [ic, ip].sort((x, y) => x - y), 'pending-under-scope + resolved-outside-scope survive');
});

test('scope: clearResolved(session, exactFile) clears only that file, leaving a sibling in the same dir', () => {
  freshHome();
  const S = 'scopeclearfile';
  core.ensureStore(S);
  const dir = path.join(tmpWork(), 'src');
  const a = path.join(dir, 'a.ts');
  const b = path.join(dir, 'b.ts'); // same folder, different file
  const ia = seedEdit(S, a, 'a1\n', 'a2\n');
  const ib = seedEdit(S, b, 'b1\n', 'b2\n');
  core.setStatus(S, ia, 'kept');
  core.setStatus(S, ib, 'kept');
  const removed = core.clearResolved(S, a); // file scope = exact match
  assert.equal(removed, 1);
  assert.deepEqual(core.readLog(S).map((r) => r.id), [ib], 'the sibling file is untouched');
});

test('scope: buildEditTree gives each folder an absolute path that matches its files via isUnderPath', () => {
  freshHome();
  const S = 'scopetree';
  core.ensureStore(S);
  const W = tmpWork();
  const a = path.join(W, 'src', 'a.ts'); // keeps `src` from compacting into `src/utils`
  const b = path.join(W, 'src', 'utils', 'b.ts');
  for (const [f, txt] of [[a, 'a2\n'], [b, 'b2\n']]) {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, txt);
  }
  seedEdit(S, a, 'a1\n', 'a2\n');
  seedEdit(S, b, 'b1\n', 'b2\n');
  const tree = core.buildEditTree(S, { root: W });
  const src = tree.folders.find((f) => f.label === 'src');
  assert.ok(src, 'expected a top-level "src" folder');
  assert.equal(src.path, path.join(W, 'src'), 'folder.path is the absolute directory');
  assert.ok(core.isUnderPath(a, src.path) && core.isUnderPath(b, src.path), 'both files fall under the folder path');
});

test('store: a stale lock is broken so appendLog can never permanently block', () => {
  freshHome();
  const S = 'lock';
  core.ensureStore(S);
  // Simulate a crashed holder: a .lock file older than the stale threshold.
  const lp = path.join(core.storeDir(S), '.lock');
  fs.writeFileSync(lp, '999999');
  const old = new Date(Date.now() - 60000); // 60s ago > LOCK_STALE_MS (10s)
  fs.utimesSync(lp, old, old);
  const F = path.join(tmpWork(), 'f.txt');
  const id = seedEdit(S, F, 'a\n', 'b\n'); // seedEdit → appendLog acquires the lock; must not hang
  assert.equal(core.findRecord(S, id).status, 'pending', 'append succeeded despite a stale lock');
});

test('store: rejects traversing session ids (no read/write/rm -rf outside the store)', () => {
  freshHome();
  assert.equal(core.isSafeSessionId('750d33e9-aedd-4186-98a4-f03ce6716ed0'), true, 'a real UUID is fine');
  assert.equal(core.isSafeSessionId('..'), false);
  assert.equal(core.isSafeSessionId('.'), false);
  assert.equal(core.isSafeSessionId('a/b'), false);
  assert.equal(core.isSafeSessionId('../evil'), false);
  assert.throws(() => core.storeDir('..'), /invalid session id/, 'storeDir fail-closes on traversal');
  assert.throws(() => core.storeDir('../../etc'), /invalid session id/);
  assert.throws(() => core.removeSession('..'), /invalid session id|outside the store/, 'removeSession refuses to escape');
});

test('clean: clearResolved drops kept+undone, keeps pending', () => {
  freshHome();
  const S = 'clr';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\n', 'b\n'); // #1
  seedEdit(S, F, 'b\n', 'c\n'); // #2
  seedEdit(S, F, 'c\n', 'd\n'); // #3
  core.setStatus(S, 1, 'kept');
  core.setStatus(S, 2, 'undone');
  const removed = core.clearResolved(S);
  assert.equal(removed, 2, 'removed the kept + undone edits');
  const log = core.readLog(S);
  assert.equal(log.length, 1, 'only pending remains');
  assert.equal(log[0].id, 3);
  assert.equal(log[0].status, 'pending');
  assert.equal(core.clearResolved(S), 0, 'no-op when nothing resolved');
});

test('store: clearing resolved edits keeps the skip markers — the record that a change went UNcaptured', () => {
  freshHome();
  const S = 'clrskip';
  const dir = tmpWork();
  const F = path.join(dir, 'f.txt');
  const OUT = path.join(dir, 'elsewhere', 'big.bin');
  seedEdit(S, F, 'a\n', 'b\n'); // #1
  core.appendSkip(S, OUT, 'file too large (>5MB) or binary at commit');
  seedEdit(S, F, 'b\n', 'c\n'); // #2
  core.appendSkip(S, '<bash-tree>', 'Bash working tree exceeds the file cap');
  assert.equal(core.readSkips(S).length, 2, 'both markers recorded');

  core.setStatus(S, 1, 'kept');
  assert.equal(core.clearResolved(S), 1, 'the kept edit is dropped');
  // The rewrite rebuilds the log from readLog, which returns EDIT RECORDS only. Without carrying the
  // op lines across, Clear silently erased the one thing standing between an uncaptured edit and
  // silence — and `status` then reported zero skips.
  assert.equal(core.readSkips(S).length, 2, 'skip markers survive a clear');
  assert.equal(core.readLog(S).length, 1, 'and the pending edit is still the only record');

  // Repeating the clear must not duplicate or drop them either (the ops are re-read each time).
  core.setStatus(S, 2, 'undone');
  core.clearResolved(S);
  assert.equal(core.readSkips(S).length, 2, 'still exactly two after a second clear');

  // A SCOPED clear must not reach markers outside its scope.
  const S2 = 'clrskip2';
  seedEdit(S2, path.join(dir, 'in', 'a.txt'), 'a\n', 'b\n');
  core.appendSkip(S2, path.join(dir, 'OUT', 'keep.bin'), 'oversized, out of scope');
  core.setStatus(S2, 1, 'kept');
  core.clearResolved(S2, path.join(dir, 'in'));
  assert.equal(core.readSkips(S2).length, 1, 'a folder-scoped clear leaves another folder\'s marker alone');
});

test('undo: keep never resurrects a reverted edit — the ledger must not claim a change that is not on disk', () => {
  freshHome();
  const S = 'keepundone';
  const F = path.join(tmpWork(), 'k.txt');
  fs.writeFileSync(F, 'a\nb\n');
  seedEdit(S, F, 'a\n', 'a\nb\n'); // #1, pending
  core.setStatus(S, 1, 'undone');

  const r = core.keepGroup(S, 1);
  assert.equal(r.kept, 0, 'nothing is kept');
  assert.deepEqual(r.ids, [], 'and no id is reported as kept');
  assert.equal(core.readLog(S)[0].status, 'undone', 'the record stays undone');

  // Marking it kept would also RESOLVE it, so clearResolved would drop it and the revert could never
  // be redone — the failure this guards is data loss, not just a wrong label.
  assert.equal(core.clearResolved(S), 1, 'it is still resolved-as-undone, so a clear drops it');

  // The pending case is untouched.
  const S2 = 'keeppending';
  seedEdit(S2, F, 'a\n', 'a\nb\n');
  assert.equal(core.keepGroup(S2, 1).kept, 1, 'a pending edit is still kept normally');
});

test('ranges: locateEditInCurrent maps an edit to its current lines (positional)', () => {
  const L = core.locateEditInCurrent;
  // simple: no later edits -> the changed line
  assert.deepEqual(L('a\nb\nc\n', 'a\nB\nc\n', 'a\nB\nc\n'), [1]);
  // later edit inserted a line ABOVE -> range shifts down
  assert.deepEqual(L('a\nb\nc\n', 'a\nB\nc\n', 'HEADER\na\nB\nc\n'), [2]);
  // the edit's own line was later rewritten -> it drops out (no inline anchor)
  assert.deepEqual(L('a\nb\nc\n', 'a\nB\nc\n', 'a\nBB\nc\n'), []);
  // new-file create -> every surviving line
  assert.deepEqual(L('', 'x\ny\n', 'x\ny\n'), [0, 1]);
  // pure deletion introduces nothing
  assert.deepEqual(L('a\nb\nc\n', 'a\nc\n', 'a\nc\n'), []);
  // multi-line insert preserved, later append below doesn't disturb it
  assert.deepEqual(L('a\nb\n', 'a\nNEW1\nNEW2\nb\n', 'a\nNEW1\nNEW2\nb\nZ\n'), [1, 2]);
});

test('ranges: locateDeletionsInCurrent surfaces removed text + its anchor (red ghost text)', () => {
  const D = core.locateDeletionsInCurrent;
  // pure deletion in the middle -> removed 'b', anchored on the surviving next line
  assert.deepEqual(D('a\nb\nc\n', 'a\nc\n', 'a\nc\n'), [{ anchor: 1, lines: ['b'] }]);
  // even swap (modification) -> no deletion; the changed line renders green instead
  assert.deepEqual(D('a\nb\nc\n', 'a\nB\nc\n', 'a\nB\nc\n'), []);
  // shrink (remove 2, add 1) -> net deletion; both removed lines surface, anchored after the replacement
  assert.deepEqual(D('a\nb\nc\nd\n', 'a\nX\nd\n', 'a\nX\nd\n'), [{ anchor: 2, lines: ['b', 'c'] }]);
  // growth (remove 1, add 2) -> not a deletion
  assert.deepEqual(D('a\nb\nc\n', 'a\nX\nY\nc\n', 'a\nX\nY\nc\n'), []);
  // deletion at end-of-file -> anchored on the last surviving line
  assert.deepEqual(D('a\nb\nc\n', 'a\n', 'a\n'), [{ anchor: 0, lines: ['b', 'c'] }]);
  // a later edit inserted a line ABOVE -> the anchor shifts down with it
  assert.deepEqual(D('a\nb\nc\n', 'a\nc\n', 'HEADER\na\nc\n'), [{ anchor: 2, lines: ['b'] }]);
  // the deletion's region was later rewritten -> the hunk drops out
  assert.deepEqual(D('a\nb\nc\n', 'a\nc\n', 'a\nZZ\n'), []);
});

test('ranges: a file\'s edits are placed by COMPOSING the chain — and one empty snapshot cannot un-place the rest', () => {
  const chainLines = (chain, current) =>
    core.locateEditsInCurrent(chain.length, (i) => chain[i], current).map((p) => p.lines);

  // 1. On a chain whose lines survive to the buffer, composing agrees edit for edit with placing each
  //    edit on its own — there the hops are purely an optimization.
  const v0 = 'a\nb\nc\n';
  const v1 = 'a\nONE\nb\nc\n';
  const v2 = 'a\nONE\nb\nTWO\nc\n';
  const chain = [{ before: v0, after: v1 }, { before: v1, after: v2 }];
  assert.deepEqual(chainLines(chain, v2), [
    core.locateEditInCurrent(v0, v1, v2),
    core.locateEditInCurrent(v1, v2, v2),
  ]);
  assert.deepEqual(chainLines(chain, v2), [[1], [3]]);

  // 1b. It is NOT true in general, and the difference is the point of composing rather than a defect to
  //     paper over. When a line is deleted and later reintroduced with the same text, the copy standing
  //     in the buffer belongs to the LATER edit. Composition follows surviving lines, so the earlier
  //     edit comes back unplaced; a direct `after -> current` alignment matches it to the replacement and
  //     hands two edits the same line — so "undo" on the earlier one would point at the later one's work.
  //     Measured over randomized chains that reuse line text, the two disagree this way on 0.40% of
  //     edits. Under-reporting is the intended answer; an unplaced edit still lists, it only loses its
  //     class attribution (tree.ts passes `undefined` straight through to `classAt`).
  const base = 'a\nb\nc\nd\n';
  const withX = 'a\nb\nXXX\nc\nd\n';
  const readd = [
    { before: base, after: withX }, // #1 introduces XXX
    { before: withX, after: base }, // #2 reverts it
    { before: base, after: withX }, // #3 reintroduces the identical text
  ];
  const reintro = chainLines(readd, withX);
  assert.deepEqual(reintro[2], [2], 'the edit that actually authored the surviving line owns it');
  assert.deepEqual(reintro[0], [], 'the reverted edit stays unplaced rather than claiming its replacement');
  assert.deepEqual(core.locateEditInCurrent(base, withX, withX), [2], 'placed alone, the same edit DOES claim line 2 — which is exactly the mis-attribution composing avoids');

  // 2. An edit that DELETED the file leaves an empty `after`. Nothing survives a hop through nothing,
  //    so composing across it would wipe out every EARLIER edit's placement too — the deletion must
  //    sever the chain and re-anchor, not erase history. (`afterBlob: null` is a normal capture
  //    outcome, and an unreadable blob reads as '' by the same path.)
  const deleted = [
    { before: v0, after: v1 }, // inserts ONE
    { before: v1, after: '' }, // deletes the file
    { before: '', after: v1 }, // recreates it
  ];
  const placed = chainLines(deleted, v1);
  assert.deepEqual(placed[0], [1], 'the first edit keeps its placement across a deletion later in the chain');
  assert.deepEqual(placed[1], [], 'the deletion itself introduces nothing');
  assert.deepEqual(placed[2], [0, 1, 2, 3], 'the re-create marks every restored line');

  // 3. The single-edit wrappers are the batch form with one element — same code path, no drift.
  assert.deepEqual(core.locateEditInCurrent(v0, v1, v1), chainLines([{ before: v0, after: v1 }], v1)[0]);
});

test('observe: recap "next steps" heading matching is linear-time on a pathological line (no ReDoS)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const S = 'redos';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  // A line that made the old `\s*\**\s*` heading regex backtrack O(n^2): marker, 100k spaces, marker.
  const evil = '#' + ' '.repeat(100000) + 'x';
  const tx = JSON.stringify({
    sessionId: S,
    timestamp: new Date().toISOString(),
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: evil }] },
  });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);
  const t0 = Date.now();
  const sug = core.transcriptSuggestions(cwd, S); // runs recapNextSteps on lastSummary
  const elapsed = Date.now() - t0;
  assert.ok(Array.isArray(sug), 'returns a list');
  assert.ok(elapsed < 1000, `heading match must be linear (took ${elapsed}ms; the O(n^2) bug takes many seconds)`);
});

test('classes: detectClasses spans + classAt (brace langs + python)', () => {
  const src = 'import x;\nexport class Foo {\n  a() { return 1 }\n}\nfunction loose() {}\nclass Bar {\n  b() {}\n}\n';
  const spans = core.detectClasses(src);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].name, 'Foo');
  assert.deepEqual([spans[0].start, spans[0].end], [1, 3]);
  assert.equal(spans[1].name, 'Bar');
  assert.equal(core.classAt(spans, 2)?.name, 'Foo', 'edit inside Foo');
  assert.equal(core.classAt(spans, 4), null, 'loose function -> no class');
  assert.equal(core.classAt(spans, 6)?.name, 'Bar');
  const py = core.detectClasses('class P:\n    def m(self):\n        pass\nx = 1\n');
  assert.equal(py.length, 1);
  assert.equal(py[0].name, 'P');
  assert.equal(py[0].end, 2, 'python body ends before dedent');
});

test('observe: correlates edits to transcript reasoning + heuristic flags/suggestions', () => {
  freshHome();
  const S = 'obs';
  const cwd = tmpWork();
  const F = path.join(cwd, 'app.js');
  seedEdit(S, F, null, 'function x(){}\n'); // #1 create
  seedEdit(S, F, 'function x(){}\n', 'function x(){}\n// TODO fix\n'); // #2 add TODO
  // fake Claude transcript in the project dir
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    { message: { role: 'assistant', content: [{ type: 'text', text: 'Creating the x function.' }, { type: 'tool_use', name: 'Write', input: { file_path: F } }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'Adding a TODO note.' }, { type: 'tool_use', name: 'Edit', input: { file_path: F } }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);

  const reasoning = core.reasoningByEdit(cwd, S);
  assert.equal(reasoning.get(1), 'Creating the x function.', 'edit #1 gets its reasoning');
  assert.equal(reasoning.get(2), 'Adding a TODO note.', 'edit #2 gets its reasoning');

  assert.match(core.summarize(S, core.findRecord(S, 1)), /created app\.js/);
  assert.ok(core.flagsFor(S, core.findRecord(S, 2)).some((f) => /TODO/.test(f.message)), 'flags the TODO');
  assert.ok(core.heuristicSuggestions(S).some((s) => /test/i.test(s)), 'suggests tests for the source file');
});

test('observe: reasoning carries forward across messages (thinking + separate tool_use)', () => {
  freshHome();
  const S = 'obs2';
  const cwd = tmpWork();
  const F = path.join(cwd, 'y.js');
  seedEdit(S, F, null, 'y\n'); // #1
  seedEdit(S, F, 'y\n', 'y\nz\n'); // #2
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan: create y then add z.' }] } }, // reasoning, no tool
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: F } }] } }, // tool, no text -> inherits thinking
    { message: { role: 'assistant', content: [{ type: 'text', text: 'Now adding z.' }, { type: 'tool_use', name: 'Edit', input: { file_path: F } }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);
  const m = core.reasoningByEdit(cwd, S);
  assert.equal(m.get(1), 'Plan: create y then add z.', 'edit #1 inherits the preceding thinking block');
  assert.equal(m.get(2), 'Now adding z.', 'edit #2 uses its own same-message text');
});

test('observe: a Bash record between two edits does not shift reasoning to the wrong edit', () => {
  freshHome();
  const S = 'obs3';
  const cwd = tmpWork();
  const F = path.join(cwd, 'app.js');
  // #1 Edit, #2 Bash (e.g. `prettier --write app.js`), #3 Edit — all to the same file.
  seedEdit(S, F, 'a\n', 'b\n'); // #1 Edit
  core.appendLog(S, { id: core.nextId(S), ts: 2000, tool: 'Bash', file: F, beforeBlob: null, afterBlob: core.writeBlob(S, Buffer.from('B\n')), status: 'pending' }); // #2 Bash
  seedEdit(S, F, 'B\n', 'C\n'); // #3 Edit
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    { message: { role: 'assistant', content: [{ type: 'text', text: 'First edit.' }, { type: 'tool_use', name: 'Edit', input: { file_path: F } }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'Second edit.' }, { type: 'tool_use', name: 'Edit', input: { file_path: F } }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);

  const m = core.reasoningByEdit(cwd, S);
  assert.equal(m.get(1), 'First edit.', 'edit #1 gets the first tool_use reasoning');
  assert.equal(m.get(2), undefined, 'the Bash record gets no reasoning (no transcript tool_use)');
  assert.equal(m.get(3), 'Second edit.', 'edit #3 gets the second reasoning, NOT shifted by the Bash record');
});

test("observe: transcriptSuggestions surfaces Claude's latest open to-dos (zero token)", () => {
  freshHome();
  const S = 'todos';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    // an earlier to-do list that a later one supersedes
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'stale item', status: 'pending' }] } }] } },
    { message: { role: 'assistant', content: [
      { type: 'text', text: 'Wrapping up.' },
      { type: 'tool_use', name: 'TodoWrite', input: { todos: [
        { content: 'Done thing', status: 'completed' },
        { content: 'Write the tests', status: 'pending' },
        { content: 'Refactor parser', status: 'in_progress' },
      ] } },
    ] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);

  const ins = core.transcriptInsights(cwd, S);
  assert.equal(ins.todos.length, 3, 'the latest TodoWrite supersedes the earlier one');
  assert.equal(ins.lastSummary, 'Wrapping up.', 'captures the last assistant summary');

  const sug = core.transcriptSuggestions(cwd, S);
  assert.deepEqual(sug, ['Write the tests', '▸ Refactor parser'], 'drops completed, marks in-progress, keeps order');
  assert.ok(!sug.some((s) => /stale|Done thing/.test(s)), 'superseded + completed items excluded');
});

test('observe: transcript mining is silent when there is no transcript', () => {
  freshHome();
  const cwd = tmpWork();
  assert.deepEqual(core.transcriptSuggestions(cwd, 'nope'), [], 'no transcript -> no suggestions');
  assert.deepEqual(core.transcriptInsights(cwd, 'nope').todos, [], 'no transcript -> no todos');
  assert.equal(core.transcriptInsights(cwd, 'nope').title, null, 'no transcript -> no title');
});

test('observe: transcriptInsights captures the latest ai-title (session recap)', () => {
  freshHome();
  const S = 'titled';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    { type: 'ai-title', aiTitle: 'Old title' },
    { message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } },
    { type: 'ai-title', aiTitle: 'Building the Observations tab' },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);
  assert.equal(core.transcriptInsights(cwd, S).title, 'Building the Observations tab', 'keeps the latest ai-title');
});

test("observe: next steps fold in a Next-steps section from Claude's recap", () => {
  freshHome();
  const S = 'recap';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const summary = 'Done building.\n\n## Next steps\n\n- Wire up the parser\n- Add a regression test\n\nThanks!';
  const tx = [
    { message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Ship it', status: 'in_progress' }] } }] } },
    { message: { role: 'assistant', content: [{ type: 'text', text: summary }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);
  const sug = core.transcriptSuggestions(cwd, S);
  assert.ok(sug.includes('▸ Ship it'), 'keeps the open to-do');
  assert.ok(sug.includes('Wire up the parser') && sug.includes('Add a regression test'), 'folds in the recap Next-steps bullets');
  assert.ok(!sug.includes('Thanks!'), 'stops at the end of the bullet section');
});

test('observe: usageLine reads context fill from the transcript usage', () => {
  freshHome();
  const S = 'usage';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    { message: { role: 'assistant', usage: { input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 9000 }, content: [{ type: 'text', text: 'hi' }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);
  const u = core.usageLine(cwd, S);
  assert.ok(u.ctx, 'context computed');
  assert.equal(u.ctx.tokens, 50000, 'sums input + cache read + cache creation');
  assert.equal(u.ctx.size, 200000, 'defaults to the 200k window under the threshold');
  assert.equal(Math.round(u.ctx.pct), 25, '50k/200k = 25%');
});

test('observe: usageLine prefers the exact statusline cache (ctx/5h/week + resets)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const claudeDir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'statusline-last.json'),
    JSON.stringify({
      ctx_pct: 39, ctx_used: 390000, ctx_size: 1000000,
      five_pct: 12.5, five_reset: '2099-01-01T00:00:00Z', five_tok: 4800000,
      week_pct: 27.3, week_reset: '2099-01-02T00:00:00Z', week_tok: 14000000,
    })
  );
  const u = core.usageLine(cwd, 'nosession'); // cache wins even with no transcript
  assert.equal(u.ctx.pct, 39, 'ctx% comes straight from the cache (matches the terminal)');
  assert.equal(u.ctx.tokens, 390000, 'ctx tokens from the cache');
  assert.equal(u.ctx.size, 1000000);
  assert.equal(u.fiveHourPct, 12.5, '5h from the cache');
  assert.equal(u.weekPct, 27.3, 'week from the cache');
  assert.equal(u.fiveReset, Date.parse('2099-01-01T00:00:00Z'), 'ISO reset normalized to epoch ms');
  assert.equal(u.fiveTokens, 4800000, '5h token estimate from the cache');
  assert.equal(u.weekTokens, 14000000, 'week token estimate from the cache');
});

test('observe: usageLine derives ctx tokens from pct when ctx_used is a stuck 0', () => {
  // Newer Claude Code builds stopped sending context_window token totals, so the statusline
  // persists ctx_used: 0 while ctx_pct is real — the bar must not read "0/1M".
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const claudeDir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'statusline-last.json'),
    JSON.stringify({ ctx_pct: 3, ctx_used: 0, ctx_size: 1000000 })
  );
  const u = core.usageLine(cwd, 'nosession');
  assert.equal(u.ctx.pct, 3);
  assert.equal(u.ctx.tokens, 30000, '3% of 1M derived, not the stuck 0');
  assert.equal(u.ctx.size, 1000000);
});

test('observe: usageLine normalizes an epoch-seconds reset from the cache', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const claudeDir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'statusline-last.json'),
    JSON.stringify({ ctx_pct: 10, ctx_size: 200000, week_pct: 5, week_reset: 1783540800 })
  );
  const u = core.usageLine(cwd, 'nosession');
  assert.equal(u.weekReset, 1783540800 * 1000, 'epoch seconds scaled to epoch ms');
});

test('paths: CLAUDE_CONFIG_DIR relocates the store, sessions, hooks, and usage together', () => {
  // Regression for the devcontainer split: the store/session/hook-install layer used to be pinned to
  // ~/.claude while usage/stats honored CLAUDE_CONFIG_DIR — so relocating the config dir onto a
  // mounted volume only half-worked (edit history reset on rebuild). Now ALL of them follow it.
  const home = freshHome();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cfg-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    assert.equal(core.claudeConfigDir(), cfg);
    assert.equal(core.rootDir(), path.join(cfg, 'claude-observatory'), 'edit store under CLAUDE_CONFIG_DIR');
    assert.equal(core.projectDir('/Users/x/proj'), path.join(cfg, 'projects', '-Users-x-proj'), 'transcripts under it');
    assert.equal(core.settingsPath(), path.join(cfg, 'settings.json'), 'hook install target under it');

    // and none of them leak back into the home ~/.claude
    const homeClaude = path.join(home, '.claude');
    assert.ok(!core.rootDir().startsWith(homeClaude), 'store does not fall back to ~/.claude');
    assert.ok(!core.projectDir('/Users/x/proj').startsWith(homeClaude), 'projects do not fall back to ~/.claude');

    // end-to-end: session resolution + hook install land under the relocated dir, not the home
    // (path.resolve makes the fake cwd drive-absolute on Windows, matching resolveSessionId's resolve)
    const cwd = path.resolve('/Users/x/proj');
    const proj = core.projectDir(cwd);
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, 'sess.jsonl'), '{}');
    assert.equal(core.resolveSessionId(cwd), 'sess', 'session resolved from the relocated projects dir');

    assert.ok(core.installHooks('claude-observatory capture #claude-observatory-hook').changed);
    assert.ok(fs.existsSync(path.join(cfg, 'settings.json')), 'hooks written under CLAUDE_CONFIG_DIR');
    assert.ok(!fs.existsSync(path.join(homeClaude, 'settings.json')), 'home ~/.claude/settings.json untouched');

    // usage cache is read from the relocated dir too
    fs.writeFileSync(path.join(cfg, 'statusline-last.json'), JSON.stringify({ ctx_pct: 42, ctx_size: 200000 }));
    const u = core.usageLine(cwd, 'sess');
    assert.equal(u.ctx.pct, 42, 'usage read from the relocated statusline cache');
    assert.equal(u.statuslineCache, true, 'cache present flag set');
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('paths: without CLAUDE_CONFIG_DIR everything falls back to ~/.claude (unchanged default)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const hc = path.join(home, '.claude');
  assert.equal(core.claudeConfigDir(), hc);
  assert.equal(core.rootDir(), path.join(hc, 'claude-observatory'));
  assert.equal(core.projectDir('/a/b'), path.join(hc, 'projects', '-a-b'));
  assert.equal(core.settingsPath(), path.join(hc, 'settings.json'));
});

test('observe: usageLine flags a missing statusline cache (drives the sidebar "install" hint)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const u = core.usageLine(cwd, 'nosession'); // no statusline-last.json, no transcript
  assert.equal(u.statuslineCache, false, 'no cache file -> false; the webview shows the install nudge');
  assert.equal(u.fiveHourPct, null);
  assert.equal(u.weekPct, null);
  assert.equal(u.cachedAtMs, null, 'no cache -> no age; the stale hint must not fire');
});

test('observe: usageLine exposes the statusline cache age (drives the sidebar "stale" hint)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const claudeDir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const cache = path.join(claudeDir, 'statusline-last.json');
  fs.writeFileSync(cache, JSON.stringify({ ctx_pct: 39, five_pct: 12.5 }));
  const t = Date.now() - 42 * 60000; // backdate 42 minutes (utimes takes seconds; mtimeMs returns ms)
  fs.utimesSync(cache, t / 1000, t / 1000);
  const u = core.usageLine(cwd, 'nosession');
  assert.equal(u.statuslineCache, true);
  assert.ok(Math.abs(u.cachedAtMs - t) < 1500, 'cachedAtMs reflects the cache mtime');
  assert.equal(u.fiveHourPct, 12.5, 'stale values still render as last-known');
  assert.equal(typeof core.USAGE_STALE_MS, 'number', 'threshold exported for the webview');
});

test('observe: usageLine prefers a newer transcript ctx over a stale cache (panel-only sessions)', () => {
  // The VS Code panel never runs the statusLine, so the cache can be hours old while the
  // transcript is live: ctx must track the transcript; 5h/week keep the cache (their only source).
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'live';
  const cwd = tmpWork();
  const claudeDir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const cache = path.join(claudeDir, 'statusline-last.json');
  fs.writeFileSync(cache, JSON.stringify({ ctx_pct: 39, ctx_used: 78000, ctx_size: 200000, five_pct: 12.5, five_reset: '2099-01-01T00:00:00Z' }));
  const old = Date.now() - 3600 * 1000;
  fs.utimesSync(cache, old / 1000, old / 1000);
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 1000, cache_read_input_tokens: 40000, cache_creation_input_tokens: 9000 }, content: [] } })
  );
  const u = core.usageLine(cwd, S);
  assert.equal(u.ctx.tokens, 50000, 'ctx re-derived from the newer transcript');
  assert.equal(Math.round(u.ctx.pct), 25, 'not the stale 39% from the cache');
  assert.equal(u.fiveHourPct, 12.5, '5h still comes from the cache');
  assert.equal(u.statuslineCache, true);
  assert.ok(Math.abs(u.cachedAtMs - old) < 1500, 'age reported so the UI can flag staleness');
});

test('observe: usageLine keeps the exact cache ctx when the cache is newer than the transcript', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'term';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = path.join(proj, S + '.jsonl');
  fs.writeFileSync(tx, JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 1000, cache_read_input_tokens: 40000 }, content: [] } }));
  const old = Date.now() - 3600 * 1000;
  fs.utimesSync(tx, old / 1000, old / 1000);
  const claudeDir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'statusline-last.json'), JSON.stringify({ ctx_pct: 39, ctx_used: 78000, ctx_size: 200000 }));
  const u = core.usageLine(cwd, S);
  assert.equal(u.ctx.pct, 39, 'fresh cache wins: exact terminal values, byte-identical to before');
  assert.equal(u.ctx.tokens, 78000);
});

test('stats: computeStats rolls up transcripts + edits into windows and a daily series', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'statSess';
  const now = Date.now();
  // two store edits stamped "now": one pending, one accepted (kept) — to exercise the status split
  core.ensureStore(S);
  const blob = core.writeBlob(S, Buffer.from('x\n'));
  const id1 = core.nextId(S);
  core.appendLog(S, { id: id1, ts: now, tool: 'Write', file: '/w/a.js', beforeBlob: null, afterBlob: blob, status: 'pending' });
  const id2 = core.nextId(S);
  core.appendLog(S, { id: id2, ts: now, tool: 'Edit', file: '/w/b.js', beforeBlob: null, afterBlob: blob, status: 'pending' });
  core.setStatus(S, id2, 'kept');
  // a transcript for that session with one assistant message today
  const proj = path.join(os.homedir(), '.claude', 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const tx = JSON.stringify({
    sessionId: S,
    timestamp: new Date(now).toISOString(),
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 50 },
      content: [{ type: 'thinking', thinking: 'abcdefghijklmnop' }, { type: 'text', text: 'hi' }],
    },
  });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);

  const st = core.computeStats(S, now);
  assert.equal(st.daily.length, 30, '30-day series');
  const today = st.daily[st.daily.length - 1];
  assert.equal(today.messages, 1, 'today: one assistant message');
  assert.equal(today.tokensOutput, 50, 'today: output tokens');
  assert.equal(today.tokensInput, 110, 'today: input+cache (10+100+0)');
  assert.equal(today.thinking, 4, 'today: thinking ~= 16 chars / 4');
  assert.equal(today.editsPending, 1, 'today: one pending edit');
  assert.equal(today.editsKept, 1, 'today: one accepted edit');
  assert.equal(today.editsUndone, 0, 'today: none reverted');
  assert.equal(st.windows.session.messages, 1, 'session window: transcript messages');
  assert.equal(st.windows.session.edits, 2, 'session window: both store edits');
  assert.equal(st.windows.session.output, 50, 'session window: output tokens');
  assert.equal(st.windows.week.output, 50, '7-day window includes today');
  // hourly (today)
  assert.equal(st.hourly.length, 24, '24 hourly buckets');
  const hr = new Date(now).getHours();
  assert.equal(st.hourly[hr].messages, 1, 'message lands in its hour');
  assert.equal(st.hourly[hr].editsPending, 1, 'pending edit in its hour');
  assert.equal(st.hourly[hr].editsKept, 1, 'accepted edit in its hour');
  assert.equal(st.hourly[hr].tokensInput, 110, 'hourly input tokens');
  assert.equal(st.hourly[hr].tokensOutput, 50, 'hourly output tokens');
});

test('stats: one assistant message split across content-block lines is counted once (no multi-count)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'splitSess';
  const now = Date.now();
  const proj = path.join(os.homedir(), '.claude', 'projects', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  // Current Claude Code writes ONE line per content block, each stamped with the SAME message.id and
  // the IDENTICAL usage. Here: one logical message split into thinking+text+tool_use (3 lines).
  const usage = { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 50 };
  const iso = new Date(now).toISOString();
  const mk = (content) =>
    JSON.stringify({ sessionId: S, timestamp: iso, type: 'assistant', message: { id: 'msg_split1', role: 'assistant', usage, content } });
  const lines = [
    mk([{ type: 'thinking', thinking: 'abcdefghijklmnop' }]), // 16 chars → thinking 4
    mk([{ type: 'text', text: 'hi' }]),
    mk([{ type: 'tool_use', name: 'Edit', input: { file_path: '/w/a.js' } }]),
  ];
  fs.writeFileSync(path.join(proj, S + '.jsonl'), lines.join('\n') + '\n');

  const st = core.computeStats(S, now);
  const today = st.daily[st.daily.length - 1];
  assert.equal(today.messages, 1, 'split message counts as ONE turn, not three');
  assert.equal(today.tokensOutput, 50, 'output usage counted once (not 150)');
  assert.equal(today.tokensInput, 110, 'input+cache usage counted once (not 330)');
  assert.equal(today.thinking, 4, 'thinking accrues from the thinking-block line');
  assert.equal(st.windows.session.messages, 1, 'session window: one message');
  assert.equal(st.windows.session.output, 50, 'session window: output counted once');
});

test('install: --project targets a repo-local settings file, leaving global untouched', () => {
  freshHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-proj-'));
  const projSettings = core.projectSettingsPath(proj);
  const cmd = 'claude-observatory capture #claude-observatory-hook';
  const res = core.installHooks(cmd, projSettings);
  assert.ok(res.changed);
  assert.equal(res.settingsPath, projSettings);
  assert.ok(core.hooksInstalled(projSettings));
  assert.equal(core.hooksInstalled(), false, 'global settings NOT touched');
  assert.ok(core.uninstallHooks(projSettings).changed);
  assert.equal(core.hooksInstalled(projSettings), false);
});

test('install: uninstallStatusline reverts ONLY our statusline, never a user custom one', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cdir = path.join(home, '.claude');
  fs.mkdirSync(cdir, { recursive: true });
  const sp = path.join(cdir, 'settings.json');
  fs.writeFileSync(path.join(cdir, 'statusline.sh'), '#!/bin/bash\n');
  const ours = 'bash ' + path.join(cdir, 'statusline.sh');
  // ours → reverted, other settings preserved, script removed
  fs.writeFileSync(sp, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: ours } }));
  let r = core.uninstallStatusline(sp);
  assert.ok(r.changed && r.scriptRemoved, 'ours is reverted + script removed');
  let d = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(d.statusLine, undefined, 'our statusLine removed');
  assert.equal(d.theme, 'dark', 'unrelated settings preserved');
  // a user's own statusLine is left untouched
  fs.writeFileSync(sp, JSON.stringify({ statusLine: { type: 'command', command: 'my-own-statusline.sh' } }));
  r = core.uninstallStatusline(sp);
  assert.equal(r.changed, false, 'a custom statusLine is NOT touched');
  assert.equal(JSON.parse(fs.readFileSync(sp, 'utf8')).statusLine.command, 'my-own-statusline.sh');
});

test('install: hooks merged non-destructively, idempotent, and reversible', () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const sp = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(sp, JSON.stringify({ permissions: { allow: ['WebSearch'] }, theme: 'dark' }));
  // A path with NO "claude" token — detection must rely on the stable marker, not the path.
  const cmd = 'node "/opt/vendor/tools/dist/capture.js" #claude-observatory-hook';

  assert.ok(core.installHooks(cmd).changed);
  assert.ok(core.hooksInstalled());
  let d = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.deepEqual(d.permissions.allow, ['WebSearch']);
  assert.equal(d.theme, 'dark');
  assert.equal(d.hooks.PreToolUse[0].hooks.length, 1);
  assert.equal(d.hooks.PostToolUse[0].hooks.length, 1);

  assert.equal(core.installHooks(cmd).changed, false, 'idempotent');
  d = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(d.hooks.PreToolUse[0].hooks.length, 1, 'no duplicate');

  assert.ok(core.uninstallHooks().changed);
  assert.equal(core.hooksInstalled(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(sp, 'utf8')).permissions.allow, ['WebSearch']);
});

test('install: isOurCommand uses the stable marker (path-independent) + legacy fallbacks', () => {
  // Primary: the marker works no matter where the package lives.
  assert.ok(core.isOurCommand('node "/opt/anything/dist/capture.js" #claude-observatory-hook'));
  // Fallbacks for legacy/manual entries.
  assert.ok(core.isOurCommand('node "/a/claude_review/packages/cli/dist/capture.js"'));
  assert.ok(core.isOurCommand('node "/usr/lib/node_modules/claude-observatory/dist/index.js" capture'));
  // Not ours.
  assert.ok(!core.isOurCommand('node "/other/tool/dist/capture.js"'), 'no marker, no claude token');
  assert.ok(!core.isOurCommand('echo claude-observatory hi'), 'not the capture entrypoint');
});

test('session: resolveSessionId picks newest and walks up from a subdirectory', () => {
  const home = freshHome();
  // path.resolve makes the fake cwd drive-absolute on Windows (D:\Users\x\proj), matching what
  // resolveSessionId's own resolve() produces — a POSIX literal would mangle to a different dir name.
  const cwd = path.resolve('/Users/x/proj');
  const proj = path.join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'old.jsonl'), '{}');
  fs.writeFileSync(path.join(proj, 'new.jsonl'), '{}');
  fs.utimesSync(path.join(proj, 'old.jsonl'), 1000, 1000);
  fs.utimesSync(path.join(proj, 'new.jsonl'), 2000, 2000);
  assert.equal(core.resolveSessionId(cwd), 'new');
  assert.equal(core.resolveSessionId(cwd + '/sub/deep'), 'new', 'ancestor walk');
  assert.equal(core.resolveSessionId('/nowhere/zzz'), null);
});

test('contract: each --json command emits the documented key set (rename-guard for both editors)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'contract';
  const F = path.join(tmpWork(), 'app.js');
  seedEdit(S, F, 'a\n', 'a\nb\n'); // #1
  seedEdit(S, F, 'a\nb\n', 'a\nB\n'); // #2
  seedEdit(S, path.join(path.dirname(F), 'sub', 'nested.js'), 'x\n', 'x\ny\n'); // #3 — forces a folder node
  // A minimal transcript under THIS cwd's project dir: `sessions` is workspace-filtered (0.8.8), so a
  // session must have a transcript findable from the spawn's cwd to be listed.
  const proj = core.projectDir(process.cwd());
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), JSON.stringify({ timestamp: new Date(500).toISOString(), message: { role: 'user', content: 'Contract fixture session' } }) + '\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_OBSERVATORY_SESSION: S };
  const runJson = (args) => JSON.parse(cp.execFileSync('node', [CLI, ...args], { env, encoding: 'utf8' }));
  const hasKeys = (obj, keys, where) => {
    for (const k of keys) assert.ok(obj && Object.prototype.hasOwnProperty.call(obj, k), `${where}: missing key "${k}"`);
  };
  // Read-only shapes (JetBrains + scripts key on these names — add fields, never rename).
  const list = runJson(['list', '--json']);
  hasKeys(list, ['session', 'edits'], 'list');
  // The FULL session trace (`export`) — the one document that carries everything recorded.
  const trace = runJson(['export']);
  hasKeys(trace, ['exportedAt', 'tool', 'session', 'title', 'root', 'summary', 'edits', 'skips', 'prompts',
    'actions', 'tasks', 'subagents', 'egress', 'outsideWrites', 'observations', 'usage', 'errors'], 'export');
  assert.equal(trace.edits.length, 3, 'export carries every edit');
  hasKeys(trace.edits[0], ['id', 'ts', 'tool', 'file', 'status', 'added', 'removed', 'diff'], 'export.edits[]');
  assert.match(trace.edits[0].diff, /^Index: /, 'each edit carries its reconstructed unified diff');
  assert.deepEqual(trace.errors, [], 'no section fails to build on a healthy store');
  hasKeys(list.edits[0], ['id', 'ts', 'tool', 'file', 'status', 'added', 'removed'], 'list.edits[]');
  hasKeys(runJson(['status', '--json']), ['hooksInstalled', 'hookScript', 'session', 'store', 'lastCaptureTs', 'counts', 'skipped'], 'status');
  const sessions = runJson(['sessions', '--json']);
  hasKeys(sessions, ['active', 'sessions'], 'sessions');
  // Every field the Sessions rows RENDER, in both editors. The list stopped at `current` while 0.9.0 added
  // nine more, so dropping any of them (verified: emitting only the first four) left a green build and a
  // Sessions tab of "+0 -0 . 0 tok" blanks — JetBrains parses exactly these names off each row.
  hasKeys(sessions.sessions[0],
    ['id', 'title', 'lastActiveMs', 'current', 'edits', 'pending', 'files', 'added', 'removed', 'tokens', 'durationMs', 'model', 'effort'],
    'sessions.sessions[]');
  const tree = runJson(['tree', '--json']);
  hasKeys(tree, ['folders', 'files'], 'tree');
  hasKeys(tree.folders[0], ['label', 'path', 'folders', 'files'], 'tree.folders[]'); // `path` drives scoped folder ops
  const observe = runJson(['observe']); // observe is always JSON
  hasKeys(observe, ['session', 'recap', 'insights', 'suggestions', 'edits'], 'observe');
  hasKeys(observe.edits[0], ['id', 'ts', 'tool', 'file', 'status', 'summary', 'reasoning', 'flags', 'memory', 'analysis'], 'observe.edits[]');
  hasKeys(runJson(['usage']), ['staleMs', 'sessionTokens', 'vitals'], 'usage'); // vitals: the Stats model/effort chip
  // Mutations (undo/redo branch on `status`; keep on `kept`) — run these last.
  hasKeys(runJson(['keep', '1', '--json']), ['kept', 'ids'], 'keep');
  const undo = runJson(['undo', '2', '--json']);
  hasKeys(undo, ['ok', 'status', 'message'], 'undo');
});

test('contract 0.8.0: every machine surface the editors consume emits its documented key set (rename-guard)', async () => {
  // The gap this closes: the fast rename-guard above predates 0.8.0 — a key rename in multitask/
  // changemap/tasklog/chat-context/observations/metrics/siblings only failed the slow bash e2e.
  // The demo simulator is the fixture: a real-pipeline session with tasks, a subagent, a workflow.
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = tmpWork();
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true }); // a plain .git dir → commonDir resolves → fleet/worktree paths engage
  const demo = await core.runDemo({ fast: true, cwd: ws });
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_OBSERVATORY_SESSION: demo.session };
  const runJson = (args) => JSON.parse(cp.execFileSync('node', [CLI, ...args], { env, cwd: ws, encoding: 'utf8' }));
  const hasKeys = (obj, keys, where) => {
    for (const k of keys) assert.ok(obj && Object.prototype.hasOwnProperty.call(obj, k), `${where}: missing key "${k}"`);
  };

  // multitask — the Overview left nav (Fleet · Workflows · curated Actions) in both editors.
  const mt = runJson(['multitask', '--json']);
  hasKeys(mt, ['agents', 'collisions', 'worktrees', 'workflows', 'actions', 'summary'], 'multitask');
  // Select the SELF row, never agents[0]: listRepoSiblings sorts by transcript mtime, and the demo's
  // sibling agent can hold that slot. A positional assumption here fails as a confusing TypeError.
  const self = mt.agents.find((a) => a.self);
  assert.ok(self, 'the active session appears in its own fleet');
  hasKeys(self, ['session', 'worktree', 'gitBranch', 'self', 'phase', 'phaseConfidence', 'sparkline', 'todos', 'subagents', 'files', 'diff', 'tokens', 'durationMs', 'risk', 'outside', 'compactions', 'folded', 'loaded'], 'multitask.agents[]');
  hasKeys(self.subagents[0], ['agentId', 'agentType', 'description', 'phase', 'phaseConfidence', 'todos', 'currentTask', 'edits', 'added', 'removed'], 'multitask.agents[].subagents[]');
  hasKeys(mt.workflows[0], ['id', 'name', 'phases', 'agents', 'phaseGroups', 'running', 'lastActivityMs', 'agentCount', 'tokens', 'durationMs', 'edits', 'added', 'removed', 'sparkline'], 'multitask.workflows[]');
  hasKeys(mt.actions, ['groups', 'egress'], 'multitask.actions');
  hasKeys(mt.summary, ['active', 'conflicts'], 'multitask.summary');

  // changemap — the Overview detail (ribbon · strip · ledger) + per-agent slices.
  const cm = runJson(['changemap', '--json']);
  hasKeys(cm, ['summary', 'edits', 'compactions', 'files', 'modules', 'tasks', 'prompts', 'rollupByTask', 'rollupBySubagent', 'rollupByWorkflow', 'workflows', 'rollupByAgent', 'agents', 'unassigned'], 'changemap');
  assert.ok(!('subtasks' in cm) && !('chapters' in cm), 'the display-subtask layer is gone (0.8.8) — neither key is emitted');
  // 0.8.7 folded the footprint into the risk/egress audits — see `risk --json`.outsideWrites and the
  // `file` channels in `egress --json`. The change map no longer carries a badge-row payload.
  assert.ok(!('footprint' in cm), 'changemap carries no footprint — it folded into risk + egress');
  hasKeys(cm.summary, ['session', 'title'], 'changemap.summary'); // title drives the Overview selector + Stats session name (JetBrains)
  hasKeys(cm.tasks[0], ['taskId', 'content', 'firstTs', 'lastTs'], 'changemap.tasks[]'); // the strict identities the Tasks tab + tasklog join
  hasKeys(cm.prompts[0], ['id', 'index', 'text', 'title', 'ts', 'endTs', 'rollup', 'files', 'modules', 'editIds', 'agentIds', 'workflowIds', 'processIds', 'actions', 'errors', 'compactions', 'durationMs'], 'changemap.prompts[]');
  hasKeys(cm.edits[0], ['id', 'rel', 'module', 'file', 'added', 'removed', 'status', 'ts', 'agent', 'risk', 'reasoning', 'taskId', 'subagentId', 'workflowId'], 'changemap.edits[]');
  hasKeys(cm.workflows[0], ['id', 'name', 'running', 'rollup', 'files', 'taskIds'], 'changemap.workflows[]');
  hasKeys(cm.agents[0], ['session', 'worktree', 'gitBranch', 'phase', 'lastMs', 'summary', 'files', 'modules'], 'changemap.agents[]');
  // Per-sibling `edits` is deliberately projected out: 1.95 MB of a 3.30 MB payload that no renderer
  // read. The ACTIVE session's own top-level edits stay — that is the list tools consume.
  assert.ok(!('edits' in cm.agents[0]), 'changemap.agents[] carries no per-sibling edit list');
  assert.ok(Array.isArray(cm.edits), 'the session\'s own edits are untouched');
  const sess = runJson(['sessions', '--json']);
  hasKeys(sess, ['active', 'sessions'], 'sessions');
  hasKeys(sess.sessions[0], ['id', 'title', 'lastActiveMs', 'current'], 'sessions.sessions[]'); // no pending counts — recency + name only (0.8.8)

  // tasklog / chat-context / observations / metrics / siblings --repo.
  const tl = runJson(['tasklog']);
  assert.ok(Array.isArray(tl) && tl.length >= 1, 'tasklog: one row per stable task');
  hasKeys(tl[0], ['taskId', 'content', 'agentIds', 'subagentIds', 'firstTs', 'lastTs', 'edits', 'added', 'removed', 'status'], 'tasklog[]');
  hasKeys(runJson(['chat-context', '--task', tl[0].taskId]), ['prompt'], 'chat-context');
  const obs = runJson(['observations']);
  hasKeys(obs, ['recap', 'runs', 'nextSteps', 'context'], 'observations');
  hasKeys(obs.context, ['sources', 'note'], 'observations.context'); // the Context section in both editors
  hasKeys(obs.runs[0], ['file', 'rel', 'count', 'added', 'removed', 'status', 'edits'], 'observations.runs[]');
  const met = runJson(['metrics', '--json']);
  hasKeys(met, ['session', 'spanMs', 'actions', 'edits', 'subagents', 'toolLatency'], 'metrics');
  const sib = runJson(['siblings', '--json', '--repo', '--all']);
  hasKeys(sib, ['session', 'summary', 'siblings'], 'siblings');
  hasKeys(sib.siblings[0], ['id', 'self', 'active', 'lastMs', 'edits', 'pending', 'files', 'pendingFiles', 'risk', 'worktree', 'gitBranch', 'phase', 'phaseConfidence'], 'siblings.siblings[]');
});

test('capture: hook subprocess records an edit and prints NOTHING to stdout', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'a.txt');
  fs.writeFileSync(F, 'one\ntwo\n');
  const S = 'capSess';
  const env = { ...process.env, HOME: home };
  const pre = JSON.stringify({ session_id: S, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: F } });
  assert.equal(cp.execFileSync('node', [CAPTURE], { input: pre, env, encoding: 'utf8' }), '', 'Pre: no stdout');
  fs.writeFileSync(F, 'ONE\ntwo\n'); // the edit
  const post = JSON.stringify({ session_id: S, cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: F } });
  assert.equal(cp.execFileSync('node', [CAPTURE], { input: post, env, encoding: 'utf8' }), '', 'Post: no stdout');
  const lines = fs.readFileSync(path.join(home, '.claude', 'claude-observatory', S, 'log.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.tool, 'Edit');
  assert.equal(rec.file, F);
  assert.equal(rec.status, 'pending');
});

// --- additional edge-case coverage -------------------------------------------------------------

const crypto = require('crypto');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Run the bundled capture hook subprocess with a hook payload; returns its stdout (must be '').
function runHook(home, session, dir, event, tool, file, keyField = 'file_path') {
  const ti = {};
  ti[keyField] = file;
  const payload = JSON.stringify({ session_id: session, cwd: dir, hook_event_name: event, tool_name: tool, tool_input: ti });
  return cp.execFileSync('node', [CAPTURE], { input: payload, env: { ...process.env, HOME: home }, encoding: 'utf8' });
}
function readStoreLog(home, session) {
  const p = path.join(home, '.claude', 'claude-observatory', session, 'log.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('capture: MultiEdit is captured as one record (tool=MultiEdit) and undoes cleanly', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'm.txt');
  const before = 'L1\nL2\nL3\nL4\nL5\n';
  fs.writeFileSync(F, before);
  const S = 'multi';
  runHook(home, S, dir, 'PreToolUse', 'MultiEdit', F);
  fs.writeFileSync(F, 'TOP\nL2\nL3\nL4\nBOT\n'); // two non-adjacent hunks committed as one MultiEdit
  runHook(home, S, dir, 'PostToolUse', 'MultiEdit', F);
  const log = readStoreLog(home, S);
  assert.equal(log.length, 1, 'one record for the whole MultiEdit');
  assert.equal(log[0].tool, 'MultiEdit', 'recorded tool field is MultiEdit');
  const res = core.undoEdit(S, log[0].id); // clean revert (no later edits) — byte-exact
  assert.equal(res.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), before, 'the whole MultiEdit is reverted');
});

test('capture: a PostToolUse with no matching Pre records nothing (no phantom edit)', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'x.txt');
  fs.writeFileSync(F, 'hi\n');
  const S = 'nopre';
  runHook(home, S, dir, 'PostToolUse', 'Edit', F); // Post only — Pre never ran
  assert.equal(readStoreLog(home, S).length, 0, 'nothing committed without a staged before-snapshot');
});

test('store: skip markers are recorded, ignored by readLog, and surfaced by readSkips', () => {
  freshHome();
  const S = 'skips';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\n', 'b\n'); // a normal edit (#1)
  core.appendSkip(S, '/big/file.bin', 'file too large');
  core.appendSkip(S, '<bash-tree>', 'tree too large');
  const log = core.readLog(S);
  assert.equal(log.length, 1, 'skip markers are NOT edit records (folded out of readLog)');
  assert.equal(log[0].id, 1);
  const skips = core.readSkips(S);
  assert.equal(skips.length, 2);
  assert.equal(skips[0].reason, 'file too large');
  assert.equal(skips[1].file, '<bash-tree>');
});

test('capture: an edit that grows a file past 5MB leaves a skip marker (not a silent drop)', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'big.txt');
  fs.writeFileSync(F, 'small\n'); // ≤5MB at Pre
  const S = 'toobig';
  runHook(home, S, dir, 'PreToolUse', 'Edit', F);
  fs.writeFileSync(F, 'X'.repeat(5 * 1024 * 1024 + 1)); // grew past MAX_BYTES
  runHook(home, S, dir, 'PostToolUse', 'Edit', F);
  assert.equal(core.readLog(S).length, 0, 'no edit record for the too-large file');
  assert.equal(core.readSkips(S).length, 1, 'but a skip marker IS recorded');
});

test('store: readLog skips malformed/partial lines and folds status ops', () => {
  freshHome();
  const S = 'malformed';
  core.ensureStore(S);
  const lp = core.logPath(S);
  // valid record, a garbage line, a partial (truncated) JSON line, then a status op
  fs.writeFileSync(
    lp,
    JSON.stringify({ id: 1, ts: 1, tool: 'Edit', file: '/f', beforeBlob: null, afterBlob: sha('x'), status: 'pending' }) + '\n' +
      'not json at all\n' +
      '{"id":2,"ts":2,"tool":"Edit","file":"/g","before\n' + // truncated
      JSON.stringify({ op: 'status', id: 1, status: 'kept', ts: 3 }) + '\n'
  );
  const log = core.readLog(S);
  assert.equal(log.length, 1, 'only the one well-formed record survives');
  assert.equal(log[0].id, 1);
  assert.equal(log[0].status, 'kept', 'status op folded onto the record');
});

test('store: status folding — last op wins in file order; redundant setStatus appends nothing', () => {
  freshHome();
  const S = 'fold';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\n', 'b\n');
  core.setStatus(S, 1, 'kept');
  core.setStatus(S, 1, 'undone');
  core.setStatus(S, 1, 'pending'); // last op -> pending wins
  assert.equal(core.findRecord(S, 1).status, 'pending');
  const before = fs.readFileSync(core.logPath(S), 'utf8');
  const r = core.setStatus(S, 1, 'pending'); // redundant: already pending
  assert.equal(r.status, 'pending');
  assert.equal(fs.readFileSync(core.logPath(S), 'utf8'), before, 'no redundant status op appended');
});

test('store: clearResolved keeps a pending edit that shares a blob with a removed kept edit', () => {
  freshHome();
  const S = 'sharedblob';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'A\n', 'B\n'); // #1 A->B (will be kept, then cleared)
  seedEdit(S, F, 'B\n', 'C\n'); // #2 B->C (pending) — its beforeBlob == #1.afterBlob (blob "B")
  core.setStatus(S, 1, 'kept');
  const removed = core.clearResolved(S);
  assert.equal(removed, 1);
  const log = core.readLog(S);
  assert.equal(log.length, 1);
  assert.equal(log[0].id, 2);
  // The shared blob "B\n" must survive GC because pending #2 still references it as its before.
  const blobs = fs.readdirSync(path.join(core.storeDir(S), 'blobs'));
  assert.ok(blobs.includes(sha('B\n')), 'shared blob B survives GC');
  assert.ok(!blobs.includes(sha('A\n')), 'blob A (only ref by removed kept edit) is GCd');
  // And undo of the surviving pending edit still works (proves the before blob is intact).
  fs.writeFileSync(F, 'C\n');
  const u = core.undoEdit(S, 2);
  assert.equal(u.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'B\n');
});

test('store: clearResolved on an all-resolved session empties the log, GCs all blobs, resets nextId', () => {
  freshHome();
  const S = 'allresolved';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\n', 'b\n');
  seedEdit(S, F, 'b\n', 'c\n');
  core.setStatus(S, 1, 'kept');
  core.setStatus(S, 2, 'undone');
  assert.equal(core.clearResolved(S), 2);
  assert.equal(core.readLog(S).length, 0, 'log emptied');
  assert.equal(fs.readdirSync(path.join(core.storeDir(S), 'blobs')).length, 0, 'all blobs GCd');
  assert.equal(core.nextId(S), 1, 'nextId resets to 1 on an empty log');
});

test('undo: a KEPT (non-pending) edit can still be undone', () => {
  freshHome();
  const S = 'undokept';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\n', 'b\n');
  fs.writeFileSync(F, 'b\n');
  core.setStatus(S, 1, 'kept');
  const r = core.undoEdit(S, 1);
  assert.equal(r.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'a\n');
  assert.equal(core.findRecord(S, 1).status, 'undone');
});

test('undo: later append with NO trailing newline merges cleanly (no false conflict)', () => {
  freshHome();
  const S = 'eol';
  const F = path.join(tmpWork(), 'eol.txt');
  seedEdit(S, F, 'a\nb\n', 'A\nb\n'); // #1 a->A
  seedEdit(S, F, 'A\nb\n', 'A\nb\nc'); // #2 append "c" with no trailing newline
  fs.writeFileSync(F, 'A\nb\nc');
  const r = core.undoEdit(S, 1);
  assert.equal(r.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'a\nb\nc', 'A->a undone, appended c (no trailing nl) preserved');
});

test('redo: re-creating a create conflicts if the file was re-made with different content; --force wins', () => {
  freshHome();
  const S = 'redocreatediff';
  const F = path.join(tmpWork(), 'n.txt');
  seedEdit(S, F, null, 'created\n'); // #1 create
  core.undoEdit(S, 1); // deletes the file
  fs.writeFileSync(F, 'SOMETHING ELSE\n'); // re-created by hand with different content
  const r = core.redoEdit(S, 1);
  assert.equal(r.status, 'conflict', 'redo must not clobber a differently-recreated file');
  assert.equal(fs.readFileSync(F, 'utf8'), 'SOMETHING ELSE\n', 'file untouched on conflict');
  const r2 = core.reapplyFile(S, 1); // --force
  assert.equal(r2.status, 'redone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'created\n', 'force reapply restores the created content');
  assert.equal(core.findRecord(S, 1).status, 'pending');
});

test('capture: a no-op edit (before == after) is NOT logged', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'same.txt');
  fs.writeFileSync(F, 'unchanged\n');
  const S = 'capnoop';
  runHook(home, S, dir, 'PreToolUse', 'Edit', F);
  // no change on disk
  runHook(home, S, dir, 'PostToolUse', 'Edit', F);
  assert.equal(readStoreLog(home, S).length, 0, 'identical before/after produces no record');
});

test('capture: an empty new-file create is logged as a create (beforeBlob null)', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'empty.txt');
  const S = 'capempty';
  runHook(home, S, dir, 'PreToolUse', 'Write', F); // file missing -> before null
  fs.writeFileSync(F, ''); // creates an empty (0-byte) file
  runHook(home, S, dir, 'PostToolUse', 'Write', F);
  const log = readStoreLog(home, S);
  assert.equal(log.length, 1);
  assert.equal(log[0].beforeBlob, null, 'new file -> before is null');
  assert.equal(log[0].afterBlob, sha(''), 'after is the empty-content blob');
});

test('capture: a binary file (contains a NUL byte) is not captured', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'b.bin');
  const S = 'capbin';
  fs.writeFileSync(F, Buffer.from([1, 2, 0, 3]));
  runHook(home, S, dir, 'PreToolUse', 'Write', F);
  fs.writeFileSync(F, Buffer.from([4, 5, 0, 6]));
  runHook(home, S, dir, 'PostToolUse', 'Write', F);
  assert.equal(readStoreLog(home, S).filter((r) => r.op !== 'skip').length, 0, 'binary edits are not captured as edit records');
  assert.equal(core.readSkips(S).length, 1, 'but a skip marker IS left — a binary edit is not silently dropped');
});

test('capture: rapid successive edits to the same file chain before/after correctly', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'a.txt');
  fs.writeFileSync(F, 'v0\n');
  const S = 'caprapid';
  runHook(home, S, dir, 'PreToolUse', 'Edit', F);
  fs.writeFileSync(F, 'v1\n');
  runHook(home, S, dir, 'PostToolUse', 'Edit', F);
  runHook(home, S, dir, 'PreToolUse', 'Edit', F);
  fs.writeFileSync(F, 'v2\n');
  runHook(home, S, dir, 'PostToolUse', 'Edit', F);
  const log = readStoreLog(home, S);
  assert.equal(log.length, 2);
  assert.deepEqual([log[0].id, log[1].id], [1, 2]);
  assert.equal(log[0].beforeBlob, sha('v0\n'));
  assert.equal(log[0].afterBlob, sha('v1\n'));
  assert.equal(log[1].beforeBlob, sha('v1\n'), 'edit #2 before == edit #1 after (no stale staging)');
  assert.equal(log[1].afterBlob, sha('v2\n'));
});

test('capture: NotebookEdit is captured via notebook_path', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'nb.ipynb');
  fs.writeFileSync(F, '{"cells":[]}\n');
  const S = 'capnb';
  runHook(home, S, dir, 'PreToolUse', 'NotebookEdit', F, 'notebook_path');
  fs.writeFileSync(F, '{"cells":[1]}\n');
  runHook(home, S, dir, 'PostToolUse', 'NotebookEdit', F, 'notebook_path');
  const log = readStoreLog(home, S);
  assert.equal(log.length, 1);
  assert.equal(log[0].tool, 'NotebookEdit');
  assert.equal(log[0].file, F);
});

test('classes: nested python (innermost wins) + unclosed brace class ends at EOF', () => {
  const src = 'class Outer:\n    x = 1\n    class Inner:\n        y = 2\n    z = 3\n';
  const spans = core.detectClasses(src);
  assert.equal(spans.length, 2);
  const outer = spans.find((s) => s.name === 'Outer');
  const inner = spans.find((s) => s.name === 'Inner');
  assert.deepEqual([outer.start, outer.end], [0, 4], 'Outer spans its whole indented body');
  assert.deepEqual([inner.start, inner.end], [2, 3], 'Inner is the nested class');
  assert.equal(core.classAt(spans, 3).name, 'Inner', 'innermost span wins for a nested line');
  assert.equal(core.classAt(spans, 4).name, 'Outer', 'a line back at Outer indent belongs to Outer');
  // An unterminated brace class runs to EOF (no trailing newline -> 3 lines, indices 0..2).
  const bad = core.detectClasses('class Broke {\n  a() {\n  // never closed');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].name, 'Broke');
  assert.equal(bad[0].end, 2, 'unclosed brace class ends at the last line');
});

test('session: mangleCwd maps spaces/unicode; resolveSessionId is null for a missing project dir', () => {
  freshHome();
  assert.equal(core.mangleCwd('/a b/proj-x'), '-a-b-proj-x', 'spaces and hyphens both become -');
  const uni = core.mangleCwd('/Users/café/proj');
  assert.ok(!/[^-a-zA-Z0-9]/.test(uni), 'no non-[-a-zA-Z0-9] chars survive mangling');
  assert.equal(uni, '-Users-caf--proj', 'non-ASCII letter (é) mangles to a single -');
  assert.equal(core.resolveSessionId('/definitely/not/a/real/project'), null);
});

test('observe: flagsFor detects debug/secret/large-deletion; summarize handles create+delete', () => {
  freshHome();
  const S = 'flags';
  const F = path.join(tmpWork(), 'svc.js');
  // create with a debug statement + a hard-coded secret
  const created = 'function f(){\n  console.log("dbg")\n  const api_key = "abc123"\n}\n';
  seedEdit(S, F, null, created);
  const f1 = core.flagsFor(S, core.findRecord(S, 1));
  assert.ok(f1.some((x) => /debug/.test(x.message)), 'flags a debug statement');
  assert.ok(f1.some((x) => /secret/.test(x.message)), 'flags a possible hard-coded secret');
  assert.match(core.summarize(S, core.findRecord(S, 1)), /created svc\.js/);
  // a large deletion
  const big = Array.from({ length: 40 }, (_, i) => `line${i}\n`).join('');
  seedEdit(S, F, big, 'line0\n');
  const f2 = core.flagsFor(S, core.findRecord(S, 2));
  assert.ok(f2.some((x) => /large deletion/.test(x.message)), 'flags a large deletion');
  // a deletion (afterBlob null)
  seedEdit(S, F, 'gone\n', null);
  assert.match(core.summarize(S, core.findRecord(S, 3)), /deleted svc\.js/);
  assert.ok(core.flagsFor(S, core.findRecord(S, 3)).some((x) => /file deleted/.test(x.message)));
});

test('install: a malformed (non-array) hooks shape is tolerated, not crashed (regression)', () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const sp = path.join(home, '.claude', 'settings.json');
  // valid JSON, but hooks.PreToolUse is an object where the code expects an array
  const original = { hooks: { PreToolUse: { matcher: 'Edit' } }, theme: 'dark' };
  fs.writeFileSync(sp, JSON.stringify(original));
  assert.doesNotThrow(() => core.hooksInstalled(sp));
  assert.equal(core.hooksInstalled(sp), false, 'reports not-installed instead of throwing');
  assert.equal(core.installedHookCommand(sp), null);
  // uninstall must not throw and must leave the unknown shape untouched
  let res;
  assert.doesNotThrow(() => {
    res = core.uninstallHooks(sp);
  });
  assert.equal(res.changed, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(sp, 'utf8')), original, 'malformed shape left intact');
});

test('install: a second distinct command merges into the existing MATCHER group (no new group)', () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const sp = path.join(home, '.claude', 'settings.json');
  const cmd1 = 'claude-observatory capture #claude-observatory-hook';
  const cmd2 = 'node "/legacy/claude_review/dist/capture.js"';
  assert.ok(core.installHooks(cmd1, sp).changed);
  assert.ok(core.installHooks(cmd2, sp).changed, 'a different command is a real change');
  const d = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(d.hooks.PreToolUse.length, 1, 'still a single matcher group');
  assert.equal(d.hooks.PreToolUse[0].matcher, core.MATCHER);
  assert.equal(d.hooks.PreToolUse[0].hooks.length, 2, 'both commands land in the same group');
  // uninstall removes both (both are recognizably ours) and prunes the empty group.
  assert.ok(core.uninstallHooks(sp).changed);
  assert.equal(core.hooksInstalled(sp), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(sp, 'utf8')).hooks, {}, 'both empty event groups pruned');
});

// --- stats cache + bucketing edge cases ---------------------------------------------------------

const dk = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
function writeTranscript(home, proj, session, msgs) {
  const dir = path.join(home, '.claude', 'projects', proj);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, session + '.jsonl');
  fs.writeFileSync(p, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
  return p;
}
function assistantMsg(ts, extra = {}) {
  return {
    sessionId: extra.sessionId,
    timestamp: new Date(ts).toISOString(),
    type: 'assistant',
    isSidechain: extra.isSidechain === true,
    message: {
      role: 'assistant',
      usage: extra.usage || { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 50 },
      content: extra.content || [{ type: 'text', text: 'hi' }],
    },
  };
}
const statsCachePath = () => path.join(os.homedir(), '.claude', 'claude-observatory', 'stats-cache.json');

test('stats: cache reused when unchanged, invalidated on mtime change, pruned for deleted files', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const now = Date.now();
  const A = writeTranscript(home, 'projA', 'sessA', [assistantMsg(now)]);
  let st = core.computeStats(undefined, now);
  assert.equal(st.daily[29].messages, 1, 'initial scan sees the message');
  const hr = new Date(now).getHours();
  assert.equal(st.hourly[hr].messages, 1, 'initial scan fills the hourly bucket');

  // Poison the cached aggregates: an UNCHANGED file must be served from the cache (proves reuse).
  const cache = JSON.parse(fs.readFileSync(statsCachePath(), 'utf8'));
  const entry = cache.files[A];
  assert.ok(entry, 'cache has an entry keyed by the transcript path');
  entry.days[dk(now)].msgs = 7;
  entry.hourly.hours[String(hr)].msgs = 5;
  fs.writeFileSync(statsCachePath(), JSON.stringify(cache));
  st = core.computeStats(undefined, now);
  assert.equal(st.daily[29].messages, 7, 'unchanged file served from the (poisoned) daily cache');
  assert.equal(st.hourly[hr].messages, 5, "today's hourly served from the cache too — no re-read");
  // A clean run must not rewrite the cache (nothing changed), so the poison persists.
  st = core.computeStats(undefined, now);
  assert.equal(st.daily[29].messages, 7, 'no-change run leaves the cache untouched');

  // Bump mtime -> stale entry invalidated, real values re-parsed.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(A, later, later);
  st = core.computeStats(undefined, now);
  assert.equal(st.daily[29].messages, 1, 'mtime change invalidates the cached aggregates');
  assert.equal(st.hourly[hr].messages, 1, 'hourly re-parsed as well');

  // A deleted transcript's entry must fall out of the cache file (no stale growth).
  const B = writeTranscript(home, 'projB', 'sessB', [assistantMsg(now)]);
  st = core.computeStats(undefined, now);
  assert.equal(st.daily[29].messages, 2, 'second transcript counted');
  assert.ok(JSON.parse(fs.readFileSync(statsCachePath(), 'utf8')).files[B], 'cache has the new file');
  fs.unlinkSync(B);
  st = core.computeStats(undefined, now);
  assert.equal(st.daily[29].messages, 1, 'deleted transcript no longer counted');
  const files = JSON.parse(fs.readFileSync(statsCachePath(), 'utf8')).files;
  assert.equal(files[B], undefined, 'deleted transcript pruned from the cache');
});

test('stats: a stale-day hourly block is pruned from the cache on the next day', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const now = Date.now();
  const A = writeTranscript(home, 'proj', 'sessH', [assistantMsg(now)]);
  core.computeStats(undefined, now);
  assert.ok(JSON.parse(fs.readFileSync(statsCachePath(), 'utf8')).files[A].hourly, 'hourly cached for today');
  // Next day: the file (mtime unchanged) can hold nothing for the NEW today -> hourly block pruned.
  const st = core.computeStats(undefined, now + 86400000);
  assert.equal(JSON.parse(fs.readFileSync(statsCachePath(), 'utf8')).files[A].hourly, undefined, 'stale hourly pruned');
  assert.equal(st.daily[28].messages, 1, "yesterday's daily aggregates still served from the cache");
  assert.equal(st.hourly.reduce((a, h) => a + h.messages, 0), 0, 'no hourly messages for the new day');
});

test('stats: midnight boundary — 23:xx activity stays in yesterday, not today (injected nowMs)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const t = new Date();
  t.setHours(0, 30, 0, 0); // "now" is 00:30 local
  const now = t.getTime();
  const yesterEve = now - 3600000; // 23:30 local, yesterday
  writeTranscript(home, 'proj', 'sessM', [assistantMsg(yesterEve)]);
  const S = 'sessM';
  core.ensureStore(S);
  const blob = core.writeBlob(S, Buffer.from('x\n'));
  core.appendLog(S, { id: 1, ts: yesterEve, tool: 'Edit', file: '/w/a.js', beforeBlob: null, afterBlob: blob, status: 'pending' });
  const st = core.computeStats(S, now);
  assert.equal(st.daily[29].day, dk(now), 'bucket 29 is today');
  assert.equal(st.daily[28].day, dk(yesterEve), 'bucket 28 is yesterday');
  assert.equal(st.daily[29].messages + st.daily[29].editsPending, 0, 'nothing leaks into today');
  assert.equal(st.daily[28].messages, 1, 'message lands in yesterday');
  assert.equal(st.daily[28].editsPending, 1, 'edit lands in yesterday');
  assert.equal(st.windows.day.edits, 0, "the 'today' window excludes yesterday 23:30");
  assert.equal(st.hourly.reduce((a, h) => a + h.editsPending + h.messages, 0), 0, 'hourly (today) is empty');
});

test('stats: daily series is DST-safe — no dropped day (spring) and no double-counted day (fall)', () => {
  const oldTZ = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    delete process.env.CLAUDE_CONFIG_DIR;
    // Spring forward (2026-03-08 has 23h): naive now-i*24h stepping SKIPS 03-08 entirely.
    let home = freshHome();
    let now = Date.parse('2026-03-09T00:30:00-04:00');
    writeTranscript(home, 'proj', 'sessS', [assistantMsg(Date.parse('2026-03-08T12:00:00-05:00'))]);
    let st = core.computeStats(undefined, now);
    assert.equal(new Set(st.daily.map((d) => d.day)).size, 30, '30 distinct day keys');
    const d8 = st.daily.find((d) => d.day === '2026-03-08');
    assert.ok(d8, 'the 23h spring-forward day is present in the series');
    assert.equal(d8.messages, 1, 'its data is not dropped');
    assert.equal(st.windows.month.messages, 1);

    // Fall back (2026-11-01 has 25h): naive stepping emits 11-01 TWICE -> double-counted windows.
    home = freshHome();
    now = Date.parse('2026-11-03T23:30:00-05:00');
    const p = writeTranscript(home, 'proj', 'sessF', [assistantMsg(Date.parse('2026-11-01T12:00:00-05:00'))]);
    fs.utimesSync(p, new Date(now - 1000), new Date(now - 1000)); // mtime inside the injected window
    st = core.computeStats(undefined, now);
    assert.equal(new Set(st.daily.map((d) => d.day)).size, 30, '30 distinct day keys (no duplicate 11-01)');
    assert.equal(st.daily.filter((d) => d.day === '2026-11-01').length, 1, 'the 25h day appears exactly once');
    assert.equal(st.windows.month.messages, 1, 'the fall-back day is not double-counted');
  } finally {
    if (oldTZ === undefined) delete process.env.TZ;
    else process.env.TZ = oldTZ;
  }
});

test('stats: inlined sidechain (subagent) turns are excluded from message/token counts', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const now = Date.now();
  writeTranscript(home, 'proj', 'sessSide', [
    assistantMsg(now, { sessionId: 'sessSide' }),
    assistantMsg(now, {
      sessionId: 'sessSide',
      isSidechain: true,
      usage: { input_tokens: 999999, cache_read_input_tokens: 999999, output_tokens: 88888 },
    }),
  ]);
  const st = core.computeStats('sessSide', now);
  assert.equal(st.daily[29].messages, 1, 'sidechain turn not counted as a message');
  assert.equal(st.daily[29].tokensOutput, 50, 'sidechain output tokens excluded');
  assert.equal(st.daily[29].tokensInput, 110, 'sidechain input/cache tokens excluded');
  assert.equal(st.windows.session.messages, 1, 'session window main-chain only');
  const hr = new Date(now).getHours();
  assert.equal(st.hourly[hr].messages, 1, 'hourly main-chain only');
});

test('stats: malformed usage values (strings) do not poison the sums', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const now = Date.now();
  writeTranscript(home, 'proj', 'sessBad', [
    assistantMsg(now, { usage: { input_tokens: '10', cache_read_input_tokens: null, output_tokens: '50' } }),
    assistantMsg(now),
  ]);
  const st = core.computeStats(undefined, now);
  assert.equal(st.daily[29].messages, 2, 'both turns counted');
  assert.equal(st.daily[29].tokensOutput, 50, 'string token fields coerced to 0, not concatenated');
  assert.equal(st.daily[29].tokensInput, 110);
  assert.ok(Number.isFinite(st.windows.month.tokens), 'window sums stay numeric');
});

test('stats: transcriptFiles honors CLAUDE_CONFIG_DIR for the transcript scan', () => {
  const home = freshHome();
  const alt = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cfg-'));
  try {
    process.env.CLAUDE_CONFIG_DIR = alt;
    const now = Date.now();
    const dir = path.join(alt, 'projects', 'p');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's.jsonl'), JSON.stringify(assistantMsg(now)) + '\n');
    // nothing under $HOME/.claude/projects — the message must come from CLAUDE_CONFIG_DIR
    const st = core.computeStats(undefined, now);
    assert.equal(st.daily[29].messages, 1, 'transcripts read from CLAUDE_CONFIG_DIR');
    // Unified config dir: the store (and its stats-cache) now follows CLAUDE_CONFIG_DIR too, instead
    // of splitting the cache into the home ~/.claude while transcripts came from the relocated dir.
    assert.ok(fs.existsSync(path.join(alt, 'claude-observatory', 'stats-cache.json')), 'cache lives under the relocated store dir');
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'claude-observatory', 'stats-cache.json')), 'not split back into home ~/.claude');
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('observe: usageLine survives a corrupt statusline-last.json and scans the transcript from the end', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const claudeDir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'statusline-last.json'), '{"ts":123,"model":"Fab'); // truncated JSON
  const S = 'usagecorrupt';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 1000, cache_read_input_tokens: 0 }, content: [] } }),
    JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 2000, cache_read_input_tokens: 38000 }, content: [] } }),
    JSON.stringify({ isSidechain: true, message: { role: 'assistant', usage: { input_tokens: 900000, cache_read_input_tokens: 0 }, content: [] } }),
    '{"broken":"usage"', // trailing garbage that still contains the "usage" prefilter token
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'no usage here' } }),
  ].join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);
  const u = core.usageLine(cwd, S);
  assert.ok(u.ctx, 'fell back to the transcript despite the corrupt cache');
  assert.equal(u.ctx.tokens, 40000, 'LATEST main-chain usage line wins (2000+38000), sidechain + garbage skipped');
  assert.equal(u.fiveHourPct, null, '5h/week stay null on the fallback path');
});

test('observe: usageLine ignores wrong-typed fields in statusline-last.json', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const claudeDir = path.join(os.homedir(), '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'statusline-last.json'),
    JSON.stringify({ ctx_pct: '42', five_pct: null, week_pct: 12, five_tok: 'lots' })
  );
  const u = core.usageLine(cwd, 'nosession');
  assert.equal(u.ctx, null, 'string ctx_pct rejected (no transcript to fall back on)');
  assert.equal(u.fiveHourPct, null, 'null five_pct rejected');
  assert.equal(u.weekPct, 12, 'valid week_pct still honored');
  assert.equal(u.fiveTokens, null, 'string five_tok rejected');
});

test('observe: transcriptInsights ignores inlined sidechain summaries and to-dos', () => {
  freshHome();
  const S = 'sideins';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    { message: { role: 'assistant', content: [{ type: 'text', text: 'Main summary.' }] } },
    { isSidechain: true, message: { role: 'assistant', content: [
      { type: 'text', text: 'Subagent detail.' },
      { type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'subagent-only item', status: 'pending' }] } },
    ] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);
  const ins = core.transcriptInsights(cwd, S);
  assert.equal(ins.lastSummary, 'Main summary.', 'sidechain text does not override the main summary');
  assert.deepEqual(ins.todos, [], "sidechain TodoWrite does not become the session's plan");
});

test('observe: flagsFor accepts a prefetched log (and uses it)', () => {
  freshHome();
  const S = 'flaglog';
  const F = path.join(tmpWork(), 'svc2.js');
  seedEdit(S, F, null, 'export const a = 1\n');
  const rec = core.findRecord(S, 1);
  const log = core.readLog(S);
  assert.deepEqual(core.flagsFor(S, rec, log), core.flagsFor(S, rec), 'prefetched log gives identical flags');
  // Prove the param is really used: a synthetic log containing a test sibling suppresses the flag.
  const withTest = log.concat([{ ...rec, id: 99, file: F.replace(/\.js$/, '.test.js') }]);
  assert.ok(core.flagsFor(S, rec).some((f) => /no test file/.test(f.message)), 'store log alone flags missing tests');
  assert.ok(!core.flagsFor(S, rec, withTest).some((f) => /no test file/.test(f.message)), 'passed-in log wins');
});

test('classes: CRLF files and python classes with trailing comments are detected', () => {
  // CRLF brace language
  const br = core.detectClasses('import x;\r\nexport class Foo {\r\n  m() { return 1 }\r\n}\r\nclass Bar {}\r\n');
  assert.equal(br.length, 2, 'both CRLF brace classes found');
  assert.deepEqual([br[0].name, br[0].start, br[0].end], ['Foo', 1, 3]);
  // CRLF python
  const py = core.detectClasses('class P:\r\n    def m(self):\r\n        pass\r\nx = 1\r\n');
  assert.equal(py.length, 1);
  assert.deepEqual([py[0].name, py[0].end], ['P', 2], 'CR does not break the python end-of-line match');
  // python class with a trailing comment must be treated as python (indent span), not brace-matched
  const pyc = core.detectClasses('class C:  # frozen\n    def m(self):\n        d = {}\n    x = 1\nz = 2\n');
  assert.equal(pyc.length, 1);
  assert.deepEqual([pyc[0].name, pyc[0].start, pyc[0].end], ['C', 0, 3], 'span covers the indented body, not the dict brace');
});

test('memory: fileMemory aggregates a file\'s review history across sessions', () => {
  freshHome();
  const F = '/w/critical/api.ts';
  // session A: one accepted, one reverted; session B: one still pending
  const a1 = seedEdit('memA', F, null, 'v1\n');
  const a2 = seedEdit('memA', F, 'v1\n', 'v2\n');
  core.setStatus('memA', a1, 'kept');
  core.setStatus('memA', a2, 'undone');
  seedEdit('memB', F, 'v2\n', 'v3\n');
  seedEdit('memB', '/w/other.ts', null, 'x\n'); // different file — must not leak in
  // a cached Claude analysis for edit a1 becomes a memory note
  const fs2 = require('fs');
  const path2 = require('path');
  const ap = core.analysisPath('memA', 'edit-' + a1);
  fs2.mkdirSync(path2.dirname(ap), { recursive: true });
  fs2.writeFileSync(ap, JSON.stringify({ kind: 'edit', key: 'edit-' + a1, text: '**Summary** adds the v1 handler\nmore', ts: 5 }));

  const m = core.fileMemory(F);
  assert.equal(m.edits, 3, 'counts edits across both sessions');
  assert.equal(m.kept, 1);
  assert.equal(m.undone, 1);
  assert.equal(m.pending, 1);
  assert.equal(m.lastVerdict.status, 'undone', 'newest decided edit wins');
  assert.equal(m.notes.length, 1, 'cached analysis surfaces as a note');
  assert.equal(m.notes[0].text, 'adds the v1 handler', 'Summary prefix stripped');

  assert.equal(core.isRiskyFile(m), false, 'one revert is not yet risky');
  assert.equal(core.isRiskyFile({ ...m, undone: 2, kept: 1 }), true, 'repeat reverts flag as risky');
  assert.equal(core.isRiskyFile({ ...m, undone: 2, kept: 5 }), false, 'mostly-accepted files are not risky');

  const s = core.memorySummary(m, 10 * 60000 + 2000);
  assert.match(s, /3 edits across sessions/, 'summary counts');
  assert.match(s, /50% accepted/, 'summary acceptance rate');
  assert.match(s, /last reverted/, 'summary last verdict');
  assert.equal(core.memorySummary(core.fileMemory('/w/never-touched.ts')), '', 'no history -> empty summary');
});

test('diagnose: flags missing hooks and CLI-off-PATH, clears once installed', () => {
  freshHome();
  const work = tmpWork();
  const byId = (checks, id) => checks.find((c) => c.id === id);

  // Nothing installed yet: hooks are a hard failure with a fix hint.
  let checks = core.diagnose({ cwd: work, binOnPath: true, jqPresent: true });
  assert.equal(byId(checks, 'hooks').level, 'fail', 'missing hooks reported as a failure');
  assert.ok(byId(checks, 'hooks').fix, 'missing hooks carries a fix hint');
  assert.equal(byId(checks, 'settings-json').level, 'ok', 'absent settings.json is not "invalid"');

  // Install the portable, marker-based hook: the hooks check clears.
  core.installHooks('claude-observatory capture #' + core.HOOK_MARKER, core.settingsPath());
  checks = core.diagnose({ cwd: work, binOnPath: true, jqPresent: true });
  assert.equal(byId(checks, 'hooks').level, 'ok', 'hooks now ok');
  assert.equal(byId(checks, 'hook-shape'), undefined, 'marker hook does not trip the legacy warning');

  // The CLI not resolving on PATH is a hard failure (capture would silently no-op).
  const off = core.diagnose({ cwd: work, binOnPath: false, jqPresent: true });
  assert.equal(byId(off, 'bin-path').level, 'fail', 'bin off PATH is a failure');

  // A hand-mangled settings.json is caught before anything else.
  const fs2 = require('fs');
  fs2.writeFileSync(core.settingsPath(), '{ not json');
  const broken = core.diagnose({ cwd: work, binOnPath: true, jqPresent: true });
  assert.equal(byId(broken, 'settings-json').level, 'fail', 'invalid settings.json flagged');
});

test('semver: compareVersions / isNewer order releases correctly', () => {
  assert.equal(core.compareVersions('0.3.0', '0.3.0'), 0);
  assert.equal(core.compareVersions('0.3.1', '0.3.0'), 1);
  assert.equal(core.compareVersions('0.4.0', '0.3.9'), 1);
  assert.equal(core.compareVersions('1.0.0', '0.9.9'), 1);
  assert.equal(core.compareVersions('v0.3.0', '0.3.0'), 0, 'a leading v is ignored');
  assert.equal(core.isNewer('0.4.0', '0.3.0'), true);
  assert.equal(core.isNewer('0.3.0', '0.3.0'), false);
  assert.equal(core.isNewer('0.2.0', '0.3.0'), false, 'an older release is not "newer"');
  assert.deepEqual(core.parseVersion('v1.2.3-beta.1'), [1, 2, 3], 'prerelease suffix ignored');
});

test('review: reviewSummary aggregates per file + acceptance rate; markdown exports', () => {
  freshHome();
  const S = 'reviewsum';
  const A = path.join(tmpWork(), 'a.txt');
  const B = path.join(tmpWork(), 'b.txt');
  seedEdit(S, A, 'x\n', 'x\ny\n');            // #1 pending
  const i2 = seedEdit(S, A, 'x\ny\n', 'x\n');  // #2 -> keep
  const i3 = seedEdit(S, B, 'p\n', 'q\n');     // #3 -> undo
  core.setStatus(S, i2, 'kept');
  core.setStatus(S, i3, 'undone');
  const s = core.reviewSummary(S);
  assert.equal(s.total, 3);
  assert.equal(s.kept, 1);
  assert.equal(s.undone, 1);
  assert.equal(s.pending, 1);
  assert.equal(Math.round(s.acceptanceRate * 100), 50, '1 kept of 2 reviewed = 50%');
  assert.equal(s.files.length, 2, 'two files aggregated');
  assert.equal(s.reverted.length, 1);
  assert.equal(s.reverted[0].id, i3);
  const md = core.reviewSummaryMarkdown(s);
  assert.match(md, /review summary/i);
  assert.match(md, /50%/, 'markdown shows the acceptance rate');
  assert.match(md, /Reverted edits/, 'markdown lists reverted edits');
});

// Run the capture hook for a Bash tool call (no file_path — capture walks cwd).
function runHookBash(home, session, dir, event) {
  const payload = JSON.stringify({
    session_id: session, cwd: dir, hook_event_name: event, tool_name: 'Bash', tool_input: { command: 'true' },
  });
  return cp.execFileSync('node', [CAPTURE], { input: payload, env: { ...process.env, HOME: home }, encoding: 'utf8' });
}

test('capture: Bash tool full-snapshots cwd and records modify/create/delete (undoable)', () => {
  const home = freshHome();
  const dir = tmpWork();
  const A = path.join(dir, 'a.txt'); // modified
  const B = path.join(dir, 'b.txt'); // deleted
  const D = path.join(dir, 'd.txt'); // untouched
  fs.writeFileSync(A, 'one\n');
  fs.writeFileSync(B, 'gone\n');
  fs.writeFileSync(D, 'same\n');
  const S = 'bashSess';
  assert.equal(runHookBash(home, S, dir, 'PreToolUse'), '', 'Pre: no stdout');
  // simulate the Bash command's effects
  fs.writeFileSync(A, 'ONE\n');
  const C = path.join(dir, 'c.txt');
  fs.writeFileSync(C, 'brand new\n'); // created
  fs.unlinkSync(B); // deleted
  assert.equal(runHookBash(home, S, dir, 'PostToolUse'), '', 'Post: no stdout');

  const log = fs
    .readFileSync(path.join(home, '.claude', 'claude-observatory', S, 'log.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  const at = (f) => log.find((r) => r.file === f);
  assert.ok(at(A) && at(A).tool === 'Bash', 'modified file recorded as a Bash edit');
  assert.ok(at(A).beforeBlob && at(A).afterBlob && at(A).beforeBlob !== at(A).afterBlob, 'modify: before+after present (undoable)');
  assert.ok(at(C) && at(C).beforeBlob === null && at(C).afterBlob, 'created file: before null');
  assert.ok(at(B) && at(B).beforeBlob && at(B).afterBlob === null, 'deleted file: after null');
  assert.equal(at(D), undefined, 'untouched file produces no edit');
});

test('capture: CLAUDE_OBSERVATORY_NO_BASH opts out of Bash capture', () => {
  const home = freshHome();
  const dir = tmpWork();
  const F = path.join(dir, 'a.txt');
  fs.writeFileSync(F, 'one\n');
  const S = 'bashOff';
  const env = { ...process.env, HOME: home, CLAUDE_OBSERVATORY_NO_BASH: '1' };
  const bash = (event) => cp.execFileSync('node', [CAPTURE], {
    input: JSON.stringify({ session_id: S, cwd: dir, hook_event_name: event, tool_name: 'Bash', tool_input: {} }),
    env, encoding: 'utf8',
  });
  bash('PreToolUse');
  fs.writeFileSync(F, 'TWO\n');
  bash('PostToolUse');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'claude-observatory', S, 'log.jsonl')), false, 'no log written when opted out');
});

test('capture: the Bash full-tree walk never snapshots secret files (.env), only ordinary edits', () => {
  const home = freshHome();
  const dir = tmpWork();
  const ENV = path.join(dir, '.env'); // secret — must NOT be captured
  const SRC = path.join(dir, 'app.js'); // ordinary — must be captured
  fs.writeFileSync(ENV, 'API_KEY=sk-secret-000\n');
  fs.writeFileSync(SRC, 'let x = 1;\n');
  const S = 'bashSecret';
  runHookBash(home, S, dir, 'PreToolUse');
  fs.writeFileSync(ENV, 'API_KEY=sk-secret-999\n'); // the Bash command "changed" both
  fs.writeFileSync(SRC, 'let x = 2;\n');
  runHookBash(home, S, dir, 'PostToolUse');

  const log = fs
    .readFileSync(path.join(home, '.claude', 'claude-observatory', S, 'log.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.ok(log.some((r) => r.file === SRC), 'ordinary source edit is captured');
  assert.ok(!log.some((r) => r.file === ENV), '.env is never recorded');
  // and its secret content never lands in a blob
  const blobs = fs.readdirSync(path.join(home, '.claude', 'claude-observatory', S, 'blobs'));
  const anySecret = blobs.some((b) =>
    fs.readFileSync(path.join(home, '.claude', 'claude-observatory', S, 'blobs', b), 'utf8').includes('sk-secret')
  );
  assert.ok(!anySecret, 'no blob contains the .env secret');
});

test('store: session dirs are 0700 and blobs 0600 (not world/group-readable)', { skip: process.platform === 'win32' }, () => {
  freshHome();
  const S = 'perms';
  core.ensureStore(S);
  const sha = core.writeBlob(S, Buffer.from('secret-ish\n'));
  const dirMode = fs.statSync(core.storeDir(S)).mode & 0o777;
  const blobMode = fs.statSync(path.join(core.storeDir(S), 'blobs', sha)).mode & 0o777;
  assert.equal(dirMode & 0o077, 0, `store dir must have no group/other bits (got ${dirMode.toString(8)})`);
  assert.equal(blobMode & 0o077, 0, `blob must have no group/other bits (got ${blobMode.toString(8)})`);
});

test('install: re-init migrates a legacy matcher in place (adds Bash) without duplicating', () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const sp = path.join(home, '.claude', 'settings.json');
  const cmd = 'claude-observatory capture #claude-observatory-hook';
  // an old install: our command under the pre-Bash matcher
  fs.writeFileSync(sp, JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: cmd }] }],
      PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: cmd }] }],
    },
  }));
  assert.ok(core.installHooks(cmd).changed, 're-init migrates the matcher');
  const d = JSON.parse(fs.readFileSync(sp, 'utf8'));
  assert.equal(d.hooks.PreToolUse.length, 1, 'no duplicate group');
  assert.equal(d.hooks.PreToolUse[0].hooks.length, 1, 'no duplicate command');
  assert.equal(d.hooks.PreToolUse[0].matcher, core.MATCHER, 'matcher upgraded to current');
  assert.ok(core.MATCHER.includes('Bash'), 'MATCHER now includes Bash');
  assert.equal(core.installHooks(cmd).changed, false, 'idempotent after migration');
});

test('tree: buildEditTree groups by folder/file with chain compaction + exact deltas', () => {
  freshHome();
  const S = 'treeview';
  const root = tmpWork();
  const A = path.join(root, 'src', 'a.ts');
  const B = path.join(root, 'src', 'util', 'deep', 'b.ts');
  fs.mkdirSync(path.dirname(A), { recursive: true });
  fs.mkdirSync(path.dirname(B), { recursive: true });
  fs.writeFileSync(A, 'x\ny\n');
  fs.writeFileSync(B, 'p\nq\n');
  seedEdit(S, A, 'x\n', 'x\ny\n');   // +1
  seedEdit(S, B, 'p\n', 'p\nq\n');   // +1

  const tree = core.buildEditTree(S, { root });
  assert.equal(tree.files.length, 0, 'nothing directly at root');
  assert.equal(tree.folders.length, 1, 'one top-level folder');
  const src = tree.folders[0];
  assert.equal(src.label, 'src', 'src not compacted (it holds a file and a subfolder)');
  assert.ok(src.files.some((f) => f.rel === 'src/a.ts'), 'a.ts sits directly under src');
  const util = src.folders.find((d) => d.label === 'util/deep');
  assert.ok(util, 'single-child chain util/deep is compacted into one node');
  assert.equal(util.files[0].rel, 'src/util/deep/b.ts');
  const aFile = src.files.find((f) => f.rel === 'src/a.ts');
  assert.equal(aFile.loose.length, 1, 'edit is loose (no class detected)');
  assert.equal(aFile.loose[0].added, 1, 'exact delta carried on the edit');

  // filter narrows by relative path
  const filtered = core.buildEditTree(S, { root, filter: 'a.ts' });
  const flatFiles = [];
  const walk = (n) => { flatFiles.push(...n.files.map((f) => f.rel)); n.folders.forEach(walk); };
  walk(filtered);
  assert.deepEqual(flatFiles, ['src/a.ts'], 'filter keeps only matching files');
});

test('actions: parseActions builds a typed timeline of every tool call, with results + edit links', () => {
  freshHome();
  const S = 'acts';
  const cwd = tmpWork();
  const F = path.join(cwd, 'app.ts');
  // store: two edits to F so the edit-category actions link to records #1 / #2 positionally.
  seedEdit(S, F, null, 'export const a = 1\n'); // #1
  seedEdit(S, F, 'export const a = 1\n', 'export const a = 2\n'); // #2
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    { timestamp: '2026-07-13T10:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'Exploring the code.' },
      { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: F } },
      { type: 'tool_use', id: 'tu2', name: 'Grep', input: { pattern: 'const a', path: cwd } },
    ] } },
    { message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'ok' },
      { type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'grep failed' },
    ] } },
    { timestamp: '2026-07-13T10:01:00.000Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'Creating app.ts.' },
      { type: 'tool_use', id: 'tu3', name: 'Write', input: { file_path: F, content: '...' } },
    ] } },
    { message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Now run checks.' }] } }, // reasoning, no tool
    { timestamp: '2026-07-13T10:02:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu4', name: 'Bash', input: { command: 'npm test\n--silent', description: 'run tests' } },
      { type: 'tool_use', id: 'tu5', name: 'WebFetch', input: { url: 'https://example.com/docs' } },
      { type: 'tool_use', id: 'tu6', name: 'Agent', input: { description: 'audit deps', subagent_type: 'Explore' } },
      { type: 'tool_use', id: 'tu7', name: 'TodoWrite', input: { todos: [{ content: 'ship it', status: 'in_progress' }, { content: 'done', status: 'completed' }] } },
    ] } },
    { timestamp: '2026-07-13T10:03:00.000Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'Bump to 2.' },
      { type: 'tool_use', id: 'tu8', name: 'Edit', input: { file_path: F } },
    ] } },
    // a subagent (sidechain) line — must be IGNORED (its calls live in subagents/*.jsonl).
    { isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 'sx1', name: 'Read', input: { file_path: '/secret' } }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);

  const acts = core.parseActions(cwd, S);
  const byTool = (t) => acts.find((a) => a.tool === t);
  assert.equal(acts.length, 8, 'every main-chain tool call captured; the sidechain call excluded');

  // categories
  assert.equal(byTool('Read').category, 'read');
  assert.equal(byTool('Grep').category, 'search');
  assert.equal(byTool('Write').category, 'edit');
  assert.equal(byTool('Bash').category, 'exec');
  assert.equal(byTool('WebFetch').category, 'web');
  assert.equal(byTool('Agent').category, 'agent');
  assert.equal(byTool('TodoWrite').category, 'todo');

  // targets (one-line, tool-specific)
  assert.equal(byTool('Read').target, F);
  assert.equal(byTool('Grep').target, 'const a');
  assert.equal(byTool('Bash').target, 'npm test --silent', 'multiline command collapsed to one line');
  assert.equal(byTool('Bash').detail, 'run tests');
  assert.equal(byTool('WebFetch').target, 'https://example.com/docs');
  assert.equal(byTool('Agent').target, 'audit deps');
  assert.equal(byTool('Agent').detail, 'Explore');
  assert.match(byTool('TodoWrite').target, /ship it/, 'todo target surfaces the in-progress item');

  // result folding (ok / isError from the correlated tool_result)
  assert.equal(byTool('Read').ok, true);
  assert.equal(byTool('Grep').ok, false);
  assert.equal(byTool('Grep').isError, true, 'an errored tool_result folds onto its action');

  // reasoning carry-forward (same-message text, and a thinking-only preceding message)
  assert.equal(byTool('Read').reasoning, 'Exploring the code.');
  assert.equal(byTool('Bash').reasoning, 'Now run checks.', 'thinking-only message carries forward to the next call');

  // edit linking: Write -> store #1, Edit -> store #2 (positional per file); Bash is not edit-linked
  assert.equal(byTool('Write').editId, 1, 'Write links to store edit #1');
  assert.equal(byTool('Edit').editId, 2, 'Edit links to store edit #2');
  assert.equal(byTool('Bash').editId, undefined, 'a Bash action carries no single editId');

  // chronological + summary
  assert.ok(acts[0].ts > 0 && acts[0].ts <= acts[acts.length - 1].ts, 'actions are in chronological order with parsed timestamps');
  const sum = core.summarizeActions(acts);
  assert.equal(sum.total, 8);
  assert.equal(sum.errors, 1);
  assert.equal(sum.byCategory.edit, 2);
});

test('actions: silent when there is no transcript', () => {
  freshHome();
  assert.deepEqual(core.parseActions(tmpWork(), 'nope'), [], 'no transcript -> no actions');
});

test('actions: buildActionGroups groups by category, curated by default (errors always surface)', () => {
  const acts = [
    { category: 'edit', tool: 'Edit', isError: false }, { category: 'edit', tool: 'Write', isError: false },
    { category: 'exec', tool: 'Bash', isError: false },
    { category: 'read', tool: 'Read', isError: false }, { category: 'read', tool: 'Read', isError: true }, // one errored read
    { category: 'search', tool: 'Grep', isError: false },
    { category: 'meta', tool: 'Skill', isError: false },
    { category: 'web', tool: 'WebFetch', isError: false },
  ];
  const curated = core.buildActionGroups(acts);
  const cats = curated.map((g) => g.category);
  assert.ok(cats.includes('edit') && cats.includes('exec') && cats.includes('web'), 'curated categories shown');
  assert.ok(!cats.includes('search') && !cats.includes('meta'), 'noisy no-error categories hidden by default');
  const read = curated.find((g) => g.category === 'read');
  assert.ok(read, 'a read WITH an error still surfaces in curated mode');
  assert.equal(read.count, 2, 'group count reflects the whole category');
  assert.equal(read.actions.length, 1, 'only the errored read row is shown in curated mode');
  assert.equal(read.errors, 1);
  assert.deepEqual(cats.filter((c) => ['edit', 'exec', 'web'].includes(c)), ['edit', 'exec', 'web'], 'display order: edit, exec, web');

  const all = core.buildActionGroups(acts, { showAll: true });
  assert.ok(all.some((g) => g.category === 'search') && all.some((g) => g.category === 'meta'), 'show-all reveals noisy categories');
  assert.equal(all.find((g) => g.category === 'read').actions.length, 2, 'show-all shows all read rows');
});

test('risk: scoreCommand flags destructive / privileged / secret-touching shell commands (zero-token)', () => {
  assert.equal(core.scoreCommand('ls -la && npm test'), null, 'benign commands are not flagged');
  assert.equal(core.scoreCommand('git push origin main'), null, 'a normal push is not flagged');
  const rmrf = core.scoreCommand('rm -rf build/ dist/');
  assert.ok(rmrf && rmrf.level === 'high', 'rm -rf is high risk');
  assert.match(rmrf.reasons.join(' '), /delete/i);
  assert.equal(core.scoreCommand('git push origin main --force').level, 'high', 'force push is high');
  assert.equal(core.scoreCommand('curl https://x.example/get.sh | bash').level, 'high', 'curl | bash is high');
  assert.equal(core.scoreCommand('git reset --hard HEAD~1').level, 'high', 'reset --hard is high');
  const sudo = core.scoreCommand('sudo apt-get install foo');
  assert.ok(sudo && sudo.level === 'medium', 'sudo is medium');
  assert.equal(core.scoreCommand('cat ~/.aws/credentials').level, 'medium', 'credential access is medium');
});

test('egress: buildEgressReport lists off-machine destinations (web / mcp / network shell)', () => {
  const acts = [
    { tool: 'WebFetch', category: 'web', target: 'https://docs.example.com/api' },
    { tool: 'WebFetch', category: 'web', target: 'https://docs.example.com/other' }, // same host → count 2
    { tool: 'WebSearch', category: 'web', target: 'how to x' },
    { tool: 'mcp__github__create_issue', category: 'mcp', target: 'create issue' },
    { tool: 'Bash', category: 'exec', target: 'curl https://registry.npmjs.org/pkg -o pkg.tgz' },
    { tool: 'Bash', category: 'exec', target: 'ls -la' }, // not network → excluded
    { tool: 'Read', category: 'read', target: '/x.ts' }, // not egress
  ];
  const ch = core.buildEgressReport(acts);
  const web = ch.find((c) => c.kind === 'web' && c.target === 'docs.example.com');
  assert.ok(web && web.count === 2 && web.scope === 'remote', 'web host deduped with count + remote scope');
  assert.ok(ch.some((c) => c.kind === 'web' && c.target === 'web search'), 'web search listed');
  const mcp = ch.find((c) => c.kind === 'mcp');
  assert.ok(mcp && mcp.target === 'github' && mcp.scope === 'unknown', 'mcp server extracted, scope unknown (stdio vs remote unknowable)');
  assert.ok(ch.some((c) => c.kind === 'shell' && c.target === 'registry.npmjs.org'), 'network shell command → host');
  assert.ok(!ch.some((c) => c.target === 'ls' || /x\.ts/.test(c.target)), 'benign shell / reads excluded');
  assert.ok(core.summarizeEgress(ch).remote >= 3, 'summary counts remote channels');
});

test('subagents: parseSubagents mines each spawned subagent + metrics from subagents/*.jsonl (0.7.0)', () => {
  freshHome();
  const S = 'subs';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const AG = 'a1b2c3d4e5f6';
  // main transcript: an Agent spawn (tu1); its tool_result record carries the toolUseResult naming the
  // agentId + Claude Code's per-subagent metrics (duration / tokens / tool-use count).
  const main = [
    { timestamp: '2026-07-13T10:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'review the diff', subagent_type: 'code-reviewer' } },
    ] } },
    { timestamp: '2026-07-13T10:05:00.000Z',
      toolUseResult: { status: 'completed', agentId: AG, agentType: 'code-reviewer', totalDurationMs: 300000, totalTokens: 45000, totalToolUseCount: 12 },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false, content: 'done' }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), main);
  // the subagent's own transcript (all isSidechain) — its tool calls live here, not in the main file.
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subtx = [
    { isSidechain: true, agentId: AG, sessionId: S, timestamp: '2026-07-13T10:01:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'st1', name: 'Read', input: { file_path: '/x.ts' } },
      { type: 'tool_use', id: 'st2', name: 'Grep', input: { pattern: 'foo' } },
    ] } },
    { isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'st2', is_error: true }] } },
    { isSidechain: true, timestamp: '2026-07-13T10:02:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'st3', name: 'Edit', input: { file_path: '/x.ts' } },
    ] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(subDir, `agent-${AG}.jsonl`), subtx);

  const subs = core.parseSubagents(cwd, S);
  assert.equal(subs.length, 1, 'one subagent found');
  const s = subs[0];
  assert.equal(s.agentId, AG);
  assert.equal(s.agentType, 'code-reviewer', 'agentType from toolUseResult');
  assert.equal(s.description, 'review the diff', 'description correlated from the spawn input');
  assert.equal(s.status, 'completed');
  assert.equal(s.durationMs, 300000, 'duration from toolUseResult');
  assert.equal(s.tokens, 45000);
  assert.equal(s.toolUseCount, 12);
  assert.equal(s.actions.length, 3, "subagent's own tool calls parsed (sidechain kept for its OWN file)");
  assert.equal(s.edits, 1, 'one edit action attributed to the subagent');
  assert.equal(s.summary.errors, 1, 'the errored grep folds onto the subagent summary');
  const rollup = core.summarizeSubagents(subs);
  assert.deepEqual(
    [rollup.count, rollup.totalActions, rollup.totalEdits, rollup.totalDurationMs, rollup.totalTokens, rollup.errors],
    [1, 3, 1, 300000, 45000, 1]
  );
  // The main transcript's Agent spawn is NOT double-counted as a subagent action.
  assert.ok(core.parseActions(cwd, S).every((a) => a.tool !== 'Read'), "subagent's Read stays out of the main action timeline");
});

test('workflows: parseWorkflows aggregates a run — name/phases from the script, per-agent + summed tokens/time/edits, running flag (0.8.0) [journal/script FALLBACK: no state file]', () => {
  freshHome();
  const S = 'wf';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), ''); // main transcript must exist (findTranscript/findSubagentsDir)
  const wfDir = path.join(proj, S, 'subagents', 'workflows', 'wf_test123');
  fs.mkdirSync(wfDir, { recursive: true });
  // The script that names the run — name/description/phases parsed from `export const meta` WITHOUT executing it.
  const scriptsDir = path.join(proj, S, 'workflows', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, 'demo-flow-wf_test123.js'),
    "export const meta = {\n  name: 'Demo Flow',\n  description: 'A demo workflow',\n  phases: [{ title: 'Plan' }, { title: 'Build' }],\n}\n"
  );
  // journal: two agents started; only agent A got a result (agent B is still running).
  fs.writeFileSync(
    path.join(wfDir, 'journal.jsonl'),
    [
      { type: 'started', key: 'phase-plan', agentId: 'a1111111' },
      { type: 'started', key: 'phase-build', agentId: 'b2222222' },
      { type: 'result', key: 'phase-plan', agentId: 'a1111111', result: { ok: true } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n')
  );
  // Agent A transcript: two assistant turns (60s apart) → 400 tok, 60000ms; one Edit adding a line (+1/-0).
  fs.writeFileSync(
    path.join(wfDir, 'agent-a1111111.jsonl'),
    [
      { timestamp: '2026-07-15T10:00:00.000Z', message: { role: 'assistant', id: 'mA1', usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 200 }, content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/f.ts', old_string: 'line1\nline2\n', new_string: 'line1\nline2\nline3\n' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: false }] } },
      { timestamp: '2026-07-15T10:01:00.000Z', message: { role: 'assistant', id: 'mA2', usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 50 }, content: [{ type: 'text', text: 'done' }] } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n')
  );
  fs.writeFileSync(path.join(wfDir, 'agent-a1111111.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
  // Agent B transcript: a single Read turn → 50 tok, 0ms, no edits.
  fs.writeFileSync(
    path.join(wfDir, 'agent-b2222222.jsonl'),
    JSON.stringify({ timestamp: '2026-07-15T10:00:30.000Z', message: { role: 'assistant', id: 'mB1', usage: { input_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 30 }, content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/g.ts' } }] } })
  );
  fs.writeFileSync(path.join(wfDir, 'agent-b2222222.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));

  const runs = core.parseWorkflows(cwd, S);
  assert.equal(runs.length, 1, 'one workflow run');
  const w = runs[0];
  assert.equal(w.id, 'wf_test123');
  assert.equal(w.name, 'Demo Flow', 'name from meta.name');
  assert.equal(w.description, 'A demo workflow', 'description from meta');
  assert.deepEqual(w.phases, ['Plan', 'Build'], 'phase titles from meta.phases');
  assert.equal(w.agentCount, 2);
  // Summed per-workflow — the user asked explicitly for tokens + time + edits.
  assert.equal(w.tokens, 450, 'Σtokens = 400 + 50');
  assert.equal(w.durationMs, 60000, 'Σtime = 60000 + 0');
  assert.equal(w.edits, 1, 'Σedits = 1 + 0');
  assert.equal(w.added, 1, 'Σadded from the agents own Edit inputs');
  assert.equal(w.removed, 0);
  assert.equal(w.running, true, 'agent B is started-without-result and the run is fresh');
  // Fallback phaseGroups group by the journal key (no real phase names without the state file), in agent order.
  assert.deepEqual(
    w.phaseGroups,
    [{ title: 'phase-plan', done: 1, total: 1 }, { title: 'phase-build', done: 0, total: 1 }],
    'fallback phaseGroups group agents by the journal key, per-phase done/total'
  );

  const a = w.agents.find((x) => x.agentId === 'a1111111');
  assert.deepEqual([a.tokens, a.durationMs, a.edits, a.added, a.removed], [400, 60000, 1, 1, 0], 'agent A per-agent metrics');
  assert.equal(a.done, true, 'agent A got a journal result');
  assert.equal(a.phase, 'phase-plan', "agent phase = the journal key that grouped it");
  assert.equal(a.label, null, 'no per-agent label in the journal fallback');
  assert.equal(a.agentType, 'workflow-subagent', 'agentType from the sidecar');
  const b = w.agents.find((x) => x.agentId === 'b2222222');
  assert.deepEqual([b.tokens, b.durationMs, b.edits], [50, 0, 0], 'agent B per-agent metrics');
  assert.equal(b.done, false, 'agent B has no result yet');
  assert.equal(b.phase, 'phase-build');
});

test('workflows: a RUNNING run whose journal keys are per-agent HASHES shows NO bogus phase groups (0.8.0)', () => {
  // Regression: newer workflow runtimes write the journal `key` as a per-agent content hash ("v2:<hex>")
  // — NOT a phase — and the rich state file (with real labels/phases) only appears at completion. The
  // fallback must NOT turn each hash into its own "phase", else the UI shows "v2:<hash> 0/1" rows.
  freshHome();
  const S = 'wfhash';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), '');
  const wfDir = path.join(proj, S, 'subagents', 'workflows', 'wf_hash1');
  fs.mkdirSync(wfDir, { recursive: true });
  const H1 = 'v2:dd396d39b36879c0a47ed0381448112552c76a5b6811aac8f71e44fa30f60a66';
  const H2 = 'v2:500cbad28997de976a1956a41becf4513d2c792dabd98109340e8ef71e87face';
  fs.writeFileSync(
    path.join(wfDir, 'journal.jsonl'),
    [
      { type: 'started', key: H1, agentId: 'aca9b4b71e422a493' },
      { type: 'started', key: H2, agentId: 'aac152dc04db93ad1' },
    ].map((o) => JSON.stringify(o)).join('\n')
  );
  for (const id of ['aca9b4b71e422a493', 'aac152dc04db93ad1']) {
    fs.writeFileSync(
      path.join(wfDir, `agent-${id}.jsonl`),
      JSON.stringify({ timestamp: '2026-07-15T10:00:00.000Z', message: { role: 'assistant', id: 'm' + id, usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: 'working' }] } })
    );
    fs.writeFileSync(path.join(wfDir, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'general-purpose', spawnDepth: 1 }));
  }
  const w = core.parseWorkflows(cwd, S)[0];
  assert.equal(w.agentCount, 2);
  assert.deepEqual(w.phaseGroups, [], 'a hash journal key is NOT a phase — no phase groups until the state file lands');
  for (const a of w.agents) {
    assert.equal(a.phase, null, 'agent phase is null (the hash key is ignored, not used as a phase)');
    assert.equal(a.label, null, 'no label derivable (assistant-only transcript — a prompt line is required)');
    assert.equal(a.labelDerived, false, 'labelDerived stays false when nothing was derived');
    assert.equal(a.agentType, 'general-purpose', 'agentType still read from the sidecar');
  }
});

test('tasks: readSessionTasks reads the session task dir (numeric order, malformed skipped, unsafe id refused) + summarizeTasks counts (0.8.3)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'task-sess-1';
  const dir = path.join(home, '.claude', 'tasks', S);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ id: '2', subject: 'Ship it', status: 'in_progress', activeForm: 'Shipping', blocks: [], blockedBy: ['1'] }));
  fs.writeFileSync(path.join(dir, '10.json'), JSON.stringify({ id: '10', subject: 'Follow-up', status: 'pending' }));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ id: '1', subject: 'Build it', status: 'completed' }));
  fs.writeFileSync(path.join(dir, '3.json'), '{not json'); // one bad write must not blank the tab
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored'); // only <digits>.json are tasks
  const ts = core.readSessionTasks(S);
  assert.deepEqual(ts.map((t) => t.id), ['1', '2', '10'], 'numeric id order (not lexicographic), malformed + non-task files skipped');
  assert.equal(ts[1].activeForm, 'Shipping');
  assert.deepEqual(ts[1].blockedBy, ['1']);
  assert.equal(ts[2].activeForm, null, 'absent activeForm → null');
  assert.deepEqual(core.summarizeTasks(ts), { total: 3, completed: 1, inProgress: 1, pending: 1 });
  assert.deepEqual(core.readSessionTasks('../escape'), [], 'a path-shaped session id is refused, not joined');
  assert.deepEqual(core.readSessionTasks('no-such-session'), [], 'missing dir → [] (session never used tasks)');
});

test('workflows: LIVE runs derive per-agent labels from the first distinguishing prompt line (hash-key journal, no state file) — marked labelDerived (0.8.1)', () => {
  // Newer runtimes journal only {type, key: "v2:<hash>", agentId} — no label/phaseTitle — so a running
  // fan-out used to render as "workflow-subagent <id>" rows. The agents' prompts share their preamble
  // and diverge at the task line: that first unique line IS the live label (heuristic, hence the flag).
  freshHome();
  const S = 'wflive';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), '');
  const wfDir = path.join(proj, S, 'subagents', 'workflows', 'wf_live1');
  fs.mkdirSync(wfDir, { recursive: true });
  const PREAMBLE = 'Repo rules: do not commit, do not touch git — shared preamble every sibling carries.';
  const agents = [
    { id: 'a111aaaaaaaaaaaaa', task: 'Your job: convert the core demo simulator to the Python canon.' },
    { id: 'a222bbbbbbbbbbbbb', task: 'Your job: convert README.md and docs/DEMO.md to the Python canon.' },
  ];
  fs.writeFileSync(
    path.join(wfDir, 'journal.jsonl'),
    agents.map((a, i) => JSON.stringify({ type: 'started', key: `v2:${String(i).repeat(64)}`, agentId: a.id })).join('\n')
  );
  for (const a of agents) {
    fs.writeFileSync(
      path.join(wfDir, `agent-${a.id}.jsonl`),
      [
        { type: 'user', timestamp: '2026-07-16T10:00:00.000Z', message: { role: 'user', content: PREAMBLE + '\n\n' + a.task } },
        { timestamp: '2026-07-16T10:00:05.000Z', message: { role: 'assistant', id: 'm' + a.id, usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: 'starting the conversion' }] } },
      ].map((o) => JSON.stringify(o)).join('\n')
    );
    fs.writeFileSync(path.join(wfDir, `agent-${a.id}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
  }
  // A third sibling whose prompt is ONLY the shared preamble: no distinguishing line exists, so NO label
  // may be derived (three identical labels would be worse than the agentType + id fallback rows).
  fs.appendFileSync(
    path.join(wfDir, 'journal.jsonl'),
    '\n' + JSON.stringify({ type: 'started', key: 'v2:' + 'c'.repeat(64), agentId: 'a333ccccccccccccc' })
  );
  fs.writeFileSync(
    path.join(wfDir, `agent-a333ccccccccccccc.jsonl`),
    JSON.stringify({ type: 'user', timestamp: '2026-07-16T10:00:00.000Z', message: { role: 'user', content: PREAMBLE } })
  );
  fs.writeFileSync(path.join(wfDir, `agent-a333ccccccccccccc.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
  const w = core.parseWorkflows(cwd, S)[0];
  const byId = new Map(w.agents.map((a) => [a.agentId, a]));
  assert.equal(byId.get('a111aaaaaaaaaaaaa').label, 'Your job: convert the core demo simulator to the Python canon.', 'label = the first prompt line unique to the agent (the shared preamble is skipped)');
  assert.equal(byId.get('a222bbbbbbbbbbbbb').label, 'Your job: convert README.md and docs/DEMO.md to the Python canon.');
  assert.equal(byId.get('a111aaaaaaaaaaaaa').labelDerived, true, 'derived labels are flagged so renderers mark them (~), never assert them');
  assert.equal(byId.get('a222bbbbbbbbbbbbb').labelDerived, true);
  assert.equal(byId.get('a333ccccccccccccc').label, null, 'all-shared prompt → no derived label (agentType + id beats identical labels)');
  assert.equal(byId.get('a333ccccccccccccc').labelDerived, false);
});

test('metrics: sessionUsage sums main-chain tokens (deduped by message id, sidechain excluded) + transcript wall-clock (0.8.0 r3 — the per-sibling Fleet metric)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'usageSess';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const T0 = '2026-07-15T10:00:00.000Z';
  const T1 = '2026-07-15T10:05:00.000Z';
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      { type: 'user', timestamp: T0, message: { role: 'user', content: 'go' } },
      { timestamp: T0, message: { role: 'assistant', id: 'm1', usage: { input_tokens: 100, cache_read_input_tokens: 40000, cache_creation_input_tokens: 9000, output_tokens: 200 }, content: [{ type: 'thinking', thinking: 'x' }] } },
      // Same message.id, second block of the SAME turn — its usage must be counted once, not doubled.
      { timestamp: T0, message: { role: 'assistant', id: 'm1', usage: { input_tokens: 100, cache_read_input_tokens: 40000, cache_creation_input_tokens: 9000, output_tokens: 200 }, content: [{ type: 'text', text: 'hi' }] } },
      { timestamp: T1, message: { role: 'assistant', id: 'm2', usage: { input_tokens: 50, output_tokens: 50 }, content: [] } },
      // A sidechain (subagent) turn — huge usage that must NOT swamp the main-chain total.
      { timestamp: T1, isSidechain: true, message: { role: 'assistant', id: 'sc', usage: { input_tokens: 999999, output_tokens: 999999 }, content: [] } },
    ].map((o) => JSON.stringify(o)).join('\n')
  );
  const u = core.sessionUsage(cwd, S);
  assert.equal(u.total, 49400, 'Σ = (100+40000+9000+200) + (50+50); dup id + sidechain excluded');
  assert.equal(u.input, 150, 'uncached input split out (100 + 50)');
  assert.equal(u.output, 250, 'output split out (200 + 50)');
  assert.equal(u.cacheRead, 40000, 'cache reads split out');
  assert.equal(u.cacheCreation, 9000, 'cache writes split out');
  assert.equal(Math.round(u.hitPct), 81, 'hit rate = 40000 / (150+40000+9000) ≈ 81%');
  assert.equal(u.durationMs, 300000, 'wall-clock = T1 − T0 (5 min)');
  assert.deepEqual(
    core.sessionUsage(cwd, 'missing'),
    { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, hitPct: null, durationMs: 0 },
    'absent transcript → zeros (hitPct null, not a fake 0%), never throws'
  );
});

test('metrics: sessionUsage cursor — appends parse incrementally, a pending tail line counts once, a shrink rescans (0.8.6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'usageCursor';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, S + '.jsonl');
  const line = (id, usage, ts) =>
    JSON.stringify({ timestamp: ts, message: { role: 'assistant', id, usage, content: [] } });
  const T0 = '2026-07-15T10:00:00.000Z';
  const T1 = '2026-07-15T10:05:00.000Z';

  fs.writeFileSync(file, line('m1', { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }, T0) + '\n');
  let u = core.sessionUsage(cwd, S);
  assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheCreation], [10, 20, 30, 40], 'first scan');

  // Append half a line (no newline): a mid-write record must not count or corrupt the totals.
  const m2 = line('m2', { input_tokens: 1, output_tokens: 2 }, T1);
  fs.appendFileSync(file, m2.slice(0, 25));
  u = core.sessionUsage(cwd, S);
  assert.equal(u.input, 10, 'partial (unparseable) tail line is not counted yet');

  // Complete it — still without a trailing newline: a complete-but-unterminated tail counts (peek)…
  fs.appendFileSync(file, m2.slice(25));
  u = core.sessionUsage(cwd, S);
  assert.equal(u.input, 11, 'complete-but-unterminated tail line counts');
  assert.equal(u.durationMs, 300000, 'peeked tail extends the wall-clock');

  // …and exactly once after its newline lands and the cursor folds it in.
  fs.appendFileSync(file, '\n');
  u = core.sessionUsage(cwd, S);
  assert.deepEqual([u.input, u.output], [11, 22], 'tail folded into the cursor once, never doubled');

  // A same-id line arriving in a LATER append is still deduped — `seen` persists across deltas.
  fs.appendFileSync(file, line('m2', { input_tokens: 1, output_tokens: 2 }, T1) + '\n');
  u = core.sessionUsage(cwd, S);
  assert.deepEqual([u.input, u.output], [11, 22], 'duplicate message id across appends counted once');

  // Unchanged file: the repeat call is a pure stat() hit with identical results.
  assert.deepEqual(core.sessionUsage(cwd, S), u, 'no-change call returns the same totals');

  // Shrink (transcript replaced): the stale cursor is discarded and the file rescans from byte 0.
  fs.writeFileSync(file, line('m9', { input_tokens: 5, output_tokens: 6 }, T0) + '\n');
  u = core.sessionUsage(cwd, S);
  assert.deepEqual([u.input, u.output, u.cacheRead], [5, 6, 0], 'shrunken file rescanned from scratch');
});

test('workflows: parseWorkflows reads the rich state file as PRIMARY — informative name/summary, real phaseTitles, per-agent label/phase, state-preferred tokens/time + transcript edits, phaseGroups (0.8.0 r2)', () => {
  freshHome();
  const S = 'wfstate';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), ''); // main transcript must exist (findTranscript/findSubagentsDir)
  const sessDir = path.join(proj, S);
  const wfDir = path.join(sessDir, 'subagents', 'workflows', 'wf_rich'); // transcripts live under subagents/ (for edits)
  fs.mkdirSync(wfDir, { recursive: true });
  // The rich per-run state file — SIBLING of subagents/ — is the PRIMARY source (no script needed).
  const stateDir = path.join(sessDir, 'workflows');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'wf_rich.json'),
    JSON.stringify({
      workflowName: 'Editors R2',
      summary: 'Ship the round-2 editor upgrade across both IDEs',
      phases: [{ title: 'Implement', detail: 'code + model' }, { title: 'Verify', detail: 'build + tests' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 0, title: 'Implement' },
        { type: 'workflow_agent', label: 'S11-vscode', phaseTitle: 'Implement', phaseIndex: 0, agentId: 'imp1', tokens: 500, toolCalls: 10, state: 'completed', durationMs: 30000 },
        { type: 'workflow_agent', label: 'S12-jetbrains', phaseTitle: 'Implement', phaseIndex: 0, agentId: 'imp2', tokens: 300, toolCalls: 5, state: 'completed', durationMs: 20000 },
        { type: 'workflow_phase', index: 1, title: 'Verify' },
        { type: 'workflow_agent', label: 'S21-vscode', phaseTitle: 'Verify', phaseIndex: 1, agentId: 'ver1', tokens: 200, toolCalls: 3, state: 'completed', durationMs: 10000 },
        { type: 'workflow_agent', label: 'S22-jetbrains', phaseTitle: 'Verify', phaseIndex: 1, agentId: 'ver2', tokens: 100, toolCalls: 2, state: 'running' },
      ],
      totalTokens: 1100,
      totalToolCalls: 20,
      durationMs: 45000,
      status: 'running',
      startTime: '2026-07-15T12:00:00.000Z',
      agentCount: 4,
    })
  );
  // Per-agent transcripts carry the EDITS (never in the state file); their usage DIFFERS from the state
  // tokens so we can prove the state file wins. imp1 edits +1, imp2 +1, ver1 none, ver2 +1/-1.
  fs.writeFileSync(
    path.join(wfDir, 'agent-imp1.jsonl'),
    JSON.stringify({ timestamp: '2026-07-15T12:00:00.000Z', message: { role: 'assistant', id: 'i1', usage: { input_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 99 }, content: [{ type: 'tool_use', id: 'ie1', name: 'Edit', input: { file_path: '/a.ts', old_string: 'a\n', new_string: 'a\nb\n' } }] } })
  );
  fs.writeFileSync(path.join(wfDir, 'agent-imp1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
  fs.writeFileSync(
    path.join(wfDir, 'agent-imp2.jsonl'),
    JSON.stringify({ timestamp: '2026-07-15T12:00:10.000Z', message: { role: 'assistant', id: 'i2', usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 10 }, content: [{ type: 'tool_use', id: 'ie2', name: 'Edit', input: { file_path: '/x.ts', old_string: 'x\n', new_string: 'x\ny\n' } }] } })
  );
  fs.writeFileSync(
    path.join(wfDir, 'agent-ver1.jsonl'),
    JSON.stringify({ timestamp: '2026-07-15T12:00:20.000Z', message: { role: 'assistant', id: 'v1', usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'vr1', name: 'Read', input: { file_path: '/g.ts' } }] } })
  );
  // ver2: two timestamps 5000ms apart → transcript durationMs 5000 (the state entry has NO durationMs → this fallback wins).
  fs.writeFileSync(
    path.join(wfDir, 'agent-ver2.jsonl'),
    [
      { timestamp: '2026-07-15T12:00:30.000Z', message: { role: 'assistant', id: 'v2a', usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 7 }, content: [{ type: 'tool_use', id: 've1', name: 'Edit', input: { file_path: '/p.ts', old_string: 'p\nq\n', new_string: 'p\nr\n' } }] } },
      { message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 've1', is_error: false }] } },
      { timestamp: '2026-07-15T12:00:35.000Z', message: { role: 'assistant', id: 'v2b', usage: { input_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 }, content: [{ type: 'text', text: 'checking' }] } },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n')
  );

  const runs = core.parseWorkflows(cwd, S);
  assert.equal(runs.length, 1, 'one workflow run (discovered from the state file / run dir)');
  const w = runs[0];
  assert.equal(w.id, 'wf_rich');
  assert.equal(w.name, 'Editors R2', 'name from the state file workflowName');
  assert.equal(w.description, 'Ship the round-2 editor upgrade across both IDEs', 'description from the state file summary');
  assert.deepEqual(w.phases, ['Implement', 'Verify'], 'phase titles from state.phases[].title');
  assert.equal(w.agentCount, 4);
  assert.equal(w.tokens, 1100, 'run tokens PREFER the state file totalTokens');
  assert.equal(w.durationMs, 45000, 'run durationMs PREFERS the state file (real wall-clock, not a sum of parallel agents)');
  assert.equal(w.edits, 3, 'Σedits from the transcripts = 1 + 1 + 0 + 1');
  assert.equal(w.added, 3, 'Σadded = 1 + 1 + 0 + 1');
  assert.equal(w.removed, 1, 'Σremoved = 0 + 0 + 0 + 1');
  // sparkline: a 20-bin activity histogram summing to one tick per counted assistant turn across all agents
  // (imp1 i1, imp2 i2, ver1 v1, ver2 v2a+v2b = 5) — the same mini-chart shape the fleet rows use.
  assert.equal(Array.isArray(w.sparkline) && w.sparkline.length, 20, 'sparkline is a 20-bin array');
  assert.equal(w.sparkline.reduce((n, x) => n + x, 0), 5, 'sparkline tick total = assistant turns across all agents');
  assert.equal(w.running, true, 'running = status !== completed AND fresh (agent transcripts just written)');
  assert.deepEqual(
    w.phaseGroups,
    [{ title: 'Implement', done: 2, total: 2 }, { title: 'Verify', done: 1, total: 2 }],
    'phaseGroups group agents by REAL phaseTitle, per-phase done/total, in phase order'
  );

  // Regression (0.8.0): a state file that still says status:'running' but whose run has gone STALE (an
  // interrupted/killed run never writes 'completed') must NOT report running — else long-dead runs show
  // "running" forever. Backdate every agent transcript + the state file well past FLEET_ACTIVE_MS.
  const stale = Date.now() / 1000 - 3600; // 1h ago, in seconds (utimesSync takes seconds)
  for (const f of fs.readdirSync(wfDir)) if (f.endsWith('.jsonl')) fs.utimesSync(path.join(wfDir, f), stale, stale);
  fs.utimesSync(path.join(stateDir, 'wf_rich.json'), stale, stale);
  const staleRuns = core.parseWorkflows(cwd, S);
  assert.equal(staleRuns[0].running, false, 'a status:running but long-stale run is NOT reported running (killed/interrupted)');

  const imp1 = w.agents.find((x) => x.agentId === 'imp1');
  assert.equal(imp1.label, 'S11-vscode', 'per-agent label from the state file');
  assert.equal(imp1.phase, 'Implement', 'per-agent phase is the REAL phaseTitle, not a hash');
  assert.equal(imp1.tokens, 500, 'per-agent tokens PREFER the state file (500), not the transcript usage (999)');
  assert.equal(imp1.durationMs, 30000, 'per-agent durationMs PREFERS the state file entry');
  assert.deepEqual([imp1.edits, imp1.added, imp1.removed], [1, 1, 0], 'per-agent edits/±lines from the transcript');
  assert.equal(imp1.done, true, 'state completed → done');
  assert.equal(imp1.agentType, 'workflow-subagent', 'agentType still from the sidecar');

  const ver2 = w.agents.find((x) => x.agentId === 'ver2');
  assert.equal(ver2.label, 'S22-jetbrains');
  assert.equal(ver2.phase, 'Verify');
  assert.equal(ver2.tokens, 100, 'state tokens preferred');
  assert.equal(ver2.durationMs, 5000, 'no state durationMs on this entry → the transcript wall-clock fills in');
  assert.deepEqual([ver2.edits, ver2.added, ver2.removed], [1, 1, 1], 'ver2 edit +1/-1 from the transcript');
  assert.equal(ver2.done, false, 'state running → not done');
});

test('subagents: editId linking attributes a within-window subagent edit, without cross-attributing the main chain (S5, §6)', () => {
  freshHome();
  const S = 'link-window';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const AG = 'agentwindow01';
  const F = path.join(cwd, 'shared.ts');
  const T_MAIN = 1_700_000_000_000; // main edits F first
  const T_SUB = 1_700_000_060_000; // the subagent edits F a minute later — DISJOINT windows
  // main transcript: spawns the subagent + one main-chain Edit on F (at T_MAIN).
  const main = [
    { timestamp: T_MAIN, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'sp1', name: 'Agent', input: { description: 'edit shared', subagent_type: 'worker' } },
      { type: 'tool_use', id: 'm1', name: 'Edit', input: { file_path: F } },
    ] } },
    { timestamp: T_SUB, toolUseResult: { status: 'completed', agentId: AG },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'sp1', is_error: false }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), main);
  // subagent transcript: one Edit on the SAME file, inside its own (later) window.
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subtx = [
    { isSidechain: true, agentId: AG, sessionId: S, timestamp: T_SUB, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 's1', name: 'Edit', input: { file_path: F } },
    ] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(subDir, `agent-${AG}.jsonl`), subtx);
  // store: two records for F under the ONE parent session — main's at T_MAIN, the subagent's at T_SUB.
  core.ensureStore(S);
  const b = core.writeBlob(S, Buffer.from('v1\n'));
  const rMain = core.appendLog(S, { ts: T_MAIN, tool: 'Edit', file: F, beforeBlob: null, afterBlob: b, status: 'pending' });
  const rSub = core.appendLog(S, { ts: T_SUB, tool: 'Edit', file: F, beforeBlob: b, afterBlob: core.writeBlob(S, Buffer.from('v2\n')), status: 'pending' });

  // main chain links only the record in its OWN window; never the subagent-window record.
  const acts = core.parseActions(cwd, S);
  const mainEdit = acts.find((a) => a.category === 'edit');
  assert.equal(mainEdit.editId, rMain.id, 'main-chain edit links to the record in its window');
  assert.ok(!acts.some((a) => a.editId === rSub.id), 'main chain never consumes the subagent-window record');

  // the subagent links the within-window record; never the main-chain record (linking is no longer a no-op).
  const subs = core.parseSubagents(cwd, S);
  assert.equal(subs.length, 1, 'one subagent found');
  const subEdit = subs[0].actions.find((a) => a.category === 'edit');
  assert.equal(subEdit.editId, rSub.id, 'subagent edit links to its within-window store record');
  assert.notEqual(subEdit.editId, rMain.id, 'subagent never cross-attributes the main-chain record');
});

test('subagents: interleaved same-file main-chain/subagent edits (overlapping windows) leave BOTH editIds null — never cross-attributed (S5, §6)', () => {
  freshHome();
  const S = 'link-overlap';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const AG = 'agentoverlap01';
  const F = path.join(cwd, 'hot.ts');
  const T1 = 1_700_000_000_000; // main edit #1
  const T2 = 1_700_000_030_000; // subagent edit — BETWEEN the two main edits, so the windows overlap
  const T3 = 1_700_000_060_000; // main edit #2
  const main = [
    { timestamp: T1, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'sp1', name: 'Agent', input: { description: 'touch hot', subagent_type: 'worker' } },
      { type: 'tool_use', id: 'm1', name: 'Edit', input: { file_path: F } },
    ] } },
    { timestamp: T3, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'm2', name: 'Edit', input: { file_path: F } },
    ] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), main);
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subtx = [
    { isSidechain: true, agentId: AG, sessionId: S, timestamp: T2, message: { role: 'assistant', content: [
      { type: 'tool_use', id: 's1', name: 'Edit', input: { file_path: F } },
    ] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(subDir, `agent-${AG}.jsonl`), subtx);
  // three store records for F, interleaved main/subagent/main under the one parent session.
  core.ensureStore(S);
  const b0 = core.writeBlob(S, Buffer.from('a\n'));
  const b1 = core.writeBlob(S, Buffer.from('b\n'));
  const b2 = core.writeBlob(S, Buffer.from('c\n'));
  core.appendLog(S, { ts: T1, tool: 'Edit', file: F, beforeBlob: null, afterBlob: b0, status: 'pending' });
  core.appendLog(S, { ts: T2, tool: 'Edit', file: F, beforeBlob: b0, afterBlob: b1, status: 'pending' });
  core.appendLog(S, { ts: T3, tool: 'Edit', file: F, beforeBlob: b1, afterBlob: b2, status: 'pending' });

  // main's window [T1,T3] straddles the subagent's [T2,T2] → cannot partition → every side null.
  const mainEdits = core.parseActions(cwd, S).filter((a) => a.category === 'edit');
  assert.equal(mainEdits.length, 2, 'two interleaved main-chain edits on F');
  assert.ok(mainEdits.every((a) => a.editId === undefined), 'ambiguous overlap → main-chain edits stay unassigned');
  const subEdit = core.parseSubagents(cwd, S)[0].actions.find((a) => a.category === 'edit');
  assert.equal(subEdit.editId, undefined, 'ambiguous overlap → subagent edit stays unassigned (never cross-attributed)');
});

test('fleet: listSiblings lists project sessions with status/pending/files/risk (read-only, path-only) (0.7.0)', () => {
  freshHome();
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const SELF = 'self1', SIB = 'sib1';
  fs.writeFileSync(path.join(proj, SELF + '.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [] } }));
  // sibling ran a destructive Bash command (for the risk flag) — lives in its transcript, not the store.
  fs.writeFileSync(
    path.join(proj, SIB + '.jsonl'),
    JSON.stringify({ timestamp: '2026-07-13T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'rm -rf build' } }] } })
  );
  const F1 = path.join(cwd, 'a.ts'), F2 = path.join(cwd, 'b.ts');
  seedEdit(SIB, F1, null, 'x\n'); // sibling store edits (both pending)
  seedEdit(SIB, F2, null, 'y\n');

  const list = core.listSiblings(cwd, SELF);
  assert.equal(list.length, 2, 'both project sessions listed');
  const self = list.find((s) => s.id === SELF);
  const sib = list.find((s) => s.id === SIB);
  assert.ok(self.self && !sib.self, 'self flagged; sibling not');
  assert.equal(sib.pending, 2, 'sibling pending count from the store');
  assert.equal(sib.edits, 2);
  assert.ok(sib.files.includes(F1) && sib.files.includes(F2), 'files touched listed');
  assert.ok(sib.risk.total >= 1 && sib.risk.high >= 1, "sibling's rm -rf flagged as high risk");
  assert.ok(sib.active, 'a just-written transcript is active');
  const sum = core.summarizeFleet(list);
  assert.equal(sum.total, 2);
  assert.equal(sum.siblings, 1);
  assert.equal(sum.pending, 2, 'pending counts siblings only (excludes self)');
  const ids = core.projectSessionIds(cwd);
  assert.ok(ids.includes(SELF) && ids.includes(SIB), 'cheap sibling-id enumeration finds both');
});

test('metrics: sessionMetrics rolls up ±lines, actions, subagents, and tool latency (0.7.0)', () => {
  freshHome();
  const S = 'met';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const F = path.join(cwd, 'm.ts');
  seedEdit(S, F, null, 'a\nb\nc\n'); // #1 create: +3
  seedEdit(S, F, 'a\nb\nc\n', 'a\n'); // #2: −2
  const main = [
    { timestamp: '2026-07-13T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: F } }] } },
    { timestamp: '2026-07-13T10:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false }] } }, // 2s
    { timestamp: '2026-07-13T10:00:10.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu2', name: 'Write', input: { file_path: F } }] } },
    { timestamp: '2026-07-13T10:00:14.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: false }] } }, // 4s
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), main);

  const m = core.sessionMetrics(cwd, S);
  // DISPLAY units since 0.9.0, like every other count in the product. These two records form a perfect
  // chain (#2 rewrites what #1 produced), so they are ONE thing to review, and its delta is the chain's
  // NET effect — a file created with one line — not the sum of the intermediate steps. Counting the raw
  // records here is what made Stats disagree with the Overview about the same session.
  assert.equal(m.edits.count, 1, 'the chained pair is one review unit');
  assert.equal(m.edits.added, 1, 'and its ±lines are the net effect of the chain');
  assert.equal(m.edits.removed, 0);
  assert.equal(m.edits.pending, 1, 'pending counts review units too — one thing is awaiting a verdict');
  assert.equal(m.actions.total, 2, 'two tool calls in the main transcript');
  assert.equal(m.subagents.count, 0, 'no subagents in this session');
  assert.equal(m.toolLatency.count, 2, 'two measurable tool latencies');
  assert.equal(m.toolLatency.medianMs, 2000, 'median of the 2s/4s gaps');
  assert.equal(m.toolLatency.maxMs, 4000, 'max latency = the 4s gap');
});

test('changemap: rolls edits into per-file/per-module rows + strict task attribution', () => {
  freshHome();
  const S = 'cmap';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });

  const A = path.join(cwd, 'packages', 'core', 'src', 'a.ts');
  const B = path.join(cwd, 'packages', 'core', 'src', 'b.ts');
  const C = path.join(cwd, 'packages', 'core', 'src', 'c.ts');
  const PKG = path.join(cwd, 'packages', 'core', 'pkg.json'); // parent `packages/core` — same label as /src
  const D = path.join(cwd, 'docs', 'x.md');
  const E = path.join(cwd, 'docs', 'y.md');
  fs.mkdirSync(path.dirname(A), { recursive: true });
  fs.mkdirSync(path.dirname(D), { recursive: true });
  fs.writeFileSync(A, 'class Foo {\n  go() {}\n}\n');
  fs.writeFileSync(B, 'p\nq\n');
  fs.writeFileSync(C, 'z\nw\n');
  fs.writeFileSync(PKG, '{\n  "x": 1\n}\n');
  fs.writeFileSync(D, 'hi\nthere\n');
  fs.writeFileSync(E, 'yo\nmore\n');
  const id1 = seedEdit(S, A, null, 'class Foo {\n  go() {}\n}\n'); // #1 ts=1000 create: +3, stays pending
  const id2 = seedEdit(S, B, 'p\n', 'p\nq\n'); // #2 ts=2000: +1
  const id3 = seedEdit(S, D, 'hi\n', 'hi\nthere\n'); // #3 ts=3000: +1
  const id4 = seedEdit(S, C, 'z\n', 'z\nw\n'); // #4 ts=4000: +1
  const id5 = seedEdit(S, PKG, 'a\n', 'a\nb\nc\n'); // #5 ts=5000: +2 (packages/core root, no /src)
  const id6 = seedEdit(S, E, 'yo\n', 'yo\nmore\n'); // #6 ts=6000: +1
  core.setStatus(S, id2, 'kept');
  core.setStatus(S, id3, 'kept');
  core.setStatus(S, id4, 'undone');
  // id1, id5, id6 stay pending

  // Three TodoWrite checkpoints define the in_progress timeline:
  //   [0..3500)  "Scaffold" — the first span is extended back to the session start
  //   [3500..5500) "Ship it"
  //   [5500..∞)  nothing in progress — a genuine gap
  const main = [
    { timestamp: new Date(1500).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [
        { content: 'Scaffold the map', status: 'in_progress' },
        { content: 'Ship it', status: 'pending' }] } }] } },
    { timestamp: new Date(3500).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [
        { content: 'Scaffold the map', status: 'completed' },
        { content: 'Ship it', status: 'in_progress' }] } }] } },
    { timestamp: new Date(5500).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [
        { content: 'Scaffold the map', status: 'completed' },
        { content: 'Ship it', status: 'completed' }] } }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), main);

  const m = core.buildChangeMap(cwd, S, { root: cwd });

  // --- per-file rollup (churn-desc, ties broken by path so the order is deterministic) ---
  assert.equal(m.files.length, 6, 'one row per touched file');
  assert.deepEqual(m.files.map((f) => f.file), ['a.ts', 'pkg.json', 'x.md', 'y.md', 'b.ts', 'c.ts'], 'churn-desc, then rel');
  const a = m.files[0];
  assert.equal(a.churn, 3, 'churn = added+removed (a 3-line create)');
  assert.equal(a.maxId, id1, 'maxId is the drill-through target — what a click opens');
  assert.equal(a.moduleLabel, 'core', 'core pre-renders the label so no front-end re-derives it');
  assert.deepEqual(a.classes, ['Foo'], 'the edit is attributed to the class it landed in');

  // --- worst-unreviewed-wins status precedence (pending > undone > kept) ---
  assert.equal(a.status, 'pending', 'a pending edit makes its file read pending');
  assert.equal(m.files.find((f) => f.file === 'b.ts').status, 'kept', 'all-kept file reads kept');
  assert.equal(m.files.find((f) => f.file === 'c.ts').status, 'undone', 'undone outranks kept, loses to pending');
  assert.equal(core.fileStatus({ pending: 1, undone: 9 }), 'pending', 'pending outranks undone');
  assert.equal(core.fileStatus({ pending: 0, undone: 1 }), 'undone', 'undone outranks kept');
  assert.equal(core.fileStatus({ pending: 0, undone: 0 }), 'kept', 'nothing outstanding reads kept');

  // --- per-module rollup: buckets group by LABEL, so packages/core/src + packages/core MERGE (0.7.6) ---
  assert.equal(m.modules.length, 2, 'two module labels (core, docs) — NOT one row per raw parent dir');
  assert.equal(m.modules.filter((x) => x.label === 'core').length, 1, 'packages/core/src and packages/core fold into ONE core segment');
  const core_ = m.modules[0];
  assert.equal(core_.label, 'core', 'packages/ prefix and /src suffix stripped');
  assert.equal(core_.module, 'core', 'a module row is identified by its label (module === label)');
  assert.equal(core_.churn, 7, 'core churn sums a.ts(3)+b.ts(1)+c.ts(1)+pkg.json(2)');
  assert.equal(core_.files, 4, 'all four core files (incl. the packages/core root file) roll into one segment');
  assert.equal(core_.status, 'pending', 'a pending descendant makes the module read pending');
  assert.equal(m.modules[1].label, 'docs', 'a root-level dir keeps its own name');
  const sum = (rows) => rows.reduce((n, r) => n + r.churn, 0);
  assert.equal(sum(m.files), sum(m.modules), 'churn is conserved from files up to modules');

  // --- strict per-task attribution: no edge fill, ever ---
  const ch0 = core.taskId('Scaffold the map', 0); // stable content-hash key replaced positional `ch0` (0.8.0 S6)
  const ch1 = core.taskId('Ship it', 0);
  const e1 = m.edits.find((e) => e.id === id1);
  assert.equal(e1.taskId, null, 'strict spans never force-file a pre-first-flip edit onto the head task');
  const e6 = m.edits.find((e) => e.id === id6);
  assert.equal(e6.taskId, null, 'strict spans never widen — a trailing gap edit is unassigned');
  assert.ok(!('subtasks' in m), 'the display-subtask layer is gone (0.8.8) — no subtasks key');
  assert.ok(!('subtask' in m.edits[0]), 'edits carry strict taskId attribution only');

  // --- taskEditIds: the strict review-op set, in capture order ---
  assert.deepEqual(core.taskEditIds(cwd, S, ch0), [id2, id3], 'Scaffold strictly holds edits #2/#3 (never #1)');
  assert.deepEqual(core.taskEditIds(cwd, S, ch1), [id4, id5], 'Ship strictly holds edits #4/#5 (never the trailing #6)');
  assert.equal(typeof m.summary.title, 'string', 'summary.title is the human-readable session name (empty string when unknown)');

  // --- 0.8.0 fix: tasks[] (strict-span identities) unify the taskId space (rollupByTask + tasklog join) ---
  // Regression for the disjoint-id-space defect: subtasks (latest plan) and rollupByTask (strict spans)
  // used to key differently, so tasklog content came up empty. tasks[] is the shared join+label source.
  const shipId = core.taskId('Ship it', 0); // firstSeenTs is not hashed, so 0 matches the real id
  const scaffoldId = core.taskId('Scaffold the map', 0);
  const taskIds = new Set(m.tasks.map((t) => t.taskId));
  assert.ok(taskIds.has(shipId) && taskIds.has(scaffoldId), 'tasks[] holds both strict-span task identities');
  assert.equal(m.tasks.find((t) => t.taskId === shipId).content, 'Ship it', 'tasks[] carries the to-do text — the tasklog/ribbon label');
  const attributed = m.rollupByTask.filter((r) => r.taskId !== null);
  assert.equal(attributed.length, 2, 'edits #2/#3 → Scaffold, #4/#5 → Ship (strict intervals)');
  for (const r of attributed) assert.ok(taskIds.has(r.taskId), `rollupByTask id ${r.taskId} joins tasks[] (unified id space)`);
  assert.equal(m.rollupByTask.find((r) => r.taskId === shipId).edits, 2, 'Ship it rolls up its two strict-span edits');
  assert.ok(m.rollupByTask.some((r) => r.taskId === null), 'the explicit unassigned bucket (edits #1/#6) survives');

  // --- module labels ---
  assert.equal(core.moduleLabel(''), '(root)', 'a root-level file');
  assert.equal(core.moduleLabel('../elsewhere'), '(external)', 'edited outside the workspace');
  assert.equal(core.moduleLabel('packages/vscode/src'), 'vscode', 'monorepo noise stripped');
  assert.equal(core.moduleLabel('packages/vscode'), 'vscode', 'the src-less sibling shares the label (why they merge)');
  assert.equal(core.moduleLabel('test'), 'test', 'an ordinary dir is left alone');
});

// --- S1: single-writer id hazard (§2.7) ---

test('store: concurrent appendLog from separate processes → no duplicate EFFECTIVE ids (S1 in-lock alloc)', async () => {
  const home = freshHome();
  const S = 'concurrent';
  core.ensureStore(S); // storeDir must exist before the child writers open the lock/log
  const DIST = path.resolve(__dirname, '../dist/index.js');
  const N = 8;
  // Each child appends exactly one record for the SAME session, launched in parallel to contend on
  // the append lock. In-lock id allocation (+ read-time reconciliation of any residual unlocked
  // collision) must yield N distinct effective ids and N distinct uids.
  const script =
    `const c=require(${JSON.stringify(DIST)});` +
    `c.appendLog(${JSON.stringify(S)},{ts:Date.now(),tool:'Edit',file:'/w/'+process.argv[1]+'.txt',beforeBlob:null,afterBlob:null,status:'pending'});`;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const children = [];
  for (let i = 0; i < N; i++) children.push(cp.spawn(process.execPath, ['-e', script, String(i)], { env }));
  await Promise.all(
    children.map(
      (ch) =>
        new Promise((res, rej) => {
          let err = '';
          ch.stderr.on('data', (d) => (err += d));
          ch.on('error', rej);
          ch.on('exit', (code) => (code === 0 ? res() : rej(new Error(`child exited ${code}: ${err}`))));
        })
    )
  );
  const log = core.readLog(S);
  assert.equal(log.length, N, 'every concurrent writer landed exactly one record');
  assert.equal(new Set(log.map((r) => r.id)).size, N, 'no duplicate EFFECTIVE ids across concurrent writers');
  assert.equal(new Set(log.map((r) => r.uid)).size, N, 'every record carries a distinct uid');
});

test('store: a forced unlocked-append duplicate id is reconciled on read — byId/status/undo stay correct (S1)', () => {
  freshHome();
  const S = 'dup';
  const W = tmpWork();
  const Fa = path.join(W, 'a.txt');
  const Fb = path.join(W, 'b.txt');
  const Fc = path.join(W, 'c.txt');
  fs.writeFileSync(Fa, 'a2\n');
  fs.writeFileSync(Fb, 'b2\n');
  fs.writeFileSync(Fc, 'c2\n');
  const id1 = seedEdit(S, Fa, 'a1\n', 'a2\n'); // 1
  const id2 = seedEdit(S, Fb, 'b1\n', 'b2\n'); // 2
  assert.deepEqual([id1, id2], [1, 2], 'clean serial ids');

  // Simulate the §2.7 residual race: a record hits disk reusing #2's display id for a DIFFERENT file —
  // exactly what two writers that both failed the append lock would produce.
  const bc = core.writeBlob(S, Buffer.from('c1\n'));
  const ac = core.writeBlob(S, Buffer.from('c2\n'));
  fs.appendFileSync(
    core.logPath(S),
    JSON.stringify({ id: 2, uid: 'forced-dup', ts: 9000, tool: 'Edit', file: Fc, beforeBlob: bc, afterBlob: ac, status: 'pending' }) + '\n'
  );

  // readLog reconciles: three distinct records; the LATER duplicate is re-keyed above every raw id.
  const log = core.readLog(S);
  assert.equal(log.length, 3, 'all three records survive');
  assert.equal(new Set(log.map((r) => r.id)).size, 3, 'no duplicate EFFECTIVE ids after reconciliation');
  assert.equal(log.find((r) => r.file === Fc).id, 3, 'the later duplicate was re-keyed to a fresh id above all raw ids');
  assert.equal(log.find((r) => r.file === Fb).id, 2, 'the original #2 kept its display id');
  assert.equal(core.nextId(S), 4, 'nextId counts the re-keyed id, so a new append cannot re-collide');

  // byId + status: a status op on the re-key targets ONLY the re-keyed record, never the original #2.
  core.setStatus(S, 3, 'kept');
  assert.equal(core.findRecord(S, 3).status, 'kept', 're-key #3 flipped');
  assert.equal(core.findRecord(S, 2).status, 'pending', 'original #2 untouched by a status op on the re-key');
  core.setStatus(S, 2, 'undone');
  assert.equal(core.findRecord(S, 2).status, 'undone', 'original #2 flipped independently');
  assert.equal(core.findRecord(S, 3).status, 'kept', 're-key #3 unchanged by the op on #2');

  // undo targeting: undo the re-keyed record → ITS file reverts; the sibling file is untouched.
  const res = core.undoEdit(S, 3);
  assert.ok(res.ok, 'undo #3 succeeded: ' + res.message);
  assert.equal(fs.readFileSync(Fc, 'utf8'), 'c1\n', 'the re-keyed edit reverted its OWN file');
  assert.equal(fs.readFileSync(Fa, 'utf8'), 'a2\n', 'sibling #1 file untouched by undo of the re-key');
  assert.equal(core.findRecord(S, 3).status, 'undone', 'undo marked the re-key undone');
  assert.equal(core.findRecord(S, 2).status, 'undone', 'original #2 remains undone, not double-touched');
});

// --- S2: git-free worktree resolver (session.ts) -----------------------------------------------
// Fixtures are hand-built from git's on-disk formats (verified against real `git worktree add` /
// `git init --bare`), so the tests stay git-free and hermetic — no git binary, no network.

const BARE_FALSE = '[core]\n\tbare = false\n';
const BARE_TRUE = '[core]\n\tbare = true\n';

test('session: repoRoot walks up from a subdir launch to the nearest .git', () => {
  const root = tmpWork();
  fs.mkdirSync(path.join(root, '.git')); // dir-.git (a main working tree)
  const foo = path.join(root, 'packages', 'foo');
  fs.mkdirSync(foo, { recursive: true });
  assert.equal(core.repoRoot(foo), root, 'walks up from packages/foo to the repo root');
  assert.equal(core.repoRoot(root), root, 'at the root itself');
  assert.equal(core.repoRoot(tmpWork()), null, 'no .git anywhere up the tree → null');
});

test('session: commonDir for a main working tree (dir-.git) returns realpath of .git', () => {
  const root = tmpWork();
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, 'config'), BARE_FALSE);
  const sub = path.join(root, 'sub', 'deep');
  fs.mkdirSync(sub, { recursive: true });
  const key = fs.realpathSync(gitDir);
  assert.equal(core.commonDir(root), key, 'main tree resolves to realpath(.git)');
  assert.equal(core.commonDir(sub), key, 'subdir launch resolves to the same key');
});

test('session: commonDir resolves a linked worktree (relative commondir) to the shared .git', () => {
  const base = tmpWork();
  const main = path.join(base, 'main');
  const gitDir = path.join(main, '.git');
  const admin = path.join(gitDir, 'worktrees', 'wtA');
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), BARE_FALSE);
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n'); // relative → resolves to main/.git
  const wt = path.join(base, 'wtA');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
  const key = fs.realpathSync(gitDir);
  assert.equal(core.commonDir(wt), key, 'linked worktree resolves to the shared common dir');
  assert.equal(core.commonDir(main), key, 'main tree resolves to the SAME key (siblings group together)');
  const wtsub = path.join(wt, 'packages', 'x');
  fs.mkdirSync(wtsub, { recursive: true });
  assert.equal(core.commonDir(wtsub), key, 'subdir launch inside the worktree still groups');
});

test('session: commonDir handles an absolute commondir (used as-is, not joined against admin dir)', () => {
  const base = tmpWork();
  const shared = path.join(base, 'shared.git');
  fs.mkdirSync(shared, { recursive: true });
  fs.writeFileSync(path.join(shared, 'config'), BARE_FALSE);
  const admin = path.join(base, 'admin', 'wtB'); // admin dir NOT under `shared`, so a wrong join would miss
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(admin, 'commondir'), shared + '\n'); // ABSOLUTE common path
  const wt = path.join(base, 'wtB');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
  assert.equal(core.commonDir(wt), fs.realpathSync(shared), 'absolute commondir used as-is');
});

test('session: commonDir collapses symlinks via realpath (both sides match)', () => {
  const base = tmpWork();
  const real = path.join(base, 'real');
  const gitDir = path.join(real, '.git');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), BARE_FALSE);
  const link = path.join(base, 'link');
  fs.symlinkSync(real, link); // link → real
  assert.equal(core.commonDir(link), core.commonDir(real), 'symlinked cwd resolves to the same key');
  assert.equal(core.commonDir(link), fs.realpathSync(gitDir), 'key is realpath-collapsed');
});

test('session: commonDir guards the bare-repo edge (returns null)', () => {
  const base = tmpWork();
  const bare = path.join(base, 'bare.git');
  const admin = path.join(bare, 'worktrees', 'wtC');
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(bare, 'config'), BARE_TRUE);
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n'); // → bare dir itself
  const wt = path.join(base, 'wtC');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${admin}\n`);
  assert.equal(core.commonDir(wt), null, 'a worktree whose common dir is bare (config bare=true) → null');
  assert.equal(core.commonDir(bare), null, 'launching inside the bare dir (no .git child) → null');
});

test('session: commonDir returns null for a missing / pruned worktree admin dir', () => {
  const base = tmpWork();
  const wt = path.join(base, 'wtD');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(base, 'gone', 'worktrees', 'wtD')}\n`);
  assert.equal(core.commonDir(wt), null, 'gitdir points at a pruned admin dir → null');
  const admin = path.join(base, 'present');
  fs.mkdirSync(admin, { recursive: true }); // admin dir exists but has no `commondir` file
  const wt2 = path.join(base, 'wtE');
  fs.mkdirSync(wt2);
  fs.writeFileSync(path.join(wt2, '.git'), `gitdir: ${admin}\n`);
  assert.equal(core.commonDir(wt2), null, 'admin dir without a commondir file → null');
});

test('session: repoKeyForSession memoizes by sessionId (key survives worktree pruning)', () => {
  const root = tmpWork();
  const gitDir = path.join(root, '.git');
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(gitDir, 'config'), BARE_FALSE);
  const key = fs.realpathSync(gitDir);
  const sid = 'sess-cache-' + Date.now() + '-' + Math.random();
  assert.equal(core.repoKeyForSession(sid, root), key, 'first resolve returns the key');
  fs.rmSync(gitDir, { recursive: true, force: true }); // prune the repo on disk
  assert.equal(core.commonDir(root), null, 'commonDir is now null after pruning');
  assert.equal(core.repoKeyForSession(sid, root), key, 'cached key survives the pruning');
});

test('session: firstCwdLine returns the first line bearing cwd, skipping leading metadata', () => {
  const dir = tmpWork();
  const f = path.join(dir, 't.jsonl');
  const lines = [
    JSON.stringify({ type: 'queue-operation', sessionId: 'S9' }), // no cwd (line 0 is not guaranteed)
    JSON.stringify({ type: 'queue-operation', sessionId: 'S9' }), // no cwd
    'not json at all', // tolerated: skipped, not thrown
    JSON.stringify({ type: 'user', cwd: '/Users/x/proj', sessionId: 'S9', gitBranch: 'feat/z' }),
    JSON.stringify({ type: 'user', cwd: '/other', sessionId: 'S9', gitBranch: 'main' }), // must NOT win
  ];
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.deepEqual(core.firstCwdLine(f), { cwd: '/Users/x/proj', sessionId: 'S9', gitBranch: 'feat/z' });
  assert.equal(core.firstCwdLine(path.join(dir, 'nope.jsonl')), null, 'missing file → null');
  fs.writeFileSync(path.join(dir, 'empty.jsonl'), '');
  assert.equal(core.firstCwdLine(path.join(dir, 'empty.jsonl')), null, 'empty file → null');
});

test('session: firstCwdLine resolves a cwd line hidden PAST 256KB behind a fat leading line (self-session regression)', () => {
  // Real self-sessions begin with a huge queue-operation line; the first cwd line can sit ~380KB in.
  // A fixed 256KB prefix read used to miss it → the live agent silently dropped from every repo view.
  const dir = tmpWork();
  const f = path.join(dir, 'big.jsonl');
  const fat = JSON.stringify({ type: 'queue-operation', blob: 'x'.repeat(600 * 1024) }); // > 256KB, no cwd
  const cwdLine = JSON.stringify({ type: 'user', cwd: '/Users/x/live', sessionId: 'LIVE', gitBranch: 'main' });
  fs.writeFileSync(f, fat + '\n' + cwdLine + '\n');
  assert.deepEqual(core.firstCwdLine(f), { cwd: '/Users/x/live', sessionId: 'LIVE', gitBranch: 'main' },
    'cwd line past the old 256KB cap must still resolve');
});

// --- S3: repo-scoped worktree siblings + fleet conflicts (fleet.ts) -----------------------------
// Builds on S2's git-free commonDir/firstCwdLine: unions sessions across worktree project dirs and
// intersects the UNCAPPED file sets for cross-agent collisions. Fixtures reuse the S2 on-disk formats.

test('fleet: listRepoSiblings unions two worktree dirs of one repo (excludes an unrelated repo)', () => {
  freshHome();
  const base = tmpWork();
  // Main working tree (dir-.git) + a linked worktree (file-.git → shared commondir) = one repo group.
  const main = path.join(base, 'main');
  const gitDir = path.join(main, '.git');
  const admin = path.join(gitDir, 'worktrees', 'wtA');
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), BARE_FALSE);
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  const wtA = path.join(base, 'wtA');
  fs.mkdirSync(wtA);
  fs.writeFileSync(path.join(wtA, '.git'), `gitdir: ${admin}\n`);
  // An unrelated repo (its own .git) — must NOT be grouped with main/wtA.
  const other = path.join(base, 'other');
  fs.mkdirSync(path.join(other, '.git'), { recursive: true });
  assert.equal(core.commonDir(main), core.commonDir(wtA), 'sanity: main + wtA share a commonDir');
  assert.notEqual(core.commonDir(other), core.commonDir(main), 'sanity: other is a different repo');

  // One session per cwd, each transcript in its own mangled project dir carrying a real cwd line.
  const MAIN = 'wt-main', WTA = 'wt-a', OTHER = 'wt-other';
  const seedSession = (cwd, id, branch) => {
    const dir = core.projectDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.jsonl'), JSON.stringify({ type: 'user', cwd, sessionId: id, gitBranch: branch }) + '\n');
  };
  seedSession(main, MAIN, 'main');
  seedSession(wtA, WTA, 'feat/x');
  seedSession(other, OTHER, 'main');

  const list = core.listRepoSiblings(main, MAIN);
  assert.deepEqual(list.map((s) => s.id).sort(), [WTA, MAIN].sort(), 'both worktree sessions unioned; the unrelated repo excluded');
  const sMain = list.find((s) => s.id === MAIN);
  const sWta = list.find((s) => s.id === WTA);
  assert.ok(sMain.self && !sWta.self, 'querying session flagged self; the sibling worktree is not');
  assert.equal(sMain.worktree, main, 'worktree is the session real launch cwd (main)');
  assert.equal(sWta.worktree, wtA, 'sibling worktree is its own cwd (wtA)');
  assert.equal(sMain.gitBranch, 'main');
  assert.equal(sWta.gitBranch, 'feat/x', 'branch read from the transcript, disambiguating the worktrees');
  assert.equal(sMain.phase, 'idle', 'S4 wires agentPhase in: a session with no tool activity phases as neutral idle');
});

test('fleet: fleetConflicts intersects the UNCAPPED allFiles — catches a sibling 21st shared file', () => {
  freshHome();
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const A = 'busy', B = 'other';
  const emptyTranscript = JSON.stringify({ message: { role: 'assistant', content: [] } }) + '\n';
  fs.writeFileSync(path.join(proj, A + '.jsonl'), emptyTranscript);
  fs.writeFileSync(path.join(proj, B + '.jsonl'), emptyTranscript);
  // Busy agent touches 21 distinct files; file #21 (index 20) is BEYOND the FILE_CAP=20 display slice.
  const files = Array.from({ length: 21 }, (_, i) => path.join(cwd, `f${i}.ts`));
  files.forEach((f, i) => seedEdit(A, f, null, `x${i}\n`));
  const shared = files[20];
  seedEdit(B, shared, null, 'y\n'); // the sibling also edits that 21st file → a real collision

  const list = core.listSiblings(cwd, A);
  const a = list.find((s) => s.id === A);
  assert.equal(a.files.length, 20, 'display list is capped at FILE_CAP');
  assert.equal(a.moreFiles, 1, 'one file elided from the display list');
  assert.equal(a.allFiles.length, 21, 'the uncapped set keeps all 21');
  assert.ok(!a.files.includes(shared), 'the 21st file is NOT in the capped display list');
  assert.ok(a.allFiles.includes(shared), 'the 21st file IS in the uncapped intersection set');

  const conflicts = core.fleetConflicts(list);
  assert.equal(conflicts.length, 1, 'exactly one collision — the shared 21st file');
  assert.equal(conflicts[0].file, shared, 'a capped intersection would have silently missed this');
  assert.deepEqual(conflicts[0].agents.sort(), [A, B].sort(), 'both agents named (no winner)');
  assert.ok(conflicts[0].anyPending, 'flagged pending — a live edit could be trampled');
  assert.equal(core.summarizeFleet(list).conflicts, 1, 'summary carries the conflict count');
});

test('fleet: fleetConflicts on disjoint file sets reports no collisions', () => {
  freshHome();
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const A = 'a', B = 'b';
  const t = JSON.stringify({ message: { role: 'assistant', content: [] } }) + '\n';
  fs.writeFileSync(path.join(proj, A + '.jsonl'), t);
  fs.writeFileSync(path.join(proj, B + '.jsonl'), t);
  seedEdit(A, path.join(cwd, 'a.ts'), null, '1\n');
  seedEdit(B, path.join(cwd, 'b.ts'), null, '2\n'); // different file → no overlap
  const list = core.listSiblings(cwd, A);
  assert.deepEqual(core.fleetConflicts(list), [], 'disjoint file sets → no collisions');
  assert.equal(core.summarizeFleet(list).conflicts, 0);
});

test('fleet: fleetConflicts flags a pending overlap with ≥1 ACTIVE holder (reviewed / all-idle do not) (0.8.0)', () => {
  freshHome();
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const A = 'a', B = 'b', C = 'c';
  const fresh = JSON.stringify({ message: { role: 'assistant', content: [] } }) + '\n';
  fs.writeFileSync(path.join(proj, A + '.jsonl'), fresh); // active (just written)
  fs.writeFileSync(path.join(proj, B + '.jsonl'), fresh); // active
  fs.writeFileSync(path.join(proj, C + '.jsonl'), fresh);
  const oldSecs = Date.now() / 1000 - 3600; // 1h ago → beyond FLEET_ACTIVE_MS
  fs.utimesSync(path.join(proj, C + '.jsonl'), oldSecs, oldSecs); // C is INACTIVE

  const live = path.join(cwd, 'live.ts'); // pending in A AND B (both active) → the ONLY live collision
  const reviewed = path.join(cwd, 'reviewed.ts'); // shared by A+B but REVIEWED in both → no live hazard
  const staleShare = path.join(cwd, 'stale.ts'); // pending in A (active) + C (INACTIVE) → not a live overlap
  seedEdit(A, live, null, '1\n');
  seedEdit(B, live, null, '2\n');
  const ra = seedEdit(A, reviewed, null, 'x\n');
  const rb = seedEdit(B, reviewed, null, 'y\n');
  core.setStatus(A, ra, 'kept'); // reviewed → drops out of pendingFiles
  core.setStatus(B, rb, 'undone');
  seedEdit(A, staleShare, null, 'p\n');
  seedEdit(C, staleShare, null, 'q\n');

  const list = core.listSiblings(cwd, A);
  const sa = list.find((s) => s.id === A);
  assert.ok(sa.pendingFiles.includes(live) && sa.pendingFiles.includes(staleShare), 'pendingFiles = A\'s pending distinct files');
  assert.ok(!sa.pendingFiles.includes(reviewed), 'a reviewed (kept) file is NOT in pendingFiles');
  assert.ok(!list.find((s) => s.id === B).pendingFiles.includes(reviewed), 'an undone file is NOT in pendingFiles');

  const conflicts = core.fleetConflicts(list);
  // 0.8.0 stabilization: widened from "both active" — a LIVE agent can trample an idle agent's pending
  // work (>60s without a write is routine for a long think), so active-vs-idle overlaps now flag too,
  // with activeAgents naming the side that's moving. An all-idle overlap still does not flag.
  assert.equal(conflicts.length, 2, 'the both-active file AND the active-vs-idle file both flag');
  const liveC = conflicts.find((k) => k.file === live);
  assert.deepEqual(liveC.agents.sort(), [A, B].sort(), 'both colliding agents named (no winner)');
  assert.deepEqual(liveC.activeAgents.sort(), [A, B].sort(), 'both holders are active here');
  const staleC = conflicts.find((k) => k.file === staleShare);
  assert.ok(staleC, 'a live agent overlapping an IDLE agent\'s pending file is a real hazard — flagged');
  assert.deepEqual(staleC.agents.sort(), [A, C].sort(), 'idle holders stay listed in agents');
  assert.deepEqual(staleC.activeAgents, [A], 'activeAgents names only the moving side (renderers dim the rest)');
  assert.ok(!conflicts.some((k) => k.file === reviewed), 'a historically-shared but REVIEWED file does NOT flag');
  assert.equal(core.summarizeFleet(list).conflicts, 2, 'summary counts both live collisions');

  // An ALL-idle overlap (nobody moving) is not a live hazard — prove it by aging A out too.
  const idleList = list.map((s) => ({ ...s, active: false }));
  assert.equal(core.fleetConflicts(idleList).length, 0, 'no active holder anywhere → nothing flags');
});

test('fleet: conflict detection is path-only — file contents never cross between agents', () => {
  freshHome();
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const A = 'a', B = 'b';
  const t = JSON.stringify({ message: { role: 'assistant', content: [] } }) + '\n';
  fs.writeFileSync(path.join(proj, A + '.jsonl'), t);
  fs.writeFileSync(path.join(proj, B + '.jsonl'), t);
  const F = path.join(cwd, 'secret.ts');
  const SECRET = 'SUPER_SECRET_TOKEN_abc123';
  seedEdit(A, F, null, SECRET + '\n'); // A creates the file with secret content
  seedEdit(B, F, 'stub\n', SECRET + '\n'); // B edits the same file → collision on F
  const list = core.listSiblings(cwd, A);
  const conflicts = core.fleetConflicts(list);
  assert.equal(conflicts.length, 1, 'the shared file collides');
  assert.equal(conflicts[0].file, F, 'the collision names the file PATH');
  assert.deepEqual(Object.keys(conflicts[0]).sort(), ['activeAgents', 'agents', 'anyPending', 'file'], 'no contents field on a collision');
  // The security boundary: nothing the fleet exposes contains any file CONTENTS.
  const exposed = JSON.stringify(conflicts) + JSON.stringify(list);
  assert.ok(!exposed.includes('SUPER_SECRET'), 'no file contents leak into fleet siblings or collisions');
});

// --- S4 (0.8.0): live phase + subagent todos + sidecar --------------------------------------------

// A bare transcript file (no project-dir mangling), optionally mtime-backdated by `ageMs` for staleness.
function writePhaseTranscript(dir, name, records, ageMs) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, records.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))).join('\n') + '\n');
  if (ageMs != null) {
    const d = new Date(Date.now() - ageMs);
    fs.utimesSync(p, d, d);
  }
  return p;
}
const asstToolUse = (id, name, input) => ({ message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: input || {} }] } });
const toolResult = (id, isError) => ({ message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!isError }] } });
const asstEnd = (text) => ({ message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: text || 'Done.' }] } });

test('actions: agentPhase classifies working / awaiting-input / awaiting-permission / errored / idle / done', () => {
  freshHome();
  const dir = tmpWork();

  // working: a trailing tool_use awaiting its result, fresh mtime.
  const working = writePhaseTranscript(dir, 'working.jsonl', [asstToolUse('t1', 'Bash', { command: 'npm test' })]);
  assert.equal(core.agentPhase(working), 'working');
  assert.equal(core.agentPhaseDetail(working).confidence, 'high', 'an active tool_use is structural');

  // awaiting-input: a trailing AskUserQuestion with no result — wins even when the mtime is fresh.
  const input = writePhaseTranscript(dir, 'input.jsonl', [asstToolUse('q1', 'AskUserQuestion', { questions: [{ question: 'which?' }] })]);
  assert.equal(core.agentPhase(input), 'awaiting-input');
  assert.equal(core.agentPhaseDetail(input).confidence, 'high');

  // awaiting-permission: the SAME pending tool_use but stale (a harness permission prompt writes nothing).
  const perm = writePhaseTranscript(dir, 'perm.jsonl', [asstToolUse('t1', 'Bash', { command: 'rm -rf build' })], 60_000);
  const permDetail = core.agentPhaseDetail(perm);
  assert.equal(permDetail.phase, 'awaiting-permission', 'pending tool_use + stale mtime => needs-attention');
  assert.equal(permDetail.confidence, 'heuristic', 'labeled a heuristic, never asserted as certain');

  // errored: the trailing event is an is_error tool_result.
  const errored = writePhaseTranscript(dir, 'errored.jsonl', [asstToolUse('b1', 'Bash', { command: 'x' }), toolResult('b1', true)]);
  assert.equal(core.agentPhase(errored), 'errored');

  // idle: a completed end_turn, fresh mtime.
  const idle = writePhaseTranscript(dir, 'idle.jsonl', [asstToolUse('b1', 'Bash', { command: 'x' }), toolResult('b1', false), asstEnd('All set.')]);
  assert.equal(core.agentPhase(idle), 'idle');

  // working (between steps): a trailing NON-error tool_result with no follow-up yet — the turn is unfinished
  // (a tool_result always obligates an assistant reply), so the agent is mid-turn generating the next step,
  // NOT idle. This is the live-session case: finished one tool, about to issue the next.
  const midStep = writePhaseTranscript(dir, 'midstep.jsonl', [asstToolUse('b1', 'Bash', { command: 'x' }), toolResult('b1', false)]);
  assert.equal(core.agentPhase(midStep), 'working', 'a trailing non-error tool_result is an unfinished turn => working');
  assert.equal(core.agentPhaseDetail(midStep).confidence, 'high', 'a tool_result mandates a follow-up — structural, not a guess');
  // …but the SAME trailing tool_result gone long-stale is an abandoned/crashed turn => done.
  const midStepStale = writePhaseTranscript(dir, 'midstep-stale.jsonl', [asstToolUse('b1', 'Bash', { command: 'x' }), toolResult('b1', false)], 30 * 60_000);
  assert.equal(core.agentPhase(midStepStale), 'done', 'a trailing tool_result gone long-stale => the turn was abandoned mid-flight');

  // done: the same completed turn, but long-stale mtime.
  const done = writePhaseTranscript(dir, 'done.jsonl', [asstToolUse('b1', 'Bash', { command: 'x' }), toolResult('b1', false), asstEnd('All set.')], 30 * 60_000);
  assert.equal(core.agentPhase(done), 'done');

  // A recovered error (agent spoke after the failed result) is NOT errored — only a TRAILING error is.
  const recovered = writePhaseTranscript(dir, 'recovered.jsonl', [asstToolUse('b1', 'Bash', { command: 'x' }), toolResult('b1', true), asstEnd('Recovered.')]);
  assert.equal(core.agentPhase(recovered), 'idle', 'a post-error end_turn recovers to idle, not errored');

  // Missing transcript => neutral idle (never asserts activity for a file that is not there).
  assert.equal(core.agentPhase(path.join(dir, 'nope.jsonl')), 'idle');
});

test('actions: agentPhase tail read is boundary-tolerant (drops a partial leading line past the tail cap)', () => {
  freshHome();
  const dir = tmpWork();
  // A leading record larger than the tail window, so the last-N-bytes read STARTS mid-line; the phase
  // must still resolve from the trailing records (the partial leading fragment is dropped, not parsed).
  const huge = { message: { role: 'assistant', content: [{ type: 'text', text: 'X'.repeat(200000) }] } };
  const p = writePhaseTranscript(dir, 'big.jsonl', [huge, asstToolUse('t9', 'Bash', { command: 'go' })]);
  assert.ok(fs.statSync(p).size > 128 * 1024, 'file exceeds the tail window');
  assert.equal(core.agentPhase(p), 'working', 'trailing tool_use classified despite a mid-file start');
});

test('subagents: subagentTodos extracts the latest TodoWrite + currentTask (in_progress) from the agent file', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'subtodos';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [] } })); // main transcript must exist
  const AG = 'abc123def456';
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const subtx = [
    { isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'stale plan', status: 'pending' }] } }] } },
    { isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
      { content: 'Read the parser', status: 'completed' },
      { content: 'Wire the linker', status: 'in_progress' },
      { content: 'Add a regression test', status: 'pending' },
    ] } }] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(subDir, `agent-${AG}.jsonl`), subtx);

  const r = core.subagentTodos(cwd, S, AG);
  assert.equal(r.todos.length, 3, 'the latest TodoWrite supersedes the earlier one');
  assert.equal(r.currentTask, 'Wire the linker', 'currentTask = the in_progress todo');
  assert.ok(!r.todos.some((t) => t.content === 'stale plan'), 'the superseded list is gone');

  // No in_progress todo => currentTask is null (honest — never falls back to a guess).
  const AG2 = 'noinprog99';
  fs.writeFileSync(
    path.join(subDir, `agent-${AG2}.jsonl`),
    JSON.stringify({ isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'all done', status: 'completed' }] } }] } })
  );
  assert.equal(core.subagentTodos(cwd, S, AG2).currentTask, null, 'nothing in_progress => currentTask null');
  // A subagent with no file at all => empty, not a throw.
  assert.deepEqual(core.subagentTodos(cwd, S, 'ghost'), { todos: [], currentTask: null });
});

test('subagents: an async_launched subagent (no result/status) still reports a LIVE phase from its tail', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'asyncsub';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  // Main transcript spawns the agent but NEVER records a toolUseResult (async_launched: null metrics/status).
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    JSON.stringify({ timestamp: '2026-07-14T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'crunch', subagent_type: 'worker' } }] } })
  );
  const AG = 'live777';
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  // The subagent's own file ends on a tool_use awaiting its result — freshly written => it's WORKING now.
  fs.writeFileSync(
    path.join(subDir, `agent-${AG}.jsonl`),
    JSON.stringify({ isSidechain: true, agentId: AG, sessionId: S, timestamp: '2026-07-14T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'st1', name: 'Bash', input: { command: 'make' } }] } })
  );

  const subs = core.parseSubagents(cwd, S);
  assert.equal(subs.length, 1, 'the async subagent is discovered from its own file');
  const s = subs[0];
  assert.equal(s.status, undefined, 'no parent toolUseResult => the stuck/null status');
  assert.equal(s.phase, 'working', 'phased LIVE from the transcript tail, not the missing status');
  assert.equal(s.running, true, 'a working subagent is running');
});

test('fleet: listSiblings wires each session\'s live phase via agentPhase (S4)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const WORK = 'wk1', WAIT = 'wt1';
  fs.writeFileSync(path.join(proj, WORK + '.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }] } }));
  fs.writeFileSync(path.join(proj, WAIT + '.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'go?' }] } }] } }));
  const list = core.listSiblings(cwd, WORK);
  assert.equal(list.find((s) => s.id === WORK).phase, 'working', 'active tool_use => working');
  assert.equal(list.find((s) => s.id === WAIT).phase, 'awaiting-input', 'pending AskUserQuestion => awaiting-input');
});

// --- S6: stable taskId (strict spans) + three-level rollups (§2.1/§2.2) ---

test('changemap: taskId is a content hash — stable across to-do reorder + identical-text collision (S6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;

  // Pure-function contract: content-only hash. firstSeenTs never enters the hash, so identical text is
  // ONE id (an honest collision → one task), and reordering can't shift it (the old positional-ch bug).
  assert.equal(core.taskId('Build the parser', 0), core.taskId('Build the parser', 999999), 'firstSeenTs is not hashed — same text, same id');
  assert.equal(core.taskId('Build the parser', 0).length, 12, 'sha1 truncated to 12 hex chars');
  assert.notEqual(core.taskId('Build the parser', 0), core.taskId('Ship the parser', 0), 'different text → different id');

  // Build-level: the same content keeps its id no matter WHERE the to-do sits, via tasks[] (strict identities).
  const build = (S, todos) => {
    const cwd = tmpWork();
    const proj = core.projectDir(cwd);
    fs.mkdirSync(proj, { recursive: true });
    core.ensureStore(S);
    const snap = JSON.stringify({ timestamp: new Date(1000).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }] } });
    fs.writeFileSync(path.join(proj, S + '.jsonl'), snap);
    return core.buildChangeMap(cwd, S, { root: cwd });
  };
  const m1 = build('order1', [{ content: 'Alpha', status: 'in_progress' }, { content: 'Beta', status: 'pending' }]);
  const m2 = build('order2', [{ content: 'Beta', status: 'pending' }, { content: 'Alpha', status: 'in_progress' }]); // reordered
  const idOf = (m, content) => m.tasks.find((t) => t.content === content).taskId;
  assert.equal(idOf(m1, 'Alpha'), core.taskId('Alpha', 0), 'a task id is the content hash, not `ch0`');
  assert.equal(idOf(m1, 'Alpha'), idOf(m2, 'Alpha'), 'Alpha keeps its id though it moved from slot 0 to slot 1');

  // Duplicate-content to-dos: identical text is deterministically ONE strict task (an honest collision).
  const dup = build('dup', [{ content: 'Dup', status: 'in_progress' }, { content: 'Dup', status: 'pending' }]);
  assert.equal(dup.tasks.filter((t) => t.content === 'Dup').length, 1, 'identical text is one strict task, never two');
  assert.equal(dup.tasks[0].taskId, core.taskId('Dup', 0), 'keyed by the plain content hash');
});
test('changemap: strict spans never edge-fill — head/trailing edits are unassigned; 3-level rollups sum (S6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'strict';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  core.ensureStore(S);

  // Explicit-ts edits (seedEdit ties ts to a sequential id, so append directly to place them precisely).
  const seedAt = (file, before, after, ts) => {
    const b = before === null ? null : core.writeBlob(S, Buffer.from(before));
    const a = after === null ? null : core.writeBlob(S, Buffer.from(after));
    return core.appendLog(S, { ts, tool: 'Edit', file, beforeBlob: b, afterBlob: a, status: 'pending' }).id;
  };
  const F = (n) => path.join(cwd, `f${n}.ts`);
  const id1 = seedAt(F(1), 'a\n', 'a\nb\n', 1000); // HEAD: before the first in_progress (2000) → unassigned
  const id2 = seedAt(F(2), 'a\n', 'a\nb\nc\n', 3000); // inside Task A's strict span [2000,4000)
  const id3 = seedAt(F(3), 'a\n', 'a\nb\n', 5000); // inside Task B's strict span [4000,6000)
  const id4 = seedAt(F(4), 'a\n', 'a\nb\n', 7000); // TRAILING: after Task B completed (6000) → unassigned
  core.setStatus(S, id2, 'kept');
  core.setStatus(S, id3, 'undone');

  const snap = (ts, todos) => JSON.stringify({ timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [
    { type: 'tool_use', id: 't' + ts, name: 'TodoWrite', input: { todos } }] } });
  const main = [
    snap(2000, [{ content: 'Task A', status: 'in_progress' }, { content: 'Task B', status: 'pending' }]),
    snap(4000, [{ content: 'Task A', status: 'completed' }, { content: 'Task B', status: 'in_progress' }]),
    snap(6000, [{ content: 'Task A', status: 'completed' }, { content: 'Task B', status: 'completed' }]),
  ].join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), main);

  const m = core.buildChangeMap(cwd, S, { root: cwd });
  const A = core.taskId('Task A', 0), B = core.taskId('Task B', 0);
  const tid = (id) => m.edits.find((e) => e.id === id).taskId;

  // --- strict-span attribution: NO edge fill onto the head/tail task (the BLOCKER fix) ---
  assert.equal(tid(id1), null, 'a pre-first-in_progress edit is unassigned, not force-filed onto the opening task');
  assert.equal(tid(id2), A, 'an edit inside Task A\'s real interval attributes to Task A');
  assert.equal(tid(id3), B, 'an edit inside Task B\'s real interval attributes to Task B');
  assert.equal(tid(id4), null, 'a post-last-completed edit is unassigned, not swept onto the last task');

  // --- rollupByTask: two task rolls + an EXPLICIT null (unassigned) bucket, sorted null-last ---
  const rt = m.rollupByTask;
  const un = rt.find((r) => r.taskId === null);
  assert.ok(un, 'the unassigned bucket is surfaced explicitly (taskId: null)');
  assert.equal(un.edits, 2, 'both the head and trailing gap edits land in unassigned');
  assert.equal(un.pending, 2, 'and they carry their pending status');
  assert.equal(rt[rt.length - 1].taskId, null, 'the null bucket sorts last');
  assert.equal(rt.find((r) => r.taskId === A).kept, 1, 'Task A\'s edit was kept');
  assert.equal(rt.find((r) => r.taskId === B).undone, 1, 'Task B\'s edit was reverted');

  // --- rollups conserve the totals (sums) across every dimension ---
  const totAdded = m.edits.reduce((n, e) => n + e.added, 0);
  const totRemoved = m.edits.reduce((n, e) => n + e.removed, 0);
  const sumRoll = (rows) => ({
    edits: rows.reduce((n, r) => n + r.edits, 0),
    added: rows.reduce((n, r) => n + r.added, 0),
    removed: rows.reduce((n, r) => n + r.removed, 0),
  });
  assert.deepEqual(sumRoll(rt), { edits: m.edits.length, added: totAdded, removed: totRemoved }, 'rollupByTask conserves edits/±lines');
  assert.deepEqual(sumRoll(m.rollupBySubagent), { edits: m.edits.length, added: totAdded, removed: totRemoved }, 'rollupBySubagent conserves totals');

  // no subagents here → every edit is main-chain (subagentId null) → one bucket
  assert.deepEqual(m.rollupBySubagent.map((r) => r.subagentId), [null], 'all edits are main-chain (subagentId null)');

  // --- rollupByAgent: one row per built map, worktree-aware when fed siblings ---
  const byAgent = core.rollupByAgent([m, { summary: { session: 'other' }, edits: [
    { added: 4, removed: 1, status: 'kept' }], files: [{}, {}] }]);
  assert.equal(byAgent.length, 2, 'one row per change-map');
  assert.deepEqual(byAgent[0], { session: S, edits: m.edits.length, added: totAdded, removed: totRemoved, pending: 2, kept: 1, undone: 1, files: m.files.length }, 'this session\'s totals');
  assert.deepEqual(byAgent[1], { session: 'other', edits: 1, added: 4, removed: 1, pending: 0, kept: 1, undone: 0, files: 2 }, 'the sibling\'s totals, kept separate');
});

test('changemap: session titles — ai-title outranks the first prompt; wrappers never win; strict stays honest', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;

  const build = (S, transcriptLines) => {
    const cwd = tmpWork();
    const proj = core.projectDir(cwd);
    fs.mkdirSync(proj, { recursive: true });
    core.ensureStore(S);
    const F = path.join(cwd, 'app.ts');
    const id = seedEdit(S, F, 'a\n', 'a\nb\n');
    fs.writeFileSync(path.join(proj, S + '.jsonl'), transcriptLines.join('\n'));
    return { m: core.buildChangeMap(cwd, S, { root: cwd }), id };
  };

  // --- a session with NO TodoWrite at all: everything is honestly unassigned ---
  const userMsg = JSON.stringify({ timestamp: new Date(500).toISOString(), message: { role: 'user', content: 'Fix the login flow so sessions persist' } });
  const { m: noTodo, id: e1 } = build('nt', [userMsg]);
  assert.ok(!('subtasks' in noTodo), 'no display-subtask layer (0.8.8)');
  assert.equal(noTodo.edits.find((e) => e.id === e1).taskId, null, 'no plan → the strict dimension reports unassigned');
  assert.equal(noTodo.summary.title, 'Fix the login flow so sessions persist', 'the session is titled from the first user prompt');

  // --- ai-title outranks the first prompt; no user line at all leaves the title empty ---
  const title = JSON.stringify({ type: 'ai-title', aiTitle: 'Login session persistence' });
  const { m: titled } = build('ntt', [title, userMsg]);
  assert.equal(titled.summary.title, 'Login session persistence', 'Claude Code\'s own title wins when present');
  const { m: bare } = build('ntb', ['']);
  assert.equal(bare.summary.title, '', 'no title, no prompt → empty string, never a guessed name');

  // --- command wrappers and tool_result-only user turns never become the session title ---
  const wrapper = JSON.stringify({ timestamp: new Date(100).toISOString(), message: { role: 'user', content: '<command-name>/effort</command-name>' } });
  const toolResult = JSON.stringify({ timestamp: new Date(200).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] } });
  const { m: filtered } = build('ntf', [wrapper, toolResult, userMsg]);
  assert.equal(filtered.summary.title, 'Fix the login flow so sessions persist', 'skips harness wrappers and tool_result turns to find the real prompt');

  // --- a ts===0 edit (no timestamp) is unassigned even alongside a real plan ---
  const cwd0 = tmpWork();
  const proj0 = core.projectDir(cwd0);
  fs.mkdirSync(proj0, { recursive: true });
  core.ensureStore('nt0');
  const b0 = core.writeBlob('nt0', Buffer.from('a\n'));
  const a0 = core.writeBlob('nt0', Buffer.from('a\nb\n'));
  core.appendLog('nt0', { ts: 0, tool: 'Edit', file: path.join(cwd0, 'zero.ts'), beforeBlob: b0, afterBlob: a0, status: 'pending' });
  const snap0 = JSON.stringify({ timestamp: new Date(1000).toISOString(), message: { role: 'assistant', content: [
    { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Real task', status: 'in_progress' }] } }] } });
  fs.writeFileSync(path.join(proj0, 'nt0.jsonl'), snap0);
  const m0 = core.buildChangeMap(cwd0, 'nt0', { root: cwd0 });
  assert.equal(m0.edits[0].taskId, null, 'a timestamp-less edit can\'t be placed in a strict interval → unassigned');
  assert.ok(m0.rollupByTask.some((r) => r.taskId === null && r.edits === 1), 'the explicit unassigned bucket claims it');
});

test('observations: buildObservations coalesces 3 consecutive same-file edits into ONE ×3 run (0.8.0 r2)', () => {
  freshHome();
  const S = 'obs-coalesce';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), ''); // transcript must exist (findTranscript)
  const F = path.join(cwd, 'coalesce.ts');
  const id1 = seedEdit(S, F, 'a\n', 'a\nb\n'); // +1
  const id2 = seedEdit(S, F, 'a\nb\n', 'a\nb\nc\n'); // +1
  const id3 = seedEdit(S, F, 'a\nb\nc\n', 'a\nb\nc\nd\n'); // +1

  const obs = core.buildObservations(cwd, S, { root: cwd });
  const runs = obs.runs.filter((r) => r.file === F);
  assert.equal(runs.length, 1, 'three consecutive same-file edits collapse into ONE run');
  const run = runs[0];
  assert.equal(run.count, 3, 'count is the ×N (=3)');
  assert.equal(run.edits.length, 3, 'the run carries all three per-edit rows for drill-down');
  assert.deepEqual(run.edits.map((e) => e.id).sort((a, b) => a - b), [id1, id2, id3], 'each row carries its edit id');
  assert.equal(run.added, 3, 'combined + across the run (one added line each)');
  assert.equal(run.removed, 0, 'combined − across the run');
  assert.ok(run.edits.every((e) => e.status === 'pending'), 'each row carries its review status');
  assert.ok(run.edits.every((e) => 'ts' in e && 'reasoning' in e), 'each row carries ts + reasoning for drill-down');
});

test('workflows: workflow→edit attribution by ts-window; ambiguous overlap → null (0.8.0 r2)', () => {
  freshHome();
  const S = 'wf-attr';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), ''); // main transcript exists
  const T = 1_700_000_000_000; // ms epoch (toMs passes >1e12 through unchanged)
  // Two workflow runs, each with one agent whose tool_uses bracket a ts-window:
  //   wf_one: [T+1000, T+2000] ; wf_two: [T+1500, T+2500]  → they OVERLAP on [T+1500, T+2000].
  const wfRoot = path.join(proj, S, 'subagents', 'workflows');
  const mkAgent = (wfId, agentId, t0, t1) => {
    const dir = path.join(wfRoot, wfId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `agent-${agentId}.jsonl`),
      [
        { timestamp: t0, message: { role: 'assistant', content: [{ type: 'tool_use', id: agentId + '1', name: 'Edit', input: { file_path: '/x.ts' } }] } },
        { timestamp: t1, message: { role: 'assistant', content: [{ type: 'tool_use', id: agentId + '2', name: 'Edit', input: { file_path: '/x.ts' } }] } },
      ].map((o) => JSON.stringify(o)).join('\n')
    );
  };
  mkAgent('wf_one', 'aa', T + 1000, T + 2000);
  mkAgent('wf_two', 'bb', T + 1500, T + 2500);

  // Four distinct-file store edits at controlled timestamps (distinct files → no tree collapse).
  core.ensureStore(S);
  const mk = (file, ts) => {
    const id = core.nextId(S);
    const b = core.writeBlob(S, Buffer.from(file + '\n'));
    core.appendLog(S, { id, ts, tool: 'Edit', file, beforeBlob: null, afterBlob: b, status: 'pending' });
    return id;
  };
  const e1 = mk(path.join(cwd, 'w1.ts'), T + 1200); // wf_one only
  const e2 = mk(path.join(cwd, 'w2.ts'), T + 2300); // wf_two only
  const e3 = mk(path.join(cwd, 'w3.ts'), T + 1800); // in BOTH windows → ambiguous → null
  const e4 = mk(path.join(cwd, 'w4.ts'), T + 9000); // in NO window → null

  const m = core.buildChangeMap(cwd, S, { root: cwd });
  const wid = (id) => m.edits.find((e) => e.id === id).workflowId;
  assert.equal(m.edits.length, 4, 'four distinct edits, none collapsed');
  assert.equal(wid(e1), 'wf_one', 'ts inside wf_one only → wf_one');
  assert.equal(wid(e2), 'wf_two', 'ts inside wf_two only → wf_two');
  assert.equal(wid(e3), null, 'ts inside BOTH workflows → ambiguous → null (never guessed)');
  assert.equal(wid(e4), null, 'ts inside NO window → null');

  // (D) workflows[] Overview tabs: one entry per workflow that produced attributed edits.
  assert.deepEqual(m.workflows.map((w) => w.id).sort(), ['wf_one', 'wf_two'], 'one tab per workflow with attributed edits (ambiguous/none excluded)');
  const one = m.workflows.find((w) => w.id === 'wf_one');
  assert.equal(one.rollup.edits, 1, 'wf_one rolls up its single attributed edit');
  assert.equal(one.rollup.pending, 1, 'and carries its review status');
  assert.deepEqual(one.files.map((f) => f.file), ['w1.ts'], 'wf_one files: its touched file(s), churn-desc');

  // rollupByWorkflow: per-workflow rows + an EXPLICIT null bucket (ambiguous + unwindowed), null-last.
  const rw = m.rollupByWorkflow;
  assert.ok(rw.find((r) => r.workflowId === 'wf_one') && rw.find((r) => r.workflowId === 'wf_two'), 'both workflows rolled up');
  const un = rw.find((r) => r.workflowId === null);
  assert.ok(un && un.edits === 2, 'the ambiguous (e3) + unwindowed (e4) edits collect in the null bucket');
  assert.equal(rw[rw.length - 1].workflowId, null, 'the null bucket sorts last');
  assert.equal(rw.reduce((n, r) => n + r.edits, 0), m.edits.length, 'rollupByWorkflow conserves the edit count');
});

// --- S7 (0.8.0): cross-agent task log + task-scoped keep/undo (taskLog.ts, undo.ts) --------------
// Reuses the S2/S3 git-free worktree fixtures and the S6 to-do timeline. STRICT-span attribution only:
// an edit in no real in_progress interval is `unassigned` and is excluded from task rows / undo sets.

test('taskLog: crossAgentTaskLog unions one logical task across two worktree siblings into one row', () => {
  freshHome();
  const base = tmpWork();
  // Main working tree (dir-.git) + a linked worktree (file-.git → shared commondir) = ONE repo group.
  const main = path.join(base, 'main');
  const gitDir = path.join(main, '.git');
  const admin = path.join(gitDir, 'worktrees', 'wtA');
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'config'), BARE_FALSE);
  fs.writeFileSync(path.join(admin, 'commondir'), '../..\n');
  const wtA = path.join(base, 'wtA');
  fs.mkdirSync(wtA);
  fs.writeFileSync(path.join(wtA, '.git'), `gitdir: ${admin}\n`);
  assert.equal(core.commonDir(main), core.commonDir(wtA), 'sanity: main + wtA are one repo');

  // Both agents work the SAME logical task — identical to-do text hashes to the SAME taskId (§S6). The
  // to-do is in_progress across [500, 1500); an edit at ts=1000 lands inside it, one at ts=2000 does not.
  const TASK = 'Wire the exporter';
  const MAIN = 's7-main', WTA = 's7-wta';
  const transcript = (cwd, id, branch) => [
    { type: 'user', cwd, sessionId: id, gitBranch: branch }, // first cwd-bearing line (listRepoSiblings keys on it)
    { timestamp: new Date(500).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: TASK, status: 'in_progress' }] } }] } },
    { timestamp: new Date(1500).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: TASK, status: 'completed' }] } }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  const seedTranscript = (cwd, id, branch) => {
    const dir = core.projectDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.jsonl'), transcript(cwd, id, branch));
  };
  seedTranscript(main, MAIN, 'main');
  seedTranscript(wtA, WTA, 'feat/x');

  seedEdit(MAIN, path.join(main, 'a.ts'), null, 'x\n'); // #1 ts=1000 → inside the task span
  seedEdit(MAIN, path.join(main, 'a2.ts'), null, 'z\n'); // #2 ts=2000 → AFTER the task closed → unassigned
  seedEdit(WTA, path.join(wtA, 'b.ts'), null, 'y\n'); // #1 ts=1000 → inside the task span (the OTHER worktree)

  const rows = core.crossAgentTaskLog(main);
  assert.equal(rows.length, 1, 'one logical task across two worktrees folds into ONE row (unassigned edit excluded)');
  const row = rows[0];
  assert.equal(row.taskId, core.taskId(TASK, 0), 'keyed by the stable content-hash taskId');
  assert.equal(row.content, TASK, 'the to-do text is carried onto the task row');
  assert.deepEqual(row.agentIds, [MAIN, WTA].sort(), 'both worktree sessions contributed → both agents named');
  assert.deepEqual(row.subagentIds, [], 'no subagents authored these edits');
  assert.equal(row.edits, 2, 'exactly the two in-interval edits (one per worktree); the unassigned edit is NOT counted');
  assert.equal(row.added, 2, '+1 line per contributing edit');
  assert.equal(row.removed, 0);
  assert.equal(row.status, 'pending', 'all contributing edits are pending → the task reads pending');
});

// A single-session fixture: transcript puts `task` in_progress across [500, 2500). Seeds three edits at
// ts 1000/2000/3000 — the third lands AFTER the task completes, so it belongs to NO strict interval.
function seedTaskSession(S, task) {
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const rec = [
    { type: 'user', cwd, sessionId: S, gitBranch: 'main' },
    { timestamp: new Date(500).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: task, status: 'in_progress' }] } }] } },
    { timestamp: new Date(2500).toISOString(), message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: task, status: 'completed' }] } }] } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  fs.writeFileSync(path.join(proj, S + '.jsonl'), rec);
  const F1 = path.join(cwd, 'f1.ts'), F2 = path.join(cwd, 'f2.ts'), F3 = path.join(cwd, 'f3.ts');
  fs.writeFileSync(F1, 'a2\n'); fs.writeFileSync(F2, 'b2\n'); fs.writeFileSync(F3, 'c2\n'); // on-disk = each edit's `after`
  const id1 = seedEdit(S, F1, 'a1\n', 'a2\n'); // ts 1000 — inside [500,2500)
  const id2 = seedEdit(S, F2, 'b1\n', 'b2\n'); // ts 2000 — inside
  const id3 = seedEdit(S, F3, 'c1\n', 'c2\n'); // ts 3000 — AFTER the task completed → unassigned
  return { cwd, S, taskId: core.taskId(task, 0), ids: [id1, id2, id3], files: [F1, F2, F3] };
}

test('undo: task revert is STRICT — exactly the real in_progress interval, never a gap fill (0.8.8)', () => {
  freshHome();
  const f = seedTaskSession('s7-undo', 'Task A');
  const [id1, id2, id3] = f.ids;
  assert.deepEqual([id1, id2, id3], [1, 2, 3], 'serial ids, ts = id*1000');

  // The strict set: #3 (ts 3000 > completed 2500) is outside the real interval.
  const strict = core.taskEditIds(f.cwd, f.S, f.taskId).sort((a, b) => a - b);
  assert.deepEqual(strict, [id1, id2], 'taskEditIds: only edits inside the real in_progress interval');
  const m = core.buildChangeMap(f.cwd, f.S, { root: f.cwd });
  assert.equal(m.edits.find((e) => e.id === id3).taskId, null, 'strict attribution: the trailing edit is honestly unassigned');

  // Task revert acts on the strict set and NOTHING else: a trailing edit the task never owned stays put.
  const res = core.undoTask(f.cwd, f.S, f.taskId);
  assert.equal(res.undone, 2, 'exactly the strict set reverted');
  assert.deepEqual(res.ids.sort((a, b) => a - b), [id1, id2], 'never the trailing gap edit');
  assert.equal(fs.readFileSync(f.files[0], 'utf8'), 'a1\n', '#1 reverted to its pre-edit state');
  assert.equal(fs.readFileSync(f.files[1], 'utf8'), 'b1\n', '#2 reverted');
  assert.equal(core.findRecord('s7-undo', id3).status, 'pending', '#3 was never part of the task — untouched');
});

test('undo: keepTask accepts the STRICT task set — an unowned edit is never swept in (0.8.8)', () => {
  freshHome();
  const f = seedTaskSession('s7-keep', 'Task K');
  const [id1, id2, id3] = f.ids;
  const res = core.keepTask(f.cwd, f.S, f.taskId);
  assert.equal(res.kept, 2, 'the strict set is kept');
  assert.equal(res.total, 2, 'total = the strict set');
  assert.deepEqual(res.ids.sort((a, b) => a - b), [id1, id2], 'exactly the strict set was kept');
  for (const id of [id1, id2]) assert.equal(core.findRecord('s7-keep', id).status, 'kept');
  assert.equal(core.findRecord('s7-keep', id3).status, 'pending', 'the trailing gap edit stays pending — it was never this task\'s');
});

test('changemap: TaskCreate/TaskUpdate tasks get STRICT attribution + the Tasks-tab taskId join + TodoWrite dedupe', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'tasklink';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  core.ensureStore(S);
  const seedAt = (file, before, after, ts) => {
    const b = core.writeBlob(S, Buffer.from(before));
    const a = core.writeBlob(S, Buffer.from(after));
    return core.appendLog(S, { ts, tool: 'Edit', file, beforeBlob: b, afterBlob: a, status: 'pending' }).id;
  };
  const F = (n) => path.join(cwd, `t${n}.py`);
  seedAt(F(1), 'a\n', 'a\nb\n', 500); // before the first flip → back-extends onto task #1
  seedAt(F(2), 'a\n', 'a\nc\n', 1500); // inside #1's span
  seedAt(F(3), 'a\n', 'a\nd\n', 3500); // inside #2's span
  const tu = (ts, blocks) => JSON.stringify({ timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: blocks } });
  const tr = (ts, tuid, text) => JSON.stringify({ type: 'user', timestamp: new Date(ts).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tuid, content: text }] } });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [
    tu(900, [{ type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'Wire the reader', description: 'core reader', activeForm: 'Wiring the reader' } }]),
    tr(950, 'c1', 'Task #1 created successfully: Wire the reader'),
    tu(960, [{ type: 'tool_use', id: 'c2', name: 'TaskCreate', input: { subject: 'Render the tab' } }]),
    tr(970, 'c2', 'Task #2 created successfully: Render the tab'),
    tu(1000, [{ type: 'tool_use', id: 'u1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }]),
    tu(3000, [
      { type: 'tool_use', id: 'u2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
      { type: 'tool_use', id: 'u3', name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' } },
    ]),
    tu(4000, [{ type: 'tool_use', id: 'u4', name: 'TaskUpdate', input: { taskId: '2', status: 'completed' } }]),
    // The demo plans BOTH ways: a TodoWrite naming the same title must NOT mint a twin task.
    tu(4100, [{ type: 'tool_use', id: 'td', name: 'TodoWrite', input: { todos: [{ content: 'Wire the reader', status: 'completed' }] } }]),
  ].join('\n'));
  const cm = core.buildChangeMap(cwd, S, { root: cwd });
  // The merged plan (tasks ∪ todos, todos winning duplicate titles) feeds ONE strict identity per title.
  const byContent = new Map(cm.tasks.map((t) => [t.content, t]));
  assert.equal(byContent.size, cm.tasks.length, 'no twin tasks — todos win duplicate titles in the merged plan');
  const t1 = byContent.get('Wire the reader');
  const t2 = byContent.get('Render the tab');
  assert.ok(t1 && t2, 'both TaskCreate subjects hold strict identities');
  const roll = new Map(cm.rollupByTask.map((r) => [r.taskId, r]));
  assert.equal(roll.get(t1.taskId).edits, 1, 'task #1 strictly claims its in-span edit (the ts-500 head edit is unassigned)');
  assert.equal(roll.get(t2.taskId).edits, 1, 'task #2 strictly claims its in-span edit');
  assert.ok(roll.get(null) && roll.get(null).edits === 1, 'the pre-first-flip edit lands in the explicit unassigned bucket');
  assert.deepEqual(core.taskEditIds(cwd, S, t1.taskId), [2], 'taskEditIds resolves the same strict set');
  // The tab join: rows come from transcript HISTORY (no task dir exists) with the strict taskId.
  const rows = core.sessionTaskRows(cwd, S);
  assert.deepEqual(rows.map((r) => r.id), ['2', '1'], 'history mined from the transcript, NEWEST first');
  assert.equal(rows[1].taskId, t1.taskId, 'taskIdForSubject joins the tab row to rollupByTask');
  assert.equal(rows[1].activeForm, 'Wiring the reader');
});

// --- S8: zero-token chat-context assembler (§2.6/§7) ---

/** A store edit + a transcript (Edit reasoning, a Bash command+result, an in_progress TodoWrite) so one
 *  fixture exercises every assembleChatContext ref path. Returns cwd/session + the taskId of the todo. */
function seedChatContext(session) {
  const cwd = tmpWork();
  const S = session;
  const F = path.join(cwd, 'app.ts');
  core.ensureStore(S);
  const before = core.writeBlob(S, Buffer.from('const a = 1\n'));
  const after = core.writeBlob(S, Buffer.from('const a = 2\n'));
  core.appendLog(S, { ts: 1000, tool: 'Edit', file: F, beforeBlob: before, afterBlob: after, status: 'pending' }); // #1
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = [
    { timestamp: '2026-07-13T10:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'Bumping the constant from 1 to 2.' },
      { type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: F } },
    ] } },
    { timestamp: '2026-07-13T10:01:00.000Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'Running the test suite.' },
      { type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'npm test --silent', description: 'run tests' } },
    ] } },
    { message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tu-bash', is_error: false, content: 'PASS 3 tests, 0 failures' },
    ] } },
    { timestamp: '2026-07-13T10:02:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tu-todo', name: 'TodoWrite', input: { todos: [{ content: 'Refactor the parser', status: 'in_progress' }] } },
    ] } },
  ].map((o) => JSON.stringify(o)).join('\n');
  fs.writeFileSync(path.join(proj, S + '.jsonl'), tx);
  return { cwd, S, taskId: core.taskId('Refactor the parser', 0) };
}

test('assembleChatContext: edit ref carries the before/after blobs + Claude’s reasoning (zero token)', () => {
  freshHome();
  const { cwd, S } = seedChatContext('s8-edit');
  // by editId
  const p = core.assembleChatContext(cwd, S, { editId: 1 });
  assert.match(p, /--- before ---/, 'has a before section');
  assert.match(p, /--- after ---/, 'has an after section');
  assert.match(p, /const a = 1/, 'before blob content present');
  assert.match(p, /const a = 2/, 'after blob content present');
  assert.match(p, /Bumping the constant from 1 to 2\./, "carries Claude's own reasoning for the edit");
  assert.match(p, /edit #1|app\.ts/, 'names the edited file/record');
  // the same edit, referenced by its stable toolUseId, resolves the same store record → same before/after
  const p2 = core.assembleChatContext(cwd, S, { toolUseId: 'tu-edit' });
  assert.match(p2, /const a = 1/, 'toolUseId path also finds the before blob');
  assert.match(p2, /const a = 2/, 'toolUseId path also finds the after blob');
});

test('assembleChatContext: exec (action) ref carries the command + its result (zero token)', () => {
  freshHome();
  const { cwd, S } = seedChatContext('s8-exec');
  const p = core.assembleChatContext(cwd, S, { toolUseId: 'tu-bash' });
  assert.match(p, /--- command ---/, 'has a command section');
  assert.match(p, /npm test --silent/, 'the shell command is present');
  assert.match(p, /--- result ---/, 'has a result section');
  assert.match(p, /PASS 3 tests, 0 failures/, 'the tool_result output is present');
  assert.match(p, /Running the test suite\./, "carries Claude's reasoning for the command");
  assert.doesNotMatch(p, /--- before ---/, 'an exec is not framed as an edit (no before/after)');
});

test('assembleChatContext: task ref frames the prompt with the task (resolved from its stable taskId)', () => {
  freshHome();
  const { cwd, S, taskId } = seedChatContext('s8-task');
  // task ref alone → the header names the task by its resolved content, not the opaque hash
  const solo = core.assembleChatContext(cwd, S, { taskId });
  assert.match(solo, /task/i, 'frames the prompt as a task');
  assert.match(solo, /Refactor the parser/, 'resolves the taskId hash back to the todo content');
  assert.doesNotMatch(solo, new RegExp(taskId), 'shows the content, not the raw hash');
  // task + subagent framing layered onto a primary action → "part of task X run by subagent Y"
  const framed = core.assembleChatContext(cwd, S, { toolUseId: 'tu-edit', taskId, agentId: 'ag7' });
  assert.match(framed, /part of task "Refactor the parser" run by subagent ag7/, 'layers task + subagent framing on the action');
  // an unknown taskId degrades honestly to the raw ref (never invents a task name)
  const unknown = core.assembleChatContext(cwd, S, { taskId: 'deadbeef0000' });
  assert.match(unknown, /deadbeef0000/, 'an unresolvable taskId is surfaced verbatim, not guessed');
});

test('assembleChatContext: NEVER spawns a process or calls a model (zero-token guarantee)', () => {
  freshHome();
  const { cwd, S, taskId } = seedChatContext('s8-nospawn');
  // Trip-wire every child_process entry point: assembling context must not exec/spawn anything
  // (it must not reach analyze.ts's `claude -p`). Restored in finally so later tests are unaffected.
  const methods = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  const orig = {};
  for (const m of methods) {
    orig[m] = cp[m];
    cp[m] = () => {
      throw new Error(`assembleChatContext spawned a process via child_process.${m}`);
    };
  }
  try {
    for (const ref of [{ editId: 1 }, { toolUseId: 'tu-edit' }, { toolUseId: 'tu-bash' }, { taskId }, { agentId: 'ag7' }, {}]) {
      const out = core.assembleChatContext(cwd, S, ref);
      assert.equal(typeof out, 'string', 'returns a prompt string');
      assert.ok(out.length > 0, 'the prompt is non-empty');
    }
  } finally {
    for (const m of methods) cp[m] = orig[m];
  }
});

// ── S9 — core barrel: every new 0.8.0 public symbol is reachable via the single `core` backend ──
// Guards the CLI-as-single-backend contract: the CLI + both editors consume aggregation exclusively
// through `core.*`, so a module dropped from index.ts (or a public symbol quietly made private) is a
// silent parity break. This test pins the reachable public surface introduced by S1-S8.
test('barrel: index.ts re-exports every new 0.8.0 public symbol (CLI-as-single-backend)', () => {
  // Runtime-checkable values (functions). Types (Phase, FileCollision, SiblingSession, TaskLogEntry,
  // ChatContextRef, TaskRoll/SubagentRoll/AgentRoll, KeepScopeResult, …) are compile-time only and
  // are surfaced by `export *` in index.d.ts — the CLI/vscode builds under `npm test` are the check
  // that they resolve, so a missing type turns the build red rather than passing silently here.
  const publicFns = [
    // S2 — git-free worktree resolver (session.ts)
    'repoRoot', 'commonDir', 'repoKeyForSession', 'firstCwdLine',
    // S3 — repo-scoped siblings + conflicts (fleet.ts)
    'listRepoSiblings', 'fleetConflicts',
    // S4 — live phase + subagent todos (actions.ts / subagents.ts)
    'agentPhase', 'agentPhaseDetail', 'subagentTodos',
    // S5 — hardened subagent editId linker (actions.ts)
    'attributeEditIds',
    // S6 — stable taskId (strict spans) + three-level rollups (changemap.ts)
    'taskId', 'rollupByTask', 'rollupBySubagent', 'rollupByAgent',
    // S7 — cross-agent task-log + task-scoped keep/undo (taskLog.ts / changemap.ts / undo.ts)
    'crossAgentTaskLog', 'taskEditIds', 'undoTask', 'keepTask',
    // S8 — zero-token chat-context assembler (actions.ts)
    'assembleChatContext',
    // 0.8.0 — panel consolidation: Observations view-model (observe.ts) + task-scoped clear (store.ts)
    'buildObservations', 'clearResolvedIds',
    // 0.8.0 — workflow-run tracking (workflows.ts)
    'parseWorkflows',
    // 0.8.0 r2 — workflow→edit attribution + per-workflow rollup (workflows.ts / changemap.ts)
    'workflowWindows', 'workflowForTs', 'rollupByWorkflow',
    // 0.8.6 — session vitals (metrics.ts), compaction primitives (actions.ts), footprint
    // (capabilities.ts), context sources (observe.ts), shared model labeller (format.ts)
    'sessionVitals', 'parseCompactLine', 'compactLabel', 'outsideReads', 'outsideWrites', 'contextSources', 'friendlyModel',
    // 0.8.8 — prompts (prompts.ts), fast session listing (observe.ts), the tab join (tasks.ts)
    'sessionPrompts', 'promptEditIds', 'promptResponse', 'summarizePrompts', 'sessionMeta', 'fastSessionTitle', 'taskIdForSubject',
  ];
  const missing = publicFns.filter((k) => typeof core[k] !== 'function');
  assert.deepEqual(missing, [], `barrel is missing public symbol(s): ${missing.join(', ')}`);

  // The strict-span mechanics (inProgressSpansStrict / taskForTs) are INTENTIONALLY private (S6/S7):
  // the blueprint §2.1 designates inProgressSpansStrict an internal builder, and taskForTs exists only
  // as the module-private strictTaskForTs helper + a buildChangeMap closure. The PUBLIC strict-span
  // contract consumers need is exposed through taskEditIds / rollupByTask / ChangeMap.rollupByTask —
  // asserted present above. Pin the boundary so a refactor can't silently widen the public surface.
  for (const priv of ['inProgressSpansStrict', 'taskForTs', 'strictTaskForTs']) {
    assert.equal(core[priv], undefined, `${priv} is an internal helper — it must not leak onto the barrel`);
  }
});

// --- 0.8.0 stabilization: tracking-fix + perf-cache regression tests ------------------------------

test('fscache: a pure parse is memoized per (mtime,size) and invalidates when the file changes', () => {
  freshHome();
  const dir = tmpWork();
  const p = path.join(dir, 't.jsonl');
  fs.writeFileSync(p, JSON.stringify(asstToolUse('x1', 'Read', { file_path: '/a.ts' })) + '\n');
  const first = core.parseTranscriptActions(p, { includeSidechain: true });
  assert.equal(first.length, 1, 'one action parsed');
  // Same stamp → served from cache; the returned records are per-call COPIES, so a consumer that
  // mutates (attribution sets editId) can never poison the cached master.
  const second = core.parseTranscriptActions(p, { includeSidechain: true });
  second[0].editId = 999;
  const third = core.parseTranscriptActions(p, { includeSidechain: true });
  assert.equal(third[0].editId, undefined, 'a consumer mutation never leaks into the cached master');
  // Append a line (size changes) → the cache revalidates and re-parses.
  fs.appendFileSync(p, JSON.stringify(asstToolUse('x2', 'Read', { file_path: '/b.ts' })) + '\n');
  assert.equal(core.parseTranscriptActions(p, { includeSidechain: true }).length, 2, 'file change → fresh parse');
  core.clearFsCache(); // exported for long-lived hosts + hermetic tests
  assert.equal(core.parseTranscriptActions(p, { includeSidechain: true }).length, 2, 'still parses after an explicit clear');
});

test('subagents/fleet: phase CONFIDENCE is propagated — heuristic staleness never asserted as truth (0.8.0)', () => {
  freshHome();
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  const S = 'conf';
  fs.mkdirSync(path.join(proj, S, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), JSON.stringify(asstToolUse('m1', 'Read', { file_path: '/x.ts' })) + '\n');
  // A subagent with a pending tool_use gone stale >10s → awaiting-permission, but only as a HEURISTIC.
  writePhaseTranscript(path.join(proj, S, 'subagents'), 'agent-s1.jsonl',
    [asstToolUse('t1', 'Bash', { command: 'sleep 99' })], 30_000);
  const subs = core.parseSubagents(cwd, S);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].phase, 'awaiting-permission', 'stale pending tool_use classifies as awaiting-permission');
  assert.equal(subs[0].phaseConfidence, 'heuristic', 'and is LABELED a heuristic — renderers dim it');
  // A sibling's phase carries its confidence too (fresh active tool_use → structural).
  const sibs = core.listSiblings(cwd, S);
  const self = sibs.find((s) => s.id === S);
  assert.equal(self.phase, 'working', 'fresh pending tool_use → working');
  assert.equal(self.phaseConfidence, 'high', 'structural classification → high confidence');
});

test('workflows: running gate uses WORKFLOW_ACTIVE_MS (5m) — a long-thinking agent no longer flaps to done (0.8.0)', () => {
  freshHome();
  const S = 'wffresh';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), '');
  const wfDir = path.join(proj, S, 'subagents', 'workflows', 'wf_fresh');
  fs.mkdirSync(wfDir, { recursive: true });
  const mk = (ageMs) => {
    fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'v2:aaaa', agentId: 'a1' }));
    writePhaseTranscript(wfDir, 'agent-a1.jsonl', [asstToolUse('t1', 'Read', { file_path: '/x.ts' })], ageMs);
    const d = new Date(Date.now() - ageMs);
    fs.utimesSync(path.join(wfDir, 'journal.jsonl'), d, d);
    return core.parseWorkflows(cwd, S)[0];
  };
  const thinking = mk(4 * 60_000); // 4 minutes silent — a long reasoning turn, NOT dead
  assert.equal(thinking.running, true, 'a 4m-silent unfinished run still reads running (was: flapped at 60s)');
  assert.ok(thinking.lastActivityMs > 0, 'lastActivityMs exposes the freshness signal for "active Nm ago"');
  const dead = mk(6 * 60_000); // past the 5m bound — killed/abandoned runs still age out
  assert.equal(dead.running, false, 'a 6m-silent run ages out (killed runs never write completed)');
});

test('workflows: parseScriptMeta survives braces/quotes in string fields; journal keys never fake phases (0.8.0)', () => {
  freshHome();
  const S = 'wfmeta';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), '');
  const wfDir = path.join(proj, S, 'subagents', 'workflows', 'wf_meta1');
  fs.mkdirSync(wfDir, { recursive: true });
  const scriptsDir = path.join(proj, S, 'workflows', 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  // Braces inside strings + comments used to mis-slice the object literal and drop every field.
  fs.writeFileSync(path.join(scriptsDir, 'tricky-wf_meta1.js'), [
    "export const meta = {",
    "  name: 'tricky {run}', // a } in a comment",
    "  description: \"notes {see: docs} and \\\"quoted\\\" bits\",",
    "  /* block } comment */",
    "  phases: [{ title: 'Scan' }, { title: 'Fix' }],",
    "}",
    "phase('Scan')",
  ].join('\n'));
  // Two agents whose journal keys are per-agent-unique and match NO declared phase → identifiers, not
  // phases (the structural belt over the isHashKey regex); a slugged declared key ('phase-scan') sticks.
  fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), [
    JSON.stringify({ type: 'started', key: 'phase-scan', agentId: 'a1' }),
    JSON.stringify({ type: 'started', key: 'zq9x-unique-blob-77', agentId: 'b2' }),
  ].join('\n'));
  writePhaseTranscript(wfDir, 'agent-a1.jsonl', [asstToolUse('t1', 'Read', { file_path: '/x.ts' })]);
  writePhaseTranscript(wfDir, 'agent-b2.jsonl', [asstToolUse('t2', 'Read', { file_path: '/y.ts' })]);
  const w = core.parseWorkflows(cwd, S)[0];
  assert.equal(w.name, 'tricky {run}', 'name parses despite braces in strings');
  assert.equal(w.description, 'notes {see: docs} and "quoted" bits', 'description parses despite braces + escaped quotes');
  assert.deepEqual(w.phases, ['Scan', 'Fix'], 'declared phases parse past the comments');
  const a1 = w.agents.find((a) => a.agentId === 'a1');
  assert.equal(a1.phase, 'phase-scan', 'a key slug-matching a declared phase is trusted');
  const b2 = w.agents.find((a) => a.agentId === 'b2');
  assert.equal(b2.phase, null, 'a per-agent-unique undeclared key is an identifier — never a bogus phase');
});

test('demo: runDemo replays a real-pipeline session — strict task attribution, attributed subagent + workflow, no-residue lifecycle', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork()); // physical path — the demo records under the shell's getcwd()
  const res = await core.runDemo({ fast: true, cwd: ws });
  assert.match(res.session, /^demo-[0-9a-f]{8}$/, 'the demo- prefix gates every demo-only behavior');
  assert.equal(res.edits, 9, 'nine captured store edits across the three prompts');
  assert.ok(fs.existsSync(res.transcript), 'a real transcript in the real project dir');
  assert.equal(res.sibling, null, 'no repo here (tmpWork has no .git) ⇒ no sibling agent is invented');
  assert.equal(res.cancelled, false, 'a run nobody stopped is not reported as cancelled');

  // Every demo edit is strictly attributed — the scenario keeps a to-do in_progress for every edit.
  const m = core.buildChangeMap(ws, res.session, { root: ws });
  assert.ok(!('subtasks' in m), 'no display-subtask layer (0.8.8)');
  assert.ok(m.edits.every((e) => typeof e.taskId === 'string' && e.taskId.length > 0), 'every demo edit sits in a real strict interval');
  // Six task identities, but only five own edits: the sixth is left IN PROGRESS when the replay ends, so
  // the Tasks tab shows work under way rather than only a finished plan. Its in-progress span is a single
  // checkpoint and strict attribution needs a ts strictly inside a span, so it owns nothing — which is
  // why this rollup is unchanged by it, and why that is a fact worth pinning rather than a coincidence.
  assert.equal(m.tasks.length, 6, 'six strict task identities');
  assert.deepEqual(m.rollupByTask.filter((r) => r.taskId !== null).map((r) => r.edits).sort(), [1, 1, 2, 2, 2], 'and five of them claim 2/1/2/1/2 edits');
  assert.ok(m.rollupByTask.every((r) => r.taskId !== null), 'strict model: nothing unassigned either');
  const rows = core.sessionTaskRows(ws, res.session);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.filter((r) => r.status === 'in_progress').map((r) => r.subject), ['Tune the scaler for sparse columns'], 'exactly one is still under way');

  // The workflow is still in flight when the replay ends — a demo whose every panel shows only the
  // aftermath never shows what running work looks like. It decays to done on its own after five minutes.
  const wfLive = core.parseWorkflows(ws, res.session).find((w) => w.id === 'wf_demo');
  assert.equal(wfLive.running, true, 'the docs run is running');
  assert.deepEqual(wfLive.phaseGroups.map((p) => `${p.title} ${p.done}/${p.total}`), ['Outline 1/1', 'Docs 1/1', 'Review 0/1'], 'with its last phase in flight');

  // Subagent + workflow attribution ride the real windows.
  const subs = core.parseSubagents(ws, res.session);
  assert.equal(subs.length, 1, 'one subagent (the test writer)');
  assert.ok(subs[0].actions.some((a) => a.editId != null), 'its edit is window-attributed to a store record');
  assert.ok(m.workflows.some((w) => w.id === 'wf_demo' && w.rollup.edits === 1), 'the docs workflow owns one edit');
  const wfRun = core.parseWorkflows(ws, res.session).find((w) => w.id === 'wf_demo');
  assert.equal(wfRun.agents.length, 3, 'the docs run is multi-agent');
  assert.deepEqual(wfRun.phaseGroups.map((p) => p.title), ['Outline', 'Docs', 'Review'], 'and multi-phase, in runtime order');

  // The audited surfaces each need live data, or the panel that presents them can only ever render its
  // empty state in the demo — which is the one session anybody browses before installing anything.
  const log = core.readLog(res.session);
  assert.equal(log.filter((r) => r.afterBlob === null).length, 1, 'one DELETION (restore-on-undo, the deletion ghost)');
  assert.equal(log.filter((r) => r.tool === 'Bash').length, 1, 'captured by the Bash tree-diff path, and only that one file');
  assert.equal(m.edits.filter((e) => e.file.endsWith('features.py')).length, 2, 'features.py holds TWO independently reviewable units — undo one, keep the other');
  assert.ok(m.modules.some((x) => x.label === '(external)'), 'the outside-the-workspace write gets its own folder tile');
  const acts = core.parseActions(ws, res.session);
  assert.equal(acts.filter((a) => a.ok === false).length, 1, 'one FAILED tool call for the Actions error filter');
  assert.ok(acts[acts.length - 1].ok !== false, 'never trailing — a trailing error would phase the agent errored for the whole tour');
  assert.equal(core.outsideWrites(acts, ws).length, 1, 'the Risk audit has an outside-the-workspace write to report');
  assert.equal(core.sessionPrompts(ws, res.session).length, 3, 'three of YOUR asks — the Prompts window needs more than one row');
  const procs = core.sessionProcesses(ws, res.session);
  assert.equal(procs.length, 3, 'three background shells');
  assert.deepEqual(
    [procs.some((p) => p.running), procs.some((p) => p.exitCode === 0), procs.some((p) => p.exitCode === 1)],
    [true, true, true],
    'one running, one clean exit, one failure — every state the Processes tab renders'
  );

  // No-residue review: resolve everything → autoClearDemo drops the records; never for a real id.
  for (const r of core.readLog(res.session)) core.setStatus(res.session, r.id, 'kept');
  assert.equal(core.autoClearDemo(res.session), true, 'a fully reviewed demo session clears itself');
  assert.equal(core.readLog(res.session).length, 0, 'store is empty — panels read empty');
  assert.equal(core.autoClearDemo('11111111-2222-3333-4444-555555555555'), false, 'a real session id can never auto-clear');

  // demo --clean removes the transcript, the session tree, the store, the marked workspace, and the
  // scratch dir the one outside-the-workspace write landed in.
  assert.ok(fs.existsSync(path.join(res.scratch, 'profile-report.md')), 'the report is really out there before cleanup');
  const cleaned = core.cleanDemo({ cwd: ws });
  assert.deepEqual(cleaned.sessions, [res.session], 'exactly the demo session is removed');
  assert.deepEqual(cleaned.scratch, [res.scratch], 'and the scratch dir it wrote outside the workspace');
  assert.ok(!fs.existsSync(res.scratch), 'scratch gone');
  assert.ok(!fs.existsSync(res.transcript), 'transcript gone');
  assert.ok(!fs.existsSync(path.join(ws, 'observatory-demo')), 'workspace gone (it carried the marker)');
  // …and a workspace WITHOUT the marker is never deleted, even when pointed at directly.
  const precious = path.join(ws, 'precious');
  fs.mkdirSync(precious, { recursive: true });
  fs.writeFileSync(path.join(precious, 'keep.txt'), 'mine');
  core.cleanDemo({ cwd: ws, dir: precious });
  assert.ok(fs.existsSync(path.join(precious, 'keep.txt')), 'an unmarked directory is never touched');
});

test('tour: autoplay pacing is derived from the text, and clamped at both ends', () => {
  const steps = core.demoTour();
  const dwell = (body, extra = {}) => core.demoStepDwellMs({ id: 'x', title: 't', view: 'edits', body, ...extra });

  // Longer text holds longer — a flat timer would either outrun the dense steps or crawl through the
  // short ones, and these bodies run two to three sentences where the site demo's captions run one.
  assert.ok(dwell('x'.repeat(200)) < dwell('x'.repeat(400)), 'monotonic in length');
  assert.ok(dwell('x'.repeat(400)) < dwell('x'.repeat(600)) || dwell('x'.repeat(400)) === 9000, 'up to the ceiling');
  // Clamped, so nothing flashes past and nothing stalls.
  assert.equal(dwell('short'), 3500, 'the floor');
  assert.equal(dwell('x'.repeat(100000)), 9000, 'the ceiling');
  // The tip and the try line are on screen too, so they count toward the time to read the step.
  assert.ok(dwell('x'.repeat(100), { tip: 'y'.repeat(200) }) > dwell('x'.repeat(100)));

  // Every shipped step gets a real, bounded dwell — a zero would advance instantly and a NaN would hang.
  for (const s of steps) {
    const ms = core.demoStepDwellMs(s);
    assert.ok(Number.isFinite(ms) && ms >= 3500 && ms <= 9000, `${s.id}: ${ms}ms is in range`);
  }
  // And the whole thing is watchable in one sitting rather than a lunch break.
  const total = steps.reduce((n, s) => n + core.demoStepDwellMs(s), 0);
  assert.ok(total < 8 * 60_000, `the full tour plays in under eight minutes (${Math.round(total / 1000)}s)`);
  const short = core.demoTour('essentials').reduce((n, s) => n + core.demoStepDwellMs(s), 0);
  assert.ok(short < 3 * 60_000, `and the short track in under three (${Math.round(short / 1000)}s)`);

  // A wait step's grace before it applies itself — the same nine seconds the site's demo gives its gates.
  assert.equal(core.DEMO_ACTION_COUNTDOWN_MS, 9000);
});

test('tour: demoActionState decides for both editors, including when the demo clears itself', () => {
  const snap = (kept, undone, total, pending = Math.max(0, total - kept - undone)) => ({ kept, undone, pending, total });
  const S = core.demoActionState;

  // Nothing moved.
  assert.equal(S('keep-edit', snap(0, 0, 9), snap(0, 0, 9)), 'waiting');
  // The right counter moved.
  assert.equal(S('keep-edit', snap(0, 0, 9), snap(1, 0, 9)), 'satisfied');
  assert.equal(S('keep-prompt', snap(2, 0, 9), snap(5, 0, 9)), 'satisfied');
  assert.equal(S('keep-task', snap(0, 0, 9), snap(2, 0, 9)), 'satisfied');
  assert.equal(S('undo-edit', snap(0, 0, 9), snap(0, 1, 9)), 'satisfied');
  // The OTHER counter moving is not this step's action.
  assert.equal(S('keep-edit', snap(0, 0, 9), snap(0, 3, 9)), 'waiting');
  assert.equal(S('undo-edit', snap(0, 0, 9), snap(4, 0, 9)), 'waiting');

  // The case that matters. A fully reviewed demo DROPS its records, so `kept` falls to zero — a
  // decrease. A watcher that only looked for "kept went up" would hang exactly when the reader had
  // done the most work, so an emptied log is its own verdict.
  assert.equal(S('keep-edit', snap(4, 0, 9), snap(0, 0, 0)), 'vacated');
  assert.equal(S('undo-edit', snap(0, 2, 9), snap(0, 0, 0)), 'vacated');
  // …and a step armed against a session that never recorded anything resolves immediately rather than
  // waiting forever.
  assert.equal(S('keep-edit', snap(0, 0, 0), snap(0, 0, 0)), 'vacated');

  // …and the second shape of "nothing left to do here": everything resolved, but the records still
  // present (a real session, or a demo whose resolved edits were never cleared). "Accept an edit" then
  // has no edit left to accept, and a step that only watched for "kept went up" would hang forever.
  assert.equal(S('keep-edit', snap(4, 5, 9), snap(4, 5, 9)), 'vacated', 'nothing pending to accept');
  assert.equal(S('keep-prompt', snap(4, 5, 9), snap(4, 5, 9)), 'vacated');
  // Undo is deliberately NOT subject to that: a kept edit can still be reverted.
  assert.equal(S('undo-edit', snap(9, 0, 9), snap(9, 0, 9)), 'waiting', 'a kept edit is still undoable');

  // The kinds the editor performs are never armed as `wait`; if one ever were, waiting is the safe
  // answer — the panel's Skip is always live, so nobody can be trapped.
  assert.equal(S('toggle-spotlight', snap(0, 0, 9), snap(9, 9, 9)), 'waiting');
  assert.equal(S('open-demo-file', snap(0, 0, 9), snap(9, 9, 9)), 'waiting');
});

test('demo: the sibling agent makes a fleet — two rows of one repo, one live collision', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true }); // commonDir resolves ⇒ fleet correlation engages
  const res = await core.runDemo({ fast: true, cwd: ws });
  assert.match(res.sibling, /^demo-[0-9a-f]{8}$/, 'the sibling is simulator-owned too, so cleanup reaches it');

  // The sibling launches from the demo workspace, which walks UP to the SAME .git — a different
  // project dir, the same repo key. That is what puts two rows in one fleet without inventing a repo.
  const fleet = core.listRepoSiblings(ws, res.session);
  assert.equal(fleet.length, 2, 'two agents in this repo');
  const self = fleet.find((s) => s.self);
  const other = fleet.find((s) => !s.self);
  assert.equal(self.id, res.session);
  assert.equal(other.id, res.sibling);
  assert.equal(other.gitBranch, 'demo/hotfix', 'its branch comes from its transcript, not from git');
  assert.notEqual(self.worktree, other.worktree, 'and they report different worktrees');
  assert.ok(!fs.existsSync(path.join(res.workspace, '.git')), 'no .git is fabricated inside the demo workspace');

  // The collision the Fleet badge shows: the SAME absolute path pending on both sides.
  const hits = core.fleetConflicts(fleet);
  assert.equal(hits.length, 1, 'exactly one live collision');
  assert.equal(hits[0].file, path.join(res.workspace, 'src', 'features.py'));
  assert.deepEqual([...hits[0].agents].sort(), [res.session, res.sibling].sort(), 'both agents are named, with no winner picked');

  // Cleanup reaches across BOTH project dirs, and takes the sibling's with it.
  const cleaned = core.cleanDemo({ cwd: ws });
  assert.deepEqual([...cleaned.sessions].sort(), [res.session, res.sibling].sort(), 'both sessions removed');
  assert.ok(!fs.existsSync(core.projectDir(res.workspace)), "the sibling's project dir goes too — it existed only for the demo");
  assert.equal(core.listSessions().length, 0, 'nothing left in the store');
});

test('demo: starting again RESETS — a replay replaces the previous demo, it does not stack on it', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  const first = await core.runDemo({ fast: true, cwd: ws });
  // Review some of it and edit a demo file, the way a presenter would before showing it again.
  core.setStatus(first.session, core.readLog(first.session)[0].id, 'kept');
  fs.writeFileSync(path.join(first.workspace, 'src', 'train.py'), '# scribbled on mid-demo\n');

  const second = await core.runDemo({ fast: true, cwd: ws });
  assert.notEqual(second.session, first.session, 'a fresh session id');
  assert.equal(core.listSessions().length, 1, 'and the previous demo is GONE, not sitting beside it');
  assert.equal(core.listSessions()[0].id, second.session);
  assert.equal(core.readLog(second.session).filter((r) => r.status !== 'pending').length, 0, 'every edit is pending again');
  assert.ok(!fs.readFileSync(path.join(second.workspace, 'src', 'train.py'), 'utf8').includes('scribbled'), 'and the workspace is re-seeded from scratch');

  // The opt-out is there for a caller that deliberately wants two.
  const third = await core.runDemo({ fast: true, cwd: ws, reset: false });
  assert.equal(core.listSessions().length, 2, 'reset:false stacks instead');
  assert.ok([second.session, third.session].every((id) => core.listSessions().some((s) => s.id === id)));
  core.cleanDemo({ cwd: ws });
});

test('demo: the workspace hides itself from git, and a stranded one stays findable', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  const res = await core.runDemo({ fast: true, cwd: ws });

  // The demo writes into the reader's OWN repository. A self-ignoring .gitignore keeps it out of their
  // `git status` and out of `git add -A`, without touching a file they own.
  const ignore = fs.readFileSync(path.join(res.workspace, '.gitignore'), 'utf8');
  assert.match(ignore, /^\*$/m, 'the demo folder ignores itself');

  // A demo must stay findable after session resolution moves on — otherwise the only way out of demo
  // mode disappears the moment the reader talks to Claude again, and the folder is stranded.
  assert.deepEqual(core.demoSessionsFor({ cwd: ws }).sort(), [res.session, res.sibling].filter(Boolean).sort());
  fs.writeFileSync(
    path.join(core.projectDir(ws), '11111111-2222-3333-4444-555555555555.jsonl'),
    JSON.stringify({ type: 'assistant', cwd: ws, message: { role: 'assistant', content: [] } }) + '\n'
  );
  assert.notEqual(core.resolveSessionId(ws), res.session, 'a newer real session is now what resolves');
  assert.ok(core.demoSessionsFor({ cwd: ws }).includes(res.session), 'but the demo is still findable, so Exit can still be offered');

  core.cleanDemo({ cwd: ws });
  assert.deepEqual(core.demoSessionsFor({ cwd: ws }), [], 'and gone once removed');
});

test('demo: it will not adopt — and therefore cannot delete — a directory it did not create', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  // A mistyped --dir used to be catastrophic: the demo planted its sentinel in whatever directory was
  // named, seeded raw over any file whose path the scenario reuses, and then — because a run RESETS —
  // the very next run rm -rf'd the whole thing. The sentinel has to prove prior ownership, not create it.
  const mine = path.join(ws, 'mywork');
  fs.mkdirSync(path.join(mine, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(mine, 'notes', 'thesis.txt'), 'my thesis');
  fs.writeFileSync(path.join(mine, 'src-placeholder'), 'mine');
  await assert.rejects(() => core.runDemo({ fast: true, cwd: ws, dir: mine }), /refusing to use/);
  assert.equal(fs.readFileSync(path.join(mine, 'notes', 'thesis.txt'), 'utf8'), 'my thesis', 'not one byte written');
  assert.ok(!fs.existsSync(path.join(mine, '.observatory-demo')), 'and no sentinel planted to authorize a later delete');

  // An EMPTY directory is fine — the demo creates its own content there and owns it from then on.
  const empty = path.join(ws, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const res = await core.runDemo({ fast: true, cwd: ws, dir: empty });
  assert.equal(res.workspace, fs.realpathSync(empty));
  // …and re-running is a reset, not a refusal, because it now carries the sentinel.
  await core.runDemo({ fast: true, cwd: ws, dir: empty });
  core.cleanDemo({ cwd: ws, dir: empty });
  assert.ok(!fs.existsSync(empty), 'a demo-owned directory is reclaimed');
});

test('demo: a symlinked workspace resolves to ONE project dir, so the sibling is never orphaned', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  // The sibling records under projectDir(workspace), and a project dir is a mangling of the path
  // STRING — so resolving the workspace one way here and another way in cleanup mints two project dirs
  // and strands the sibling where no command can reach it, while --clean reports success.
  const real = path.join(ws, 'real');
  const link = path.join(ws, 'link');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(real, link);
  const res = await core.runDemo({ fast: true, cwd: ws, dir: link });
  assert.ok(res.sibling, 'the sibling was created');
  assert.deepEqual(core.demoSessionsFor({ cwd: ws, dir: link }).sort(), [res.session, res.sibling].sort(), 'and is findable through the link');
  // Both transcripts through the link, plus the workflow state file — the point is that the link and the
  // real path resolve to ONE project dir, so nothing is stranded where no command can reach it.
  const beat = core.demoHeartbeat({ cwd: ws, dir: link });
  assert.equal(beat.filter((f) => f.endsWith('.jsonl')).length, 2, 'the heartbeat reaches both agents, so the fleet stays live');
  const cleaned = core.cleanDemo({ cwd: ws, dir: link });
  assert.deepEqual([...cleaned.sessions].sort(), [res.session, res.sibling].sort(), 'and cleanup removes both');
  assert.equal(core.listSessions().length, 0, 'nothing stranded');
});

test('demo: --no-fleet writes exactly one session', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true }); // a repo IS resolvable — the opt-out is what declines
  const res = await core.runDemo({ fast: true, cwd: ws, fleet: false });
  assert.equal(res.sibling, null);
  assert.equal(core.listRepoSiblings(ws, res.session).length, 1, 'just this session');
  core.cleanDemo({ cwd: ws });
});

test('demo: shouldStop halts at a beat boundary and the partial run still cleans up', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  let beats = 0;
  const res = await core.runDemo({ fast: true, cwd: ws, log: () => beats++, shouldStop: () => beats >= 4 });
  assert.equal(res.cancelled, true, 'the result says it was stopped, rather than looking like a short scenario');
  assert.ok(res.steps < 10, 'it really stopped early');
  assert.ok(res.edits < 9, 'so not every edit landed');
  // Whatever DID land is real and reviewable — and removable.
  const cleaned = core.cleanDemo({ cwd: ws });
  assert.deepEqual(cleaned.sessions, [res.session]);
  assert.ok(!fs.existsSync(path.join(ws, 'observatory-demo')), 'a cancelled run leaves no more residue than a complete one');
});

test('demoHeartbeat: bumps every demo transcript and writes nothing', async () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  const res = await core.runDemo({ fast: true, cwd: ws });
  // Backdate both transcripts past the 60s fleet-active window — the state a tour reaches mid-explanation.
  const stale = new Date(Date.now() - 5 * 60 * 1000);
  const paths = [res.transcript, path.join(core.projectDir(res.workspace), `${res.sibling}.jsonl`)];
  const sizes = paths.map((p) => fs.statSync(p).size);
  for (const p of paths) fs.utimesSync(p, stale, stale);
  assert.equal(core.listRepoSiblings(ws, res.session).filter((s) => s.active).length, 0, 'both have gone idle');

  const touched = core.demoHeartbeat({ cwd: ws });
  for (const p of paths) assert.ok(touched.includes(p), 'both demo transcripts, across both project dirs');
  // …and the workflow run's state file, which is what holds the in-flight run inside its own window.
  // ONLY that file: the agent transcripts beside it are watched by the editors, so bumping those would
  // give the heartbeat a self-retriggering loop.
  const stateFile = touched.find((p) => p.endsWith('.json'));
  assert.match(stateFile ?? '', /workflows[/\\]wf_demo\.json$/, 'the workflow state file too');
  assert.equal(touched.filter((p) => p.includes(`${path.sep}subagents${path.sep}`)).length, 0, 'and nothing under subagents/, which the editors watch');
  assert.deepEqual(paths.map((p) => fs.statSync(p).size), sizes, 'touch only — no line is appended and no activity is invented');
  assert.equal(core.listRepoSiblings(ws, res.session).filter((s) => s.active).length, 2, 'and the fleet is live again');
  assert.equal(core.fleetConflicts(core.listRepoSiblings(ws, res.session)).length, 1, 'so the collision badge is back');
  core.cleanDemo({ cwd: ws });
});

test('tour: demoTour is a complete, well-formed script for both editors', () => {
  const steps = core.demoTour();
  const VIEWS = new Set(['overview', 'prompts', 'stats', 'edits', 'diffs', 'fileHistory', 'actions', 'observations', 'editor']);
  const TABS = ['sessions', 'fleet', 'workflows', 'tasks', 'processes'];
  const ANCHORS = new Set([
    'nav-tabs', 'folders-strip', 'files-ledger', 'summary-bar', 'feed', 'nav-axes', 'accept-prompt',
    'session-label', 'spotlight', 'prompts-list',
    'stats-model', 'stats-compaction', 'stats-tokens', 'stats-cache', 'stats-usage', 'stats-review',
  ]);
  assert.ok(steps.length >= 15, 'a tour of every surface is not a handful of steps');
  assert.equal(new Set(steps.map((s) => s.id)).size, steps.length, 'ids are unique — both editors key on them');
  for (const s of steps) {
    assert.match(s.id, /^[a-z][a-z0-9-]*$/, `${s.id}: kebab id`);
    assert.ok(s.title && s.title.length <= 60, `${s.id}: a title that fits a panel header`);
    assert.ok(s.body && s.body.length >= 40, `${s.id}: a body that says something`);
    assert.ok(!/[<>`]|\*\*/.test(s.body), `${s.id}: plain text — a webview and a Swing label must render it alike`);
    assert.ok(VIEWS.has(s.view), `${s.id}: names a real view`);
    assert.equal(s.view === 'overview', TABS.includes(s.tab), `${s.id}: a tab iff it is an Overview step`);
    if (s.anchor) assert.ok(ANCHORS.has(s.anchor), `${s.id}: anchors must be mappable by both editors`);
    if (s.tip) assert.ok(s.tip.length <= 90, `${s.id}: a tip has to fit beside the thing it describes`);
  }
  // The whole point of the tour: no shipped surface goes unexplained. EVERY view the type admits must
  // have a step — a panel with no step is a panel nobody is told about, and `diffs` was exactly that.
  for (const tab of TABS) assert.ok(steps.some((s) => s.tab === tab), `the Overview's ${tab} tab is explained`);
  for (const view of VIEWS) assert.ok(steps.some((s) => s.view === view), `the ${view} surface is explained`);

  // Action steps: the shape rules that keep the two labels honest.
  const KINDS = new Set(['keep-edit', 'undo-edit', 'keep-prompt', 'keep-task', 'open-demo-file', 'toggle-spotlight']);
  const acts = steps.filter((s) => s.action);
  assert.ok(acts.length >= 4, 'the tour asks the reader to do things');
  for (const s of acts) {
    assert.ok(s.action.mode === 'wait' || s.action.mode === 'auto', `${s.id}: a known mode`);
    assert.ok(KINDS.has(s.action.kind), `${s.id}: a kind both editors can implement`);
    assert.ok(s.action.hint && s.action.hint.length <= 110, `${s.id}: a hint that fits one line`);
    assert.equal(s.action.mode === 'auto', !!s.action.done, `${s.id}: a past-tense line iff the tour did it itself`);
    // Two "do this" lines on one step is exactly the inconsistency the two labels exist to avoid.
    assert.ok(!s.tryIt, `${s.id}: an action step carries no tryIt`);
  }
  for (const mode of ['wait', 'auto']) {
    assert.ok(acts.some((s) => s.action.mode === mode), `the full tour has a ${mode} step`);
    assert.ok(core.demoTour('essentials').some((s) => s.action?.mode === mode), `and so does the short track, so both labels teach themselves`);
  }

  // The short track is a FILTER over the same list, not a second script — so the two can never tell
  // different stories, and a step can never appear in the short tour but not the long one.
  const essentials = core.demoTour('essentials');
  const ids = steps.map((s) => s.id);
  assert.ok(essentials.length >= 8 && essentials.length < steps.length, 'a genuinely shorter track');
  assert.deepEqual(essentials.map((s) => s.id), ids.filter((id) => essentials.some((e) => e.id === id)), 'same order, no reshuffling');
  for (const e of essentials) assert.deepEqual(steps.find((s) => s.id === e.id), e, 'and identical content, not a paraphrase');
  assert.deepEqual(core.demoTour(), steps, 'the default track is everything');
  // The remainder is the exact complement, so finishing the short track can RESUME rather than restart.
  const remainder = core.demoTour('remainder');
  assert.deepEqual(
    [...essentials, ...remainder].map((s) => s.id).sort(),
    ids.slice().sort(),
    'essentials ∪ remainder === everything'
  );
  assert.equal(essentials.filter((e) => remainder.some((r) => r.id === e.id)).length, 0, 'and they are disjoint');
  assert.deepEqual(remainder.map((s) => s.id), ids.filter((id) => !essentials.some((e) => e.id === id)), 'remainder keeps script order');
  assert.deepEqual(core.demoTrackSizes(), { essentials: essentials.length, remainder: remainder.length, everything: steps.length });
  for (const t of ['essentials', 'remainder', 'everything']) {
    assert.match(core.demoTrackBlurb(t), /\S.*\.$/, `${t} has a closing sentence`);
  }
  // Every anchor the type admits is used by some step, and each name belongs to exactly ONE panel —
  // the editors broadcast an anchor to every tour-aware panel, so a shared name would ring two things.
  const used = steps.filter((s) => s.anchor).map((s) => s.anchor);
  for (const a of ANCHORS) assert.ok(used.includes(a), `the ${a} anchor is named by a step`);
  const panelOf = (a) => (a.startsWith('stats-') ? 'stats' : a === 'prompts-list' ? 'prompts' : 'overview');
  const byName = new Map();
  for (const a of used) {
    const p = panelOf(a);
    if (byName.has(a)) assert.equal(byName.get(a), p, `${a} is owned by one panel`);
    byName.set(a, p);
  }
  assert.equal(new Set(used).size, byName.size, 'no anchor name is shared between panels');
  // The short track still has to be a coherent product story on its own.
  for (const view of ['overview', 'prompts', 'edits', 'editor', 'actions']) {
    assert.ok(essentials.some((s) => s.view === view), `the short track still reaches ${view}`);
  }
});

// --- session resolution: stub transcripts must never hijack the current session ------------------
// Local commands (/effort, /model) and bridge-session records write transcript .jsonl files that
// never gain an assistant record. They must not win newest-mtime resolution over the real session.

function writeResolverTranscript(proj, id, lines, mtimeMs) {
  const p = path.join(proj, id + '.jsonl');
  fs.writeFileSync(p, lines.map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}
function realLines(id, cwd) {
  return [
    { type: 'user', sessionId: id, cwd, message: { role: 'user', content: 'do the thing' } },
    { type: 'assistant', sessionId: id, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  ];
}
function effortStubLines(id, cwd) {
  // faithful to a real /effort stub: user records WITH a cwd line, no assistant record ever
  return [
    { type: 'user', sessionId: id, cwd, message: { role: 'user', content: '<local-command-caveat>Caveat: local commands</local-command-caveat>' } },
    { type: 'user', sessionId: id, cwd, message: { role: 'user', content: '<command-name>/effort</command-name>' } },
    { type: 'user', sessionId: id, cwd, message: { role: 'user', content: '<local-command-stdout>Set effort level to xhigh</local-command-stdout>' } },
  ];
}

test('session: /effort-style command-only stub (with cwd) never hijacks resolution', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const T = Date.now();
  writeResolverTranscript(proj, 'real-one', realLines('real-one', cwd), T);
  writeResolverTranscript(proj, 'effort-stub', effortStubLines('effort-stub', cwd), T + 5000); // stub is NEWER
  assert.equal(core.resolveSessionId(cwd), 'real-one', 'newer command-only stub is skipped');
});

test('session: bridge-session stub never hijacks resolution', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const T = Date.now();
  writeResolverTranscript(proj, 'real-one', realLines('real-one', cwd), T);
  writeResolverTranscript(proj, 'bridge', [{ type: 'bridge-session', sessionId: 'bridge', bridgeSessionId: 'cse_x', lastSequenceNum: 0 }], T + 5000);
  assert.equal(core.resolveSessionId(cwd), 'real-one', 'bridge stub is skipped');
});

test('session: when ALL transcripts are assistant-less, fall back to the newest (never regress)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const T = Date.now();
  writeResolverTranscript(proj, 'older-stub', effortStubLines('older-stub', cwd), T);
  writeResolverTranscript(proj, 'newer-stub', effortStubLines('newer-stub', cwd), T + 5000);
  assert.equal(core.resolveSessionId(cwd), 'newer-stub', 'first-turn-in-flight project still resolves');
});

test('session: a growing transcript flips from skipped to selected once the first assistant record lands', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const T = Date.now();
  writeResolverTranscript(proj, 'real-old', realLines('real-old', cwd), T);
  // brand-new session: user prompt written, Claude has not replied yet
  const newP = writeResolverTranscript(proj, 'real-new', [
    { type: 'user', sessionId: 'real-new', cwd, message: { role: 'user', content: 'fresh prompt' } },
  ], T + 5000);
  assert.equal(core.resolveSessionId(cwd), 'real-old', 'not-yet-replied session defers to previous real session');
  // first assistant record lands (append -> mtime+size change invalidates the negative cache)
  fs.appendFileSync(newP, JSON.stringify({ type: 'assistant', sessionId: 'real-new', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } }) + '\n');
  fs.utimesSync(newP, new Date(T + 10000), new Date(T + 10000));
  assert.equal(core.resolveSessionId(cwd), 'real-new', 'resolution flips to the new session on first reply');
});

test('session: pasted content containing "type":"assistant" inside a user record does not count', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const T = Date.now();
  writeResolverTranscript(proj, 'real-one', realLines('real-one', cwd), T);
  writeResolverTranscript(proj, 'tricky-stub', [
    { type: 'user', sessionId: 'tricky-stub', cwd, message: { role: 'user', content: 'look at this jsonl: {"type":"assistant","message":{}}' } },
  ], T + 5000);
  assert.equal(core.resolveSessionId(cwd), 'real-one', 'substring inside pasted content is parse-rejected');
});

test('diagnose: no-assistant-yet session gets honest advice, never "restart Claude Code"', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const work = tmpWork();
  const byId = (checks, id) => checks.find((c) => c.id === id);
  core.installHooks('claude-observatory capture #' + core.HOOK_MARKER, core.settingsPath());

  // Only a command-only stub resolves (fresh project, /effort ran first): hooks must not be blamed.
  const proj = core.projectDir(work);
  fs.mkdirSync(proj, { recursive: true });
  writeResolverTranscript(proj, 'stub-only', effortStubLines('stub-only', work), Date.now());
  let checks = core.diagnose({ cwd: work, binOnPath: true, jqPresent: true });
  let c = byId(checks, 'session');
  assert.equal(c.level, 'warn');
  assert.match(c.detail, /no assistant reply yet/, 'names the real state');
  assert.match(c.fix, /hooks are fine/i, 'does not blame the hooks');
  assert.doesNotMatch(c.fix, /restart Claude Code/, 'no bogus restart advice for a stub');

  // A real session with zero edits keeps the fresh/read-only framing first.
  writeResolverTranscript(proj, 'real-one', realLines('real-one', work), Date.now() + 5000);
  checks = core.diagnose({ cwd: work, binOnPath: true, jqPresent: true });
  c = byId(checks, 'session');
  assert.equal(c.level, 'warn');
  assert.match(c.fix, /Normal for a fresh or read-only session/, 'fresh real session is not an error state');
});

// --- bash capture stat-cache memo: stat-only steady state, GC self-heal, racy-clean guard ---------

function bashHook(session, cwd, event) {
  core.handleHookPayload({ session_id: session, cwd, tool_name: 'Bash', tool_input: { command: 'x' }, hook_event_name: event });
}
const blobCount = (S) => fs.readdirSync(path.join(core.storeDir(S), 'blobs')).length;

test('capture: bash memo — steady-state Pre is stat-only (zero file reads, zero new blobs)', () => {
  freshHome();
  const S = 'memo1';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'alpha\n');
  fs.writeFileSync(path.join(cwd, 'b.bin'), Buffer.from([0, 1, 2, 0, 3])); // binary — negative verdict must be cached too
  // Age the files out of the racily-clean epsilon: files touched within ~2s of a cache write are
  // deliberately re-read (git's rule); steady state means files older than that.
  const aged = new Date(Date.now() - 10_000);
  fs.utimesSync(path.join(cwd, 'a.txt'), aged, aged);
  fs.utimesSync(path.join(cwd, 'b.bin'), aged, aged);
  bashHook(S, cwd, 'PreToolUse');
  bashHook(S, cwd, 'PostToolUse'); // no changes — warms the cache for the next call
  const blobsAfterFirst = blobCount(S);

  // Count reads of workdir files during the second Pre: the memo must not read ANY of them.
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && p.startsWith(cwd + path.sep)) reads++;
    return realRead.call(fs, p, ...rest);
  };
  try {
    bashHook(S, cwd, 'PreToolUse');
  } finally {
    fs.readFileSync = realRead;
  }
  assert.equal(reads, 0, 'unchanged tree: no candidate file is read (binary included)');
  assert.equal(blobCount(S), blobsAfterFirst, 'no new blobs on a warm Pre');
  assert.ok(core.readBashManifest(S), 'manifest still written from cached hashes');
  core.deleteBashManifest(S);
});

test('capture: bash memo self-heals a GC-collected blob (no dangling beforeBlob ever)', () => {
  freshHome();
  const S = 'memo2';
  const cwd = tmpWork();
  const F = path.join(cwd, 'f.txt');
  fs.writeFileSync(F, 'v1\n');
  bashHook(S, cwd, 'PreToolUse');
  bashHook(S, cwd, 'PostToolUse'); // cache warm, blob for v1 exists but is manifest-orphaned
  // Simulate routine GC: remove ALL blobs (nothing references them — the log is empty).
  const bdir = path.join(core.storeDir(S), 'blobs');
  for (const b of fs.readdirSync(bdir)) fs.unlinkSync(path.join(bdir, b));
  // Next command changes the file: Pre must re-write the before-blob despite the warm cache.
  bashHook(S, cwd, 'PreToolUse');
  fs.writeFileSync(F, 'v2\n');
  bashHook(S, cwd, 'PostToolUse');
  const rec = core.readLog(S).find((r) => r.file === F && r.afterBlob !== null);
  assert.ok(rec, 'the change was recorded');
  assert.ok(rec.beforeBlob, 'record carries a before-blob');
  assert.ok(fs.existsSync(path.join(bdir, rec.beforeBlob)), 'beforeBlob content exists on disk (undo works)');
  assert.ok(fs.existsSync(path.join(bdir, rec.afterBlob)), 'afterBlob content exists on disk');
});

test('capture: bash deletion detection survives the memo', () => {
  freshHome();
  const S = 'memo3';
  const cwd = tmpWork();
  const F = path.join(cwd, 'gone.txt');
  fs.writeFileSync(F, 'bye\n');
  bashHook(S, cwd, 'PreToolUse');
  bashHook(S, cwd, 'PostToolUse'); // warm
  bashHook(S, cwd, 'PreToolUse');
  fs.unlinkSync(F);
  bashHook(S, cwd, 'PostToolUse');
  const rec = core.readLog(S).find((r) => r.file === F);
  assert.ok(rec, 'deletion recorded');
  assert.equal(rec.afterBlob, null, 'deletion has null afterBlob');
  assert.ok(fs.existsSync(path.join(core.storeDir(S), 'blobs', rec.beforeBlob)), 'restore content preserved');
});

test('capture: racily-clean same-size rewrite inside the epsilon is still detected', () => {
  freshHome();
  const S = 'memo4';
  const cwd = tmpWork();
  const F = path.join(cwd, 'r.txt');
  fs.writeFileSync(F, 'AAAA\n');
  const st0 = fs.statSync(F);
  bashHook(S, cwd, 'PreToolUse'); // cache written NOW; F's mtime is within the 2s epsilon
  // Same-size rewrite with the ORIGINAL mtime restored — (mtimeMs,size) alone cannot see this.
  fs.writeFileSync(F, 'BBBB\n');
  fs.utimesSync(F, st0.atime, st0.mtime);
  bashHook(S, cwd, 'PostToolUse');
  const rec = core.readLog(S).find((r) => r.file === F);
  assert.ok(rec, 'epsilon re-hash caught the same-size same-mtime rewrite');
});

test('clean: stub-session husks are reclaimed; live and reviewed sessions are untouched', () => {
  freshHome();
  // A stub husk: blobs from a Bash walk, no log ever (the /effort-session shape).
  const STUB = 'stub-husk';
  core.ensureStore(STUB);
  core.writeBlob(STUB, Buffer.from('walk snapshot A'));
  core.writeBlob(STUB, Buffer.from('walk snapshot B'));
  // A live first-turn session: bash manifest in staging (command running right now).
  const LIVE = 'live-midbash';
  core.ensureStore(LIVE);
  const liveBlob = core.writeBlob(LIVE, Buffer.from('before content'));
  core.writeBashManifest(LIVE, { files: { '/w/f.txt': liveBlob }, ts: Date.now() });
  // A real session with a reviewable edit.
  const REAL = 'real-edits';
  seedEdit(REAL, '/w/app.js', 'a\n', 'b\n');

  for (const id of core.allStoreSessionIds()) {
    core.gcSession(id);
    core.pruneEmptySession(id);
  }
  assert.ok(!fs.existsSync(core.storeDir(STUB)), 'stub husk removed entirely');
  assert.ok(fs.existsSync(core.storeDir(LIVE)), 'mid-bash session kept');
  assert.ok(core.readBashManifest(LIVE), 'its manifest survives');
  assert.ok(fs.existsSync(path.join(core.storeDir(LIVE), 'blobs', liveBlob)), 'its before-blob survives (manifest-referenced)');
  assert.equal(core.readLog(REAL).length, 1, 'reviewed session untouched');
  core.deleteBashManifest(LIVE);
});

// --- round-2 sweep: shared predicates, formatting, bin resolution, and the UTF-8 merge guard -------

test('filter: matchesQuery — case-insensitive substring; empty/whitespace query matches all', () => {
  assert.equal(core.matchesQuery('src/Foo Bar.ts', 'foo'), true);
  assert.equal(core.matchesQuery('src/Foo Bar.ts', 'BAR'), true);
  assert.equal(core.matchesQuery('src/Foo Bar.ts', 'baz'), false);
  assert.equal(core.matchesQuery('anything', ''), true);
  assert.equal(core.matchesQuery('anything', '   '), true, 'whitespace-only query matches all');
});

test('format: relTime boundaries incl. the new week/month buckets', () => {
  const now = 1_784_300_000_000;
  const at = (deltaSec) => core.relTime(now - deltaSec * 1000, now);
  assert.equal(at(59), '59s ago');
  assert.equal(at(60), '1m ago');
  assert.equal(at(59 * 60), '59m ago');
  assert.equal(at(60 * 60), '1h ago');
  assert.equal(at(23 * 3600), '23h ago');
  assert.equal(at(24 * 3600), '1d ago');
  assert.equal(at(13 * 86400), '13d ago');
  assert.equal(at(14 * 86400), '2w ago', 'days cap at 13, then weeks');
  assert.equal(at(60 * 86400), '8w ago');
  assert.equal(at(62 * 86400), '2mo ago', 'weeks cap at ~2 months, then months');
  assert.equal(core.relTime(now + 5000, now), '0s ago', 'future timestamps clamp to zero');
});

test('analyze: resolveClaudeBin precedence — configured > env > well-known paths > bare name', () => {
  const home = freshHome();
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bin-'));
  const fakeBin = path.join(fakeDir, 'claude');
  fs.writeFileSync(fakeBin, '#!/bin/sh\n', { mode: 0o755 });
  const OLD = process.env.CLAUDE_BIN;
  try {
    process.env.CLAUDE_BIN = fakeBin;
    assert.equal(core.resolveClaudeBin('/configured/claude-not-on-disk'), fakeBin,
      'a configured path that does not exist falls through to the env candidate');
    assert.equal(core.resolveClaudeBin(fakeBin), fakeBin, 'an existing configured path wins outright');
    delete process.env.CLAUDE_BIN;
    // fresh HOME has no ~/.local/bin etc. candidates; may still find a real system claude —
    // accept either the bare-name fallback or an absolute existing path, never a bogus one.
    const got = core.resolveClaudeBin();
    assert.ok(got === 'claude' || fs.existsSync(got), `fallback is PATH name or a real file (got ${got})`);
  } finally {
    if (OLD === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = OLD;
  }
});

test('tasks: taskSnaps anchors a create via its result text, then snapshots each update', () => {
  freshHome();
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-tx-'));
  const tx = path.join(proj, 't.jsonl');
  fs.writeFileSync(tx, [
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-17T10:00:00Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'TaskCreate', input: { subject: 'Fix the parser', description: '' } },
    ] } }),
    // the assigned id only appears in the tool_result text — the mining anchors on it
    JSON.stringify({ type: 'user', timestamp: '2026-07-17T10:00:01Z', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'Task #1 created successfully: Fix the parser' },
    ] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-17T10:00:02Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 't2', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } },
    ] } }),
  ].join('\n'));
  const snaps = core.taskSnaps(tx);
  assert.equal(snaps.length, 2, 'one snapshot at create-result, one at update');
  assert.equal(snaps[0].todos[0].content, 'Fix the parser');
  assert.equal(snaps[0].todos[0].status, 'pending');
  assert.equal(snaps[1].todos[0].status, 'completed', 'update snapshot reflects the new status');
  assert.equal(snaps[1].todos[0].src, 'task', 'task-born items are marked so ribbons skip them');
});

test('undo: non-UTF-8 file on the MERGE path refuses (conflict) instead of corrupting to U+FFFD', () => {
  freshHome();
  const S = 'latin1';
  const F = path.join(tmpWork(), 'legacy.txt');
  // Latin-1 content: "caf<0xE9>\n" — not valid UTF-8, but capturable (isBinary only screens NUL).
  const v1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x41, 0x0a]); // café\nA\n
  const v2 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x42, 0x0a]); // café\nB\n  (edit #1: A->B)
  const v3 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x42, 0x0a, 0x43, 0x0a]); // + C\n (edit #2)
  core.ensureStore(S);
  const b1 = core.writeBlob(S, v1), b2 = core.writeBlob(S, v2), b3 = core.writeBlob(S, v3);
  core.appendLog(S, { ts: 1000, tool: 'Edit', file: F, beforeBlob: b1, afterBlob: b2, status: 'pending' });
  core.appendLog(S, { ts: 2000, tool: 'Edit', file: F, beforeBlob: b2, afterBlob: b3, status: 'pending' });
  fs.writeFileSync(F, v3);
  const res = core.undoEdit(S, 1); // later edit #2 exists -> merge path
  assert.equal(res.status, 'conflict', 'non-UTF-8 merge refuses rather than rewrites');
  assert.ok(Buffer.compare(fs.readFileSync(F), v3) === 0, 'file bytes untouched — 0xE9 preserved');
  // The byte-exact escape hatch still works: whole-file restore (drops later edits, raw bytes).
  const forced = core.restoreFile(S, 1);
  assert.ok(forced.ok, 'force restore succeeds');
  assert.ok(Buffer.compare(fs.readFileSync(F), v1) === 0, 'restore path is byte-exact (0xE9 intact)');
});

test('undo: valid multibyte UTF-8 (emoji/CJK) still merges on the surgical path', () => {
  freshHome();
  const S = 'utf8ok';
  const F = path.join(tmpWork(), 'i18n.txt');
  const v1 = '日本語 🎉\nline A\n';
  const v2 = '日本語 🎉\nline B\n';   // edit #1: A->B
  const v3 = '日本語 🎉\nline B\nline C 世界\n'; // edit #2: append (different line)
  core.ensureStore(S);
  const b1 = core.writeBlob(S, Buffer.from(v1)), b2 = core.writeBlob(S, Buffer.from(v2)), b3 = core.writeBlob(S, Buffer.from(v3));
  core.appendLog(S, { ts: 1000, tool: 'Edit', file: F, beforeBlob: b1, afterBlob: b2, status: 'pending' });
  core.appendLog(S, { ts: 2000, tool: 'Edit', file: F, beforeBlob: b2, afterBlob: b3, status: 'pending' });
  fs.writeFileSync(F, v3);
  const res = core.undoEdit(S, 1); // merge path (later edit #2 exists)
  assert.equal(res.status, 'undone', 'valid multibyte content merges — round-trip guard does not false-positive');
  const after = fs.readFileSync(F, 'utf8');
  assert.ok(after.includes('line A'), 'edit #1 undone');
  assert.ok(after.includes('line C 世界'), 'later edit #2 preserved');
  assert.ok(after.includes('🎉'), 'emoji intact');
});

test('diagnose: a broken/looping symlink does not suppress the warning for a real symlinked dir', () => {
  freshHome();
  const work = tmpWork();
  core.installHooks('claude-observatory capture #' + core.HOOK_MARKER, core.settingsPath());
  const realDir = path.join(work, 'realpkg');
  fs.mkdirSync(realDir, { recursive: true });
  fs.symlinkSync(realDir, path.join(work, 'goodlink'), 'dir');   // genuine symlinked dir -> should warn
  fs.symlinkSync(path.join(work, 'nowhere'), path.join(work, 'deadlink')); // dangling -> statSync throws
  const checks = core.diagnose({ cwd: work, binOnPath: true, jqPresent: true });
  const c = checks.find((x) => x.id === 'symlink-subtrees');
  assert.ok(c, 'the symlink warning still fires despite a sibling broken link');
  assert.match(c.detail, /goodlink/, 'names the real symlinked directory');
});

test('undo: an oversized current file routes to conflict instead of throwing', () => {
  freshHome();
  const S = 'huge';
  const F = path.join(tmpWork(), 'big.txt');
  core.ensureStore(S);
  const b1 = core.writeBlob(S, Buffer.from('a\n')), b2 = core.writeBlob(S, Buffer.from('b\n'));
  const b3 = core.writeBlob(S, Buffer.from('c\n'));
  core.appendLog(S, { ts: 1000, tool: 'Edit', file: F, beforeBlob: b1, afterBlob: b2, status: 'pending' });
  core.appendLog(S, { ts: 2000, tool: 'Edit', file: F, beforeBlob: b2, afterBlob: b3, status: 'pending' });
  // Real Buffer whose toString('utf8') throws — simulates a >512MB file without allocating one.
  const realRead = fs.readFileSync;
  const throwing = Buffer.from('c\n');
  throwing.toString = () => { throw new RangeError('Cannot create a string longer than 0x1fffffe8 characters'); };
  fs.readFileSync = (p, ...rest) => (p === F ? throwing : realRead(p, ...rest));
  try {
    const res = core.undoEdit(S, 1);
    assert.equal(res.status, 'conflict', 'oversized file degrades to conflict, no throw');
  } finally {
    fs.readFileSync = realRead;
  }
});

test('actions: agentPhase counts child agent activity — a live agent fleet keeps the session working (0.8.6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'childphase';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = path.join(proj, S + '.jsonl');
  // A COMPLETED turn (assistant spoke, no tool call), long stale => classifies done on its own.
  fs.writeFileSync(tx, JSON.stringify({ timestamp: '2026-07-15T10:00:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'spawned the fleet' }] } }) + '\n');
  const old = (Date.now() - 60 * 60_000) / 1000; // utimes takes seconds
  fs.utimesSync(tx, old, old);
  assert.equal(core.agentPhase(tx), 'done', 'stale main transcript alone reads done');
  // A FRESH workflow agent transcript flips the session to working — the fleet is churning.
  const wfDir = path.join(proj, S, 'subagents', 'workflows', 'wf_x');
  fs.mkdirSync(wfDir, { recursive: true });
  const child = path.join(wfDir, 'agent-a1.jsonl');
  fs.writeFileSync(child, JSON.stringify({ message: { role: 'assistant', content: [] } }) + '\n');
  const pd = core.agentPhaseDetail(tx);
  assert.equal(pd.phase, 'working', 'fresh child agent activity keeps the session working');
  assert.equal(pd.confidence, 'high', 'a just-written child is structural-grade evidence');
  // Age the child out too => the session reads done again (children cannot keep a dead run alive).
  fs.utimesSync(child, old, old);
  assert.equal(core.agentPhase(tx), 'done', 'stale children do not resurrect the session');
});

test('workflows: script-meta phases parse when the harness serializes {"title":…} with quoted keys (0.8.6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'wfquoted';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), '');
  const wfDir = path.join(proj, S, 'subagents', 'workflows', 'wf_q');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'v2:abc', agentId: 'a1' }) + '\n');
  fs.writeFileSync(
    path.join(wfDir, 'agent-a1.jsonl'),
    JSON.stringify({ timestamp: '2026-07-15T10:00:00.000Z', message: { role: 'assistant', id: 'm1', usage: { input_tokens: 5, output_tokens: 5 }, content: [] } }) + '\n'
  );
  const scripts = path.join(proj, S, 'workflows', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(
    path.join(scripts, 'myflow-wf_q.js'),
    'export const meta = {\n  name: \'myflow\',\n  description: \'quoted-key phases\',\n  phases: [{"title":"Scope","detail":"d1"},{"title":"Search","detail":"d2"}],\n}\n'
  );
  const wfs = core.parseWorkflows(cwd, S);
  assert.equal(wfs.length, 1, 'the run is discovered from its wf_ dir');
  assert.equal(wfs[0].name, 'myflow');
  assert.deepEqual(wfs[0].phases, ['Scope', 'Search'], 'titles only — never the flattened title/detail string soup');
});

test('tasks: allSessionTaskRows folds background Agent runs into the Tasks tab (new harness task system, 0.8.6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'agenttasks';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), '');
  fs.writeFileSync(
    path.join(subDir, 'agent-abc123.jsonl'),
    JSON.stringify({ timestamp: '2026-07-15T10:00:00.000Z', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'done' }] } }) + '\n'
  );
  fs.writeFileSync(path.join(subDir, 'agent-abc123.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Scan the docs', spawnDepth: 1 }));
  const old = (Date.now() - 60 * 60_000) / 1000;
  fs.utimesSync(path.join(subDir, 'agent-abc123.jsonl'), old, old);
  const rows = core.allSessionTaskRows(cwd, S);
  assert.equal(rows.length, 1, 'the agent run IS the task list on the new harness');
  assert.equal(rows[0].id, 'a1', 'spawn-order display key, distinct from legacy numeric ids');
  assert.equal(rows[0].subject, 'Scan the docs', 'subject = the spawn description');
  assert.equal(rows[0].status, 'completed', 'a finished agent reads completed');
  assert.ok(rows[0].description.includes('Explore'), 'agent type rides in the description');
  assert.equal(rows[0].activeForm, null, 'no activeForm once the agent stops');
});

test('observe: listSessionsWithTitles pairs store sessions with their transcript titles (0.8.6 pickers)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'titledlist';
  const cwd = tmpWork();
  seedEdit(S, path.join(cwd, 'a.txt'), 'x', 'y'); // the store session the pickers list
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Refactor the parser' }) + '\n');
  const rows = core.listSessionsWithTitles(cwd);
  const row = rows.find((r) => r.id === S);
  assert.ok(row, 'store session listed');
  assert.equal(row.title, 'Refactor the parser', 'title mined from the transcript ai-title');

  // A first-PROMPT fallback (no ai-title) stays short: first sentence, then a 64-char hard cap.
  const S2 = 'longprompt';
  seedEdit(S2, path.join(cwd, 'b.txt'), 'x', 'y');
  fs.writeFileSync(
    path.join(proj, S2 + '.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Run the "deep-research" workflow. Deep research harness with a very long tail of instructions that would swamp a one-line picker row.' } }) + '\n'
  );
  const row2 = core.listSessionsWithTitles(cwd).find((r) => r.id === S2);
  assert.equal(row2.title, 'Run the "deep-research" workflow.', 'fallback trims to the first sentence');

  const S3 = 'runonprompt';
  seedEdit(S3, path.join(cwd, 'c.txt'), 'x', 'y');
  fs.writeFileSync(
    path.join(proj, S3 + '.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'please refactor the ingestion pipeline so that every stage reports progress and the whole thing can resume from a checkpoint without reprocessing' } }) + '\n'
  );
  const row3 = core.listSessionsWithTitles(cwd).find((r) => r.id === S3);
  assert.ok(row3.title.length <= 64, 'sentence-less prompts hard-cap at 64');
  assert.ok(row3.title.endsWith('…'), 'capped titles end with an ellipsis');
});

// --- 0.8.6: session vitals (model/effort), compaction visibility, footprint, context sources ---

test('metrics: sessionVitals reports the CURRENT model, keeps the full set, and never counts sidechains or <synthetic> (0.8.6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'vitalsModel';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  // A real session that switched models mid-flight (/model, or fast mode): the chip must show what it
  // is running on NOW, while still disclosing that it switched. `<synthetic>` records are harness
  // filler with no model behind them, and sidechain turns belong to subagents that may run a
  // different model entirely — counting either would misreport the session's own model.
  const turn = (id, model, extra = {}) =>
    JSON.stringify({
      timestamp: new Date(extra.ts || 1000).toISOString(),
      type: 'assistant',
      isSidechain: extra.isSidechain === true,
      effort: extra.effort,
      message: { role: 'assistant', id, model, usage: { input_tokens: 5, output_tokens: 1 }, content: [] },
    });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      turn('m1', 'claude-opus-4-8', { ts: 1000 }),
      turn('m2', 'claude-opus-4-8', { ts: 2000 }),
      turn('m3', 'claude-sonnet-5', { ts: 3000, isSidechain: true }), // a subagent's model
      turn('m4', '<synthetic>', { ts: 4000 }),
      turn('m5', 'claude-fable-5', { ts: 5000 }),
    ].join('\n') + '\n'
  );
  const v = core.sessionVitals(cwd, S);
  assert.equal(v.model.id, 'claude-fable-5', 'the latest main-chain turn is what the session runs on now');
  assert.equal(v.model.label, 'Fable 5', 'raw ids are labelled through the shared friendlyModel');
  assert.deepEqual(v.models.map((m) => m.id), ['claude-opus-4-8', 'claude-fable-5'], 'both real models listed, first-seen order; sidechain + <synthetic> excluded');
  assert.equal(v.models[0].turns, 2, 'per-model turn counts back the chip tooltip');
  assert.equal(v.effort, null, 'effort is unknown here — reported as null, never guessed to a default');
});

test('metrics: sessionVitals takes effort from the assistant record, falling back to a /effort stub (0.8.6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const stub = (text) => JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', message: { role: 'user', content: text } });
  const turn = (id, effort, ts) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'assistant', effort, message: { role: 'assistant', id, model: 'claude-opus-4-8', usage: { input_tokens: 5 }, content: [] } });

  // Current builds stamp `effort` on every assistant record — the latest wins after a mid-session switch.
  fs.writeFileSync(path.join(proj, 'effRec.jsonl'), [turn('a', 'max', 1000), turn('b', 'xhigh', 2000)].join('\n') + '\n');
  const rec = core.sessionVitals(cwd, 'effRec');
  assert.deepEqual([rec.effort.level, rec.effort.source], ['xhigh', 'record'], 'latest structural effort wins');

  // Older transcripts have no such field; the only trace is the /effort command stub. Both wordings
  // ("this session only" / "saved as your default") occur, and unknown levels pass through verbatim.
  fs.writeFileSync(
    path.join(proj, 'effStub.jsonl'),
    [
      stub('<local-command-stdout>Set effort level to max (this session only): …</local-command-stdout>'),
      stub('<local-command-stdout>Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration</local-command-stdout>'),
      turn('c', undefined, 3000),
    ].join('\n') + '\n'
  );
  const st = core.sessionVitals(cwd, 'effStub');
  assert.deepEqual([st.effort.level, st.effort.source], ['ultracode', 'stub'], 'newest stub wins and an unknown level is not normalised away');
});

test('actions: a compact_boundary becomes a first-class row, with this event\'s drop — not the cumulative one (0.8.6)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'compactRows';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  // Verbatim shape from a real transcript. compactMetadata.cumulativeDroppedTokens is a RUNNING
  // SESSION TOTAL (986k, then 1.97M across two compactions) — rendering it as one event's drop would
  // overstate every compaction after the first, so droppedTokens is derived as pre − post.
  const boundary = (ts, pre, post, cumulative, durationMs) =>
    JSON.stringify({
      timestamp: new Date(ts).toISOString(),
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      isSidechain: false,
      compactMetadata: { trigger: 'auto', preTokens: pre, postTokens: post, cumulativeDroppedTokens: cumulative, durationMs },
    });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [boundary(1000, 1000140, 13883, 986257, 125455), boundary(2000, 999467, 14222, 1971502, 116315)].join('\n') + '\n'
  );
  const acts = core.parseActions(cwd, S);
  assert.equal(acts.length, 2, 'a compaction earns a row even though its record carries no `message`');
  assert.equal(acts[0].category, 'compact', 'rows land in their own category');
  assert.equal(acts[0].compact.droppedTokens, 986257, 'first event: pre − post');
  assert.equal(acts[1].compact.droppedTokens, 985245, "second event's own drop, not the 1.97M running total");
  assert.equal(acts[1].compact.cumulativeDropped, 1971502, 'the cumulative figure is still carried, clearly named');
  assert.equal(core.compactLabel(acts[0].compact), 'auto · 1M→14k · 986k dropped · 2m 5s', 'one label builder every surface shares');
  const groups = core.buildActionGroups(acts, false);
  assert.ok(groups.some((g) => g.category === 'compact' && g.label === 'Compactions'), 'curated by default — a lost context is never hidden behind "show all"');
});

test('changemap: compactions ride the map ordered by time, with the shared label', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'compactPlace';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const F = path.join(cwd, 'a.js');
  seedEdit(S, F, 'a\n', 'a\nb\n'); // ts = 1000 (seedEdit's synthetic clock)
  const boundary = (ts) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 900, postTokens: 100, cumulativeDroppedTokens: 800, durationMs: 5 } });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [boundary(4000), boundary(2000)].join('\n') + '\n');
  const cm = core.buildChangeMap(cwd, S);
  assert.equal(cm.summary.compactions, 2, 'the headline count reaches the Overview');
  assert.deepEqual(cm.compactions.map((x) => x.ts), [2000, 4000], 'oldest first, by time — never transcript order');
  assert.equal(cm.compactions[0].droppedTokens, 800, 'per-event drop = pre − post, never the cumulative figure');
  assert.ok(cm.compactions[0].label.includes('→'), 'the shared label rides along so renderers stay thin');
  assert.ok(!('afterChapterId' in cm.compactions[0]) && !('afterSubtaskId' in cm.compactions[0]),
    'no display-anchor field — Actions and Stats render by ts (0.8.8); the field shipped as afterChapterId');
});

test('observe: contextSources separates what the transcript PROVES from what is merely present (0.8.6)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'ctxSrc';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const plansDir = path.join(home, '.claude', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planFile = path.join(plansDir, 'refactor.md');
  fs.writeFileSync(planFile, '# plan\n');
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), '# project rules\n'); // present, but injected invisibly
  const use = (ts, name, input) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u' + ts, name, input }] } });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      JSON.stringify({ timestamp: new Date(500).toISOString(), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation…' } }),
      use(1000, 'Skill', { skill: 'dataviz' }),
      use(2000, 'Write', { file_path: planFile }),
      use(3000, 'Read', { file_path: planFile }),
    ].join('\n') + '\n'
  );
  const rep = core.contextSources(cwd, S);
  const byKind = (k) => rep.sources.filter((s) => s.kind === k);
  assert.equal(byKind('skill')[0].label, 'skill: dataviz', 'an invoked skill is transcript-proven context');
  assert.equal(byKind('skill')[0].evidence, 'transcript', 'and is labelled as such');
  const plan = byKind('plan')[0];
  assert.equal(plan.count, 2, 'repeat touches aggregate into one row with a count');
  assert.equal(plan.detail, 'read and written this session', 'a file both read and written says so — reporting only the first touch would misdescribe it');
  const md = byKind('claude-md')[0];
  assert.equal(md.evidence, 'file-present', 'CLAUDE.md is auto-loaded system-prompt-side, so presence is all we can honestly claim');
  assert.ok(byKind('compact-summary').length === 1, 'being resumed from a compaction is itself a context source');
  assert.ok(/never record/.test(rep.note), 'the payload carries the caveat both editors render');
});

test('observe: a compaction summary can never become the session title (0.8.6)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'compactTitle';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  // On a compacted session the injected summary is a synthesized USER turn that arrives before the
  // real prompt survives — it passes the '<'/'Caveat:' guards, so without an explicit exclusion it
  // becomes firstUserPrompt, and from there the session title and the session-picker label: every
  // surface renaming itself to "This session is being continued…".
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      JSON.stringify({ timestamp: new Date(500).toISOString(), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. Summary: …' } }),
      JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', message: { role: 'user', content: 'Add retry logic to the uploader' } }),
      // A real assistant turn: this is what makes S the session this workspace RESOLVES to, whatever
      // the mtimes say — the stub-proofing added in 0.8.4.
      JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'On it.' }] } }),
    ].join('\n') + '\n'
  );
  const ins = core.transcriptInsights(cwd, S);
  assert.equal(ins.firstUserPrompt, 'Add retry logic to the uploader', 'the real prompt wins over the injected summary');

  // The BOUNDED title scan applies the same filters (0.8.8) — and the sidecar answers repeat calls.
  const tx = path.join(proj, S + '.jsonl');
  assert.equal(core.fastSessionTitle(tx, S), 'Add retry logic to the uploader', 'fastSessionTitle skips the injected summary too');
  assert.equal(core.fastSessionTitle(tx, S), 'Add retry logic to the uploader', 'sidecar-cached second call agrees');
  core.ensureStore(S); // a store makes it a listed session
  const meta = core.sessionMeta(cwd);
  const row = meta.sessions.find((r) => r.id === S);
  assert.ok(row, 'sessionMeta lists this workspace\'s session');
  assert.equal(row.title, 'Add retry logic to the uploader', 'rows carry the fast title');
  // Each row carries what the session DID, the way a fleet row does — from the log, never the blobs.
  assert.deepEqual(
    { edits: row.edits, pending: row.pending, files: row.files },
    { edits: 0, pending: 0, files: 0 },
    'a session that captured nothing reports zeros, not absent fields'
  );
  assert.ok(row.lastActiveMs > 0, 'recency comes from the transcript mtime');

  // Counts that are only ever asserted at zero are counts nobody checked. Capture real work, and the
  // row must report it — and must NOT keep reporting the old numbers once the log moves, which is the
  // whole risk of caching them in a sidecar keyed to the log's stamp.
  const f1 = path.join(cwd, 'up.ts');
  const f2 = path.join(cwd, 'retry.ts');
  fs.writeFileSync(f1, 'a\n');
  fs.writeFileSync(f2, 'b\n');
  const e1 = core.appendLog(S, { tool: 'Edit', file: f1, before: null, after: null, added: 3, removed: 0, status: 'pending', ts: 1200 });
  core.appendLog(S, { tool: 'Edit', file: f2, before: null, after: null, added: 1, removed: 1, status: 'pending', ts: 1300 });
  const withWork = core.sessionMeta(cwd).sessions.find((r) => r.id === S);
  assert.deepEqual(
    { edits: withWork.edits, pending: withWork.pending, files: withWork.files },
    { edits: 2, pending: 2, files: 2 },
    'the row reports the work the log holds'
  );
  // Accepting one edit changes only `pending` — and the sidecar is keyed to the log's stamp, so the
  // next listing has to see it rather than serve the counts it cached a moment ago.
  core.setStatus(S, e1.id, 'kept');
  const after = core.sessionMeta(cwd).sessions.find((r) => r.id === S);
  assert.deepEqual(
    { edits: after.edits, pending: after.pending, files: after.files },
    { edits: 2, pending: 1, files: 2 },
    'a status change invalidates the counts sidecar — the row follows the log'
  );

  // 0.8.8 — the two properties the Sessions tab and the picker are BUILT on: rows come back ordered by
  // conversation recency (newest first), and exactly the session this workspace resolves to is flagged
  // `current`. Both are invisible to a shape assertion, and both decide what the reader is looking at.
  const S2 = 'compactTitle2';
  fs.writeFileSync(
    path.join(proj, S2 + '.jsonl'),
    JSON.stringify({ timestamp: new Date(2000).toISOString(), type: 'user', message: { role: 'user', content: 'Rewrite the uploader tests' } }) + '\n'
  );
  core.ensureStore(S2);
  // Make S2's conversation the newer one, by a margin no filesystem timestamp granularity can blur.
  const older = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(proj, S + '.jsonl'), older, older);
  const m2 = core.sessionMeta(cwd);
  const ids = m2.sessions.map((r) => r.id);
  assert.ok(
    ids.indexOf(S2) < ids.indexOf(S),
    'ordered by CONVERSATION recency — the session written to most recently leads, whatever its store says'
  );
  const active = core.resolveSessionId(cwd);
  assert.equal(m2.active, active, 'the payload names the session this workspace resolves to');
  assert.deepEqual(
    m2.sessions.filter((r) => r.current).map((r) => r.id),
    active ? [active] : [],
    'exactly one row is flagged current — the live session, never a guess'
  );
  // Pull the two properties apart: make the RESOLVED session the OLDEST conversation, so a row flagged
  // `current` can no longer be explained by "it happens to sort first".
  const S3 = 'compactTitle3';
  fs.writeFileSync(
    path.join(proj, S3 + '.jsonl'),
    JSON.stringify({ timestamp: new Date(3000).toISOString(), type: 'user', message: { role: 'user', content: 'Third session' } }) + '\n'
  );
  core.ensureStore(S3);
  const newest = new Date();
  fs.utimesSync(path.join(proj, S3 + '.jsonl'), newest, newest);
  const older2 = new Date(Date.now() - 120_000);
  // S2 and S3 are command-only stubs (no assistant record), so resolution stays on S even though S3 is
  // the newest file — the two properties now disagree, which is the only way this assertion can fail.
  fs.utimesSync(path.join(proj, S + '.jsonl'), older2, older2);
  const m3 = core.sessionMeta(cwd);
  assert.equal(core.resolveSessionId(cwd), S, 'resolution follows the real conversation, not the newest stub');
  assert.deepEqual(
    m3.sessions.filter((r) => r.current).map((r) => r.id),
    [S],
    'current tracks the RESOLVED session — a row is not current merely for sorting first'
  );
  assert.equal(m3.sessions[0].id, S3, '…while the ordering still puts the newest conversation first');
  assert.notEqual(m3.sessions[0].id, S, 'the two properties are genuinely separated in this fixture');
});

test('prompts: the ask that WORKS a task is credited, not the one that planned it (0.8.8)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'taskCredit';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const ask = (ts, text) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: text } });
  const call = (ts, id, name, input) =>
    JSON.stringify({
      timestamp: new Date(ts).toISOString(), type: 'assistant',
      message: { role: 'assistant', id: 'm' + id, content: [{ type: 'tool_use', id, name, input }] },
    });
  // Prompt #1 only PLANS (TaskCreate). Prompt #2 does the work, and says so the only way the newer task
  // system can: TaskUpdate, which carries a display number and a status and no subject at all.
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      ask(1000, 'plan the work'),
      call(1100, 'tc1', 'TaskCreate', { subject: 'Wire the loader', description: 'stream it' }),
      // The runtime answers a TaskCreate with the number it assigned — that result is where a task's id
      // comes from, and without it an update can be anchored to nothing.
      JSON.stringify({
        timestamp: new Date(1150).toISOString(), type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'Task #1 created' }] },
      }),
      ask(2000, 'now do it'),
      call(2100, 'tu1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),
      call(2200, 'tu2', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ].join('\n') + '\n'
  );
  const rs = core.sessionPrompts(cwd, S);
  assert.equal(rs.length, 2, 'two asks');
  assert.equal(rs[0].tasks, 0, 'writing a plan is not working a task — the planning ask is credited with none');
  assert.equal(rs[1].tasks, 1, 'the ask that moved the task is credited, though TaskUpdate names no subject');
});

test('prompts: a task count survives long titles, description-only edits, and later renames (0.8.8)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'taskEdges';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const ask = (ts, text) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: text } });
  const call = (ts, id, name, input) =>
    JSON.stringify({
      timestamp: new Date(ts).toISOString(), type: 'assistant',
      message: { role: 'assistant', id: 'm' + id, content: [{ type: 'tool_use', id, name, input }] },
    });
  const result = (ts, forId, text) =>
    JSON.stringify({
      timestamp: new Date(ts).toISOString(), type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: forId, content: text }] },
    });

  // A to-do whose text runs past the 160-character display clip. Its identity must come from the FULL
  // text, or it hashes to something no task equals — and the same item planned twice counts twice.
  const LONG =
    'Rewrite the uploader so that a partial multipart upload can resume from its last acknowledged ' +
    'chunk instead of restarting, including the retry budget and the backoff schedule it uses';
  assert.ok(LONG.length > 160, 'the fixture actually exceeds the display clip');

  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      ask(1000, 'plan and start the upload work'),
      call(1100, 'tc1', 'TaskCreate', { subject: LONG, description: 'resumable uploads' }),
      result(1150, 'tc1', 'Task #1 created'),
      // The same item, named again as a to-do — one task, whichever way it was planned.
      call(1200, 'tw1', 'TodoWrite', { todos: [{ content: LONG, status: 'in_progress' }] }),
      call(1300, 'tu1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }),

      ask(2000, 'tidy the notes'),
      // A description-only edit: it moves nothing, so this ask worked no task.
      call(2100, 'tu2', 'TaskUpdate', { taskId: '1', description: 'note the backoff table' }),

      ask(3000, 'rename it and finish'),
      call(3100, 'tu3', 'TaskUpdate', { taskId: '1', subject: 'Resumable uploads' }),
      call(3200, 'tu4', 'TaskUpdate', { taskId: '1', status: 'completed' }),
    ].join('\n') + '\n'
  );

  const rs = core.sessionPrompts(cwd, S);
  assert.equal(rs.length, 3, 'three asks');
  assert.equal(
    rs[0].tasks,
    1,
    'the long item counts ONCE: identity comes from the full text, so the TaskCreate, the TodoWrite and ' +
      'the TaskUpdate all resolve to the same task'
  );
  assert.equal(rs[1].tasks, 0, 'an update that only edits a description is not work');
  assert.equal(rs[2].tasks, 1, 'the ask that renamed and finished it worked one task');

  // …and the rename does not reach back: the first ask is still credited with exactly one task, keyed
  // by the subject in force when it worked, not by the name the task has now.
  const again = core.sessionPrompts(cwd, S);
  assert.equal(again[0].tasks, 1, 'a later rename does not rewrite an earlier prompt\'s count');
  assert.deepEqual(
    again.map((r) => r.tasks),
    [1, 0, 1],
    'the whole session reads the same on a second pass'
  );
});

test('subagents: the digest is cached per transcript state, but the phase is asked every time (0.8.8)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'subDigest';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  const subs = path.join(proj, S, 'subagents');
  fs.mkdirSync(subs, { recursive: true });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', message: { role: 'user', content: 'write the tests' } }) + '\n'
  );
  const agent = path.join(subs, 'agent-a1.jsonl');
  // The agent's turn is COMPLETE (its last message calls no tool), so its phase is decided by how long
  // ago the file was written — the part of the phase that a cache would freeze. A transcript ending on
  // an unanswered tool_use would be structurally "working" whatever its age, and would prove nothing.
  fs.writeFileSync(
    agent,
    [
      JSON.stringify({ timestamp: new Date(Date.now() - 1000).toISOString(), type: 'assistant', isSidechain: true, message: { role: 'assistant', id: 'x1', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'write the tests', status: 'in_progress' }] } }] } }),
      JSON.stringify({ timestamp: new Date(Date.now() - 900).toISOString(), type: 'user', isSidechain: true, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      JSON.stringify({ timestamp: new Date(Date.now() - 800).toISOString(), type: 'assistant', isSidechain: true, message: { role: 'assistant', id: 'x2', content: [{ type: 'text', text: 'done' }] } }),
    ].join('\n') + '\n'
  );

  const live = core.subagentDigests(cwd, S);
  assert.equal(live.length, 1, 'the subagent is listed');
  assert.equal(live[0].currentTask, 'write the tests', 'its plan comes from the cached digest');

  // Is the identity half REALLY served from the sidecar? Put a value in the cache that the file cannot
  // produce, leaving the stamp alone, and see which one comes back. (Aging the file instead proves
  // nothing: mtime IS the stamp, so the whole digest recomputes and the assertion passes with the cache
  // removed. Rewriting the file in place is no better — the filesystem's mtime precision is not ours to
  // hold fixed.)
  const sidePath = path.join(core.rootDir(), 'session-meta', S + '.json');
  const side = JSON.parse(fs.readFileSync(sidePath, 'utf8'));
  assert.ok(Array.isArray(side.subagentDigests) && side.subagentDigests.length === 1, 'the digest was written to the sidecar');
  // The phase is deliberately NOT in there: it is derived from how long ago the agent last wrote, so a
  // remembered copy would report an agent that stopped hours ago as still going.
  for (const k of ['phase', 'phaseConfidence', 'running']) {
    assert.ok(!(k in side.subagentDigests[0]), `the sidecar holds no ${k} — liveness is asked of the file every time`);
  }
  side.subagentDigests[0].currentTask = 'served from the sidecar';
  fs.writeFileSync(sidePath, JSON.stringify(side));
  const cached = core.subagentDigests(cwd, S);
  assert.equal(cached[0].currentTask, 'served from the sidecar', 'the identity half is read from the sidecar, not re-parsed');
  assert.ok(cached[0].phase, '…while the phase is still derived on every call');

  // Aging the file moves the stamp, which rebuilds the identity half too — that is how a renamed task
  // or a new to-do reaches the panel at all — and moves the phase with it.
  const old = new Date(Date.now() - 12 * 60 * 60 * 1000);
  fs.utimesSync(agent, old, old);
  const later = core.subagentDigests(cwd, S);
  assert.equal(later.length, 1, 'still listed');
  assert.equal(later[0].currentTask, 'write the tests', 'a changed stamp rebuilds the identity half from the file');
  assert.notEqual(later[0].phase, live[0].phase, 'and the phase followed the file, not the cache');
});

test('changemap: the map is memoized on disk across processes, and invalidated by either input (0.8.8)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'mapCache';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tx = path.join(proj, S + '.jsonl');
  fs.writeFileSync(
    tx,
    [
      JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', message: { role: 'user', content: 'do the thing' } }),
      JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n'
  );
  core.ensureStore(S);
  const f = path.join(cwd, 'a.ts');
  fs.writeFileSync(f, 'one\n');
  core.appendLog(S, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'pending', ts: 1200 });

  const first = core.cachedChangeMap(cwd, S, { root: cwd, prompts: true });
  assert.equal(first.summary?.units, 1, 'the map is built');
  // The cache file is what a FRESH process would read; assert it exists and that a second call agrees.
  const cacheDir = path.join(core.rootDir(), 'changemap-cache');
  assert.ok(fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0, 'a cache entry was written');
  assert.deepEqual(core.cachedChangeMap(cwd, S, { root: cwd, prompts: true }), first, 'the cached map is the same map');

  // A new edit must invalidate it — a stale map is worse than a slow one.
  core.appendLog(S, { tool: 'Edit', file: f, before: null, after: null, added: 2, removed: 0, status: 'pending', ts: 1300 });
  assert.equal(core.cachedChangeMap(cwd, S, { root: cwd, prompts: true }).summary?.units, 2, 'the log changing rebuilds it');

  // …and so must a transcript that grew (new prompts, tasks, actions all live there).
  fs.appendFileSync(tx, JSON.stringify({ timestamp: new Date(2000).toISOString(), type: 'user', message: { role: 'user', content: 'and another thing' } }) + '\n');
  assert.equal(
    core.cachedChangeMap(cwd, S, { root: cwd, prompts: true }).prompts.length,
    2,
    'the transcript changing rebuilds it too'
  );

  // …and so must the WORKSPACE FILE itself. The map reads each edited file off disk to detect its
  // classes and place each edit in the CURRENT text, so a file the user edits in their editor is a
  // third input — and one that moves neither the transcript nor the log. Without stamping it, the map
  // kept reporting class names for a version of the file that no longer existed.
  const cls = path.join(cwd, 'k.py');
  const v1 = 'class Alpha:\n    def go(self):\n        return 1\n';
  fs.writeFileSync(cls, v1);
  // Real blobs: class attribution places the edit's introduced lines in the CURRENT text, so a
  // record with no snapshots has nothing to place and would pass this test vacuously.
  core.appendLog(S, {
    tool: 'Edit',
    file: cls,
    beforeBlob: core.writeBlob(S, Buffer.from('class Alpha:\n    def go(self):\n        return 0\n')),
    afterBlob: core.writeBlob(S, Buffer.from(v1)),
    status: 'pending',
    ts: 1400,
  });
  const named = core.cachedChangeMap(cwd, S, { root: cwd, prompts: true });
  const clsOf = (m) => m.edits.find((e) => e.file === 'k.py')?.cls ?? null;
  assert.equal(clsOf(named), 'Alpha', 'the class is detected from the file on disk');
  fs.writeFileSync(cls, 'class Renamed:\n    def go(self):\n        return 1\n');
  assert.equal(clsOf(core.cachedChangeMap(cwd, S, { root: cwd, prompts: true })), 'Renamed', 'editing the workspace file rebuilds it');
});

/* The cache entry is rewritten via tmp+rename on every MISS and not touched at all on a hit, so the
   entry's inode is the instrument for "did this rebuild?" — an output assertion cannot tell the two
   apart when the correct answer is that nothing changed. `placements.json` is excluded: it is the edit
   tree's own memo (see below) and moves on its own schedule. */
function mapCacheInos(session) {
  const dir = path.join(core.rootDir(), 'changemap-cache', session);
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json') && n !== 'placements.json')
    .sort()
    .map((n) => `${n}:${fs.statSync(path.join(dir, n)).ino}`)
    .join(',');
}

test('changemap: a sibling session GROWING does not invalidate this session\'s map (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'mapSelf';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const rec = (ms, text) =>
    JSON.stringify({ timestamp: new Date(ms).toISOString(), type: 'user', message: { role: 'user', content: text } });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), rec(1000, 'do the thing') + '\n');
  core.ensureStore(S);
  const f = path.join(cwd, 'a.ts');
  fs.writeFileSync(f, 'one\n');
  core.appendLog(S, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'pending', ts: 1200 });

  const build = () => core.cachedChangeMap(cwd, S, { root: cwd, prompts: true });
  build();
  const before = mapCacheInos(S);

  // POSITIVE CONTROL, and it must come first: a NEW sibling appearing DOES have to rebuild, because
  // summary.fleet counts the sessions in the project dir. Without this, a stamp that returned a
  // constant would sail through the assertion below while measuring nothing at all.
  const sib = path.join(proj, 'sibling.jsonl');
  fs.writeFileSync(sib, rec(2000, 'a second session') + '\n');
  assert.equal(build().summary.fleet, 1, 'the new sibling is counted');
  const afterAdd = mapCacheInos(S);
  assert.notEqual(afterAdd, before, 'a sibling APPEARING rebuilds the map (positive control)');

  // The fix: that sibling growing must NOT. Its bytes are not an input to this session's map — only
  // the set of session ids is — and stamping them meant every session in a project invalidated every
  // other one's cache on each tick, which is what made an old session's Overview cost ~14 s a refresh.
  fs.appendFileSync(sib, rec(3000, 'and it keeps working') + '\n');
  assert.equal(build().summary.fleet, 1, 'the fleet count is unchanged');
  assert.equal(mapCacheInos(S), afterAdd, 'a sibling APPENDING is served from cache');

  // Removal is the other half of the id set, and it is what a reap does.
  fs.rmSync(sib);
  assert.equal(build().summary.fleet, 0, 'a sibling disappearing rebuilds the map too');
});

test('tree: edit placement is memoized on disk and survives the process (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'placeCache';
  const cwd = tmpWork();
  const py = path.join(cwd, 'm.py');
  const v1 = 'class Alpha:\n    def go(self):\n        return 1\n';
  fs.writeFileSync(py, v1);
  core.ensureStore(S);
  core.appendLog(S, {
    tool: 'Edit',
    file: py,
    beforeBlob: core.writeBlob(S, Buffer.from('class Alpha:\n    def go(self):\n        return 0\n')),
    afterBlob: core.writeBlob(S, Buffer.from(v1)),
    status: 'pending',
    ts: 1400,
  });

  // A FRESH process is the whole point — the in-process memo is what already worked, and the Overview
  // spawns a new CLI process on every refresh tick, so only a disk tier can help it.
  const CORE = path.resolve(__dirname, '../dist/index.js');
  const inChild = () =>
    JSON.parse(
      cp.execFileSync(
        process.execPath,
        ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(CORE)}).buildEditTree(${JSON.stringify(S)}, { root: ${JSON.stringify(cwd)} })))`],
        { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' }
      )
    );

  // Only the PLACEMENT is under test. The blob deletion below also strips lineDelta's added/removed
  // counts, which are a different derivation — comparing whole trees would fail for reasons that have
  // nothing to do with the memo.
  const placement = (t) => ({ cls: t.files[0].classes[0]?.name ?? null, loose: t.files[0].loose.length });

  const cold = inChild();
  const pFile = path.join(core.rootDir(), 'changemap-cache', S, 'placements.json');
  assert.ok(fs.existsSync(pFile), 'placements were persisted');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(pFile, 'utf8')).entries).length, 1, 'one entry per class-bearing file');
  assert.deepEqual(placement(cold), { cls: 'Alpha', loose: 0 }, 'the edit is placed inside the class');

  // Building TWICE IN ONE PROCESS is its own case, and the one a long-lived host actually hits: the
  // in-process memo outlives the per-call store, so the second build takes only the memo path. When that
  // path did not re-retain its keys, the store's pruning flush rewrote this file as {} — the disk tier
  // deleting itself on every refresh after the first. A child process per build never sees it, which is
  // why every assertion here passed while the cache was being wiped in the VS Code extension host.
  const entries = () => Object.keys(JSON.parse(fs.readFileSync(pFile, 'utf8')).entries).length;
  cp.execFileSync(
    process.execPath,
    ['-e', `const c=require(${JSON.stringify(CORE)});for(let i=0;i<3;i++)c.buildEditTree(${JSON.stringify(S)},{root:${JSON.stringify(cwd)}});`],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' }
  );
  assert.equal(entries(), 1, 'three builds in one process keep the entry (the memo path still retains it)');

  // Deleting the BLOBS is the instrument: placement is computed from them, so a run that still answers
  // "Alpha" can only have read the disk tier. Nothing here is keyed by mtime, so this is exact.
  fs.rmSync(path.join(core.rootDir(), S, 'blobs'), { recursive: true, force: true });
  assert.deepEqual(placement(inChild()), { cls: 'Alpha', loose: 0 }, 'a fresh process places it identically, without the blobs');

  // POSITIVE CONTROL: without the memo AND without the blobs there is nothing to place from, so the
  // edit falls out of the class. If this still said "Alpha", the assertion above would prove nothing.
  fs.rmSync(pFile);
  assert.deepEqual(placement(inChild()), { cls: null, loose: 1 }, 'with neither blobs nor memo the placement is lost');

  // …and that unplaceable result must never be written back, or it would outlive the process as a
  // wrong answer keyed identically to the right one.
  assert.ok(!fs.existsSync(pFile), 'a placement computed from unreadable blobs is not persisted');
});

test('changemap: a RUNNING workflow\'s growing transcript invalidates the map (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'wfStamp';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', message: { role: 'user', content: 'run a workflow' } }) + '\n'
  );
  const wf = path.join(proj, S, 'subagents', 'workflows', 'wf_abc');
  fs.mkdirSync(wf, { recursive: true });
  const agent = path.join(wf, 'agent-1.jsonl');
  fs.writeFileSync(agent, JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'user', message: { role: 'user', content: 'go' } }) + '\n');
  core.ensureStore(S);
  const f = path.join(cwd, 'a.ts');
  fs.writeFileSync(f, 'one\n');
  core.appendLog(S, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'pending', ts: 1200 });

  const build = () => core.cachedChangeMap(cwd, S, { root: cwd, prompts: true });
  build();
  const before = mapCacheInos(S);

  // The entries of subagents/workflows/ are wf_<id> DIRECTORIES, and a directory's mtime and size do
  // not move when a file inside it grows — so stamping that directory alone left a workflow that was
  // still running frozen at whatever its window was when its first agent appeared. Assert the premise
  // rather than trusting it: if this ever failed, the shallow stamp would have been sufficient.
  const dirBefore = fs.statSync(wf);
  fs.appendFileSync(agent, JSON.stringify({ timestamp: new Date(1300).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'working' }] } }) + '\n');
  const dirAfter = fs.statSync(wf);
  assert.equal(`${dirBefore.mtimeMs}:${dirBefore.size}`, `${dirAfter.mtimeMs}:${dirAfter.size}`, 'the wf_ directory itself did not move (premise)');

  build();
  assert.notEqual(mapCacheInos(S), before, 'the growing agent transcript rebuilds the map');
});

test('fleet: a conversation older than a week is folded, and never the one under review (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = tmpWork();
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true }); // plain .git → commonDir resolves → the fleet engages
  const proj = core.projectDir(ws);
  fs.mkdirSync(proj, { recursive: true });
  const NOW = 'liveSess';
  const OLD = 'oldSess';
  const seed = (id) => {
    const p = path.join(proj, id + '.jsonl');
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', cwd: ws, message: { role: 'user', content: 'work on ' + id } }),
        JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a-' + id, content: [{ type: 'text', text: 'ok' }] } }),
      ].join('\n') + '\n'
    );
    core.ensureStore(id);
    const f = path.join(ws, id + '.ts');
    fs.writeFileSync(f, 'one\n');
    core.appendLog(id, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'pending', ts: 1200 });
    return p;
  };
  seed(NOW);
  const pOld = seed(OLD);
  const rowFor = (viewing, id) => core.overviewChangeMap(ws, viewing, { root: ws }).agents.find((a) => a.session === id);
  const state = (r) => ({ folded: r.folded, loaded: r.loaded });

  // POSITIVE CONTROL: while it is recent the sibling is built like any other. Without this, a fold
  // that simply always fired would satisfy every assertion below.
  assert.deepEqual(state(rowFor(NOW, OLD)), { folded: false, loaded: true }, 'a recent sibling is built');

  // Age its conversation past the fold window.
  const ago = (Date.now() - 30 * 86400000) / 1000;
  fs.utimesSync(pOld, ago, ago);
  assert.deepEqual(state(rowFor(NOW, OLD)), { folded: true, loaded: false }, 'a week-old sibling is folded and not rebuilt');

  // Folding declines to BUILD; it never hides an answer that is already on disk.
  core.siblingOverview(ws, OLD, { root: ws });
  assert.deepEqual(state(rowFor(NOW, OLD)), { folded: true, loaded: true }, 'a folded sibling still renders from a warm cache');

  // The one that matters for a pinned old session: whatever its age, the session being VIEWED is
  // never folded — the user selected it precisely to look at what it did.
  const own = rowFor(OLD, OLD);
  assert.equal(own.folded, false, 'the session under review is never folded, however old');
  assert.equal(own.summary.units, 1, '...and its own map is fully built');
});

test('clean: --completed reaps finished sessions and refuses every live one (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  // realpath: a child process started with cwd=<symlinked tmp> reports the RESOLVED path from
  // process.cwd(), and projectDir() mangles the path it is given — so the CLI would look under a
  // different project dir than the fixture wrote to and find nothing.
  const ws = fs.realpathSync(tmpWork());
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  const proj = core.projectDir(ws);
  fs.mkdirSync(proj, { recursive: true });
  const HOUR = 3_600_000; // REAP_QUIET_MS is a DAY — this deletes edit history, so the clock is coarse
  // Each session is one refusal clause in reapableSessions, so a rail that stopped working shows up
  // here as a specific session going missing rather than as a vague count.
  const mk = (id, agoMs, status) => {
    const p = path.join(proj, id + '.jsonl');
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', cwd: ws, message: { role: 'user', content: id } }),
        JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a-' + id, content: [{ type: 'text', text: 'ok' }] } }),
      ].join('\n') + '\n'
    );
    core.ensureStore(id);
    const f = path.join(ws, id + '.ts');
    fs.writeFileSync(f, 'one\n');
    core.appendLog(id, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status, ts: 1200 });
    const t = (Date.now() - agoMs) / 1000;
    fs.utimesSync(p, t, t); // CONVERSATION recency is transcript mtime
    return p;
  };
  const age = (id, agoMs) => {
    const t = (Date.now() - agoMs) / 1000;
    fs.utimesSync(path.join(proj, id + '.jsonl'), t, t);
  };
  // sCurrent is the NEWEST transcript (so resolveSessionId answers with it) but is itself well past the
  // quiet window — otherwise the quiet rail would cover for the not-current rail and neither would be
  // under test. Each survivor below is spared by exactly one clause.
  mk('sCurrent', 30 * HOUR, 'kept');
  mk('sDone', 48 * HOUR, 'kept'); // the one that should go
  mk('sPending', 48 * HOUR, 'pending'); // old and quiet, but still has review left
  mk('sStaged', 48 * HOUR, 'kept');
  fs.mkdirSync(path.join(core.rootDir(), 'sStaged', 'staging'), { recursive: true });
  fs.writeFileSync(path.join(core.rootDir(), 'sStaged', 'staging', 'x.json'), '{}'); // capture in flight

  assert.equal(core.resolveSessionId(ws), 'sCurrent', 'the fixture puts the live session where we think');
  assert.deepEqual(
    core.reapableSessions(ws).map((s) => s.id),
    ['sDone'],
    'only the finished, quiet, unstaged, non-current session is reapable'
  );

  // The quiet rail on its own: a finished, non-current session whose conversation stopped only moments
  // ago is NOT finished enough. sCurrent stays newest so it keeps answering as current.
  age('sCurrent', 1 * HOUR);
  age('sDone', 2 * HOUR);
  assert.deepEqual(core.reapableSessions(ws).map((s) => s.id), [], 'a session that just went quiet is not reaped');
  age('sDone', 48 * HOUR);
  assert.equal(core.reapableSessions(ws)[0].reason, 'finished', 'a fully reviewed session is reported as finished');

  // ABANDONED: unreviewed edits do NOT protect a session forever. Two days in, sPending is still under
  // review; a month in, nobody is coming back and its edits are discarded with it. Without this second
  // clause almost nothing qualifies on a real store — most old sessions were never reviewed to the end.
  assert.ok(!core.reapableSessions(ws).some((s) => s.id === 'sPending'), 'a 2-day-old session with pending edits is spared');
  age('sPending', 30 * 24 * HOUR);
  const ab = core.reapableSessions(ws).find((s) => s.id === 'sPending');
  assert.ok(ab, 'a month-dead session with pending edits IS reaped');
  assert.equal(ab.reason, 'abandoned', 'and is reported as abandoned, so the UI can warn what it discards');
  assert.equal(ab.pending, 1, 'carrying the count of unreviewed edits that go with it');
  // …and the threshold is caller-controllable, because "too old" is a judgement, not a constant.
  assert.ok(
    !core.reapableSessions(ws, Date.now(), 60 * 24 * HOUR).some((s) => s.id === 'sPending'),
    'a longer stale window spares it again'
  );
  age('sPending', 48 * HOUR); // back under the window, so the CLI assertions below still see one target

  const store = (id) => fs.existsSync(path.join(core.rootDir(), id));
  const out = JSON.parse(
    cp.execFileSync('node', [CLI, 'clean', '--completed', '--json'], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      cwd: ws,
      encoding: 'utf8',
    })
  );
  assert.deepEqual(out.dropped, ['sDone'], 'the CLI drops exactly that one');
  assert.equal(store('sDone'), false, 'its store is gone');
  for (const kept of ['sCurrent', 'sPending', 'sStaged']) {
    assert.equal(store(kept), true, `${kept} survives`);
  }
});

test('clean: --completed never reaps a session recorded for an ANCESTOR workspace (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  // A session launched in a PARENT directory — ~, ~/Github, a monorepo root are all ordinary launch
  // dirs. `findTranscript` walks up to the filesystem root, so such a session resolves from a
  // subdirectory and used to be deleted by a clear run there. Listing it is fine; deleting it is not.
  const parent = fs.realpathSync(tmpWork());
  const sub = path.join(parent, 'packages', 'thing');
  fs.mkdirSync(sub, { recursive: true });
  const old = (Date.now() - 48 * 3_600_000) / 1000;
  const seed = (cwd, id) => {
    const proj = core.projectDir(cwd);
    fs.mkdirSync(proj, { recursive: true });
    const p = path.join(proj, id + '.jsonl');
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', cwd, message: { role: 'user', content: id } }),
        JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a-' + id, content: [{ type: 'text', text: 'ok' }] } }),
      ].join('\n') + '\n'
    );
    core.ensureStore(id);
    const f = path.join(cwd, id + '.ts');
    fs.writeFileSync(f, 'one\n');
    core.appendLog(id, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'kept', ts: 1200 });
    fs.utimesSync(p, old, old);
  };
  seed(parent, 'ancestorSess');
  seed(sub, 'subDone');
  seed(sub, 'subCurrent');
  // Make subCurrent the newest so it is `current` and cannot be the one under test.
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(core.projectDir(sub), 'subCurrent.jsonl'), now, now);

  const reapable = core.reapableSessions(sub).map((s) => s.id);
  assert.deepEqual(reapable, ['subDone'], 'only this workspace’s finished session is reapable');
  // POSITIVE CONTROL: the ancestor session IS resolvable from here — that is exactly why the naive
  // provenance rail let it through. If this fails, the fixture is not reproducing the hazard.
  assert.ok(core.findTranscript(sub, 'ancestorSess'), 'the ancestor session does resolve from the subdirectory');
  assert.ok(
    core.sessionMeta(sub).sessions.some((r) => r.id === 'ancestorSess'),
    'and it is even LISTED here — listing is fine, deleting is not'
  );
});

test('clean: --older-than never deletes the session the user is in (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork()); // the CLI child reports the resolved cwd — see the note above
  const proj = core.projectDir(ws);
  fs.mkdirSync(proj, { recursive: true });
  const S = 'liveLong';
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', cwd: ws, message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n'
  );
  core.ensureStore(S);
  const f = path.join(ws, 'a.ts');
  fs.writeFileSync(f, 'one\n');
  core.appendLog(S, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'pending', ts: 1200 });
  // A long conversation that made all its edits early: the STORE LOG is ancient while the session is
  // very much alive. That is the shape --older-than used to delete out from under the user.
  const old = (Date.now() - 30 * 86400000) / 1000;
  fs.utimesSync(core.logPath(S), old, old);

  const run = (args) =>
    JSON.parse(cp.execFileSync('node', [CLI, ...args], { env: { ...process.env, HOME: home, USERPROFILE: home }, cwd: ws, encoding: 'utf8' }));
  assert.equal(core.resolveSessionId(ws), S, 'it is the current session');
  assert.deepEqual(run(['clean', '--older-than', '7d', '--json']).dropped, [], 'the live session is not swept up');
  assert.equal(fs.existsSync(core.logPath(S)), true, 'its store survives');

  // POSITIVE CONTROL: the verb still works. An identical but NON-current session is still dropped,
  // so this is a targeted exclusion and not a broken --older-than.
  const O = 'deadOne';
  fs.writeFileSync(path.join(proj, O + '.jsonl'), JSON.stringify({ timestamp: new Date(900).toISOString(), type: 'user', cwd: ws, message: { role: 'user', content: 'old' } }) + '\n');
  core.ensureStore(O);
  core.appendLog(O, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'kept', ts: 1000 });
  fs.utimesSync(core.logPath(O), old, old);
  assert.deepEqual(run(['clean', '--older-than', '7d', '--json']).dropped, [O], 'a dead session with the same age still goes');
});

test('taskLog: the cross-agent log reads the sibling CACHE, never the raw builder (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
  const proj = core.projectDir(ws);
  fs.mkdirSync(proj, { recursive: true });
  const S = 'tlSess';
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', cwd: ws, message: { role: 'user', content: 'do the work' } }),
      JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n'
  );
  core.ensureStore(S);
  const f = path.join(ws, 'a.ts');
  fs.writeFileSync(f, 'one\n');
  core.appendLog(S, { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'pending', ts: 1200 });

  // The instrument: `siblingChangeMap` PERSISTS its result, and the raw `buildChangeMap` writes nothing.
  // So a cache entry appearing after this call is proof of which door was used — and the log rebuilt
  // every sibling from scratch on every run before this, 12.4 s on a repo with 31 of them.
  const cacheDir = path.join(core.rootDir(), 'changemap-cache', S);
  assert.equal(fs.existsSync(cacheDir), false, 'nothing cached yet (baseline)');
  core.crossAgentTaskLog(ws);
  assert.ok(
    // The 16-hex payload name is the SIBLING SLOT's signature — 'any .json but placements' was a
    // never-fail door: the raw builder writes deltas.json into the same dir, so both implementations
    // satisfied it (proven by reinstating the raw-builder mutation, which passed).
    fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some((n) => /^[0-9a-f]{16}\.json$/.test(n)),
    'the task log went through the caching path'
  );
});

test('memory: fileMemory indexes the store once, and a new edit still invalidates it (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = tmpWork();
  const f = path.join(ws, 'shared.ts');
  fs.writeFileSync(f, 'one\n');
  // Two sessions touching ONE file: fileMemory's whole job is aggregating across them, and the index
  // rewrite must not lose that.
  core.ensureStore('memA');
  core.appendLog('memA', { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'kept', ts: 1000 });
  core.ensureStore('memB');
  core.appendLog('memB', { tool: 'Edit', file: f, before: null, after: null, added: 1, removed: 0, status: 'undone', ts: 2000 });

  const m1 = core.fileMemory(f);
  assert.deepEqual(
    { edits: m1.edits, kept: m1.kept, undone: m1.undone, pending: m1.pending },
    { edits: 2, kept: 1, undone: 1, pending: 0 },
    'both sessions are folded into one history'
  );
  assert.deepEqual(m1.lastVerdict, { status: 'undone', ts: 2000 }, 'the newest verdict wins');

  // The index is memoized on the log files. A memo that did not notice a new edit would report the old
  // counts forever — the failure mode this rewrite could plausibly introduce, so assert it directly.
  core.appendLog('memA', { tool: 'Edit', file: f, before: null, after: null, added: 5, removed: 0, status: 'pending', ts: 3000 });
  const m2 = core.fileMemory(f);
  assert.equal(m2.edits, 3, 'a new edit invalidates the index');
  assert.equal(m2.pending, 1, '...and lands in the right bucket');

  // A file nobody has touched has an empty history, not a crash or a neighbour's numbers.
  assert.equal(core.fileMemory(path.join(ws, 'never-edited.ts')).edits, 0, 'an unknown file is empty');
});

test('observe: session line deltas are cached per blob PAIR, so a wrong total can never be inherited (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = tmpWork();
  const S = 'deltaSess';
  const f = path.join(ws, 'a.ts');
  fs.writeFileSync(f, 'one\n');
  const add = (before, after) => seedEdit(S, f, before, after);
  add('a\n', 'a\nb\n'); // +1
  add('a\nb\n', 'a\nb\nc\n'); // +1
  const sidecar = () => JSON.parse(fs.readFileSync(path.join(core.rootDir(), 'session-meta', S + '.json'), 'utf8'));
  const full = () => {
    let a = 0, r = 0;
    for (const rec of core.readLog(S)) { const d = core.lineDelta(S, rec); a += d.added; r += d.removed; }
    return { added: a, removed: r };
  };

  let c = core.sessionCounts(S);
  assert.deepEqual({ added: c.added, removed: c.removed }, full(), 'the first pass matches a full sum');
  const cacheFile = path.join(core.rootDir(), 'changemap-cache', S, 'deltas.json');
  assert.ok(fs.existsSync(cacheFile), 'the per-blob-pair delta cache was written');

  add('a\nb\nc\n', 'a\nb\nc\nd\n');
  c = core.sessionCounts(S);
  assert.deepEqual({ added: c.added, removed: c.removed }, full(), 'a grown log still matches a full sum');

  // The cache is keyed by CONTENT — the record's before AND after blob shas, as a PAIR. Two records with
  // the same pair share one entry…
  add('a\n', 'a\nb\n'); // identical blob pair to the very first edit
  // …and, the case that actually pins the key: the same AFTER reached from a different BEFORE is a
  // different edit with a different delta. Keyed on the after alone (four distinct afters mapping 1:1
  // onto the pairs) every count above still agreed, so that mis-key shipped green.
  add('a\nb\nc\nd\ne\nf\n', 'a\nb\nc\n'); // same after as edit #2, but removes three lines instead of adding one
  core.sessionCounts(S);
  const pairs = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).pairs;
  assert.equal(Object.keys(pairs).length, 4, 'five records, four distinct blob PAIRS — identical edits collapse, a shared after does not');
  const c2 = core.sessionCounts(S);
  assert.deepEqual({ added: c2.added, removed: c2.removed }, full(), 'and a shared after keeps its own delta');
  assert.ok(c2.removed > 0, 'the fixture really does exercise a removal, not only additions');

  // A wrong cached TOTAL must not be permanent. This is why a running total was rejected: resuming from
  // one is inheriting it, so a single bad write is never recomputed and the number is frozen for good
  // (observed for real: 0 over 2,800 edits). Here the sum is rebuilt in full on the next log change, so
  // a bad value is bounded by one edit rather than forever.
  // A delta computed from a blob that could not be READ must never be cached. blobText returns '' for a
  // missing snapshot so rendering degrades instead of crashing — which makes lineDelta report a plausible
  // wrong number, filed under the INTACT sha. Content-keying makes a hit exact only when the content was
  // actually there, and nothing would ever heal it, because the key never changes.
  const gone = add('p\nq\nr\n', 'p\n'); // a removal, so a lost `before` changes the answer visibly
  const rec = core.readLog(S).find((x) => x.id === gone);
  const pairKey = `${rec.beforeBlob}:${rec.afterBlob}`;
  const blob = path.join(core.rootDir(), S, 'blobs', rec.beforeBlob);
  const stampBefore = sidecar().countsStamp;
  const blobBytes = fs.readFileSync(blob);
  fs.rmSync(blob);
  core.sessionCounts(S); // computes from an unreadable blob — allowed to be wrong, must not be STORED
  // Assert the FILE, not the returned number: `full()` recomputes through lineDelta, whose in-process
  // memo is poisoned by the very same failed read, so oracle and cache agree on the wrong value and any
  // comparison between them passes either way. The stored entry is the only uncontaminated witness.
  const stored = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).pairs;
  assert.ok(!(pairKey in stored), 'a delta computed from an unreadable blob is never written to the cache');
  // …and neither is the AGGREGATE it feeds. The sidecar's stamp covers the LOG only, but added/removed
  // come from BLOBS — so a sum derived from a snapshot this session could not read would be filed under
  // a stamp that, for a finished session, never moves again. Leaving the sidecar untouched is what makes
  // "wrong is bounded by one edit" true of the total and not just of the per-pair entries.
  assert.equal(sidecar().countsStamp, stampBefore,
    'an incomplete pass leaves the sidecar alone rather than freezing a guess under a log-only stamp');
  fs.writeFileSync(blob, blobBytes); // the snapshot comes back — and with it a persistable pass
  core.sessionCounts(S);
  assert.notEqual(sidecar().countsStamp, stampBefore, 'positive control: a COMPLETE pass does write the sidecar');

  const poisoned = { ...sidecar(), counts: { ...sidecar().counts, added: 0, removed: 0 } };
  fs.writeFileSync(path.join(core.rootDir(), 'session-meta', S + '.json'), JSON.stringify(poisoned));
  assert.equal(core.sessionCounts(S).added, 0, 'a current stamp is still served from cache (it is a cache)');
  add('a\nb\nc\nd\n', 'a\nb\nc\nd\ne\n'); // the log moves on
  c = core.sessionCounts(S);
  assert.deepEqual({ added: c.added, removed: c.removed }, full(), 'and the next change heals it completely');
  assert.notEqual(c.added, 0, 'the poisoned zero did not survive');
});

test('changemap: the GC reclaims cache payloads from a superseded version, and spares the live ones (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'staleMaps';
  const cwd = fs.realpathSync(tmpWork());
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'),
    JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', cwd, message: { role: 'user', content: 'go' } }) + '\n');
  seedEdit(S, path.join(cwd, 'a.ts'), 'x\n', 'y\n');
  // Write the live entry with the REAL writer, and read the current version back out of it. Hand-writing
  // a fixture and hard-coding "2" is what this test did, which tied it to nothing: the GC's version rule
  // and the writer's version could drift apart and only the fixture would notice, and a version bump
  // failed the test rather than the code. The version is an implementation detail of the writer — the
  // GC's contract is "spare what the writer just made, reclaim what it superseded".
  core.cachedChangeMap(cwd, S, { root: cwd, prompts: true });
  const dir = path.join(core.rootDir(), 'changemap-cache', S);
  const live = fs.readdirSync(dir).filter((f) => /^[0-9a-f]{16}\.json$/.test(f));
  assert.equal(live.length, 1, 'positive control: the real writer produced exactly one map payload');
  const version = Number(JSON.parse(fs.readFileSync(path.join(dir, live[0]), 'utf8')).stamp.split('|')[0]);
  assert.ok(Number.isInteger(version) && version >= 1, `the live entry carries a version (got ${version})`);
  const write = (name, stamp) => fs.writeFileSync(path.join(dir, name), JSON.stringify({ stamp, map: { summary: {} } }));
  write('0123456789abcdef.json', `${version - 1}|t|l|p|d`); // superseded
  write('fedcba9876543210.json', `${version - 1}|t|l|-|d`); // superseded
  fs.writeFileSync(path.join(dir, 'placements.json'), JSON.stringify({ version: 1, entries: {} }));
  fs.writeFileSync(path.join(dir, 'deltas.json'), JSON.stringify({ version: 1, pairs: {} }));

  const r = core.pruneStaleMaps(S);
  assert.equal(r.removed, 2, 'both superseded payloads are reclaimed');
  assert.ok(r.bytes > 0, 'and their bytes are reported');
  const left = fs.readdirSync(dir).sort();
  // The sibling caches are content-keyed with their own version fields — a name-based sweep must not
  // touch them, or the GC would silently delete the two caches this release exists to add.
  assert.deepEqual(left, [live[0], 'deltas.json', 'placements.json'].sort(), 'the live map and both sibling caches survive');
  assert.equal(core.pruneStaleMaps(S).removed, 0, 'a second sweep finds nothing (it is not re-reaping)');
  assert.deepEqual(core.pruneStaleMaps('noSuchSession'), { removed: 0, bytes: 0 }, 'a session with no cache is not an error');
});

test('observe: a session row and the change map agree about pending and ±lines (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'agreeSess';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'user', cwd, message: { role: 'user', content: 'go' } }) + '\n'
  );
  const f = path.join(cwd, 'a.ts');
  const v1 = 'one\n';
  const v2 = 'one\ntwo\n';
  const v3 = 'one\ntwoX\n';
  const v4 = 'one\ntwoXY\n';
  fs.writeFileSync(f, v4);
  // SAME-CODE edits: a perfect CHAIN where each edit rewrites the line the previous one produced, which
  // is what `reviewEdits` collapses into a single review unit. A raw record count and a display-unit
  // count therefore diverge here — exactly how the Sessions row came to say 5,198 pending while the
  // Overview's summary bar said 3,609 for the same session.
  seedEdit(S, f, v1, v2);
  seedEdit(S, f, v2, v3);
  seedEdit(S, f, v3, v4);

  const raw = core.readLog(S).filter((r) => r.status === 'pending').length;
  const counts = core.sessionCounts(S);
  const map = core.cachedChangeMap(cwd, S, { root: cwd });
  assert.ok(raw > counts.pending, 'the fixture really does collapse (otherwise this proves nothing)');
  assert.equal(counts.pending, map.summary.pending, 'the row and the map agree about pending');
  assert.equal(counts.added, map.summary.added, '…and about added lines');
  assert.equal(counts.removed, map.summary.removed, '…and about removed lines');

  // EVERY surface that reports "how many edits / how many pending" must answer with the same number.
  // These are five independent implementations over the same log, and before 0.9.0 three of them
  // counted raw records while the change map counted collapsed units — so Stats, the Prompts rollup,
  // the summary and the session row could each print a different total for one session.
  const metrics = core.sessionMetrics(cwd, S);
  const summary = core.reviewSummary(S);
  const asks = core.sessionPrompts(cwd, S);
  const askPending = asks.reduce((n, a) => n + (a.pending || 0), 0);
  assert.equal(metrics.edits.pending, counts.pending, 'metrics agrees');
  assert.equal(metrics.edits.count, map.summary.units, 'metrics counts display units, not raw records');
  // No `?? counts.pending` fallback: it made the assertion satisfy itself the moment reviewSummary stopped
  // emitting `pending`, which is precisely the regression it is here to catch.
  assert.equal(summary.pending, counts.pending, 'the review summary agrees');
  assert.equal(askPending, counts.pending, 'the per-ask rollup agrees');
  assert.ok(
    core.heuristicSuggestions(S).some((s) => s.startsWith(`${counts.pending} edit(s) still pending`)),
    'and the suggestion text quotes the same number'
  );
});

test('store: a bulk status change is one parse and one append, and skips no-ops (0.8.8)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'bulkKeep';
  core.ensureStore(S);
  const lp = path.join(core.storeDir(S), 'log.jsonl');
  const N = 4000;
  const lines = [];
  for (let id = 1; id <= N; id++)
    lines.push(JSON.stringify({ id, ts: 1000 + id, tool: 'Edit', file: '/w/f' + (id % 30) + '.ts', added: 1, removed: 0, status: 'pending' }));
  fs.writeFileSync(lp, lines.join('\n') + '\n');

  // Per-edit setStatus re-resolves the record through readLog, whose memo its own append invalidates —
  // quadratic, and unusable at the size a real session reaches. The bulk path parses once.
  const before = fs.statSync(lp).size;
  const t0 = Date.now();
  const changed = core.setStatusMany(S, core.readLog(S).map((r) => r.id), 'kept');
  const ms = Date.now() - t0;
  assert.equal(changed.length, N, 'every pending edit changed');
  assert.ok(ms < 2000, `accepting ${N} edits stays interactive (took ${ms}ms)`);
  assert.equal(core.readLog(S).filter((r) => r.status === 'kept').length, N, 'and the log reads back kept');

  // A second Accept All must be a no-op, not another N ops appended: a log that doubles on every
  // repeated bulk action is how a session's store runs away.
  const after = fs.statSync(lp).size;
  assert.deepEqual(core.setStatusMany(S, core.readLog(S).map((r) => r.id), 'kept'), [], 'nothing left to change');
  assert.equal(fs.statSync(lp).size, after, 'and nothing was written');
  assert.ok(after > before, 'the first pass did append its ops');

  // Clearing the resolved set then leaves an empty log rather than a rewritten one.
  assert.equal(core.clearResolved(S), N, 'clear drops exactly the resolved edits');
  assert.equal(core.readLog(S).length, 0, 'the log is empty afterwards');
});

test('store: nextId reads the log TAIL past 64 KB and still agrees with a full parse (0.8.8)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'tailIds';
  core.ensureStore(S);
  const lp = path.join(core.storeDir(S), 'log.jsonl');
  // Grow the log past the 64 KB threshold the fast path is gated on — asserted, never assumed from a
  // record count, because the record size is not this test's business.
  let n = 0;
  while (!fs.existsSync(lp) || fs.statSync(lp).size <= 64 * 1024) {
    core.appendLog(S, {
      tool: 'Edit', file: '/w/f' + (n % 7) + '.ts', before: null, after: null,
      added: 1, removed: 0, status: 'pending', ts: 1000 + n, reason: 'x'.repeat(180),
    });
    n++;
    assert.ok(n < 5000, 'the log should cross 64 KB long before this');
  }
  assert.ok(fs.statSync(lp).size > 64 * 1024, 'the fast path is actually exercised (log is past 64 KB)');

  // The tail read must agree with the full parse it replaces — the whole point is that it is a
  // shortcut, not a different answer.
  const full = core.readLog(S);
  const maxId = full.reduce((m, r) => Math.max(m, r.id), 0);
  assert.equal(core.nextId(S), maxId + 1, 'the tail read returns the same next id a full parse would');

  // …and a capture on top of it lands at that id, with no gap and no reuse.
  const rec = core.appendLog(S, {
    tool: 'Edit', file: '/w/after.ts', before: null, after: null,
    added: 1, removed: 0, status: 'pending', ts: 2_000_000,
  });
  assert.equal(rec.id, maxId + 1, 'the appended record takes the id the tail read predicted');
  const reread = core.readLog(S);
  assert.equal(new Set(reread.map((r) => r.id)).size, reread.length, 'no id is reused');

  // A status op appended after the last edit does NOT carry an id — the tail must skip ops, or the
  // next capture would collide with an existing edit.
  core.setStatus(S, rec.id, 'kept');
  assert.equal(core.nextId(S), rec.id + 1, 'trailing status ops do not disturb the id sequence');
});

test('store: a 64 KB tail of nothing but status ops never yields an id an edit already owns (0.8.8)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'tailOps';
  core.ensureStore(S);
  const lp = path.join(core.storeDir(S), 'log.jsonl');
  // The shape the tail read has to survive, written directly because a session reaches it only after
  // thousands of reviews: a few edits, then status ops all the way down. The ops carry the ids of the
  // edits they resolve, ASCENDING and ending far below the highest edit id — so a reader that does not
  // skip ops sees a perfectly monotonic sequence, trusts it, and hands back an id that is already taken.
  const EDITS = 2000;
  const OPS = 1400; // reviewed oldest-first, so their ids ascend and stop well below the newest edit
  const edits = [];
  for (let id = 1; id <= EDITS; id++)
    edits.push(JSON.stringify({ id, ts: 1000 + id, tool: 'Edit', file: '/w/f' + (id % 9) + '.ts', added: 1, removed: 0, status: 'pending' }));
  const ops = [];
  for (let id = 1; id <= OPS; id++)
    ops.push(JSON.stringify({ op: 'status', id, status: 'kept', ts: 9_000_000 + id }));
  fs.writeFileSync(lp, edits.concat(ops).join('\n') + '\n');
  assert.ok(fs.statSync(lp).size > 64 * 1024, 'the log is past the tail-read threshold');
  // The last 64 KB must be ops ONLY — otherwise an edit id in the tail would give the right answer for
  // the wrong reason, and this test would pass against a reader that ignores the op marker.
  const tail = fs.readFileSync(lp).subarray(-64 * 1024).toString('utf8').split('\n').slice(1).filter(Boolean);
  assert.ok(tail.every((l) => JSON.parse(l).op === 'status'), 'the tail read will see nothing but status ops');
  assert.ok(tail.length > 2, 'and enough of them for the fast path to trust the sequence');

  // Proof that the FAST PATH answered, not the fallback: count the bytes the call reads. The tail read
  // takes one 64 KB window; a full parse reads the whole file, which here is several times that.
  const realRead = fs.readSync;
  let bytesRead = 0;
  fs.readSync = function (...args) {
    const n = realRead.apply(fs, args);
    bytesRead += n;
    return n;
  };
  let answer;
  try {
    answer = core.nextId(S);
  } finally {
    fs.readSync = realRead;
  }
  assert.ok(bytesRead <= 64 * 1024, `the tail shortcut answered (read ${bytesRead} bytes, not the whole ${fs.statSync(lp).size})`);
  assert.equal(answer, EDITS + 1, 'the next id follows the highest EDIT, not the last status op');
  const rec = core.appendLog(S, {
    tool: 'Edit', file: '/w/after.ts', before: null, after: null, added: 1, removed: 0, status: 'pending', ts: 9_900_000,
  });
  assert.equal(rec.id, EDITS + 1, 'the capture takes that id');
  const ids = core.readLog(S).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length, 'and no edit id is reused');
});

test('store: a non-increasing tail falls back to the full parse rather than trusting it (0.8.8)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'tailDup';
  core.ensureStore(S);
  const lp = path.join(core.storeDir(S), 'log.jsonl');
  // Ids are strictly increasing in a healthy log, so the tail read trusts a sequence only while it
  // stays that way. Two interleaved writers (or a partially-written line) can break that, and the
  // shortcut must then defer to the full parse instead of returning the last id it happened to see.
  const lines = [];
  for (let id = 1; id <= 1500; id++)
    lines.push(JSON.stringify({ id, ts: 1000 + id, tool: 'Edit', file: '/w/f' + (id % 9) + '.ts', added: 1, removed: 0, status: 'pending' }));
  // …then one id repeated out of order, at the very end — inside the window the fast path reads.
  lines.push(JSON.stringify({ id: 900, ts: 99_999, tool: 'Edit', file: '/w/dup.ts', added: 1, removed: 0, status: 'pending' }));
  fs.writeFileSync(lp, lines.join('\n') + '\n');
  assert.ok(fs.statSync(lp).size > 64 * 1024, 'the log is past the tail-read threshold');
  // A tail that trusted its last id would answer 901 and hand the next capture an id three records
  // deep in the log. It defers instead, and the full parse reconciles the repeat to a fresh id (1501),
  // so the next one is 1502 — the duplicate is repaired rather than propagated.
  const full = core.readLog(S);
  assert.equal(full.length, 1501, 'every record survives — the duplicate is renumbered, not dropped');
  assert.equal(new Set(full.map((r) => r.id)).size, full.length, 'and the ids are unique afterwards');
  assert.equal(core.nextId(S), 1502, 'the next id follows the reconciled maximum, not the tail');
});

test('metrics: the usage cursor survives across processes — a cold reader delta-parses instead of re-reading (0.8.6)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'usagePersist';
  // realpath: on macOS os.tmpdir() hands back /var/… while a child process's cwd resolves to
  // /private/var/…, and the two mangle into different project-dir names — the transcript would be
  // written where the subprocess never looks.
  const cwd = fs.realpathSync(tmpWork());
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, S + '.jsonl');
  const line = (id, n, ts) =>
    JSON.stringify({ timestamp: ts, message: { role: 'assistant', id, model: 'claude-opus-4-8', usage: { input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: 0 }, content: [] } });
  // Real separate processes, because that IS the case being fixed: the status line runs one CLI per
  // prompt and the JetBrains stats poll one per tick, so an in-memory cursor never survives to help
  // them — only the persisted one does.
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const usage = () => JSON.parse(cp.execFileSync('node', [CLI, 'usage', '--session', S], { env, cwd, encoding: 'utf8' }));

  fs.writeFileSync(file, line('p1', 10, '2026-07-15T10:00:00.000Z') + '\n');
  assert.equal(usage().sessionTokens.input, 10, 'first (cold) process parses the whole file');

  fs.appendFileSync(file, line('p2', 5, '2026-07-15T10:05:00.000Z') + '\n');
  const second = usage();
  assert.equal(second.sessionTokens.input, 15, 'the next process resumes from the persisted totals and adds only the new turn');
  assert.equal(second.sessionTokens.output, 15, 'every counter carries forward, not just input');
  assert.equal(second.vitals.model.label, 'Opus 4.8', 'vitals ride the same persisted state');

  // A message id repeated far from its first appearance (a resumed session re-emitting earlier turns)
  // must not count twice — which is why the whole seen-set is persisted, not a last-id shortcut.
  fs.appendFileSync(file, line('p1', 10, '2026-07-15T10:09:00.000Z') + '\n');
  assert.equal(usage().sessionTokens.input, 15, 'a far-apart duplicate id is still deduped across processes');

  // A replaced (shrunken) transcript must invalidate rather than serve stale totals.
  fs.writeFileSync(file, line('q1', 3, '2026-07-15T11:00:00.000Z') + '\n');
  assert.equal(usage().sessionTokens.input, 3, 'a replaced transcript rescans from zero');
});

test('processes: background shells are reconstructed with runtime, exit code and output (0.8.7)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'bgProc';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const outFile = path.join(cwd, 'job.output');
  fs.writeFileSync(outFile, 'some output\n');
  // Verbatim record shapes: the spawn is a Bash tool_use with run_in_background, the result names the
  // shell in toolUseResult.backgroundTaskId, and the completion arrives as its own `queue-operation`
  // record carrying a <task-notification> block — which has no `message` at all.
  const spawn = (id, cmd, desc, ts) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd, description: desc, run_in_background: true } }] } });
  const result = (id, bg, ts) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', toolUseResult: { backgroundTaskId: bg }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${bg}. Output is being written to: ${outFile}. You will be notified.` }] } });
  const done = (bg, ts, code) =>
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(ts).toISOString(), content: `<task-notification> <task-id>${bg}</task-id> <status>completed</status> <summary>Background command "job" completed (exit code ${code})</summary> </task-notification>` });

  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      spawn('t1', 'npm test', 'Run the suite', 1000),
      result('t1', 'shellA', 1100),
      done('shellA', 61000, 0),
      spawn('t2', 'tail -f log', 'Watch the log', 2000),
      result('t2', 'shellB', 2100),
      // a foreground Bash must NOT appear
      JSON.stringify({ timestamp: new Date(3000).toISOString(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'ls' } }] } }),
    ].join('\n') + '\n'
  );

  const list = core.sessionProcesses(cwd, S, 92000); // pin "now" so the live runtime is deterministic
  assert.equal(list.length, 2, 'only backgrounded shells are listed — a foreground Bash is not a process');
  // Running first: the Processes tab leads with the shell you might still act on. Look rows up by id
  // rather than position so this assertion states identity, not ordering.
  assert.deepEqual(list.map((p) => p.id), ['shellB', 'shellA'], 'a running shell sorts above a finished one');
  const a = list.find((p) => p.id === 'shellA');
  const b = list.find((p) => p.id === 'shellB');
  assert.deepEqual([a.id, a.command, a.description], ['shellA', 'npm test', 'Run the suite'], 'identity comes from the spawn + its result');
  assert.equal(a.running, false, 'the completion notification ends it');
  assert.equal(a.exitCode, 0, 'the exit code is read out of the completion summary');
  assert.equal(a.runtimeMs, 60000, 'a finished shell measures start → finish');
  assert.equal(a.outputBytes, 12, 'the output file is stat-ed for volume');
  assert.equal(b.running, true, 'a shell with no completion notification is still running');
  assert.equal(b.runtimeMs, 90000, 'a live shell measures start → now');
  assert.equal(b.exitCode, null, 'a running shell has no exit code — reported as unknown, never 0');
  assert.deepEqual(core.summarizeProcesses(list), { total: 2, running: 1, failed: 0 }, 'headline for the Processes tab');
  assert.deepEqual(core.sessionProcesses(cwd, 'nope'), [], 'no transcript -> no processes');
});

test('feed: each kind tails the file that thing writes, and says what it dropped (0.8.7)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'feedSess';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const use = (id, name, input, ts) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
  const err = (id, ts) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true }] } });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [use('a1', 'Read', { file_path: '/x/one.ts' }, 1000), use('a2', 'Bash', { command: 'npm test' }, 2000), err('a2', 2100)].join('\n') + '\n'
  );

  const sess = core.liveFeed(cwd, S, { kind: 'session', id: '' });
  assert.equal(sess.entries.length, 2, 'the session feed is its main-chain tool calls');
  assert.equal(sess.entries[0].label, 'Read', 'oldest first — a feed reads downward like a terminal');
  assert.equal(sess.entries[1].ok, false, 'a failed call is marked, not silently normal');

  // A limit must report what it hid: a feed that silently truncates reads as "this is everything".
  const capped = core.liveFeed(cwd, S, { kind: 'session', id: '' }, { limit: 1 });
  assert.equal(capped.entries.length, 1, 'limit honoured');
  assert.equal(capped.truncated, 1, 'and the dropped count is reported');
  assert.equal(capped.entries[0].label, 'Bash', 'the NEWEST entries survive a cap, not the oldest');

  // A subagent's feed comes from its own transcript.
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const agFile = path.join(subDir, 'agent-ag1.jsonl');
  // A COMPLETED turn (the call and its result), then backdated: an unanswered tool call would read as
  // awaiting-permission — still alive — and phase is staleness-derived, so a file written a millisecond
  // ago never looks finished either. (utimesSync takes SECONDS.)
  fs.writeFileSync(
    agFile,
    [use('s1', 'Grep', { pattern: 'todo' }, 3000), JSON.stringify({ timestamp: new Date(3100).toISOString(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1' }] } })].join('\n') + '\n'
  );
  const anHourAgo = (Date.now() - 60 * 60_000) / 1000;
  fs.utimesSync(agFile, anHourAgo, anHourAgo);
  const ag = core.liveFeed(cwd, S, { kind: 'agent', id: 'ag1' });
  assert.equal(ag.entries[0].label, 'Grep', "an agent's feed is its OWN transcript, not the parent's");

  // A background shell has no structured events — its feed is the output file, tailed.
  const outFile = path.join(cwd, 'p.output');
  fs.writeFileSync(outFile, 'line one\nline two\n');
  fs.writeFileSync(
    path.join(proj, 'procFeed.jsonl'),
    [
      JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'p1', name: 'Bash', input: { command: 'tail -f log', run_in_background: true } }] } }),
      JSON.stringify({ timestamp: new Date(1100).toISOString(), type: 'user', toolUseResult: { backgroundTaskId: 'sh1' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'p1', content: `Command running in background with ID: sh1. Output is being written to: ${outFile}.` }] } }),
    ].join('\n') + '\n'
  );
  const proc = core.liveFeed(cwd, 'procFeed', { kind: 'process', id: 'sh1' });
  assert.deepEqual(proc.entries.map((e) => e.label), ['line one', 'line two'], 'output lines become feed rows');
  assert.equal(proc.entries[0].ts, 0, 'raw output carries no timestamp — reported as 0, never invented');
  assert.equal(proc.running, true, 'no completion notification yet -> still running');
  // A feed means a different thing depending on whether its source is still going: follow a live one,
  // read a finished one as the record it is. Renderers key their label and their polling off this.
  assert.equal(proc.mode, 'live', 'a running shell yields a LIVE feed');
  assert.equal(ag.mode, 'audit', 'a finished agent yields an AUDIT log, and should stop being polled');

  const missing = core.liveFeed(cwd, S, { kind: 'agent', id: 'nope' });
  assert.deepEqual([missing.entries.length, missing.running], [0, false], 'an unknown target is empty, not an error');
  assert.ok(missing.note, 'and says why it is empty');
});

test('processes: a shell that never reported an end is bounded by evidence, not by the clock (0.8.7)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'procEvidence';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const at = (ms) => new Date(ms).toISOString();
  const spawn = (id, cmd, ts, bg = true) =>
    JSON.stringify({ timestamp: at(ts), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: cmd, run_in_background: bg } }] } });
  const result = (id, bg, ts) =>
    JSON.stringify({ timestamp: at(ts), type: 'user', toolUseResult: { backgroundTaskId: bg }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Command running in background with ID: ${bg}.` }] } });
  const note = (bg, ts, status, code) =>
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(ts), content: `<task-notification> <task-id>${bg}</task-id> <tool-use-id>t9</tool-use-id> <status>${status}</status> <summary>done (exit code ${code})</summary> </task-notification>` });

  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      // never-ending shell: the session's last record is the last moment we can vouch for
      spawn('t1', 'tail -f log', 1000),
      result('t1', 'ghost', 1100),
      // the harness logs each completion TWICE (enqueue, then remove) — the FIRST is when it ended
      spawn('t2', 'npm test', 2000),
      result('t2', 'twice', 2100),
      note('twice', 62000, 'completed', 0),
      JSON.stringify({ type: 'queue-operation', operation: 'remove', timestamp: at(120000), content: '<task-notification> <task-id>twice</task-id> <status>completed</status> <summary>done (exit code 0)</summary> </task-notification>' }),
      // an end that arrives BEFORE the result binding its id must still be applied
      note('early', 3000, 'completed', 0),
      spawn('t3', 'sleep 1', 4000),
      result('t3', 'early', 4100),
      // an explicit kill is the only end some shells ever get
      spawn('t4', 'watch', 5000),
      result('t4', 'killme', 5100),
      JSON.stringify({ timestamp: at(9000), type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't5', name: 'TaskStop', input: { task_id: 'killme' } }] } }),
    ].join('\n') + '\n'
  );

  const byId = Object.fromEntries(core.sessionProcesses(cwd, S, 999999999).map((p) => [p.id, p]));
  assert.equal(byId.twice.runtimeMs, 60000, 'the FIRST completion is when it ended — the later `remove` inflated runtimes up to 10x');
  assert.equal(byId.early.running, false, 'a completion logged before its binding result is still applied');
  assert.equal(byId.killme.status, 'stopped', 'TaskStop is an end — otherwise a killed shell runs forever');
  assert.equal(byId.killme.running, false, 'and it is no longer polled');
  // The open shell: "nobody told us it stopped" is not "it is still running at this instant".
  assert.equal(byId.ghost.running, true, 'with no end recorded we do not claim it finished');
  // Last evidence in this fixture is the `remove` record at 120000, so the open shell measures to
  // there — not to `now`, which would have reported the age of the session instead of a runtime.
  assert.equal(byId.ghost.runtimeMs, 119000, 'an open shell is measured to the last evidence, never to the clock');
  assert.ok(byId.ghost.runtimeMs < 999999999 - byId.ghost.startedTs, 'and is nowhere near now-minus-start');
});

test('observe: a subagent edit takes ITS OWN reasoning, and one gap does not cascade (0.8.7)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'reasonAuthor';
  const cwd = tmpWork();
  const F = path.join(cwd, 'app.js');
  const G = path.join(cwd, 'lib.js');
  // #1 main-chain edit, #2 subagent edit (same file), #3 main-chain edit after an unexplained gap.
  seedEdit(S, F, 'a\n', 'b\n'); // id 1, ts 1000
  seedEdit(S, F, 'b\n', 'c\n'); // id 2, ts 2000  ← authored by the subagent
  seedEdit(S, G, 'x\n', 'y\n'); // id 3, ts 3000
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const turn = (ts, text, file) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }, { type: 'tool_use', id: 'u' + ts, name: 'Edit', input: { file_path: file } }] } });
  // The MAIN transcript explains #1 and #3 only — it never saw the subagent's edit.
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [turn(900, 'Main: rename the handler.', F), turn(2900, 'Main: extend the helper.', G)].join('\n') + '\n');
  // The subagent's own transcript explains #2.
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'agent-a1.jsonl'), turn(1900, 'Agent: tighten the guard clause.', F) + '\n');

  const m = core.reasoningByEdit(cwd, S);
  assert.equal(m.get(1), 'Main: rename the handler.', 'the main chain explains its own edit');
  // The bug this pins: the subagent's edit used to take the orchestrator's words (or nothing at all),
  // because only the main transcript was searched and matching walked a positional cursor.
  assert.equal(m.get(2), 'Agent: tighten the guard clause.', "a subagent's edit takes the words of the agent that made it");
  assert.equal(m.get(3), 'Main: extend the helper.', 'and a later edit is unaffected — one gap no longer shifts everything after it');
});

test('audits: boundary crossings land in the audit that owns them (0.8.7)', () => {
  const root = '/work/app';
  const acts = [
    { ts: 1, tool: 'Read', category: 'read', target: '/work/app/src/a.ts', ok: true, isError: false },
    { ts: 2, tool: 'Read', category: 'read', target: '/etc/hosts', ok: true, isError: false },
    { ts: 3, tool: 'Read', category: 'read', target: '/etc/hosts', ok: true, isError: false },
    { ts: 4, tool: 'Write', category: 'edit', target: '/work/app/src/b.ts', ok: true, isError: false },
    { ts: 5, tool: 'Edit', category: 'edit', target: '/tmp/scratch.md', ok: true, isError: false },
  ];
  // Reading outside the boundary is REACH — the same question egress answers for the network — so it
  // arrives as a channel of that report rather than as a second audit.
  const reads = core.outsideReads(acts, root);
  assert.equal(reads.length, 1, 'only the read that left the workspace is a channel');
  assert.deepEqual([reads[0].kind, reads[0].scope, reads[0].count], ['file', 'local', 2], 'repeat reads of one path collapse to a count');
  assert.notEqual(reads[0].scope, 'unknown', "'local' is a fact; 'unknown' is an admission — never collapse the two");

  // Writing outside it is DAMAGE, which is risk's question. Reported as an observation, never scored.
  const writes = core.outsideWrites(acts, root);
  assert.equal(writes.length, 1, 'only the edit that left the workspace is reported');
  assert.ok(writes[0].file.endsWith('scratch.md'), 'named by path so a renderer can open it');

  assert.deepEqual(core.outsideReads([], root), [], 'nothing read outside -> nothing claimed');
  assert.deepEqual(core.outsideWrites([], root), [], 'nothing written outside -> nothing claimed');
  assert.ok(/exercised, not approved/.test(core.EXERCISED_NOTE), 'the product rule survives the fold, in one place');
});

test('prompts: the session splits by what the USER asked, and work belongs to the ask that started it', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const S = 'reqSplit';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  // Three DIFFERENT files: same-code collapse folds repeated edits to one file into a single review
  // unit, and this test is about which ASK owns which work — not about the collapse.
  seedEdit(S, path.join(cwd, 'a.js'), 'a\n', 'b\n'); // id 1 → ts 1000
  seedEdit(S, path.join(cwd, 'b.js'), 'x\n', 'y\n'); // id 2 → ts 2000
  seedEdit(S, path.join(cwd, 'c.js'), 'p\n', 'q\n'); // id 3 → ts 3000
  const ask = (ts, text) =>
    JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: text } });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    [
      ask(500, 'first, add the thing'),
      // Records that WEAR the user's role without being anything a person typed. Counting any of them
      // would invent turns, and every one of these occurs in real transcripts.
      JSON.stringify({ timestamp: new Date(600).toISOString(), type: 'user', message: { role: 'user', content: '<local-command-stdout>Set effort level to max</local-command-stdout>' } }),
      JSON.stringify({ timestamp: new Date(700).toISOString(), type: 'user', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } }),
      JSON.stringify({ timestamp: new Date(800).toISOString(), type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
      JSON.stringify({ timestamp: new Date(900).toISOString(), type: 'user', isSidechain: true, message: { role: 'user', content: 'a subagent turn' } }),
      // Token usage inside request #1's window — the two lines share a message.id (one assistant
      // message split across lines), so the usage counts ONCE: 100+50+1000+200 = 1350.
      JSON.stringify({ timestamp: new Date(1500).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'msgA', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } }),
      JSON.stringify({ timestamp: new Date(1550).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'msgA', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } } }),
      // A to-do marked in_progress during request #1 → one "task worked".
      JSON.stringify({ timestamp: new Date(1600).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'msgT', content: [{ type: 'tool_use', id: 'tuTodo', name: 'TodoWrite', input: { todos: [{ content: 'build the thing', status: 'in_progress' }] } }] } }),
      // The SAME item planned the other way (0.8.8): a TaskCreate naming it, then TaskUpdate flipping
      // its status twice. Identity is the content digest, and TaskUpdate names nothing — so this whole
      // group still counts ONE task, not four. (The old counter keyed on the raw target string and
      // reported "1", "2" and the subject as three separate tasks.)
      JSON.stringify({ timestamp: new Date(1620).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'msgT2', content: [{ type: 'tool_use', id: 'tuTc', name: 'TaskCreate', input: { subject: 'build the thing', description: 'the same item, planned twice' } }] } }),
      JSON.stringify({ timestamp: new Date(1640).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'msgT3', content: [{ type: 'tool_use', id: 'tuTu1', name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }] } }),
      JSON.stringify({ timestamp: new Date(1660).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'msgT4', content: [{ type: 'tool_use', id: 'tuTu2', name: 'TaskUpdate', input: { taskId: 1, status: 'completed' } }] } }),
      ask(2500, 'now the second thing'),
      JSON.stringify({ timestamp: new Date(2600).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'msgB', usage: { input_tokens: 300, output_tokens: 200 } } }),
    ].join('\n') + '\n'
  );

  const rs = core.sessionPrompts(cwd, S);
  assert.equal(rs.length, 2, 'command stubs, compaction summaries, tool results and sidechains are not asks');
  assert.deepEqual(rs.map((r) => r.index), [1, 2], 'numbered the way a person counts their own turns');
  // Edits 1 and 2 landed before the second ask; edit 3 after it.
  assert.deepEqual(rs[0].editIds, [1, 2], 'the first ask owns the work done before the next one');
  assert.deepEqual(rs[1].editIds, [3], 'and the second owns what followed');
  assert.equal(rs[0].added > 0, true, '±lines are accumulated, not left at zero');
  assert.equal(rs[1].endTs, 0, 'the ask being answered has no end yet');
  assert.deepEqual(core.promptEditIds(cwd, S, rs[0].id), [1, 2], 'the review scope for "accept everything from this ask"');
  assert.deepEqual(core.summarizePrompts(rs), { total: 2, withEdits: 2, edits: 3 }, 'headline for the Prompts window');
  // 0.8.7: each ask carries files, folders, tokens and tasks — the per-request headline stats.
  assert.equal(rs[0].files, 2, 'prompt #1 touched a.js and b.js');
  assert.equal(rs[0].folders, 1, '…both in the one folder');
  assert.equal(rs[1].files, 1, 'prompt #2 touched only c.js');
  assert.equal(rs[0].tokens, 1350, 'tokens are summed from assistant usage and deduped by message id (counted once, not twice)');
  assert.equal(rs[1].tokens, 500, 'the second ask gets only the usage in its own window');
  assert.equal(
    rs[0].tasks,
    1,
    'one item planned as BOTH a to-do and a task, then moved twice, counts once — identity is the ' +
      'content digest shared by TodoWrite, TaskCreate and TaskUpdate'
  );
  assert.equal(rs[1].tasks, 0, 'an ask that touched no to-do reports zero, not a guess');
  assert.deepEqual(core.sessionPrompts(cwd, 'nope'), [], 'no transcript -> no prompts');

  // …and the SLICES the Requests window scopes everything by (0.8.7). Same partition, aggregated the
  // way a workflow's slice is, so a renderer can swap one for the other.
  const plain = core.buildChangeMap(cwd, S, { root: cwd });
  assert.deepEqual(plain.prompts, [], 'slices are opt-in — the fleet builds a map per sibling and none of them needs one');
  const map = core.buildChangeMap(cwd, S, { root: cwd, prompts: true });
  assert.equal(map.prompts.length, 2, 'one slice per ask');
  assert.equal(map.prompts[0].rollup.edits, 2, 'the first ask’s own edit count');
  assert.equal(map.prompts[1].rollup.edits, 1, '…and the second’s');
  assert.equal(
    map.prompts[0].rollup.added + map.prompts[1].rollup.added,
    map.summary.added,
    'the slices partition the session exactly — every line is claimed once'
  );
  assert.deepEqual(map.prompts[0].files.map((f) => f.file).sort(), ['a.js', 'b.js'], 'a slice carries its own file rollup (no renderer re-aggregates)');
  assert.deepEqual(map.prompts[1].files.map((f) => f.file), ['c.js'], '…and only its own files — never a neighbouring ask’s');
  assert.equal(map.prompts[0].modules.length, 1, '…plus its own folder buckets, for the strip');
  assert.equal(map.prompts[0].text, 'first, add the thing', 'the slice carries the ask in FULL — renderers wrap it, nothing is clipped');
  assert.deepEqual(map.prompts[0].editIds, [1, 2], 'the review scope rides along');

  // Accept/reject by REQUEST scope resolves to exactly that ask's edits and flips only those — the set
  // keepRequest/undoRequest apply in the editors. #1 owns edits 1 & 2; accepting it must leave #2's
  // edit 3 pending. (Task/folder/file scopes are covered end-to-end in test/e2e.sh.)
  for (const id of core.promptEditIds(cwd, S, rs[0].id)) core.setStatus(S, id, 'kept');
  const afterKeep = core.readLog(S);
  assert.deepEqual(afterKeep.filter((r) => r.status === 'kept').map((r) => r.id).sort((a, b) => a - b), [1, 2],
    'accepting a request flips exactly its own edits');
  assert.equal(afterKeep.find((r) => r.id === 3).status, 'pending', '…and leaves a neighbouring ask’s edit untouched');
});

// ---------------------------------------------------------------------------------------------
// 0.9.0 coverage for the verbs and caches this release added. Each of these was written because a
// mutation to the code it covers passed the whole suite: a green build was proving nothing about
// resolve, warm, --stale, the delta cache's READ path, or the placement store's prune rule.
// ---------------------------------------------------------------------------------------------

test('store: resolve accepts every pending edit and clears the log — in that order (0.9.0)', () => {
  freshHome();
  const S = 'resolveOrder';
  seedEdit(S, '/w/a.ts', 'x\n', 'y\n');
  seedEdit(S, '/w/b.ts', 'p\n', 'q\n');
  const c = seedEdit(S, '/w/c.ts', 'm\n', 'n\n');
  core.setStatus(S, c, 'kept'); // already carries a verdict before resolve runs
  const r = core.resolveSession(S);
  assert.deepEqual(r, { accepted: 2, cleared: 3 }, 'both pending edits accepted, all three records dropped');
  // THE ORDERING CONTROL. clearResolved only drops records that already carry a verdict, so running it
  // first would drop `c` alone (cleared: 1) and leave the two it never saw sitting in the log as kept.
  // `accepted` reads the same either way — the empty log is what pins the order.
  assert.deepEqual(core.readLog(S), [], 'nothing survives a resolve');
});

test('core: every built module loads standalone, so the require cycle stays benign (0.9.0)', () => {
  // observe.ts documents this test by name. It did not exist: every test requires the barrel, which
  // hides load-order faults because tsc hoists `exports.fn = fn` above the requires — true for function
  // declarations and silently false the first time a module exports a const computed at load.
  const dist = path.resolve(__dirname, '../dist');
  const mods = fs.readdirSync(dist).filter((f) => f.endsWith('.js') && f !== 'index.js');
  assert.ok(mods.length > 5, `positive control: found ${mods.length} modules to load`);
  const broken = [];
  for (const m of mods) {
    const r = cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(dist, m))})`], { encoding: 'utf8' });
    if (r.status !== 0) broken.push(`${m}: ${(r.stderr || '').split('\n').find((l) => l.trim()) || 'exit ' + r.status}`);
  }
  assert.deepEqual(broken, [], 'each module must be requirable on its own, not only through the barrel');
});

test('cli: warm skips the reviewed session and anything past --since (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork()); // execFileSync hands the child the realpath; projectDir must agree
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const now = Date.now();
  const mk = (id, ageMs) => {
    const p = path.join(proj, id + '.jsonl');
    fs.writeFileSync(p, [
      JSON.stringify({ timestamp: new Date(now - ageMs).toISOString(), type: 'user', message: { role: 'user', content: 'do a thing' } }),
      JSON.stringify({ timestamp: new Date(now - ageMs + 10).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'ok' }] } }),
    ].join('\n') + '\n');
    const s = (now - ageMs) / 1000;
    fs.utimesSync(p, s, s);
    core.ensureStore(id); // a store is what makes it a listed session
    return p;
  };
  mk('warmOld', 5 * 24 * 3600_000); // outside a 24h window
  mk('warmRecent', 2 * 3600_000);
  mk('warmCurrent', 1000); // newest transcript with an assistant record === the session under review
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const out = JSON.parse(cp.execFileSync('node', [CLI, 'warm', '--json', '--root', cwd, '--since', '24h'], { cwd, env, encoding: 'utf8' }));
  assert.deepEqual(out.warmed, ['warmRecent'], 'only the recent SIBLING is warmed');
  // Positive control for the window itself: widen it and the old session joins. Without this a `warm`
  // that simply warmed nothing would satisfy the assertion above.
  const wide = JSON.parse(cp.execFileSync('node', [CLI, 'warm', '--json', '--root', cwd, '--since', '7d'], { cwd, env, encoding: 'utf8' }));
  assert.deepEqual(wide.warmed.sort(), ['warmOld', 'warmRecent'], '--since widens the window but never pulls in the reviewed session');
  const bad = cp.spawnSync('node', [CLI, 'warm', '--root', cwd, '--since', 'soon'], { cwd, env, encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'a bad --since fails loudly rather than silently defaulting');
});

test('cli: clean --completed --stale widens the abandoned window only (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const now = Date.now();
  const mk = (id, ageMs) => {
    const p = path.join(proj, id + '.jsonl');
    fs.writeFileSync(p, [
      JSON.stringify({ timestamp: new Date(now - ageMs).toISOString(), type: 'user', message: { role: 'user', content: 'q' } }),
      JSON.stringify({ timestamp: new Date(now - ageMs + 10).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'a' }] } }),
    ].join('\n') + '\n');
    const s = (now - ageMs) / 1000;
    fs.utimesSync(p, s, s);
    return p;
  };
  mk('staleLive', 1000); // newest + an assistant record: this is the session under review, never reaped
  core.ensureStore('staleLive');
  mk('staleAband', 30 * 24 * 3600_000); // a month dead, but still holding unreviewed work
  seedEdit('staleAband', path.join(cwd, 'x.ts'), 'a\n', 'b\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const run = (extra) => JSON.parse(cp.execFileSync('node', [CLI, 'clean', '--completed', '--json', ...extra], { cwd, env, encoding: 'utf8' }));
  const spared = run(['--stale', '60d']);
  assert.ok(!spared.sessions.some((s) => s.id === 'staleAband'), '--stale 60d spares a session dead only 30 days');
  // Positive control: the DEFAULT 14-day window reaps exactly that session, so the assertion above is
  // measuring the flag and not an unreapable fixture.
  const reaped = run([]);
  const row = reaped.sessions.find((s) => s.id === 'staleAband');
  assert.ok(row, 'the default window reaps it');
  assert.equal(row.pending, 1, 'and the CLI reports the unreviewed work it discarded');
  assert.ok(!reaped.sessions.some((s) => s.id === 'staleLive'), 'the session under review is never reaped, at any window');
  for (const bad of [['--stale'], ['--stale', 'never']]) {
    assert.notEqual(cp.spawnSync('node', [CLI, 'clean', '--completed', ...bad], { cwd, env, encoding: 'utf8' }).status, 0, `\`clean --completed ${bad.join(' ')}\` fails loudly`);
  }
});

test('observe: the delta cache is READ, not just written — counts survive losing the blobs (0.9.0)', () => {
  const home = freshHome();
  const S = 'deltaRead';
  seedEdit(S, '/w/a.ts', 'a\nb\n', 'a\nb\nc\nd\ne\n'); // +3
  seedEdit(S, '/w/b.ts', 'p\nq\nr\n', 'p\n'); // -2
  const warm = core.sessionCounts(S);
  assert.deepEqual({ added: warm.added, removed: warm.removed }, { added: 3, removed: 2 }, 'the cold count is right');
  // Delete the evidence the count is derived FROM, and the sidecar that would answer from memory. A
  // cache that is written but never read now recomputes from nothing and reports zeroes.
  fs.rmSync(path.join(core.rootDir(), S, 'blobs'), { recursive: true, force: true });
  fs.rmSync(path.join(core.rootDir(), 'session-meta', `${S}.json`), { force: true });
  const child = cp.execFileSync('node', ['-e',
    `const c=require(${JSON.stringify(path.resolve(__dirname, '../dist/index.js'))});const r=c.sessionCounts(${JSON.stringify(S)});console.log(JSON.stringify({added:r.added,removed:r.removed}))`,
  ], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(child), { added: 3, removed: 2 }, 'a cold process answers from the persisted per-blob-pair cache');
});

test('observe: the delta cache drops entries for records that are gone (0.9.0)', () => {
  freshHome();
  const S = 'deltaPrune';
  const a = seedEdit(S, '/w/a.ts', 'a\n', 'a\nb\n');
  seedEdit(S, '/w/b.ts', 'p\n', 'p\nq\n');
  core.sessionCounts(S);
  const pairs = () => Object.keys(JSON.parse(fs.readFileSync(path.join(core.rootDir(), 'changemap-cache', S, 'deltas.json'), 'utf8')).pairs).length;
  assert.equal(pairs(), 2, 'both blob pairs cached');
  core.setStatus(S, a, 'kept');
  core.clearResolved(S);
  fs.rmSync(path.join(core.rootDir(), 'session-meta', `${S}.json`), { force: true }); // force a real recount
  core.sessionCounts(S);
  assert.equal(pairs(), 1, 'the dropped record takes its cache entry with it instead of leaking forever');
});

test('tree: a filtered build must not prune the placements of files it never looked at (0.9.0)', () => {
  freshHome();
  const cwd = fs.realpathSync(tmpWork());
  const S = 'placePrune';
  // Placement only runs for files with structure to place edits INTO — a class-free file is grouped as
  // `loose` and never touches the store, so a fixture without one exercises nothing.
  const before = (n) => `export class ${n} {\n  run() {\n    return 1;\n  }\n}\n`;
  const after = (n) => `export class ${n} {\n  run() {\n    return 1;\n  }\n  extra() {\n    return 2;\n  }\n}\n`;
  for (const f of ['alpha.ts', 'beta.ts']) {
    const n = f[0].toUpperCase() + f.slice(1, -3);
    fs.writeFileSync(path.join(cwd, f), after(n));
    seedEdit(S, path.join(cwd, f), before(n), after(n));
  }
  const pfile = path.join(core.rootDir(), 'changemap-cache', S, 'placements.json');
  core.buildEditTree(S, { root: cwd });
  const full = Object.keys(JSON.parse(fs.readFileSync(pfile, 'utf8')).entries).length;
  assert.equal(full, 2, 'an unfiltered build places both files');
  core.buildEditTree(S, { root: cwd, filter: 'alpha' });
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(pfile, 'utf8')).entries).length, 2,
    'a filtered build sees one file and must not treat the other as unreferenced');
});

test('observe: a plan with no rolling windows says so, instead of drawing empty quota bars (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const cwd = fs.realpathSync(tmpWork());
  const cache = path.join(home, '.claude', 'statusline-last.json');
  const write = (o) => { fs.writeFileSync(cache, JSON.stringify(o)); core.clearFsCache(); };

  // Claude Code sends rate_limits.* ONLY for Claude.ai subscription plans. An Enterprise or API account
  // gets a turn like this one — context, no limits — and the 5h/weekly bars then sat at empty forever,
  // which reads as "none of your quota used" rather than "this plan has no quota to use".
  write({ ctx_pct: 19, ctx_size: 1000000, ctx_used: 186131 });
  const ent = core.usageLine(cwd, 'none');
  assert.equal(ent.rollingLimits, false, 'a reading that carried no rate_limits means the plan has none');
  assert.deepEqual([ent.fiveHourPct, ent.weekPct], [null, null], 'and there is nothing to draw in the bars');
  assert.ok(Array.isArray(ent.localWindows) && ent.localWindows.length >= 1,
    'so it is replaced by something measurable — locally counted token windows');
  assert.ok(ent.localWindows.every((w) => typeof w.label === 'string' && typeof w.tokens === 'number'),
    'each window carries the label it was measured over, so a row cannot be drawn under the wrong one');

  // The status line measures the same transcripts against the clocks it draws. When it has written its
  // totals, they win — two surfaces reporting different numbers for one account is the bug this release
  // is mostly about.
  write({ ctx_pct: 19, five_meas: 3500, week_meas: 5250 });
  assert.deepEqual(core.usageLine(cwd, 'none').localWindows,
    [{ label: '5h', tokens: 3500 }, { label: 'wk', tokens: 5250 }],
    'the status line\u2019s own measured windows are preferred over a second local scan — and the week label reads "wk", as the status line itself prints it');

  // A subscription account must be untouched by all of this.
  write({ ctx_pct: 19, five_pct: 42, week_pct: 8 });
  const sub = core.usageLine(cwd, 'none');
  assert.equal(sub.rollingLimits, true, 'percentages present ⇒ this plan does have rolling windows');
  assert.equal(sub.fiveHourPct, 42, 'and they are still read exactly as before');
  assert.equal(sub.localWindows, null, 'the replacement is not computed for an account that will never see it');

  // And "nothing has reported yet" is a THIRD state, not the enterprise one — treating a missing cache
  // as "no limits" would tell every user who has not installed the status line that they have no plan.
  fs.rmSync(cache);
  core.clearFsCache();
  assert.equal(core.usageLine(cwd, 'none').rollingLimits, null, 'no reading at all is unknown, never false');
});

test('cli: clean reaches the GC blind spots — ghost cache dirs, orphaned cursors, dead blob-memo (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const root = core.rootDir();
  // 1. a changemap-cache dir whose session has NO store dir: the store-id loop never visits it, so its
  //    superseded-version payloads survived every GC (27 found on a real store). The LIVE-version file
  //    must survive — a transcript-only session's warm cache is a working cache, not garbage.
  const cd = path.join(root, 'changemap-cache', 'ghostSess');
  fs.mkdirSync(cd, { recursive: true });
  fs.writeFileSync(path.join(cd, '0123456789abcdef.json'), JSON.stringify({ stamp: '1|old', map: {} }));
  fs.writeFileSync(path.join(cd, 'aaaabbbbccccdddd.json'), JSON.stringify({ stamp: '3|live', map: {} }));
  // 2. usage cursors: filename is a one-way hash of the transcript path, unreachable from any session id.
  const uc = path.join(root, 'usage-cursors');
  fs.mkdirSync(uc, { recursive: true });
  fs.writeFileSync(path.join(uc, 'dead00.json'), JSON.stringify({ v: 1, transcript: '/no/such/file.jsonl', seen: [] }));
  const liveT = path.join(home, 'live.jsonl');
  fs.writeFileSync(liveT, '');
  fs.writeFileSync(path.join(uc, 'live00.json'), JSON.stringify({ v: 1, transcript: liveT, seen: [] }));
  fs.writeFileSync(path.join(uc, 'legacy.json'), JSON.stringify({ v: 1, seen: [] })); // path-less old format
  const old = (Date.now() - 40 * 24 * 3600e3) / 1000;
  fs.utimesSync(path.join(uc, 'legacy.json'), old, old);
  // 3. the artifact no released build ever read.
  fs.writeFileSync(path.join(root, 'blob-memo.json'), 'x'.repeat(1000));

  const out = JSON.parse(cp.execFileSync('node', [CLI, 'clean', '--json'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' }));
  assert.equal(out.staleMaps, 1, 'the ghost dir’s superseded payload is reaped');
  assert.equal(out.cursors, 2, 'the dead-path cursor and the aged path-less one are reaped');
  assert.ok(!fs.existsSync(path.join(cd, '0123456789abcdef.json')), 'superseded version gone');
  assert.ok(fs.existsSync(path.join(cd, 'aaaabbbbccccdddd.json')), 'live version kept');
  assert.ok(fs.existsSync(path.join(uc, 'live00.json')), 'a cursor whose transcript exists is never touched');
  assert.ok(!fs.existsSync(path.join(root, 'blob-memo.json')), 'blob-memo dropped');
  // Scoped clean must NOT sweep the blind spots: `--session x` names one session's store, and machine-
  // wide reaping on a scoped call would surprise exactly the caller who asked for the narrow thing.
  fs.writeFileSync(path.join(root, 'blob-memo.json'), 'y');
  core.ensureStore('scopedS');
  cp.execFileSync('node', [CLI, 'clean', '--session', 'scopedS', '--json'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(root, 'blob-memo.json')), 'a scoped clean leaves the machine-wide sweeps alone');
});

test('actions: outsideCounts — memoized boundary-crossing counts stay exact (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const ws = fs.realpathSync(tmpWork());
  const S = 'outCounts';
  const proj = core.projectDir(ws);
  fs.mkdirSync(proj, { recursive: true });
  const tp = path.join(proj, S + '.jsonl');
  const use = (name, input) => JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'assistant', message: { role: 'assistant', id: 'a' + Math.random(), content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] } });
  // ASYMMETRIC on purpose: 2 outside reads + 1 outside write — the asymmetry is the built-in positive
  // control, so a reads/writes swap cannot pass.
  fs.writeFileSync(tp, [
    use('Read', { file_path: path.join(home, 'outside-a.txt') }),
    use('Read', { file_path: path.join(home, 'outside-b.txt') }),
    use('Edit', { file_path: path.join(home, 'outside-c.txt'), old_string: 'x', new_string: 'y' }),
    use('Read', { file_path: path.join(ws, 'inside.txt') }), // inside the worktree — counted by neither
  ].join('\n') + '\n');
  core.ensureStore(S);
  assert.deepEqual(core.outsideCounts(ws, S), { reads: 2, writes: 1 }, 'counts match the transcript, not each other');
  // The stamp must cover the TRANSCRIPT: append one more outside write and the memo must not serve the
  // stale pair (a finished session's numbers are permanent precisely because its transcript is).
  fs.appendFileSync(tp, use('Write', { file_path: path.join(home, 'outside-d.txt'), content: 'z' }) + '\n');
  assert.deepEqual(core.outsideCounts(ws, S), { reads: 2, writes: 2 }, 'a grown transcript recounts');
});

test('prompts: promptWindows owns edits by ask window, boundary to the NEWER ask (0.9.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'pwOwner';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, o) => JSON.stringify({ timestamp: new Date(ts).toISOString(), ...o });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [
    line(1000, { type: 'user', message: { role: 'user', content: 'first ask' } }),
    line(5000, { type: 'user', message: { role: 'user', content: 'second ask' } }),
    line(5100, { type: 'assistant', message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n');
  // Three pending edits in DISTINCT files (so reviewEdits collapses nothing): before any ask, inside
  // ask 1, and exactly AT ask 2's timestamp — the boundary that pins the binary search.
  const mk = (ts, f) => { core.ensureStore(S); const b = core.writeBlob(S, Buffer.from('a\n')); const a = core.writeBlob(S, Buffer.from('b\n')); const id = core.nextId(S); core.appendLog(S, { id, ts, tool: 'Edit', file: path.join(cwd, f), beforeBlob: b, afterBlob: a, status: 'pending' }); return id; };
  mk(500, 'pre.ts');
  const mid = mk(2000, 'mid.ts');
  const edge = mk(5000, 'edge.ts');
  const w = core.promptWindows(cwd, S);
  assert.equal(w.length, 2, 'two asks, two windows');
  assert.deepEqual(w[0].editIds, [mid], 'ask 1 owns only the edit inside its window — the pre-ask edit belongs to nobody');
  assert.deepEqual(w[1].editIds, [edge], 'an edit stamped at an ask’s own ts belongs to the NEW ask, not the old one');
  assert.deepEqual([w[0].pending, w[1].pending], [1, 1], 'pending rides each window');
  // Positive control for the status overlay: keep the mid edit; its id stays owned, pending drops.
  core.setStatus(S, mid, 'kept');
  const w2 = core.promptWindows(cwd, S);
  assert.deepEqual(w2[0].editIds, [mid], 'a kept edit is still owned by its ask');
  assert.equal(w2[0].pending, 0, 'and no longer pending');
});

test('store: Windows drive-letter case — phantoms are healed, repaired, and undo-proofed (#43)', () => {
  freshHome();
  const S = 'caseSess';
  core.ensureStore(S);
  // canonPath is a pure transform, so the same assertions run on every CI OS.
  assert.equal(core.canonPath('c:\\repo\\x.ts'), 'C:\\repo\\x.ts', 'lowercase drive is uppercased');
  assert.equal(core.canonPath('C:/repo/x.ts'), 'C:/repo/x.ts', 'already-canonical stays');
  assert.equal(core.canonPath('/unix/path'), '/unix/path', 'POSIX paths untouched');
  assert.equal(core.canonPath('cargo.toml'), 'cargo.toml', 'a bare name with no drive is untouched');

  const blob = (txt) => core.writeBlob(S, Buffer.from(txt));
  const add = (file, before, after) => {
    const id = core.nextId(S);
    core.appendLog(S, { id, ts: id * 1000, tool: 'Bash', file, beforeBlob: before, afterBlob: after, status: 'pending' });
    return id;
  };
  // The issue's exact shape: one file, two cases — a phantom create and its delete twin.
  const A = blob('the untouched file\ncontents\n');
  const phantomCreate = add('C:\\repo\\ci.yml', null, A);
  const phantomDelete = add('c:\\repo\\ci.yml', A, null);
  // A LEGITIMATE create-then-delete of a temp file — one consistent path. The repair must keep it.
  const B = blob('temp\n');
  const legitCreate = add('C:\\repo\\tmp.txt', null, B);
  const legitDelete = add('C:\\repo\\tmp.txt', B, null);
  // And one real pending edit that must survive everything.
  const realEdit = add('C:\\repo\\real.ts', blob('a\n'), blob('b\n'));

  // 1. READ-SIDE HEAL: both phantom records surface under ONE canonical file.
  const files = new Set(core.readLog(S).map((r) => r.file));
  assert.ok(files.has('C:\\repo\\ci.yml') && !files.has('c:\\repo\\ci.yml'),
    'readLog serves one canonical path for the case twins');

  // 2. REPAIR: exactly the case-differing pair goes; the legit pair and the real edit stay.
  const r = core.repairCasePhantoms(S);
  assert.deepEqual(r, { pairs: 1, ids: [phantomCreate, phantomDelete].sort((a, b) => a - b) },
    'one provable pair found — raw-case difference is the discriminator');
  const left = core.readLog(S).map((x) => x.id).sort((a, b) => a - b);
  assert.deepEqual(left, [legitCreate, legitDelete, realEdit].sort((a, b) => a - b),
    'the same-case create+delete pair and the real edit are untouched');
  assert.equal(core.repairCasePhantoms(S).pairs, 0, 'a second repair finds nothing (idempotent)');
});

test('undo: the phantom guard is STRICT — a same-raw-path create+delete chain keeps ordinary undo semantics (#43)', () => {
  // The guard refuses only PROVABLE phantoms: the create and its delete-twin must disagree in RAW
  // path case (repairCasePhantoms' own discriminator). A genuine create→delete→re-create chain on
  // ONE consistent path (stash/checkout flows produce it) must not be misdiagnosed as a phantom and
  // pointed at a repair that would then find nothing. The refusal itself needs a real case-twin pair
  // with the file on disk, which only a Windows path can be — exercised end-to-end by the win32 test.
  freshHome();
  const S = 'caseUndo';
  const work = fs.realpathSync(tmpWork());
  core.ensureStore(S);
  const target = path.join(work, 'made-and-remade.txt');
  fs.writeFileSync(target, 'same bytes\n');
  const A = core.writeBlob(S, fs.readFileSync(target));
  const mk = (file, before, after) => { const id = core.nextId(S); core.appendLog(S, { id, ts: id * 1000, tool: 'Bash', file, beforeBlob: before, afterBlob: after, status: 'pending' }); return id; };
  const create = mk(target, null, A);
  mk(target, A, null); // same RAW path — NOT a provable phantom
  const res = core.undoEdit(S, create);
  assert.equal(res.ok, true, 'no phantom misdiagnosis on one consistent raw path');
  assert.ok(!fs.existsSync(target), 'the ordinary create-undo semantics hold (content matches → delete)');
  // Positive control for the guard's other gate: with no file on disk, a create-undo is a no-op success.
  const ghost = mk(path.join(work, 'never-on-disk.txt'), null, core.writeBlob(S, Buffer.from('tmp\n')));
  assert.equal(core.undoEdit(S, ghost).ok, true, 'a create whose file is gone undoes harmlessly');
});

test('cli: clean --phantoms wiring — removes a provable pair; a log-less session reports zero, not ENOENT (#43)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const home = process.env.HOME;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_OBSERVATORY_SESSION;
  const S = 'phWire';
  core.ensureStore(S);
  const blob = core.writeBlob(S, Buffer.from('x\n'));
  const mk = (file, before, after) => { const id = core.nextId(S); core.appendLog(S, { id, ts: id * 1000, tool: 'Bash', file, beforeBlob: before, afterBlob: after, status: 'pending' }); return id; };
  mk('C:\\repo\\ci.yml', null, blob);
  mk('c:\\repo\\ci.yml', blob, null);
  const runJson = (args) => JSON.parse(cp.execFileSync('node', [CLI, ...args], { env, encoding: 'utf8' }));
  assert.equal(runJson(['clean', '--phantoms', '--session', S, '--json']).pairs, 1, 'the flag reaches repairCasePhantoms');
  // A session that never captured (no log.jsonl at all): zero pairs and a clean exit — the undo
  // guard's error message names this command, so it must never die on ENOENT where it sends people.
  assert.equal(runJson(['clean', '--phantoms', '--session', 'never-captured', '--json']).pairs, 0, 'no log → zero pairs, not a crash');
});

test('scope: isUnderPath canonicalizes BOTH operands (#43)', () => {
  // EXACT-FILE scope is separator-free, so the canon is assertable on every CI OS. (FOLDER scope
  // splices the RUNTIME path.sep, so Windows folder prefixes only match on win32 — covered by the
  // win32-gated CLI test below.)
  assert.ok(core.isUnderPath('C:\\repo\\x.ts', 'c:\\repo\\x.ts'), 'exact-file scope with a lower-cased drive matches');
  assert.ok(core.isUnderPath('c:\\repo\\x.ts', 'C:\\repo\\x.ts'), 'a lower-cased record side is canonicalized too');
  assert.ok(!core.isUnderPath('C:\\repo\\x.ts', 'c:\\other\\x.ts'), 'a non-matching scope still refuses (positive control)');
  // FOLDER scope splices the RUNTIME path.sep, so assert it with native paths — POSIX literals here
  // failed on windows-latest ('/w/src' + '\\' matches nothing), the mirror of the trap above.
  const root = path.join('w', 'src');
  assert.ok(core.isUnderPath(path.join(root, 'a.ts'), root), 'native folder scope');
  assert.ok(!core.isUnderPath(path.join('w', 'srcx', 'a.ts'), root), 'native sibling prefix still refuses');
});

test('cli: list --file and keep --under canonicalize their operands (#43)', () => {
  // Platform-independent half: records with FAKE canonical Windows paths, read-only `list --file`
  // (keep/undo would try to touch C:\ paths on a POSIX runner, so the write half is win32-gated below).
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR; // the in-process store writes must land in the fake HOME too
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_OBSERVATORY_SESSION;
  const S = 'cliCase';
  core.ensureStore(S);
  const id = core.nextId(S);
  core.appendLog(S, {
    id, ts: 1000, tool: 'Edit', file: 'C:\\repo\\src\\mod.ts',
    beforeBlob: core.writeBlob(S, Buffer.from('a\n')), afterBlob: core.writeBlob(S, Buffer.from('b\n')), status: 'pending',
  });
  const runJson = (args) => JSON.parse(cp.execFileSync('node', [CLI, ...args], { env, encoding: 'utf8' }));
  const hit = runJson(['list', '--session', S, '--file', 'c:\\repo\\src', '--json']);
  assert.equal(hit.edits.length, 1, 'a lower-cased --file substring matches the canonical record');
  const miss = runJson(['list', '--session', S, '--file', 'c:\\other', '--json']);
  assert.equal(miss.edits.length, 0, 'a non-matching substring still matches nothing (positive control)');
  const kept = runJson(['keep', '--session', S, '--file', 'c:\\repo\\src', '--json']);
  assert.equal(kept.kept, 1, 'keep --file canonicalizes its substring the same way');
});

test('cli(win32): lower-cased drive operands work end-to-end — list, keep --under, locate', { skip: process.platform !== 'win32' }, () => {
  // REAL paths on the Windows runner: C:\Users\... — lower-case the drive letter in every operand,
  // exactly what a Git Bash shell or an editor hands over. Runs only on windows-latest CI.
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CLAUDE_OBSERVATORY_SESSION;
  const S = 'cliWin';
  core.ensureStore(S);
  const work = fs.realpathSync(tmpWork());
  const target = path.join(work, 'mod.ts');
  fs.writeFileSync(target, 'b\n');
  const canonical = core.canonPath(target);
  assert.notEqual(canonical, canonical[0].toLowerCase() + canonical.slice(1), 'the runner path is drive-shaped');
  const id = core.nextId(S);
  core.appendLog(S, {
    id, ts: 1000, tool: 'Edit', file: canonical,
    beforeBlob: core.writeBlob(S, Buffer.from('a\n')), afterBlob: core.writeBlob(S, Buffer.from('b\n')), status: 'pending',
  });
  const lower = (p) => p[0].toLowerCase() + p.slice(1);
  assert.ok(core.isUnderPath(canonical, lower(work)), 'isUnderPath folder scope through a lower-cased drive (win32 sep)');
  const run = (args, input) => cp.execFileSync('node', [CLI, ...args], { env, encoding: 'utf8', ...(input === undefined ? {} : { input }) });
  const runJson = (args, input) => JSON.parse(run(args, input));
  assert.equal(runJson(['list', '--session', S, '--file', lower(target), '--json']).edits.length, 1, 'list --file');
  const loc = runJson(['locate', '--session', S, '--file', lower(target), '--json'], 'b\n');
  assert.equal(loc.placements.length, 1, 'locate --file finds the pending edit through a lower-cased drive');
  const kept = runJson(['keep', '--session', S, '--under', lower(work), '--json']);
  assert.equal(kept.kept, 1, 'keep --under scopes through a lower-cased drive');

  // The REAL #43 shape end-to-end: one file, two RAW drive cases, the file on disk. Both undo paths
  // must refuse, the bulk revert must SAY so, and the named repair must remove the pair.
  const phTarget = path.join(work, 'phantom.txt');
  fs.writeFileSync(phTarget, 'untouched\n');
  const P = core.writeBlob(S, fs.readFileSync(phTarget));
  const mk = (file, before, after) => { const pid = core.nextId(S); core.appendLog(S, { id: pid, ts: pid * 1000, tool: 'Bash', file, beforeBlob: before, afterBlob: after, status: 'pending' }); return pid; };
  const create = mk(core.canonPath(phTarget), null, P);
  mk(lower(core.canonPath(phTarget)), P, null); // the delete-twin under the OTHER raw case
  assert.equal(core.undoEdit(S, create).ok, false, 'undoEdit refuses the provable phantom');
  assert.equal(core.restoreFile(S, create).ok, false, 'the --force path refuses it too');
  assert.ok(fs.existsSync(phTarget), 'the untouched file survives both undo paths');
  const scope = core.undoScope(S, { under: lower(work) });
  assert.ok(scope.errors >= 1 && /phantom/.test(scope.firstError ?? ''), 'bulk revert counts and names the refusal');
  assert.equal(runJson(['clean', '--phantoms', '--session', S, '--json']).pairs, 1, 'clean --phantoms removes the pair');
});

test('install: statuslineInstalled detects OURS and only ours (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(core.statuslineInstalled(), false, 'nothing installed — false');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `bash ${path.join(dir, 'statusline.sh')}` } }));
  assert.equal(core.statuslineInstalled(), false, 'settings point at a script that does not exist — false (never "refresh" onto nothing)');
  fs.writeFileSync(path.join(dir, 'statusline.sh'), '#!/bin/bash\n');
  assert.equal(core.statuslineInstalled(), true, 'settings + script — true');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: '/usr/local/bin/some-other-statusline' } }));
  assert.equal(core.statuslineInstalled(), false, 'a FOREIGN status line is never treated as ours');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'bash /home/u/tools/statusline.sh' } }));
  assert.equal(core.statuslineInstalled(), false, "someone else's statusline.sh at a foreign path is not ours — the match is the FULL config-dir path, and `update` must never overwrite it");
  fs.writeFileSync(path.join(dir, 'settings.json'), '{corrupt');
  assert.equal(core.statuslineInstalled(), false, 'corrupt settings — false, never a throw');
});
