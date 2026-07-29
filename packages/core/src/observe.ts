/**
 * Observations layer (zero-token): correlate each captured edit with Claude's ACTUAL reasoning from
 * the session transcript, plus cheap heuristic change-summaries, issue-flags, and next-step
 * suggestions. No model calls — the transcript already contains Claude's words.
 */
import * as fs from 'fs';
import * as path from 'path';
import { diffArrays } from 'diff';
import { EditRecord, EditStatus, readLog, readBlob, logPath, maxOf, listSessions, SessionInfo, allStoreSessionIds, rootDir, isSafeSessionId, hasInflightCapture, hasBlob } from './store';
import { lineDelta } from './format';
import { projectDir, resolveSessionId } from './session';
import { claudeConfigDir } from './paths';
import { cachedAnalysis } from './analyze';
import { cachedByFiles } from './fscache';
import { reviewEdits } from './groups';
// NOTE: metrics.ts imports `findTranscript` from this module, so this pair is CIRCULAR. It is safe only
// because both directions are used at CALL time, never at module-init time — nothing here runs during
// load. `test/core.test.js` requires each module first in a child process to keep that true.
import { sessionUsage, sessionVitals } from './metrics';

/** Locate the Claude Code transcript jsonl for a session, walking up from cwd (like resolveSessionId). */
export function findTranscript(cwd: string, sessionId: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const p = path.join(projectDir(dir), `${sessionId}.jsonl`);
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The file-editing tools that appear as tool_uses in the transcript (parseToolUses queues these);
 *  a store record with any other tool (e.g. Bash) has no transcript counterpart to correlate. */
const CORRELATED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface ToolUse {
  file: string;
  reasoning: string;
  /** ms epoch of the tool_use line — the key the correlation matches on. */
  ts: number;
  /** The tool_use id, when the transcript carries one. Reserved for an EXACT join: capture does not
   *  record an id on the edit yet, so nothing matches on this today. */
  id: string;
}

/** Edit/Write/MultiEdit/NotebookEdit tool_uses in transcript order, each with its message's text. */
function parseToolUses(transcriptPath: string): ToolUse[] {
  const out: ToolUse[] = [];
  let lines: string[];
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return out;
  }
  // Carry the most recent assistant text/thinking forward: Claude often emits its reasoning in one
  // message (a `text` explanation and/or a `thinking` block) and the tool_use in the next message.
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
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    // NOTE: sidechain (subagent) messages are deliberately NOT skipped here. The capture hooks fire
    // for subagent edits too (same session store), so if a legacy transcript inlines them
    // (isSidechain:true) their tool_uses must stay in the queues. Current Claude Code writes sidechains
    // to separate subagents/*.jsonl files — which this parser is now pointed at as well, so a
    // subagent's edit takes ITS OWN agent's words instead of the orchestrator's.
    let text = '';
    let think = '';
    for (const b of msg.content) {
      if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text.trim();
      else if (b.type === 'thinking') {
        const th = typeof b.thinking === 'string' ? b.thinking : typeof b.text === 'string' ? b.text : '';
        if (th) think += (think ? '\n' : '') + th.trim();
      }
    }
    const reasoning = text || think; // prefer the visible explanation; fall back to thinking
    if (reasoning) lastReasoning = reasoning;
    const ts = toEpochMs(o.timestamp ?? o.ts) ?? 0;
    for (const b of msg.content) {
      if (b.type === 'tool_use' && CORRELATED_TOOLS.has(b.name)) {
        const f = b.input && (b.input.file_path || b.input.notebook_path);
        if (typeof f === 'string')
          out.push({ file: path.resolve(f), reasoning: lastReasoning, ts, id: typeof b.id === 'string' ? b.id : '' });
      }
    }
  }
  return out;
}

/** Map edit id -> Claude's reasoning text, correlating store edits to transcript tool_uses per file. */
export function reasoningByEdit(cwd: string, sessionId: string): Map<number, string> {
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return new Map<number, string>();
  // Depends on the transcript (tool_uses) AND the store log (the cursor walk) — keyed on both files'
  // (mtime,size), so a new capture or a review op invalidates it. Read-only result, shared as-is.
  return cachedByFiles('reasoningByEdit', [transcript, logPath(sessionId)], () =>
    reasoningByEditUncached(transcript, sessionId)
  );
}

/** How far before an edit's commit its tool_use may sit. The hook writes the record moments after the
 *  call, so this is generous rather than tight — but bounded, so an unrelated edit hours earlier in the
 *  same file can never lend its words. */
const REASONING_WINDOW_MS = 10 * 60_000;
/** A tool_use may be stamped slightly AFTER the commit when clocks or buffering disagree. */
const REASONING_SLACK_MS = 2_000;

/** Every transcript that can explain an edit in this session: the main chain plus each subagent's own
 *  file. Computed from the transcript path rather than imported from subagents.ts, which imports this
 *  module (a value import back would close a runtime cycle). */
function explainingTranscripts(transcript: string): string[] {
  const out = [transcript];
  const subDir = path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) if (n.endsWith('.jsonl')) out.push(path.join(dir, n));
  };
  walk(subDir);
  let runs: string[] = [];
  try {
    runs = fs.readdirSync(path.join(subDir, 'workflows'));
  } catch {
    /* no workflow runs */
  }
  for (const r of runs) walk(path.join(subDir, 'workflows', r));
  return out;
}

/**
 * Correlate store edits to the words that explain them.
 *
 * Matching is by TIME, per file, across every transcript that could have produced the edit — the main
 * chain and each subagent's own file. The previous approach walked a per-file positional cursor over
 * the main transcript alone, which broke twice over: a subagent's edits have no main-chain tool_use, so
 * they either went unexplained or consumed an entry belonging to the orchestrator (attributing one
 * author's words to another's work); and any gap — a file also touched by a `prettier --write`, a
 * filtered record — shifted every later edit in that file, so one miss cascaded through the session.
 *
 * A nearest-in-time match costs at most the single edit it gets wrong, and it reads the author's own
 * transcript. Each tool_use is consumed once, so two edits never claim the same sentence.
 */
function reasoningByEditUncached(transcript: string, sessionId: string): Map<number, string> {
  const map = new Map<number, string>();
  const byFile = new Map<string, ToolUse[]>();
  for (const file of explainingTranscripts(transcript)) {
    for (const e of parseToolUses(file)) {
      const list = byFile.get(e.file);
      if (list) list.push(e);
      else byFile.set(e.file, [e]);
    }
  }
  for (const list of byFile.values()) list.sort((a, b) => a.ts - b.ts);
  const used = new Set<ToolUse>();

  for (const rec of readLog(sessionId)) {
    // A Bash record (a file changed by `prettier --write`, `eslint --fix`) has no tool_use to match.
    if (!CORRELATED_TOOLS.has(rec.tool)) continue;
    const list = byFile.get(path.resolve(rec.file));
    if (!list || !list.length) continue;
    let best: ToolUse | null = null;
    // Time matching needs both sides to HAVE a time. A legacy transcript (or a test fixture) whose
    // tool_uses carry no timestamp would otherwise see every candidate tie at 0 and hand the newest
    // entry to the oldest edit — so those fall through to the positional order they were written in.
    if (rec.ts) {
      // The tool_use always PRECEDES the commit the hook writes, so a candidate at-or-before the edit
      // is the right one and the latest such candidate is the nearest. Only if none exists do we allow
      // the small slack for clock/buffering skew — otherwise a later edit's explanation, which sits
      // just inside that slack, would outrank the correct earlier one.
      for (const e of list) {
        if (used.has(e) || !e.reasoning || !e.ts) continue;
        if (e.ts > rec.ts) break; // sorted: everything after is later still
        if (rec.ts - e.ts > REASONING_WINDOW_MS) continue;
        best = e;
      }
      if (!best) {
        for (const e of list) {
          if (used.has(e) || !e.reasoning || !e.ts) continue;
          if (e.ts > rec.ts + REASONING_SLACK_MS) break;
          if (e.ts > rec.ts) best = e;
        }
      }
    }
    if (!best) best = list.find((e) => !used.has(e) && e.reasoning && !e.ts) ?? null;
    if (!best) continue;
    used.add(best);
    map.set(rec.id, best.reasoning);
  }
  return map;
}

/**
 * Claude's OWN tracked to-dos (its latest `TodoWrite`) plus the last assistant summary, pulled from
 * the transcript — zero token. This is the most grounded "next steps" source we have: it's the plan
 * Claude was literally working from, already sitting in the cached session.
 */
export interface TranscriptInsights {
  todos: { content: string; status: string }[]; // from the latest non-empty TodoWrite in the session
  lastSummary: string | null; // last assistant text block (what Claude said it just did)
  title: string | null; // Claude Code's latest auto session title (the `ai-title` entries) — a recap line
  firstUserPrompt: string | null; // first real user message (non-sidechain, text — never a tool_result/command wrapper)
}
export function transcriptInsights(cwd: string, sessionId: string): TranscriptInsights {
  const empty: TranscriptInsights = { todos: [], lastSummary: null, title: null, firstUserPrompt: null };
  const p = findTranscript(cwd, sessionId);
  if (!p) return empty;
  // Memoized per (mtime,size) — several views consult the same insights per refresh. Read-only result.
  return cachedByFiles('insights', [p], () => transcriptInsightsUncached(p));
}

/** Every store session (listSessions order) + its human-readable TITLE — the transcript's `ai-title`,
 *  else the first user prompt — for the session pickers: both editors' dropdowns show names, with the
 *  raw id demoted to detail. `title` is null when the session has no transcript under this cwd (another
 *  project's session) — renderers fall back to the id. Insights are memoized per (mtime,size), so
 *  re-opening a picker costs stats, not parses. */
export function listSessionsWithTitles(cwd: string): (SessionInfo & { title: string | null })[] {
  return listSessions().map((s) => {
    let title: string | null = null;
    try {
      const ins = transcriptInsights(cwd, s.id);
      title = normalizeSessionTitle(ins.title ?? ins.firstUserPrompt ?? '');
    } catch {
      /* unreadable transcript — the id still identifies the session */
    }
    return { ...s, title };
  });
}

/** Keep list rows SHORT but informative: ai-titles already are, but the first-PROMPT fallback can be a
 *  whole pasted brief — take its first sentence, then hard-cap at 64. Hover surfaces show it uncapped. */
function normalizeSessionTitle(raw: string): string | null {
  let title = raw.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const sentence = /^(.*?[.?!])(?:\s|$)/.exec(title);
  if (sentence && sentence[1].length >= 12) title = sentence[1]; // a bare "Hi." is no title
  if (title.length > 64) title = title.slice(0, 63).trimEnd() + '…';
  return title;
}

// --- fast session listing: the session selector + the Overview's Sessions tab ---

export interface SessionMetaRow {
  id: string;
  /** Human-readable name (latest ai-title, else the first user prompt), normalized; null when neither
   *  could be found in the bounded scan — renderers fall back to the short id. */
  title: string | null;
  /** Conversation recency: the TRANSCRIPT's mtime (a review click on the store must not resurrect a
   *  dead session), falling back to log.jsonl mtime for a transcript that vanished. */
  lastActiveMs: number;
  /** True for the session `resolveSessionId(cwd)` currently answers with. */
  current: boolean;
  /** What the session did to this workspace, in the terms the log itself carries: how many edits were
   *  captured, how many still await review, and how many distinct files they touched. Zeros for a
   *  session with no store — a conversation that only asked and read changed nothing, which is a fact,
   *  not a gap. Line deltas are deliberately absent: they live in the content blobs, and reading two per
   *  edit is exactly the cost this listing exists to avoid. */
  edits: number;
  pending: number;
  files: number;
  /** Lines added / removed across the session's captured edits (sidecar-cached — see SessionCounts). */
  added: number;
  removed: number;
  /** Total tokens the conversation consumed, and its wall-clock span. Both ride sessionUsage's persisted
   *  byte cursor, so a finished session is a stat and the live one is a delta parse. */
  tokens: number;
  durationMs: number;
  /** The model serving the session's latest turn ('' when no turn exists yet) and the reasoning effort
   *  it declared ('' when it never declared one — unset is reported as unknown, never guessed, because
   *  the default differs by build and model). */
  model: string;
  effort: string;
}

export interface SessionMeta {
  active: string | null;
  /** This WORKSPACE's sessions, newest conversation first. */
  sessions: SessionMetaRow[];
}

/**
 * The cheap session list both pickers and the Sessions tab render. Deliberately carries NO pending or
 * edit counts: computing them meant a full `readLog` of every session in the store per open (2.2 MB of
 * JSONL on a mature machine), and recency plus name is what the switch decision actually needs. Titles
 * come from a BOUNDED transcript scan (tail for the latest ai-title, head for the first prompt) behind
 * an on-disk sidecar keyed to the transcript's (mtime,size), so even a cold CLI spawn answers in stats.
 */
/**
 * How long a conversation must have been quiet before "it is finished" is a safe thing to assume.
 *
 * A DAY, not the five minutes the phase heuristic uses to call a session `done`. That heuristic decides
 * how to draw a badge; this one decides whether to recursively delete a session's edit history and undo
 * snapshots, and the two do not deserve the same clock. `current` protects only ONE session — it is the
 * newest transcript in the project dir — so with several Claude sessions open in a repo (which the whole
 * Fleet view exists for) every other one is a candidate the moment it goes quiet. Five minutes of quiet
 * is a user thinking about their next prompt; a day is a session they have moved on from.
 */
export const REAP_QUIET_MS = 24 * 60 * 60_000;

/**
 * How long a conversation must be dead before it counts as ABANDONED rather than merely quiet.
 *
 * A session with unreviewed edits is not finished — but one nobody has spoken to in a fortnight is never
 * going to be reviewed either, and it is the bulk of what accumulates. Two weeks is chosen to be
 * conservative about what it discards: on the store this was built against it clears 11 sessions while
 * dropping 108 unreviewed edits, where a one-week threshold would drop 792.
 */
export const REAP_STALE_MS = 14 * 24 * 60 * 60_000;

export interface ReapCandidate {
  id: string;
  title: string | null;
  /** Transcript mtime — CONVERSATION recency, not store-write recency. See the note below. */
  lastActiveMs: number;
  edits: number;
  /** Unreviewed edits that would be DISCARDED with it. Always 0 for a `finished` candidate. */
  pending: number;
  /** `finished` = nothing left to review. `abandoned` = still had pending edits, but nobody came back. */
  reason: 'finished' | 'abandoned';
}

/**
 * Sessions in `cwd` whose review is finished and whose data is safe to discard.
 *
 * Every clause is a refusal, and each one is load-bearing:
 *  - not `current` — never the session the user is working in;
 *  - `pending === 0` — nothing left to review, which is the whole definition of finished here;
 *  - quiet for REAP_QUIET_MS — a session with no pending edits *yet* is not a finished one;
 *  - no in-flight capture — the one liveness signal no timestamp can give us (see hasInflightCapture).
 *
 * Staleness is measured on `lastActiveMs` (transcript mtime), never on the store log's mtime. Accepting
 * a batch of old edits writes the log, so a log-mtime clock would make reviewing a dead session look
 * like reviving it — and, worse for a reaper, a long live conversation that made all its edits early
 * looks ANCIENT by that clock. The list is cheap: sessionMeta is sidecar-cached, one stat per session.
 */
export function reapableSessions(cwd: string, now: number = Date.now(), staleMs: number = REAP_STALE_MS): ReapCandidate[] {
  // THIS workspace only, by exact match. sessionMeta's own provenance rail is `findTranscript`, which
  // WALKS UP to the filesystem root — so a session started in an ancestor directory (~, ~/Github, a
  // monorepo root, all ordinary launch dirs) resolves here and would be reaped from a subdirectory.
  // Listing such a session is fine; deleting it is not, so the destructive path narrows the rule.
  const here = projectDir(cwd);
  return sessionMeta(cwd)
    .sessions.filter((r) => {
      const t = findTranscript(cwd, r.id);
      if (!t || path.dirname(path.resolve(t)) !== path.resolve(here)) return false;
      if (r.current || hasInflightCapture(r.id)) return false;
      const quiet = now - r.lastActiveMs;
      // Two ways to be done with a session, and they need different clocks. FINISHED: nothing left to
      // review — a day of quiet is enough. ABANDONED: it still has unreviewed edits, but the conversation
      // has been dead for a fortnight and nobody is coming back. Without the second clause almost nothing
      // qualifies on a real store: most old sessions were simply never reviewed to the end.
      return r.pending === 0 ? quiet > REAP_QUIET_MS : quiet > staleMs;
    })
    .map((r) => ({
      id: r.id,
      title: r.title,
      lastActiveMs: r.lastActiveMs,
      edits: r.edits,
      pending: r.pending,
      reason: r.pending === 0 ? ('finished' as const) : ('abandoned' as const),
    }));
}

export function sessionMeta(cwd: string, reviewing?: string | null): SessionMeta {
  const active = (() => {
    try {
      return resolveSessionId(cwd);
    } catch {
      return null;
    }
  })();
  const rows: SessionMetaRow[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const transcript = findTranscript(cwd, id);
    if (!transcript) return; // another workspace's session — not offered here
    let lastActiveMs = 0;
    try {
      lastActiveMs = fs.statSync(transcript).mtimeMs;
    } catch {
      try {
        lastActiveMs = fs.statSync(logPath(id)).mtimeMs;
      } catch {
        /* neither file — skip the row below */
      }
    }
    if (!lastActiveMs) return;
    // Tokens/duration and model/effort share ONE incremental cursor over the transcript, so asking for
    // both costs a single delta parse — and nothing at all for a session whose transcript has not moved.
    let tokens = 0;
    let durationMs = 0;
    let model = '';
    let effort = '';
    try {
      const u = sessionUsage(cwd, id);
      tokens = u.total;
      durationMs = u.durationMs;
      const v = sessionVitals(cwd, id);
      model = v.model?.label ?? ''; // the display label ('Opus 4.8'), so renderers stay thin
      effort = v.effort?.level ?? '';
    } catch {
      /* an unreadable transcript still identifies a session — report the row without its vitals */
    }
    rows.push({
      id,
      title: fastSessionTitle(transcript, id),
      lastActiveMs,
      current: id === active,
      ...sessionCounts(id),
      tokens,
      durationMs,
      model,
      effort,
    });
  };
  for (const id of allStoreSessionIds()) push(id);
  if (active) push(active); // the live conversation may have no store yet (no edits) — still listed
  // …and the session the reader has PINNED, which may equally have no store: a conversation that only
  // asked and read never triggers the capture hook. Provenance is still decided by `push` (a transcript
  // that does not resolve under this cwd is dropped), so a genuinely foreign pin stays unlisted — but a
  // local one is no longer reported as "recorded for another workspace" merely for having no edits.
  if (reviewing) push(reviewing);
  rows.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return { active, sessions: rows };
}

/** A session's review numbers, cached beside its title. */
export interface SessionCounts {
  edits: number;
  pending: number;
  files: number;
  /**
   * Lines this session added / removed across every captured edit.
   *
   * These DO cost content-blob reads — two per edit, the one thing this listing was built to avoid. A
   * live log grows constantly, so caching the total alone still re-paid the whole sum on every refresh:
   * +0.17 s a tick at 1,732 edits, +0.71 s at 7,914, worse the longer the session ran.
   *
   * What makes it cheap is a per-BLOB-PAIR delta cache (see deltaCache): the sum is recomputed in full
   * every time, but from map lookups instead of blob reads. A running total was tried first and rejected
   * — it cannot be validated. One entry written wrong (observed: a sum of 0 over 2,800 edits) is
   * inherited by every later pass, and nothing can notice, because there is nothing to check it against.
   * A blob pair is CONTENT, so a cache keyed by it is either a hit on the same bytes or a miss.
   */
  added: number;
  removed: number;
}

// 5: counts are over DISPLAY units (same-code collapsed), matching the change map; 4: line deltas moved
// to the per-blob-pair cache (deltaCache); 2: added `files`.
const COUNTS_SIDECAR_VERSION = 5;

/**
 * A session's captured-edit counts, cached in the same sidecar the title uses and keyed to the LOG's
 * mtime:size — so a listing pays one `stat` per session and re-reads only the logs that changed since.
 *
 * The counts exist because a session row is only useful next to what the session did: a fleet row would
 * never show a name alone. Reading them from the log is what the sidecar makes cheap; reading them from
 * the transcript would not be, which is why nothing here parses one.
 */
export function sessionCounts(sessionId: string): SessionCounts {
  const empty: SessionCounts = { edits: 0, pending: 0, files: 0, added: 0, removed: 0 };
  let stamp = '';
  try {
    const st = fs.statSync(logPath(sessionId));
    stamp = `${COUNTS_SIDECAR_VERSION}|${st.mtimeMs}:${st.size}`;
  } catch {
    return empty; // no store — the session captured nothing
  }
  const sidecar = path.join(rootDir(), 'session-meta', `${sessionId}.json`);
  type Side = {
    stamp?: string;
    title?: string | null;
    counts?: SessionCounts;
    countsStamp?: string;
  };
  let side: Side = {};
  try {
    side = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    if (side && side.countsStamp === stamp && side.counts) return side.counts;
  } catch {
    /* absent or unreadable — count */
  }
  // The DISPLAY units, not the raw records — `reviewEdits` applies the same same-code collapse the
  // change map draws. Counting raw records here made the Sessions row and the Overview's summary bar
  // disagree about the same session under the same word: 5,198 pending against 3,609, and +939,803
  // against +355,905, because 1,589 records collapsed away. One product, one meaning for "pending".
  const log = reviewEdits(sessionId);
  const counts = { ...empty };
  const files = new Set<string>();
  for (const r of log) {
    counts.edits++;
    if (r.status === 'pending') counts.pending++;
    files.add(r.file);
  }
  counts.files = files.size;
  // The sum is computed IN FULL every time, from a per-blob-pair cache. Full means a wrong number can
  // never outlive one log change; content-keyed means the cache cannot be wrong in the first place.
  const deltas = deltaCache(sessionId);
  for (const r of log) {
    const d = deltas.get(r);
    counts.added += d.added;
    counts.removed += d.removed;
  }
  deltas.flush();
  // The stamp above covers the LOG only, but `added`/`removed` are derived from BLOBS. A record whose
  // snapshot is missing (observed at ~4.7% of reads mid-rewrite — see writeStaging) yields a wrong sum,
  // and a finished session's log never changes again, so persisting it here would make that number
  // permanent — exactly the inherited-forever failure the per-pair cache was chosen to avoid. Serve
  // this pass, cache nothing, and recompute next time when the blob may be back.
  if (!deltas.complete()) return counts;
  try {
    fs.mkdirSync(path.dirname(sidecar), { recursive: true, mode: 0o700 });
    const tmp = `${sidecar}.${process.pid}.tmp`;
    // Merge, never replace: the title half of this file is keyed to the TRANSCRIPT and must survive a
    // log-only change (and the other way round).
    fs.writeFileSync(tmp, JSON.stringify({ ...side, counts, countsStamp: stamp }), { mode: 0o600 });
    fs.renameSync(tmp, sidecar);
  } catch {
    /* a cache we could not write is a cache we recompute — never an error */
  }
  return counts;
}

/** Bump when the stored shape changes. */
const DELTA_CACHE_VERSION = 1;

/**
 * A session's line deltas, cached per BLOB PAIR on disk.
 *
 * The key is `<beforeSha>:<afterSha>` — the content itself — so an entry is either a hit on exactly
 * those bytes or a miss. That is the whole reason this shape was chosen over a running total: a total
 * is a derived number with nothing to check it against, and one bad write is inherited forever. Blobs
 * are immutable and content-addressed, so a hit here is exact by construction, and identical edits
 * across records collapse onto one entry (within this session — the file is per session).
 *
 * Lives beside the session's other derived copies so dropping a session reaps it too.
 */
function deltaCache(sessionId: string): { get(r: EditRecord): { added: number; removed: number }; flush(): void; complete(): boolean } {
  const file = isSafeSessionId(sessionId)
    ? path.join(rootDir(), 'changemap-cache', sessionId, 'deltas.json')
    : null;
  const map = new Map<string, [number, number]>();
  if (file) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; pairs?: Record<string, [number, number]> };
      if (j && j.version === DELTA_CACHE_VERSION && j.pairs) for (const [k, v] of Object.entries(j.pairs)) map.set(k, v);
    } catch {
      /* absent or unreadable — recompute */
    }
  }
  const keep = new Map<string, [number, number]>();
  let dirty = false;
  let complete = true; // false once any record's blobs could not be read
  return {
    complete: () => complete,
    get(r) {
      const key = `${r.beforeBlob ?? '-'}:${r.afterBlob ?? '-'}`;
      const cached = map.get(key);
      if (cached) {
        keep.set(key, cached); // retained: this pass used it
        return { added: cached[0], removed: cached[1] };
      }
      const d = lineDelta(sessionId, r);
      const v: [number, number] = [d.added, d.removed];
      // A blob that cannot be READ is not the same as an edit with no blob. `blobText` returns '' for a
      // GC'd snapshot so rendering degrades instead of crashing — which means lineDelta happily reports
      // "the whole file was removed" and we would file that under the INTACT sha. Content-keying makes a
      // hit exact only when the content was actually there; nothing would ever heal this entry, because
      // the key never changes. Same guard placementStore already applies to the same hazard.
      if (hasBlob(sessionId, r.beforeBlob) && hasBlob(sessionId, r.afterBlob)) {
        keep.set(key, v);
        dirty = true;
      } else {
        complete = false; // this pass's SUM is a guess; the caller must not persist it (see sessionCounts)
      }
      return { added: v[0], removed: v[1] };
    },
    flush() {
      // Write only when something changed, and keep only the pairs still referenced — a log that drops
      // records (clean --resolved) must not leave their entries behind forever.
      if (!file || (!dirty && keep.size === map.size)) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: DELTA_CACHE_VERSION, pairs: Object.fromEntries(keep) }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch {
        /* cache is best-effort */
      }
    },
  };
}

const TITLE_SIDECAR_VERSION = 1;
const TITLE_TAIL_SCAN = 4 * 1024 * 1024; // ai-title rides near the end; latest wins
const TITLE_HEAD_SCAN = 256 * 1024; // the first user prompt sits near the top

/**
 * A session's display title from a BOUNDED transcript scan, cached in an on-disk sidecar
 * (`<store>/session-meta/<id>.json`, keyed to the transcript's mtime:size — the usage-cursors
 * pattern). The scan replicates transcriptInsights' rules on a budget: the LATEST `ai-title` from the
 * tail, else the first REAL user prompt from the head (no sidechains, no compact summaries, no
 * command/caveat wrappers).
 */
export function fastSessionTitle(transcriptPath: string, sessionId: string): string | null {
  let stamp = '';
  try {
    const st = fs.statSync(transcriptPath);
    stamp = `${TITLE_SIDECAR_VERSION}|${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  // The id reaches here from a pinned setting or a --session flag, so it is not trusted to be a single
  // path segment: without this, `../../evil` would resolve OUTSIDE the store and then be written to.
  if (!isSafeSessionId(sessionId)) return scanTitle(transcriptPath);
  const sidecar = path.join(rootDir(), 'session-meta', `${sessionId}.json`);
  try {
    const hit = JSON.parse(fs.readFileSync(sidecar, 'utf8')) as { stamp: string; title: string | null };
    if (hit && hit.stamp === stamp) return hit.title;
  } catch {
    /* absent or unreadable — scan */
  }
  const title = scanTitle(transcriptPath);
  try {
    fs.mkdirSync(path.dirname(sidecar), { recursive: true, mode: 0o700 });
    const tmp = `${sidecar}.${process.pid}.tmp`;
    // Merge: the counts half of this file is keyed to the LOG and must survive a transcript-only change.
    let prev: Record<string, unknown> = {};
    try {
      prev = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
    } catch {
      /* first write */
    }
    fs.writeFileSync(tmp, JSON.stringify({ ...prev, stamp, title }), { mode: 0o600 });
    fs.renameSync(tmp, sidecar); // atomic — a concurrent reader sees old-or-new, never a torn file
  } catch {
    /* sidecar is best-effort */
  }
  return title;
}

function scanTitle(transcriptPath: string): string | null {
  let fd: number;
  let size = 0;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    size = fs.fstatSync(fd).size;
  } catch {
    return null;
  }
  try {
    // Tail: the LATEST ai-title wins, so walk the last chunk's lines backwards.
    const tailLen = Math.min(size, TITLE_TAIL_SCAN);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    const tailLines = tail.toString('utf8').split('\n');
    if (tailLen < size) tailLines.shift(); // first line may be partial
    for (let i = tailLines.length - 1; i >= 0; i--) {
      const t = tailLines[i];
      if (t.indexOf('"ai-title"') === -1) continue;
      try {
        const o = JSON.parse(t);
        if (o && o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim())
          return normalizeSessionTitle(o.aiTitle);
      } catch {
        /* partial line */
      }
    }
    // Head: the first REAL user prompt (same filters as transcriptInsights).
    const headLen = Math.min(size, TITLE_HEAD_SCAN);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    for (const line of head.toString('utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let o: any;
      try {
        o = JSON.parse(t);
      } catch {
        continue; // the last line may be cut by the byte budget
      }
      const msg = o.message;
      if (!msg || msg.role !== 'user' || o.isSidechain === true || o.isCompactSummary === true) continue;
      let text: string | null = null;
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) {
        const tb = msg.content.find((b: any) => b && b.type === 'text' && typeof b.text === 'string');
        if (tb) text = tb.text;
      }
      const clean = text ? text.trim() : '';
      if (clean && !clean.startsWith('<') && !/^caveat:/i.test(clean)) return normalizeSessionTitle(clean);
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function transcriptInsightsUncached(p: string): TranscriptInsights {
  const empty: TranscriptInsights = { todos: [], lastSummary: null, title: null, firstUserPrompt: null };
  let lines: string[];
  try {
    lines = fs.readFileSync(p, 'utf8').split('\n');
  } catch {
    return empty;
  }
  let todos: { content: string; status: string }[] = [];
  let lastSummary: string | null = null;
  let title: string | null = null;
  let firstUserPrompt: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    // Claude Code writes an `ai-title` entry whenever it (re)titles the session — keep the latest.
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
      title = o.aiTitle.trim();
      continue;
    }
    const msg = o.message;
    // First REAL user prompt — the fallback session title for sessions without to-dos. String or
    // text-block content both occur; skip sidechains, tool_result-only turns, and the harness's
    // command/caveat wrappers (`<command-name>…`, `Caveat: …`) — those aren't what the user asked.
    // A compaction summary is likewise excluded: it's a synthesized user turn ("This session is being
    // continued from a previous conversation…"), so on a compacted session it would otherwise become
    // the session title and the session picker's label.
    if (firstUserPrompt === null && msg && msg.role === 'user' && o.isSidechain !== true && o.isCompactSummary !== true) {
      let text: string | null = null;
      if (typeof msg.content === 'string') text = msg.content;
      else if (Array.isArray(msg.content)) {
        const tb = msg.content.find((b: any) => b && b.type === 'text' && typeof b.text === 'string');
        if (tb) text = tb.text;
      }
      const clean = text ? text.trim() : '';
      if (clean && !clean.startsWith('<') && !/^caveat:/i.test(clean)) firstUserPrompt = clean;
    }
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    // Skip inlined sidechain (subagent) turns: a subagent's report/TodoWrite is not "what Claude
    // said it just did" in the main conversation. (Current Claude Code stores sidechains in
    // separate files; this guards legacy transcripts.)
    if (o.isSidechain === true) continue;
    for (const b of msg.content) {
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) lastSummary = b.text.trim();
      if (b.type === 'tool_use' && b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
        const list = b.input.todos
          .filter((td: any) => td && typeof td.content === 'string')
          .map((td: any) => ({ content: String(td.content).trim(), status: String(td.status || '') }));
        if (list.length) todos = list; // keep the LATEST non-empty list — it supersedes earlier ones
      }
    }
  }
  return { todos, lastSummary, title, firstUserPrompt };
}

// --- context sources: what shaped this session ---

/** Where a piece of the session's context came from. */
export type ContextSourceKind = 'claude-md' | 'memory' | 'plan' | 'skill' | 'compact-summary';

export interface ContextSource {
  kind: ContextSourceKind;
  /** Display label, e.g. `CLAUDE.md (global)`, `skill: dataviz`, `plan: refactor-auth.md`. */
  label: string;
  /** The file to open when the row is clicked; null for sources that aren't a file. */
  path: string | null;
  /** How we know: the transcript recorded it, or the file simply exists where the harness loads it
   *  from. The distinction is the point — see `ContextSourcesReport.note`. */
  evidence: 'transcript' | 'file-present';
  detail: string | null;
  /** Transcript evidence only: how many times it appeared. */
  count: number;
  /** First transcript evidence (ms epoch); 0 for file-present rows. */
  ts: number;
}

export interface ContextSourcesReport {
  sources: ContextSource[];
  /** Rendered verbatim by both editors as the section's caveat. */
  note: string;
}

const CONTEXT_NOTE =
  'Detectable sources only — instruction files are injected into the system prompt, which transcripts never record.';

/**
 * What shaped this session: the skills it invoked, the plans it wrote, the memory it read, whether it
 * was resumed from a compaction, and which instruction files are present where the harness loads them.
 *
 * Two tiers of evidence, kept explicit rather than blurred: `transcript` rows are things the session
 * demonstrably did, `file-present` rows are files that exist in a location Claude Code auto-loads —
 * because current builds inject CLAUDE.md and memory system-prompt-side, leaving no transcript trace.
 * Claiming those as observed facts would be a lie; omitting them would hide the biggest influence on
 * the session. So they're listed, and labelled as what they are.
 */
export function contextSources(cwd: string, sessionId: string): ContextSourcesReport {
  const p = findTranscript(cwd, sessionId);
  // Memoize only the transcript fold: cachedByFiles declines to cache when any input path can't be
  // stat'd, so stamping the (often absent) instruction files here would disable caching entirely.
  const fromTranscript = p ? cachedByFiles('contextSources', [p], () => contextSourcesUncached(p)) : [];
  const seen = new Set(fromTranscript.map((s) => s.path).filter(Boolean) as string[]);
  const present: ContextSource[] = [];
  const addPresent = (file: string, kind: ContextSourceKind, label: string): void => {
    if (seen.has(file)) return; // transcript evidence already covers it — don't list it twice
    let ok = false;
    try {
      ok = fs.existsSync(file);
    } catch {
      ok = false;
    }
    if (!ok) return;
    seen.add(file);
    present.push({ kind, label, path: file, evidence: 'file-present', detail: 'auto-loaded — injection not recorded per-session', count: 0, ts: 0 });
  };
  addPresent(path.join(cwd, 'CLAUDE.md'), 'claude-md', 'CLAUDE.md (project)');
  addPresent(path.join(claudeConfigDir(), 'CLAUDE.md'), 'claude-md', 'CLAUDE.md (global)');
  addPresent(path.join(projectDir(cwd), 'memory', 'MEMORY.md'), 'memory', 'MEMORY.md (memory index)');

  const order: Record<ContextSourceKind, number> = { 'claude-md': 0, memory: 1, plan: 2, skill: 3, 'compact-summary': 4 };
  const sources = [...fromTranscript, ...present].sort(
    (a, b) => order[a.kind] - order[b.kind] || b.count - a.count || a.label.localeCompare(b.label)
  );
  return { sources, note: CONTEXT_NOTE };
}

/** The transcript half of `contextSources` — one pass, parsed locally (importing parseActions here
 *  would close a cycle: actions.ts already imports findTranscript from this module). */
function contextSourcesUncached(transcriptPath: string): ContextSource[] {
  let lines: string[];
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
  } catch {
    return [];
  }
  const plansDir = path.join(claudeConfigDir(), 'plans');
  const configDir = claudeConfigDir();
  const byKey = new Map<string, ContextSource>();
  // A file that was both read and written must say so — reporting only whichever came first would
  // describe a plan the session actively maintained as merely "read".
  const touch = new Map<string, { read: boolean; wrote: boolean }>();
  const add = (key: string, src: Omit<ContextSource, 'count'>): void => {
    const hit = byKey.get(key);
    if (hit) {
      hit.count++;
      if (src.ts && (!hit.ts || src.ts < hit.ts)) hit.ts = src.ts;
      return;
    }
    byKey.set(key, { ...src, count: 1 });
  };
  const addFile = (key: string, src: Omit<ContextSource, 'count' | 'detail'>, wrote: boolean): void => {
    const flags = touch.get(key) ?? { read: false, wrote: false };
    if (wrote) flags.wrote = true;
    else flags.read = true;
    touch.set(key, flags);
    add(key, { ...src, detail: null });
  };
  const under = (file: string, dir: string): boolean => {
    const rel = path.relative(dir, file);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let o: any;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (o.isSidechain === true) continue;
    const ts = toEpochMs(o.timestamp ?? o.ts) ?? 0;
    // Resumed from a compaction: everything before the boundary reaches this session as a summary.
    if (o.isCompactSummary === true) {
      add('compact-summary', {
        kind: 'compact-summary',
        label: 'resumed from a compaction summary',
        path: null,
        evidence: 'transcript',
        detail: 'earlier turns arrived as a summary, not their original text',
        ts,
      });
      continue;
    }
    const msg = o.message;
    if (!msg || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      if (b.name === 'Skill') {
        const skill = typeof input.skill === 'string' ? input.skill : typeof input.command === 'string' ? input.command : '';
        if (skill) add('skill:' + skill, { kind: 'skill', label: `skill: ${skill}`, path: null, evidence: 'transcript', detail: 'instructions loaded into the session', ts });
        continue;
      }
      const file = typeof input.file_path === 'string' ? input.file_path : '';
      if (!file) continue;
      const wrote = b.name === 'Write' || b.name === 'Edit' || b.name === 'MultiEdit' || b.name === 'NotebookEdit';
      if (under(file, plansDir)) {
        addFile('plan:' + file, { kind: 'plan', label: `plan: ${path.basename(file)}`, path: file, evidence: 'transcript', ts }, wrote);
      } else if (under(file, configDir) && /\bmemory\b/.test(file)) {
        addFile('memory:' + file, { kind: 'memory', label: `memory: ${path.basename(file)}`, path: file, evidence: 'transcript', ts }, wrote);
      } else if (path.basename(file) === 'CLAUDE.md') {
        addFile('claude-md:' + file, { kind: 'claude-md', label: `CLAUDE.md (${path.basename(path.dirname(file))})`, path: file, evidence: 'transcript', ts }, wrote);
      }
    }
  }
  for (const [key, flags] of touch) {
    const s = byKey.get(key);
    if (s) s.detail = flags.read && flags.wrote ? 'read and written this session' : flags.wrote ? 'written this session' : 'read this session';
  }
  return [...byKey.values()];
}

/** Pull a "Next steps / TODO / Follow-ups" bullet section out of Claude's recap (last summary). */
function recapNextSteps(summary: string): string[] {
  // Linear: a SINGLE character class for the leading markdown noise (#, *, whitespace). The previous
  // `\s*\**\s*` had two whitespace matchers around an empty-matching `\**`, which backtracks O(n²) on
  // a line of many spaces — and `summary` is Claude-transcript text (a prompt-injected line could hang
  // the review UI). One quantifier over a char class can't backtrack catastrophically.
  const heading = /^[#*\s]*(next steps?|to-?dos?|follow[- ]?ups?|remaining|still to do)\b/i;
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)/;
  const out: string[] = [];
  let capturing = false;
  for (const raw of summary.split('\n')) {
    // Native trimEnd (linear) — `/\s+$/.replace` retries from every index and is O(n^2) when a long
    // whitespace run is followed by a non-space char (the same ReDoS class as the heading regex).
    const line = raw.trimEnd();
    if (heading.test(line.trim())) {
      capturing = true;
      continue;
    }
    if (!capturing) continue;
    const m = bullet.exec(line);
    if (m) {
      const t = m[1]
        .replace(/\*\*/g, '')
        .replace(/`/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // strip markdown links, keep text
        .trim();
      if (t.length >= 3 && t.length <= 140) out.push(t);
    } else if (line.trim() !== '') {
      capturing = false; // a non-blank, non-bullet line ends the section
    }
  }
  return out;
}

/** The still-open next steps Claude tracked this session: its latest to-do list plus any "Next steps"
 *  bullets from its recap (last summary) — all mined from the transcript, zero token. */
export function transcriptSuggestions(cwd: string, sessionId: string): string[] {
  const ins = transcriptInsights(cwd, sessionId);
  const out: string[] = ins.todos
    .filter((td) => td.status !== 'completed')
    .map((td) => (td.status === 'in_progress' ? `▸ ${td.content}` : td.content));
  const seen = new Set(out.map((s) => s.replace(/^▸\s*/, '').toLowerCase()));
  if (ins.lastSummary) {
    for (const step of recapNextSteps(ins.lastSummary)) {
      const key = step.toLowerCase();
      if (!seen.has(key)) {
        out.push(step);
        seen.add(key);
      }
    }
  }
  return out.slice(0, 6);
}

// --- heuristic summary + flags (zero-token) ---

function blobText(sessionId: string, sha: string | null): string | null {
  if (sha === null) return null;
  try {
    return readBlob(sessionId, sha).toString('utf8');
  } catch {
    return null; // a GC'd blob is a missing input, not a crash in the Observations tree
  }
}

function addedLines(before: string, after: string): string[] {
  const tok = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) || [];
  const out: string[] = [];
  // Loop, never out.push(...p.value): a whole-file Write of a >65k-line file would blow the arg limit.
  for (const p of diffArrays(tok(before), tok(after))) {
    if (p.added) for (const v of p.value) out.push(v);
  }
  return out;
}

export interface Flag {
  level: 'info' | 'warn';
  message: string;
}

/** One-line change summary for an edit (created/deleted/±lines). */
export function summarize(sessionId: string, rec: EditRecord): string {
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  const base = path.basename(rec.file);
  if (before === null) return `created ${base}`;
  if (after === null) return `deleted ${base}`;
  const add = addedLines(before, after).length;
  const rem = addedLines(after, before).length; // "added" in reverse = removed
  return `edited ${base} (+${add} −${rem})`;
}

/** Cheap issue flags for an edit (scans added lines + the whole session's file set).
 *  Pass `log` (the session's readLog result) when calling per-edit in a loop to avoid re-reading
 *  the log file for every edit; omitted, it is read on demand (backward compatible). */
/** The BLOB-derived half of `flagsFor`, memoized on the two blob hashes.
 *
 *  Blobs are content-addressed and immutable, so this pair always yields the same answer. It is worth
 *  caching because the change map calls flagsFor once per edit on every build, and each call ran two
 *  full array diffs — at ~1,100 edits that was the single largest cost in the build. Deliberately only
 *  the blob half: the "no test file changed" flag below depends on the session's FILE SET, which grows
 *  as the session runs, so caching the whole result would freeze a flag that is supposed to flip. */
const flagBlobMemo = new Map<string, { addedText: string; removed: number } | null>();
const FLAG_MEMO_CAP = 20000;

function flagInputs(sessionId: string, rec: EditRecord): { addedText: string; removed: number } | null {
  const key = `${rec.beforeBlob ?? ''}\u0000${rec.afterBlob ?? ''}`;
  const hit = flagBlobMemo.get(key);
  if (hit !== undefined) return hit;
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  const value =
    after === null
      ? null // the file was deleted — the caller answers that without diffing
      : { addedText: addedLines(before ?? '', after).join(''), removed: before !== null ? addedLines(after, before).length : 0 };
  if (flagBlobMemo.size >= FLAG_MEMO_CAP) flagBlobMemo.clear();
  flagBlobMemo.set(key, value);
  return value;
}

/** The distinct test-pattern files in a log, derived ONCE per log array.
 *
 *  flagsFor's no-test-sibling check needs only this list, but it rebuilt the full file Set per record —
 *  and buildChangeMap calls flagsFor per edit, which made map builds quadratic: measured n^1.8, 1.58s
 *  warm at 12k edits with 83.6% of the build inside this function. Keyed on ARRAY IDENTITY because every
 *  hot caller (buildChangeMap, the CLI summary loop, the editors' cachedLog) passes one stable array per
 *  pass; a caller that passes fresh copies simply falls back to paying per call, never to a wrong answer. */
const testFilesMemo = new WeakMap<readonly EditRecord[], string[]>();
function testFilesOf(log: readonly EditRecord[]): string[] {
  let t = testFilesMemo.get(log);
  if (!t) {
    const seen = new Set<string>();
    for (const r of log) if (/\.(test|spec)\.|_test\.|test_/.test(r.file)) seen.add(r.file);
    t = [...seen];
    testFilesMemo.set(log, t);
  }
  return t;
}

export function flagsFor(sessionId: string, rec: EditRecord, log?: EditRecord[]): Flag[] {
  const flags: Flag[] = [];
  const blob = flagInputs(sessionId, rec);
  if (blob === null) return [{ level: 'warn', message: 'file deleted' }];
  const addedText = blob.addedText;
  if (/\b(TODO|FIXME|XXX|HACK)\b/.test(addedText)) flags.push({ level: 'info', message: 'adds a TODO/FIXME' });
  if (/\b(console\.log|debugger|print\(|dbg!)\b/.test(addedText))
    flags.push({ level: 'warn', message: 'adds a debug statement' });
  if (/(api[_-]?key|secret|password|token)\s*[:=]\s*['"`]/i.test(addedText))
    flags.push({ level: 'warn', message: 'possible hard-coded secret' });
  const removed = blob.removed;
  if (removed > 30) flags.push({ level: 'warn', message: `large deletion (−${removed} lines)` });
  // source file with no test sibling touched anywhere in the session
  if (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(rec.file) && !/\.(test|spec)\.|_test\.|test_/.test(rec.file)) {
    const stem = path.basename(rec.file).replace(/\.[^.]+$/, '');
    const hasTest = testFilesOf(log ?? readLog(sessionId)).some((f) => f.includes(stem));
    if (!hasTest) flags.push({ level: 'info', message: 'no test file changed for this source' });
  }
  return flags;
}

/** How many GENERATED follow-ups accompany Claude's own to-dos. They are one template per source file,
 *  so an uncapped list buries the handful of steps a human actually wrote. */
const HEURISTIC_STEP_CAP = 8;

/** Session-level heuristic next-steps (zero-token). */
export function heuristicSuggestions(sessionId: string): string[] {
  const log = reviewEdits(sessionId); // DISPLAY units, so this agrees with the panels it advises about
  const out: string[] = [];
  const pending = log.filter((r) => r.status === 'pending').length;
  if (pending) out.push(`${pending} edit(s) still pending review — Accept or Revert them.`);
  const files = new Set(log.map((r) => r.file));
  for (const f of files) {
    if (!/\.(ts|tsx|js|jsx|py|go|rs)$/.test(f) || /\.(test|spec)\.|_test\.|test_/.test(f)) continue;
    const stem = path.basename(f).replace(/\.[^.]+$/, '');
    const hasTest = [...files].some((g) => /\.(test|spec)\.|_test\.|test_/.test(g) && g.includes(stem));
    if (!hasTest) out.push(`Add or update tests for ${path.basename(f)}.`);
  }
  // Rides flagInputs' blob-pair memo — the previous version re-read both blobs and re-diffed every
  // record on every Observations render (O(edits) blob reads + line diffs for an already-memoized answer).
  const todoFiles = log.filter((r) => {
    const blob = flagInputs(sessionId, r);
    return blob !== null && /\b(TODO|FIXME)\b/.test(blob.addedText);
  });
  for (const r of todoFiles) out.push(`Follow up on the TODO/FIXME added in ${path.basename(r.file)}.`);
  if (out.length === 0) out.push('No obvious follow-ups from these heuristics.');
  return out;
}

// --- Observations view-model (0.8.0): timeline-style coalesced runs + per-edit reasoning + recap ---

/** One edit inside a coalesced run — its ±lines, review status, and Claude's reasoning for it. */
export interface ObservationEdit {
  id: number;
  ts: number;
  added: number;
  removed: number;
  status: EditStatus;
  reasoning: string | null; // Claude's own words for this edit (reasoningByEdit), null when uncorrelated
}

/** A run of adjacent same-file edits — the timeline's ×N unit, with a combined delta. */
export interface ObservationRun {
  file: string; // absolute path
  rel: string; // root-relative, forward slashes
  count: number; // edits in the run (the ×N)
  added: number; // combined + across the run
  removed: number; // combined − across the run
  status: EditStatus; // worst-unreviewed-wins rollup (pending > undone > kept)
  edits: ObservationEdit[]; // members in chronological order (expand for per-edit Keep/Undo)
}

export interface Observations {
  recap: string; // session recap — see `recapSource` for where it came from
  /** WHERE the recap came from, because the three sources mean different things and were previously
   *  swapped silently: 'analysis' is a line Claude generated on request, 'title' is Claude Code's own
   *  auto-title, 'summary' is the last thing the assistant happened to say — presenting that last one
   *  unlabelled reads as a considered recap when it is just the tail of the transcript. '' when none. */
  recapSource: 'analysis' | 'title' | 'summary' | '';
  runs: ObservationRun[]; // most-recent activity first
  nextSteps: string[]; // still-open to-dos + heuristic follow-ups
  context: ContextSourcesReport; // what shaped this session (skills, plans, memory, instruction files)
}

/** Worst-unreviewed-wins status for a run (mirrors changemap.fileStatus, inlined to avoid a cycle). */
function runStatus(edits: ObservationEdit[]): EditStatus {
  if (edits.some((e) => e.status === 'pending')) return 'pending';
  if (edits.some((e) => e.status === 'undone')) return 'undone';
  return 'kept';
}

/**
 * The Observations view-model (zero token): the session's edits as a chronological timeline where
 * adjacent same-file edits coalesce into ×N runs (combined delta), each edit carrying Claude's own
 * reasoning, under a session recap with the still-open next steps at the end. Runs are ordered by
 * most-recent activity. Assembled ONCE here so the CLI `observations --json` and both editors render
 * the same payload. `root` sets the display-relative paths (defaults to cwd).
 */
export function buildObservations(cwd: string, sessionId: string, opts: { root?: string } = {}): Observations {
  const root = opts.root ?? cwd;
  const relOf = (file: string): string => path.relative(root, file).split(path.sep).join('/');
  const log = readLog(sessionId);
  const reasoning = reasoningByEdit(cwd, sessionId);
  const insights = transcriptInsights(cwd, sessionId);
  // ONE definition of the recap, shared by every surface. Core previously used `title ?? lastSummary`
  // while the CLI and VS Code used `cachedAnalysis('recap') ?? title` — so the same session read
  // "Plan mode is active…" in one editor and "No recap yet" in the other, and a generated recap
  // survived a restart in only one of them.
  const analysis = cachedAnalysis(sessionId, 'recap')?.text?.trim() || '';
  const recap = analysis || insights.title || insights.lastSummary || '';
  const recapSource: Observations['recapSource'] = analysis ? 'analysis' : insights.title ? 'title' : insights.lastSummary ? 'summary' : '';
  // Claude's OWN open to-dos come first and are never what gets cut — they were being sliced to 6
  // while the generated half ran unbounded (58 rows, 55 of them one template, one per source file).
  // The heuristic half is capped, and says how many it dropped rather than trailing off silently.
  const fromTranscript = transcriptSuggestions(cwd, sessionId);
  const heuristic = heuristicSuggestions(sessionId).filter((h) => !fromTranscript.includes(h));
  const shown = heuristic.slice(0, HEURISTIC_STEP_CAP);
  const hidden = heuristic.length - shown.length;
  const nextSteps = [
    ...new Set([...fromTranscript, ...shown]),
    ...(hidden > 0 ? [`… ${hidden} more heuristic follow-up${hidden === 1 ? '' : 's'} not shown.`] : []),
  ];

  // Walk the log in chronological (capture) order, merging consecutive same-file edits into one run.
  const runs: ObservationRun[] = [];
  for (const rec of log) {
    const d = lineDelta(sessionId, rec);
    const edit: ObservationEdit = {
      id: rec.id,
      ts: rec.ts,
      added: d.added,
      removed: d.removed,
      status: rec.status,
      reasoning: reasoning.get(rec.id) ?? null,
    };
    const last = runs[runs.length - 1];
    if (last && last.file === rec.file) {
      last.edits.push(edit);
      last.count++;
      last.added += d.added;
      last.removed += d.removed;
    } else {
      runs.push({ file: rec.file, rel: relOf(rec.file), count: 1, added: d.added, removed: d.removed, status: rec.status, edits: [edit] });
    }
  }
  for (const r of runs) r.status = runStatus(r.edits);
  // Most-recent activity first: the run's newest member ts (falls back to id order for ts-less records).
  const runTs = (r: ObservationRun): number => maxOf(r.edits.map((e) => e.ts || e.id));
  runs.sort((a, b) => runTs(b) - runTs(a));
  return { recap, recapSource, runs, nextSteps, context: contextSources(cwd, sessionId) };
}

// --- usage readout (context fill + rough 5h/week plan usage) for the sidebar status line ---

export interface UsageLine {
  ctx: { tokens: number; size: number; pct: number } | null; // context-window fill
  fiveHourPct: number | null; // 5-hour plan usage
  weekPct: number | null; // 7-day plan usage
  fiveReset: number | null; // reset time for the 5h window, epoch ms
  weekReset: number | null; // reset time for the 7-day window, epoch ms
  fiveTokens: number | null; // ~estimated tokens used in the 5h window
  weekTokens: number | null; // ~estimated tokens used in the 7-day window
  statuslineCache: boolean; // whether statusline-last.json was found — false ⇒ claude-statusline
  //                           isn't installed/writing on this host, so the 5h/week bars can't fill
  cachedAtMs: number | null; // statusline-last.json mtime, epoch ms — only the terminal TUI runs the
  //                            statusLine, so panel-only sessions leave the cache (and 5h/week) stale
  /**
   * Whether this account's plan reports rolling-window limits at all.
   *
   * Claude Code sends `rate_limits.*` ONLY for Claude.ai subscription plans (Pro/Max/Team). An
   * Enterprise or API account never receives it, so the 5h and weekly bars can never fill — and an
   * empty bar reads as "you have used none of your quota" when the truth is "this plan has no rolling
   * quota". `null` means nothing has reported either way yet (no status-line cache).
   *
   * Note what this does NOT claim: it says the plan reports no rolling windows, not that the account is
   * Enterprise specifically. API-key use produces the same signal, and there is nothing in the payload
   * that distinguishes them — so the UI must not label it "Enterprise".
   */
  rollingLimits: boolean | null;
  /** Measured token totals per rolling window, replacing the 5h/weekly bars on a plan that has no
   *  windows. Populated only when `rollingLimits === false`. Deliberately no percentage — there is no
   *  quota to divide by, and inventing a denominator would be the same wrong-by-plausible answer the
   *  empty bars already gave.
   *
   *  A LIST rather than fixed fields, because there are two sources with different windows: the status
   *  line measures 5h/7d (it anchors on the same clocks it draws), and this module's own fallback
   *  measures 24h/7d from `computeStats`. Whichever answers, the label travels with the number, so a
   *  row can never be drawn under a window it was not measured over. */
  localWindows: { label: string; tokens: number }[] | null;
}

/** Statusline cache older than this ⇒ the UI should surface its age and the terminal remedy. */
export const USAGE_STALE_MS = 5 * 60 * 1000;

/** Bytes read from the transcript's END when estimating context fill from its latest usage line —
 *  generous enough to clear a large trailing tool_result, yet a tiny slice of a 20-56MB file. */
const USAGE_TAIL_BYTES = 2 * 1024 * 1024;

/** Claude Code sends `resets_at` as either epoch seconds (a number) or an ISO string → epoch ms. */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000; // >1e12 already ms
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

/** The status line's usage row (its last line): context fill + 5h/week plan usage. Source of truth is
 *  the exact per-turn values claude-statusline persisted to `statusline-last.json`; if that's absent we
 *  fall back to a context estimate from the session transcript's latest usage (5h/week stay null). */
export function usageLine(cwd: string, sessionId: string): UsageLine {
  const out: UsageLine = {
    ctx: null,
    fiveHourPct: null,
    weekPct: null,
    fiveReset: null,
    weekReset: null,
    fiveTokens: null,
    weekTokens: null,
    statuslineCache: false,
    cachedAtMs: null,
    rollingLimits: null,
    localWindows: null,
  };
  const fin = (v: unknown): v is number => typeof v === 'number' && isFinite(v); // reject NaN from a corrupt cache
  const cachePath = path.join(claudeConfigDir(), 'statusline-last.json');
  try {
    const last = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    out.statuslineCache = true; // the cache exists and parsed — statusline is installed & writing
    out.cachedAtMs = fs.statSync(cachePath).mtimeMs;
    if (fin(last.ctx_pct)) {
      const size = fin(last.ctx_size) && last.ctx_size > 0 ? last.ctx_size : 200000;
      // ctx_used can be a stuck 0 (newer Claude Code builds stopped sending the context_window
      // token totals, so the statusline persists 0 while the percentage is real) — trust it only
      // when positive, otherwise derive tokens from the percentage so the bar never reads "0/1M".
      const tokens =
        fin(last.ctx_used) && last.ctx_used > 0 ? last.ctx_used : Math.round((last.ctx_pct / 100) * size);
      out.ctx = { tokens, size, pct: Math.min(100, last.ctx_pct) };
    }
    if (fin(last.five_pct)) out.fiveHourPct = Math.min(100, last.five_pct);
    if (fin(last.week_pct)) out.weekPct = Math.min(100, last.week_pct);
    out.fiveReset = toEpochMs(last.five_reset);
    out.weekReset = toEpochMs(last.week_reset);
    if (fin(last.five_tok) && last.five_tok > 0) out.fiveTokens = last.five_tok;
    if (fin(last.week_tok) && last.week_tok > 0) out.weekTokens = last.week_tok;
    // The status line has written a reading. If it carried no rolling percentages, this plan does not
    // have them — the statusline keeps the last known-good across a turn that omits rate_limits, so a
    // subscription account cannot flicker into this branch BETWEEN turns. It can land here transiently
    // on the very first turn of a brand-new cache (rate_limits arrive only with the first API response);
    // the next percentaged write heals it, and the merge semantics make that state permanent.
    out.rollingLimits = out.fiveHourPct !== null || out.weekPct !== null;
    // Prefer the status line's own measurement. It scans the same transcripts, but anchors its windows
    // on the reset clocks it draws — so taking its numbers is what keeps this panel and that line from
    // reporting two different totals for one account, which is the whole point of reading its cache.
    if (out.rollingLimits === false) {
      const w: { label: string; tokens: number }[] = [];
      if (fin(last.five_meas) && last.five_meas > 0) w.push({ label: '5h', tokens: last.five_meas });
      if (fin(last.week_meas) && last.week_meas > 0) w.push({ label: 'wk', tokens: last.week_meas }); // "wk", as the status line itself prints it
      if (w.length) out.localWindows = w;
    }
  } catch {
    /* no statusline cache yet (or corrupt JSON) — fall back to a transcript estimate below */
  }
  // A panel-only session never runs the statusLine, so the cache (and its ctx) can be arbitrarily
  // old while the transcript is live — prefer the transcript's ctx whenever it is newer. When a
  // terminal session is open the statusline rewrites the cache every render, so its exact values
  // still win. 5h/week always come from the cache: they have no other source.
  // Only on a plan with no rolling windows, so a Pro/Max account pays nothing for a readout it will
  // Fallback only: an older status line writes no measured totals, and this panel should still say
  // something true rather than nothing. ~51ms cold / ~7ms warm over this machine's transcripts.
  if (out.rollingLimits === false && out.localWindows === null) {
    try {
      const w = require('./stats').computeStats() as import('./stats').StatsResult;
      out.localWindows = [
        { label: '24h', tokens: w.windows.day.tokens },
        { label: 'wk', tokens: w.windows.week.tokens },
      ];
    } catch {
      /* a stats scan that fails is not a reason to lose the rest of the usage line */
    }
  }
  const transcript = findTranscript(cwd, sessionId);
  let transcriptNewer = false;
  if (transcript && out.cachedAtMs !== null) {
    try {
      transcriptNewer = fs.statSync(transcript).mtimeMs > out.cachedAtMs;
    } catch {
      /* transcript vanished between find and stat */
    }
  }
  if (!out.ctx || transcriptNewer) {
    if (transcript) {
      try {
        // Only the LATEST usage-bearing line matters, and it sits at the very end of the transcript
        // (the final assistant turn). Read a BOUNDED tail from EOF — never the whole 20-56MB file —
        // then scan it backwards for the first usage hit. If the last usage line happens to sit beyond
        // the tail window we keep the prior ctx (same as finding no usage line), rather than read it all.
        let latest: any = null;
        let tail = '';
        const fd = fs.openSync(transcript, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          const start = Math.max(0, size - USAGE_TAIL_BYTES);
          const buf = Buffer.alloc(size - start);
          const n = fs.readSync(fd, buf, 0, buf.length, start);
          tail = buf.toString('utf8', 0, n);
          if (start > 0) tail = tail.slice(tail.indexOf('\n') + 1); // started mid-file: drop the partial line
        } finally {
          fs.closeSync(fd);
        }
        const lines = tail.split('\n');
        for (let i = lines.length - 1; i >= 0 && !latest; i--) {
          const t = lines[i].trim();
          if (!t || !t.includes('"usage"')) continue;
          let o: any;
          try {
            o = JSON.parse(t);
          } catch {
            continue;
          }
          if (o?.isSidechain === true) continue; // a subagent's usage is not the main-chain context
          const u = o?.message?.usage;
          if (u && (u.input_tokens != null || u.cache_read_input_tokens != null)) latest = u;
        }
        if (latest) {
          const tokens =
            (latest.input_tokens || 0) +
            (latest.cache_read_input_tokens || 0) +
            (latest.cache_creation_input_tokens || 0);
          const size = tokens > 200000 ? 1000000 : 200000; // 1M-context sessions auto-detected
          out.ctx = { tokens, size, pct: Math.min(100, (tokens / size) * 100) };
        }
      } catch {
        /* unreadable transcript */
      }
    }
  }
  return out;
}
