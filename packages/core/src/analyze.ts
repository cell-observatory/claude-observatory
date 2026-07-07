/**
 * Analysis layer (OPT-IN, token-spending): runs `claude -p` to deep-analyze an edit or generate
 * session suggestions, and caches the result in the store. Kept separate from the zero-token core;
 * the capture hook never imports this.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { findRecord, readBlob, readLog, storeDir } from './store';
import { summarize } from './observe';

export interface Analysis {
  kind: 'edit' | 'suggestions' | 'recap';
  key: string; // 'edit-<id>' | 'suggestions' | 'recap'
  text: string; // markdown (or a single sentence, for recap)
  ts: number;
}

function analysisDir(sessionId: string): string {
  return path.join(storeDir(sessionId), 'analysis');
}
export function analysisPath(sessionId: string, key: string): string {
  return path.join(analysisDir(sessionId), `${key}.json`);
}
export function cachedAnalysis(sessionId: string, key: string): Analysis | null {
  try {
    return JSON.parse(fs.readFileSync(analysisPath(sessionId, key), 'utf8')) as Analysis;
  } catch {
    return null;
  }
}
function save(sessionId: string, a: Analysis): void {
  fs.mkdirSync(analysisDir(sessionId), { recursive: true });
  const p = analysisPath(sessionId, a.key);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(a));
  fs.renameSync(tmp, p); // atomic: a concurrent cachedAnalysis() never reads a torn file
}

/** Best-effort location of the `claude` binary (GUI apps often lack ~/.local/bin on PATH). */
export function resolveClaudeBin(configured?: string): string {
  const cands = [
    configured,
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'claude'; // fall back to PATH
}

/** Run `claude -p` with `prompt` on stdin; resolve stdout. Rejects on spawn error / non-zero / timeout.
 *  When `resumeSessionId` is set, resumes that session (`--resume`) so Claude reuses its already-cached
 *  context — cheaper and better-grounded than re-sending code. Store session ids ARE Claude session ids. */
export function runClaude(
  prompt: string,
  opts: { timeoutMs?: number; claudeBin?: string; resumeSessionId?: string } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-p'];
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    const child = spawn(opts.claudeBin || 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('claude timed out'));
    }, opts.timeoutMs ?? 90000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    // A failed spawn (missing binary) also errors the stdin stream; without a handler that is an
    // UNHANDLED 'error' event that crashes the host process. The 'error'/'close' events on the
    // child itself carry the actionable failure, so stdin errors are safe to swallow.
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `claude exited with code ${code}`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function blobText(sessionId: string, sha: string | null): string {
  return sha ? readBlob(sessionId, sha).toString('utf8') : '';
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Try the cheap resume path first (Claude reuses its cached session context); on any failure —
 *  session locked / not resumable / older CLI — fall back to the self-contained prompt on a fresh run. */
async function runResumeOrFresh(
  resumePrompt: string,
  freshPrompt: string,
  sessionId: string,
  opts: { timeoutMs?: number; claudeBin?: string }
): Promise<string> {
  try {
    return await runClaude(resumePrompt, { ...opts, resumeSessionId: sessionId });
  } catch {
    return runClaude(freshPrompt, opts);
  }
}

/** Deep-analyze one edit (summary / issues / suggestions) via claude -p; caches the markdown.
 *  Prefers resuming the session so Claude already has the file + its own reasoning in context. */
export async function analyzeEdit(
  sessionId: string,
  id: number,
  opts: { timeoutMs?: number; claudeBin?: string; reasoning?: string } = {}
): Promise<Analysis> {
  const rec = findRecord(sessionId, id);
  if (!rec) throw new Error(`no edit #${id}`);
  const base = path.basename(rec.file);
  const seed = opts.reasoning ? `\n\nWhat you said at the time: "${clip(opts.reasoning, 500)}"` : '';
  const ask =
    `Reply in brief markdown: **Summary** (one sentence), **Potential issues** (bullets or "none"), ` +
    `**Suggestions** (bullets or "none"). Be concise.`;
  // Cheap: resume — no need to re-send the code, Claude still has it cached.
  const resumePrompt = `Review edit #${id} you made this session to \`${base}\` (${rec.tool}).${seed}\n\n${ask}`;
  // Fallback: self-contained (fresh claude, blobs pasted in).
  const before = rec.beforeBlob ? blobText(sessionId, rec.beforeBlob) : '(new file)';
  const after = rec.afterBlob ? blobText(sessionId, rec.afterBlob) : '(deleted)';
  const freshPrompt =
    `Review ONE code change Claude Code made to \`${base}\`.${seed}\n\n` +
    `BEFORE:\n\`\`\`\n${before}\n\`\`\`\n\nAFTER:\n\`\`\`\n${after}\n\`\`\`\n\n${ask}`;
  const text = await runResumeOrFresh(resumePrompt, freshPrompt, sessionId, opts);
  const a: Analysis = { kind: 'edit', key: `edit-${id}`, text, ts: Date.now() };
  save(sessionId, a);
  return a;
}

/** Generate session-level next-steps + code suggestions via claude -p; caches the markdown.
 *  Prefers resuming the session (Claude already knows every edit it made) over re-sending a digest. */
export async function analyzeSuggestions(
  sessionId: string,
  opts: { timeoutMs?: number; claudeBin?: string } = {}
): Promise<Analysis> {
  const ask =
    `In brief markdown, give **Next steps** (bullets) and **Code suggestions** (bullets) — concrete, ` +
    `high-value follow-ups a reviewer should consider. Be concise.`;
  const resumePrompt = `Based on the edits you made in this session, ${ask[0].toLowerCase()}${ask.slice(1)}`;
  const digest = readLog(sessionId)
    .map((r) => {
      const sample = blobText(sessionId, r.afterBlob).split('\n').slice(0, 40).join('\n');
      return `### ${summarize(sessionId, r)} [${r.status}]\n\`\`\`\n${sample}\n\`\`\``;
    })
    .join('\n\n')
    .slice(0, 20000); // bound the fallback prompt
  const freshPrompt = `Here are the changes Claude Code made in this session:\n\n${digest}\n\n${ask}`;
  const text = await runResumeOrFresh(resumePrompt, freshPrompt, sessionId, opts);
  const a: Analysis = { kind: 'suggestions', key: 'suggestions', text, ts: Date.now() };
  save(sessionId, a);
  return a;
}

/** A one-line "what was I working on & where did I leave off" recap; prefers resume (cached context). */
export async function analyzeRecap(
  sessionId: string,
  opts: { timeoutMs?: number; claudeBin?: string } = {}
): Promise<Analysis> {
  const ask =
    'In ONE sentence, what was I working on in this session and where did I leave off? ' +
    'Reply with ONLY that sentence — no preamble, no quotes, no markdown.';
  const digest = readLog(sessionId)
    .map((r) => summarize(sessionId, r))
    .join('; ')
    .slice(0, 4000);
  const freshPrompt = `Here are the file changes made in a coding session:\n${digest}\n\n${ask}`;
  const raw = await runResumeOrFresh(ask, freshPrompt, sessionId, opts);
  const text = raw.trim().replace(/^["'`]|["'`]$/g, ''); // strip any wrapping quotes
  const a: Analysis = { kind: 'recap', key: 'recap', text, ts: Date.now() };
  save(sessionId, a);
  return a;
}
