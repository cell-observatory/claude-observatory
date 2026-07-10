/**
 * claude-observatory — standalone, git-free, per-edit Keep/Undo for Claude Code.
 *
 * Commands:
 *   init                 install the PreToolUse/PostToolUse capture hooks into ~/.claude/settings.json
 *   uninstall            remove those hooks again
 *   capture              internal hook entrypoint (invoked by Claude Code; never call by hand)
 *   list                 list edits in the active session
 *   diff <id>            colored before/after for one edit
 *   keep <id>            mark an edit kept (no disk change)
 *   undo <id> [--force]  surgically undo one edit; --force = per-file restore fallback
 *
 * Machine-readable surface (drives the JetBrains plugin): blob / locate / observe / usage, plus
 * --json on list / status / sessions / keep / undo / redo, and analyze / recap / suggest for the
 * opt-in `claude -p` layer. See `usage()` below.
 *
 * The `capture` path lazy-loads only the zero-dep capture module (no `diff`) so the hook stays fast.
 */
import type { EditRecord, FileMemory, InstallResult, StatMetrics } from '@claude-observatory/core';

/** Version read from the package manifest at runtime — one source of truth, so it can never drift. */
function version(): string {
  try {
    const fs = require('fs');
    const path = require('path');
    // dist/index.js → ../package.json (same layout in the repo and the published tarball).
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return '0.0.0';
  }
}

function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

const c = {
  dim: (s: string) => (isTTY() ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (isTTY() ? `\x1b[1m${s}\x1b[0m` : s),
  green: (s: string) => (isTTY() ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isTTY() ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isTTY() ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isTTY() ? `\x1b[36m${s}\x1b[0m` : s),
};

function fail(msg: string): never {
  process.stderr.write(c.red('claude-observatory: ') + msg + '\n');
  process.exit(1);
}

/** Machine-readable output for non-Node front-ends (the JetBrains plugin drives these). */
function emitJson(v: unknown): void {
  process.stdout.write(JSON.stringify(v));
}

// --- session resolution (shared shape with the VS Code front-end) ---

function getSessionId(args: string[]): string {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const i = args.indexOf('--session');
  let id: string | null = null;
  if (i >= 0 && args[i + 1]) id = args[i + 1];
  else if (process.env.CLAUDE_OBSERVATORY_SESSION) id = process.env.CLAUDE_OBSERVATORY_SESSION;
  else if (process.env.CLAUDE_CHANGES_SESSION) id = process.env.CLAUDE_CHANGES_SESSION; // legacy name
  else id = core.resolveSessionId(process.cwd());
  if (!id) {
    fail(
      `could not resolve an active Claude Code session for ${process.cwd()}.\n` +
        `  Run this from your workspace root, or pass --session <id>.`
    );
  }
  // Reject a traversing/garbage session id before it reaches any store path (read, write, or delete).
  if (!core.isSafeSessionId(id)) {
    fail(`invalid session id "${id}" (letters, digits, dot, dash, underscore only).`);
  }
  return id;
}

// --- init / uninstall: delegate the settings.json merge to the shared core installer ---

function captureCommand(_project: boolean): string {
  const { HOOK_MARKER } = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  // Portable hook: relies on the globally-installed `claude-observatory` bin being on PATH. Survives
  // moving/renaming the repo and works for teammates who `npm i -g`. The trailing shell-comment marker
  // makes the hook recognizable for status/uninstall regardless of where the package lives.
  return `claude-observatory capture #${HOOK_MARKER}`;
}

function cmdInit(project: boolean, withStatusline = false): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const command = captureCommand(project);
  const target = project ? core.projectSettingsPath(process.cwd()) : core.settingsPath();
  let res: InstallResult;
  try {
    res = core.installHooks(command, target);
  } catch {
    fail(`${target} is not valid JSON; fix it and re-run init.`);
  }
  // Companion status line (bundled): powers the 5h/week Usage bars in the sidebars. Install it in
  // the same run when asked; otherwise just point at it when it isn't active yet.
  const statuslineNote = withStatusline
    ? null
    : statuslineActive()
      ? null
      : c.dim('tip: `claude-observatory statusline` installs the bundled status line (plan-usage bars in the sidebars).\n');
  if (!res.changed) {
    process.stdout.write(c.yellow('claude-observatory hooks already installed — nothing to do.\n'));
    if (statuslineNote) process.stdout.write(statuslineNote);
    if (withStatusline) cmdStatusline();
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `installed capture hooks into ${res.settingsPath}\n` +
      (res.backupPath ? c.dim(`  backup: ${res.backupPath}\n`) : '') +
      c.dim(`  command: ${command}\n`) +
      (project
        ? c.yellow(
            '  note: project hooks call `claude-observatory` on PATH — teammates need it installed ' +
              '(npm i -g claude-observatory) for capture to run.\n'
          )
        : '') +
      `Edits made by Claude Code (Edit/Write/MultiEdit/NotebookEdit — plus files changed by Bash; ` +
      `set CLAUDE_OBSERVATORY_NO_BASH=1 to opt out) will now be tracked.\n`
  );
  if (statuslineNote) process.stdout.write(statuslineNote);
  if (withStatusline) cmdStatusline();
}

function cmdUninstall(project: boolean): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const target = project ? core.projectSettingsPath(process.cwd()) : core.settingsPath();
  let res: InstallResult;
  try {
    res = core.uninstallHooks(target);
  } catch {
    fail(`${target} is not valid JSON.`);
  }
  process.stdout.write(
    res.changed
      ? c.green('✓ ') + `removed capture hooks from ${res.settingsPath}\n`
      : 'no claude-observatory hooks found.\n'
  );
}

function cmdStatus(args: string[] = []): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const fs = require('fs');
  const installed = core.hooksInstalled();
  // Verify the installed hook points at a script that still exists — the #1 silent-failure mode
  // (repo moved / deleted after install, or a stale path on a teammate's machine).
  const cmd = core.installedHookCommand();
  const quoted = cmd ? cmd.match(/"([^"]+)"/) : null;
  // Legacy hooks embed an absolute script path (in quotes); the current portable hook is just
  // `claude-observatory capture #marker` and resolves the bin on PATH — probe THAT instead, else the
  // health check is silently inert (never fires) for every current install.
  const hookScript = quoted
    ? { path: quoted[1], ok: fs.existsSync(quoted[1]) }
    : cmd
      ? { path: 'claude-observatory (on PATH)', ok: onPath('claude-observatory') === true }
      : null;
  const session = core.resolveSessionId(process.cwd());
  const log = session ? core.readLog(session) : [];
  const by = (s: string) => log.filter((r) => r.status === s).length;

  if (args.includes('--json')) {
    emitJson({
      hooksInstalled: installed,
      hookScript,
      session,
      store: session ? core.storeDir(session) : null,
      lastCaptureTs: log.length ? Math.max(...log.map((r) => r.ts)) : null,
      counts: session
        ? { total: log.length, pending: by('pending'), kept: by('kept'), undone: by('undone') }
        : null,
    });
    return;
  }

  process.stdout.write(
    `capture hooks:   ${installed ? c.green('installed') : c.red('not installed — run `claude-observatory init`')}\n`
  );
  if (hookScript) {
    process.stdout.write(
      `hook script:     ${hookScript.path} ${hookScript.ok ? c.green('[ok]') : c.red('[not resolving — run `claude-observatory doctor`]')}\n`
    );
  }
  if (!session) {
    process.stdout.write(`active session:  ${c.dim('none for ' + process.cwd())}\n`);
    return;
  }
  const last = log.length ? core.relTime(Math.max(...log.map((r) => r.ts))) : 'never';
  process.stdout.write(
    `active session:  ${session}\n` +
      `store:           ${core.storeDir(session)}\n` +
      `last capture:    ${last}\n` +
      `edits:           ${log.length}  ${c.dim(`(${by('pending')} pending · ${by('kept')} kept · ${by('undone')} undone)`)}\n`
  );
}

/** Does `bin` resolve on PATH? Cross-platform; null if we couldn't determine it. */
function onPath(bin: string): boolean | null {
  const cp = require('child_process');
  try {
    const res =
      process.platform === 'win32'
        ? cp.spawnSync('where', [bin], { stdio: 'ignore' })
        : cp.spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
    if (res.error) return null;
    return res.status === 0;
  } catch {
    return null;
  }
}

/** `doctor` — diagnose the whole setup (hooks, PATH, config dir, session, status line) with fixes. */
function cmdDoctor(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const checks = core.diagnose({
    cwd: process.cwd(),
    binOnPath: onPath('claude-observatory'),
    jqPresent: onPath('jq'),
  });
  if (args.includes('--json')) {
    emitJson({ version: version(), checks });
    return;
  }
  if (args.includes('--markdown') || args.includes('--md')) {
    process.stdout.write(core.diagnoseMarkdown(checks));
    return;
  }
  const icon = (l: string) => (l === 'ok' ? c.green('✓') : l === 'warn' ? c.yellow('!') : c.red('✗'));
  process.stdout.write(c.bold(`claude-observatory doctor`) + c.dim(`  v${version()}\n\n`));
  for (const ch of checks) {
    process.stdout.write(`${icon(ch.level)} ${ch.label}\n    ${c.dim(ch.detail)}\n`);
    if (ch.fix) process.stdout.write(`    ${c.cyan('→ ' + ch.fix)}\n`);
  }
  const fails = checks.filter((ch) => ch.level === 'fail').length;
  const warns = checks.filter((ch) => ch.level === 'warn').length;
  process.stdout.write(
    '\n' +
      (fails
        ? c.red(`${fails} problem(s) to fix`) + (warns ? c.yellow(` · ${warns} warning(s)`) : '') + '\n'
        : warns
          ? c.yellow(`critical checks passed · ${warns} warning(s)`) + '\n'
          : c.green('all checks passed 🎉') + '\n')
  );
  process.exit(fails ? 1 : 0);
}

function cmdSessions(args: string[] = []): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const sessions = core.listSessions();
  if (args.includes('--json')) {
    emitJson({ active: core.resolveSessionId(process.cwd()), sessions });
    return;
  }
  if (sessions.length === 0) {
    process.stdout.write(c.dim('no sessions in the store yet.\n'));
    return;
  }
  const active = core.resolveSessionId(process.cwd());
  for (const s of sessions) {
    const mark = s.id === active ? c.green('● ') : '  ';
    process.stdout.write(
      `${mark}${c.bold(s.id)}  ${c.dim(`${s.edits} edit(s) · ${s.pending} pending · ${core.relTime(s.lastMs)}`)}\n`
    );
  }
  process.stdout.write(c.dim('\n● = resolves for this directory · use `--session <id>` to target another\n'));
}

// --- review commands ---

function relFile(file: string): string {
  const path = require('path');
  const r = path.relative(process.cwd(), file);
  return r && !r.startsWith('..') ? r : file;
}

function statusLabel(s: string): string {
  if (s === 'pending') return c.yellow('pending');
  if (s === 'kept') return c.green('kept');
  return c.dim('undone');
}

function cmdList(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  let log = core.readLog(session);

  // Filters: --pending | --kept | --undone, and --file <substring>
  const only = args.includes('--pending')
    ? 'pending'
    : args.includes('--kept')
      ? 'kept'
      : args.includes('--undone')
        ? 'undone'
        : null;
  if (only) log = log.filter((r) => r.status === only);
  const fi = args.indexOf('--file');
  if (fi >= 0 && args[fi + 1]) {
    const sub = args[fi + 1];
    log = log.filter((r) => r.file.includes(sub));
  }

  if (args.includes('--json')) {
    emitJson({
      session,
      edits: log.map((r) => {
        const d = core.lineDelta(session, r);
        return { id: r.id, ts: r.ts, tool: r.tool, file: r.file, status: r.status, added: d.added, removed: d.removed };
      }),
    });
    return;
  }

  if (log.length === 0) {
    process.stdout.write(c.dim(`no matching edits (session ${session}).\n`));
    return;
  }
  // group by file, preserve first-seen order
  const byFile = new Map<string, EditRecord[]>();
  for (const r of log) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file)!.push(r);
  }
  const pending = log.filter((r) => r.status === 'pending').length;
  process.stdout.write(
    c.bold(`${log.length} edit(s)`) +
      c.dim(`  ·  ${pending} pending${only ? ` · ${only} only` : ''}  ·  session ${session}\n\n`)
  );
  for (const [file, recs] of byFile) {
    process.stdout.write(c.cyan(relFile(file)) + '\n');
    for (const r of recs) {
      const { added, removed } = core.lineDelta(session, r);
      const delta = c.green(`+${added}`) + ' ' + c.red(`-${removed}`);
      process.stdout.write(
        `  ${c.bold('#' + r.id)}  ${statusLabel(r.status).padEnd(7)}  ${delta}  ${c.dim(
          r.tool
        )}  ${c.dim(core.relTime(r.ts))}\n`
      );
    }
    process.stdout.write('\n');
  }
  process.stdout.write(c.dim('diff <id> · keep <id> · undo <id>\n'));
}

function requireId(args: string[]): number {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--session') {
      i++; // skip the session VALUE so a numeric session id isn't mistaken for the edit id
      continue;
    }
    if (/^\d+$/.test(args[i])) {
      raw = args[i];
      break;
    }
  }
  if (!raw) fail('expected an edit id, e.g. `claude-observatory diff 3`');
  return parseInt(raw, 10);
}

function cmdDiff(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const id = requireId(args);
  const rec = core.findRecord(session, id);
  if (!rec) fail(`no edit #${id} in session ${session}`);
  process.stdout.write(core.coloredDiff(session, rec as EditRecord, isTTY()) + '\n');
}

function cmdKeep(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const json = args.includes('--json');
  // Bulk: --all (every pending) or --file <substr> (pending edits in matching files).
  const fi = args.indexOf('--file');
  if (args.includes('--all') || fi >= 0) {
    const fileSub = fi >= 0 ? args[fi + 1] : undefined;
    if (fi >= 0 && !fileSub) fail('`keep --file <substr>` requires a value');
    const targets = core
      .readLog(session)
      .filter((r) => r.status === 'pending' && (!fileSub || r.file.includes(fileSub)));
    for (const r of targets) core.setStatus(session, r.id, 'kept');
    if (json) {
      emitJson({ kept: targets.length, ids: targets.map((r) => r.id) });
      return;
    }
    process.stdout.write(
      c.green('✓ ') + `kept ${targets.length} edit(s)${fileSub ? ` in files matching "${fileSub}"` : ''}\n`
    );
    return;
  }
  const id = requireId(args);
  const rec = core.setStatus(session, id, 'kept');
  if (!rec) fail(`no edit #${id} in session ${session}`);
  if (json) {
    emitJson({ kept: 1, ids: [id] });
    return;
  }
  process.stdout.write(c.green('✓ ') + `kept edit #${id} (${relFile(rec.file)})\n`);
}

function cmdUndo(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const id = requireId(args);
  const force = args.includes('--force');
  const res = force ? core.restoreFile(session, id) : core.undoEdit(session, id);
  // --json: the full structured UndoResult, so a front-end can branch conflict → offer --force
  // instead of string-matching prose. Exit codes match the human path exactly.
  if (args.includes('--json')) {
    emitJson({ ok: res.ok, status: res.status, message: res.message });
    process.exit(res.status === 'conflict' ? 1 : res.ok ? 0 : 1);
  }
  if (res.status === 'conflict') {
    process.stdout.write(c.yellow('⚠ conflict: ') + res.message + '\n');
    process.exit(1);
  }
  process.stdout.write((res.ok ? c.green('✓ ') : c.red('✗ ')) + res.message + '\n');
  process.exit(res.ok ? 0 : 1);
}

function cmdRedo(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const id = requireId(args);
  const force = args.includes('--force');
  const res = force ? core.reapplyFile(session, id) : core.redoEdit(session, id);
  if (args.includes('--json')) {
    emitJson({ ok: res.ok, status: res.status, message: res.message });
    process.exit(res.status === 'conflict' ? 1 : res.ok ? 0 : 1);
  }
  if (res.status === 'conflict') {
    process.stdout.write(c.yellow('⚠ conflict: ') + res.message + '\n');
    process.exit(1);
  }
  process.stdout.write((res.ok ? c.green('✓ ') : c.red('✗ ')) + res.message + '\n');
  process.exit(res.ok ? 0 : 1);
}

function parseDuration(spec: string): number | null {
  const m = spec.match(/^(\d+)([dh])$/);
  if (!m) return null;
  return parseInt(m[1], 10) * (m[2] === 'd' ? 86400000 : 3600000);
}
function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function cmdClean(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  // Drop resolved (kept/undone) edits in the active session, keep pending.
  if (args.includes('--resolved')) {
    const n = core.clearResolved(getSessionId(args));
    process.stdout.write(c.green('✓ ') + `cleared ${n} resolved edit(s)\n`);
    return;
  }
  // Destructive: drop a specific session.
  const di = args.indexOf('--drop');
  if (di >= 0) {
    const id = args[di + 1];
    if (!id) fail('`--drop <session-id>` requires a session id');
    if (!core.isSafeSessionId(id)) fail(`invalid session id "${id}" — refusing to delete.`);
    core.removeSession(id);
    process.stdout.write(c.green('✓ ') + `dropped session ${id}\n`);
    return;
  }
  // Destructive: drop sessions inactive longer than N.
  const oi = args.indexOf('--older-than');
  if (oi >= 0) {
    const spec = args[oi + 1];
    const ms = spec ? parseDuration(spec) : null;
    if (ms === null) fail(`bad --older-than value "${spec ?? ''}" (use e.g. 30d or 12h)`);
    const stale = core.listSessions().filter((s) => s.lastMs < Date.now() - ms);
    for (const s of stale) core.removeSession(s.id);
    process.stdout.write(c.green('✓ ') + `dropped ${stale.length} session(s) inactive > ${spec}\n`);
    return;
  }
  // Destructive: drop everything.
  if (args.includes('--all')) {
    const all = core.listSessions();
    for (const s of all) core.removeSession(s.id);
    process.stdout.write(c.green('✓ ') + `dropped all ${all.length} session(s)\n`);
    return;
  }
  // Safe default: garbage-collect orphaned blobs (optionally scoped to --session <id>).
  const si = args.indexOf('--session');
  const only = si >= 0 ? args[si + 1] : undefined;
  const targets = only ? [only] : core.listSessions().map((s) => s.id);
  let removed = 0;
  let bytes = 0;
  for (const id of targets) {
    const r = core.gcSession(id);
    removed += r.removed;
    bytes += r.bytes;
  }
  process.stdout.write(
    c.green('✓ ') + `garbage-collected ${removed} orphaned blob(s), freed ${fmtBytes(bytes)}\n`
  );
}

function human(n: number): string {
  if (!Number.isFinite(n)) return '0'; // never render "NaNB" for a malformed metric
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
  if (n < 1e9) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  return (n / 1e9).toFixed(2) + 'B';
}

function cmdStats(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  let sid: string | undefined;
  const i = args.indexOf('--session');
  if (i >= 0 && args[i + 1]) sid = args[i + 1];
  else sid = core.resolveSessionId(process.cwd()) || undefined;
  const stats = core.computeStats(sid);
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify(stats));
    return;
  }
  const w = stats.windows;
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length));
  const metrics: [string, keyof StatMetrics][] = [
    ['edits', 'edits'],
    ['tokens', 'tokens'],
    ['messages', 'messages'],
    ['thinking', 'thinking'],
    ['output', 'output'],
  ];
  process.stdout.write(c.bold('Claude usage stats') + c.dim('   session · today · 7 days · 30 days\n\n'));
  process.stdout.write(c.dim(pad('', 11) + pad('session', 10) + pad('today', 10) + pad('7d', 10) + '30d\n'));
  for (const [label, key] of metrics) {
    process.stdout.write(
      pad(label, 11) +
        pad(human(w.session[key]), 10) +
        pad(human(w.day[key]), 10) +
        pad(human(w.week[key]), 10) +
        human(w.month[key]) +
        '\n'
    );
  }
  process.stdout.write(c.dim('\nthinking tokens are estimated (~chars/4); tokens include cache.\n'));
}

/** `summary` — a per-session review recap (kept/reverted per file + acceptance rate); --markdown to export. */
function cmdSummary(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const s = core.reviewSummary(session);
  if (args.includes('--json')) {
    emitJson(s);
    return;
  }
  if (args.includes('--markdown') || args.includes('--md')) {
    process.stdout.write(core.reviewSummaryMarkdown(s));
    return;
  }
  const pct = s.acceptanceRate === null ? '—' : `${Math.round(s.acceptanceRate * 100)}%`;
  process.stdout.write(
    c.bold('Review summary') +
      c.dim(`  session ${session}\n\n`) +
      `${s.total} edit(s) · ${c.yellow(s.pending + ' pending')} · ${c.green(s.kept + ' kept')} · ` +
      `${c.dim(s.undone + ' reverted')} · ${pct} accepted\n\n`
  );
  for (const f of s.files) {
    process.stdout.write(
      `  ${c.cyan(relFile(f.file))}  ${c.green('+' + f.added)} ${c.red('-' + f.removed)}  ` +
        `${c.dim(`${f.kept} kept · ${f.undone} reverted · ${f.pending} pending`)}\n`
    );
  }
  if (s.reverted.length) {
    process.stdout.write('\n' + c.dim('reverted: ') + s.reverted.map((r) => '#' + r.id).join(' ') + '\n');
  }
  process.stdout.write(c.dim('\nexport:  claude-observatory summary --markdown > review.md\n'));
}

// --- machine-readable commands for non-Node front-ends (JetBrains plugin, scripts) ---

/** Raw blob bytes to stdout (diff panes, chat prompts). */
function cmdBlob(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const sha = args.find((a) => /^[0-9a-f]{64}$/i.test(a));
  if (!sha) fail('expected a 64-hex blob sha, e.g. `claude-observatory blob <sha>`');
  try {
    process.stdout.write(core.readBlob(session, sha));
  } catch {
    fail(`no blob ${sha} in session ${session}`);
  }
}

/** Current line indices of every pending edit in a file, mapped into the LIVE buffer text supplied
 *  on stdin (which may be unsaved). Powers inline overlays; always emits JSON. */
function cmdLocate(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const path = require('path');
  const fs = require('fs');
  const session = getSessionId(args);
  const fi = args.indexOf('--file');
  const file = fi >= 0 ? args[fi + 1] : undefined;
  if (!file) fail('`locate --file <path>` is required (current buffer text on stdin)');
  const abs = path.resolve(file);
  let current: string;
  try {
    current = fs.readFileSync(0, 'utf8'); // stdin
  } catch {
    fail('locate reads the current buffer on stdin, e.g. `claude-observatory locate --file f.ts < f.ts`');
  }
  const placements = core
    .readLog(session)
    .filter((r) => r.status === 'pending' && r.file === abs)
    .map((r) => {
      const before = r.beforeBlob ? core.readBlob(session, r.beforeBlob).toString('utf8') : '';
      const after = r.afterBlob ? core.readBlob(session, r.afterBlob).toString('utf8') : '';
      return { id: r.id, lines: core.locateEditInCurrent(before, after, current) };
    });
  emitJson({ file: abs, placements });
}

/** The full folder→file→class→edit tree (with exact deltas) — the shared view-model for both editors. */
function cmdTree(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const ri = args.indexOf('--root');
  const root = ri >= 0 && args[ri + 1] ? args[ri + 1] : process.cwd();
  const fi = args.indexOf('--filter');
  const filter = fi >= 0 ? args[fi + 1] : undefined;
  emitJson(core.buildEditTree(session, { root, filter }));
}

/** One JSON payload for an Observations-style view: recap + per-edit reasoning/flags/memory. */
function cmdObserve(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const cwd = process.cwd();
  const log = core.readLog(session);
  const reasoning = core.reasoningByEdit(cwd, session);
  const insights = core.transcriptInsights(cwd, session);
  const recap = core.cachedAnalysis(session, 'recap')?.text ?? insights.title ?? null;
  const suggestions = [
    ...new Set([...core.transcriptSuggestions(cwd, session), ...core.heuristicSuggestions(session)]),
  ];
  const memCache = new Map<string, FileMemory>(); // fileMemory scans all sessions — once per file
  const edits = [...log].reverse().map((r) => {
    let mem = memCache.get(r.file);
    if (!mem) {
      mem = core.fileMemory(r.file);
      memCache.set(r.file, mem);
    }
    return {
      id: r.id,
      ts: r.ts,
      tool: r.tool,
      file: r.file,
      status: r.status,
      summary: core.summarize(session, r),
      reasoning: reasoning.get(r.id) ?? null,
      flags: core.flagsFor(session, r, log),
      memory: { summary: core.memorySummary(mem), risky: core.isRiskyFile(mem) },
      analysis: core.cachedAnalysis(session, `edit-${r.id}`)?.text ?? null,
    };
  });
  emitJson({ session, recap, insights, suggestions, edits });
}

/** The UsageLine snapshot (ctx / 5h / week) + the shared staleness threshold; always JSON. */
function cmdUsage(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const si = args.indexOf('--session');
  const sid = (si >= 0 && args[si + 1]) || core.resolveSessionId(process.cwd()) || '';
  emitJson({ ...core.usageLine(process.cwd(), sid), staleMs: core.USAGE_STALE_MS });
}

// --- opt-in `claude -p` analysis (token-spending; cached results are returned unless --fresh) ---

function claudeBinFrom(args: string[]): string {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const bi = args.indexOf('--claude-bin');
  return core.resolveClaudeBin(bi >= 0 ? args[bi + 1] : undefined);
}

function emitAnalysis(a: { key: string; text: string; ts: number }, cached: boolean, json: boolean): void {
  if (json) emitJson({ key: a.key, text: a.text, ts: a.ts, cached });
  else process.stdout.write(a.text + '\n');
}

async function cmdAnalyze(args: string[]): Promise<void> {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const id = requireId(args);
  const json = args.includes('--json');
  const cached = args.includes('--fresh') ? null : core.cachedAnalysis(session, `edit-${id}`);
  if (cached) return emitAnalysis(cached, true, json);
  const reasoning = core.reasoningByEdit(process.cwd(), session).get(id);
  const a = await core.analyzeEdit(session, id, { claudeBin: claudeBinFrom(args), reasoning });
  emitAnalysis(a, false, json);
}

async function cmdRecap(args: string[]): Promise<void> {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const json = args.includes('--json');
  const cached = args.includes('--fresh') ? null : core.cachedAnalysis(session, 'recap');
  if (cached) return emitAnalysis(cached, true, json);
  const a = await core.analyzeRecap(session, { claudeBin: claudeBinFrom(args) });
  emitAnalysis(a, false, json);
}

// --- bundled status line (vendored cell-observatory/claude-statusline installer) ---

/** The self-contained statusline installer shipped inside this npm package. */
function statuslineInstallerPath(): string {
  const path = require('path');
  // dist/index.js -> ../statusline/install-statusline.sh (same layout in the repo and the tarball)
  return path.join(__dirname, '..', 'statusline', 'install-statusline.sh');
}

/** True once the status line has written its cache — the signal the Usage bars need. */
function statuslineActive(): boolean {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const fs = require('fs');
  const path = require('path');
  return fs.existsSync(path.join(core.claudeConfigDir(), 'statusline-last.json'));
}

/** Install/refresh the bundled status line (idempotent; honors CLAUDE_CONFIG_DIR; needs bash+jq). */
function cmdStatusline(): void {
  const fs = require('fs');
  const cp = require('child_process');
  const script = statuslineInstallerPath();
  if (!fs.existsSync(script)) {
    fail(`bundled installer missing (${script}) — install from https://github.com/cell-observatory/claude-statusline`);
  }
  const res = cp.spawnSync('bash', [script], { stdio: 'inherit' });
  if (res.error) {
    const winHint = process.platform === 'win32' ? ' — on Windows run this from Git Bash or WSL' : '';
    fail(`could not run bash: ${res.error.message} (the status line needs bash + jq${winHint})`);
  }
  process.exit(res.status ?? 1);
}

async function cmdSuggest(args: string[]): Promise<void> {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const json = args.includes('--json');
  const cached = args.includes('--fresh') ? null : core.cachedAnalysis(session, 'suggestions');
  if (cached) return emitAnalysis(cached, true, json);
  const a = await core.analyzeSuggestions(session, { claudeBin: claudeBinFrom(args) });
  emitAnalysis(a, false, json);
}

// --- self-update: fetch the latest GitHub Release and reinstall the CLI (no registry, no deps) ---

const RELEASE_REPO = 'cell-observatory/claude-observatory';

/** GET a URL following redirects, resolving to the response body. Rejects on non-200. */
function httpGet(url: string, redirects = 5): Promise<Buffer> {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': 'claude-observatory', Accept: 'application/vnd.github+json' } },
      (res: any) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume();
          resolve(httpGet(headers.location, redirects - 1)); // asset URLs redirect to a CDN
          return;
        }
        if (statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${statusCode} for ${url}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timed out')));
  });
}

async function cmdUpdate(args: string[]): Promise<void> {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const current = version();
  let release: any;
  try {
    release = JSON.parse((await httpGet(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`)).toString('utf8'));
  } catch (e: any) {
    fail(`could not check for updates (need network access to github.com): ${e?.message || e}`);
  }
  const latest = String(release.tag_name || '').replace(/^v/i, '');
  if (!latest) fail('no published release found for the repository.');
  if (!core.isNewer(latest, current)) {
    process.stdout.write(c.green(`✓ claude-observatory is up to date (${current})\n`));
    return;
  }
  if (args.includes('--check')) {
    process.stdout.write(c.yellow(`update available: ${current} → ${latest}`) + c.dim('   run `claude-observatory update`\n'));
    return;
  }
  const assets: { name: string; browser_download_url: string }[] = release.assets || [];
  const tgz = assets.find((a) => /\.tgz$/.test(a.name));
  if (!tgz) fail(`release v${latest} has no CLI tarball asset to install.`);
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const cp = require('child_process');
  const dest = path.join(os.tmpdir(), tgz!.name);
  process.stdout.write(c.dim(`downloading ${tgz!.name} …\n`));
  fs.writeFileSync(dest, await httpGet(tgz!.browser_download_url));
  process.stdout.write(c.dim('installing globally (npm i -g) …\n'));
  const r = cp.spawnSync('npm', ['i', '-g', dest], { stdio: 'inherit' });
  if (r.status !== 0) fail(`npm install failed (exit ${r.status ?? '?'}). Try: npm i -g ${dest}`);
  process.stdout.write(
    c.green('✓ ') +
      `updated the CLI ${current} → ${latest}\n` +
      c.dim(`  editor extensions: re-run the installer, or install claude-observatory-vscode-v${latest}.vsix / -jetbrains-v${latest}.zip from the release.\n`)
  );
}

function usage(): void {
  process.stdout.write(
    `claude-observatory — per-edit Keep/Undo for Claude Code\n\n` +
      `  init [--project] [--with-statusline]\n` +
      `                       install capture hooks (--project = repo ./.claude/settings.json;\n` +
      `                       --with-statusline also installs the bundled status line)\n` +
      `  statusline           install/refresh the bundled claude-statusline (usage bars; needs bash+jq)\n` +
      `  uninstall [--project] remove the capture hooks\n` +
      `  status               show hooks + hook-path health + session + edit counts\n` +
      `  doctor [--json]      diagnose setup (hooks, PATH, config dir, session, status line) with fixes\n` +
      `  update [--check]     update the CLI to the latest GitHub Release (\`--check\` only reports)\n` +
      `  sessions             list all sessions in the store (● = current dir)\n` +
      `  list [filters]       list edits; filters: --pending|--kept|--undone, --file <substr>\n` +
      `  diff <id>            show before/after for an edit\n` +
      `  keep <id>            mark an edit kept\n` +
      `  undo <id> [--force]  surgically undo an edit (--force = per-file restore)\n` +
      `  redo <id> [--force]  re-apply an undone edit\n` +
      `  clean [opts]         GC orphaned blobs; --drop <id> | --older-than <Nd> | --all | --resolved\n` +
      `  stats [--json]       usage stats (edits/tokens/messages/thinking/output) by session & window\n` +
      `  summary [--markdown] per-session review recap (kept/reverted per file); --markdown to export\n\n` +
      `machine-readable (for front-ends/scripts; list/status/sessions/keep/undo/redo also take --json):\n` +
      `  blob <sha>           raw blob bytes to stdout\n` +
      `  tree [--root <d>] [--filter <q>]   folder→file→class→edit view-model as JSON (both editors)\n` +
      `  locate --file <f>    per-pending-edit line indices in the live buffer (text on stdin; JSON out)\n` +
      `  observe              recap + per-edit reasoning/flags/memory as JSON\n` +
      `  usage                ctx / 5h / week usage snapshot as JSON\n\n` +
      `opt-in, token-spending (runs \`claude -p\`; returns the cached result unless --fresh):\n` +
      `  analyze <id>         deep-analyze one edit    [--json --fresh --claude-bin <path>]\n` +
      `  recap                one-line session recap   [--json --fresh --claude-bin <path>]\n` +
      `  suggest              next-steps + suggestions [--json --fresh --claude-bin <path>]\n\n` +
      `  --session <id>       target a specific session instead of the newest\n` +
      `  --version            print version\n`
  );
}

function main(): void {
  // Exit cleanly when output is piped to a consumer that closes early (`| head`, `| grep -q`, …)
  // instead of crashing with an unhandled EPIPE 'error' event.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  switch (cmd) {
    case 'capture': {
      // Hot path: load only the zero-dep capture module, never the diff-based engine.
      const { runCapture } = require('@claude-observatory/core/dist/capture');
      runCapture();
      process.exit(0);
      break;
    }
    case 'init':
      cmdInit(rest.includes('--project'), rest.includes('--with-statusline'));
      break;
    case 'statusline':
      cmdStatusline();
      break;
    case 'uninstall':
      cmdUninstall(rest.includes('--project'));
      break;
    case 'status':
      cmdStatus(rest);
      break;
    case 'doctor':
      cmdDoctor(rest);
      break;
    case 'sessions':
      cmdSessions(rest);
      break;
    case 'list':
      cmdList(rest);
      break;
    case 'diff':
      cmdDiff(rest);
      break;
    case 'keep':
      cmdKeep(rest);
      break;
    case 'undo':
      cmdUndo(rest);
      break;
    case 'redo':
      cmdRedo(rest);
      break;
    case 'clean':
      cmdClean(rest);
      break;
    case 'stats':
      cmdStats(rest);
      break;
    case 'summary':
      cmdSummary(rest);
      break;
    case 'blob':
      cmdBlob(rest);
      break;
    case 'locate':
      cmdLocate(rest);
      break;
    case 'tree':
      cmdTree(rest);
      break;
    case 'observe':
      cmdObserve(rest);
      break;
    case 'usage':
      cmdUsage(rest);
      break;
    case 'analyze':
      cmdAnalyze(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'recap':
      cmdRecap(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'update':
      cmdUpdate(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case 'suggest':
      cmdSuggest(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case '--version':
    case '-v':
    case 'version':
      process.stdout.write(`claude-observatory ${version()}\n`);
      break;
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      usage();
      break;
    default:
      fail(`unknown command "${cmd}". Run \`claude-observatory help\`.`);
  }
}

main();
