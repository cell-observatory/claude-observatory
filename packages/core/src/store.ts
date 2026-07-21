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

/**
 * Loop-based min/max over a numeric array — the call-stack-safe replacement for `Math.min(...xs)` /
 * `Math.max(...xs)`, which spread the entire array as call arguments and throw `RangeError` once it
 * exceeds the engine's argument cap (~65-125k elements). Empty input yields Math's identity value
 * (Infinity / -Infinity), so an existing `xs.length ? minOf(xs) : fallback` guard keeps its fallback.
 */
export function minOf(nums: number[]): number {
  let m = Infinity;
  for (const n of nums) if (n < m) m = n;
  return m;
}
export function maxOf(nums: number[]): number {
  let m = -Infinity;
  for (const n of nums) if (n > m) m = n;
  return m;
}

export type EditStatus = 'pending' | 'kept' | 'undone';

export interface EditRecord {
  /** Monotonic per-session integer id — short and typeable for `diff <id>` / `undo <id>`. */
  id: number;
  /**
   * Collision-proof per-record token (pid + hrtime + counter), decoupled from the small display `id`.
   * Two capture processes that both fail the best-effort append lock can append the same display `id`;
   * `uid` never collides, so readLog can deterministically reconcile a duplicate display id (§2.7).
   * `appendLog` stamps one on every new record. Optional because records written before this field
   * existed (and synthetic/derived records) lack it — reconciliation keys on append order, so a missing
   * `uid` is tolerated.
   */
  uid?: string;
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

/**
 * A store session id must be a single, safe path segment (real ids are Claude Code UUIDs). This is
 * the guard against a crafted `--session`/`--drop` value escaping the store via `..` — the sink is a
 * recursive, forced rmSync in removeSession. `..`/`.` are rejected explicitly (they pass the class).
 */
export function isSafeSessionId(id: string): boolean {
  return typeof id === 'string' && id !== '.' && id !== '..' && /^[A-Za-z0-9._-]{1,128}$/.test(id);
}

export function storeDir(sessionId: string): string {
  if (!isSafeSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
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

// --- advisory lock: serializes log-MUTATING ops so the one rewrite path (clearResolved) and GC can
// never race a concurrent capture append. Reads stay lock-free (append-only + torn-line tolerance).

const LOCK_STALE_MS = 10_000; // a lock held longer than this is presumed a crashed holder → broken
const APPEND_LOCK_BUDGET_MS = 2000; // hot capture path: cap the wait, then proceed unlocked (still atomic)
const MAINT_LOCK_BUDGET_MS = 5000; // maintenance (clearResolved / gc) can afford to wait longer

// Synchronous sleep without a busy-loop: wait on an unshared word that is never notified.
const SLEEP_WORD = new Int32Array(new SharedArrayBuffer(4));
function sleepMs(ms: number): void {
  try {
    Atomics.wait(SLEEP_WORD, 0, 0, Math.max(0, ms));
  } catch {
    /* SharedArrayBuffer/Atomics unavailable — skip the backoff */
  }
}

function lockPath(sessionId: string): string {
  return path.join(storeDir(sessionId), '.lock');
}

/**
 * Acquire an exclusive advisory lock for a session (O_EXCL create of `.lock`). Best-effort: breaks a
 * stale lock (older than LOCK_STALE_MS, i.e. a crashed holder) and gives up after `budgetMs`, so a
 * wedged lock can never permanently block capture. Returns a release fn, or null if not acquired
 * (the caller proceeds unlocked — an append is still atomic; only cross-op ordering is lost).
 */
function acquireLock(sessionId: string, budgetMs: number): (() => void) | null {
  const p = lockPath(sessionId);
  const deadline = Date.now() + budgetMs;
  for (;;) {
    try {
      const fd = fs.openSync(p, 'wx'); // wx = O_CREAT|O_EXCL: fails if the lock already exists
      try {
        fs.writeSync(fd, String(process.pid));
      } catch {
        /* pid is advisory only */
      }
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(p);
        } catch {
          /* already broken/removed */
        }
      };
    } catch {
      // Lock exists (or storeDir is missing). Break it if stale; else back off and retry.
      let ageMs: number;
      try {
        ageMs = Date.now() - fs.statSync(p).mtimeMs;
      } catch {
        return null; // storeDir/lock unstatable — proceed unlocked
      }
      if (ageMs > LOCK_STALE_MS) {
        try {
          fs.unlinkSync(p);
        } catch {
          /* someone else broke it first */
        }
        continue;
      }
      if (Date.now() >= deadline) return null;
      sleepMs(25);
    }
  }
}

/** Run `fn` holding the session lock (best-effort — `fn` still runs if the lock couldn't be taken). */
function withLock<T>(sessionId: string, budgetMs: number, fn: () => T): T {
  const release = acquireLock(sessionId, budgetMs);
  try {
    return fn();
  } finally {
    if (release) release();
  }
}

export function ensureStore(sessionId: string): void {
  // 0700 dirs / 0600 files: the store holds whole-file snapshots (often of secret-bearing files) and
  // is designed to run on shared/SSH/devcontainer hosts — it must not be world/group-readable.
  fs.mkdirSync(blobsDir(sessionId), { recursive: true, mode: 0o700 });
  fs.mkdirSync(stagingDir(sessionId), { recursive: true, mode: 0o700 });
  // Tighten pre-existing dirs too (older installs created them at the 0755 default).
  for (const d of [rootDir(), storeDir(sessionId)]) {
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* best-effort */
    }
  }
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
    // tmp + atomic rename: a concurrent reader never sees a half-written blob, and a crash mid-write
    // leaves a `.tmp-*` (ignored by GC + reads) instead of a truncated file at the real sha path.
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    try {
      fs.renameSync(tmp, dest);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* lost the race to an identical-content writer — dest already exists */
      }
    }
  }
  return sha;
}

export function readBlob(sessionId: string, sha: string): Buffer {
  return fs.readFileSync(path.join(blobsDir(sessionId), sha));
}

// --- staging (transient before-snapshot) ---

export function writeStaging(sessionId: string, key: string, rec: StagingRecord): void {
  fs.writeFileSync(path.join(stagingDir(sessionId), `${key}.json`), JSON.stringify(rec), { mode: 0o600 });
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
  fs.writeFileSync(path.join(stagingDir(sessionId), BASH_MANIFEST), JSON.stringify(m), { mode: 0o600 });
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

// --- bash stat cache (memo for the whole-tree Bash walk; consumed by capture.ts) ---

export interface BashStatEntry {
  k: string; // `${mtimeMs}:${size}` at last read
  h?: string; // content blob sha; ABSENT ⇒ binary/oversized verdict (negative results cached too)
}
export interface BashStatCache {
  v: 1;
  wroteMs: number; // when this cache was written — drives the racily-clean re-hash epsilon
  files: Record<string, BashStatEntry>;
}

// Lives in the storeDir ROOT: staging/*.json is JSON-parsed as StagingRecords by gcSessionCore,
// and removeSession reaps the whole dir, so no separate lifecycle is needed.
const BASH_STATCACHE = 'statcache.json';

export function readBashStatCache(sessionId: string): BashStatCache {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(storeDir(sessionId), BASH_STATCACHE), 'utf8'));
    if (c && c.v === 1 && c.files && typeof c.files === 'object') return c as BashStatCache;
  } catch {
    /* absent or corrupt — cold cache */
  }
  return { v: 1, wroteMs: 0, files: {} };
}

export function writeBashStatCache(sessionId: string, cache: BashStatCache): void {
  cache.wroteMs = Date.now();
  const dest = path.join(storeDir(sessionId), BASH_STATCACHE);
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(tmp, dest); // atomic: a concurrent reader sees old-or-new, never a torn file
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* nothing to clean */
    }
  }
}

/** Blob names present right now — one readdir beats a per-cached-file existsSync by ~10x. */
export function blobPresence(sessionId: string): Set<string> {
  try {
    return new Set(fs.readdirSync(blobsDir(sessionId)));
  } catch {
    return new Set();
  }
}

/**
 * Session lock for the Bash Pre walk: holding it across snapshot+manifest-write means a concurrent
 * GC (clearResolved/clean, which takes the same lock) can never collect just-written before-blobs
 * in the gap before the manifest lands. NOTE appendLog takes this same lock — never append inside.
 */
export function withBashPreLock<T>(sessionId: string, fn: () => T): T {
  return withLock(sessionId, APPEND_LOCK_BUDGET_MS, fn);
}

// --- log (append-only, source of truth) ---

interface StatusOp {
  op: 'status';
  id: number;
  status: EditStatus;
  ts: number;
}

/** A real edit that capture could not snapshot (too large / binary / Bash tree too large). Recorded
 *  so the CLI/editors can tell the user "N change(s) weren't captured" instead of failing silently. */
export interface SkipOp {
  op: 'skip';
  file: string; // absolute path, or a short marker like '<bash-tree>' for a truncated Bash walk
  reason: string;
  ts: number;
}

/** Read the log, folding append-only status ops onto their edit records (in file order). */
export function readLog(sessionId: string): EditRecord[] {
  const p = logPath(sessionId);
  if (!fs.existsSync(p)) return [];
  const records: EditRecord[] = [];
  const byId = new Map<number, EditRecord>();
  const usedIds = new Set<number>();
  let maxId = 0;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let obj: EditRecord | StatusOp | SkipOp;
    try {
      obj = JSON.parse(t);
    } catch {
      continue; // skip a partially-written line
    }
    // Any line with an `op` is a control op, not an edit record: fold 'status', ignore the rest
    // (e.g. 'skip' markers, read separately by readSkips).
    if ((obj as { op?: string }).op) {
      if ((obj as StatusOp).op === 'status') {
        const rec = byId.get((obj as StatusOp).id);
        if (rec) rec.status = (obj as StatusOp).status;
      }
      continue;
    }
    const rec = obj as EditRecord;
    // §2.7 reconciliation: a residual unlocked append (two writers that both failed the lock) can put
    // two records on disk with the SAME display id. Deterministically re-key the LATER one (append
    // order) to a fresh id above every id seen so far, so byId / the status fold / undo targeting each
    // resolve to a distinct record. Depends only on records at-or-before this one, so effective ids are
    // stable across future appends (and `nextId`, reading this reconciled log, won't re-collide).
    if (usedIds.has(rec.id)) rec.id = maxId + 1;
    usedIds.add(rec.id);
    if (rec.id > maxId) maxId = rec.id;
    records.push(rec);
    byId.set(rec.id, rec);
  }
  return records;
}

/** Append a 'skip' marker (a real edit capture had to drop). Best-effort, under the lock. */
export function appendSkip(sessionId: string, file: string, reason: string): void {
  const op: SkipOp = { op: 'skip', file, reason, ts: Date.now() };
  withLock(sessionId, APPEND_LOCK_BUDGET_MS, () =>
    fs.appendFileSync(logPath(sessionId), JSON.stringify(op) + '\n', { mode: 0o600 })
  );
}

/** The 'skip' markers in a session's log (dropped, untracked changes). */
export function readSkips(sessionId: string): SkipOp[] {
  const p = logPath(sessionId);
  if (!fs.existsSync(p)) return [];
  const out: SkipOp[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.indexOf('"skip"') === -1) continue;
    try {
      const o = JSON.parse(t);
      if (o && o.op === 'skip') out.push(o as SkipOp);
    } catch {
      /* skip a partial line */
    }
  }
  return out;
}

/**
 * Next display id = max existing (reconciled) id + 1. `appendLog` calls this INSIDE the append lock so
 * two concurrent writers can't read the same max and collide (§2.7); reads the reconciled log, so a
 * re-keyed duplicate id is counted too and a subsequent append can't re-collide with it.
 */
export function nextId(sessionId: string): number {
  const log = readLog(sessionId);
  return log.reduce((m, r) => Math.max(m, r.id), 0) + 1;
}

// Per-process monotonic counter for uid: guarantees distinct uids even if two calls read the same
// hrtime tick within this process. pid distinguishes separate capture processes.
let uidCounter = 0;

/** Collision-proof per-record token: pid + high-res monotonic clock + a per-process counter. Two
 *  separate capture processes that both fail the append lock still get distinct uids (§2.7). */
function makeUid(): string {
  return `${process.pid.toString(36)}-${process.hrtime.bigint().toString(36)}-${(uidCounter++).toString(36)}`;
}

/**
 * Append a new edit record; returns it with the store-allocated `id` + `uid`.
 *
 * §2.7 single-writer hazard: the display `id` is allocated INSIDE the lock (folding `nextId` into the
 * locked append) so a concurrent writer can't read the same max and collide — the common-case fix.
 * The lock is best-effort (it can give up and proceed unlocked), so each record also carries a
 * collision-proof `uid`; any residual unlocked duplicate display id is reconciled deterministically on
 * read (readLog). The store owns id allocation: any `id` on the input object is ignored.
 */
export function appendLog(sessionId: string, rec: Omit<EditRecord, 'id' | 'uid'>): EditRecord {
  return withLock(sessionId, APPEND_LOCK_BUDGET_MS, () => {
    const full: EditRecord = { ...rec, id: nextId(sessionId), uid: makeUid() };
    fs.appendFileSync(logPath(sessionId), JSON.stringify(full) + '\n', { mode: 0o600 });
    return full;
  });
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
  withLock(sessionId, APPEND_LOCK_BUDGET_MS, () =>
    fs.appendFileSync(logPath(sessionId), JSON.stringify(op) + '\n', { mode: 0o600 })
  );
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
    if (!isSafeSessionId(id)) continue; // skip stray/foreign entries (also keeps storeDir from throwing)
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

/**
 * Delete blobs in a session not referenced by any log record — the actual GC (no lock; callers hold
 * it). Crucially it also treats blobs referenced by IN-FLIGHT captures as live: a `staging/<key>.json`
 * before-snapshot and every sha in the `__bash__.json` manifest belong to a PreToolUse whose
 * PostToolUse hasn't appended its record yet. Ignoring them would delete a blob the imminent edit
 * needs, leaving a permanently non-undoable record pointing at a missing blob.
 */
function gcSessionCore(sessionId: string): { removed: number; bytes: number } {
  const referenced = new Set<string>();
  for (const r of readLog(sessionId)) {
    if (r.beforeBlob) referenced.add(r.beforeBlob);
    if (r.afterBlob) referenced.add(r.afterBlob);
  }
  // In-flight before-snapshots not yet committed to the log.
  const sdir = stagingDir(sessionId);
  let staged: string[];
  try {
    staged = fs.readdirSync(sdir);
  } catch {
    staged = [];
  }
  for (const name of staged) {
    if (name === BASH_MANIFEST) {
      const m = readBashManifest(sessionId);
      if (m) for (const sha of Object.values(m.files)) if (sha) referenced.add(sha);
    } else if (name.endsWith('.json')) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(sdir, name), 'utf8')) as StagingRecord;
        if (rec && rec.beforeBlob) referenced.add(rec.beforeBlob);
      } catch {
        /* unparseable staging record — ignore */
      }
    }
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
    if (!/^[0-9a-f]{64}$/.test(name)) continue; // only blob files are GC candidates (skip in-flight .tmp-*)
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

/** Delete blobs in a session not referenced by any log record (or in-flight capture). Freed count + bytes. */
export function gcSession(sessionId: string): { removed: number; bytes: number } {
  return withLock(sessionId, MAINT_LOCK_BUDGET_MS, () => gcSessionCore(sessionId));
}

/** Every session dir present in the store — INCLUDING log-less stub dirs that listSessions skips
 *  (whole-tree Bash snapshots from sessions that never edited). `clean` iterates THIS so those
 *  dirs are reclaimable; every other consumer keeps the listSessions view. */
export function allStoreSessionIds(): string[] {
  try {
    return fs.readdirSync(rootDir()).filter((id) => {
      if (!isSafeSessionId(id)) return false;
      try {
        return fs.statSync(path.join(rootDir(), id)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/**
 * Remove a session dir that holds no reviewable state: no log.jsonl, empty staging, no blobs left
 * after GC. This reclaims stub-session husks; a live capture is protected by its staging entries
 * (pre-snapshot or bash manifest), and any blob surviving gcSession means a live reference — keep.
 */
export function pruneEmptySession(sessionId: string): boolean {
  try {
    if (fs.existsSync(logPath(sessionId))) return false; // has (or had) review state — keep
    const sdir = stagingDir(sessionId);
    if (fs.existsSync(sdir) && fs.readdirSync(sdir).length > 0) return false; // in-flight capture
    const bdir = blobsDir(sessionId);
    if (fs.existsSync(bdir) && fs.readdirSync(bdir).length > 0) return false; // live-referenced blobs
    removeSession(sessionId);
    return true;
  } catch {
    return false;
  }
}

/** Remove an entire session directory from the store. */
export function removeSession(sessionId: string): void {
  const dir = storeDir(sessionId); // throws on an invalid/traversing id
  const root = path.resolve(rootDir());
  const resolved = path.resolve(dir);
  // Defense in depth: never rm -rf anything that isn't a direct child of the store root.
  if (resolved === root || !resolved.startsWith(root + path.sep)) {
    throw new Error(`refusing to remove ${resolved}: outside the store`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** True when `file` is the scope path itself (exact file) or lives beneath it (folder prefix). The one
 *  rule shared by every `--under` operation, so file-scope and folder-scope match identically. */
export function isUnderPath(file: string, scope: string): boolean {
  return file === scope || file.startsWith(scope.endsWith(path.sep) ? scope : scope + path.sep);
}

/**
 * Drop resolved (kept + undone) edits, keeping every pending one — rewrites the log to just the
 * kept records and GCs the now-orphaned blobs. Returns how many resolved edits were removed.
 * With `under` set, only resolved edits at-or-beneath that path are dropped (scoped Clear for a file
 * or folder); pending edits and resolved edits outside the scope are preserved.
 */
export function clearResolved(sessionId: string, under?: string): number {
  // Whole read→rewrite→rename→GC runs under the lock so a concurrent capture appendLog (which also
  // takes the lock) can't be silently clobbered by the rename.
  return withLock(sessionId, MAINT_LOCK_BUDGET_MS, () => {
    const log = readLog(sessionId);
    const inScope = (r: EditRecord) => !under || isUnderPath(r.file, under);
    const keep = log.filter((r) => r.status === 'pending' || !inScope(r));
    const removed = log.length - keep.length;
    if (removed === 0) return 0;
    const lp = logPath(sessionId);
    const tmp = lp + '.tmp';
    fs.writeFileSync(tmp, keep.length ? keep.map((r) => JSON.stringify(r)).join('\n') + '\n' : '', { mode: 0o600 });
    fs.renameSync(tmp, lp);
    gcSessionCore(sessionId); // reclaim blobs referenced only by the removed edits (already locked)
    return removed;
  });
}

/**
 * Drop resolved (kept + undone) edits whose id is in `ids`, keeping every pending one — the id-scoped
 * counterpart to `clearResolved`, so a chapter's strict-span edit set (taskEditIds) can be cleared
 * without touching edits outside it. Pending edits in the set, and every edit outside it, are preserved.
 * Returns the count + the ids actually dropped.
 */
export function clearResolvedIds(sessionId: string, ids: number[]): { cleared: number; ids: number[] } {
  const want = new Set(ids);
  return withLock(sessionId, MAINT_LOCK_BUDGET_MS, () => {
    const log = readLog(sessionId);
    const dropped = log.filter((r) => want.has(r.id) && r.status !== 'pending').map((r) => r.id);
    if (dropped.length === 0) return { cleared: 0, ids: [] };
    const drop = new Set(dropped);
    const keep = log.filter((r) => !drop.has(r.id));
    const lp = logPath(sessionId);
    const tmp = lp + '.tmp';
    fs.writeFileSync(tmp, keep.length ? keep.map((r) => JSON.stringify(r)).join('\n') + '\n' : '', { mode: 0o600 });
    fs.renameSync(tmp, lp);
    gcSessionCore(sessionId); // reclaim blobs referenced only by the removed edits (already locked)
    return { cleared: dropped.length, ids: dropped };
  });
}
