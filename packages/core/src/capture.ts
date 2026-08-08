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
import * as os from 'os';
import * as path from 'path';
import { canonPath } from './paths';
import { ignoreContext } from './ignore';
import {
  ensureStore,
  pathKey,
  writeBlob,
  writeStaging,
  readStaging,
  lastRecordFor,
  deleteStaging,
  writeBashManifest,
  takeBashManifest,
  advancePendingManifests,
  deleteBashManifest,
  readBashStatCache,
  writeBashStatCache,
  blobPresence,
  withBashPreLock,
  appendLog,
  appendSkip,
  sweepIgnoredIfChanged,
  readBlob,
  EMPTY_BLOB,
  type BashStatCache,
} from './store';
import { blankLineOnlyChange } from './merge';

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
  /** The harness's id for this tool call, when it sends one. Current Claude Code builds do NOT include
   *  it in the hook payload; it is read opportunistically so that the day it appears, edit→reasoning
   *  correlation becomes an exact join instead of a nearest-in-time match. */
  tool_use_id?: string;
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

/**
 * Is the difference between these two snapshots nothing but blank lines?
 *
 * Fails CLOSED in every uncertain case — a create, a delete, an unreadable blob, or content that does
 * not round-trip as UTF-8 all answer `false` and get recorded. Dropping a change because we could not
 * check it would be the one outcome worse than recording a blank line.
 */
function blankLineOnly(session: string, beforeBlob: string | null, afterBlob: string | null): boolean {
  if (!beforeBlob || !afterBlob) return false; // a create or a delete is never "just whitespace"
  try {
    const b = readBlob(session, beforeBlob);
    const a = readBlob(session, afterBlob);
    // A file that does not survive a UTF-8 round-trip has no line model we can trust; `isBinary` only
    // screens for NUL, so Latin-1 and UTF-16 reach here.
    if (!Buffer.from(b.toString('utf8'), 'utf8').equals(b)) return false;
    if (!Buffer.from(a.toString('utf8'), 'utf8').equals(a)) return false;
    return blankLineOnlyChange(b.toString('utf8'), a.toString('utf8'));
  } catch {
    return false;
  }
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
  // canonPath: hook events can disagree about drive-letter case on Windows (#43) — one key per file.
  const abs = canonPath(path.isAbsolute(f) ? f : path.resolve(cwd, f));
  // `.observatoryignore` — never recorded. HERE and not in handlePre, because this is the one funnel
  // BOTH handlers use and both already treat null as "nothing to do". Refusing in Pre alone would
  // leave Post with no staging record, sending it down the appendSkip branch to write an "edit not
  // captured — no before-snapshot" marker for a file the reader asked us to leave alone.
  if (ignoreContext().ignored(abs)) return null;
  return abs;
}

/**
 * The directories this hook event touched, for the ignore sweep's stamp.
 *
 * Deliberately NOT `resolveFile`: that returns null for an ignored path, and an ignored path is
 * exactly the case whose directory the sweep most needs, because that is where the new rule lives.
 *
 * For a Bash tool this returns the working directory ALONE, which is why `handlePostBash` reports the
 * directories it actually wrote into instead. The walk records files at ANY depth under cwd, so
 * stamping cwd alone left the gate blind to a `.observatoryignore` created BELOW it: the rule refused
 * new captures immediately while the records it covered stayed in the store forever, because the
 * stamp could never move. Reproduced end to end before this was written.
 */
function editedDirs(payload: HookPayload): string[] {
  const cwd = payload.cwd || process.cwd();
  const f = (payload.tool_input || {}).file_path || (payload.tool_input || {}).notebook_path;
  if (typeof f === 'string' && f) {
    return [path.dirname(canonPath(path.isAbsolute(f) ? f : path.resolve(cwd, f)))];
  }
  return [canonPath(cwd)];
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

  // …nor a change that is only blank lines. Same rule, one step weaker: there is no decision for a
  // reviewer to make about an added or removed empty line, and an agent reformatting around an edit
  // produces them constantly. Recording one costs a row, a pending count and a click, and answers
  // nothing.
  if (blankLineOnly(session, staging.beforeBlob, afterBlob)) {
    deleteStaging(session, key);
    return;
  }

  // ALREADY RECORDED. A backgrounded Bash command's Post walks the tree in the middle of an edit and
  // logs what it finds, so both captures see one change — two rows, byte-identical, one attributed to
  // `Bash`, and undoing the first then refuses as a conflict with the second.
  //
  // The EDIT is the side that yields, never the walk: the walk's record is already in the log and its
  // snapshot is gone, so declining there loses the change outright when the edit turns out never to
  // land (PreToolUse fires before the permission prompt, and PostToolUse only on success — every
  // denied or failed edit leaves its staging record behind). Matching on the END STATE rather than on
  // the whole hop also covers the case where the command's walk recorded a WIDER transition than this
  // call did: appending the narrower one would break the file's chain.
  const lastForFile = lastRecordFor(session, file);
  if (lastForFile && lastForFile.afterBlob === afterBlob) {
    deleteStaging(session, key);
    return;
  }

  // Publish the after-blob on the staging record BEFORE appending. Until the record lands, nothing
  // else references this blob, and a concurrent GC (clean / clearResolved) would collect it — leaving
  // a committed edit pointing at a missing blob. gcSessionCore reads staging, so this closes the gap.
  if (afterBlob) writeStaging(session, key, { ...staging, afterBlob });

  appendLog(session, {
    ts: Date.now(),
    tool: staging.tool,
    file,
    beforeBlob: staging.beforeBlob,
    afterBlob,
    status: 'pending',
  });
  // A Bash snapshot taken BEFORE this edit still holds the old content, so that command's Post would
  // diff this change out of its own tree and record it a second time — as `tool: "Bash"`, with the
  // duplicate that makes undoing the first refuse. Same baseline advance the Bash path does; it just
  // never covered the edits captured beside it.
  advancePendingManifests(session, new Map([[file, afterBlob]]));
  deleteStaging(session, key);
}

/** Walk files under root, skipping vendor/build dirs and symlinks. Returns false if it hit the file
 *  cap (truncated) — the caller then degrades rather than record a partial/incorrect diff. */
function walkCandidates(root: string, onFile: (abs: string) => void): boolean {
  const stack: string[] = [root];
  let count = 0;
  // One matcher for the whole walk, so each directory's `.observatoryignore` is read once rather
  // than once per file under it.
  const ignore = ignoreContext();
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
        // An ignored directory is never descended — the same shape as BASH_SKIP_DIRS, so a rule on
        // `dist/` costs nothing rather than costing a walk of everything inside it.
        if (!BASH_SKIP_DIRS.has(e.name) && !ignore.ignored(full, true)) stack.push(full); // isDirectory() is false for symlinks → no loops
      } else if (e.isFile()) {
        if (ignore.ignored(full)) continue;
        if (++count > BASH_MAX_FILES) return false;
        onFile(full);
      }
    }
  }
  return true;
}

// git's "racily clean" rule: a same-size rewrite inside the same timestamp quantum as the cached
// stat is invisible to (mtimeMs,size). Re-hash any file whose mtime lands within this window of
// the cache's own write time — only files hot at cache-write time qualify, so the cost is ~zero.
const RACY_EPSILON_MS = 2000;

function statKey(st: fs.Stats): string {
  return `${st.mtimeMs}:${st.size}`;
}

/**
 * Content hash for a Bash-walk candidate via the stat cache: stat-only when (mtimeMs,size) is
 * unchanged AND the blob still exists (never trust cache presence as blob existence — routine GC
 * collects manifest-orphaned blobs, and a dangling beforeBlob would corrupt undo forever); read+
 * hash+blob only what changed. Negative verdicts (binary/oversized) are cached too — 2/3 of the
 * walked bytes are binaries the uncached path re-read on every single pass. Returns null for
 * vanished/non-file/binary/oversized candidates.
 */
function cachedSnapshotHash(session: string, abs: string, cache: BashStatCache, blobs: Set<string>): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const k = statKey(st);
  const hit = cache.files[abs];
  const racy = cache.wroteMs > 0 && Math.abs(st.mtimeMs - cache.wroteMs) < RACY_EPSILON_MS;
  if (hit && hit.k === k && !racy) {
    if (hit.h === undefined) return null; // known binary/oversized — skip without reading
    if (blobs.has(hit.h)) return hit.h; // GC-safe fast path
  }
  if (st.size > MAX_BYTES) {
    cache.files[abs] = { k };
    return null;
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  if (isBinary(buf)) {
    cache.files[abs] = { k };
    return null;
  }
  const h = writeBlob(session, buf);
  blobs.add(h);
  cache.files[abs] = { k, h };
  return h;
}

/** Bash Pre: snapshot the before-content of every candidate file under cwd into a manifest.
 *  Runs under the session lock so concurrent GC can't collect fresh blobs before the manifest
 *  lands; appendSkip happens AFTER release (appendLog takes the same lock — never append inside). */
/**
 * A directory the Bash full-tree snapshot must NOT treat as a working tree.
 *
 * The walk records every file whose content differs across the command, which is the right model for
 * a project directory and completely wrong for `$HOME` or a filesystem root: a session that ran
 * `install neovim` from the home directory recorded 2,445 "edits" — `.Xauthority`,
 * `.CFUserTextEncoding`, `.bash_history`, shell state, caches — against ONE real Write. None of them
 * were changes the agent made; they were files that happened to move while a command ran, and the
 * session's review list was 99.8% noise. Sweeping a person's home directory into a snapshot store is
 * also the wrong thing to do on its own terms.
 *
 * Deliberately narrow: a project without a VCS marker is still a project, so the test is the specific
 * pair of places that are never one, not a positive test for project-ness.
 */
function unwalkableRoot(dir: string): string | null {
  if (dir === path.parse(dir).root) return 'the filesystem root';
  let home: string;
  try {
    home = canonPath(os.homedir());
  } catch {
    return null;
  }
  return dir === home ? 'your home directory' : null;
}

function handlePreBash(session: string, payload: HookPayload): void {
  // Canonical drive-letter case for the tree every walk key derives from (#43): a Pre manifest keyed
  // C:\ against a Post walk keyed c:\ made every file a phantom create + delete pair.
  const cwd = payload.cwd ? canonPath(payload.cwd) : payload.cwd;
  if (!cwd) return;
  const refuse = unwalkableRoot(cwd);
  if (refuse) {
    ensureStore(session);
    // The manifest MUST be cleared before returning. `handlePostBash` no-ops only when there is no
    // manifest, so leaving a previous command's behind would have it diff that against a walk of the
    // very tree this branch exists to refuse — turning a guard into the bug it was written to stop.
    // OUR tree only: a refused $HOME command used to wipe every pending snapshot, so a repo command
    // running beside it captured nothing and never said so.
    withBashPreLock(session, () => deleteBashManifest(session, cwd));
    // A marker, not silence: a real Bash command ran and its changes are genuinely not captured, and
    // that is exactly what SkipOp exists to say. Written once per command, like the truncation case,
    // and AFTER the lock is released (appendSkip takes the same one).
    appendSkip(session, '<bash-tree>', `Bash ran in ${refuse} — its tree is not snapshotted, so changes made by this command are not captured`);
    return;
  }
  ensureStore(session);
  const truncated = withBashPreLock(session, () => {
    // NOTE: no longer clears other manifests. Each Pre owns its own file and each Post consumes the
    // one taken of its own tree, because Bash calls overlap (any backgrounded command runs beside
    // the next one) and a shared manifest had them diffing against each other's snapshots.
    const cache = readBashStatCache(session);
    const blobs = blobPresence(session);
    const files: Record<string, string | null> = {};
    const ok = walkCandidates(cwd, (abs) => {
      if (isSecretName(path.basename(abs))) return; // never sweep secrets into the store via the Bash walk
      const h = cachedSnapshotHash(session, abs, cache, blobs);
      if (h) files[abs] = h;
    });
    writeBashStatCache(session, cache); // verdicts are facts either way — persist even on truncation
    if (!ok) return true;
    writeBashManifest(session, { files, ts: Date.now(), root: cwd });
    return false;
  });
  if (truncated) {
    // Tree too large to snapshot reliably — record one marker for the whole command rather than
    // half-capture (no manifest → Post no-ops).
    appendSkip(session, '<bash-tree>', `Bash working tree exceeds ${BASH_MAX_FILES} files — changes not captured`);
  }
}

/** Bash Post: diff the tree against the manifest and log one edit per changed/created/deleted file.
 *  Unlocked like always: each changed file's blob is log-referenced by appendLog immediately after
 *  it is written, so the unreferenced window stays microseconds. */
function handlePostBash(session: string, payload: HookPayload): string[] {
  // Canonical drive-letter case for the tree every walk key derives from (#43): a Pre manifest keyed
  // C:\ against a Post walk keyed c:\ made every file a phantom create + delete pair.
  const cwd = payload.cwd ? canonPath(payload.cwd) : payload.cwd;
  if (!cwd) return [];
  // OUR command's snapshot: the oldest one taken of this same tree, consumed as it is read. Taking
  // "the manifest" unconditionally is what let a subtree walk diff against a repo-root snapshot.
  const manifest = takeBashManifest(session, cwd);
  if (!manifest) return []; // Pre skipped/truncated, or its manifest belongs to another tree
  const before = manifest.files;
  const seen = new Set<string>();
  const cache = readBashStatCache(session);
  const blobs = blobPresence(session);
  /**
   * Empty-file appearances and disappearances this command produced.
   *
   * The Bash walk INFERS edits from a before/after tree diff, so it sees every side effect of a
   * command, not only what the agent meant to change. A file that goes from absent to zero bytes (or
   * back) is the degenerate case: there is no content, so the diff is empty, and the row renders as
   * "+0 −0" with nothing behind it. One real session — `install neovim`, run from the home directory
   * — produced 2,241 of these out of 2,446 records: postgres relation stubs from `initdb`, plus
   * `.Xauthority`, `.tig_history`, `btmp`. 91.6% of the review list was rows with nothing to review.
   *
   * Counted, not swallowed: one marker per command says how many there were. Edit / Write /
   * NotebookEdit are untouched — a zero-byte file Claude created ON PURPOSE is a real edit.
   */
  let emptyNoise = 0;
  /** Directories this command actually recorded into — what the ignore sweep must stamp. The walk
   *  reaches any depth under cwd, so cwd alone is not the answer (see `editedDirs`). */
  const wrote = new Set<string>();
  /** file → the content this command recorded for it, so every other pending snapshot of this tree
   *  can be advanced past it (see `advancePendingManifests`). */
  const recorded = new Map<string, string | null>();
  const ok = walkCandidates(cwd, (abs) => {
    if (isSecretName(path.basename(abs))) return; // symmetric with Pre: secrets are out of scope
    seen.add(abs);
    const afterBlob = cachedSnapshotHash(session, abs, cache, blobs);
    if (afterBlob === null) return;
    const beforeBlob = Object.prototype.hasOwnProperty.call(before, abs) ? before[abs] : null;
    if (beforeBlob === afterBlob) return; // unchanged — no edit
    if (beforeBlob === null && afterBlob === EMPTY_BLOB) return void emptyNoise++;
    if (blankLineOnly(session, beforeBlob, afterBlob)) return; // blank-line churn is not a review unit
    wrote.add(path.dirname(abs));
    recorded.set(abs, afterBlob);
    // Attributed to the EDIT TOOL when one is mid-flight on this file (staging exists only between an
    // Edit/Write/MultiEdit's Pre and its Post). The walk is the capture that has to win — its snapshot
    // is consumed and cannot be replayed, so it never defers — but the row would otherwise blame
    // `Bash` for a change an edit tool made, purely because a backgrounded command's Post happened to
    // land first. That call's own Post then finds its end state already recorded and declines.
    const inflight = readStaging(session, pathKey(abs));
    appendLog(session, {
      ts: Date.now(),
      tool: inflight?.tool || 'Bash',
      file: abs,
      beforeBlob,
      afterBlob,
      status: 'pending',
    });
  });
  // Deletions: present before, gone now. Only trust this when the post-walk wasn't truncated.
  if (ok) {
    for (const abs of Object.keys(before)) {
      if (seen.has(abs) || before[abs] === null) continue;
      // STILL ON DISK — so this walk simply never visited it, and "deleted" would be a lie. The walk
      // does not reach everything under its root: it refuses to descend `BASH_SKIP_DIRS`, symlinked
      // directories and unreadable ones. A snapshot can hold such a key because a command running in
      // a SUBDIRECTORY recorded a change there and every pending snapshot containing that file was
      // advanced past it — so an ancestor's Post, whose own walk skips `build/`, would report the
      // file gone. The pair then chains into "file deleted", and undoing the real change refuses as
      // a conflict: the exact failure the advance exists to prevent. One stat per unseen key, and
      // only for keys a walk did not reach.
      if (fs.existsSync(abs)) continue;
      if (before[abs] === EMPTY_BLOB) {
        emptyNoise++; // symmetric with the creation case: an empty file removed has nothing to review
        continue;
      }
      wrote.add(path.dirname(abs));
      recorded.set(abs, null);
      appendLog(session, { ts: Date.now(), tool: 'Bash', file: abs, beforeBlob: before[abs], afterBlob: null, status: 'pending' });
    }
  }
  if (!ok) {
    // The walk stopped at the file cap, so "present before, gone now" cannot be told from "never
    // reached" — the deletion pass above is skipped. Say so: a command that removed a file and left
    // no record of it is exactly the silent miss this store refuses to ship.
    appendSkip(
      session,
      '<bash-tree>',
      `Bash working tree exceeds ${BASH_MAX_FILES} files — deletions by this command were not captured`
    );
  }
  if (emptyNoise) {
    appendSkip(
      session,
      '<bash-empty>',
      `${emptyNoise} zero-byte file(s) appeared or vanished while this command ran — no content to review, so they were not recorded`
    );
  }
  writeBashStatCache(session, cache);
  // NOT deleteBashManifest: `takeBashManifest` already consumed OURS, and wiping the rest would
  // destroy the snapshot an overlapping command is about to diff against — the second half of the
  // shared-manifest bug (its partner then captured nothing at all, silently).
  //
  // Instead, move those snapshots' baseline past what this command just recorded, or the overlapping
  // Post records the SAME change again — two identical rows, the second of which makes undoing the
  // first refuse as a conflict.
  advancePendingManifests(session, recorded);
  return [...wrote];
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
      // The directories the capture actually wrote into. A Bash walk reports its own, because only
      // it knows how deep beneath cwd the command reached.
      const touched = isBash ? handlePostBash(session, payload) : (handlePost(session, payload), editedDirs(payload));
      // Records written BEFORE a rule existed are the one case the refusal in `resolveFile` cannot
      // reach, so they are swept here. On the WRITE path deliberately: a read path is called dozens
      // of times per refresh by several processes at once, and a read that rewrites the store would
      // race every other reader. Gated on a stamp of the ignore files this session's directories can
      // see, so it rewrites once per rule change rather than once per edit — and it reports through a
      // control op, never through stdout (see the note at the top of this file).
      sweepIgnoredIfChanged(session, [...editedDirs(payload), ...touched]);
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
