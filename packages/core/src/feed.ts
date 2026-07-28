/**
 * Live feed (zero-token): what one thing in the Overview is doing RIGHT NOW.
 *
 * The panels answer "who is working and on what" at a glance; this answers the question that always
 * follows — "so what is it actually doing?" — for whichever row you clicked, from the file that thing
 * writes as it works:
 *
 *   agent    → its own `subagents/agent-<id>.jsonl` (its tool calls and its reasoning)
 *   workflow → its agents' transcripts, merged in time order and tagged by agent
 *   task     → the main chain's tool calls inside that task's real in_progress window
 *   process  → the background shell's output file, tailed
 *   session  → the main transcript's tool calls
 *
 * Everything is a bounded TAIL — a feed is about the newest activity, and a panel that re-reads a 50MB
 * transcript per tick is a panel nobody leaves open. `lastTs` is the newest evidence found, so a
 * renderer can say "updated 3s ago" instead of implying live-ness it cannot verify.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findTranscript } from './observe';
import { parseTranscriptActions, ActionRecord, agentPhaseDetail } from './actions';
import { findSubagentsDir } from './subagents';
import { parseWorkflows } from './workflows';
import { listRepoSiblings } from './fleet';
import { cachedChangeMap } from './changemap';
import { sessionProcesses, processOutputTail } from './processes';

export type FeedKind = 'session' | 'agent' | 'workflow' | 'task' | 'process';

export interface FeedRef {
  kind: FeedKind;
  /** agentId · wf_<id> · taskId · background shell id; ignored for 'session'. */
  id: string;
}

export interface FeedEntry {
  /** ms epoch; 0 for raw output lines, which carry no timestamp of their own. */
  ts: number;
  kind: 'action' | 'output' | 'reasoning';
  /** The headline: a tool call, or one line of output. */
  label: string;
  /** Secondary context — the tool's target, or which agent produced it. */
  detail?: string;
  /** false when the call reported an error; undefined when not applicable. */
  ok?: boolean;
}

export interface FeedResult {
  ref: FeedRef;
  /** What is being watched, ready to render as the pane's heading. */
  title: string;
  /** Whether the source still looks alive (an agent's phase, a shell's completion, a run's activity). */
  running: boolean;
  /** What this feed IS, which is a different thing depending on whether its source is still going:
   *  'live'  — still writing, so follow the tail and keep polling;
   *  'audit' — finished, so it is a record of what happened, not a stream. Renderers label and behave
   *  accordingly (a completed run should stop being polled, and should not pretend to be live). */
  mode: 'live' | 'audit';
  /** Chronological, OLDEST first — a feed reads downward, like a terminal. */
  entries: FeedEntry[];
  /** How many older entries were dropped to honour `limit` (0 when none were). */
  truncated: number;
  /** Newest evidence seen (ms epoch, 0 when none) — renderers show the age rather than claim "live". */
  lastTs: number;
  /** Set when the feed can only be partial, and why. */
  note?: string;
}

const DEFAULT_LIMIT = 60;
/** Output tail per process feed — enough scrollback to be useful, small enough to post every tick. */
const OUTPUT_TAIL_BYTES = 16 * 1024;

function empty(ref: FeedRef, title: string, note?: string): FeedResult {
  return { ref, title, running: false, mode: 'audit', entries: [], truncated: 0, lastTs: 0, note };
}

/** Newest `limit` records, oldest-first, plus how many were dropped. */
function tail<T>(all: T[], limit: number): { rows: T[]; truncated: number } {
  if (all.length <= limit) return { rows: all, truncated: 0 };
  return { rows: all.slice(all.length - limit), truncated: all.length - limit };
}

/** One tool call → one feed row. */
function fromAction(a: ActionRecord, agentLabel?: string): FeedEntry {
  return {
    ts: a.ts,
    kind: 'action',
    label: a.tool === 'CompactBoundary' ? 'context compacted' : a.tool,
    detail: [agentLabel, a.target].filter(Boolean).join(' · ') || undefined,
    ok: a.isError ? false : true,
  };
}

/** Resolve a session's transcript even when it belongs to a SIBLING WORKTREE.
 *
 *  `findTranscript` only walks up from cwd, but both editors pin cwd to the workspace root while the
 *  fleet deliberately unions in sessions from every worktree of the repo — so clicking one of those
 *  rows produced an empty feed whose own note ("no transcript for this session") was false. The sibling
 *  scan runs ONLY on the miss path, so the common case still costs one existsSync walk.
 *  Returns the [transcript, cwd] pair, because everything downstream re-resolves from that cwd. */
function resolveSession(cwd: string, sessionId: string): { transcript: string; cwd: string } | null {
  const direct = findTranscript(cwd, sessionId);
  if (direct) return { transcript: direct, cwd };
  for (const sib of listRepoSiblings(cwd, sessionId)) {
    if (sib.id !== sessionId) continue;
    const t = findTranscript(sib.worktree, sessionId);
    if (t) return { transcript: t, cwd: sib.worktree };
  }
  return null;
}

/** An agent's human label from its cached sidecar — deliberately NOT parseSubagents, which re-parses
 *  every agent transcript in the session and would run on each live poll. */
function subagentLabel(dir: string, agentId: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${agentId}.meta.json`), 'utf8'));
    const d = typeof meta?.description === 'string' ? meta.description.trim() : '';
    const t = typeof meta?.agentType === 'string' ? meta.agentType.trim() : '';
    return d || t || '';
  } catch {
    return '';
  }
}

/** mtime of a file, 0 when it can't be stat'd. */
function mtime(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The feed for one Overview row. `nowMs` is injectable for tests.
 */
export function liveFeed(cwd: string, sessionId: string, ref: FeedRef, opts: { limit?: number } = {}): FeedResult {
  const limit = opts.limit ?? DEFAULT_LIMIT;

  // A fleet row can name a session in another worktree; re-point cwd so every branch below resolves.
  const owner = resolveSession(cwd, sessionId);
  if (owner) cwd = owner.cwd;

  if (ref.kind === 'process') {
    const proc = sessionProcesses(cwd, sessionId).find((p) => p.id === ref.id);
    if (!proc) return empty(ref, ref.id, 'no such background shell in this session');
    const text = processOutputTail(proc.outputPath, OUTPUT_TAIL_BYTES);
    const lines = text.split('\n').filter((l) => l.length > 0);
    // The output file lives in a temp dir that gets reaped. "No output yet" and "the log is gone" look
    // identical once it is deleted, and only one of them is true of a shell that already finished.
    let gone = false;
    if (proc.outputPath && !lines.length) {
      try {
        gone = !fs.existsSync(proc.outputPath);
      } catch {
        gone = false;
      }
    }
    const { rows, truncated } = tail(lines, limit);
    return {
      ref,
      title: proc.description || proc.command,
      running: proc.running,
      mode: proc.running ? 'live' : 'audit',
      // Output lines carry no timestamps of their own — the file's mtime is the only honest clock here.
      entries: rows.map((l) => ({ ts: 0, kind: 'output' as const, label: l })),
      truncated,
      lastTs: proc.lastOutputTs || proc.endedTs || proc.startedTs,
      // `truncated` can only count lines INSIDE the tail window, so on a large log it reads 0 while
      // megabytes sit unseen. State the window against the real file size instead of implying the tail
      // is the whole story.
      note: gone
        ? 'the output file has been cleaned up — nothing left to read'
        : !proc.outputPath
        ? 'this shell has no output file to follow'
        : proc.outputBytes > OUTPUT_TAIL_BYTES
          ? `showing the last ${Math.round(OUTPUT_TAIL_BYTES / 1024)} kB of ${(proc.outputBytes / 1048576).toFixed(1)} MB`
          : undefined,
    };
  }

  if (ref.kind === 'agent') {
    const dir = findSubagentsDir(cwd, sessionId);
    const file = dir ? path.join(dir, `agent-${ref.id}.jsonl`) : null;
    if (!file || !fs.existsSync(file)) return empty(ref, ref.id, 'no transcript for this agent yet');
    const actions = parseTranscriptActions(file, { includeSidechain: true });
    const { rows, truncated } = tail(actions, limit);
    const { phase } = agentPhaseDetail(file);
    const agentLive = phase === 'working' || phase === 'awaiting-input' || phase === 'awaiting-permission';
    return {
      ref,
      // Prefer the agent's own description over its id: the id is what the reader just clicked.
      title: (dir ? subagentLabel(dir, ref.id) : '') || ref.id,
      running: agentLive,
      mode: agentLive ? 'live' : 'audit',
      entries: rows.map((a) => fromAction(a)),
      truncated,
      lastTs: mtime(file),
    };
  }

  if (ref.kind === 'workflow') {
    const run = parseWorkflows(cwd, sessionId).find((w) => w.id === ref.id);
    const dir = findSubagentsDir(cwd, sessionId);
    if (!run || !dir) return empty(ref, ref.id, 'no such workflow run in this session');
    // Merge every agent's stream so the run reads as one story, each row tagged with who did it.
    const merged: FeedEntry[] = [];
    let newest = 0;
    for (const a of run.agents) {
      const file = path.join(dir, 'workflows', run.id, `agent-${a.agentId}.jsonl`);
      if (!fs.existsSync(file)) continue;
      newest = Math.max(newest, mtime(file));
      const label = a.label ?? a.phase ?? a.agentId.slice(0, 8);
      for (const act of parseTranscriptActions(file, { includeSidechain: true })) merged.push(fromAction(act, label));
    }
    merged.sort((x, y) => x.ts - y.ts);
    const { rows, truncated } = tail(merged, limit);
    return { ref, title: run.name, running: run.running, mode: run.running ? 'live' : 'audit', entries: rows, truncated, lastTs: newest || run.lastActivityMs || 0 };
  }

  if (ref.kind === 'task') {
    // The strict-span task model lives on the change map, which the Overview has already built — so read
    // the CACHED one. This said the same thing while calling the raw builder, which re-derived the whole
    // map (seconds on a large session) on every feed poll to look up one task's interval.
    const task = cachedChangeMap(cwd, sessionId, { root: cwd, prompts: true }).tasks.find((t) => t.taskId === ref.id);
    if (!task) return empty(ref, ref.id, 'no such task in this session');
    // A task owns a real interval, so its feed is the main chain's calls inside that window.
    const end = task.lastTs || Number.MAX_SAFE_INTEGER;
    const within = parseTranscriptActions(findTranscript(cwd, sessionId) ?? '', { includeSidechain: false }).filter(
      (a) => a.ts >= task.firstTs && a.ts <= end
    );
    const { rows, truncated } = tail(within, limit);
    return {
      ref,
      title: task.content,
      running: !task.lastTs,
      mode: task.lastTs ? 'audit' : 'live',
      entries: rows.map((a) => fromAction(a)),
      truncated,
      lastTs: rows.length ? rows[rows.length - 1].ts : task.lastTs,
      // An empty task feed has two very different causes, and a bare "nothing recorded yet" hides which.
      note: rows.length
        ? undefined
        : task.firstTs > (task.lastTs || Number.MAX_SAFE_INTEGER)
          ? 'this task has no usable window (its recorded start is after its end)'
          : 'no tool calls fell inside this task’s window',
    };
  }

  const resolved = resolveSession(cwd, sessionId);
  if (!resolved) return empty(ref, sessionId, 'no transcript for this session');
  const transcript = resolved.transcript;
  const actions = parseTranscriptActions(transcript, { includeSidechain: false });
  const { rows, truncated } = tail(actions, limit);
  const { phase } = agentPhaseDetail(transcript);
  const live = phase === 'working' || phase === 'awaiting-input' || phase === 'awaiting-permission';
  return {
    ref,
    title: sessionId,
    running: live,
    mode: live ? 'live' : 'audit',
    entries: rows.map((a) => fromAction(a)),
    truncated,
    lastTs: mtime(transcript),
  };
}
