/**
 * Capture hook logic for Claude Observatory.
 *
 * Wired as PreToolUse + PostToolUse hooks (matcher: Edit|Write|MultiEdit|NotebookEdit).
 * Snapshots the WHOLE file off disk before and after each edit — robust across all four tools
 * (including Write overwrites and .ipynb JSON) and independent of tool_input string shapes.
 *
 * HARD RULES (preserve zero-token, non-blocking behavior):
 *   - never write to stdout (nothing must reach the model context)
 *   - never throw out of runCapture(); the caller always exit(0)
 *   - a capture failure degrades silently and never blocks or slows Claude's edit
 *
 * Zero external deps (fs/path/crypto only) so the hook process stays lean & fast; in particular
 * this module must NOT import the `diff`-based undo engine.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  ensureStore,
  pathKey,
  writeBlob,
  writeStaging,
  readStaging,
  deleteStaging,
  appendLog,
  nextId,
} from './store';

const MAX_BYTES = 5 * 1024 * 1024; // skip files larger than 5 MB
const CAPTURED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; [k: string]: unknown };
  hook_event_name?: string;
}

type Snapshot =
  | { kind: 'missing' }
  | { kind: 'skip' }
  | { kind: 'text'; content: Buffer };

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function snapshot(file: string): Snapshot {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { kind: 'missing' };
  }
  if (!st.isFile()) return { kind: 'skip' };
  if (st.size > MAX_BYTES) return { kind: 'skip' };
  const buf = fs.readFileSync(file);
  if (isBinary(buf)) return { kind: 'skip' };
  return { kind: 'text', content: buf };
}

function resolveFile(payload: HookPayload): string | null {
  const ti = payload.tool_input || {};
  const f = ti.file_path || ti.notebook_path;
  if (typeof f !== 'string' || !f) return null;
  const cwd = payload.cwd || process.cwd();
  return path.isAbsolute(f) ? f : path.resolve(cwd, f);
}

function handlePre(session: string, payload: HookPayload): void {
  if (!CAPTURED_TOOLS.has(payload.tool_name || '')) return;
  const file = resolveFile(payload);
  if (!file) return;
  const key = pathKey(file);
  ensureStore(session);
  deleteStaging(session, key); // clear any stale before-snapshot for this path

  const s = snapshot(file);
  if (s.kind === 'skip') return; // binary/oversized — don't capture this edit
  const beforeBlob = s.kind === 'missing' ? null : writeBlob(session, s.content);
  writeStaging(session, key, { file, tool: payload.tool_name || 'unknown', beforeBlob });
}

function handlePost(session: string, payload: HookPayload): void {
  if (!CAPTURED_TOOLS.has(payload.tool_name || '')) return;
  const file = resolveFile(payload);
  if (!file) return;
  const key = pathKey(file);
  const staging = readStaging(session, key);
  if (!staging) return; // Pre skipped or didn't run — nothing reliable to commit

  const s = snapshot(file);
  if (s.kind === 'skip') {
    deleteStaging(session, key);
    return;
  }
  const afterBlob = s.kind === 'missing' ? null : writeBlob(session, s.content);

  // No real change (e.g. a MultiEdit that netted out, or identical rewrite) — don't log a no-op.
  if (staging.beforeBlob === afterBlob) {
    deleteStaging(session, key);
    return;
  }

  appendLog(session, {
    id: nextId(session),
    ts: Date.now(),
    tool: staging.tool,
    file,
    beforeBlob: staging.beforeBlob,
    afterBlob,
    status: 'pending',
  });
  deleteStaging(session, key);
}

/**
 * Read the hook payload from stdin and record the edit. Never throws, never writes stdout.
 * The caller is responsible for exit(0).
 */
export function runCapture(): void {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return;
    const payload = JSON.parse(raw) as HookPayload;
    const session = payload.session_id;
    if (!session) return;
    if (payload.hook_event_name === 'PreToolUse') handlePre(session, payload);
    else if (payload.hook_event_name === 'PostToolUse') handlePost(session, payload);
  } catch {
    // Silent by design: capture must never block, slow, or perturb an edit.
  }
}
