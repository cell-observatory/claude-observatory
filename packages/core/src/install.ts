/**
 * Installer: careful merge of the PreToolUse/PostToolUse capture hooks into ~/.claude/settings.json.
 * Shared by the CLI (`claude-observatory init`) and the VS Code extension so there is one source of truth.
 * Adds only the `hooks` entries; never disturbs existing permissions/statusLine/etc.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';

export const MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';

/** Matchers shipped by earlier versions — migrated in place to MATCHER on re-init (adds Bash capture). */
const LEGACY_MATCHERS = ['Edit|Write|MultiEdit|NotebookEdit'];

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
  return path.join(claudeConfigDir(), 'settings.json');
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

/** readSettings for the WRITE paths: a malformed settings.json becomes a GUIDING error (naming the
 *  file and pointing at the .bak) instead of a raw SyntaxError. The read-only probes above degrade
 *  quietly, but a mutation must stop loudly so the user repairs the JSON before we rewrite it. */
function readSettingsForWrite(file: string): { path: string; exists: boolean; data: any } {
  try {
    return readSettings(file);
  } catch (e) {
    throw new Error(
      `Cannot parse ${file}: ${(e as Error).message}. Fix the JSON (a backup may exist at ${file}.bak) and retry.`
    );
  }
}

/** Atomically replace the settings file: write a temp sibling, then rename it into place, so a crash
 *  mid-write can never truncate the user's settings.json. Mirrors the cache writers (store/analyze).
 *  Callers write the .bak first, so a rare rename failure still leaves a recovery copy. */
function writeSettingsFile(p: string, data: any): void {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, p); // atomic: a concurrent reader sees old-or-new, never a torn file
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

/** Upgrade a pre-existing hook group (our command, an older matcher) to the current MATCHER, so
 *  re-running `init` extends an old install to also capture Bash — without adding a duplicate group. */
function migrateMatchers(hooks: Record<string, HookGroup[]>): boolean {
  let migrated = false;
  for (const event of Object.keys(hooks)) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    for (const g of list) {
      if (
        g.matcher &&
        g.matcher !== MATCHER &&
        LEGACY_MATCHERS.includes(g.matcher) &&
        (Array.isArray(g.hooks) ? g.hooks : []).some((h) => isOurCommand(h.command))
      ) {
        g.matcher = MATCHER;
        migrated = true;
      }
    }
  }
  return migrated;
}

export interface InstallResult {
  changed: boolean;
  settingsPath: string;
  backupPath?: string;
}

/** Install both hook entries. `command` is the exact shell command Claude Code will run. */
export function installHooks(command: string, file: string = settingsPath()): InstallResult {
  const { path: p, exists, data } = readSettingsForWrite(file);
  if (!exists) fs.mkdirSync(path.dirname(p), { recursive: true });
  const hooks = (data.hooks = data.hooks || {});
  const migrated = migrateMatchers(hooks);
  const a = addTo(hooks, 'PreToolUse', command);
  const b = addTo(hooks, 'PostToolUse', command);
  const changed = migrated || a || b;
  let backupPath: string | undefined;
  if (changed) {
    // Back up the ORIGINAL file (only when we're actually going to modify it — a no-op re-init
    // must not clobber a good backup).
    if (exists) {
      backupPath = p + '.bak';
      fs.writeFileSync(backupPath, fs.readFileSync(p));
    }
    writeSettingsFile(p, data);
  }
  return { changed, settingsPath: p, backupPath };
}

/** Remove any of our capture hooks. */
export function uninstallHooks(file: string = settingsPath()): InstallResult {
  const { path: p, exists, data } = readSettingsForWrite(file);
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
    writeSettingsFile(p, data);
  }
  return { changed, settingsPath: p };
}

/**
 * Revert the bundled status line — but ONLY if settings.json's `statusLine.command` still points at
 * OUR `<configDir>/statusline.sh` (never disturb a user's own custom statusLine). Also removes the
 * vendored script + its cache. Part of `uninstall --all`.
 */
export function uninstallStatusline(file: string = settingsPath()): {
  changed: boolean;
  settingsPath: string;
  scriptRemoved: boolean;
} {
  const { path: p, exists, data } = readSettingsForWrite(file);
  const ourScript = path.join(claudeConfigDir(), 'statusline.sh');
  let changed = false;
  const sl = data.statusLine as { command?: string } | undefined;
  if (exists && sl && typeof sl.command === 'string' && sl.command.includes(ourScript)) {
    delete data.statusLine;
    changed = true;
    fs.writeFileSync(p + '.bak', fs.readFileSync(p));
    writeSettingsFile(p, data);
  }
  let scriptRemoved = false;
  for (const f of [ourScript, path.join(claudeConfigDir(), 'statusline-last.json')]) {
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        if (f === ourScript) scriptRemoved = true;
      }
    } catch {
      /* best-effort */
    }
  }
  return { changed, settingsPath: p, scriptRemoved };
}
