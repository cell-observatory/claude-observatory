/**
 * Session metrics (zero-token): high-signal numbers rolled up from what the observatory already
 * parses — per-edit diff stats (±lines), action counts, per-subagent duration/tokens, and tool
 * latency (the gap between each tool_use and its tool_result, straight from transcript timestamps).
 *
 * Everything here is derived, never stored: edits from the store (lineDelta), actions from the action
 * timeline, subagents from their transcripts, latency from the main transcript. No model calls.
 */
import * as fs from 'fs';
import { readLog } from './store';
import { lineDelta } from './format';
import { findTranscript } from './observe';
import { parseActions, summarizeActions } from './actions';
import { parseSubagents, summarizeSubagents, SubagentsSummary } from './subagents';

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
    maxMs: lat.length ? Math.max(...lat) : 0,
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
