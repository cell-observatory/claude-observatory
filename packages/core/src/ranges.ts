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

/** One run of the line alignment — the shape `diffArrays` returns, and all this file consumes. */
interface LinePart {
  value: string[];
  added?: boolean;
  removed?: boolean;
}

/** Positional map: a-line index → b-line index, over the lines the two texts have in common. */
function alignMap(a: string[], b: string[]): Map<number, number> {
  const m = new Map<number, number>();
  let ai = 0;
  let bi = 0;
  // Plain diffArrays: jsdiff already seeds its search with `extractCommon` at edit length 0 and returns
  // immediately on identity, and Myers' band is already bounded by the true edit distance — so a manual
  // common-prefix/suffix trim in front of it measured a flat 0 ms across every size and drift tested.
  for (const part of diffArrays(a, b) as LinePart[]) {
    if (part.added) {
      bi += part.value.length; // b-only lines
    } else if (part.removed) {
      ai += part.value.length; // a-only lines
    } else {
      for (let k = 0; k < part.value.length; k++) m.set(ai + k, bi + k);
      ai += part.value.length;
      bi += part.value.length;
    }
  }
  return m;
}

/** `first` (x→y) followed by `second` (y→z), keeping only the lines that survive BOTH hops. */
function compose(first: Map<number, number>, second: Map<number, number>): Map<number, number> {
  const m = new Map<number, number>();
  for (const [x, y] of first) {
    const z = second.get(y);
    if (z !== undefined) m.set(x, z);
  }
  return m;
}

/** One net-deletion hunk: the removed `lines` and the current-buffer line they now sit just after. */
export interface Deletion {
  anchor: number; // current line index the removed text is shown after (last line for an EOF deletion)
  lines: string[]; // the removed lines (before-only), trailing "\n" stripped — for red "ghost" text
}

/** One edit's whole-file snapshots, as the store holds them (a missing side is ''). */
export interface EditSnapshot {
  before: string;
  after: string;
}

/** Where one edit currently sits: the lines it introduced, and its net-deletion hunks. */
export interface EditPlacement {
  lines: number[];
  removed: Deletion[];
}

/**
 * What one edit did to its own file, in `after` coordinates: the line indices it introduced, and each
 * hunk where it net-REMOVED lines (the after-index just past the hunk, plus the removed text).
 *
 * Both come out of ONE `diffArrays` run. Computing them separately ran the identical Myers alignment
 * over the identical pair of arrays twice — 35% of the loop at 100 changed lines per edit.
 */
function editShape(beforeT: string[], afterT: string[]): { introduced: Set<number>; hunks: { at: number; lines: string[] }[] } {
  const introduced = new Set<number>();
  const hunks: { at: number; lines: string[] }[] = [];
  const parts = diffArrays(beforeT, afterT) as LinePart[];
  let aIdx = 0; // index into afterT
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.added) {
      for (let k = 0; k < part.value.length; k++) introduced.add(aIdx + k);
      aIdx += part.value.length;
    } else if (part.removed) {
      // A modification is a removed run immediately followed by an added run; it only counts as a
      // deletion when it removes MORE than it adds. The before-only lines don't advance the after index.
      const next = parts[i + 1];
      const addedLen = next && next.added ? next.value.length : 0;
      if (part.value.length > addedLen) {
        hunks.push({ at: aIdx + addedLen, lines: part.value.map((l) => l.replace(/\n$/, '')) });
      }
    } else {
      aIdx += part.value.length; // common lines
    }
  }
  return { introduced, hunks };
}

/**
 * Place a whole file's edits in the current buffer at once, by COMPOSING the edit chain.
 *
 * Placing one edit means mapping its `after` snapshot onto `current`. Done per edit, that re-runs a
 * whole-file alignment whose cost grows with the CUMULATIVE drift since that edit, so a file with n
 * edits pays the largest alignment n times over — measured at 28.3 s of a 38.6 s change-map build on a
 * real 2,985-edit session, against a 30 s CLI timeout, so the plugin killed the build and retried every
 * three seconds forever.
 *
 * Consecutive snapshots are only one edit apart, though. Aligning `after[i] → after[i+1]` costs that
 * single edit's churn, and composing those hops backwards from `current` gives every edit its mapping
 * for the price of one small diff each. Measured on an 800-line file with 30 pending edits: 6.3× faster
 * at 3 changed lines per edit, 39.4× at 15, 71.9× at 40 — with zero placement differences. On a
 * class-bearing 40-file / 1,200-edit tree build the whole locate pass goes 505 ms → 175 ms at churn 3
 * and 4,787 ms → 325 ms at churn 15.
 *
 * Composition is also the more honest mapping: a line deleted and later reintroduced does not survive
 * the hops, where a direct `after → current` alignment would match it to its replacement. It
 * under-reports (the edit is simply unplaced) rather than pointing at the wrong line.
 *
 * Snapshots are PULLED one at a time rather than passed as an array: a caller that materialised all 2n
 * before/after strings up front held the file's entire history resident — on a 5,000-line file with 500
 * pending edits that was +665 MB over baseline inside the VS Code extension host, against +171 MB
 * pulling lazily at the same speed. The walk is backwards, so only two tokenized snapshots are alive.
 *
 * `get` should yield one file's snapshots in chronological order — that is what makes each hop small.
 * Out-of-order input does NOT merely cost more: composition follows surviving lines, so a hop between
 * unrelated states drops them and the earlier edits come back unplaced. Callers pass log order, which
 * is chronological by construction.
 */
export function locateEditsInCurrent(count: number, get: (i: number) => EditSnapshot, current: string): EditPlacement[] {
  const out: EditPlacement[] = [];
  for (let i = 0; i < count; i++) out.push({ lines: [], removed: [] });
  if (count <= 0) return out;
  const currentT = tokenizeLines(current);

  // Walk backwards from `current`, carrying ONE running map (after[i] → current) and the single
  // tokenized snapshot the next hop needs.
  let toCurrent = new Map<number, number>();
  let nextAfterT: string[] | null = null;
  for (let i = count - 1; i >= 0; i--) {
    const snap = get(i);
    const afterT = tokenizeLines(snap.after);
    // An EMPTY next snapshot means the file did not exist at that point (a delete, or a blob that could
    // not be read — both `tree.readText` and the VS Code blob cache yield '' on a failed read). Nothing
    // survives a hop through nothing, so composing across it would wipe out every EARLIER edit's
    // placement, not just this one's. Re-anchor to the buffer directly instead.
    toCurrent =
      nextAfterT === null || nextAfterT.length === 0
        ? alignMap(afterT, currentT)
        : compose(alignMap(afterT, nextAfterT), toCurrent);
    nextAfterT = afterT;

    const { introduced, hunks } = editShape(tokenizeLines(snap.before), afterT);

    const lines: number[] = [];
    for (const a of introduced) {
      const c = toCurrent.get(a);
      if (c !== undefined) lines.push(c);
    }
    lines.sort((x, y) => x - y);

    const removed: Deletion[] = [];
    for (const h of hunks) {
      // An anchor at/after afterT.length is an end-of-file deletion → attach to the last current line;
      // a hunk whose region was later rewritten drops out.
      const c = h.at >= afterT.length ? Math.max(0, currentT.length - 1) : toCurrent.get(h.at);
      if (c !== undefined) removed.push({ anchor: c, lines: h.lines });
    }
    removed.sort((x, y) => x.anchor - y.anchor);

    out[i] = { lines, removed };
  }
  return out;
}

/**
 * 0-based line indices in `current` that this edit introduced (its added/changed lines), as they
 * sit in `current` now. Lines the edit added but that a later edit rewrote drop out; shifted lines
 * follow. A pure deletion introduces nothing → returns []. A new-file create (before === '') marks
 * every surviving line.
 *
 * Placing SEVERAL of one file's edits? Use {@link locateEditsInCurrent} — it composes the chain
 * instead of re-aligning the whole file once per edit.
 */
export function locateEditInCurrent(before: string, after: string, current: string): number[] {
  return locateEditsInCurrent(1, () => ({ before, after }), current)[0].lines;
}

/**
 * Where this edit *removed* lines, so the VS Code overlay can show the deleted text as red ghost text
 * on the surviving line. Complements {@link locateEditInCurrent} (the green added/changed lines). A
 * hunk counts as a deletion only when it removes more lines than it adds (pure deletion, or a shrink
 * like remove-5/add-1); even swaps and growth are modifications and yield nothing. `anchor` is the
 * current line the removed text now follows (the last line for an end-of-file deletion). Anchors follow
 * later edits and a hunk drops out if its region was rewritten.
 */
export function locateDeletionsInCurrent(before: string, after: string, current: string): Deletion[] {
  return locateEditsInCurrent(1, () => ({ before, after }), current)[0].removed;
}
