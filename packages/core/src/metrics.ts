/**
 * Session metrics (zero-token): high-signal numbers rolled up from what the observatory already
 * parses — per-edit diff stats (±lines), action counts, per-subagent duration/tokens, and tool
 * latency (the gap between each tool_use and its tool_result, straight from transcript timestamps).
 *
 * Everything here is derived, never stored: edits from the store (lineDelta), actions from the action
 * timeline, subagents from their transcripts, latency from the main transcript. No model calls.
 */
import * as fs from 'fs';
import { readLog, maxOf } from './store';
import { lineDelta } from './format';
import { findTranscript } from './observe';
import { parseActions, summarizeActions } from './actions';
import { parseSubagents, summarizeSubagents, SubagentsSummary } from './subagents';
import { cachedByFiles } from './fscache';

export interface EditMetrics {
  count: number;
  added: number; // total lines added across all captured edits
  removed: number; // total lines removed
  pending: number;
  kept: number;
  undone: number;
}

export interface LatencyMetrics {
  count: number; // tool calls with a measurable latency
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

export interface SessionMetrics {
  session: string;
  /** Wall-clock span of the session's actions (lastTs − firstTs), ms. */
  spanMs: number;
  actions: { total: number; errors: number; byCategory: Record<string, number> };
  edits: EditMetrics;
  subagents: SubagentsSummary;
  /** Per tool_use→tool_result gap: how long Claude's tools took this session. */
  toolLatency: LatencyMetrics;
}

/** Nearest-rank percentile of an unsorted numeric array (0 for empty). p in [0,1]. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/** Parse ISO/epoch → ms epoch, 0 when absent. */
function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Usage fields must be finite numbers — a malformed line must not poison the sum (a string would turn
 *  the next `+=` into concatenation). */
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

/**
 * Session-total usage from one light transcript pass — the per-sibling numbers the Fleet view shows
 * alongside Workflows. `tokens` = input+cache+output summed across the session's main-chain assistant
 * messages (deduped by message id, the same formula Stats/Workflows use, so a multi-block message isn't
 * multiplied); `durationMs` = wall-clock span of the transcript (last − first timestamp over every
 * timestamped line). Both 0 when the transcript is absent/unreadable. Cheap enough to call per fleet
 * sibling on the slow tier. Zero token, no model calls.
 */
export function sessionUsage(cwd: string, sessionId: string): { tokens: number; durationMs: number } {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return { tokens: 0, durationMs: 0 };
  // Memoized per (mtime,size) — the fleet views ask per sibling per refresh. Read-only result.
  return cachedByFiles('sessionUsage', [transcript], () => sessionUsageUncached(transcript));
}

function sessionUsageUncached(transcript: string): { tokens: number; durationMs: number } {
  let lines: string[];
  try {
    lines = fs.readFileSync(transcript, 'utf8').split('\n');
  } catch {
    return { tokens: 0, durationMs: 0 };
  }
  let tokens = 0;
  let firstTs = 0;
  let lastTs = 0;
  const seen = new Set<string>();
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
    if (ts > 0) {
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
    }
    const m = o.message;
    if (!m || m.role !== 'assistant' || o.isSidechain === true) continue; // main-chain assistant turns only
    // One assistant message is split across lines sharing message.id + identical usage — count each id once.
    const id = typeof m.id === 'string' ? m.id : null;
    if (id !== null && seen.has(id)) continue;
    if (id !== null) seen.add(id);
    const u = m.usage || {};
    tokens += num(u.output_tokens) + num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  }
  return { tokens, durationMs: firstTs && lastTs ? Math.max(0, lastTs - firstTs) : 0 };
}

/** Tool-call latencies (ms) = each tool_result timestamp − its tool_use timestamp, matched by id. */
function toolLatencies(transcriptPath: string): number[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return [];
  }
  const useTs = new Map<string, number>(); // tool_use_id → tool_use ts
  const out: number[] = [];
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
    const ts = toMs(o.timestamp ?? o.ts);
    for (const b of msg.content) {
      if (b && b.type === 'tool_use' && typeof b.id === 'string' && ts > 0) useTs.set(b.id, ts);
      else if (b && b.type === 'tool_result' && typeof b.tool_use_id === 'string' && ts > 0) {
        const started = useTs.get(b.tool_use_id);
        if (started && ts >= started) out.push(ts - started);
      }
    }
  }
  return out;
}

/** Roll up the session's metrics. `cwd` locates the transcript; falls back gracefully when absent. */
export function sessionMetrics(cwd: string, sessionId: string): SessionMetrics {
  const log = readLog(sessionId);
  const edits: EditMetrics = { count: log.length, added: 0, removed: 0, pending: 0, kept: 0, undone: 0 };
  for (const r of log) {
    const d = lineDelta(sessionId, r);
    edits.added += d.added;
    edits.removed += d.removed;
    if (r.status === 'kept') edits.kept++;
    else if (r.status === 'undone') edits.undone++;
    else edits.pending++;
  }

  const actions = parseActions(cwd, sessionId);
  const aSum = summarizeActions(actions);
  const subs = summarizeSubagents(parseSubagents(cwd, sessionId));

  const transcript = findTranscript(cwd, sessionId);
  const lat = transcript ? toolLatencies(transcript) : [];
  const toolLatency: LatencyMetrics = {
    count: lat.length,
    medianMs: Math.round(percentile(lat, 0.5)),
    p95Ms: Math.round(percentile(lat, 0.95)),
    maxMs: lat.length ? maxOf(lat) : 0,
  };

  return {
    session: sessionId,
    spanMs: aSum.lastTs && aSum.firstTs ? Math.max(0, aSum.lastTs - aSum.firstTs) : 0,
    actions: { total: aSum.total, errors: aSum.errors, byCategory: aSum.byCategory },
    edits,
    subagents: subs,
    toolLatency,
  };
}

export type { SubagentsSummary };
