/**
 * Installer: careful merge of the PreToolUse/PostToolUse capture hooks into ~/.claude/settings.json.
 * Shared by the CLI (`claude-observatory init`) and the VS Code extension so there is one source of truth.
 * Adds only the `hooks` entries; never disturbs existing permissions/statusLine/etc.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';

/** Stable, path-independent marker appended (as a shell comment) to our hook command. */
export const HOOK_MARKER = 'claude-observatory-hook';

interface HookCmd {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookCmd[];
}

export function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/** Project-scoped settings file (checked into a repo so teammates get capture). */
export function projectSettingsPath(cwd: string): string {
  return path.join(cwd, '.claude', 'settings.json');
}

/**
 * True if a command string is one of ours. Primary signal is the stable HOOK_MARKER (works no
 * matter where the repo/package lives); the path-based check is a fallback for legacy/manual entries.
 */
export function isOurCommand(cmd: string): boolean {
  if (cmd.includes(HOOK_MARKER)) return true;
  return /(claude[-_](observatory|changes)|claude_review)/.test(cmd) && /capture(\.js)?["']?\s*$/.test(cmd.trim());
}

function readSettings(file: string): { path: string; exists: boolean; data: any } {
  if (!fs.existsSync(file)) return { path: file, exists: false, data: {} };
  const data = JSON.parse(fs.readFileSync(file, 'utf8')); // throws on invalid JSON — caller handles
  return { path: file, exists: true, data };
}

/** Coerce a possibly-mangled settings value into a HookGroup[] (a hand-edited file may hold the
 *  wrong shape — e.g. an object where an array is expected). Never throws. */
function hookGroups(data: any, event: string): HookGroup[] {
  const v = data?.hooks?.[event];
  return Array.isArray(v) ? v : [];
}

/** Are our capture hooks already present (PreToolUse)? */
export function hooksInstalled(file: string = settingsPath()): boolean {
  let data: any;
  try {
    data = readSettings(file).data;
  } catch {
    return false;
  }
  return hookGroups(data, 'PreToolUse').some((g) =>
    (Array.isArray(g.hooks) ? g.hooks : []).some((h) => isOurCommand(h.command))
  );
}

/** The installed capture command (from PreToolUse), or null if not installed. */
export function installedHookCommand(file: string = settingsPath()): string | null {
  let data: any;
  try {
    data = readSettings(file).data;
  } catch {
    return null;
  }
  for (const g of hookGroups(data, 'PreToolUse')) {
    for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
      if (isOurCommand(h.command)) return h.command;
    }
  }
  return null;
}

function addTo(events: Record<string, HookGroup[]>, event: string, command: string): boolean {
  const list = (events[event] = events[event] || []);
  for (const g of list) {
    if ((g.hooks || []).some((h) => h.command === command)) return false; // dedupe
  }
  const group = list.find((g) => g.matcher === MATCHER);
  if (group) {
    group.hooks = group.hooks || [];
    group.hooks.push({ type: 'command', command });
  } else {
    list.push({ matcher: MATCHER, hooks: [{ type: 'command', command }] });
  }
  return true;
}

export interface InstallResult {
  changed: boolean;
  settingsPath: string;
  backupPath?: string;
}

/** Install both hook entries. `command` is the exact shell command Claude Code will run. */
export function installHooks(command: string, file: string = settingsPath()): InstallResult {
  const { path: p, exists, data } = readSettings(file);
  if (!exists) fs.mkdirSync(path.dirname(p), { recursive: true });
  const hooks = (data.hooks = data.hooks || {});
  const a = addTo(hooks, 'PreToolUse', command);
  const b = addTo(hooks, 'PostToolUse', command);
  const changed = a || b;
  let backupPath: string | undefined;
  if (changed) {
    // Back up the ORIGINAL file (only when we're actually going to modify it — a no-op re-init
    // must not clobber a good backup).
    if (exists) {
      backupPath = p + '.bak';
      fs.writeFileSync(backupPath, fs.readFileSync(p));
    }
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  }
  return { changed, settingsPath: p, backupPath };
}

/** Remove any of our capture hooks. */
export function uninstallHooks(file: string = settingsPath()): InstallResult {
  const { path: p, exists, data } = readSettings(file);
  if (!exists || !data.hooks) return { changed: false, settingsPath: p };
  const hooks = data.hooks as Record<string, HookGroup[]>;
  let changed = false;
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue; // leave a hand-mangled (non-array) shape untouched
    for (const g of hooks[event]) {
      const list = Array.isArray(g.hooks) ? g.hooks : [];
      const before = list.length;
      g.hooks = list.filter((h) => !isOurCommand(h.command));
      if (g.hooks.length !== before) changed = true;
    }
    hooks[event] = hooks[event].filter((g) => (Array.isArray(g.hooks) ? g.hooks : []).length > 0);
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (changed) {
    fs.writeFileSync(p + '.bak', fs.readFileSync(p));
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
  }
  return { changed, settingsPath: p };
}
