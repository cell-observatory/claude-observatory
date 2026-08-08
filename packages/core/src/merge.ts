/**
 * The line-merge primitives shared by the undo engine and the review-unit derivation.
 *
 * These lived inside `undo.ts` until `units.ts` needed `tokenizeLines` for its hop-shape diffs.
 * Importing `undo.ts` from `units.ts` would have closed a cycle — `undo.ts` already imports the
 * grouping layer — so the primitives moved here instead of being copied. There is exactly one
 * implementation of "merge two line-deltas onto a common base" in this product; `undo.ts` is its
 * caller, and `capture.ts` reads `blankLineOnlyChange` from the same toolbox.
 *
 * Pure text + the `diff` package. No filesystem, no store, no model calls.
 */
import { diffArrays } from 'diff';

/** Split into lines that KEEP their trailing "\n" (last line may lack one); join('') round-trips. */
export function tokenizeLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * True when the ONLY difference between two texts is blank lines being added or removed.
 *
 * A reviewer does not have a decision to make about a blank line. Recording one costs a row, a pending
 * count, a diff to open and a keep/undo click, and it tells them nothing — and agents produce them
 * constantly while reformatting around an edit they later revert. So a change that survives nothing but
 * blank-line churn is not tracked at all, the same way an edit that nets out to identical content is
 * already not tracked (`capture.ts`).
 *
 * "Blank" means empty or whitespace-only: a line of stray indentation reads as empty to the person
 * looking at it, and treating it otherwise would put the row back for a change they cannot see. This
 * compares the two texts with their blank lines removed — so an edit that ALSO changes real content is
 * unaffected and rides through with its whitespace intact.
 */
export function blankLineOnlyChange(before: string, after: string): boolean {
  if (before === after) return false; // no change at all is a different case, handled by its own check
  // A file's FINAL NEWLINE is not a blank line. Splitting on '\n' makes a trailing terminator look
  // like an empty last element, so stripping blanks compared "…two\n" equal to "…two" — and adding
  // or removing a file's last newline vanished entirely: no record, no marker, nothing to undo,
  // while git renders it as `\ No newline at end of file` and linters fail the build on it.
  if (before.endsWith('\n') !== after.endsWith('\n')) return false;
  const strip = (s: string) => s.split('\n').filter((l) => l.trim() !== '').join('\n');
  return strip(before) === strip(after);
}

export interface LineChange {
  start: number; // base token index
  del: number; // base tokens removed
  ins: string[]; // tokens inserted
}

/** Changes base->other in base-token coordinates, via diffArrays over newline-terminated lines. */
export function lineChanges(base: string, other: string): LineChange[] {
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
export function threeWayMerge(base: string, ours: string, theirs: string): string | null {
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
