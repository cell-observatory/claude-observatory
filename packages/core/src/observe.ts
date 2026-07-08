/**
 * Observations layer (zero-token): correlate each captured edit with Claude's ACTUAL reasoning from
 * the session transcript, plus cheap heuristic change-summaries, issue-flags, and next-step
 * suggestions. No model calls — the transcript already contains Claude's words.
 */
import * as fs from 'fs';
import * as path from 'path';
import { diffArrays } from 'diff';
import { EditRecord, readLog, readBlob } from './store';
import { projectDir } from './session';
import { claudeConfigDir } from './paths';

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

interface ToolUse {
  file: string;
  reasoning: string;
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
    // (isSidechain:true) their tool_uses must stay in the per-file queues to keep the store<->
    // transcript correlation aligned. Current Claude Code writes sidechains to separate
    // subagents/*.jsonl files, so subagent-made edits have no transcript counterpart at all — an
    // inherent limitation of the correlation, not something an exclusion here could fix.
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
    for (const b of msg.content) {
      if (b.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name)) {
        const f = b.input && (b.input.file_path || b.input.notebook_path);
        if (typeof f === 'string') out.push({ file: path.resolve(f), reasoning: lastReasoning });
      }
    }
  }
  return out;
}

/** Map edit id -> Claude's reasoning text, correlating store edits to transcript tool_uses per file. */
export function reasoningByEdit(cwd: string, sessionId: string): Map<number, string> {
  const map = new Map<number, string>();
  const transcript = findTranscript(cwd, sessionId);
  if (!transcript) return map;
  const byFile = new Map<string, string[]>();
  for (const e of parseToolUses(transcript)) {
    if (!byFile.has(e.file)) byFile.set(e.file, []);
    byFile.get(e.file)!.push(e.reasoning);
  }
  const cursor = new Map<string, number>();
  for (const rec of readLog(sessionId)) {
    const q = byFile.get(path.resolve(rec.file));
    if (!q) continue;
    const i = cursor.get(rec.file) ?? 0;
    if (i < q.length) {
      if (q[i]) map.set(rec.id, q[i]);
      cursor.set(rec.file, i + 1);
    }
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
}
export function transcriptInsights(cwd: string, sessionId: string): TranscriptInsights {
  const empty: TranscriptInsights = { todos: [], lastSummary: null, title: null };
  const p = findTranscript(cwd, sessionId);
  if (!p) return empty;
  let lines: string[];
  try {
    lines = fs.readFileSync(p, 'utf8').split('\n');
  } catch {
    return empty;
  }
  let todos: { content: string; status: string }[] = [];
  let lastSummary: string | null = null;
  let title: string | null = null;
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
  return { todos, lastSummary, title };
}

/** Pull a "Next steps / TODO / Follow-ups" bullet section out of Claude's recap (last summary). */
function recapNextSteps(summary: string): string[] {
  const heading = /^#{0,4}\s*\**\s*(next steps?|to-?dos?|follow[- ]?ups?|remaining|still to do)\b/i;
  const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)/;
  const out: string[] = [];
  let capturing = false;
  for (const raw of summary.split('\n')) {
    const line = raw.replace(/\s+$/, '');
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
  return sha === null ? null : readBlob(sessionId, sha).toString('utf8');
}

function addedLines(before: string, after: string): string[] {
  const tok = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) || [];
  const out: string[] = [];
  for (const p of diffArrays(tok(before), tok(after))) if (p.added) out.push(...p.value);
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
export function flagsFor(sessionId: string, rec: EditRecord, log?: EditRecord[]): Flag[] {
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  const flags: Flag[] = [];
  if (after === null) return [{ level: 'warn', message: 'file deleted' }];
  const added = addedLines(before ?? '', after);
  const addedText = added.join('');
  if (/\b(TODO|FIXME|XXX|HACK)\b/.test(addedText)) flags.push({ level: 'info', message: 'adds a TODO/FIXME' });
  if (/\b(console\.log|debugger|print\(|dbg!)\b/.test(addedText))
    flags.push({ level: 'warn', message: 'adds a debug statement' });
  if (/(api[_-]?key|secret|password|token)\s*[:=]\s*['"`]/i.test(addedText))
    flags.push({ level: 'warn', message: 'possible hard-coded secret' });
  const removed = before !== null ? addedLines(after, before).length : 0;
  if (removed > 30) flags.push({ level: 'warn', message: `large deletion (−${removed} lines)` });
  // source file with no test sibling touched anywhere in the session
  if (/\.(ts|tsx|js|jsx|py|go|rs)$/.test(rec.file) && !/\.(test|spec)\.|_test\.|test_/.test(rec.file)) {
    const files = new Set((log ?? readLog(sessionId)).map((r) => r.file));
    const stem = path.basename(rec.file).replace(/\.[^.]+$/, '');
    const hasTest = [...files].some((f) => /\.(test|spec)\.|_test\.|test_/.test(f) && f.includes(stem));
    if (!hasTest) flags.push({ level: 'info', message: 'no test file changed for this source' });
  }
  return flags;
}

/** Session-level heuristic next-steps (zero-token). */
export function heuristicSuggestions(sessionId: string): string[] {
  const log = readLog(sessionId);
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
  const todoFiles = log.filter((r) => {
    const after = blobText(sessionId, r.afterBlob);
    const before = blobText(sessionId, r.beforeBlob);
    return after !== null && /\b(TODO|FIXME)\b/.test(addedLines(before ?? '', after).join(''));
  });
  for (const r of todoFiles) out.push(`Follow up on the TODO/FIXME added in ${path.basename(r.file)}.`);
  if (out.length === 0) out.push('No obvious follow-ups from heuristics — run “Generate suggestions” for a deeper look.');
  return out;
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
}

/** Statusline cache older than this ⇒ the UI should surface its age and the terminal remedy. */
export const USAGE_STALE_MS = 5 * 60 * 1000;

/** Claude Code sends `resets_at` as either epoch seconds (a number) or an ISO string → epoch ms. */
function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? v : v * 1000; // >1e12 already ms
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

/** The status line's second line: context fill + 5h/week plan usage. Source of truth is the exact
 *  per-turn values claude-statusline persisted to `statusline-last.json`; if that's absent we fall
 *  back to a context estimate from the session transcript's latest usage (5h/week stay null). */
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
  };
  const fin = (v: unknown): v is number => typeof v === 'number' && isFinite(v); // reject NaN from a corrupt cache
  const cachePath = path.join(claudeConfigDir(), 'statusline-last.json');
  try {
    const last = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    out.statuslineCache = true; // the cache exists and parsed — statusline is installed & writing
    out.cachedAtMs = fs.statSync(cachePath).mtimeMs;
    if (fin(last.ctx_pct)) {
      const size = fin(last.ctx_size) && last.ctx_size > 0 ? last.ctx_size : 200000;
      const tokens = fin(last.ctx_used) ? last.ctx_used : Math.round((last.ctx_pct / 100) * size);
      out.ctx = { tokens, size, pct: Math.min(100, last.ctx_pct) };
    }
    if (fin(last.five_pct)) out.fiveHourPct = Math.min(100, last.five_pct);
    if (fin(last.week_pct)) out.weekPct = Math.min(100, last.week_pct);
    out.fiveReset = toEpochMs(last.five_reset);
    out.weekReset = toEpochMs(last.week_reset);
    if (fin(last.five_tok) && last.five_tok > 0) out.fiveTokens = last.five_tok;
    if (fin(last.week_tok) && last.week_tok > 0) out.weekTokens = last.week_tok;
  } catch {
    /* no statusline cache yet (or corrupt JSON) — fall back to a transcript estimate below */
  }
  // A panel-only session never runs the statusLine, so the cache (and its ctx) can be arbitrarily
  // old while the transcript is live — prefer the transcript's ctx whenever it is newer. When a
  // terminal session is open the statusline rewrites the cache every render, so its exact values
  // still win. 5h/week always come from the cache: they have no other source.
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
        // Only the LATEST usage-bearing line matters, so scan from the END and stop at the first
        // hit — on a 15MB transcript this parses a handful of lines instead of thousands.
        let latest: any = null;
        const lines = fs.readFileSync(transcript, 'utf8').split('\n');
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
