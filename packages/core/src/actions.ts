/**
 * Action timeline (zero-token): the full, typed stream of EVERY tool call Claude made this session —
 * not just the file edits the store captures. Reads, searches, shell commands, web fetches, subagent
 * spawns, and to-do updates are all mined from the Claude Code session transcript (the same file
 * observe.ts already parses for reasoning), correlated with their tool_result for success/failure.
 *
 * This is what turns Claude Observatory from an *edit* review layer into a *session* observatory: the
 * store answers "what did Claude change?"; this answers "what did Claude DO?".
 *
 * No model calls — the transcript already contains every tool_use and its result.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readLog } from './store';
import { findTranscript } from './observe';
import { scoreCommand, CommandRisk } from './risk';

/** Coarse action kind, drives the timeline's icon + grouping + which rows the UI can dim/filter. */
export type ActionCategory =
  | 'edit' // Edit | Write | MultiEdit | NotebookEdit  (mutates a file — links to a store EditRecord)
  | 'exec' // Bash                                     (runs a shell command — may also mutate files)
  | 'read' // Read | NotebookRead                      (reads a file)
  | 'search' // Grep | Glob                            (searches the codebase)
  | 'web' // WebFetch | WebSearch                      (touches the network — see egress, 0.6.0)
  | 'agent' // Task | Agent                            (spawns a subagent — see subagents, 0.7.0)
  | 'todo' // TodoWrite                                (updates the plan checklist)
  | 'mcp' // mcp__<server>__<tool>                     (an external MCP tool)
  | 'meta' // AskUserQuestion | ExitPlanMode | ToolSearch | Skill (harness/UX, not codebase work)
  | 'other';

export interface ActionRecord {
  /** ms epoch of the tool_use's transcript line (0 if the line carried no timestamp). */
  ts: number;
  /** The tool name exactly as Claude Code recorded it (Bash, Read, Grep, WebFetch, Agent, mcp__x__y…). */
  tool: string;
  category: ActionCategory;
  /** One-line human-readable target: file path, shell command, search pattern, url, query, subagent task… */
  target: string;
  /** Secondary context when the tool has one (Bash description, Agent subagent_type, Grep path…). */
  detail?: string;
  /** false only when the correlated tool_result reported is_error (or the command failed). */
  ok: boolean;
  isError: boolean;
  /** Claude's reasoning (the assistant text/thinking that preceded this call), carried forward per message. */
  reasoning?: string;
  /** For file-edit actions: the store EditRecord id this call produced, so the timeline can offer diff/keep/undo. */
  editId?: number;
  /** For shell (Bash) actions: a risk score when the command is destructive / privileged / touches secrets. */
  risk?: CommandRisk;
  /** The tool_use id (correlates to its tool_result). */
  toolUseId?: string;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** Map a tool name to its coarse category. */
export function categoryOf(tool: string): ActionCategory {
  if (tool.startsWith('mcp__')) return 'mcp';
  if (EDIT_TOOLS.has(tool)) return 'edit';
  switch (tool) {
    case 'Bash':
      return 'exec';
    case 'Read':
    case 'NotebookRead':
      return 'read';
    case 'Grep':
    case 'Glob':
    case 'LS':
      return 'search';
    case 'WebFetch':
    case 'WebSearch':
      return 'web';
    case 'Task':
    case 'Agent':
      return 'agent';
    case 'TodoWrite':
      return 'todo';
    case 'AskUserQuestion':
    case 'ExitPlanMode':
    case 'ToolSearch':
    case 'Skill':
      return 'meta';
    default:
      return 'other';
  }
}

/** Collapse to a single trimmed line so a multi-line command/target renders in one row. */
function oneLine(s: string, max = 300): string {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** Best human-readable "what did this call act on" for a tool_use, plus optional secondary detail. */
export function targetOf(tool: string, input: any): { target: string; detail?: string } {
  const i = input && typeof input === 'object' ? input : {};
  // file_path / notebook_path are unambiguously a file; `path` is NOT (Grep/LS use it for a search dir),
  // so it is handled by the pattern/fallback branches below, not treated as the file target.
  const f = i.file_path || i.notebook_path;
  if (typeof f === 'string' && f) return { target: f, detail: undefined };
  if (tool === 'Bash' && typeof i.command === 'string')
    return { target: oneLine(i.command), detail: typeof i.description === 'string' ? i.description : undefined };
  if ((tool === 'Task' || tool === 'Agent')) {
    const desc = typeof i.description === 'string' ? i.description : typeof i.prompt === 'string' ? oneLine(i.prompt, 120) : '';
    return { target: desc || '(subagent)', detail: typeof i.subagent_type === 'string' ? i.subagent_type : undefined };
  }
  if (typeof i.pattern === 'string') return { target: i.pattern, detail: typeof i.path === 'string' ? i.path : typeof i.glob === 'string' ? i.glob : undefined };
  if (typeof i.url === 'string') return { target: i.url };
  if (typeof i.query === 'string') return { target: oneLine(i.query, 160) };
  if (tool === 'TodoWrite' && Array.isArray(i.todos)) {
    const inProg = i.todos.find((t: any) => t && t.status === 'in_progress');
    const active = inProg && typeof inProg.content === 'string' ? inProg.content : '';
    return { target: active ? oneLine(active, 160) : `${i.todos.length} to-do(s)`, detail: `${i.todos.length} item(s)` };
  }
  if (typeof i.skill === 'string') return { target: i.skill };
  if (tool === 'AskUserQuestion' && Array.isArray(i.questions) && i.questions[0] && typeof i.questions[0].question === 'string')
    return { target: oneLine(i.questions[0].question, 160), detail: i.questions.length > 1 ? `${i.questions.length} questions` : undefined };
  // Fallback: the first non-empty string field, else the tool name.
  for (const [, v] of Object.entries(i)) if (typeof v === 'string' && v.trim()) return { target: oneLine(v, 160) };
  return { target: '' };
}

/** Parse ISO (or epoch) timestamp → ms epoch, 0 when absent/unparseable. */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * Every tool call Claude made this session, in transcript (chronological) order, each correlated with
 * its result (ok/isError) and — for file-edit tools — the store EditRecord it produced. Zero token.
 */
export function parseActions(cwd: string, sessionId: string): ActionRecord[] {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return [];
  let lines: string[];
  try {
    lines = fs.readFileSync(transcript, 'utf8').split('\n');
  } catch {
    return [];
  }

  const actions: ActionRecord[] = [];
  const resultErr = new Map<string, boolean>(); // tool_use_id -> is_error
  let lastReasoning = '';

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = o.message;
    if (!msg || !Array.isArray(msg.content)) continue;

    // A subagent's own tool calls live in separate subagents/*.jsonl files (0.7.0); a legacy transcript
    // that inlines them (isSidechain) would double-count, so skip those here.
    if (o.isSidechain === true) continue;

    if (msg.role === 'user') {
      for (const b of msg.content) {
        if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') resultErr.set(b.tool_use_id, !!b.is_error);
      }
      continue;
    }
    if (msg.role !== 'assistant') continue;

    // Carry the message's reasoning forward (Claude often explains in one message, acts in the next).
    let text = '';
    let think = '';
    for (const b of msg.content) {
      if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text.trim();
      else if (b.type === 'thinking') {
        const th = typeof b.thinking === 'string' ? b.thinking : typeof b.text === 'string' ? b.text : '';
        if (th) think += (think ? '\n' : '') + th.trim();
      }
    }
    const reasoning = text || think;
    if (reasoning) lastReasoning = reasoning;

    const ts = toMs(o.timestamp ?? o.ts);
    for (const b of msg.content) {
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const { target, detail } = targetOf(b.name, b.input);
      // Score the FULL command (not the truncated display target) for shell actions.
      const risk = b.name === 'Bash' && b.input && typeof b.input.command === 'string' ? scoreCommand(b.input.command) : null;
      actions.push({
        ts,
        tool: b.name,
        category: categoryOf(b.name),
        target,
        detail,
        ok: true, // provisional — folded from resultErr below
        isError: false,
        reasoning: lastReasoning || undefined,
        risk: risk ?? undefined,
        toolUseId: typeof b.id === 'string' ? b.id : undefined,
      });
    }
  }

  // Fold in each call's result (transcript-order guarantees the result line came after its tool_use).
  for (const a of actions) {
    if (a.toolUseId && resultErr.has(a.toolUseId)) {
      a.isError = resultErr.get(a.toolUseId)!;
      a.ok = !a.isError;
    }
  }

  linkEditIds(sessionId, actions);
  return actions;
}

/**
 * Attach the store EditRecord id to each file-edit action, per file in order — the same positional
 * correlation observe.ts uses for reasoning. Bash actions are left unlinked (one Bash command can
 * produce many store records; there is no 1:1 mapping to hang on the single Bash row).
 */
function linkEditIds(sessionId: string, actions: ActionRecord[]): void {
  const queues = new Map<string, ActionRecord[]>(); // resolved file path -> its edit actions, in order
  for (const a of actions) {
    if (a.category !== 'edit') continue;
    const key = path.resolve(a.target);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key)!.push(a);
  }
  if (queues.size === 0) return;
  const cursor = new Map<string, number>();
  for (const rec of readLog(sessionId)) {
    if (!EDIT_TOOLS.has(rec.tool)) continue; // only the 4 file tools have a 1:1 transcript tool_use
    const q = queues.get(path.resolve(rec.file));
    if (!q) continue;
    const i = cursor.get(rec.file) ?? 0;
    if (i < q.length) {
      q[i].editId = rec.id;
      cursor.set(rec.file, i + 1);
    }
  }
}

// --- category grouping (the Actions view is grouped by kind; curated by default) ---

/** Display order for the category groups — high-signal kinds first. */
export const CATEGORY_ORDER: ActionCategory[] = ['edit', 'exec', 'web', 'agent', 'mcp', 'todo', 'search', 'read', 'meta', 'other'];

/** Human labels for each category group header. */
export const CATEGORY_LABEL: Record<ActionCategory, string> = {
  edit: 'Edits',
  exec: 'Commands',
  read: 'Reads',
  search: 'Searches',
  web: 'Web',
  agent: 'Subagents',
  todo: 'To-dos',
  mcp: 'MCP',
  meta: 'Meta',
  other: 'Other',
};

/** Shown by default (the rest hide behind "show all"); errors always surface regardless of category. */
export const CURATED_CATEGORIES: ReadonlySet<ActionCategory> = new Set<ActionCategory>(['edit', 'exec', 'web', 'agent', 'mcp', 'todo']);

export interface ActionGroup {
  category: ActionCategory;
  label: string;
  /** Total actions of this kind in the session. */
  count: number;
  /** How many of them errored. */
  errors: number;
  /** The rows to render: the whole category when shown, else only its errored rows (curated mode). */
  actions: ActionRecord[];
}

/**
 * Group actions by category in display order. Curated (default): high-signal categories show in full,
 * noisy ones (reads/searches/meta/other) contribute only their errored rows so a failure is never
 * hidden. `showAll` renders every category in full.
 */
export function buildActionGroups(actions: ActionRecord[], opts?: { showAll?: boolean }): ActionGroup[] {
  const showAll = opts?.showAll ?? false;
  const byCat = new Map<ActionCategory, ActionRecord[]>();
  for (const a of actions) {
    if (!byCat.has(a.category)) byCat.set(a.category, []);
    byCat.get(a.category)!.push(a);
  }
  const groups: ActionGroup[] = [];
  for (const cat of CATEGORY_ORDER) {
    const list = byCat.get(cat);
    if (!list || list.length === 0) continue;
    const errors = list.filter((a) => a.isError).length;
    const curated = showAll || CURATED_CATEGORIES.has(cat);
    const shown = curated ? list : list.filter((a) => a.isError); // noisy category: only failures leak through
    if (shown.length === 0) continue;
    groups.push({ category: cat, label: CATEGORY_LABEL[cat], count: list.length, errors, actions: shown });
  }
  return groups;
}

export interface ActionSummary {
  total: number;
  byCategory: Record<string, number>;
  errors: number;
  firstTs: number;
  lastTs: number;
}

/** Cheap headline counts for the timeline header / status. */
export function summarizeActions(actions: ActionRecord[]): ActionSummary {
  const byCategory: Record<string, number> = {};
  let errors = 0;
  for (const a of actions) {
    byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;
    if (a.isError) errors++;
  }
  const ts = actions.map((a) => a.ts).filter((n) => n > 0);
  return {
    total: actions.length,
    byCategory,
    errors,
    firstTs: ts.length ? Math.min(...ts) : 0,
    lastTs: ts.length ? Math.max(...ts) : 0,
  };
}
