/**
 * Map a stored edit (whole-file before/after snapshots) to the line ranges it currently occupies in
 * a possibly-further-edited buffer. Used by the VS Code inline overlay to decorate + anchor per-edit
 * CodeLenses. Purely positional (diffArrays line alignment), never a text search — so duplicated
 * content can't misplace a highlight, and later edits that shift lines are followed correctly.
 */
import { diffArrays } from 'diff';

/** Split into lines keeping the trailing "\n" (last line may lack one); join('') round-trips. */
function tokenizeLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * 0-based line indices in `current` that this edit introduced (its added/changed lines), as they
 * sit in `current` now. Lines the edit added but that a later edit rewrote drop out; shifted lines
 * follow. A pure deletion introduces nothing → returns []. A new-file create (before === '') marks
 * every surviving line.
 */
export function locateEditInCurrent(before: string, after: string, current: string): number[] {
  const beforeT = tokenizeLines(before);
  const afterT = tokenizeLines(after);
  const currentT = tokenizeLines(current);

  // 1) Which `after` line indices did this edit introduce (added/changed vs before)?
  const introduced = new Set<number>();
  {
    let aIdx = 0; // index into afterT
    for (const part of diffArrays(beforeT, afterT)) {
      if (part.added) {
        for (let k = 0; k < part.value.length; k++) introduced.add(aIdx + k);
        aIdx += part.value.length;
      } else if (part.removed) {
        /* before-only lines: don't advance the after index */
      } else {
        aIdx += part.value.length; // common lines
      }
    }
  }
  if (introduced.size === 0) return [];

  // 2) Map after-line indices -> current-line indices over the lines common to both.
  const afterToCurrent = new Map<number, number>();
  {
    let aIdx = 0; // index into afterT
    let cIdx = 0; // index into currentT
    for (const part of diffArrays(afterT, currentT)) {
      if (part.added) {
        cIdx += part.value.length; // current-only lines
      } else if (part.removed) {
        aIdx += part.value.length; // after-only lines (introduced-but-later-deleted land here)
      } else {
        for (let k = 0; k < part.value.length; k++) afterToCurrent.set(aIdx + k, cIdx + k);
        aIdx += part.value.length;
        cIdx += part.value.length;
      }
    }
  }

  // 3) Current indices of the introduced lines that still survive.
  const out: number[] = [];
  for (const i of introduced) {
    const c = afterToCurrent.get(i);
    if (c !== undefined) out.push(c);
  }
  return out.sort((a, b) => a - b);
}
