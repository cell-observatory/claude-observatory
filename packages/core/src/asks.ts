/**
 * The user's asks, read from a session transcript — the one place that decides what counts as a turn.
 *
 * This lives below the grouping layer on purpose. Review units are bounded by the ask that produced
 * them (see `units.ts`), and `prompts.ts` builds the prompt axis from the same scan; putting the scan
 * in `prompts.ts` would have meant `units.ts` importing it, and `prompts.ts` imports the grouping layer
 * — a cycle. One scan, memoized against the transcript, two consumers, no drift about what a turn is.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { cachedByFiles, readLines } from './fscache';

/**
 * Is this transcript record a REAL user prompt?
 *
 * The transcript is full of records that wear the user's role without being anything the user typed:
 * tool results, `<command-name>` / `<local-command-stdout>` wrappers from slash commands, injected
 * system reminders, the synthesized summary after a compaction, and the harness's own queue records.
 * Counting any of them would invent turns the person never took.
 */
export function userPrompt(o: any): string | null {
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
export function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

/** ISO/epoch → ms epoch, 0 when absent. */
export function toMs(v: unknown): number {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** Phase 1 of the prompt views — the asks and the per-moment assistant token usage — memoized on the
 *  TRANSCRIPT alone. Everything else the prompt views derive is keyed on the log too, so before this
 *  split a keep click (a log-only change) re-read and re-parsed the whole transcript to recover facts
 *  that had not moved: ~60ms per click at 10MB, growing linearly with the conversation. */
export function askScan(transcript: string): { asks: { ts: number; text: string }[]; tokenAt: { ts: number; tokens: number }[] } {
  return cachedByFiles('promptAsks', [transcript], () => {
    let lines: string[];
    try {
      lines = readLines(transcript);
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
        // NEW tokens only. Adding the cache counters made the same context count once per turn,
        // so this row reported millions where Claude Code's own view reported ~128k for the very
        // same agent. Two tools reporting different numbers for one run is worse than either being
        // slightly off — the reader cannot tell which to trust. Cache traffic is surfaced
        // separately (SessionTokens.cacheRead/cacheCreation), never folded in here.
        const tk = num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens);
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

/** Resolved transcript paths, keyed by config dir + session. Positives only: a found transcript never
 *  moves, but a miss must re-scan because a store is sometimes seeded before its first ask lands. The
 *  config dir is part of the key because tests swap HOME mid-process. */
const transcriptPathMemo = new Map<string, string>();

/**
 * This session's transcript, found from the SESSION ID alone.
 *
 * `findTranscript` walks up from a cwd, which the grouping layer does not have — `pendingGroups(session)`
 * is called from every surface, several of them with no workspace in hand. Session ids are UUIDs, so a
 * scan of the project folders resolves one unambiguously.
 *
 * Exported so the unit memos can stamp the transcript file alongside the log: the unit split depends on
 * ask boundaries, so a new ask with no accompanying edit must invalidate it too. That puts this scan on
 * the warm path of every refresh — hence the positive cache above.
 */
export function transcriptForSession(sessionId: string): string | null {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId)) return null;
  const base = path.join(claudeConfigDir(), 'projects');
  const memoKey = `${base}|${sessionId}`;
  const hit = transcriptPathMemo.get(memoKey);
  if (hit) return hit;
  let names: string[];
  try {
    names = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const slug of names) {
    const p = path.join(base, slug, `${sessionId}.jsonl`);
    try {
      if (fs.statSync(p).isFile()) {
        transcriptPathMemo.set(memoKey, p);
        return p;
      }
    } catch {
      /* not this project folder */
    }
  }
  return null;
}

/**
 * The ask timestamps that bound this session's turns, ascending.
 *
 * Empty when there is no transcript — a store read with no conversation beside it (a test fixture, a
 * copied store, another machine's session). Callers must treat empty as "one unbounded window" rather
 * than "no asks", because the alternative is refusing to group anything at all.
 */
export function askBoundaries(sessionId: string): number[] {
  const transcript = transcriptForSession(sessionId);
  if (!transcript) return [];
  return cachedByFiles('askBoundaries', [transcript], () => askScan(transcript).asks.map((a) => a.ts));
}

/** Which turn a moment belongs to: the index of the newest ask at or before `ts`, or -1 before the
 *  first ask. `-1` is a real answer — work that predates every ask belongs to no turn. */
export function windowOf(boundaries: number[], ts: number): number {
  if (!boundaries.length || !ts || ts < boundaries[0]) return -1;
  let lo = 0;
  let hi = boundaries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (boundaries[mid] <= ts) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
