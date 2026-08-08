/**
 * Surgical undo engine for Claude Observatory.
 *
 * For edit N we hold the full file content BEFORE (before_N) and AFTER (after_N). To undo only N
 * while keeping later edits to the same file, we do a POSITION-ANCHORED 3-way merge with after_N as
 * the common base: `ours` = the file's current on-disk content (after_N + later edits), `theirs` =
 * before_N (after_N with edit N reversed). Merging both onto the common base applies the undo AND
 * the later edits; if the two truly overlap, the merge reports a conflict and we offer a per-file
 * restore fallback. Anchoring to the base (rather than fuzzy patch application that searches for
 * matching text) is what makes this safe against duplicated content — a fuzzy reverse-patch could
 * silently revert the wrong duplicate block and pass a naive round-trip check.
 *
 * Pure filesystem + the `diff` package. No model calls, zero tokens.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EditRecord, EditStatus, OperationEntry, findRecord, isUnderPath, readBlob, readLog, readLogRaw, setStatus, setStatusMany } from './store';
import { canonPath } from './paths';
import { groupMembers } from './groups';
import { unitDependents } from './units';
import { taskEditIds } from './changemap';
import { threeWayMerge } from './merge';


export interface UndoResult {
  ok: boolean;
  status: 'undone' | 'redone' | 'deleted' | 'conflict' | 'noop' | 'error';
  message: string;
  /** On an undo conflict caused by LATER UNITS that rewrote this change's lines: their unit reps,
   *  ascending. Absent on ordinary conflicts (a manual/external change). Additive — never renamed. */
  dependents?: number[];
  /** With [dependents]: the whole closure as RAW member ids, newest first — exactly the set
   *  `undo --ids` takes to revert this change and its dependents in one call. */
  closure?: number[];
}

/** Raw blob bytes (exactly what capture stored) — the fidelity-preserving read. */
function blobBuf(sessionId: string, sha: string | null): Buffer | null {
  return sha === null ? null : readBlob(sessionId, sha);
}

/** UTF-8 decode — ONLY for the line-based 3-way merge, which is inherently a text operation. Every
 *  whole-file restore path writes raw bytes instead, so a non-UTF-8 file is never corrupted. */
function blobText(sessionId: string, sha: string | null): string | null {
  const b = blobBuf(sessionId, sha);
  return b === null ? null : b.toString('utf8');
}

/** True iff `buf` survives a UTF-8 decode→encode round-trip. The 3-way merge is a text operation;
 *  merging a file that does NOT round-trip (Latin-1, UTF-16, mixed encodings — capturable because
 *  isBinary only screens for NUL) would silently rewrite its bytes as U+FFFD. Those inputs must
 *  degrade to the conflict path instead: the explicit whole-file restore stays byte-exact. */
function utf8RoundTrips(buf: Buffer): boolean {
  try {
    return Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
  } catch {
    // .toString('utf8') throws past V8's MAX_STRING_LENGTH (~512 MB). A file that large can't be
    // line-merged anyway — treat it as "does not round-trip" so undo/redo returns conflict (the
    // byte-exact whole-file restore) instead of crashing the whole bulk operation.
    return false;
  }
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeEnsuringDir(file: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// The line-merge primitives moved to `merge.ts` when `units.ts` needed `tokenizeLines` for its
// hop-shape diffs; importing this module from there would have closed a cycle. Same implementation,
// one copy — see that file's header.

/**
 * The file's baseline for a quick-diff: `current` with every still-PENDING edit reverted, computed
 * in-memory (the same position-anchored 3-way merge undoEdit uses, applied newest→oldest) so an editor
 * can show a git-style dirty-diff of exactly Claude's pending changes without touching disk. A manual
 * (non-Claude) edit stays in the baseline (it's `ours`, not reverted), so the diff shows only Claude's
 * work. Best-effort: an edit that won't cleanly revert is left in place rather than corrupting the text.
 */
export function fileBaseline(sessionId: string, file: string, current: string): string {
  const resolved = path.resolve(file);
  const pending = readLog(sessionId)
    .filter((r) => path.resolve(r.file) === resolved && r.status === 'pending')
    .sort((a, b) => b.id - a.id); // newest → oldest
  let text = current;
  for (const rec of pending) {
    const before = blobText(sessionId, rec.beforeBlob);
    const after = blobText(sessionId, rec.afterBlob);
    if (after === null) continue; // edit deleted the file, but it exists now — leave as-is
    if (before === null) {
      // new-file create: the baseline had no such content — drop what this edit added.
      text = text === after ? '' : threeWayMerge(after, text, '') ?? text;
      continue;
    }
    if (text === after) {
      text = before; // clean exact revert (no later edits since)
      continue;
    }
    text = threeWayMerge(after, text, before) ?? text; // later edits present — surgical revert
  }
  return text;
}

/**
 * Undo a single edit, preserving unrelated later edits where possible.
 * On overlap, returns { status: 'conflict' } without touching the file — caller can then call
 * restoreFile() (the `--force` / per-file fallback).
 */
export function undoEdit(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };
  return undoRecord(sessionId, rec, [id]);
}

/**
 * Undo one CHANGE: a record, or a whole review unit summed into its net blob pair. `rec` may be
 * synthetic — a unit's rep carrying the span's FIRST beforeBlob, exactly the record `reviewEdits`
 * renders — and `memberIds` are the records whose ledger status the outcome covers, flipped in ONE
 * append. The decision tree is the single-edit one, branch for branch; on conflict the DISK IS
 * UNTOUCHED and no status is written. `defer` skips the status write so a scoped caller can flush
 * one batch at the end instead of invalidating the readLog memo once per record.
 */
function undoRecord(sessionId: string, rec: EditRecord, memberIds: number[], defer = false): UndoResult {
  const id = rec.id;
  if (rec.status === 'undone') {
    return { ok: true, status: 'noop', message: `edit #${id} is already undone` };
  }
  const markUndone = (): void => {
    if (!defer) setStatusMany(sessionId, memberIds, 'undone');
  };

  const beforeBuf = blobBuf(sessionId, rec.beforeBlob);
  let currentBuf: Buffer | null;
  try {
    currentBuf = fs.readFileSync(rec.file);
  } catch {
    currentBuf = null;
  }
  const currentSha = currentBuf ? sha256(currentBuf) : null;

  const conflict = (): UndoResult => {
    // A dependent unit by definition rewrote lines this change produced, so the merge already
    // refused on its own — the dependency edge's job is to turn that anonymous refusal into a named
    // one with a one-call closure. A conflict with NO dependent unit keeps the original wording: it
    // means a manual or external change, and `--ids` would not help there.
    const dependents = unitDependents(sessionId, id).filter(
      (d) => findRecord(sessionId, d)?.status !== 'undone'
    );
    if (dependents.length) {
      const many = dependents.length > 1;
      const members = [...new Set([...dependents, id].flatMap((d) => groupMembers(sessionId, d)))];
      // The one-call closure exists only when `undo --ids` can actually perform it — that verb
      // reverts PENDING records alone. A kept unit anywhere in the set (this one, or a dependent)
      // would make the suggestion a no-op that re-prints itself; name the edge, offer --force.
      const allPending = members.every((m) => findRecord(sessionId, m)?.status === 'pending');
      if (allPending) {
        const closure = members.sort((a, b) => b - a); // newest first — the order undoScope reverts in
        return {
          ok: false,
          status: 'conflict',
          dependents,
          closure,
          message:
            `edit #${id} overlaps later work: unit${many ? 's' : ''} #${dependents.join(', #')} ` +
            `depend${many ? '' : 's'} on it. Undo ${many ? 'them together' : 'both'} with ` +
            `\`claude-observatory undo --ids ${closure.join(',')}\`, or --force to restore the whole file.`,
        };
      }
      return {
        ok: false,
        status: 'conflict',
        dependents,
        message:
          `edit #${id} overlaps later work: unit${many ? 's' : ''} #${dependents.join(', #')} ` +
          `depend${many ? '' : 's'} on it, and part of that chain is already accepted — ` +
          `review ${many ? 'those units' : 'that unit'} first, or --force to restore the whole file.`,
      };
    }
    return {
      ok: false,
      status: 'conflict',
      message:
        `edit #${id} overlaps a later change to ${path.basename(rec.file)}. ` +
        `Run \`claude-observatory undo ${id} --force\` to restore the file to its pre-edit-#${id} ` +
        `state (this also drops later edits to this file).`,
    };
  };

  // New-file create -> undo deletes the file, but ONLY if no later edit changed it since (compare by
  // sha of the raw bytes, never a UTF-8 round-trip).
  if (rec.beforeBlob === null) {
    // A unit whose FIRST member created the file and whose rep DELETED it nets to both blobs null:
    // "no file existed, none should exist". There is nothing of ours to remove — a file at that path
    // now is someone else's, its content captured in NO blob, so unlinking it would be unrecoverable
    // data loss (the old vacuous `rec.afterBlob !== null &&` guard did exactly that). Refuse when a
    // file exists; absent, the undo is a pure ledger flip.
    if (rec.afterBlob === null) {
      if (currentBuf !== null) return conflict();
      markUndone();
      return { ok: true, status: 'undone', message: `edit #${id} created and removed ${rec.file} — nothing to restore` };
    }
    // #43 phantom guard: this "creation" is one half of a capture artifact, not Claude's work, and the
    // content check below cannot save the file (the phantom's snapshot IS the untouched file, so it
    // always matches). Refuse and name the repair. Gated on the file still EXISTING: that is what
    // makes this undo destructive — a legitimate create-then-delete pair (Claude made a temp file and
    // removed it) has the same record shape but no file on disk, and its undo stays a harmless no-op.
    const twin = currentBuf === null ? undefined : phantomTwinOf(sessionId, rec);
    if (twin) return phantomRefusal(id, twin.id);
    if (currentSha !== null && currentSha !== rec.afterBlob) return conflict();
    try {
      if (currentBuf !== null) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    markUndone();
    return { ok: true, status: 'deleted', message: `deleted ${rec.file} (created by edit #${id})` };
  }

  // Edit deleted the file -> undo restores it (raw bytes), unless a later edit re-created it.
  if (rec.afterBlob === null) {
    if (currentBuf !== null) return conflict();
    writeEnsuringDir(rec.file, beforeBuf as Buffer);
    markUndone();
    return { ok: true, status: 'undone', message: `restored ${rec.file}` };
  }

  // Normal in-place edit; file missing now -> restore wholesale (raw bytes).
  if (currentBuf === null) {
    writeEnsuringDir(rec.file, beforeBuf as Buffer);
    markUndone();
    return {
      ok: true,
      status: 'undone',
      message: `${rec.file} was missing; restored to its pre-edit-#${id} state`,
    };
  }

  // No later edits touched this file -> clean, exact byte-for-byte revert.
  if (currentSha === rec.afterBlob) {
    fs.writeFileSync(rec.file, beforeBuf as Buffer);
    markUndone();
    return { ok: true, status: 'undone', message: `undid edit #${id} (${rec.file})` };
  }

  // Later edits exist -> position-anchored 3-way merge (base = after_N, ours = current, theirs = before).
  // Text-domain by necessity; the clean paths above already preserved bytes exactly.
  const afterBuf = blobBuf(sessionId, rec.afterBlob) as Buffer;
  if (!utf8RoundTrips(currentBuf) || !utf8RoundTrips(beforeBuf as Buffer) || !utf8RoundTrips(afterBuf)) {
    return conflict(); // non-UTF-8 content: a text merge would corrupt it — refuse, offer --force
  }
  const merged = threeWayMerge(
    afterBuf.toString('utf8'),
    currentBuf.toString('utf8'),
    (beforeBuf as Buffer).toString('utf8')
  );
  if (merged === null) return conflict(); // edit #id and a later edit genuinely overlap
  fs.writeFileSync(rec.file, merged);
  markUndone();
  return {
    ok: true,
    status: 'undone',
    message: `surgically undid edit #${id}, preserving later edits (${rec.file})`,
  };
}

/**
 * A wholesale per-file restore/reapply of edit `id` overwrites the file and DROPS every later edit to
 * that same file from disk. Mark those later edits `undone` so their recorded status matches disk —
 * otherwise the tree shows a pending/kept edit whose change is gone, and a later per-edit undo/redo
 * computes against a file that no longer matches its blobs (a spurious conflict).
 */
function markLaterSameFileDropped(sessionId: string, file: string, afterId: number): void {
  const ids = readLog(sessionId)
    .filter((r) => r.file === file && r.id > afterId && r.status !== 'undone')
    .map((r) => r.id);
  setStatusMany(sessionId, ids, 'undone'); // one parse + one append, however many were dropped
}

/**
 * The PROVABLE #43 phantom delete-twin of a pending create record, or undefined. Provable STRICTLY,
 * matching repairCasePhantoms: same canonical file, the twin's before-blob equals the create's
 * after-blob, both still pending — and the two RAW paths disagree (drive-letter case). A genuine
 * create→delete→re-create chain carries one consistent raw path and must keep its ordinary undo
 * semantics; without the raw-case discriminator the guard misdiagnosed exactly that chain and pointed
 * at a repair (`clean --phantoms`) that then correctly found nothing.
 */
function phantomTwinOf(sessionId: string, rec: EditRecord): EditRecord | undefined {
  const rawById = new Map(readLogRaw(sessionId).map((r) => [r.id, r.file]));
  const rawRec = rawById.get(rec.id);
  if (rawRec === undefined) return undefined;
  return readLog(sessionId).find(
    (t) =>
      t.id !== rec.id &&
      t.status === 'pending' &&
      t.afterBlob === null &&
      t.beforeBlob === rec.afterBlob &&
      t.file === rec.file &&
      rawById.get(t.id) !== undefined &&
      rawById.get(t.id) !== rawRec
  );
}

/** The one refusal both undo paths present — the remediation pointer must read identically. */
function phantomRefusal(id: number, twinId: number): UndoResult {
  return {
    ok: false,
    status: 'error',
    message:
      `edit #${id} looks like a Windows path-case phantom (its delete-twin is edit #${twinId}) — ` +
      `undoing it would delete a file Claude never touched. Run \`claude-observatory clean --phantoms\` to remove both records.`,
  };
}

/**
 * Per-file restore fallback (the `--force` path). Reverts the file to its state BEFORE edit `id`,
 * dropping any later edits to that same file. Used when undoEdit() reports a conflict.
 */
export function restoreFile(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };

  const beforeBuf = blobBuf(sessionId, rec.beforeBlob);
  if (beforeBuf === null) {
    // #43: the phantom guard holds on the FORCE path too — `undo <id> --force` on a phantom create
    // must not delete the untouched file either (the bulk flow's conflict hint names --force, so this
    // is exactly where a #43 victim lands next).
    if (rec.beforeBlob === null && fs.existsSync(rec.file)) {
      const twin = phantomTwinOf(sessionId, rec);
      if (twin) return phantomRefusal(id, twin.id);
    }
    try {
      if (fs.existsSync(rec.file)) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    setStatus(sessionId, id, 'undone');
    markLaterSameFileDropped(sessionId, rec.file, id);
    return { ok: true, status: 'deleted', message: `deleted ${rec.file} (created by edit #${id})` };
  }
  writeEnsuringDir(rec.file, beforeBuf);
  setStatus(sessionId, id, 'undone');
  markLaterSameFileDropped(sessionId, rec.file, id);
  return {
    ok: true,
    status: 'undone',
    message: `restored ${rec.file} to its pre-edit-#${id} state (later edits to this file dropped)`,
  };
}

/**
 * Re-apply a previously undone edit (the mirror of undoEdit in the forward direction): merge edit
 * #id (before -> after) back onto the current file, keeping unrelated later edits. Common base is
 * before_N. On overlap, returns { status: 'conflict' } and leaves the file untouched.
 */
export function redoEdit(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };
  return redoRecord(sessionId, rec, [id]);
}

/** The forward mirror of [undoRecord]: re-apply one change (a record, or a unit's net pair), its
 *  members returning to 'pending' in ONE append. Same synthetic-rec contract, same conflict contract
 *  (disk untouched, no status write), same `defer` contract for scoped callers. */
function redoRecord(sessionId: string, rec: EditRecord, memberIds: number[], defer = false): UndoResult {
  const id = rec.id;
  if (rec.status !== 'undone') {
    return { ok: true, status: 'noop', message: `edit #${id} is not undone — nothing to redo` };
  }
  const markPending = (): void => {
    if (!defer) setStatusMany(sessionId, memberIds, 'pending');
  };

  const afterBuf = blobBuf(sessionId, rec.afterBlob);
  const beforeBuf = blobBuf(sessionId, rec.beforeBlob);
  let currentBuf: Buffer | null;
  try {
    currentBuf = fs.readFileSync(rec.file);
  } catch {
    currentBuf = null;
  }
  const currentSha = currentBuf ? sha256(currentBuf) : null;

  const conflict = (): UndoResult => ({
    ok: false,
    status: 'conflict',
    message:
      `re-applying edit #${id} overlaps a later change to ${path.basename(rec.file)}. ` +
      `Run \`claude-observatory redo ${id} --force\` to force it (drops later edits to this file).`,
  });

  // Redo a creation -> re-create the file with `after` (raw bytes).
  if (rec.beforeBlob === null) {
    // The both-null net (a create→…→delete unit): re-applying it means the file STAYS absent. A file
    // there now is someone else's — fabricating an empty file over it (the old `?? Buffer.alloc(0)`)
    // was never a state any captured snapshot held.
    if (rec.afterBlob === null) {
      if (currentBuf !== null) return conflict();
      markPending();
      return { ok: true, status: 'redone', message: `re-applied edit #${id} — ${rec.file} stays removed` };
    }
    if (currentSha !== null && currentSha !== rec.afterBlob) return conflict();
    writeEnsuringDir(rec.file, afterBuf ?? Buffer.alloc(0));
    markPending();
    return { ok: true, status: 'redone', message: `re-applied edit #${id} — created ${rec.file}` };
  }

  // Redo a deletion -> delete the file again (only if it still matches its pre-deletion content).
  if (rec.afterBlob === null) {
    if (currentSha !== null && currentSha !== rec.beforeBlob) return conflict();
    try {
      if (currentBuf !== null) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    markPending();
    return { ok: true, status: 'deleted', message: `re-applied edit #${id} — deleted ${rec.file}` };
  }

  // Normal edit: file missing now -> write after wholesale (raw bytes).
  if (currentBuf === null) {
    writeEnsuringDir(rec.file, afterBuf as Buffer);
    markPending();
    return { ok: true, status: 'redone', message: `re-applied edit #${id} (${rec.file})` };
  }
  // No later edits -> clean forward apply (raw bytes).
  if (currentSha === rec.beforeBlob) {
    fs.writeFileSync(rec.file, afterBuf as Buffer);
    markPending();
    return { ok: true, status: 'redone', message: `re-applied edit #${id} (${rec.file})` };
  }
  // Later edits exist -> 3-way merge with before_N as the common base (text-domain by necessity).
  if (
    !utf8RoundTrips(currentBuf) ||
    !utf8RoundTrips(beforeBuf as Buffer) ||
    !utf8RoundTrips(afterBuf as Buffer)
  ) {
    return conflict(); // non-UTF-8 content: a text merge would corrupt it — refuse, offer --force
  }
  const merged = threeWayMerge(
    (beforeBuf as Buffer).toString('utf8'),
    currentBuf.toString('utf8'),
    (afterBuf as Buffer).toString('utf8')
  );
  if (merged === null) return conflict();
  fs.writeFileSync(rec.file, merged);
  markPending();
  return {
    ok: true,
    status: 'redone',
    message: `re-applied edit #${id}, preserving later edits (${rec.file})`,
  };
}

// --- group-aware review actions: keep/undo/redo operate on the whole same-code review unit (the
// collapsed group), so a superseded intermediate edit is never kept/reverted on its own ---

export interface GroupResult extends UndoResult {
  ids: number[]; // the member edit ids acted on
}

/**
 * Keep every PENDING edit in the review group containing `id`.
 *
 * Only pending ones, exactly as [keepTask] does and for the same reason: keeping an already-undone edit
 * asserts a change that is not on disk. `keep 1` on a reverted edit used to report `{"kept":1}` and flip
 * the ledger to 'kept' while the file still held the reverted content — and since that also marks the
 * edit RESOLVED, `clearResolved` would then drop it and the revert could never be redone.
 */
export function keepGroup(sessionId: string, id: number): { kept: number; ids: number[] } {
  const members = new Set(groupMembers(sessionId, id));
  const ids = readLog(sessionId)
    .filter((r) => members.has(r.id) && r.status === 'pending')
    .map((r) => r.id);
  setStatusMany(sessionId, ids, 'kept'); // one parse + one append, whatever the group's size
  return { kept: ids.length, ids };
}

/**
 * Undo the whole review unit containing `id` as ONE merge. A unit's members are contiguous, so its
 * net change IS the blob pair `(first.beforeBlob, rep.afterBlob)` — the same synthetic record
 * `reviewEdits` renders. The old member-by-member walk paid k × (file read + whole-file merge +
 * locked append) and could conflict against the unit's OWN chain, stopping half-reverted; summing
 * the chain into one pair makes that impossible. A conflict now means a LATER unrelated edit or a
 * manual change — never the chain itself — and every member flips in one append.
 */
export function undoGroup(sessionId: string, id: number): GroupResult {
  const ids = [...groupMembers(sessionId, id)].sort((a, b) => a - b); // oldest → newest
  // Singleton (the common case) keeps the exact single-edit semantics: noop / error / conflict / undone.
  if (ids.length === 1) return { ...undoEdit(sessionId, ids[0]), ids };
  const first = findRecord(sessionId, ids[0]);
  const rep = findRecord(sessionId, ids[ids.length - 1]);
  if (!first || !rep) return { ok: false, status: 'error', message: `no edit #${id} in this session`, ids };
  const res = undoRecord(sessionId, { ...rep, beforeBlob: first.beforeBlob }, ids);
  if (res.ok && res.status !== 'noop') {
    const message = res.status === 'deleted'
      ? `deleted ${rep.file} (created by this change — ${ids.length} edit(s))`
      : `reverted this change — ${ids.length} edit(s)`;
    return { ...res, message, ids };
  }
  return { ...res, ids };
}

/** Re-apply a whole undone unit as ONE merge — the forward mirror of [undoGroup]: base is the span's
 *  first `before`, `theirs` its rep's `after`, and every member returns to 'pending' in one append. */
export function redoGroup(sessionId: string, id: number): GroupResult {
  const ids = [...groupMembers(sessionId, id)].sort((a, b) => a - b); // oldest → newest
  if (ids.length === 1) return { ...redoEdit(sessionId, ids[0]), ids };
  const first = findRecord(sessionId, ids[0]);
  const rep = findRecord(sessionId, ids[ids.length - 1]);
  if (!first || !rep) return { ok: false, status: 'error', message: `no edit #${id} in this session`, ids };
  const res = redoRecord(sessionId, { ...rep, beforeBlob: first.beforeBlob }, ids);
  if (res.ok && res.status !== 'noop') {
    const message = res.status === 'deleted'
      ? `re-applied this change — deleted ${rep.file}`
      : `re-applied this change — ${ids.length} edit(s)`;
    return { ...res, message, ids };
  }
  return { ...res, ids };
}

/** Force a redo: write the edit's `after` content wholesale (dropping later edits to the file). */
export function reapplyFile(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };
  const afterBuf = blobBuf(sessionId, rec.afterBlob);
  if (afterBuf === null) {
    try {
      if (fs.existsSync(rec.file)) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    setStatus(sessionId, id, 'pending');
    markLaterSameFileDropped(sessionId, rec.file, id);
    return { ok: true, status: 'deleted', message: `re-applied edit #${id} — deleted ${rec.file}` };
  }
  writeEnsuringDir(rec.file, afterBuf);
  setStatus(sessionId, id, 'pending');
  markLaterSameFileDropped(sessionId, rec.file, id);
  return {
    ok: true,
    status: 'redone',
    message: `re-applied edit #${id} to ${rec.file} (later edits to this file dropped)`,
  };
}

export interface UndoScopeResult {
  undone: number; // edits actually reverted
  conflicts: number; // edits left in place because a later change overlapped (offer per-edit --force)
  errors: number; // edits refused outright (e.g. the #43 phantom guard) — without this the bulk totals lie
  firstError?: string; // the first refusal's message — its remediation pointer must reach the user
  firstConflict?: string; // the first conflict's message — a named-dependent refusal must reach the reader too
  total: number; // pending edits that matched the scope
  ids: number[]; // the reverted edit ids
}

/**
 * Revert every PENDING edit matching a scope, NEWEST-first (so each surgical undo stays on its clean
 * path — later edits are removed before earlier ones). Already-Accepted (kept) and already-undone
 * edits are left as-is; revert an accepted edit individually if you want it gone.
 *
 * This is the ONE implementation behind every scoped/bulk revert: the CLI's `undo --all|--file|--under`,
 * VS Code's file/folder/session Revert (in-process), and — via those CLI flags — JetBrains. Keeping the
 * enumeration here (rather than reimplementing the filter+sort+loop per surface) is what stops the three
 * front-ends from drifting. Scope: no opts = the whole session; `under` = a file (exact) or folder
 * (everything beneath, via isUnderPath); `fileSubstr` = a filename substring (the CLI `--file` filter).
 */
export function undoScope(
  sessionId: string,
  opts: { under?: string; fileSubstr?: string; ids?: number[] } = {}
): UndoScopeResult {
  const idSet = opts.ids ? new Set(opts.ids) : null; // the task-scoped path passes a resolved edit-id set
  const sub = opts.fileSubstr === undefined ? undefined : canonPath(opts.fileSubstr); // #43: match canonical records
  const targets = readLog(sessionId)
    .filter(
      (r) =>
        r.status === 'pending' &&
        (opts.under === undefined || isUnderPath(r.file, opts.under)) &&
        (sub === undefined || r.file.includes(sub)) &&
        (idSet === null || idSet.has(r.id))
    )
    .sort((a, b) => b.id - a.id);
  let undone = 0;
  let conflicts = 0;
  let errors = 0;
  let firstError: string | undefined;
  let firstConflict: string | undefined;
  const ids: number[] = [];
  try {
    for (const t of targets) {
      // Deferred status write: each per-record append would invalidate the readLog memo, making the
      // NEXT iteration re-parse the whole log — O(N) full parses per bulk revert. The successes flush
      // as ONE setStatusMany below instead.
      const r = undoRecord(sessionId, t, [t.id], true);
      if (r.status === 'conflict') {
        conflicts++;
        if (firstConflict === undefined) firstConflict = r.message;
      } else if (r.ok) {
        undone++;
        ids.push(t.id);
      } else {
        // A refusal (status 'error') is not a conflict and must not vanish from the arithmetic: on a
        // #43-corrupted store, "Reject All" hits the phantom guard for every phantom create, and the
        // refusal message is the only place the repair (`clean --phantoms`) is named.
        errors++;
        if (firstError === undefined) firstError = r.message;
      }
    }
  } finally {
    // The files already rewritten must not lose their ledger flip to a mid-loop throw (one EACCES
    // target aborting the walk) — flush whatever succeeded before the error propagates, or every
    // reverted-but-still-"pending" record answers a spurious conflict forever after.
    setStatusMany(sessionId, ids, 'undone');
  }
  return { undone, conflicts, errors, firstError, firstConflict, total: targets.length, ids };
}

export interface RedoScopeResult {
  redone: number;
  conflicts: number;
  total: number; // UNDONE edits in scope
  ids: number[]; // the re-applied edit ids
}

/**
 * The forward mirror of undoScope: re-apply every UNDONE edit in scope, OLDEST-first (so a later edit
 * re-merges onto the earlier ones it built on). Same single-implementation rationale — the CLI's
 * `redo --all|--file|--under|--ids`, VS Code's "Redo all", and (via those flags) JetBrains all route
 * here. On a per-edit overlap the edit stays undone and is counted as a conflict (redo it with --force).
 * Scope: no opts = the whole session; `under` = a file/folder (isUnderPath); `fileSubstr` = a filename
 * substring; `ids` = an explicit id set.
 */
export function redoScope(
  sessionId: string,
  opts: { under?: string; fileSubstr?: string; ids?: number[] } = {}
): RedoScopeResult {
  const idSet = opts.ids ? new Set(opts.ids) : null;
  const sub = opts.fileSubstr === undefined ? undefined : canonPath(opts.fileSubstr); // #43: match canonical records
  const targets = readLog(sessionId)
    .filter(
      (r) =>
        r.status === 'undone' &&
        (opts.under === undefined || isUnderPath(r.file, opts.under)) &&
        (sub === undefined || r.file.includes(sub)) &&
        (idSet === null || idSet.has(r.id))
    )
    .sort((a, b) => a.id - b.id); // oldest-first: re-apply in original order
  let redone = 0;
  let conflicts = 0;
  const ids: number[] = [];
  try {
    for (const t of targets) {
      // Deferred status write — same rationale as undoScope: one flush below, not one append per record.
      const r = redoRecord(sessionId, t, [t.id], true);
      if (r.status === 'conflict') conflicts++;
      else if (r.ok) {
        redone++;
        ids.push(t.id);
      }
    }
  } finally {
    setStatusMany(sessionId, ids, 'pending'); // flush survives a mid-loop throw — see undoScope
  }
  return { redone, conflicts, total: targets.length, ids };
}

/**
 * Reverse ONE journaled reviewer operation (store.ts `BatchOp`, listed by `oplog`).
 *
 * A 'keep' is a pure ledger change — restoring each record's journaled BEFORE-status is the whole
 * revert. An 'undo'/'redo' rewrote FILES, so statuses alone would lie about disk: those replay
 * through redoScope/undoScope and surface conflicts exactly like every other scoped verb. Every
 * path flows back through setStatusMany, so the revert is journaled too — `oplog --revert-last`
 * twice lands back where it started, never in a hidden state.
 */
export function revertOperation(
  session: string,
  entry: OperationEntry
): { kind: OperationEntry['kind']; restored?: number; result?: UndoScopeResult | RedoScopeResult } {
  // Disk verbs replay ONLY for records whose journaled BEFORE-status matches the disk operation the
  // kind names: an 'undo' rewrote files flipping pending→undone, a 'redo' flipping undone→pending.
  // Any other before-status means the journaled flip was ledger-only for that record — reverting a
  // keep journals kind 'redo' with prev 'kept', and replaying that through undoScope would rewrite
  // disk for an operation that never touched it (and land on 'undone', not back at 'kept').
  const canonical: EditStatus | null = entry.kind === 'undo' ? 'pending' : entry.kind === 'redo' ? 'undone' : null;
  const diskIds: number[] = [];
  const byPrev = new Map<EditStatus, number[]>();
  for (const id of entry.ids) {
    const prev = entry.prev[String(id)];
    if (!prev) continue;
    if (canonical !== null && prev === canonical) {
      diskIds.push(id);
    } else {
      const arr = byPrev.get(prev);
      if (arr) arr.push(id);
      else byPrev.set(prev, [id]);
    }
  }
  let restored = 0;
  for (const [status, ids] of byPrev) restored += setStatusMany(session, ids, status).length;
  if (entry.kind === 'undo' && diskIds.length) {
    return { kind: entry.kind, ...(restored ? { restored } : {}), result: redoScope(session, { ids: diskIds }) };
  }
  if (entry.kind === 'redo' && diskIds.length) {
    return { kind: entry.kind, ...(restored ? { restored } : {}), result: undoScope(session, { ids: diskIds }) };
  }
  return { kind: entry.kind, restored };
}

/**
 * Task-scoped revert: undo every PENDING edit in the task's STRICT edit set (taskEditIds — only edits
 * made inside a real in_progress interval; an edit that cannot be strictly placed is never included).
 * Reuses undoScope, so a task revert behaves exactly like every other scoped/bulk revert (newest-first,
 * per-edit conflict fallback — a mis-anchored revert still surfaces as a conflict, never a silent
 * clobber).
 */
export function undoTask(cwd: string, session: string, taskId: string): UndoScopeResult {
  return undoScope(session, { ids: taskEditIds(cwd, session, taskId) });
}

export interface KeepScopeResult {
  kept: number; // edits flipped to kept
  total: number; // edits in the task's STRICT edit set (taskEditIds), any status
  ids: number[]; // the kept edit ids
}

/**
 * Task-scoped keep: mark every PENDING edit in the task's STRICT edit set (taskEditIds — the same set
 * undoTask reverts) as kept. Only pending edits are flipped: keeping an already-undone edit would
 * assert a change that isn't on disk.
 */
export function keepTask(cwd: string, session: string, taskId: string): KeepScopeResult {
  const idSet = new Set(taskEditIds(cwd, session, taskId));
  const ids = readLog(session)
    .filter((r) => idSet.has(r.id) && r.status === 'pending')
    .map((r) => r.id);
  setStatusMany(session, ids, 'kept');
  return { kept: ids.length, total: idSet.size, ids };
}
