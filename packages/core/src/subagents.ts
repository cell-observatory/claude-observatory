/**
 * Subagent tracking (zero-token): the nested action timeline of every subagent Claude spawned this
 * session. Current Claude Code writes each subagent's turns to its OWN transcript at
 * ~/.claude/projects/<proj>/<session>/subagents/agent-<agentId>.jsonl (self-describing: `agentId`,
 * `sessionId` = parent, `isSidechain: true`) — so a subagent's work is invisible in the main-chain
 * transcript the rest of the observatory parses.
 *
 * This reads those files with the SAME action parser the main session uses (parseTranscriptActions),
 * and correlates each one back to the `Agent`/`Task` tool_use that spawned it via the spawn's
 * tool_result `toolUseResult` block — which conveniently also carries per-subagent metrics
 * (totalDurationMs / totalTokens / totalToolUseCount) straight from Claude Code. No model calls.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findTranscript } from './observe';
import { cachedByFiles } from './fscache';
import { parseTranscriptActions, ActionRecord, ActionSummary, summarizeActions, agentPhaseDetail, Phase, PhaseConfidence, attributeEditIds, EditAttributionAuthor } from './actions';

/** Spawn + result metadata for one subagent, mined from the parent transcript's Agent/Task result. */
interface SubagentMeta {
  agentType?: string; // e.g. "code-reviewer" (toolUseResult.agentType, else the spawn's subagent_type)
  description?: string; // the spawn's short description (input.description)
  status?: string; // "completed" | … (toolUseResult.status)
  durationMs?: number; // toolUseResult.totalDurationMs — wall-clock the subagent ran
  tokens?: number; // toolUseResult.totalTokens
  toolUseCount?: number; // toolUseResult.totalToolUseCount
  ts: number; // spawn time (the Agent/Task tool_use's ms epoch)
  toolUseId?: string; // the spawning Agent/Task tool_use id
}

export interface SubagentInfo {
  /** The subagent's own id (from the agent-<id>.jsonl filename / its records). */
  agentId: string;
  agentType?: string;
  description?: string;
  status?: string;
  /** Spawn time (ms epoch), or the first subagent line when the spawn couldn't be correlated. */
  ts: number;
  durationMs?: number;
  tokens?: number;
  toolUseCount?: number;
  toolUseId?: string;
  /** Nesting depth in the agent tree, from the agent-<id>.meta.json sidecar (undefined when no sidecar). */
  spawnDepth?: number;
  /** The subagent's own typed action stream (reads, edits, bash, web, nested spawns…). */
  actions: ActionRecord[];
  /** How many of those actions edited a file. */
  edits: number;
  /** Headline counts for the subagent's actions (total / byCategory / errors). */
  summary: ActionSummary;
  /** Live phase from a bounded tail read of the subagent's OWN transcript — so an async_launched
   *  subagent (null status, never transitions) still shows what it's doing now, not a stuck status. */
  phase: Phase;
  /** 'high' = structural; 'heuristic' = staleness-inferred (awaiting-permission/idle/done have no
   *  transcript marker). Renderers dim/qualify heuristic phases instead of asserting them as truth. */
  phaseConfidence: PhaseConfidence;
  /** True while the subagent is still active (phase working/awaiting-*), false once idle/done/errored. */
  running: boolean;
  /** The subagent's latest TodoWrite (its own plan). */
  todos: { content: string; status: string }[];
  /** The todo the subagent is currently on (in_progress); null when none is — honest, never guessed. */
  currentTask: string | null;
}

/** Fields from an `agent-<id>.meta.json` sidecar (Claude Code 2.1.20x) — a label source when the parent
 *  transcript's spawn/result can't be correlated (async_launched subagents often have no result). */
interface SubagentSidecar {
  agentType?: string;
  description?: string;
  spawnDepth?: number;
  toolUseId?: string;
}

/** Read an `agent-<id>.meta.json` sidecar, or null when absent/unparseable (the parent meta still applies). */
function readSidecar(metaPath: string): SubagentSidecar | null {
  let o: any;
  try {
    o = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  return {
    agentType: typeof o.agentType === 'string' ? o.agentType : undefined,
    description: typeof o.description === 'string' ? o.description : undefined,
    spawnDepth: typeof o.spawnDepth === 'number' && isFinite(o.spawnDepth) ? o.spawnDepth : undefined,
    toolUseId: typeof o.toolUseId === 'string' ? o.toolUseId : undefined,
  };
}

export interface SubagentTodos {
  todos: { content: string; status: string }[];
  /** The todo currently in_progress; null when none is (honest — never falls back to a guess). */
  currentTask: string | null;
}

/** Extract the latest non-empty TodoWrite (the subagent's own plan) from an agent-<id>.jsonl. */
function todosFromTranscript(agentTranscriptPath: string): SubagentTodos {
  let lines: string[];
  try {
    lines = fs.readFileSync(agentTranscriptPath, 'utf8').split('\n');
  } catch {
    return { todos: [], currentTask: null };
  }
  let todos: { content: string; status: string }[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const msg = o && o.message;
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b && b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
        const list = b.input.todos
          .filter((td: any) => td && typeof td.content === 'string')
          .map((td: any) => ({ content: String(td.content).trim(), status: String(td.status || '') }));
        if (list.length) todos = list; // latest non-empty list supersedes (same rule as transcriptInsights)
      }
    }
  }
  const inProg = todos.find((td) => td.status === 'in_progress');
  return { todos, currentTask: inProg ? inProg.content : null };
}

/**
 * A subagent's latest TodoWrite (its own plan) + the todo it's currently on. `transcriptInsights` is
 * main-chain only; this reads the subagent's OWN agent-<id>.jsonl. Empty when the subagent has no file.
 */
export function subagentTodos(cwd: string, sessionId: string, agentId: string): SubagentTodos {
  const dir = findSubagentsDir(cwd, sessionId);
  if (!dir) return { todos: [], currentTask: null };
  return todosFromTranscript(path.join(dir, `agent-${agentId}.jsonl`));
}

/** Parse ISO/epoch timestamp → ms epoch, 0 when absent. (Local copy so subagents.ts stays standalone.) */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

function fin(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined;
}

/** The subagents/ dir for a session, or null. Derived from the main transcript's project dir:
 *  <proj>/<session>.jsonl  ⇒  <proj>/<session>/subagents/. */
export function findSubagentsDir(cwd: string, sessionId: string): string | null {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return null;
  const dir = path.join(path.dirname(transcript), sessionId, 'subagents');
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** Map agentId → its spawn + result metadata, from a single pass over the parent transcript. */
function subagentMeta(transcriptPath: string): Map<string, SubagentMeta> {
  // Memoized per (mtime,size) — the parent transcript is multi-MB and every subagent view re-mines it.
  return cachedByFiles('subagentMeta', [transcriptPath], () => subagentMetaUncached(transcriptPath));
}

function subagentMetaUncached(transcriptPath: string): Map<string, SubagentMeta> {
  const out = new Map<string, SubagentMeta>();
  let lines: string[];
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return out;
  }
  const spawns = new Map<string, { description?: string; subagentType?: string; ts: number }>(); // toolUseId → spawn
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    const ts = toMs(o.timestamp ?? o.ts);
    const content = o.message && Array.isArray(o.message.content) ? o.message.content : [];
    // Record every Agent/Task spawn so its description/type can be attached once the result names the agentId.
    for (const b of content) {
      if (b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string') {
        const i = b.input && typeof b.input === 'object' ? b.input : {};
        spawns.set(b.id, {
          description: typeof i.description === 'string' ? i.description : undefined,
          subagentType: typeof i.subagent_type === 'string' ? i.subagent_type : undefined,
          ts,
        });
      }
    }
    // The tool_result for a spawn carries a `toolUseResult` object naming the agentId + its metrics.
    const tur = o.toolUseResult;
    if (tur && typeof tur === 'object' && typeof tur.agentId === 'string') {
      let toolUseId: string | undefined;
      for (const b of content) if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string') toolUseId = b.tool_use_id;
      const spawn = toolUseId ? spawns.get(toolUseId) : undefined;
      out.set(tur.agentId, {
        agentType: typeof tur.agentType === 'string' ? tur.agentType : spawn?.subagentType,
        description: spawn?.description,
        status: typeof tur.status === 'string' ? tur.status : undefined,
        durationMs: fin(tur.totalDurationMs),
        tokens: fin(tur.totalTokens),
        toolUseCount: fin(tur.totalToolUseCount),
        ts: spawn?.ts ?? ts,
        toolUseId,
      });
    }
  }
  return out;
}

/**
 * Every subagent spawned in this session, each with its own action timeline + metrics, spawn-time
 * ordered. Empty when the session has no subagents/ dir (no subagents ran). Zero token.
 */
export function parseSubagents(cwd: string, sessionId: string): SubagentInfo[] {
  const dir = findSubagentsDir(cwd, sessionId);
  if (!dir) return [];
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('agent-') && f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const transcript = findTranscript(cwd, sessionId);
  const meta = transcript ? subagentMeta(transcript) : new Map<string, SubagentMeta>();
  const out: SubagentInfo[] = [];
  for (const f of files) {
    const agentId = f.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    const jsonlPath = path.join(dir, f);
    const actions = parseTranscriptActions(jsonlPath, { includeSidechain: true });
    const m = meta.get(agentId);
    const sidecar = readSidecar(path.join(dir, `agent-${agentId}.meta.json`)); // fills gaps the parent lacks
    const { todos, currentTask } = todosFromTranscript(jsonlPath);
    // Live tail read — async_launched subagents have no status to trust. Detail (not the bare label) so
    // consumers can tell a structural phase from a staleness heuristic instead of asserting it as truth.
    const { phase, confidence } = agentPhaseDetail(jsonlPath);
    const firstTs = actions.find((a) => a.ts > 0)?.ts ?? 0;
    out.push({
      agentId,
      agentType: m?.agentType ?? sidecar?.agentType,
      description: m?.description ?? sidecar?.description,
      status: m?.status,
      ts: m?.ts || firstTs,
      durationMs: m?.durationMs,
      tokens: m?.tokens,
      toolUseCount: m?.toolUseCount,
      toolUseId: m?.toolUseId ?? sidecar?.toolUseId,
      spawnDepth: sidecar?.spawnDepth,
      actions,
      edits: actions.filter((a) => a.category === 'edit').length,
      summary: summarizeActions(actions),
      phase,
      phaseConfidence: confidence,
      running: phase === 'working' || phase === 'awaiting-input' || phase === 'awaiting-permission',
      todos,
      currentTask,
    });
  }
  // §6: honestly attribute store edit ids across the main chain + every subagent (ts-window
  // partitioned; interleaved same-file overlaps stay unassigned, never cross-attributed). Mutates each
  // subagent's actions' editId in place — so SubagentInfo.actions now carries the attributed editIds
  // (previously a no-op: parseTranscriptActions never linked, so every subagent editId was undefined).
  const mainActions = transcript ? parseTranscriptActions(transcript, { includeSidechain: false }) : [];
  const authors: EditAttributionAuthor[] = [
    { agentId: null, edits: mainActions },
    ...out.map((s) => ({ agentId: s.agentId, edits: s.actions })),
  ];
  attributeEditIds(sessionId, authors);
  // Spawn order (a subagent with no correlated spawn ts sinks last, which is fine — it's the exception).
  out.sort((a, b) => a.ts - b.ts || a.agentId.localeCompare(b.agentId));
  return out;
}

export interface SubagentsSummary {
  count: number;
  totalActions: number;
  totalEdits: number;
  totalDurationMs: number;
  totalTokens: number;
  errors: number;
}

/** Headline rollup across all subagents (for the Actions "Subagents" group header + `metrics`). */
export function summarizeSubagents(subs: SubagentInfo[]): SubagentsSummary {
  return {
    count: subs.length,
    totalActions: subs.reduce((n, s) => n + s.summary.total, 0),
    totalEdits: subs.reduce((n, s) => n + s.edits, 0),
    totalDurationMs: subs.reduce((n, s) => n + (s.durationMs ?? 0), 0),
    totalTokens: subs.reduce((n, s) => n + (s.tokens ?? 0), 0),
    errors: subs.reduce((n, s) => n + s.summary.errors, 0),
  };
}
