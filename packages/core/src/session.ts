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
