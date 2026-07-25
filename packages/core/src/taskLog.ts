/**
 * Cross-agent task log (zero-token): one row per stable taskId, unioned across every worktree-sibling
 * of the current repo (listRepoSiblings, §S3) and their subagents, so ONE logical task spanning agents
 * or worktrees reads as a single row. Edit counts / ±lines per task use the STRICT-span attribution
 * (§S6) that buildChangeMap already bakes into each edit: an edit in no real in_progress interval is
 * `unassigned` (taskId === null) and is EXCLUDED from task rows — never swept into a neighbour.
 *
 * Thin by design — it composes the existing parsers (listRepoSiblings + buildChangeMap) rather than
 * re-deriving attribution. Git-free, path-only, no model calls, nothing stored.
 */
import { EditStatus } from './store';
import { listRepoSiblings } from './fleet';
import { buildChangeMap, fileStatus } from './changemap';

/** One logical task, unioned across the agents (sessions) and subagents that contributed edits to it. */
export interface TaskLogEntry {
  taskId: string; // stable content-hash id (§S6) — the union key across worktrees + subagents
  content: string; // the to-do text (from the strict-span task identities, map.tasks); '' if unlabelled
  agentIds: string[]; // sessions that contributed strict-span edits to this task (sorted)
  subagentIds: string[]; // subagents (agentId) that authored strict-span edits (sorted; main-chain excluded)
  firstTs: number; // earliest contributing edit ts
  lastTs: number; // latest contributing edit ts
  edits: number;
  added: number;
  removed: number;
  status: EditStatus; // worst-unreviewed-wins across the task's edits (pending > undone > kept)
}

interface Acc {
  taskId: string;
  content: string;
  agentIds: Set<string>;
  subagentIds: Set<string>;
  firstTs: number;
  lastTs: number;
  edits: number;
  added: number;
  removed: number;
  pending: number;
  undone: number;
}

/**
 * The cross-agent task log for the repo `cwd` belongs to: every worktree-sibling's change-map, folded by
 * stable taskId. `unassigned` edits (no strict interval) are excluded from the rows (reported separately
 * — e.g. the per-session change-map's `taskId: null` rollup bucket). Returns [] when `cwd` has no
 * resolvable repo (listRepoSiblings guards the null-key case, never unioning unrelated sessions).
 */
export function crossAgentTaskLog(cwd: string): TaskLogEntry[] {
  const by = new Map<string, Acc>();
  for (const sib of listRepoSiblings(cwd)) {
    const map = buildChangeMap(sib.worktree, sib.id, { root: sib.worktree });
    // Label from the STRICT-span task identities (map.tasks), which cover exactly the edit-producing
    // tasks and share ids with edit.taskId — the strict identities, whose ids
    // only overlap where content matches, leaving most strict-span tasks unlabelled.
    const contentByTask = new Map<string, string>();
    for (const t of map.tasks) contentByTask.set(t.taskId, t.content);
    for (const e of map.edits) {
      if (e.taskId === null) continue; // unassigned — excluded from task rows (honest, never swept in)
      let acc = by.get(e.taskId);
      if (!acc) {
        acc = {
          taskId: e.taskId, content: contentByTask.get(e.taskId) ?? '',
          agentIds: new Set(), subagentIds: new Set(),
          firstTs: e.ts, lastTs: e.ts,
          edits: 0, added: 0, removed: 0, pending: 0, undone: 0,
        };
        by.set(e.taskId, acc);
      }
      if (!acc.content) acc.content = contentByTask.get(e.taskId) ?? acc.content; // first sibling to label it wins
      acc.agentIds.add(sib.id);
      if (e.subagentId !== null) acc.subagentIds.add(e.subagentId);
      if (e.ts) {
        acc.firstTs = acc.firstTs ? Math.min(acc.firstTs, e.ts) : e.ts;
        acc.lastTs = Math.max(acc.lastTs, e.ts);
      }
      acc.edits++;
      acc.added += e.added;
      acc.removed += e.removed;
      if (e.status === 'pending') acc.pending++;
      else if (e.status === 'undone') acc.undone++;
    }
  }
  const out: TaskLogEntry[] = [...by.values()].map((a) => ({
    taskId: a.taskId,
    content: a.content,
    agentIds: [...a.agentIds].sort(),
    subagentIds: [...a.subagentIds].sort(),
    firstTs: a.firstTs,
    lastTs: a.lastTs,
    edits: a.edits,
    added: a.added,
    removed: a.removed,
    status: fileStatus({ pending: a.pending, undone: a.undone }),
  }));
  // Most-recent work first (a task log reads newest-first); ties by taskId for a deterministic order.
  out.sort((a, b) => b.lastTs - a.lastTs || a.taskId.localeCompare(b.taskId));
  return out;
}
