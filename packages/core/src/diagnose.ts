/**
 * Setup diagnostics — the rules and messaging behind `claude-observatory doctor`.
 *
 * Kept pure and environment-injected (binOnPath / jqPresent are probed by the CLI and passed in) so
 * it stays unit-testable and so any front-end can render the exact same checks via `doctor --json`.
 * This turns the tool's quiet setup footguns (hooks reverted mid-session, CLI not on PATH, a broken
 * settings.json) into explicit, actionable messages.
 */
import * as fs from 'fs';
import * as path from 'path';
import { claudeConfigDir } from './paths';
import { settingsPath, hooksInstalled, installedHookCommand, HOOK_MARKER } from './install';
import { resolveSessionId, hasAssistantRecord } from './session';
import { findTranscript } from './observe';
import { readLog } from './store';

export type CheckLevel = 'ok' | 'warn' | 'fail';

export interface Check {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  /** A concrete next action, present when level !== 'ok'. */
  fix?: string;
}

export interface DiagnoseInput {
  cwd: string;
  /** Whether `claude-observatory` resolves on PATH — the capture hook depends on it. null = unknown. */
  binOnPath?: boolean | null;
  /** Whether `jq` is available — the bundled status line needs it. null = unknown. */
  jqPresent?: boolean | null;
}

function settingsJsonValid(): boolean | null {
  const p = settingsPath();
  if (!fs.existsSync(p)) return null; // no file yet is not "invalid"
  try {
    JSON.parse(fs.readFileSync(p, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Writable if the dir — or the nearest existing ancestor `init` would create it under — is writable. */
function writable(dir: string): boolean {
  let d = dir;
  while (!fs.existsSync(d)) {
    const parent = path.dirname(d);
    if (parent === d) return false;
    d = parent;
  }
  try {
    fs.accessSync(d, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Render checks as portable markdown (shown in an editor tab by both front-ends). */
export function diagnoseMarkdown(checks: Check[]): string {
  const icon = (l: CheckLevel) => (l === 'ok' ? '✅' : l === 'warn' ? '⚠️' : '❌');
  const lines: string[] = ['# Claude Observatory — setup check', ''];
  for (const c of checks) {
    lines.push(`### ${icon(c.level)} ${c.label}`, c.detail);
    if (c.fix) lines.push('', `**Fix:** ${c.fix}`);
    lines.push('');
  }
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  lines.push(
    '---',
    '',
    fails
      ? `**${fails} problem(s) to fix**${warns ? ` · ${warns} warning(s)` : ''}`
      : warns
        ? `Critical checks passed · ${warns} warning(s)`
        : 'All checks passed 🎉'
  );
  return lines.join('\n') + '\n';
}

/** Run every setup check and return them in report order (most foundational first). */
export function diagnose(input: DiagnoseInput): Check[] {
  const checks: Check[] = [];
  const cfg = claudeConfigDir();
  const usingOverride = Boolean(process.env.CLAUDE_CONFIG_DIR);

  // settings.json must parse before anything can read or write hooks.
  const valid = settingsJsonValid();
  checks.push(
    valid === false
      ? {
          id: 'settings-json',
          label: 'settings.json is valid JSON',
          level: 'fail',
          detail: `${settingsPath()} is not valid JSON — capture hooks can't be read or installed.`,
          fix: 'Fix the JSON (or restore the .bak beside it), then re-run `claude-observatory init`.',
        }
      : {
          id: 'settings-json',
          label: 'settings.json is valid JSON',
          level: 'ok',
          detail: valid === null ? `no settings.json yet (${settingsPath()})` : `${settingsPath()} parses cleanly`,
        }
  );

  // The capture hooks are the whole mechanism — without them nothing is tracked.
  const installed = hooksInstalled();
  checks.push(
    installed
      ? { id: 'hooks', label: 'capture hooks installed', level: 'ok', detail: 'PreToolUse/PostToolUse hooks are present' }
      : {
          id: 'hooks',
          label: 'capture hooks installed',
          level: 'fail',
          detail: 'no capture hooks in settings.json — Claude edits are not being tracked.',
          fix: 'Run `claude-observatory init` with Claude Code CLOSED (a running session reverts mid-session hook edits).',
        }
  );

  // The hook command is `claude-observatory capture …` resolved from PATH; if the bin is missing there,
  // capture silently no-ops — the single most common "it's just not working" cause.
  if (input.binOnPath === false) {
    checks.push({
      id: 'bin-path',
      label: '`claude-observatory` on PATH',
      level: 'fail',
      detail: 'the capture hook runs `claude-observatory` from PATH, but it does not resolve here — capture will silently do nothing.',
      fix: 'Add the global npm bin dir (`$(npm prefix -g)/bin`) to your PATH, or reinstall the CLI.',
    });
  } else if (input.binOnPath === true) {
    checks.push({ id: 'bin-path', label: '`claude-observatory` on PATH', level: 'ok', detail: 'resolves on PATH' });
  }

  // A legacy/absolute hook command is brittle across machines and repo moves.
  const cmd = installedHookCommand();
  if (installed && cmd && !cmd.includes(HOOK_MARKER)) {
    checks.push({
      id: 'hook-shape',
      label: 'hook uses the portable marker',
      level: 'warn',
      detail: `the installed hook looks legacy/absolute: ${cmd}`,
      fix: 'Re-run `claude-observatory init` to migrate to the portable PATH-based hook.',
    });
  }

  // The store lives under the config dir; if it isn't writable, capture can't record.
  checks.push(
    writable(cfg)
      ? {
          id: 'config-dir',
          label: 'config dir writable',
          level: 'ok',
          detail: `${cfg}${usingOverride ? ' (CLAUDE_CONFIG_DIR)' : ''}`,
        }
      : {
          id: 'config-dir',
          label: 'config dir writable',
          level: 'fail',
          detail: `${cfg} is not writable — the edit store can't be updated.`,
          fix: 'Check permissions on the config dir (or CLAUDE_CONFIG_DIR, if set).',
        }
  );

  // "The directory is writable" and "a setting persists" are different claims, and only the second
  // one is what a channel switch depends on. A bind-mounted overlay or a network filesystem can
  // accept a write and not keep it, which makes `update --channel dev` report success and change
  // nothing — the exact shape that looks like a broken feature rather than a broken mount.
  checks.push(channelRoundTrips(cfg));

  // A resolvable session with real capture activity is the proof the whole chain works end-to-end.
  const session = resolveSessionId(input.cwd);
  if (!session) {
    checks.push({
      id: 'session',
      label: 'active session resolves',
      level: 'warn',
      detail: `no Claude Code session resolves for ${input.cwd}`,
      fix: 'Run doctor from your workspace root, or start a Claude Code session there.',
    });
  } else {
    const log = readLog(session);
    if (installed && log.length === 0) {
      // Distinguish the two honest no-edits cases so the fix advice never points at working hooks:
      // a session with no assistant reply yet (command-only stub / first turn in flight) vs a real
      // session that simply hasn't run an Edit/Write yet.
      const transcript = findTranscript(input.cwd, session);
      if (transcript && !hasAssistantRecord(transcript)) {
        checks.push({
          id: 'session',
          label: 'capture activity',
          level: 'warn',
          detail: `session ${session} resolves but has no assistant reply yet (command-only or just-started session).`,
          fix: 'The hooks are fine. If an earlier session holds your edits, pick it explicitly (session picker in the sidebar, or the claudeObservatory.session setting).',
        });
      } else {
        checks.push({
          id: 'session',
          label: 'capture activity',
          level: 'warn',
          detail: `session ${session} resolves, but no edits have been captured yet.`,
          fix: 'Normal for a fresh or read-only session. If Claude HAS edited files this session, the hooks were likely added mid-session — restart Claude Code.',
        });
      }
    } else {
      checks.push({ id: 'session', label: 'capture activity', level: 'ok', detail: `session ${session} · ${log.length} edit(s)` });
    }
  }

  // Bash capture walks the real directory tree only: a symlinked subtree is skipped (loop safety),
  // so its Bash-driven changes are invisible. Surface the blind spot instead of leaving it silent.
  try {
    const symDirs = fs
      .readdirSync(input.cwd, { withFileTypes: true })
      .filter((e) => {
        // Per-entry guard: one dangling (ENOENT), circular (ELOOP), or unreadable (EACCES) link
        // must not abort the whole check and silently drop warnings for the genuine ones.
        if (!e.isSymbolicLink()) return false;
        try {
          return fs.statSync(path.join(input.cwd, e.name)).isDirectory();
        } catch {
          return false;
        }
      })
      .map((e) => e.name);
    if (symDirs.length > 0) {
      checks.push({
        id: 'symlink-subtrees',
        label: 'symlinked subtrees',
        level: 'warn',
        detail: `${symDirs.slice(0, 3).join(', ')}${symDirs.length > 3 ? ', …' : ''} — Bash-driven changes under symlinked directories are not captured.`,
        fix: 'Edit/Write captures still work everywhere; only the Bash tree diff skips symlinks (loop safety).',
      });
    }
  } catch {
    /* cwd unreadable — other checks already cover that */
  }

  // The status line powers the 5h/week usage bars — nice-to-have, not required.
  const statuslineOn = fs.existsSync(path.join(cfg, 'statusline-last.json'));
  checks.push(
    statuslineOn
      ? { id: 'statusline', label: 'status line active', level: 'ok', detail: 'usage cache present (plan-usage bars will render)' }
      : {
          id: 'statusline',
          label: 'status line active',
          level: 'warn',
          detail: `no usage cache yet — the 5h/week bars will be empty${input.jqPresent === false ? ' (jq not found; the status line needs bash + jq)' : ''}.`,
          fix: 'Run `claude-observatory statusline` to install the bundled status line.',
        }
  );

  return checks;
}


/** Write the channel marker, read it back, and restore it. Proves the setting SURVIVES, not merely
 *  that the write returned without an error. */
function channelRoundTrips(cfg: string): Check {
  const file = path.join(cfg, 'channel');
  let before: string | null = null;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch {
    before = null; // absent is fine — stable is the default
  }
  const probe = `${before && before.trim() === 'dev' ? 'stable' : 'dev'}\n`;
  try {
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(file, probe);
    const back = fs.readFileSync(file, 'utf8');
    // Restore whatever was there before probing, including "absent".
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before);
    if (back !== probe) {
      return {
        id: 'channel-persist',
        label: 'update channel persists',
        level: 'fail',
        detail: `${file} accepted a write but did not keep it — \`update --channel\` will report success and change nothing.`,
        fix: 'That filesystem is not keeping writes (common on a bind-mounted or network config dir). Point CLAUDE_CONFIG_DIR at a real local path.',
      };
    }
    return { id: 'channel-persist', label: 'update channel persists', level: 'ok', detail: `${file} round-trips` };
  } catch (e) {
    return {
      id: 'channel-persist',
      label: 'update channel persists',
      level: 'fail',
      detail: `cannot write ${file} (${(e as NodeJS.ErrnoException).code ?? 'error'}) — switching channels will fail.`,
      fix: 'Make the config dir writable by this user, or set CLAUDE_CONFIG_DIR to a writable path. In a devcontainer it is often bind-mounted read-only or owned by another uid.',
    };
  }
}
