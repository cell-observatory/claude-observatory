/**
 * Git-free, content-addressed snapshot store for Claude Observatory.
 *
 * Layout:  ~/.claude/claude-observatory/<session_id>/
 *   log.jsonl            append-only: EditRecord lines + status-op lines (`{op:"status",id,status}`)
 *   blobs/<sha256>       whole-file snapshots, content-addressed (deduped)
 *   staging/<pathHash>   transient "before" snapshot between PreToolUse and PostToolUse
 *
 * The log is strictly append-only — status changes are appended as ops and folded in on read, so a
 * front-end updating a status never rewrites the file and so cannot race-drop a record the capture
 * hook appends concurrently.
 *
 * Pure local filesystem — no network, no model calls, zero tokens.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { claudeConfigDir } from './paths';

export type EditStatus = 'pending' | 'kept' | 'undone';

export interface EditRecord {
  /** Monotonic per-session integer id — short and typeable for `diff <id>` / `undo <id>`. */
  id: number;
  /** ms epoch when the edit was committed (PostToolUse). */
  ts: number;
  /** Edit | Write | MultiEdit | NotebookEdit */
  tool: string;
  /** Absolute path of the edited file. */
  file: string;
  /** sha256 of the file BEFORE the edit, or null if the file did not exist (new-file Write). */
  beforeBlob: string | null;
  /** sha256 of the file AFTER the edit, or null if the edit deleted the file. */
  afterBlob: string | null;
  status: EditStatus;
}

/** Transient record written by PreToolUse, consumed by PostToolUse. */
export interface StagingRecord {
  file: string;
  tool: string;
  beforeBlob: string | null;
}

export function rootDir(): string {
  return path.join(claudeConfigDir(), 'claude-observatory');
}

export function storeDir(sessionId: string): string {
  return path.join(rootDir(), sessionId);
}

function blobsDir(sessionId: string): string {
  return path.join(storeDir(sessionId), 'blobs');
}

function stagingDir(sessionId: string): string {
  return path.join(storeDir(sessionId), 'staging');
}

export function logPath(sessionId: string): string {
  return path.join(storeDir(sessionId), 'log.jsonl');
}

export function ensureStore(sessionId: string): void {
  fs.mkdirSync(blobsDir(sessionId), { recursive: true });
  fs.mkdirSync(stagingDir(sessionId), { recursive: true });
}

/** Stable short key for a file path, used to name its staging record. */
export function pathKey(absFile: string): string {
  return crypto.createHash('sha256').update(absFile).digest('hex').slice(0, 16);
}

/** Write bytes to a content-addressed blob (idempotent). Returns the sha256 hex. */
export function writeBlob(sessionId: string, content: Buffer): string {
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const dest = path.join(blobsDir(sessionId), sha);
  if (!fs.existsSync(dest)) {
    fs.writeFileSync(dest, content);
  }
  return sha;
}

export function readBlob(sessionId: string, sha: string): Buffer {
  return fs.readFileSync(path.join(blobsDir(sessionId), sha));
}

// --- staging (transient before-snapshot) ---

export function writeStaging(sessionId: string, key: string, rec: StagingRecord): void {
  fs.writeFileSync(path.join(stagingDir(sessionId), `${key}.json`), JSON.stringify(rec));
}

export function readStaging(sessionId: string, key: string): StagingRecord | null {
  const p = path.join(stagingDir(sessionId), `${key}.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as StagingRecord;
  } catch {
    return null;
  }
}

export function deleteStaging(sessionId: string, key: string): void {
  const p = path.join(stagingDir(sessionId), `${key}.json`);
  try {
    fs.unlinkSync(p);
  } catch {
    /* already gone */
  }
}

// --- Bash capture manifest: before-snapshots of every candidate file for one Bash command ---

/** abs file path → before-blob sha (null = the file did not exist before the command). */
export interface BashManifest {
  files: Record<string, string | null>;
  ts: number;
}

const BASH_MANIFEST = '__bash__.json';

export function writeBashManifest(sessionId: string, m: BashManifest): void {
  fs.writeFileSync(path.join(stagingDir(sessionId), BASH_MANIFEST), JSON.stringify(m));
}

export function readBashManifest(sessionId: string): BashManifest | null {
  const p = path.join(stagingDir(sessionId), BASH_MANIFEST);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as BashManifest;
  } catch {
    return null;
  }
}

export function deleteBashManifest(sessionId: string): void {
  try {
    fs.unlinkSync(path.join(stagingDir(sessionId), BASH_MANIFEST));
  } catch {
    /* already gone */
  }
}

// --- log (append-only, source of truth) ---

interface StatusOp {
  op: 'status';
  id: number;
  status: EditStatus;
  ts: number;
}

/** Read the log, folding append-only status ops onto their edit records (in file order). */
export function readLog(sessionId: string): EditRecord[] {
  const p = logPath(sessionId);
  if (!fs.existsSync(p)) return [];
  const records: EditRecord[] = [];
  const byId = new Map<number, EditRecord>();
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj: EditRecord | StatusOp;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // skip a partially-written line
    }
    if ((obj as StatusOp).op === 'status') {
      const rec = byId.get((obj as StatusOp).id);
      if (rec) rec.status = (obj as StatusOp).status;
      continue;
    }
    const rec = obj as EditRecord;
    records.push(rec);
    byId.set(rec.id, rec);
  }
  return records;
}

/** Next monotonic id = max existing id + 1 (safe: hooks run serially within a session). */
export function nextId(sessionId: string): number {
  const log = readLog(sessionId);
  return log.reduce((m, r) => Math.max(m, r.id), 0) + 1;
}

export function appendLog(sessionId: string, rec: EditRecord): void {
  fs.appendFileSync(logPath(sessionId), JSON.stringify(rec) + '\n');
}

/**
 * Change one record's status by APPENDING a status op (never rewrites the file), then return the
 * updated record (or null if the id doesn't exist). Append-only = safe against a concurrent
 * capture-hook append.
 */
export function setStatus(sessionId: string, id: number, status: EditStatus): EditRecord | null {
  const rec = findRecord(sessionId, id);
  if (!rec) return null;
  if (rec.status === status) return rec; // no-op: don't append a redundant status op (avoids log bloat)
  const op: StatusOp = { op: 'status', id, status, ts: Date.now() };
  fs.appendFileSync(logPath(sessionId), JSON.stringify(op) + '\n');
  rec.status = status;
  return rec;
}

export function findRecord(sessionId: string, id: number): EditRecord | null {
  return readLog(sessionId).find((r) => r.id === id) ?? null;
}

export interface SessionInfo {
  id: string;
  edits: number;
  pending: number;
  lastMs: number; // mtime of log.jsonl (last activity)
}

/** All sessions in the store, newest activity first. */
export function listSessions(): SessionInfo[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(rootDir());
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const id of ids) {
    const lp = logPath(id);
    if (!fs.existsSync(lp)) continue;
    let lastMs = 0;
    try {
      lastMs = fs.statSync(lp).mtimeMs;
    } catch {
      /* ignore */
    }
    const log = readLog(id);
    out.push({ id, edits: log.length, pending: log.filter((r) => r.status === 'pending').length, lastMs });
  }
  return out.sort((a, b) => b.lastMs - a.lastMs);
}

/** Delete blobs in a session not referenced by any log record. Returns freed count + bytes. */
export function gcSession(sessionId: string): { removed: number; bytes: number } {
  const referenced = new Set<string>();
  for (const r of readLog(sessionId)) {
    if (r.beforeBlob) referenced.add(r.beforeBlob);
    if (r.afterBlob) referenced.add(r.afterBlob);
  }
  const dir = path.join(storeDir(sessionId), 'blobs');
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: 0, bytes: 0 };
  }
  let removed = 0;
  let bytes = 0;
  for (const name of names) {
    if (referenced.has(name)) continue;
    const p = path.join(dir, name);
    try {
      bytes += fs.statSync(p).size;
      fs.unlinkSync(p);
      removed++;
    } catch {
      /* ignore */
    }
  }
  return { removed, bytes };
}

/** Remove an entire session directory from the store. */
export function removeSession(sessionId: string): void {
  fs.rmSync(storeDir(sessionId), { recursive: true, force: true });
}

/**
 * Drop resolved (kept + undone) edits, keeping only pending ones — rewrites the log to just the
 * pending records and GCs the now-orphaned blobs. Returns how many resolved edits were removed.
 */
export function clearResolved(sessionId: string): number {
  const log = readLog(sessionId);
  const pending = log.filter((r) => r.status === 'pending');
  const removed = log.length - pending.length;
  if (removed === 0) return 0;
  const lp = logPath(sessionId);
  const tmp = lp + '.tmp';
  fs.writeFileSync(tmp, pending.length ? pending.map((r) => JSON.stringify(r)).join('\n') + '\n' : '');
  fs.renameSync(tmp, lp);
  gcSession(sessionId); // reclaim blobs referenced only by the removed edits
  return removed;
}
