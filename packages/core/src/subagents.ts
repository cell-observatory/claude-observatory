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
import { parseTranscriptActions, ActionRecord, ActionSummary, summarizeActions } from './actions';

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
  /** The subagent's own typed action stream (reads, edits, bash, web, nested spawns…). */
  actions: ActionRecord[];
  /** How many of those actions edited a file. */
  edits: number;
  /** Headline counts for the subagent's actions (total / byCategory / errors). */
  summary: ActionSummary;
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
    const actions = parseTranscriptActions(path.join(dir, f), { includeSidechain: true });
    const m = meta.get(agentId);
    const firstTs = actions.find((a) => a.ts > 0)?.ts ?? 0;
    out.push({
      agentId,
      agentType: m?.agentType,
      description: m?.description,
      status: m?.status,
      ts: m?.ts || firstTs,
      durationMs: m?.durationMs,
      tokens: m?.tokens,
      toolUseCount: m?.toolUseCount,
      toolUseId: m?.toolUseId,
      actions,
      edits: actions.filter((a) => a.category === 'edit').length,
      summary: summarizeActions(actions),
    });
  }
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
