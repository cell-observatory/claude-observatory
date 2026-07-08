/**
 * Single source of truth for the Claude config directory.
 *
 * Everything the observatory reads or writes lives under one directory: the edit store
 * (claude-observatory/), the per-session transcripts (projects/), the capture hooks in
 * settings.json, and the statusline usage cache (statusline-last.json). That directory is
 * CLAUDE_CONFIG_DIR when set — Claude Code's own override, commonly pointed at a mounted volume
 * inside a devcontainer so the store and history survive a container rebuild — otherwise ~/.claude.
 *
 * The capture hook runs as a subprocess of Claude Code and inherits the same CLAUDE_CONFIG_DIR, so
 * routing every path through here keeps the writer (hook) and the readers (CLI + VS Code sidebar)
 * pointed at the same place even when the config dir is relocated.
 */
import * as os from 'os';
import * as path from 'path';

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}
