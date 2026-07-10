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
import { resolveSessionId } from './session';
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
      checks.push({
        id: 'session',
        label: 'capture activity',
        level: 'warn',
        detail: `session ${session} resolves, but no edits have been captured yet.`,
        fix: 'If Claude has already edited files this session, the hooks were likely added mid-session — restart Claude Code.',
      });
    } else {
      checks.push({ id: 'session', label: 'capture activity', level: 'ok', detail: `session ${session} · ${log.length} edit(s)` });
    }
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
