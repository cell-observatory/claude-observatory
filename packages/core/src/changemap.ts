/**
 * Change-map model (zero-token): the whole session's edits assembled as one bird's-eye review diagram.
 * Reuses the folder→file→class tree, flattens it to a per-edit list carrying churn (±lines), review
 * status, Claude's own reasoning, and subagent/risk overlays — with strict per-task attribution from
 * Claude's own plan (to-dos ∪ the task system) and per-prompt slices of everything an ask produced.
 * One assembly, so the Folders strip + Files ledger render identically in VS Code and JetBrains off
 * the CLI `changemap --json`.
 *
 * Everything here is derived from what the observatory already parses — no model calls, nothing stored.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EditStatus, EditRecord, readLog, minOf, maxOf, logPath, rootDir, isSafeSessionId } from './store';
import { buildEditTree, EditTree, TreeEdit, TreeFolder, TreeFile } from './tree';
import { reasoningByEdit, transcriptInsights, findTranscript, flagsFor } from './observe';
import { parseActions, summarizeActions, compactLabel } from './actions';
import { parseSubagents } from './subagents';
import { buildEgressReport } from './egress';
import { projectSessionIds } from './fleet';
import { parseWorkflows, workflowWindows, workflowForTs } from './workflows';
import { taskSnaps, digest12 } from './tasks';
import { sessionPrompts } from './prompts';
import { sessionProcesses } from './processes';
import { cachedByFiles } from './fscache';

/** One edit (review unit) placed in the map: where it landed, how big, how reviewed, why, and which goal. */
export interface ChangeMapEdit {
  id: number; // the review-unit's representative edit id — drills via claudeObservatory.viewChanges
  rel: string; // workspace-relative path, forward slashes
  module: string; // immediate parent dir (the treemap's module bucket); '' for a root file
  file: string; // basename
  cls: string | null; // class/function it fell in, or null (file scope)
  added: number;
  removed: number;
  status: EditStatus; // pending | kept | undone
  ts: number;
  agent: boolean; // best-effort: a subagent authored this edit (only set when correlated, never guessed)
  risk: string | null; // a warn-level flag (secret / debug / large deletion / deleted file), else null
  reasoning: string | null; // first line of Claude's words for this edit (from the transcript)
  taskId: string | null; // per-TASK: the stable taskId whose STRICT in_progress interval this edit fell in, else null (unassigned)
  subagentId: string | null; // per-SUBAGENT: the subagent (agentId) that authored this edit, else null (main-chain or unattributed)
  workflowId: string | null; // per-WORKFLOW: the wf_<id> whose agent ts-window this edit fell in, else null (none / ambiguous)
}

/** One touched file, rolled up — the row a "ranked ledger" renders. */
export interface ChangeMapFile {
  rel: string; // workspace-relative path (the identity)
  module: string; // its module bucket (immediate parent dir) — the filter key
  moduleLabel: string; // pre-rendered display label, so no front-end re-derives it
  file: string; // basename
  churn: number; // added+removed across this file's units
  cnt: number; // review units in this file
  added: number;
  removed: number;
  kept: number;
  pending: number;
  undone: number;
  /** Worst-unreviewed-wins rollup (see `fileStatus`) — what colours the row. */
  status: EditStatus;
  /** Most-recent edit id in this file — the drill-through target (open its diff / review). */
  maxId: number;
  classes: string[]; // distinct classes/functions touched
  agent: boolean; // any edit subagent-authored
  risk: string | null; // first warn-level flag, if any
  reason: string | null; // first line of Claude's reasoning for this file
}

/** One module bucket (keyed by display LABEL) — the segment a "proportion strip" renders. */
export interface ChangeMapModule {
  module: string; // the bucket's identity — equals `label` (a renderer filters files by `f.moduleLabel`)
  label: string; // display label (see `moduleLabel`); one row per distinct label
  churn: number;
  cnt: number;
  added: number;
  removed: number;
  kept: number;
  pending: number;
  undone: number;
  status: EditStatus;
  files: number;
}

export interface ChangeMapSummary {
  session: string;
  title?: string; // human-readable session name (Claude's ai-title, else the first user prompt; '' when neither) — the Overview session selector + the Stats panel show it instead of the raw id
  units: number; // edits after same-code collapse (what the map draws)
  rawEdits: number; // raw store edits
  pending: number;
  kept: number;
  undone: number;
  added: number;
  removed: number;
  actions: number;
  errors: number;
  subagents: number;
  fleet: number; // sibling sessions in this project
  egress: number; // off-machine destinations
  compactions: number; // context compactions the harness performed this session
  spanMs: number; // wall-clock span of the session's actions
}

/** Per-TASK rollup row (strict spans). `taskId: null` is the explicit unassigned bucket. */
export interface TaskRoll {
  taskId: string | null; // null = unassigned (edits in no strict in_progress interval)
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
}

/**
 * A task identity from the STRICT-span model — the authoritative taskId↔content mapping that keys
 * `edit.taskId`, `rollupByTask`, task-scoped keep/undo, and the cross-agent task log. Built from the
 * to-dos that actually held an in_progress interval (so it joins `rollupByTask` by `taskId`), NOT from
 * the latest snapshot.
 */
export interface TaskInfo {
  taskId: string; // === taskId(content); the join key for rollupByTask / tasklog / the Tasks tab
  content: string; // the to-do text
  firstTs: number; // earliest in_progress start
  lastTs: number; // latest in_progress end
}

/** Per-SUBAGENT rollup row. `subagentId: null` is the main-chain (or unattributed) bucket. */
export interface SubagentRoll {
  subagentId: string | null; // null = main-chain / unattributed
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
}

/** Per-WORKFLOW rollup row. `workflowId: null` is the not-a-workflow (main-chain / ambiguous) bucket. */
export interface WorkflowRoll {
  workflowId: string | null; // null = main-chain / no-workflow / ambiguous
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
}

/** One workflow's Overview tab: its ts-window-attributed edits rolled up, its touched files, its identity. */
export interface ChangeMapWorkflow {
  id: string; // the wf_<id>
  name: string; // meta.name / script stem / the id (from parseWorkflows)
  running: boolean; // still in flight (from parseWorkflows)
  rollup: { edits: number; added: number; removed: number; pending: number; kept: number; undone: number };
  files: ChangeMapFile[]; // this workflow's touched files, churn-desc (a per-workflow rollupFiles)
  taskIds: string[]; // distinct non-null taskIds among this workflow's edits (cross-dimension join)
}

/**
 * One user PROMPT as a change-map slice: everything that ask produced, aggregated exactly the way a
 * workflow's slice is, so a renderer can swap one for the other and draw the same strip/ledger.
 *
 * This is the axis a PERSON reads a session by. Selecting a prompt narrows every other view to the
 * work that ask caused — its folders and files on the right; its subagents, workflow runs, tasks and
 * background shells on the left. Attribution is by START time (core's rule for prompts): a shell
 * launched by #4 stays #4's even when it exits during #7.
 */
export interface ChangeMapPrompt {
  id: string; // stable prompt id — the same one `prompts --json` emits
  index: number; // 1-based chronological position, the way a person counts their own turns
  /** The ask itself, whitespace-collapsed and COMPLETE — renderers wrap it; nothing here is clipped. */
  text: string;
  /** First line, capped — for one-line contexts (a button label, a tooltip head). */
  title: string;
  ts: number;
  endTs: number; // 0 while this is the ask still being answered
  rollup: { edits: number; added: number; removed: number; pending: number; kept: number; undone: number };
  files: ChangeMapFile[]; // this ask's touched files, churn-desc (a per-prompt rollupFiles)
  modules: ChangeMapModule[]; // …and their folder buckets, so the strip needs no re-aggregation
  /** Raw store edit ids this ask committed, capture order — the review scope of "accept this ask". */
  editIds: number[];
  /** Subagents spawned while answering (their own agentIds — what a fleet row is keyed by). */
  agentIds: string[];
  /** Workflow runs started while answering (wf_<id>). */
  workflowIds: string[];
  /** Background shells launched while answering (the harness shell id — what a Processes row shows). */
  processIds: string[];
  actions: number;
  errors: number;
  compactions: number;
  durationMs: number;
}

/** Per-AGENT (per-session) rollup row — one per built change-map, worktree-aware when fed siblings. */
export interface AgentRoll {
  session: string;
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
  files: number;
}

/** A context compaction, ordered by time — the Actions timeline and the Stats readout render these. */
export interface CompactionMarker {
  ts: number;
  trigger: string;
  preTokens: number;
  postTokens: number;
  /** This event's own drop (pre − post), never the session-cumulative figure. */
  droppedTokens: number;
  /** The harness's running session total, for a "dropped so far" readout. */
  cumulativeDropped: number;
  durationMs: number;
  /** The one-line summary every surface prints (built once in core — see `compactLabel`). */
  label: string;
}

export interface ChangeMap {
  summary: ChangeMapSummary;
  edits: ChangeMapEdit[];
  /** Context compactions during this session, oldest first — the Actions timeline carries the same
   *  events as 'compact' rows, and Stats prints the one-line readout. */
  compactions: CompactionMarker[];
  /** Per-file rollup, churn-desc. Rendered directly — front-ends must not re-aggregate. */
  files: ChangeMapFile[];
  /** Per-module rollup, churn-desc. Rendered directly — front-ends must not re-aggregate. */
  modules: ChangeMapModule[];
  /** Per-TASK rollup (strict spans), incl. the explicit `taskId: null` unassigned bucket. */
  rollupByTask: TaskRoll[];
  /** Per-SUBAGENT rollup, incl. the `subagentId: null` main-chain bucket. */
  rollupBySubagent: SubagentRoll[];
  /** Per-WORKFLOW rollup, incl. the `workflowId: null` no-workflow/ambiguous bucket. */
  rollupByWorkflow: WorkflowRoll[];
  /** One entry per workflow that produced ts-window-attributed edits — the Overview's per-workflow tabs
   *  (edits rolled up + touched files), aggregated here so renderers stay thin. */
  workflows: ChangeMapWorkflow[];
  /**
   * The session partitioned by what the USER asked for — one slice per prompt, in order. Only built
   * when `opts.prompts` is set (the Prompts window's own scope source), because it costs one more
   * transcript pass and the fleet builds dozens of sibling maps per refresh that never need it.
   */
  prompts: ChangeMapPrompt[];
  /**
   * Strict-span task identities (taskId → content), the authoritative label + join source for
   * `rollupByTask`, the Tasks tab, and the cross-agent task log. Covers exactly the tasks that held
   * a real in_progress interval — so it joins `rollupByTask` by `taskId`.
   */
  tasks: TaskInfo[];
}

/** Immediate parent directory of a rel path (the module bucket); '' when the file sits at the root. */
function moduleOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
}

/**
 * Display label for a module bucket: '' → '(root)', an out-of-workspace path → '(external)', else
 * strip the monorepo noise (a `packages/` prefix and a trailing `/src`) so `packages/core/src`
 * reads as `core`. Lives here, not in a renderer, so every front-end labels a bucket identically.
 */
export function moduleLabel(module: string): string {
  if (!module) return '(root)';
  if (module.startsWith('..')) return '(external)'; // edited outside the workspace root
  let s = module;
  if (s.startsWith('packages/')) s = s.slice('packages/'.length);
  if (s.endsWith('/src')) s = s.slice(0, -'/src'.length);
  return s;
}

/**
 * Roll a set of edit-status counts up to ONE status for a file/module — worst-unreviewed-wins, so a
 * parent never reads as reviewed while something under it is still pending. ('undone' surfaces as
 * "reverted" in the UIs; the vocabulary here stays EditStatus so there's only one status language.)
 */
export function fileStatus(c: { pending: number; undone: number }): EditStatus {
  if (c.pending > 0) return 'pending';
  if (c.undone > 0) return 'undone';
  return 'kept';
}

/** Group the placed edits into per-file rows (churn-desc). */
function rollupFiles(edits: ChangeMapEdit[]): ChangeMapFile[] {
  const by = new Map<string, ChangeMapFile>();
  const classes = new Map<string, Set<string>>();
  for (const e of edits) {
    let f = by.get(e.rel);
    if (!f) {
      f = {
        rel: e.rel, module: e.module, moduleLabel: moduleLabel(e.module), file: e.file,
        churn: 0, cnt: 0, added: 0, removed: 0,
        kept: 0, pending: 0, undone: 0, status: 'kept', maxId: -1, classes: [],
        agent: false, risk: null, reason: null,
      };
      by.set(e.rel, f);
      classes.set(e.rel, new Set());
    }
    f.churn += e.added + e.removed;
    f.added += e.added;
    f.removed += e.removed;
    f.cnt++;
    if (e.status === 'kept') f.kept++;
    else if (e.status === 'undone') f.undone++;
    else f.pending++;
    if (e.cls) classes.get(e.rel)!.add(e.cls);
    if (e.agent) f.agent = true;
    if (e.risk && !f.risk) f.risk = e.risk;
    if (e.reasoning && !f.reason) f.reason = e.reasoning;
    if (e.id > f.maxId) f.maxId = e.id; // newest edit = what a click on this row opens
  }
  const out = [...by.values()];
  for (const f of out) {
    f.classes = [...classes.get(f.rel)!];
    f.status = fileStatus(f);
  }
  out.sort((a, b) => b.churn - a.churn || a.rel.localeCompare(b.rel));
  return out;
}

/**
 * Roll the per-file rows up into module buckets (churn-desc). Keyed by the DISPLAY LABEL, not the raw
 * parent dir — so a package edited both at its root and under `src/` (`packages/vscode/package.json`
 * → `packages/vscode` and `packages/vscode/src/extension.ts` → `packages/vscode/src`) folds into ONE
 * `vscode` bucket instead of two same-named strip segments. On a module row `module === label` (the
 * bucket's identity); files keep their raw `module`, so a renderer filters by `f.moduleLabel`.
 */
function rollupModules(files: ChangeMapFile[]): ChangeMapModule[] {
  const by = new Map<string, ChangeMapModule>();
  for (const f of files) {
    const key = f.moduleLabel;
    let m = by.get(key);
    if (!m) {
      m = {
        module: key, label: key, churn: 0, cnt: 0, added: 0, removed: 0,
        kept: 0, pending: 0, undone: 0, status: 'kept', files: 0,
      };
      by.set(key, m);
    }
    m.churn += f.churn;
    m.cnt += f.cnt;
    m.added += f.added;
    m.removed += f.removed;
    m.kept += f.kept;
    m.pending += f.pending;
    m.undone += f.undone;
    m.files++;
  }
  const out = [...by.values()];
  for (const m of out) m.status = fileStatus(m);
  out.sort((a, b) => b.churn - a.churn || a.module.localeCompare(b.module));
  return out;
}

/** First non-blank line of some text, capped — the tooltip / drill-rail "why". */
function firstLine(s: string, cap = 160): string {
  const l = s.split('\n').find((x) => x.trim()) ?? '';
  const t = l.trim();
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t;
}

/** Flatten the folder/file/class tree into (rel, class, edit) rows — the leaves the map places. */
function flattenTree(tree: EditTree): { rel: string; cls: string | null; edit: TreeEdit }[] {
  const out: { rel: string; cls: string | null; edit: TreeEdit }[] = [];
  const walk = (folders: TreeFolder[], files: TreeFile[]): void => {
    for (const f of files) {
      for (const c of f.classes) for (const e of c.edits) out.push({ rel: f.rel, cls: c.name, edit: e });
      for (const e of f.loose) out.push({ rel: f.rel, cls: null, edit: e });
    }
    for (const sub of folders) walk(sub.folders, sub.files);
  };
  walk(tree.folders, tree.files);
  return out;
}

interface TodoSnap {
  ts: number;
  /** src marks TASK-born items (tasks.ts snapshots) — provenance for the merged plan timeline. */
  todos: { content: string; status: string; src?: 'task' }[];
}

/**
 * The PLAN snapshots the strict-span model consumes: TodoWrite ∪ the task system (TaskCreate/TaskUpdate,
 * mined in tasks.ts), merged on one timeline into the same full-list shape — so task-planned sessions
 * get real per-task attribution through the identical machinery. Todos win duplicate titles (the
 * bundled demo plans both ways) so the two systems never mint twin tasks.
 */
function planSnaps(transcriptPath: string): TodoSnap[] {
  const todos = todoSnaps(transcriptPath);
  // Sort by ts: the merge below walks both lists as if they were ascending, but taskSnaps emits in
  // transcript LINE order and a transcript is not ts-ordered (one real session steps backwards 438
  // times). An inverted snapshot yields a task whose firstTs > lastTs, which silently attributes zero
  // edits and returns an empty feed for a task that did plenty.
  const tasks = taskSnaps(transcriptPath).slice().sort((a, b) => a.ts - b.ts);
  if (!tasks.length) return todos;
  if (!todos.length) return tasks;
  const norm = (s: string) => s.trim().toLowerCase();
  const out: TodoSnap[] = [];
  let i = 0;
  let j = 0;
  let curTodos: TodoSnap['todos'] = [];
  let curTasks: TodoSnap['todos'] = [];
  while (i < todos.length || j < tasks.length) {
    const tTs = i < todos.length ? todos[i].ts : Infinity;
    const kTs = j < tasks.length ? tasks[j].ts : Infinity;
    let ts: number;
    if (tTs <= kTs) {
      curTodos = todos[i].todos;
      ts = tTs;
      i++;
    } else {
      curTasks = tasks[j].todos;
      ts = kTs;
      j++;
    }
    const seen = new Set(curTodos.map((d) => norm(d.content)));
    out.push({ ts, todos: [...curTodos, ...curTasks.filter((k) => !seen.has(norm(k.content)))] });
  }
  return out;
}

/** Ordered TodoWrite snapshots from the main transcript (each carries its ts + the full list). */
function todoSnaps(transcriptPath: string): TodoSnap[] {
  // Memoized per (mtime,size): one build consults the snapshots for BOTH span models, and the fleet
  // paths re-consult per sibling — read-only result, so the cached value is shared as-is.
  return cachedByFiles('todoSnaps', [transcriptPath], () => todoSnapsUncached(transcriptPath));
}

function todoSnapsUncached(transcriptPath: string): TodoSnap[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return [];
  }
  const out: TodoSnap[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || !t.includes('TodoWrite')) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.isSidechain === true) continue; // a subagent's checklist is not the main plan
    const msg = o.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const ts = toMs(o.timestamp ?? o.ts);
    for (const b of msg.content) {
      if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
        const todos = b.input.todos
          .filter((td: any) => td && typeof td.content === 'string')
          .map((td: any) => ({ content: String(td.content).trim(), status: String(td.status || '') }));
        if (todos.length) out.push({ ts, todos });
      }
    }
  }
  return out;
}

function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Stable per-task identity (first-seen wins), tracked while building strict spans. */
export type TaskIdentity = { taskId: string; content: string; firstTs: number };

/**
 * Stable task id — a content hash, NOT the old positional `ch${i}`. Reordering or inserting to-dos
 * never shifts it, and two to-dos with identical text deterministically share ONE id (an honest
 * collision → one task) instead of the old last-wins. `firstSeenTs` pins a task's first-seen time in
 * the identity map so its `firstTs` doesn't drift if the to-do reappears later; it does NOT enter the
 * hash (identical text must stay one id). The hash core is shared with tasks.taskIdForSubject() via
 * digest12(), so the two can't drift; `firstSeenTs` stays in the signature (callers + tests pass it
 * positionally) but remains intentionally unhashed.
 */
export function taskId(content: string, firstSeenTs: number): string {
  return digest12(content);
}

/** A REAL in_progress interval for the taskId model — no edge extension (cf. `Span`). */
interface StrictSpan {
  taskId: string;
  content: string;
  start: number; // ts the to-do ENTERED in_progress — the first span does NOT reach back to 0
  end: number; // ts it LEFT in_progress; an open (never-completed) span ends at its LAST observed in_progress mtime, NOT +∞
}

/**
 * The strict in_progress timeline for the taskId model, with NO edge fill. `start` is exactly when a
 * to-do entered in_progress; `end` is when it left (a later checkpoint no longer shows it
 * in_progress). A to-do that never completes ends at its LAST observed in_progress mtime, not +∞.
 * So an edit made before the first in_progress, or after the last one closed, falls in NO interval and
 * is honestly `unassigned` — never force-filed onto the head/tail task. This is the destructive-safety
 * rule: a task's keep/undo set must never include an edit that was never part of that task.
 */
function inProgressSpansStrict(snaps: TodoSnap[]): StrictSpan[] {
  const spans: StrictSpan[] = [];
  const identity = new Map<string, TaskIdentity>(); // first-seen wins: pins each task's firstTs + id
  let cur: StrictSpan | null = null;
  let lastSeen = 0; // last checkpoint ts at which `cur`'s to-do was still in_progress
  for (const s of snaps) {
    if (!s.ts) continue;
    const ip = s.todos.find((t) => t.status === 'in_progress');
    const content = ip ? ip.content : null;
    if (content === (cur ? cur.content : null)) {
      if (cur) lastSeen = s.ts; // same task still in_progress at this checkpoint
      continue;
    }
    if (cur) cur.end = s.ts; // it left in_progress here — a REAL end, never +∞
    if (content) {
      let id = identity.get(content);
      if (!id) {
        id = { taskId: taskId(content, s.ts), content, firstTs: s.ts };
        identity.set(content, id);
      }
      cur = { taskId: id.taskId, content, start: s.ts, end: s.ts };
      lastSeen = s.ts;
      spans.push(cur);
    } else {
      cur = null;
    }
  }
  if (cur) cur.end = lastSeen; // open span: end at its last observed in_progress mtime, never +∞
  return spans;
}

/** Strict ts→taskId lookup over pre-built strict spans (NO edge fill): a ts in no REAL interval → null. */
function strictTaskForTs(strictSpans: StrictSpan[], ts: number): string | null {
  if (!ts) return null;
  for (const sp of strictSpans) if (ts >= sp.start && ts < sp.end) return sp.taskId;
  return null;
}

/** Fold one edit's ±lines and review status into a running rollup accumulator. */
function foldStatus(
  acc: { edits: number; added: number; removed: number; pending: number; kept: number; undone: number },
  e: ChangeMapEdit,
): void {
  acc.edits++;
  acc.added += e.added;
  acc.removed += e.removed;
  if (e.status === 'kept') acc.kept++;
  else if (e.status === 'undone') acc.undone++;
  else acc.pending++;
}

/**
 * Per-TASK rollup keyed by stable `taskId` (strict spans). Edits in no strict in_progress interval
 * collect in an explicit `taskId: null` bucket — never swept into a neighbour. Edit-count desc, null last.
 */
export function rollupByTask(edits: ChangeMapEdit[]): TaskRoll[] {
  const by = new Map<string | null, TaskRoll>();
  for (const e of edits) {
    let r = by.get(e.taskId);
    if (!r) {
      r = { taskId: e.taskId, edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
      by.set(e.taskId, r);
    }
    foldStatus(r, e);
  }
  return [...by.values()].sort((a, b) => {
    if (a.taskId === null) return 1;
    if (b.taskId === null) return -1;
    return b.edits - a.edits || a.taskId.localeCompare(b.taskId);
  });
}

/**
 * Per-SUBAGENT rollup keyed by `subagentId` (the authoring subagent's agentId). Main-chain and
 * unattributed edits collect in the `subagentId: null` bucket. Edit-count desc, null last.
 */
export function rollupBySubagent(edits: ChangeMapEdit[]): SubagentRoll[] {
  const by = new Map<string | null, SubagentRoll>();
  for (const e of edits) {
    let r = by.get(e.subagentId);
    if (!r) {
      r = { subagentId: e.subagentId, edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
      by.set(e.subagentId, r);
    }
    foldStatus(r, e);
  }
  return [...by.values()].sort((a, b) => {
    if (a.subagentId === null) return 1;
    if (b.subagentId === null) return -1;
    return b.edits - a.edits || a.subagentId.localeCompare(b.subagentId);
  });
}

/**
 * Per-WORKFLOW rollup keyed by `workflowId` (the ts-window-attributed workflow). Main-chain and ambiguous
 * edits collect in the `workflowId: null` bucket. Edit-count desc, null last.
 */
export function rollupByWorkflow(edits: ChangeMapEdit[]): WorkflowRoll[] {
  const by = new Map<string | null, WorkflowRoll>();
  for (const e of edits) {
    let r = by.get(e.workflowId);
    if (!r) {
      r = { workflowId: e.workflowId, edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
      by.set(e.workflowId, r);
    }
    foldStatus(r, e);
  }
  return [...by.values()].sort((a, b) => {
    if (a.workflowId === null) return 1;
    if (b.workflowId === null) return -1;
    return b.edits - a.edits || a.workflowId.localeCompare(b.workflowId);
  });
}

/**
 * Per-AGENT (per-session) rollup — one row per built change-map, summing its edits. Fed the per-sibling
 * `buildChangeMap` results (§3), it renders a worktree fleet as one row per agent; aggregation stays here.
 */
export function rollupByAgent(maps: ChangeMap[]): AgentRoll[] {
  return maps.map((m) => {
    const r: AgentRoll = {
      session: m.summary.session,
      edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0,
      files: m.files.length,
    };
    for (const e of m.edits) foldStatus(r, e);
    return r;
  });
}

/** Build the change-map for a session. `root` sets display-relative paths (defaults to cwd). */
export function buildChangeMap(
  cwd: string,
  session: string,
  opts: { root?: string; prompts?: boolean } = {},
): ChangeMap {
  const root = opts.root ?? cwd;
  const tree = buildEditTree(session, { root });
  const flat = flattenTree(tree);
  const log = readLog(session);
  const byId = new Map<number, EditRecord>(log.map((r) => [r.id, r]));
  const reasoning = reasoningByEdit(cwd, session);

  // Subagent-authored edit ids — best-effort, only where an agent action carried a correlated editId.
  const subs = parseSubagents(cwd, session);
  const agentEditIds = new Set<number>();
  const editIdToSubagent = new Map<number, string>(); // editId → the subagent (agentId) that authored it
  for (const s of subs) for (const a of s.actions) if (a.editId != null) {
    agentEditIds.add(a.editId);
    editIdToSubagent.set(a.editId, s.agentId);
  }

  const insights = transcriptInsights(cwd, session);
  const transcript = findTranscript(cwd, session);
  const snaps = transcript ? planSnaps(transcript) : [];
  const strictSpans = inProgressSpansStrict(snaps); // REAL intervals — the taskId model (rollups + task review ops)
  // Strict ts→taskId lookup — NO edge fill: an edit in no REAL interval → null (unassigned).
  const taskForTs = (ts: number): string | null => strictTaskForTs(strictSpans, ts);

  // Workflow ts-windows for workflow→edit attribution (§C): an edit whose ts lands in exactly one
  // workflow's agent-window is that workflow's; in two → ambiguous → null; in none → null.
  const wfWindows = workflowWindows(cwd, session);

  const edits: ChangeMapEdit[] = flat.map(({ rel, cls, edit }) => {
    const rec = byId.get(edit.id);
    const flags = rec ? flagsFor(session, rec, log) : [];
    const warn = flags.find((f) => f.level === 'warn');
    const rsn = reasoning.get(edit.id);
    return {
      id: edit.id,
      rel,
      module: moduleOf(rel),
      file: path.basename(rel),
      cls,
      added: edit.added,
      removed: edit.removed,
      status: edit.status,
      ts: edit.ts,
      agent: agentEditIds.has(edit.id),
      risk: warn ? warn.message : null,
      reasoning: rsn ? firstLine(rsn) : null,
      taskId: taskForTs(edit.ts),
      subagentId: editIdToSubagent.get(edit.id) ?? null,
      workflowId: workflowForTs(wfWindows, edit.ts),
    };
  });

  // Summary — headline counts, all from pieces already parsed above (+ one action scan for errors/egress).
  const actions = parseActions(cwd, session);
  const aSum = summarizeActions(actions);

  // Compactions ride that SAME action scan (they are 'compact' rows) — no extra transcript read, which
  // matters because buildChangeMap runs once per fleet sibling. Ordered by time; the Actions timeline
  // and the Stats readout render them.
  const compactions: CompactionMarker[] = actions
    .filter((a) => a.compact)
    .map((a) => ({ ...a.compact!, label: compactLabel(a.compact!) }))
    .sort((a, b) => a.ts - b.ts);

  const summary: ChangeMapSummary = {
    session,
    title: (insights.title ?? insights.firstUserPrompt ?? '').replace(/\s+/g, ' ').trim(),
    units: edits.length,
    rawEdits: log.length,
    pending: edits.filter((e) => e.status === 'pending').length,
    kept: edits.filter((e) => e.status === 'kept').length,
    undone: edits.filter((e) => e.status === 'undone').length,
    added: edits.reduce((n, e) => n + e.added, 0),
    removed: edits.reduce((n, e) => n + e.removed, 0),
    actions: aSum.total,
    errors: aSum.errors,
    subagents: subs.length,
    fleet: projectSessionIds(cwd).filter((id) => id !== session).length,
    egress: buildEgressReport(actions).length,
    compactions: compactions.length,
    spanMs: aSum.lastTs && aSum.firstTs ? Math.max(0, aSum.lastTs - aSum.firstTs) : 0,
  };

  // Aggregate ONCE, here — every front-end (VS Code webview, JetBrains Swing) renders these rows as
  // given. Duplicating this per-editor is exactly the drift the "shared logic in core" rule prevents.
  const files = rollupFiles(edits);
  const modules = rollupModules(files);

  // Strict-span task identities — the authoritative taskId↔content join source (covers exactly the
  // edit-producing tasks, so `tasklog` labels + the Tasks tab join `rollupByTask` by taskId).
  const taskById = new Map<string, TaskInfo>();
  for (const sp of strictSpans) {
    const t = taskById.get(sp.taskId);
    if (!t) taskById.set(sp.taskId, { taskId: sp.taskId, content: sp.content, firstTs: sp.start, lastTs: sp.end });
    else {
      t.firstTs = Math.min(t.firstTs, sp.start);
      t.lastTs = Math.max(t.lastTs, sp.end);
    }
  }
  const tasks = [...taskById.values()].sort((a, b) => a.firstTs - b.firstTs);

  // Per-WORKFLOW Overview tabs (§D): group the workflow-attributed edits by workflowId — one entry per
  // workflow that produced attributed edits, carrying its name/running (from parseWorkflows) + a
  // per-workflow file rollup. Built HERE so the CLI/editors render tabs without re-aggregating.
  const wfMeta = new Map<string, { name: string; running: boolean }>();
  for (const w of parseWorkflows(cwd, session)) wfMeta.set(w.id, { name: w.name, running: w.running });
  const editsByWorkflow = new Map<string, ChangeMapEdit[]>();
  for (const e of edits) {
    if (e.workflowId === null) continue;
    if (!editsByWorkflow.has(e.workflowId)) editsByWorkflow.set(e.workflowId, []);
    editsByWorkflow.get(e.workflowId)!.push(e);
  }
  const workflows: ChangeMapWorkflow[] = [...editsByWorkflow.entries()].map(([id, wfEdits]) => {
    const rollup = { edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
    const taskIds = new Set<string>();
    for (const e of wfEdits) {
      foldStatus(rollup, e);
      if (e.taskId) taskIds.add(e.taskId);
    }
    const meta = wfMeta.get(id);
    return {
      id,
      name: meta ? meta.name : id,
      running: meta ? meta.running : false,
      rollup,
      files: rollupFiles(wfEdits),
      taskIds: [...taskIds],
    };
  });
  workflows.sort((a, b) => b.rollup.edits - a.rollup.edits || a.id.localeCompare(b.id));

  return {
    summary, edits, compactions, files, modules, tasks,
    rollupByTask: rollupByTask(edits),
    rollupBySubagent: rollupBySubagent(edits),
    rollupByWorkflow: rollupByWorkflow(edits),
    workflows,
    // Per-PROMPT slices are opt-in: they need the user's turns, which is one more transcript pass, and
    // the fleet builds a map per worktree sibling on every refresh — none of which is ever scoped by an
    // ask typed into THIS window. The self map asks for them; siblings don't.
    prompts: opts.prompts ? promptSlices(cwd, session, { edits, subs }) : [],
  };
}

/**
 * Group the session's work by the ask that caused it.
 *
 * Everything here is a fold over pieces `buildChangeMap` already computed — the only new reads are the
 * user's turns (`sessionPrompts`, memoized against the transcript + log) and the background shells,
 * whose ids are what a Processes row is keyed by. Attribution is by START time throughout, so a slice
 * answers "what did asking for this set in motion", not "what finished while I was typing".
 */
function promptSlices(
  cwd: string,
  session: string,
  ctx: {
    edits: ChangeMapEdit[];
    subs: { agentId: string; ts: number }[];
  }
): ChangeMapPrompt[] {
  const asks = sessionPrompts(cwd, session);
  if (!asks.length) return [];
  const slices: ChangeMapPrompt[] = asks.map((r) => ({
    id: r.id,
    index: r.index,
    text: r.text,
    title: r.title,
    ts: r.ts,
    endTs: r.endTs,
    rollup: { edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 },
    files: [],
    modules: [],
    editIds: r.editIds.slice(),
    agentIds: [],
    workflowIds: [],
    processIds: [],
    actions: r.actions,
    errors: r.errors,
    compactions: r.compactions,
    durationMs: r.durationMs,
  }));
  // Which ask owned a given moment — the same binary search `sessionPrompts` attributes with, over
  // ask times that are sorted and tile the session from the first prompt onward. A moment BEFORE the
  // first ask belongs to no prompt (session setup answers to nobody).
  const owner = (ts: number): number => {
    if (!ts || ts < slices[0].ts) return -1;
    let lo = 0;
    let hi = slices.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (slices[mid].ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  // 1. the edits, and with them the files/folders each ask touched
  const editsByAsk = new Map<number, ChangeMapEdit[]>();
  for (const e of ctx.edits) {
    const i = owner(e.ts);
    if (i < 0) continue;
    let arr = editsByAsk.get(i);
    if (!arr) editsByAsk.set(i, (arr = []));
    arr.push(e);
  }
  // 2. subagents by SPAWN time — a fleet row is keyed by the subagent's own agentId, so resolve to that
  //    rather than to the spawning tool_use id (which only the action timeline speaks).
  for (const s of ctx.subs) {
    const i = owner(s.ts);
    if (i >= 0) slices[i].agentIds.push(s.agentId);
  }
  for (const w of parseWorkflows(cwd, session)) {
    const i = owner(w.startedTs || w.lastActivityMs);
    if (i >= 0) slices[i].workflowIds.push(w.id);
  }
  for (const p of sessionProcesses(cwd, session)) {
    const i = owner(p.startedTs);
    if (i >= 0) slices[i].processIds.push(p.id);
  }

  for (let i = 0; i < slices.length; i++) {
    const sl = slices[i];
    const mine = editsByAsk.get(i);
    if (!mine || !mine.length) continue;
    for (const e of mine) foldStatus(sl.rollup, e);
    sl.files = rollupFiles(mine);
    sl.modules = rollupModules(sl.files);
  }
  return slices;
}

/**
 * The RAW store edit ids whose commit ts falls inside a REAL (strict) in_progress interval for `taskId`
 * — the honest per-task attribution that backs task review ops, the cross-agent task log, and the
 * strict rollups. Reads raw store records (never the collapsed change-map units): an edit joins a
 * task's set ONLY via a real interval — never a start=0/end=+∞ edge fill. Composes the single
 * strict-span builder (inProgressSpansStrict), so it can't diverge from the change-map's own
 * attribution. Zero token.
 */
export function taskEditIds(cwd: string, session: string, taskId: string): number[] {
  const transcript = findTranscript(cwd, session);
  const strictSpans = inProgressSpansStrict(transcript ? planSnaps(transcript) : []);
  return readLog(session)
    .filter((r) => strictTaskForTs(strictSpans, r.ts) === taskId)
    .map((r) => r.id);
}

// --- cross-process change-map cache (the Overview's dominant cost) ---

/** Bump to invalidate every persisted map after a shape or semantics change. */
const MAP_CACHE_VERSION = 1;

/** (mtimeMs:size) for a file, or '' when it can't be stat'd. */
/**
 * A digest of every file in `dir` (name, mtime, size) — the stamp for an input that is a DIRECTORY.
 *
 * A directory's own mtime moves when an entry is added or removed but not when one grows, and a
 * subagent's transcript grows for as long as that agent works. Stat-only, over a handful of files.
 */
function dirStamp(dir: string | null): string {
  if (!dir) return '';
  try {
    return fs
      .readdirSync(dir)
      .sort()
      .map((n) => {
        try {
          const st = fs.statSync(path.join(dir, n));
          return `${n}:${st.mtimeMs}:${st.size}`;
        } catch {
          return `${n}:?`;
        }
      })
      .join(',');
  } catch {
    return '';
  }
}

/**
 * Everything a change map is derived from, beyond the session's own transcript and store log.
 *
 * `buildChangeMap` also reads the session's subagent transcripts (summary.subagents, rollupBySubagent,
 * prompts[].agentIds), its workflow journals (workflows[]), and the project's OTHER session transcripts
 * (summary.fleet). Keying the cache on the transcript and log alone froze all of that: subagents that
 * only read, and siblings starting in other worktrees, changed no keyed file, so the Overview kept
 * reporting zero of them until something unrelated moved.
 */
function derivedInputsStamp(cwd: string, session: string): string {
  const transcript = findTranscript(cwd, session);
  const base = transcript ? transcript.replace(/\.jsonl$/, '') : null;
  const subs = base ? path.join(base, 'subagents') : null;
  return [
    dirStamp(subs),
    dirStamp(subs ? path.join(subs, 'workflows') : null),
    dirStamp(base ? path.join(base, 'workflows') : null),
    // The project dir is one file per session: this covers every sibling transcript at once.
    dirStamp(transcript ? path.dirname(transcript) : null),
  ].join('|');
}

function fileStamp(p: string | null): string {
  if (!p) return '';
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

/**
 * `buildChangeMap` for a FLEET SIBLING, memoized on disk.
 *
 * Why this exists: the Overview builds one full change map per sibling session, and a mature repo has
 * dozens (27 in this one) — nearly all finished sessions whose transcript and store log will never
 * change again. Each build re-parses that session's transcript, so one Overview refresh cost ~14.5s of
 * pure re-derivation, in a fresh CLI process every few seconds where the in-process memo can never
 * help. Keying the result to its (transcript, log) stamps turns every idle sibling into a file read.
 *
 * Deliberately NOT used for the session being viewed: that transcript is growing, so it would miss
 * every time regardless, and its live counts are the ones a user is watching.
 */
export function siblingChangeMap(cwd: string, session: string, opts: { root: string }): ChangeMap {
  return siblingOverview(cwd, session, opts).map;
}

/** Everything the fleet views derive per sibling that is a pure function of its files. */
export interface SiblingOverview {
  map: ChangeMap;
  /** Fixed-width activity histogram over the session's tool calls — the fleet row's sparkline. */
  sparkline: number[];
  /** The session's latest to-do list, for the fleet row's task line. */
  todos: { content: string; status: string }[];
}

/**
 * The session's own change map, memoized on disk exactly as a sibling's payload is.
 *
 * `changemap --json` runs in a FRESH process on every refresh tick, so the in-process memo never helps
 * it: rebuilding a finished session's map cost seconds of transcript parsing every time, which is what
 * made switching to a long session feel like a hang. The map is a pure function of the transcript and
 * the store log, so keying the result to their stamps is safe — either file changing rebuilds it.
 */
/**
 * Where a session's cached map lives: `<root>/changemap-cache/<sessionId>/<key>.json`.
 *
 * Filed under the session id, not flat, so dropping a session can reap its derived copies — a flat
 * key is a one-way hash of (cwd, session, root) and cannot be reversed to find them. The payload holds
 * the session's prompt text verbatim; leaving it behind after a drop would keep deleted content.
 */
function mapCachePath(session: string, key: string): string {
  const dir = isSafeSessionId(session)
    ? path.join(rootDir(), 'changemap-cache', session)
    : path.join(rootDir(), 'changemap-cache');
  return path.join(dir, `${key}.json`);
}

export function cachedChangeMap(cwd: string, session: string, opts: { root: string; prompts?: boolean }): ChangeMap {
  const transcript = findTranscript(cwd, session);
  const tStamp = fileStamp(transcript);
  const lStamp = fileStamp(logPath(session));
  const build = (): ChangeMap => buildChangeMap(cwd, session, opts);
  if (!tStamp && !lStamp) return build(); // nothing stable to key on
  const stamp = `${MAP_CACHE_VERSION}|${tStamp}|${lStamp}|${opts.prompts ? 'p' : '-'}|${derivedInputsStamp(cwd, session)}`;
  const key = crypto.createHash('sha256').update(`map ${cwd} ${session} ${opts.root}`).digest('hex').slice(0, 16);
  const p = mapCachePath(session, key);
  try {
    const hit = JSON.parse(fs.readFileSync(p, 'utf8')) as { stamp: string; map: ChangeMap };
    if (hit && hit.stamp === stamp && hit.map && hit.map.summary) return hit.map;
  } catch {
    /* absent or unreadable — rebuild */
  }
  const map = build();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`;
    // 0600/0700 like every other file in the store (SECURITY.md): this payload carries prompt text.
    fs.writeFileSync(tmp, JSON.stringify({ stamp, map }), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    /* cache is best-effort */
  }
  return map;
}

/**
 * One sibling's whole fleet payload, memoized on disk.
 *
 * The Overview derives several things per sibling — its change map, an activity sparkline, its current
 * to-dos — and a mature repo has dozens of siblings, nearly all FINISHED sessions whose transcript and
 * store log will never change again. All of it runs in a fresh CLI process every few seconds, where an
 * in-process memo can never help, so each refresh re-parsed every sibling transcript two or three more
 * times over. Keying the finished result to its (transcript, log) stamps turns that into one file read.
 *
 * Live facts (an agent's phase, its subagents' phases) are deliberately NOT cached here: they are
 * staleness-derived, so a frozen copy would report a working agent as done.
 */
export function siblingOverview(cwd: string, session: string, opts: { root: string; bins?: number }): SiblingOverview {
  const transcript = findTranscript(cwd, session);
  const tStamp = fileStamp(transcript);
  const lStamp = fileStamp(logPath(session));
  const bins = opts.bins ?? 20;
  const build = (): SiblingOverview => ({
    map: buildChangeMap(cwd, session, opts),
    sparkline: activityBins(parseActions(cwd, session).map((a) => a.ts), bins),
    todos: transcriptInsights(cwd, session).todos,
  });
  // Nothing stable to key on (neither input exists) — just build it.
  if (!tStamp && !lStamp) return build();
  const stamp = `${MAP_CACHE_VERSION}|${tStamp}|${lStamp}|${bins}|${derivedInputsStamp(cwd, session)}`;
  const key = crypto.createHash('sha256').update(`${cwd} ${session} ${opts.root}`).digest('hex').slice(0, 16);
  const p = mapCachePath(session, key);
  try {
    const hit = JSON.parse(fs.readFileSync(p, 'utf8')) as { stamp: string; view: SiblingOverview };
    if (hit && hit.stamp === stamp && hit.view && hit.view.map) return hit.view;
  } catch {
    /* absent or unreadable — rebuild */
  }
  const view = build();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.${process.pid}.tmp`; // pid-scoped so concurrent CLI processes can't collide
    fs.writeFileSync(tmp, JSON.stringify({ stamp, view }), { mode: 0o600 });
    fs.renameSync(tmp, p); // atomic: a concurrent reader sees old-or-new, never a torn view
  } catch {
    /* cache is best-effort */
  }
  return view;
}

/**
 * Bucket timestamps into a fixed-width activity histogram (the fleet + workflow sparklines). Loop-based
 * min/max, never Math.min(...ts): a long session's timestamp array is large enough to blow the call
 * stack when spread into arguments.
 */
export function activityBins(tsList: number[], bins = 20): number[] {
  const out = new Array(bins).fill(0);
  const ts = tsList.filter((t) => t > 0);
  if (ts.length === 0) return out;
  const min = minOf(ts);
  const max = maxOf(ts);
  if (max === min) {
    out[bins - 1] = ts.length; // all at one instant → a single trailing spike, not a divide-by-zero
    return out;
  }
  const span = max - min;
  for (const t of ts) {
    let i = Math.floor(((t - min) / span) * bins);
    if (i < 0) i = 0;
    if (i >= bins) i = bins - 1;
    out[i]++;
  }
  return out;
}
