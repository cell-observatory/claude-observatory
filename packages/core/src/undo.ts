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
import { diffArrays } from 'diff';
import { findRecord, readBlob, setStatus } from './store';

export interface UndoResult {
  ok: boolean;
  status: 'undone' | 'redone' | 'deleted' | 'conflict' | 'noop' | 'error';
  message: string;
}

function blobText(sessionId: string, sha: string | null): string | null {
  return sha === null ? null : readBlob(sessionId, sha).toString('utf8');
}

function writeEnsuringDir(file: string, content: string): void {
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

  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  let current: string | null;
  try {
    current = fs.readFileSync(rec.file, 'utf8');
  } catch {
    current = null;
  }

  const conflict = (): UndoResult => ({
    ok: false,
    status: 'conflict',
    message:
      `edit #${id} overlaps a later change to ${path.basename(rec.file)}. ` +
      `Run \`claude-observatory undo ${id} --force\` to restore the file to its pre-edit-#${id} ` +
      `state (this also drops later edits to this file).`,
  });

  // New-file create -> undo deletes the file, but ONLY if no later edit changed it since.
  if (before === null) {
    if (current !== null && after !== null && current !== after) return conflict();
    try {
      if (current !== null) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    setStatus(sessionId, id, 'undone');
    return { ok: true, status: 'deleted', message: `deleted ${rec.file} (created by edit #${id})` };
  }

  // Edit deleted the file -> undo restores it, unless a later edit re-created it.
  if (after === null) {
    if (current !== null) return conflict();
    writeEnsuringDir(rec.file, before);
    setStatus(sessionId, id, 'undone');
    return { ok: true, status: 'undone', message: `restored ${rec.file}` };
  }

  // Normal in-place edit; file missing now -> restore wholesale.
  if (current === null) {
    writeEnsuringDir(rec.file, before);
    setStatus(sessionId, id, 'undone');
    return {
      ok: true,
      status: 'undone',
      message: `${rec.file} was missing; restored to its pre-edit-#${id} state`,
    };
  }

  // No later edits touched this file -> clean, exact revert.
  if (current === after) {
    fs.writeFileSync(rec.file, before);
    setStatus(sessionId, id, 'undone');
    return { ok: true, status: 'undone', message: `undid edit #${id} (${rec.file})` };
  }

  // Later edits exist -> position-anchored 3-way merge (base = after_N, ours = current, theirs = before).
  const merged = threeWayMerge(after, current, before);
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
 * Per-file restore fallback (the `--force` path). Reverts the file to its state BEFORE edit `id`,
 * dropping any later edits to that same file. Used when undoEdit() reports a conflict.
 */
export function restoreFile(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };

  const before = blobText(sessionId, rec.beforeBlob);
  if (before === null) {
    try {
      if (fs.existsSync(rec.file)) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    setStatus(sessionId, id, 'undone');
    return { ok: true, status: 'deleted', message: `deleted ${rec.file} (created by edit #${id})` };
  }
  writeEnsuringDir(rec.file, before);
  setStatus(sessionId, id, 'undone');
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

  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  let current: string | null;
  try {
    current = fs.readFileSync(rec.file, 'utf8');
  } catch {
    current = null;
  }

  const conflict = (): UndoResult => ({
    ok: false,
    status: 'conflict',
    message:
      `re-applying edit #${id} overlaps a later change to ${path.basename(rec.file)}. ` +
      `Run \`claude-observatory redo ${id} --force\` to force it (drops later edits to this file).`,
  });

  // Redo a creation -> re-create the file with `after`.
  if (before === null) {
    if (current !== null && after !== null && current !== after) return conflict();
    writeEnsuringDir(rec.file, after ?? '');
    setStatus(sessionId, id, 'pending');
    return { ok: true, status: 'redone', message: `re-applied edit #${id} — created ${rec.file}` };
  }

  // Redo a deletion -> delete the file again (only if it still matches its pre-deletion content).
  if (after === null) {
    if (current !== null && current !== before) return conflict();
    try {
      if (current !== null) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    setStatus(sessionId, id, 'pending');
    return { ok: true, status: 'deleted', message: `re-applied edit #${id} — deleted ${rec.file}` };
  }

  // Normal edit: file missing now -> write after wholesale.
  if (current === null) {
    writeEnsuringDir(rec.file, after);
    setStatus(sessionId, id, 'pending');
    return { ok: true, status: 'redone', message: `re-applied edit #${id} (${rec.file})` };
  }
  // No later edits -> clean forward apply.
  if (current === before) {
    fs.writeFileSync(rec.file, after);
    setStatus(sessionId, id, 'pending');
    return { ok: true, status: 'redone', message: `re-applied edit #${id} (${rec.file})` };
  }
  // Later edits exist -> 3-way merge with before_N as the common base.
  const merged = threeWayMerge(before, current, after);
  if (merged === null) return conflict();
  fs.writeFileSync(rec.file, merged);
  setStatus(sessionId, id, 'pending');
  return {
    ok: true,
    status: 'redone',
    message: `re-applied edit #${id}, preserving later edits (${rec.file})`,
  };
}

/** Force a redo: write the edit's `after` content wholesale (dropping later edits to the file). */
export function reapplyFile(sessionId: string, id: number): UndoResult {
  const rec = findRecord(sessionId, id);
  if (!rec) return { ok: false, status: 'error', message: `no edit #${id} in this session` };
  const after = blobText(sessionId, rec.afterBlob);
  if (after === null) {
    try {
      if (fs.existsSync(rec.file)) fs.unlinkSync(rec.file);
    } catch (e) {
      return { ok: false, status: 'error', message: `could not delete ${rec.file}: ${String(e)}` };
    }
    setStatus(sessionId, id, 'pending');
    return { ok: true, status: 'deleted', message: `re-applied edit #${id} — deleted ${rec.file}` };
  }
  writeEnsuringDir(rec.file, after);
  setStatus(sessionId, id, 'pending');
  return {
    ok: true,
    status: 'redone',
    message: `re-applied edit #${id} to ${rec.file} (later edits to this file dropped)`,
  };
}
