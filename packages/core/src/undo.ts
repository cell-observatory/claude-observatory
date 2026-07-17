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
import { diffArrays } from 'diff';
import { findRecord, isUnderPath, readBlob, readLog, setStatus } from './store';
import { groupMembers } from './groups';
import { reviewEditIds } from './changemap';

export interface UndoResult {
  ok: boolean;
  status: 'undone' | 'redone' | 'deleted' | 'conflict' | 'noop' | 'error';
  message: string;
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

/** Split into lines that KEEP their trailing "\n" (last line may lack one); join('') round-trips. */
function tokenizeLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

interface LineChange {
  start: number; // base token index
  del: number; // base tokens removed
  ins: string[]; // tokens inserted
}

/** Changes base->other in base-token coordinates, via diffArrays over newline-terminated lines. */
function lineChanges(base: string, other: string): LineChange[] {
  const parts = diffArrays(tokenizeLines(base), tokenizeLines(other));
  const out: LineChange[] = [];
  let baseIdx = 0;
  let i = 0;
  while (i < parts.length) {
    if (!parts[i].added && !parts[i].removed) {
      baseIdx += parts[i].value.length;
      i++;
      continue;
    }
    const start = baseIdx;
    let del = 0;
    const ins: string[] = [];
    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].removed) {
        del += parts[i].value.length;
        baseIdx += parts[i].value.length;
      } else {
        ins.push(...parts[i].value);
      }
      i++;
    }
    out.push({ start, del, ins });
  }
  return out;
}

/**
 * Position-anchored 3-way line merge. base = after_N; ours = current (base + later edits);
 * theirs = before_N (base with edit N undone). Returns merged text, or null on a genuine overlap.
 *
 * Anchoring on base line positions (not fuzzy text search) makes it safe against duplicated content;
 * zero-context change regions avoid the spurious "nearby edits" conflicts that a patch-level merge
 * produces when two edits fall within a context window of each other.
 */
function threeWayMerge(base: string, ours: string, theirs: string): string | null {
  const A = lineChanges(base, ours);
  const B = lineChanges(base, theirs);
  for (const a of A) {
    for (const b of B) {
      const a0 = a.start,
        a1 = a.start + a.del,
        b0 = b.start,
        b1 = b.start + b.del;
      const overlap = a0 < b1 && b0 < a1;
      const bothInsertSamePoint = a.del === 0 && b.del === 0 && a0 === b0;
      const insertInsideReplace =
        (a.del === 0 && a0 > b0 && a0 < b1) || (b.del === 0 && b0 > a0 && b0 < a1);
      if (overlap || bothInsertSamePoint || insertInsideReplace) return null;
    }
  }
  const baseTok = tokenizeLines(base);
  const all = [...A, ...B].sort((x, y) => x.start - y.start || x.del - y.del);
  const res: string[] = [];
  let i = 0;
  for (const ch of all) {
    while (i < ch.start) res.push(baseTok[i++]);
    res.push(...ch.ins);
    i = ch.start + ch.del;
  }
  while (i < baseTok.length) res.push(baseTok[i++]);
  return res.join('');
}

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
  if (rec.status === 'undone') {
    return { ok: true, status: 'noop', message: `edit #${id} is already undone` };
  }

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
      `edit #${id} overlaps a later change to ${path.basename(rec.file)}. ` +
      `Run \`claude-observatory undo ${id} --force\` to restore the file to its pre-edit-#${id} ` +
      `state (this also drops later edits to this file).`,
  });

  // New-file create -> undo deletes the file, but ONLY if no later edit changed it since (compare by
  // sha of the raw bytes, never a UTF-8 round-trip).
  if (rec.beforeBlob === null) {
    if (currentSha !== null && rec.afterBlob !== null && currentSha !== rec.afterBlob) return conflict();
    try {
      if (currentBuf !== null) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    setStatus(sessionId, id, 'undone');
    return { ok: true, status: 'deleted', message: `deleted ${rec.file} (created by edit #${id})` };
  }

  // Edit deleted the file -> undo restores it (raw bytes), unless a later edit re-created it.
  if (rec.afterBlob === null) {
    if (currentBuf !== null) return conflict();
    writeEnsuringDir(rec.file, beforeBuf as Buffer);
    setStatus(sessionId, id, 'undone');
    return { ok: true, status: 'undone', message: `restored ${rec.file}` };
  }

  // Normal in-place edit; file missing now -> restore wholesale (raw bytes).
  if (currentBuf === null) {
    writeEnsuringDir(rec.file, beforeBuf as Buffer);
    setStatus(sessionId, id, 'undone');
    return {
      ok: true,
      status: 'undone',
      message: `${rec.file} was missing; restored to its pre-edit-#${id} state`,
    };
  }

  // No later edits touched this file -> clean, exact byte-for-byte revert.
  if (currentSha === rec.afterBlob) {
    fs.writeFileSync(rec.file, beforeBuf as Buffer);
    setStatus(sessionId, id, 'undone');
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
  setStatus(sessionId, id, 'undone');
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
  for (const r of readLog(sessionId)) {
    if (r.file === file && r.id > afterId && r.status !== 'undone') setStatus(sessionId, r.id, 'undone');
  }
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
  if (rec.status !== 'undone') {
    return { ok: true, status: 'noop', message: `edit #${id} is not undone — nothing to redo` };
  }

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
    if (currentSha !== null && rec.afterBlob !== null && currentSha !== rec.afterBlob) return conflict();
    writeEnsuringDir(rec.file, afterBuf ?? Buffer.alloc(0));
    setStatus(sessionId, id, 'pending');
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
    setStatus(sessionId, id, 'pending');
    return { ok: true, status: 'deleted', message: `re-applied edit #${id} — deleted ${rec.file}` };
  }

  // Normal edit: file missing now -> write after wholesale (raw bytes).
  if (currentBuf === null) {
    writeEnsuringDir(rec.file, afterBuf as Buffer);
    setStatus(sessionId, id, 'pending');
    return { ok: true, status: 'redone', message: `re-applied edit #${id} (${rec.file})` };
  }
  // No later edits -> clean forward apply (raw bytes).
  if (currentSha === rec.beforeBlob) {
    fs.writeFileSync(rec.file, afterBuf as Buffer);
    setStatus(sessionId, id, 'pending');
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
  setStatus(sessionId, id, 'pending');
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

/** Keep every edit in the review group containing `id`. */
export function keepGroup(sessionId: string, id: number): { kept: number; ids: number[] } {
  const ids = groupMembers(sessionId, id);
  for (const m of ids) setStatus(sessionId, m, 'kept');
  return { kept: ids.length, ids };
}

/**
 * Undo every edit in the review group containing `id`, NEWEST-first — a clean sequential revert back
 * to the group's earliest before-state (the members are a chained overlap, so each step reverts
 * cleanly). Stops and returns the conflict if a member genuinely conflicts with an out-of-group edit.
 */
export function undoGroup(sessionId: string, id: number): GroupResult {
  const ids = [...groupMembers(sessionId, id)].sort((a, b) => b - a); // newest → oldest
  // Singleton (the common case) keeps the exact single-edit semantics: noop / error / conflict / undone.
  if (ids.length === 1) return { ...undoEdit(sessionId, ids[0]), ids };
  let undone = 0;
  for (const m of ids) {
    const res = undoEdit(sessionId, m);
    if (!res.ok && res.status !== 'noop') return { ...res, ids }; // conflict or error → stop + report
    if (res.status !== 'noop') undone++;
  }
  return { ok: true, status: 'undone', message: `reverted this change — ${undone} edit(s)`, ids };
}

/** Re-apply every undone edit in a group, OLDEST-first (rebuilds the chain). Mirror of undoGroup. */
export function redoGroup(sessionId: string, id: number): GroupResult {
  const ids = [...groupMembers(sessionId, id)].sort((a, b) => a - b); // oldest → newest
  if (ids.length === 1) return { ...redoEdit(sessionId, ids[0]), ids };
  let redone = 0;
  for (const m of ids) {
    const res = redoEdit(sessionId, m);
    if (!res.ok && res.status !== 'noop') return { ...res, ids };
    if (res.status !== 'noop') redone++;
  }
  return { ok: true, status: 'redone', message: `re-applied this change — ${redone} edit(s)`, ids };
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
  const targets = readLog(sessionId)
    .filter(
      (r) =>
        r.status === 'pending' &&
        (opts.under === undefined || isUnderPath(r.file, opts.under)) &&
        (opts.fileSubstr === undefined || r.file.includes(opts.fileSubstr)) &&
        (idSet === null || idSet.has(r.id))
    )
    .sort((a, b) => b.id - a.id);
  let undone = 0;
  let conflicts = 0;
  const ids: number[] = [];
  for (const t of targets) {
    const r = undoEdit(sessionId, t.id);
    if (r.status === 'conflict') conflicts++;
    else if (r.ok) {
      undone++;
      ids.push(t.id);
    }
  }
  return { undone, conflicts, total: targets.length, ids };
}

/**
 * Chapter-scoped revert: undo every PENDING edit in the chapter's DISPLAYED set (reviewEditIds — the
 * WYSIWYG rule: the ↩ button reverts exactly the edits the chapter row shows, so a partial accept
 * never strands leftovers the buttons can't reach). An id that names no display chapter (an
 * analytics-side task id) falls back to its strict-span set. Reuses undoScope, so a chapter revert
 * behaves exactly like every other scoped/bulk revert (newest-first, per-edit conflict fallback —
 * a mis-anchored revert still surfaces as a conflict, never a silent clobber).
 */
export function undoTask(cwd: string, session: string, taskId: string): UndoScopeResult {
  return undoScope(session, { ids: reviewEditIds(cwd, session, taskId) });
}

export interface KeepScopeResult {
  kept: number; // edits flipped to kept
  total: number; // edits in the task's strict-span set (any status)
  ids: number[]; // the kept edit ids
}

/**
 * Chapter-scoped keep: mark every PENDING edit in the chapter's DISPLAYED set (reviewEditIds — the
 * same WYSIWYG set undoTask reverts) as kept. Only pending edits are flipped: keeping an already-
 * undone edit would assert a change that isn't on disk. Accepting a chapter therefore resolves
 * everything its row shows — including gap-filled members and the synthetic session chapter.
 */
export function keepTask(cwd: string, session: string, taskId: string): KeepScopeResult {
  const idSet = new Set(reviewEditIds(cwd, session, taskId));
  const ids: number[] = [];
  for (const r of readLog(session)) {
    if (idSet.has(r.id) && r.status === 'pending') {
      setStatus(session, r.id, 'kept');
      ids.push(r.id);
    }
  }
  return { kept: ids.length, total: idSet.size, ids };
}
