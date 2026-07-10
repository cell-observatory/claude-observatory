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
import { EditRecord, EditStatus, readLog, readBlob } from './store';

function tokenizeLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) || [];
}

function blobText(session: string, sha: string | null): string {
  if (!sha) return '';
  try {
    return readBlob(session, sha).toString('utf8');
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
      const shared = blobText(session, e.afterBlob); // == f.before
      const eProduced = diffRegions(blobText(session, e.beforeBlob), shared).afterAdded;
      const fTouches = diffRegions(shared, blobText(session, f.afterBlob)).beforeChanged;
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

/** Ascending member ids of the same-status group containing `id` (or `[id]` if ungrouped/unknown). */
export function groupMembers(session: string, id: number): number[] {
  const rec = readLog(session).find((r) => r.id === id);
  if (!rec) return [id];
  for (const members of computeGroups(session, rec.status).values()) {
    if (members.includes(id)) return members;
  }
  return [id];
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
