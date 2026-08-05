/**
 * Review-unit collapsing: successive edits to the SAME code should be reviewed as one unit, not as a
 * pile of superseded intermediate states (you can't sensibly keep/revert an edit whose result a later
 * edit already overwrote). Within a file, CONSECUTIVE chained edits (edit[i].after === edit[i+1].before —
 * i.e. nothing else touched the file in between) whose changed regions OVERLAP in that shared state are
 * the "same code" and merge, transitively. Each group is represented by its most-recent (max-id) edit;
 * edits to different regions of a file stay separate and independently reviewable.
 *
 * This lives in core so every surface (CLI, VS Code, JetBrains) collapses identically — the editors are
 * thin renderers over the tree/keep/undo this backs.
 */
import { diffArrays } from 'diff';
import { EditRecord, EditStatus, readLog, blobText as storeBlobText, logPath } from './store';
import { cachedByFiles } from './fscache';

function tokenizeLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function blobText(session: string, sha: string | null): string {
  if (!sha) return '';
  try {
    return storeBlobText(session, sha);
  } catch {
    return '';
  }
}

/**
 * The line regions an edit touches, in BOTH coordinate systems:
 * - `afterAdded`: indices in `after` the edit added/changed (what it produced).
 * - `beforeChanged`: indices in `before` the edit removed/replaced (or the insertion anchor).
 */
function diffRegions(before: string, after: string): { afterAdded: Set<number>; beforeChanged: Set<number> } {
  const b = tokenizeLines(before);
  const a = tokenizeLines(after);
  const afterAdded = new Set<number>();
  const beforeChanged = new Set<number>();
  let ai = 0;
  let bi = 0;
  for (const part of diffArrays(b, a)) {
    if (part.added) {
      for (let k = 0; k < part.value.length; k++) afterAdded.add(ai + k);
      beforeChanged.add(bi); // pure-insertion anchor on the before side
      ai += part.value.length;
    } else if (part.removed) {
      for (let k = 0; k < part.value.length; k++) beforeChanged.add(bi + k);
      bi += part.value.length;
    } else {
      ai += part.value.length;
      bi += part.value.length;
    }
  }
  return { afterAdded, beforeChanged };
}

/** Memo for `diffRegions` keyed on the (session, beforeBlob, afterBlob) pair. Blobs are
 *  content-addressed and immutable, so a pair always yields the same regions — and computeGroups ran
 *  three blob reads + two whole-file line diffs per adjacent pending pair on EVERY tree build, which
 *  was the dominant cost of a many-edit refresh. Callers only READ the sets. */
const regionsMemo = new Map<string, { afterAdded: Set<number>; beforeChanged: Set<number> }>();
const REGIONS_MEMO_CAP = 20000;

function regionsFor(session: string, beforeSha: string | null, afterSha: string | null): { afterAdded: Set<number>; beforeChanged: Set<number> } {
  const key = `${session}|${beforeSha ?? ''}|${afterSha ?? ''}`;
  const hit = regionsMemo.get(key);
  if (hit) return hit;
  const value = diffRegions(blobText(session, beforeSha), blobText(session, afterSha));
  if (regionsMemo.size >= REGIONS_MEMO_CAP) regionsMemo.clear();
  regionsMemo.set(key, value);
  return value;
}

function overlaps(a: Set<number>, b: Set<number>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

/**
 * Collapse a session's edits of one status into review groups (same-code merges, keeping the most
 * recent). Returns repId → ascending member ids; a lone edit maps to `[its id]`. Grouping is
 * per-status so keep/undo work on the pending group and redo works on the undone group.
 */
function computeGroups(session: string, status: EditStatus): Map<number, number[]> {
  // Memoized per (mtime,size) of log.jsonl: one refresh builds the tree at least twice (Edits + Diffs
  // providers) and every CLI spawn rebuilds it again. Callers only read the returned map.
  return cachedByFiles(`groups:${status}`, [logPath(session)], () => computeGroupsUncached(session, status));
}

function computeGroupsUncached(session: string, status: EditStatus): Map<number, number[]> {
  const pending = readLog(session).filter((r) => r.status === status);
  const byFile = new Map<string, EditRecord[]>();
  for (const r of pending) {
    const arr = byFile.get(r.file);
    if (arr) arr.push(r);
    else byFile.set(r.file, [r]);
  }
  // union-find over edit ids
  const parent = new Map<number, number>();
  for (const r of pending) parent.set(r.id, r.id);
  const find = (x: number): number => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    while (parent.get(x) !== root) {
      const next = parent.get(x) as number;
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number) => parent.set(find(a), find(b));

  for (const recs of byFile.values()) {
    recs.sort((a, b) => a.id - b.id);
    for (let i = 0; i + 1 < recs.length; i++) {
      const e = recs[i];
      const f = recs[i + 1];
      // Perfectly chained? (nothing else changed the file between them.)
      if (e.afterBlob === null || f.beforeBlob === null || e.afterBlob !== f.beforeBlob) continue;
      const eProduced = regionsFor(session, e.beforeBlob, e.afterBlob).afterAdded;
      const fTouches = regionsFor(session, f.beforeBlob, f.afterBlob).beforeChanged;
      if (overlaps(eProduced, fTouches)) union(e.id, f.id); // f edits what e produced → same code
    }
  }

  const byRoot = new Map<number, number[]>();
  for (const r of pending) {
    const root = find(r.id);
    const arr = byRoot.get(root);
    if (arr) arr.push(r.id);
    else byRoot.set(root, [r.id]);
  }
  const out = new Map<number, number[]>();
  for (const members of byRoot.values()) {
    members.sort((a, b) => a - b);
    out.set(members[members.length - 1], members); // represent by the most-recent (max) id
  }
  return out;
}

/** Pending review groups: repId → ascending member ids (what the tree/list collapse to). */
export function pendingGroups(session: string): Map<number, number[]> {
  return computeGroups(session, 'pending');
}

/**
 * Every grouped id → its group's ascending members, across ALL THREE statuses in one map.
 *
 * Built because the obvious per-id lookup is quadratic in disguise: it read the whole log to learn one
 * record's status, then scanned that status's groups linearly. Called once per review unit — which is what
 * [checkpointScope] does — a 7,922-record session spent 1.2 s answering a question whose answer was that
 * NOTHING was pending, blocking VS Code's extension host to say "nothing to rewind".
 *
 * Merging the statuses is safe, not a shortcut: `computeGroupsUncached` filters the log by status before
 * grouping, so member ids are strictly partitioned by status and no id can appear under two of them. A
 * pending-only index would be wrong — it silently drops kept/undone multi-member groups, and half-redoing
 * a straddling group is the exact failure the expansion exists to prevent.
 */
function membersIndex(session: string): Map<number, number[]> {
  return cachedByFiles(`groupIndex`, [logPath(session)], () => {
    const index = new Map<number, number[]>();
    for (const status of ['pending', 'kept', 'undone'] as EditStatus[]) {
      for (const members of computeGroups(session, status).values()) {
        if (members.length < 2) continue; // a lone edit is its own group; `?? [id]` covers it
        for (const id of members) index.set(id, members);
      }
    }
    return index;
  });
}

/** Ascending member ids of the same-status group containing `id` (or `[id]` if ungrouped/unknown). */
export function groupMembers(session: string, id: number): number[] {
  return membersIndex(session).get(id) ?? [id];
}

/** The representative (most-recent) id of the group containing `id`. */
export function groupRep(session: string, id: number): number {
  const members = groupMembers(session, id);
  return members[members.length - 1];
}

/**
 * The session's edits collapsed for REVIEW (in log order): each pending same-code group becomes ONE
 * synthetic record — the most-recent edit's id/tool/status/ts/afterBlob, but the earliest member's
 * beforeBlob, so its delta/diff/placement reflect the group's net before→after. Resolved (kept/undone)
 * edits pass through unchanged. Shared by the tree and the CLI `list` so both collapse identically.
 *
 * No `.observatoryignore` filtering happens here, or anywhere else on a read path. A matching file is
 * never CAPTURED, so there is nothing in the log to filter — which is what let the whole display
 * layer that used to sit here go away.
 */
export function reviewEdits(session: string): EditRecord[] {
  const log = readLog(session);
  const groups = pendingGroups(session);
  const repByMember = new Map<number, number>();
  for (const [rep, members] of groups) for (const m of members) repByMember.set(m, rep);
  const byId = new Map(log.map((r) => [r.id, r]));
  const out: EditRecord[] = [];
  const emitted = new Set<number>();
  for (const rec of log) {
    if (rec.status !== 'pending') {
      out.push(rec);
      continue;
    }
    const rep = repByMember.get(rec.id) ?? rec.id;
    if (emitted.has(rep)) continue;
    emitted.add(rep);
    const members = groups.get(rep) ?? [rec.id];
    const repRec = byId.get(rep) as EditRecord;
    const earliest = byId.get(members[0]) as EditRecord;
    out.push(members.length > 1 ? { ...repRec, beforeBlob: earliest.beforeBlob } : repRec);
  }
  return out;
}
