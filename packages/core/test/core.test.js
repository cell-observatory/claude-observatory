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
  assert.equal(readStoreLog(home, S).length, 0, 'binary edits are skipped');
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
