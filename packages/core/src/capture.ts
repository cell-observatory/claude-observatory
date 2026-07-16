/**
 * Capture hook logic for Claude Observatory.
 *
 * Wired as PreToolUse + PostToolUse hooks (matcher: Edit|Write|MultiEdit|NotebookEdit|Bash).
 * For the four file tools it snapshots the WHOLE named file off disk before and after the edit.
 * For Bash (which names no file) it snapshots the whole candidate tree under cwd before the command
 * and diffs it after, recording one edit per changed/created/deleted file — so Bash-driven changes
 * are fully undoable too. The Bash walk is bounded (skips vendor/build dirs, caps the file count) and
 * degrades silently when a tree is too large; set CLAUDE_OBSERVATORY_NO_BASH=1 to opt out entirely.
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
  writeBashManifest,
  readBashManifest,
  deleteBashManifest,
  appendLog,
  appendSkip,
} from './store';

const MAX_BYTES = 5 * 1024 * 1024; // skip files larger than 5 MB
const CAPTURED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Bash full-snapshot bounds — keep the per-command walk from ever hanging Claude on a huge tree.
const BASH_MAX_FILES = 4000;
const BASH_SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.cache', '__pycache__', '.gradle', '.idea',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'vendor', 'coverage', '.terraform',
]);

/**
 * Commonly secret-bearing file names. The Bash capture path snapshots the WHOLE cwd tree, so without
 * this it would vacuum unrelated `.env`/keys/credentials into the store — never do that. (A deliberate
 * Edit/Write to such a file is still captured, so undo keeps working; those blobs are written 0600.)
 * Patterns are simple/linear — no nested quantifiers — so they can't backtrack catastrophically.
 */
function isSecretName(name: string): boolean {
  return (
    /^\.env(\.|$)/i.test(name) || // .env, .env.local, .env.production
    /\.(pem|key|p12|pfx|keystore|jks)$/i.test(name) || // private keys / keystores
    /^id_(rsa|dsa|ecdsa|ed25519)$/i.test(name) || // ssh private keys
    /^\.(npmrc|netrc|pgpass|git-credentials)$/i.test(name) || // token-bearing dotfiles
    /(^|[._-])(secret|secrets|credential|credentials)([._-]|$)/i.test(name)
  );
}

export interface HookPayload {
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
  if (!staging) {
    // A real edit to a captured tool, but there's no before-snapshot: Pre skipped it (the file was
    // binary/oversized AT PRE-TIME) or PreToolUse never ran. We can't reconstruct the before, so the edit
    // isn't recorded — but it DID happen. Leave a marker (mirroring the post-time-skip branch below) so
    // `status` surfaces the gap instead of swallowing it silently. (no-silent-fail)
    appendSkip(session, file, 'edit not captured — no before-snapshot (binary/oversized at pre-time, or PreToolUse did not run)');
    return;
  }

  const s = snapshot(file);
  if (s.kind === 'skip') {
    // Pre snapshotted a before, but the file is now too large/binary to record — this edit is real
    // but untracked; leave a marker so `status` can surface it instead of failing silently.
    appendSkip(session, file, 'file too large (>5MB) or binary at commit — edit not captured');
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
    ts: Date.now(),
    tool: staging.tool,
    file,
    beforeBlob: staging.beforeBlob,
    afterBlob,
    status: 'pending',
  });
  deleteStaging(session, key);
}

/** Walk files under root, skipping vendor/build dirs and symlinks. Returns false if it hit the file
 *  cap (truncated) — the caller then degrades rather than record a partial/incorrect diff. */
function walkCandidates(root: string, onFile: (abs: string) => void): boolean {
  const stack: string[] = [root];
  let count = 0;
  while (stack.length) {
    const dir = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!BASH_SKIP_DIRS.has(e.name)) stack.push(full); // isDirectory() is false for symlinks → no loops
      } else if (e.isFile()) {
        if (++count > BASH_MAX_FILES) return false;
        onFile(full);
      }
    }
  }
  return true;
}

/** Bash Pre: snapshot the before-content of every candidate file under cwd into a manifest. */
function handlePreBash(session: string, payload: HookPayload): void {
  const cwd = payload.cwd;
  if (!cwd) return;
  ensureStore(session);
  deleteBashManifest(session); // clear any stale manifest from an interrupted command
  const files: Record<string, string | null> = {};
  const ok = walkCandidates(cwd, (abs) => {
    if (isSecretName(path.basename(abs))) return; // never sweep secrets into the store via the Bash walk
    const s = snapshot(abs);
    if (s.kind === 'text') files[abs] = writeBlob(session, s.content);
  });
  if (!ok) {
    // Tree too large to snapshot reliably — record one marker for the whole command rather than
    // half-capture (no manifest → Post no-ops).
    appendSkip(session, '<bash-tree>', `Bash working tree exceeds ${BASH_MAX_FILES} files — changes not captured`);
    return;
  }
  writeBashManifest(session, { files, ts: Date.now() });
}

/** Bash Post: diff the tree against the manifest and log one edit per changed/created/deleted file. */
function handlePostBash(session: string, payload: HookPayload): void {
  const cwd = payload.cwd;
  if (!cwd) return;
  const manifest = readBashManifest(session);
  if (!manifest) return; // Pre skipped/truncated — nothing reliable to diff
  const before = manifest.files;
  const seen = new Set<string>();
  const ok = walkCandidates(cwd, (abs) => {
    if (isSecretName(path.basename(abs))) return; // symmetric with Pre: secrets are out of scope
    seen.add(abs);
    const s = snapshot(abs);
    if (s.kind !== 'text') return;
    const afterBlob = writeBlob(session, s.content);
    const beforeBlob = Object.prototype.hasOwnProperty.call(before, abs) ? before[abs] : null;
    if (beforeBlob === afterBlob) return; // unchanged — no edit
    appendLog(session, { ts: Date.now(), tool: 'Bash', file: abs, beforeBlob, afterBlob, status: 'pending' });
  });
  // Deletions: present before, gone now. Only trust this when the post-walk wasn't truncated.
  if (ok) {
    for (const abs of Object.keys(before)) {
      if (seen.has(abs) || before[abs] === null) continue;
      appendLog(session, { ts: Date.now(), tool: 'Bash', file: abs, beforeBlob: before[abs], afterBlob: null, status: 'pending' });
    }
  }
  deleteBashManifest(session);
}

/**
 * Record one hook payload — the EXACT logic the Pre/PostToolUse hooks run (staging, blobs, appendLog),
 * exposed so the demo simulator can drive the real pipeline in-process (its keep/undo/task ops then
 * work on genuinely captured edits). Never throws, never writes stdout.
 */
export function handleHookPayload(payload: HookPayload): void {
  try {
    const session = payload.session_id;
    if (!session) return;
    const isBash = payload.tool_name === 'Bash';
    if (isBash && process.env.CLAUDE_OBSERVATORY_NO_BASH) return; // opt-out escape hatch
    if (payload.hook_event_name === 'PreToolUse') {
      if (isBash) handlePreBash(session, payload);
      else handlePre(session, payload);
    } else if (payload.hook_event_name === 'PostToolUse') {
      if (isBash) handlePostBash(session, payload);
      else handlePost(session, payload);
    }
  } catch {
    // Silent by design: capture must never block, slow, or perturb an edit.
  }
}

/**
 * Read the hook payload from stdin and record the edit. Never throws, never writes stdout.
 * The caller is responsible for exit(0).
 */
export function runCapture(): void {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return;
    handleHookPayload(JSON.parse(raw) as HookPayload);
  } catch {
    // Silent by design: capture must never block, slow, or perturb an edit.
  }
}
