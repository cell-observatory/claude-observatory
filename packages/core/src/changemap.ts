/**
 * Change-map model (zero-token): the whole session's edits assembled as one bird's-eye review diagram.
 * Reuses the folder→file→class tree, flattens it to a per-edit list carrying churn (±lines), review
 * status, Claude's own reasoning, and subagent/risk overlays — then turns Claude's to-dos into
 * time-windowed "chapters" so each edit can be traced back to the goal it realized. One assembly, so
 * the treemap + chapter ribbon render identically in VS Code and JetBrains off the CLI `changemap --json`.
 *
 * Everything here is derived from what the observatory already parses — no model calls, nothing stored.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EditStatus, EditRecord, readLog } from './store';
import { buildEditTree, EditTree, TreeEdit, TreeFolder, TreeFile } from './tree';
import { reasoningByEdit, transcriptInsights, findTranscript, flagsFor } from './observe';
import { parseActions, summarizeActions } from './actions';
import { parseSubagents } from './subagents';
import { buildEgressReport } from './egress';
import { projectSessionIds } from './fleet';
import { parseWorkflows, workflowWindows, workflowForTs } from './workflows';
import { taskSnaps } from './tasks';
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
  chapter: string; // display-brush key — TOTAL: the chapter (to-do) whose gap-filled window this edit fell in, else the synthetic session chapter. Never null.
  taskId: string | null; // per-TASK: the stable taskId whose STRICT in_progress interval this edit fell in, else null (unassigned)
  subagentId: string | null; // per-SUBAGENT: the subagent (agentId) that authored this edit, else null (main-chain or unattributed)
  workflowId: string | null; // per-WORKFLOW: the wf_<id> whose agent ts-window this edit fell in, else null (none / ambiguous)
}

/** A to-do Claude tracked, turned into a chapter: the goal + how much of the session it accounts for. */
export interface ChangeMapChapter {
  id: string; // stable content-hash brush key — ALSO the WYSIWYG review-op key (reviewEditIds); duplicate-content to-dos get an occurrence-salted id (first occurrence keeps the plain hash); the synthetic session chapter is 'ch:session'
  taskId: string | null; // the STRICT task this chapter joins for analytics + 💬 chat framing; null = no strict task (synthetic chapter, or a duplicate-content occurrence beyond the first)
  synthetic: boolean; // true for the fallback session chapter that claims work outside any to-do (never a real task)
  fromTask: boolean; // true when this chapter was born from the numbered task list (0.8.3) — attribution + review + the Tasks-tab join use it, but ribbons don't draw it (its home is the Tasks tab)
  index: number;
  title: string; // Claude's own to-do text (or the session title / first prompt for the synthetic chapter)
  status: 'done' | 'wip' | 'todo'; // completed | in_progress | pending
  startTs: number; // window start (0 if this to-do never became in_progress → no attributed edits)
  endTs: number; // window end (0 if open-ended / none)
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
  agent: boolean; // any attributed edit was subagent-authored
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
  chapters: string[]; // distinct chapter ids this file's edits belong to (the brush key)
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
  chapters: string[];
}

export interface ChangeMapSummary {
  session: string;
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
 * the latest snapshot. This is the join source; the display `chapters[]` (the full plan, incl.
 * never-started to-dos) are a separate view whose ids only overlap where content matches.
 */
export interface TaskInfo {
  taskId: string; // === taskId(content); the join key for rollupByTask / tasklog / the Overview ribbon
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
  /** This workflow's edits regrouped by chapter — session-chapter identity (id/title/status/…) with
   *  counts scoped to the workflow. Rendered directly as the workflow slice's ribbon, replacing the
   *  per-editor "run total minus chaptered" residual math (total chapters → no residual exists). */
  chapters: ChangeMapChapter[];
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

export interface ChangeMap {
  summary: ChangeMapSummary;
  edits: ChangeMapEdit[];
  chapters: ChangeMapChapter[];
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
   * Strict-span task identities (taskId → content), the authoritative label + join source for
   * `rollupByTask`, the Overview task ribbon, and the cross-agent task log. Covers exactly the tasks
   * that held a real in_progress interval — so it joins `rollupByTask` by `taskId` (unlike `chapters`,
   * which is the full plan and only overlaps where content matches).
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
  const chapters = new Map<string, Set<string>>();
  for (const e of edits) {
    let f = by.get(e.rel);
    if (!f) {
      f = {
        rel: e.rel, module: e.module, moduleLabel: moduleLabel(e.module), file: e.file,
        churn: 0, cnt: 0, added: 0, removed: 0,
        kept: 0, pending: 0, undone: 0, status: 'kept', maxId: -1, classes: [], chapters: [],
        agent: false, risk: null, reason: null,
      };
      by.set(e.rel, f);
      classes.set(e.rel, new Set());
      chapters.set(e.rel, new Set());
    }
    f.churn += e.added + e.removed;
    f.added += e.added;
    f.removed += e.removed;
    f.cnt++;
    if (e.status === 'kept') f.kept++;
    else if (e.status === 'undone') f.undone++;
    else f.pending++;
    if (e.cls) classes.get(e.rel)!.add(e.cls);
    if (e.chapter) chapters.get(e.rel)!.add(e.chapter);
    if (e.agent) f.agent = true;
    if (e.risk && !f.risk) f.risk = e.risk;
    if (e.reasoning && !f.reason) f.reason = e.reasoning;
    if (e.id > f.maxId) f.maxId = e.id; // newest edit = what a click on this row opens
  }
  const out = [...by.values()];
  for (const f of out) {
    f.classes = [...classes.get(f.rel)!];
    f.chapters = [...chapters.get(f.rel)!];
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
  const chapters = new Map<string, Set<string>>();
  for (const f of files) {
    const key = f.moduleLabel;
    let m = by.get(key);
    if (!m) {
      m = {
        module: key, label: key, churn: 0, cnt: 0, added: 0, removed: 0,
        kept: 0, pending: 0, undone: 0, status: 'kept', files: 0, chapters: [],
      };
      by.set(key, m);
      chapters.set(key, new Set());
    }
    m.churn += f.churn;
    m.cnt += f.cnt;
    m.added += f.added;
    m.removed += f.removed;
    m.kept += f.kept;
    m.pending += f.pending;
    m.undone += f.undone;
    m.files++;
    for (const c of f.chapters) chapters.get(key)!.add(c);
  }
  const out = [...by.values()];
  for (const m of out) {
    m.chapters = [...chapters.get(m.label)!];
    m.status = fileStatus(m);
  }
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
  /** src marks TASK-born items (tasks.ts snapshots) — their chapters carry `fromTask`, so ribbons
   *  leave them to the Overview's Tasks tab instead of drawing duplicate rows. */
  todos: { content: string; status: string; src?: 'task' }[];
}

/**
 * The PLAN snapshots the span model consumes: TodoWrite ∪ the task system (TaskCreate/TaskUpdate,
 * mined in tasks.ts), merged on one timeline into the same full-list shape — so task-planned sessions
 * get real chapters (attribution + WYSIWYG review) through the identical machinery. Todos win
 * duplicate titles (the bundled demo plans both ways) so the two systems never mint twin chapters.
 */
function planSnaps(transcriptPath: string): TodoSnap[] {
  const todos = todoSnaps(transcriptPath);
  const tasks = taskSnaps(transcriptPath);
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

interface Span {
  content: string;
  start: number;
  end: number;
}

/**
 * The disjoint timeline of "which to-do was in_progress, and when" — one span per contiguous run.
 * A span closes the instant a DIFFERENT to-do becomes in_progress (or none is), so spans never
 * overlap: a to-do revisited later gets a second, separate span instead of one that swallows the
 * work done in between (the bug in the old window model). The display brush is TOTAL — once any
 * span exists, every ts>0 falls in exactly one:
 *   - the FIRST span extends back to the session start, so edits made before the first `in_progress`
 *     flip attribute to the opening chapter instead of falling through;
 *   - each span's end is filled forward to the NEXT span's start, so work done in a lull between
 *     to-dos attributes to the chapter that was just in progress (the nearest preceding one);
 *   - the LAST span runs to +∞ even if it closed, so trailing edits attribute to the final chapter.
 * The STRICT model (`inProgressSpansStrict`) keeps the honest gaps — destructive ops never widen.
 */
function inProgressSpans(snaps: TodoSnap[]): Span[] {
  const spans: Span[] = [];
  let cur: Span | null = null;
  for (const s of snaps) {
    if (!s.ts) continue;
    const ip = s.todos.find((t) => t.status === 'in_progress');
    const content = ip ? ip.content : null;
    if (content === (cur ? cur.content : null)) continue; // nothing changed about what's in progress
    if (cur) cur.end = s.ts; // close the running span at this checkpoint
    cur = content ? { content, start: s.ts, end: Number.MAX_SAFE_INTEGER } : null;
    if (cur) spans.push(cur);
  }
  if (spans.length) spans[0].start = 0; // opening work counts toward the first chapter, not nothing
  for (let i = 0; i + 1 < spans.length; i++) spans[i].end = spans[i + 1].start; // fill gaps forward
  if (spans.length) spans[spans.length - 1].end = Number.MAX_SAFE_INTEGER; // trailing work → final chapter
  return spans;
}

/** Stable per-task identity (first-seen wins), tracked while building strict spans. */
export type TaskIdentity = { taskId: string; content: string; firstTs: number };

/**
 * Stable task id — a content hash, NOT the old positional `ch${i}`. Reordering or inserting to-dos
 * never shifts it, and two to-dos with identical text deterministically share ONE id (an honest
 * collision → one task) instead of the old last-wins. `firstSeenTs` pins a task's first-seen time in
 * the identity map so its `firstTs` doesn't drift if the to-do reappears later; it does NOT enter the
 * hash (identical text must stay one id).
 */
export function taskId(content: string, firstSeenTs: number): string {
  return crypto.createHash('sha1').update(content).digest('hex').slice(0, 12);
}

/**
 * Display-only chapter id for the nth (n ≥ 1) duplicate-content to-do — every ribbon row needs its own
 * brush key, but identical text is ONE strict task, so later occurrences render display-only rows
 * (`taskId: null`). Occurrence 0 keeps the plain content hash: existing sessions' ids never change.
 */
function dupChapterId(content: string, n: number): string {
  return crypto.createHash('sha1').update(`${content}\u0000${n}`).digest('hex').slice(0, 12);
}

/** The synthetic fallback chapter's id — claims every edit outside any to-do window, so the display
 *  dimension is total. Contains a ':' so it can never collide with a 12-hex content hash. */
const SYNTHETIC_CHAPTER_ID = 'ch:session';

/** A REAL in_progress interval for the taskId model — no edge extension (cf. `Span`). */
interface StrictSpan {
  taskId: string;
  content: string;
  start: number; // ts the to-do ENTERED in_progress — the first span does NOT reach back to 0
  end: number; // ts it LEFT in_progress; an open (never-completed) span ends at its LAST observed in_progress mtime, NOT +∞
}

/**
 * The honest counterpart to `inProgressSpans` for the taskId model, with NO edge fill. `start` is
 * exactly when a to-do entered in_progress; `end` is when it left (a later checkpoint no longer shows
 * it in_progress). A to-do that never completes ends at its LAST observed in_progress mtime, not +∞.
 * So an edit made before the first in_progress, or after the last one closed, falls in NO interval and
 * is honestly `unassigned` — never force-filed onto the head/tail task. This is the destructive-safety
 * fix: a task's keep/undo set must never include an edit that was never part of that task.
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
export function buildChangeMap(cwd: string, session: string, opts: { root?: string } = {}): ChangeMap {
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
  const spans = inProgressSpans(snaps); // legacy edge-extended windows — the display brush only
  const strictSpans = inProgressSpansStrict(snaps); // REAL intervals — the taskId model (rollups + destructive ops)
  const firstSpan = new Map<string, Span>(); // a chapter's display start/end = its first in_progress span
  for (const sp of spans) if (!firstSpan.has(sp.content)) firstSpan.set(sp.content, sp);
  const firstSeenTs = new Map<string, number>(); // a to-do's first appearance ts — pins its taskId's firstTs
  for (const s of snaps) for (const td of s.todos) if (!firstSeenTs.has(td.content)) firstSeenTs.set(td.content, s.ts);

  // Chapters from the FINAL plan list (the full plan, in order) — the last merged snapshot, so a
  // task-planned session (TaskCreate, no TodoWrite) gets real chapters too; spans attach by content
  // match. Duplicate-content items: the timeline can't tell the occurrences apart (spans key by
  // content), so the FIRST occurrence keeps the plain content-hash id (stable for every existing
  // session) and claims the edits + the strict taskId; later occurrences get an occurrence-salted id
  // and are display-only (`taskId: null`) — two ribbon rows never share a brush key, nothing
  // double-counts.
  const finalPlan: TodoSnap['todos'] = snaps.length ? snaps[snaps.length - 1].todos : insights.todos;
  const occurrence = new Map<string, number>();
  const chapters: ChangeMapChapter[] = finalPlan.map((td, i) => {
    const n = occurrence.get(td.content) ?? 0;
    occurrence.set(td.content, n + 1);
    const baseId = taskId(td.content, firstSeenTs.get(td.content) ?? 0);
    const sp = n === 0 ? firstSpan.get(td.content) : undefined; // a duplicate row owns no window
    return {
      id: n === 0 ? baseId : dupChapterId(td.content, n),
      taskId: n === 0 ? baseId : null,
      synthetic: false,
      fromTask: td.src === 'task',
      index: i,
      title: td.content,
      status: td.status === 'completed' ? 'done' : td.status === 'in_progress' ? 'wip' : 'todo',
      startTs: sp ? sp.start : 0,
      endTs: sp && sp.end !== Number.MAX_SAFE_INTEGER ? sp.end : 0,
      edits: 0,
      added: 0,
      removed: 0,
      pending: 0,
      kept: 0,
      undone: 0,
      agent: false,
    };
  });
  const chapterByContent = new Map<string, ChangeMapChapter>();
  for (const c of chapters) if (!chapterByContent.has(c.title)) chapterByContent.set(c.title, c); // FIRST occurrence claims the content's spans
  const chapterForTs = (ts: number): ChangeMapChapter | null => {
    if (!ts) return null;
    // spans are disjoint + in order → at most one contains ts (no overlap ambiguity)
    for (const sp of spans) if (ts >= sp.start && ts < sp.end) return chapterByContent.get(sp.content) ?? null;
    return null;
  };
  // Strict ts→taskId lookup for the taskId model — NO edge fill: an edit in no REAL interval → null (unassigned).
  const taskForTs = (ts: number): string | null => strictTaskForTs(strictSpans, ts);

  // Workflow ts-windows for workflow→edit attribution (§C): an edit whose ts lands in exactly one
  // workflow's agent-window is that workflow's; in two → ambiguous → null; in none → null.
  const wfWindows = workflowWindows(cwd, session);

  const edits: ChangeMapEdit[] = flat.map(({ rel, cls, edit }) => {
    const rec = byId.get(edit.id);
    const flags = rec ? flagsFor(session, rec, log) : [];
    const warn = flags.find((f) => f.level === 'warn');
    const rsn = reasoning.get(edit.id);
    const ch = chapterForTs(edit.ts);
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
      chapter: ch ? ch.id : SYNTHETIC_CHAPTER_ID, // TOTAL — anything outside every window lands in the session chapter
      taskId: taskForTs(edit.ts),
      subagentId: editIdToSubagent.get(edit.id) ?? null,
      workflowId: workflowForTs(wfWindows, edit.ts),
    };
  });

  // The synthetic session chapter — appended only when something actually fell outside every to-do
  // window (no-TodoWrite session, ts===0 edit, or a span whose to-do left the final list). Titled from
  // the session itself so the ribbon reads as a real goal, never a bookkeeping bucket. Display-only:
  // `taskId: null` → renderers offer no destructive ops (the strict model has no such task).
  if (edits.some((e) => e.chapter === SYNTHETIC_CHAPTER_ID)) {
    const orphanTs = edits.filter((e) => e.chapter === SYNTHETIC_CHAPTER_ID && e.ts > 0).map((e) => e.ts);
    chapters.push({
      id: SYNTHETIC_CHAPTER_ID,
      taskId: null,
      synthetic: true,
      fromTask: false,
      index: chapters.length,
      title: insights.title ?? (insights.firstUserPrompt ? firstLine(insights.firstUserPrompt, 80) : 'Session work'),
      status: 'wip', // refined to 'done' below once counts are folded
      startTs: orphanTs.length ? Math.min(...orphanTs) : 0,
      endTs: 0,
      edits: 0,
      added: 0,
      removed: 0,
      pending: 0,
      kept: 0,
      undone: 0,
      agent: false,
    });
  }

  // Roll chapter stats from the edits attributed to each.
  const chById = new Map(chapters.map((c) => [c.id, c]));
  for (const e of edits) {
    const c = chById.get(e.chapter);
    if (!c) continue;
    c.edits++;
    c.added += e.added;
    c.removed += e.removed;
    if (e.status === 'kept') c.kept++;
    else if (e.status === 'undone') c.undone++;
    else c.pending++;
    if (e.agent) c.agent = true;
  }
  // The synthetic chapter's status follows its review state (it has no to-do to inherit from).
  const synth = chById.get(SYNTHETIC_CHAPTER_ID);
  if (synth) synth.status = synth.pending > 0 ? 'wip' : 'done';

  // Summary — headline counts, all from pieces already parsed above (+ one action scan for errors/egress).
  const actions = parseActions(cwd, session);
  const aSum = summarizeActions(actions);
  const summary: ChangeMapSummary = {
    session,
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
    spanMs: aSum.lastTs && aSum.firstTs ? Math.max(0, aSum.lastTs - aSum.firstTs) : 0,
  };

  // Aggregate ONCE, here — every front-end (VS Code webview, JetBrains Swing) renders these rows as
  // given. Duplicating this per-editor is exactly the drift the "shared logic in core" rule prevents.
  const files = rollupFiles(edits);
  const modules = rollupModules(files);

  // Strict-span task identities — the authoritative taskId↔content join source (covers exactly the
  // edit-producing tasks, so `tasklog` labels + the Overview ribbon join `rollupByTask` by taskId).
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
    // The workflow slice's own ribbon: this workflow's edits regrouped by chapter — session-chapter
    // identity with counts scoped to the run. Total chapters → this partitions the slice exactly, so
    // renderers draw it as-is (no residual math).
    const wfChapters = new Map<string, ChangeMapChapter>();
    for (const e of wfEdits) {
      foldStatus(rollup, e);
      if (e.taskId) taskIds.add(e.taskId);
      const src = chById.get(e.chapter);
      if (!src) continue;
      let c = wfChapters.get(src.id);
      if (!c) {
        c = { ...src, edits: 0, added: 0, removed: 0, pending: 0, kept: 0, undone: 0, agent: false };
        wfChapters.set(src.id, c);
      }
      c.edits++;
      c.added += e.added;
      c.removed += e.removed;
      if (e.status === 'kept') c.kept++;
      else if (e.status === 'undone') c.undone++;
      else c.pending++;
      if (e.agent) c.agent = true;
    }
    const meta = wfMeta.get(id);
    return {
      id,
      name: meta ? meta.name : id,
      running: meta ? meta.running : false,
      rollup,
      files: rollupFiles(wfEdits),
      taskIds: [...taskIds],
      chapters: [...wfChapters.values()].sort((a, b) => a.index - b.index),
    };
  });
  workflows.sort((a, b) => b.rollup.edits - a.rollup.edits || a.id.localeCompare(b.id));

  return {
    summary, edits, chapters, files, modules, tasks,
    rollupByTask: rollupByTask(edits),
    rollupBySubagent: rollupBySubagent(edits),
    rollupByWorkflow: rollupByWorkflow(edits),
    workflows,
  };
}

/**
 * The RAW store edit ids whose commit ts falls inside a REAL (strict) in_progress interval for `taskId`
 * — the honest per-task attribution that backs the cross-agent task log and the strict rollups. Reads
 * raw store records (never the collapsed change-map units): an edit joins a task's set ONLY via a real
 * interval — never a start=0/end=+∞ edge fill. Composes S6's single strict-span builder
 * (inProgressSpansStrict), so it can't diverge from the change-map's own attribution. Zero token.
 * (Review ops resolve via `reviewEditIds` below — WYSIWYG over the DISPLAYED chapter set.)
 */
export function taskEditIds(cwd: string, session: string, taskId: string): number[] {
  const transcript = findTranscript(cwd, session);
  const strictSpans = inProgressSpansStrict(transcript ? planSnaps(transcript) : []);
  return readLog(session)
    .filter((r) => strictTaskForTs(strictSpans, r.ts) === taskId)
    .map((r) => r.id);
}

/**
 * The RAW store edit ids DISPLAYED under a chapter — including the synthetic session chapter
 * ('ch:session'). This is the WYSIWYG review set (0.8.0 stabilization): a chapter row's Accept/Reject/
 * Clear act on exactly the edits the row shows, so accepting a chapter never leaves gap-filled members
 * behind (the "accepted the chapter but edits remain" confusion). Mirrors buildChangeMap's display
 * attribution — gap-filled spans, first-occurrence content → plain-hash chapter id, synthetic fallback
 * for everything else — and is pinned against it by tests. Returns [] for an id that names no display
 * chapter (callers fall back to the strict set).
 */
export function chapterEditIds(cwd: string, session: string, chapterId: string): number[] {
  const transcript = findTranscript(cwd, session);
  const snaps = transcript ? planSnaps(transcript) : [];
  const spans = inProgressSpans(snaps);
  const insights = transcriptInsights(cwd, session);
  // First occurrence of each plan item's content claims the content's spans (mirrors chapterByContent).
  // The FINAL merged snapshot, so task-chapters resolve here too (WYSIWYG review on task rows).
  const finalPlan = snaps.length ? snaps[snaps.length - 1].todos : insights.todos;
  const idByContent = new Map<string, string>();
  for (const td of finalPlan) if (!idByContent.has(td.content)) idByContent.set(td.content, taskId(td.content, 0));
  const chapterOf = (ts: number): string => {
    if (ts) {
      // Display spans are gap-filled and disjoint → at most one contains ts.
      for (const sp of spans) if (ts >= sp.start && ts < sp.end) return idByContent.get(sp.content) ?? SYNTHETIC_CHAPTER_ID;
    }
    return SYNTHETIC_CHAPTER_ID;
  };
  return readLog(session)
    .filter((r) => chapterOf(r.ts) === chapterId)
    .map((r) => r.id);
}

/**
 * Resolve a chapter/task id to the edit set REVIEW OPS act on: the displayed chapter set when the id
 * names a chapter (WYSIWYG — the buttons touch exactly what the row shows, including the synthetic
 * session chapter), else the strict-span set (an analytics-side task id — e.g. a tasklog row whose
 * to-do no longer heads a chapter). Chapter ids and strict taskIds share the same content-hash value
 * for real chapters, so one resolver serves the CLI, both editors, and scripts.
 */
export function reviewEditIds(cwd: string, session: string, id: string): number[] {
  const display = chapterEditIds(cwd, session, id);
  return display.length ? display : taskEditIds(cwd, session, id);
}
