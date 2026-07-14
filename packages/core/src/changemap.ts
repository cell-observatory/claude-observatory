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
import { EditStatus, EditRecord, readLog } from './store';
import { buildEditTree, EditTree, TreeEdit, TreeFolder, TreeFile } from './tree';
import { reasoningByEdit, transcriptInsights, findTranscript, flagsFor } from './observe';
import { parseActions, summarizeActions } from './actions';
import { parseSubagents } from './subagents';
import { buildEgressReport } from './egress';
import { projectSessionIds } from './fleet';

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
  chapter: string | null; // id of the chapter (to-do) whose window this edit fell in, or null (unassigned)
}

/** A to-do Claude tracked, turned into a chapter: the goal + how much of the session it accounts for. */
export interface ChangeMapChapter {
  id: string; // stable within a build (`ch0`, `ch1`, …) — the brush key
  index: number;
  title: string; // Claude's own to-do text
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

/** One module bucket, rolled up from its files — the segment a "proportion strip" renders. */
export interface ChangeMapModule {
  module: string; // raw bucket (the filter key)
  label: string; // display label (see `moduleLabel`)
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

export interface ChangeMap {
  summary: ChangeMapSummary;
  edits: ChangeMapEdit[];
  chapters: ChangeMapChapter[];
  /** Per-file rollup, churn-desc. Rendered directly — front-ends must not re-aggregate. */
  files: ChangeMapFile[];
  /** Per-module rollup, churn-desc. Rendered directly — front-ends must not re-aggregate. */
  modules: ChangeMapModule[];
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

/** Roll the per-file rows up into module buckets (churn-desc). */
function rollupModules(files: ChangeMapFile[]): ChangeMapModule[] {
  const by = new Map<string, ChangeMapModule>();
  const chapters = new Map<string, Set<string>>();
  for (const f of files) {
    let m = by.get(f.module);
    if (!m) {
      m = {
        module: f.module, label: moduleLabel(f.module), churn: 0, cnt: 0, added: 0, removed: 0,
        kept: 0, pending: 0, undone: 0, status: 'kept', files: 0, chapters: [],
      };
      by.set(f.module, m);
      chapters.set(f.module, new Set());
    }
    m.churn += f.churn;
    m.cnt += f.cnt;
    m.added += f.added;
    m.removed += f.removed;
    m.kept += f.kept;
    m.pending += f.pending;
    m.undone += f.undone;
    m.files++;
    for (const c of f.chapters) chapters.get(f.module)!.add(c);
  }
  const out = [...by.values()];
  for (const m of out) {
    m.chapters = [...chapters.get(m.module)!];
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
  todos: { content: string; status: string }[];
}

/** Ordered TodoWrite snapshots from the main transcript (each carries its ts + the full list). */
function todoSnaps(transcriptPath: string): TodoSnap[] {
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

/** Map a to-do's content → its [start,end) window, from the times it was the in-progress item.
 *  A chapter boundary = a to-do flips to in_progress; its window runs until the next one does. */
function todoWindows(snaps: TodoSnap[]): Map<string, { start: number; end: number }> {
  const transitions: { ts: number; content: string }[] = [];
  let last: string | null = null;
  for (const s of snaps) {
    if (!s.ts) continue;
    const ip = s.todos.find((t) => t.status === 'in_progress');
    if (ip && ip.content !== last) {
      transitions.push({ ts: s.ts, content: ip.content });
      last = ip.content;
    }
  }
  const win = new Map<string, { start: number; end: number }>();
  for (let i = 0; i < transitions.length; i++) {
    const cur = transitions[i];
    const end = i + 1 < transitions.length ? transitions[i + 1].ts : Number.MAX_SAFE_INTEGER;
    // First writer wins the window start; a later re-visit of the same to-do extends the end implicitly
    // via the next-transition boundary, so we keep the earliest start.
    const prev = win.get(cur.content);
    if (!prev) win.set(cur.content, { start: cur.ts, end });
    else prev.end = end;
  }
  return win;
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
  for (const s of subs) for (const a of s.actions) if (a.editId != null) agentEditIds.add(a.editId);

  const insights = transcriptInsights(cwd, session);
  const transcript = findTranscript(cwd, session);
  const windows = transcript ? todoWindows(todoSnaps(transcript)) : new Map<string, { start: number; end: number }>();

  // Chapters from the FINAL to-do list (the full plan, in order); windows attach by content match.
  const chapters: ChangeMapChapter[] = insights.todos.map((td, i) => {
    const w = windows.get(td.content);
    return {
      id: `ch${i}`,
      index: i,
      title: td.content,
      status: td.status === 'completed' ? 'done' : td.status === 'in_progress' ? 'wip' : 'todo',
      startTs: w?.start ?? 0,
      endTs: w && w.end !== Number.MAX_SAFE_INTEGER ? w.end : 0,
      edits: 0,
      added: 0,
      removed: 0,
      pending: 0,
      kept: 0,
      undone: 0,
      agent: false,
    };
  });
  // Sorted windows for O(edits · chapters) attribution (chapter count is tiny).
  const windowed = chapters
    .filter((c) => c.startTs > 0)
    .map((c) => ({ c, start: c.startTs, end: windows.get(c.title)!.end }))
    .sort((a, b) => a.start - b.start);
  const chapterForTs = (ts: number): ChangeMapChapter | null => {
    if (!ts) return null;
    for (const w of windowed) if (ts >= w.start && ts < w.end) return w.c;
    return null;
  };

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
      chapter: ch ? ch.id : null,
    };
  });

  // Roll chapter stats from the edits attributed to each.
  const chById = new Map(chapters.map((c) => [c.id, c]));
  for (const e of edits) {
    if (!e.chapter) continue;
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

  return { summary, edits, chapters, files, modules };
}
