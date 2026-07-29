/**
 * Prompts (zero-token): the session broken into what the USER actually asked for.
 *
 * Every other axis in this product organizes work the way the agent saw it — rollups come from
 * files, folders, tasks, subagents and workflow runs. None of them
 * answer the question a person actually has: *what happened when I asked for X?* A long session is a
 * conversation, and the honest unit of that conversation is the user's turn.
 *
 * A prompt owns everything that happened between it and the next one: the edits committed, the tool
 * calls made, the subagents and workflow runs spawned, the background shells started, the compactions
 * suffered. Attribution is by START time, not completion — a shell launched by prompt #4 belongs to #4
 * even when it exits during #7, because #4 is what caused it. Attributing by completion would credit
 * whatever you happened to be typing when a job finished.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { findTranscript } from './observe';
import { parseActions } from './actions';
import { parseWorkflows } from './workflows';
import { reviewEdits } from './groups';
import { lineDelta } from './format';
import { cachedByFiles } from './fscache';
import { logPath } from './store';
import { taskIdForSubject, taskNamings } from './tasks';

export interface SessionPrompt {
  /** Stable id (content+time hash) — safe to key UI state and review ops on. */
  id: string;
  /** 1-based chronological position, the way a person counts their own turns. */
  index: number;
  /** When it was asked (ms epoch). */
  ts: number;
  /** When the NEXT prompt arrived; 0 while this is still the current one. */
  endTs: number;
  /** The prompt itself, whitespace-collapsed. */
  text: string;
  /** First line, capped — what a row shows. */
  title: string;
  /** Store edit ids committed in this window, in capture order. */
  editIds: number[];
  edits: number;
  added: number;
  removed: number;
  pending: number;
  kept: number;
  undone: number;
  /** Distinct files and folders those edits touched. */
  files: number;
  folders: number;
  /** Main-chain assistant tokens spent answering this ask (input + output + cache, deduped by message
   *  id) — the same total the Stats panel sums, attributed to the window it fell in. */
  tokens: number;
  /** Distinct to-dos this prompt WORKED, keyed by the same content digest tasks use everywhere, so an
   *  item planned both ways counts once. Evidence of work is a TodoWrite item marked in progress or a
   *  TaskUpdate naming the task; writing a plan (TaskCreate) is not. Two limits follow from reading
   *  actions rather than plan snapshots: a TodoWrite that only marks its last item complete leaves no
   *  in-progress item to name, and a TaskUpdate that edits a description counts like one that moves the
   *  task. Both err toward the plan's current state, and neither invents a task that was never named. */
  tasks: number;
  /** Tool calls made while answering, and how many reported an error. */
  actions: number;
  errors: number;
  /** Subagents spawned by this prompt (by spawn time). */
  agents: string[];
  /** Workflow runs started by this prompt. */
  workflows: string[];
  /** Background shells started by this prompt — they often outlive it. */
  processes: string[];
  /** Context compactions that happened while answering. */
  compactions: number;
  /** Wall-clock from the ask to the next one (or to the last thing that happened, if it is current). */
  durationMs: number;
}

/** Stable per-prompt id: the ask's time plus its opening words. */
function promptId(ts: number, text: string): string {
  // The separator is a literal NUL by ESCAPE, never a raw byte: a raw one makes this a "binary" file
  // to git, ripgrep and every review tool, which hides the diff of the module they most need to read.
  return crypto.createHash('sha256').update(`${ts}\u0000${text.slice(0, 200)}`).digest('hex').slice(0, 12);
}

/**
 * Is this transcript record a REAL user prompt?
 *
 * The transcript is full of records that wear the user's role without being anything the user typed:
 * tool results, `<command-name>` / `<local-command-stdout>` wrappers from slash commands, injected
 * system reminders, the synthesized summary after a compaction, and the harness's own queue records.
 * Counting any of them would invent turns the person never took.
 */
function userPrompt(o: any): string | null {
  if (!o || o.isSidechain === true || o.isCompactSummary === true || o.isMeta === true) return null;
  const msg = o.message;
  if (!msg || msg.role !== 'user') return null;
  let text: string | null = null;
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    // A turn made only of tool_results is the harness answering the agent, not a person speaking.
    const block = msg.content.find((b: any) => b && b.type === 'text' && typeof b.text === 'string');
    if (!block) return null;
    text = block.text;
  }
  const clean = (text ?? '').trim();
  if (!clean) return null;
  // `<command-name>`, `<local-command-stdout>`, `<system-reminder>`, `<task-notification>` … all open
  // with a tag; "Caveat:" is the harness's own preamble to a command's output.
  if (clean.startsWith('<') || /^caveat:/i.test(clean)) return null;
  return clean.replace(/\s+/g, ' ');
}

/** A finite number, or 0 — for token-usage fields that may be absent/malformed. */
function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** ISO/epoch → ms epoch, 0 when absent. */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/**
 * The session as a list of the user's asks, each carrying what it produced. Memoized against the
 * transcript AND the store log, since both feed it.
 */
/** One row of the prompt AXIS: an ask's window plus its DISPLAY-unit edit ids and pending count. */
export interface PromptWindow {
  id: string;
  index: number;
  ts: number;
  title: string;
  editIds: number[];
  pending: number;
}

/**
 * The prompt-axis slice of a session — what the status bar and the nav bar's Prompt group step over.
 *
 * `sessionPrompts` computes far more than the axis reads: a lineDelta per display record, transcript-wide
 * action/task/agent attribution, token windows. The axis needs the windows, their edit ids and which are
 * pending — and it asks on EVERY refresh and every keep click. The asks come from the transcript-keyed
 * `askScan`, so a log-only change (a keep) re-pays only reviewEdits + a binary-search ownership pass,
 * never a transcript read.
 */
export function promptWindows(cwd: string, sessionId: string): PromptWindow[] {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return [];
  return cachedByFiles('promptWindows', [transcript, logPath(sessionId)], () => {
    const { asks } = askScan(transcript);
    if (!asks.length) return [];
    const reqs: PromptWindow[] = asks.map((a, i) => ({
      id: promptId(a.ts, a.text),
      index: i + 1,
      ts: a.ts,
      title: a.text.length > 96 ? a.text.slice(0, 95) + '…' : a.text,
      editIds: [],
      pending: 0,
    }));
    // Same ownership rule as sessionPrompts: an edit belongs to the ask whose window its ts falls in.
    const owner = (ts: number): PromptWindow | null => {
      if (!ts || ts < reqs[0].ts) return null;
      let lo = 0;
      let hi = reqs.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (reqs[mid].ts <= ts) lo = mid;
        else hi = mid - 1;
      }
      return reqs[lo];
    };
    for (const rec of reviewEdits(sessionId)) {
      const r = owner(rec.ts);
      if (!r) continue;
      r.editIds.push(rec.id);
      if (rec.status === 'pending') r.pending++;
    }
    return reqs;
  });
}

export function sessionPrompts(cwd: string, sessionId: string): SessionPrompt[] {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return [];
  return cachedByFiles('sessionPrompts', [transcript, logPath(sessionId)], () =>
    sessionPromptsUncached(transcript, cwd, sessionId)
  );
}

/** Phase 1 of sessionPrompts — the asks and the per-moment assistant token usage — memoized on the
 *  TRANSCRIPT alone. Everything else the prompt views derive is keyed on the log too, so before this
 *  split a keep click (a log-only change) re-read and re-parsed the whole transcript to recover facts
 *  that had not moved: ~60ms per click at 10MB, growing linearly with the conversation. */
function askScan(transcript: string): { asks: { ts: number; text: string }[]; tokenAt: { ts: number; tokens: number }[] } {
  return cachedByFiles('promptAsks', [transcript], () => {
    let lines: string[];
    try {
      lines = fs.readFileSync(transcript, 'utf8').split('\n');
    } catch {
      return { asks: [], tokenAt: [] };
    }
    // The asks themselves — and, in the SAME pass, the assistant token usage per moment (this file is
    // already fully read, so tokens cost no extra IO). One assistant message can span several lines
    // that share a message.id and repeat the usage; count each id once, exactly as the Stats cursor does.
    const asks: { ts: number; text: string }[] = [];
    const tokenAt: { ts: number; tokens: number }[] = [];
    const seenMsg = new Set<string>();
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
      if (msg && msg.role === 'assistant' && o.isSidechain !== true && msg.usage && typeof msg.id === 'string' && !seenMsg.has(msg.id)) {
        seenMsg.add(msg.id);
        const u = msg.usage;
        const tk = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
        const ts = toMs(o.timestamp ?? o.ts);
        if (ts && tk) tokenAt.push({ ts, tokens: tk });
      }
      const text = userPrompt(o);
      if (text === null) continue;
      const ts = toMs(o.timestamp ?? o.ts);
      if (!ts) continue; // an undated ask cannot own a window
      asks.push({ ts, text });
    }
    asks.sort((a, b) => a.ts - b.ts);
    return { asks, tokenAt };
  });
}

function sessionPromptsUncached(transcript: string, cwd: string, sessionId: string): SessionPrompt[] {
  const { asks, tokenAt } = askScan(transcript);
  if (!asks.length) return [];

  const reqs: SessionPrompt[] = asks.map((a, i) => ({
    id: promptId(a.ts, a.text),
    index: i + 1,
    ts: a.ts,
    endTs: i + 1 < asks.length ? asks[i + 1].ts : 0,
    text: a.text,
    title: a.text.length > 96 ? a.text.slice(0, 95) + '…' : a.text,
    editIds: [],
    edits: 0,
    added: 0,
    removed: 0,
    pending: 0,
    kept: 0,
    undone: 0,
    files: 0,
    folders: 0,
    tokens: 0,
    tasks: 0,
    actions: 0,
    errors: 0,
    agents: [],
    workflows: [],
    processes: [],
    compactions: 0,
    durationMs: 0,
  }));

  /** Which prompt owned a given moment. Binary search over the ask times. */
  const owner = (ts: number): SessionPrompt | null => {
    if (!ts || ts < reqs[0].ts) return null; // before the first ask — setup, not an answer to anything
    let lo = 0;
    let hi = reqs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (reqs[mid].ts <= ts) lo = mid;
      else hi = mid - 1;
    }
    return reqs[lo];
  };

  // 2. the work, attributed by when it STARTED
  const filesByReq = new Map<string, Set<string>>();
  const foldersByReq = new Map<string, Set<string>>();
  const tasksByReq = new Map<string, Set<string>>();
  // A TaskUpdate names its task by display number alone, so the number has to be resolved to a subject.
  // Resolve it AS OF the update: the namings timeline is append-only, so a task renamed (or deleted)
  // later cannot rewrite what an earlier prompt was credited with.
  const namings = transcript ? taskNamings(transcript) : [];
  const subjectAt = (taskId: string, ts: number): string | null => {
    let found: string | null = null;
    for (const n of namings) {
      if (n.id !== taskId) continue;
      if (n.ts > ts && found !== null) break; // later renames belong to later moments
      found = n.subject;
      if (n.ts > ts) break; // the first naming can post-date a 0-timestamp update — take it, then stop
    }
    return found;
  };
  /** A status that is evidence of WORK. An update carrying only a new description moves nothing. */
  const WORKED = new Set(['in_progress', 'completed', 'done']);
  const bump = (m: Map<string, Set<string>>, id: string, v: string) => {
    let s = m.get(id);
    if (!s) m.set(id, (s = new Set()));
    s.add(v);
  };
  // DISPLAY units: an ask's rollup must not count records the change map collapsed away.
  for (const rec of reviewEdits(sessionId)) {
    const r = owner(rec.ts);
    if (!r) continue;
    r.editIds.push(rec.id);
    r.edits++;
    const d = lineDelta(sessionId, rec);
    r.added += d.added;
    r.removed += d.removed;
    if (rec.status === 'pending') r.pending++;
    else if (rec.status === 'kept') r.kept++;
    else if (rec.status === 'undone') r.undone++;
    if (rec.file) {
      bump(filesByReq, r.id, rec.file);
      bump(foldersByReq, r.id, path.dirname(rec.file));
    }
  }

  // Workflow runs are attributed by when the run STARTED, from the run model itself — the `Workflow`
  // tool call alone would only give a spawn id, and a run's identity is its wf_<id>.
  for (const w of parseWorkflows(cwd, sessionId)) {
    const r = owner(w.startedTs || w.lastActivityMs);
    if (r) r.workflows.push(w.id);
  }

  let lastTs = 0;
  for (const a of parseActions(cwd, sessionId)) {
    if (a.ts > lastTs) lastTs = a.ts;
    const r = owner(a.ts);
    if (!r) continue;
    r.actions++;
    if (a.isError) r.errors++;
    if (a.compact) r.compactions++;
    if (a.category === 'agent' && a.toolUseId) r.agents.push(a.toolUseId);
    // A backgrounded shell is a Bash call the harness kept running; its id arrives with the result, so
    // the spawn is what we can attribute here — which is the correct owner anyway.
    if (a.category === 'exec' && a.toolUseId && /run_in_background/.test(a.detail ?? '')) r.processes.push(a.toolUseId);
    // A to-do this action names as in progress (actionTarget puts the active item's content there) —
    // the distinct set is "tasks worked on" for this prompt. The fallback string "N to-do(s)" (nothing
    // was in progress) is not a task, so it is excluded. Identity is the SAME content digest tasks are
    // keyed by everywhere else, so a session that plans twice — a TodoWrite and a TaskCreate naming the
    // same item — counts one task here, exactly as the change map does.
    // Tasks WORKED, not tasks named — read from the call's own plan facts, never from `target`, which
    // is a display string clipped at 160 characters. A TodoWrite names its in-progress item outright; a
    // TaskUpdate names a number and a status, so the number is resolved to the subject it stood for at
    // that moment and only a status that means work counts. TaskCreate is deliberately NOT counted:
    // writing a plan is not doing it. Everything is keyed by the same content digest tasks use
    // everywhere, so an item planned both ways counts once.
    if (a.category === 'todo' && a.plan) {
      if (a.tool === 'TodoWrite' && a.plan.subject) {
        bump(tasksByReq, r.id, taskIdForSubject(a.plan.subject));
      } else if (a.tool === 'TaskUpdate' && a.plan.taskId && a.plan.status && WORKED.has(a.plan.status)) {
        const subject = a.plan.subject ?? subjectAt(a.plan.taskId, a.ts);
        if (subject) bump(tasksByReq, r.id, taskIdForSubject(subject)); // unanchorable → not guessed
      }
    }
  }

  // Tokens: attribute each assistant message's usage to the ask whose window it fell in.
  for (const ev of tokenAt) {
    const r = owner(ev.ts);
    if (r) r.tokens += ev.tokens;
  }

  for (const r of reqs) {
    r.files = filesByReq.get(r.id)?.size ?? 0;
    r.folders = foldersByReq.get(r.id)?.size ?? 0;
    r.tasks = tasksByReq.get(r.id)?.size ?? 0;
    const end = r.endTs || Math.max(lastTs, r.ts);
    r.durationMs = Math.max(0, end - r.ts);
  }
  return reqs;
}

/** The store edit ids a prompt produced — the review scope for "accept everything I asked for here". */
export function promptEditIds(cwd: string, sessionId: string, promptId: string): number[] {
  const r = sessionPrompts(cwd, sessionId).find((x) => x.id === promptId || String(x.index) === promptId);
  return r ? r.editIds.slice() : [];
}

/** Claude's own prose in reply to one ask — the assistant TEXT it wrote while answering, its tool calls
 *  stripped out, so a reader gets the narrative (the plan, the explanations, the summary) not the
 *  mechanics. Lazily fetched: it can be large, so it never rides the Prompts list payload. */
export interface PromptResponse {
  promptId: string;
  index: number;
  /** The concatenated assistant text, turns separated by a blank line, capped at [RESPONSE_CAP]. */
  text: string;
  /** How many assistant text turns were joined. */
  turns: number;
  /** Total bytes of prose before the cap. */
  bytes: number;
  /** Bytes past the cap that are not shown (0 when the whole response fits). */
  truncated: number;
}

/** A response can be enormous (hundreds of turns of prose); keep it reviewable, and say when clipped. */
const RESPONSE_CAP = 200_000;

/**
 * Claude's response to one ask, assembled from the main-chain assistant TEXT blocks whose timestamp
 * falls in that ask's window. Sidechains (subagents) are excluded — they are their own conversation —
 * and tool_use / tool_result blocks are skipped, leaving the prose a person actually reads. Memoized
 * against the transcript, so re-expanding a row is free. Null when the ask (or transcript) is unknown.
 */
export function promptResponse(cwd: string, sessionId: string, promptId: string): PromptResponse | null {
  const reqs = sessionPrompts(cwd, sessionId);
  const r = reqs.find((x) => x.id === promptId || String(x.index) === promptId);
  if (!r) return null;
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return null;
  return cachedByFiles(`promptResponse:${r.id}`, [transcript], () => buildResponse(transcript, r));
}

function buildResponse(transcript: string, r: SessionPrompt): PromptResponse {
  const end = r.endTs || Number.MAX_SAFE_INTEGER;
  let lines: string[];
  try {
    lines = fs.readFileSync(transcript, 'utf8').split('\n');
  } catch {
    return { promptId: r.id, index: r.index, text: '', turns: 0, bytes: 0, truncated: 0 };
  }
  const segments: string[] = [];
  const seen = new Set<string>(); // an assistant message split across lines shares message.id — join once
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
    if (!msg || msg.role !== 'assistant' || o.isSidechain === true) continue;
    const ts = toMs(o.timestamp ?? o.ts);
    if (!ts || ts < r.ts || ts >= end) continue; // outside this ask's window
    if (typeof msg.id === 'string') {
      if (seen.has(msg.id)) continue;
      seen.add(msg.id);
    }
    // The prose only: text blocks, in order; skip tool_use / tool_result / thinking.
    const parts: string[] = [];
    if (typeof msg.content === 'string') parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const b of msg.content) if (b && b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    }
    const seg = parts.join('\n').trim();
    if (seg) segments.push(seg);
  }
  const full = segments.join('\n\n');
  const bytes = Buffer.byteLength(full, 'utf8');
  const text = full.length > RESPONSE_CAP ? full.slice(0, RESPONSE_CAP) : full;
  return {
    promptId: r.id,
    index: r.index,
    text,
    turns: segments.length,
    bytes,
    truncated: Math.max(0, bytes - Buffer.byteLength(text, 'utf8')),
  };
}

/** Headline for the Prompts window. */
export function summarizePrompts(reqs: SessionPrompt[]): { total: number; withEdits: number; edits: number } {
  return {
    total: reqs.length,
    withEdits: reqs.filter((r) => r.edits > 0).length,
    edits: reqs.reduce((n, r) => n + r.edits, 0),
  };
}
