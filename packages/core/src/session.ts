/**
 * Resolve the active Claude Code session id for a given working directory.
 *
 * Claude Code stores per-project transcripts at ~/.claude/projects/<mangled-cwd>/<session_id>.jsonl
 * where <mangled-cwd> is the ABSOLUTE launch cwd with every non-alphanumeric char replaced by '-'.
 * Verified: /Users/thayer/Github -> -Users-thayer-Github  (leading '/' becomes a leading '-').
 *
 * The newest .jsonl in that dir is the current session. Capture never needs this (the hook payload
 * supplies session_id directly) — it exists for the CLI and the VS Code sidebar.
 */
import * as fs from 'fs';
import * as path from 'path';
import { StringDecoder } from 'string_decoder';
import { claudeConfigDir } from './paths';

/** Mangle an absolute path the same way Claude Code names its project dirs. */
export function mangleCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// projectDir (and everything built on it: resolveSessionId, findTranscript, the store) resolves
// under claudeConfigDir(), the same CLAUDE_CONFIG_DIR-aware base that stats.transcriptFiles and
// usageLine use — so relocating the config dir (e.g. onto a mounted devcontainer volume) moves
// session resolution, the store, and usage together instead of splitting them across two roots.
export function projectDir(cwd: string): string {
  return path.join(claudeConfigDir(), 'projects', mangleCwd(cwd));
}

/** Newest session id in a specific project dir, or null if none / the dir doesn't exist. */
function newestSessionIn(dir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  let newest: { id: string; mtime: number } | null = null;
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    let mtime: number;
    try {
      mtime = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    if (!newest || mtime > newest.mtime) {
      newest = { id: name.slice(0, -'.jsonl'.length), mtime };
    }
  }
  return newest ? newest.id : null;
}

/**
 * Newest Claude Code session id for `cwd`, or null if none found. Walks up parent directories so a
 * CLI/sidebar invoked from a subdirectory still finds the session for the dir Claude was launched in
 * (returns the nearest ancestor that has one).
 */
export function resolveSessionId(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const s = newestSessionIn(projectDir(dir));
    if (s) return s;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Walk up from `cwd` to the nearest ancestor directory that holds a `.git` entry (file OR dir),
 * mirroring resolveSessionId's parent walk. Returns that directory (the repo/worktree root) or
 * null if none is found. The transcript `cwd` is Claude's launch cwd, frequently a subdirectory
 * (e.g. packages/foo) that has no `.git` of its own — so this walk-up is required before resolving
 * the shared common git dir.
 */
export function repoRoot(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A git dir is a bare repository iff its config says so — the honest signal for the bare guard. */
function isBareGitDir(gitDir: string): boolean {
  try {
    return /^\s*bare\s*=\s*true\s*$/im.test(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Git-free repo-identity key for `cwd`: the realpath of the shared common git directory, which is
 * identical across a main working tree and all its linked worktrees, so sessions launched from
 * sibling worktrees of one logical repo resolve to the SAME key. Reads only the plain files git
 * writes — never the git binary.
 *
 * From repoRoot(cwd), read `<root>/.git`:
 *   - a DIRECTORY -> a main working tree; key = realpath(<root>/.git).
 *   - a FILE      -> a linked worktree holding `gitdir: <admindir>`. Read `<admindir>/commondir`;
 *                    if relative (observed `../..`) resolve against <admindir>, else use as-is;
 *                    key = realpath(that).
 * realpath collapses symlinks (/tmp vs /private/tmp, /var vs /private/var) so both sides match.
 * Returns null for: no repo root, unreadable/missing (pruned) worktree admin files, or a bare
 * repository — no conventional main working tree to correlate (the honest guard).
 */
export function commonDir(cwd: string): string | null {
  const root = repoRoot(cwd);
  if (root === null) return null;
  const gitPath = path.join(root, '.git');
  let st: fs.Stats;
  try {
    st = fs.statSync(gitPath);
  } catch {
    return null;
  }
  if (st.isDirectory()) {
    // Main working tree: `.git` is a directory (never bare — bare repos have no `.git` child).
    try {
      return fs.realpathSync(gitPath);
    } catch {
      return null;
    }
  }
  // `.git` is a file: a linked worktree pointing at its admin dir via `gitdir: <admindir>`.
  let admindir: string;
  try {
    const m = fs.readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const raw = m[1].trim();
    admindir = path.isAbsolute(raw) ? raw : path.resolve(root, raw);
  } catch {
    return null;
  }
  let key: string;
  try {
    // `commondir` (not `gitdir`) points back at the shared repo; relative unless configured absolute.
    const raw = fs.readFileSync(path.join(admindir, 'commondir'), 'utf8').trim();
    const common = path.isAbsolute(raw) ? raw : path.resolve(admindir, raw);
    key = fs.realpathSync(common);
  } catch {
    return null; // missing / pruned worktree admin dir
  }
  return isBareGitDir(key) ? null : key;
}

// Cache the repo key by sessionId so grouping survives a worktree being pruned after first
// resolution (commonDir needs the live `.git` on disk). Only successful resolutions are cached —
// a transient miss (worktree not yet on disk) can be retried.
const repoKeyCache = new Map<string, string>();

/** commonDir(cwd) memoized by sessionId. Returns null when the cwd's repo can't be resolved. */
export function repoKeyForSession(sessionId: string, cwd: string): string | null {
  const hit = repoKeyCache.get(sessionId);
  if (hit !== undefined) return hit;
  const key = commonDir(cwd);
  if (key !== null) repoKeyCache.set(sessionId, key);
  return key;
}

export interface FirstCwdLine {
  cwd: string;
  sessionId: string | null;
  gitBranch: string | null;
}

function parseCwdLine(line: string): FirstCwdLine | null {
  if (!line) return null;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null; // tolerate non-JSON / partial lines (schema evolves)
  }
  if (o && typeof o.cwd === 'string' && o.cwd) {
    return {
      cwd: o.cwd,
      sessionId: typeof o.sessionId === 'string' ? o.sessionId : null,
      gitBranch: typeof o.gitBranch === 'string' ? o.gitBranch : null,
    };
  }
  return null;
}

// A transcript's first cwd-bearing line is immutable once written (transcripts are append-only), so
// cache successful resolutions by path. Only successes are cached — a still-growing brand-new file
// can be re-scanned next call.
const firstCwdCache = new Map<string, FirstCwdLine>();

/**
 * Scan a transcript for the FIRST line that actually carries `cwd` (Claude's launch cwd), skipping
 * leading queue-operation/metadata lines that have none — line 0 is NOT guaranteed to bear it, and
 * the first cwd line is not always the first `type:user`. Returns {cwd, sessionId, gitBranch} or
 * null. Reads incrementally (not a fixed prefix) so a large leading queue-operation line can't hide
 * the cwd line behind a byte cap — a real 20MB self-session's first cwd line sits ~380KB in. Bounded
 * by MAX_SCAN so a live refresh never loads a whole 20-34MB transcript.
 */
export function firstCwdLine(transcriptPath: string): FirstCwdLine | null {
  const cached = firstCwdCache.get(transcriptPath);
  if (cached) return cached;
  let fd: number;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const CHUNK = 256 * 1024;
    const MAX_SCAN = 32 * 1024 * 1024; // generous — the cwd line is near the top; bounds a pathological file
    const buf = Buffer.alloc(CHUNK);
    const decoder = new StringDecoder('utf8'); // handle multibyte split across chunk boundaries
    let offset = 0;
    let carry = '';
    while (offset < MAX_SCAN) {
      const n = fs.readSync(fd, buf, 0, CHUNK, offset);
      if (n === 0) break; // EOF
      offset += n;
      carry += decoder.write(buf.subarray(0, n));
      let nl: number;
      while ((nl = carry.indexOf('\n')) !== -1) {
        const hit = parseCwdLine(carry.slice(0, nl));
        carry = carry.slice(nl + 1);
        if (hit) {
          firstCwdCache.set(transcriptPath, hit);
          return hit;
        }
      }
      if (n < CHUNK) break; // short read => EOF
    }
    const tail = parseCwdLine(carry + decoder.end()); // final line with no trailing newline
    if (tail) {
      firstCwdCache.set(transcriptPath, tail);
      return tail;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
