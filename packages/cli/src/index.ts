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
  const given = flagValue(args, '--session');
  let id: string | null = null;
  if (i >= 0 && !given) fail('`--session` requires a session id');
  if (given) id = given;
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

function cmdUninstall(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const project = args.includes('--project');
  const all = args.includes('--all');
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
  if (!all) {
    process.stdout.write(
      c.dim('tip: `claude-observatory uninstall --all` also reverts the bundled status line + prints full teardown steps.\n')
    );
    return;
  }
  // --all: revert the bundled status line too, but only if it's still ours (never a user's custom one).
  try {
    const sl = core.uninstallStatusline(target);
    if (sl.changed || sl.scriptRemoved) {
      process.stdout.write(c.green('✓ ') + `reverted the bundled status line${sl.changed ? ' (settings.json + script)' : ' (script)'}\n`);
    }
  } catch {
    /* leave a custom/hand-edited statusLine alone */
  }
  if (args.includes('--purge-store')) {
    const sessions = core.listSessions();
    for (const s of sessions) core.removeSession(s.id);
    process.stdout.write(c.green('✓ ') + `purged the store (${sessions.length} session(s))\n`);
  }
  // We can't remove the global CLI or the editor extensions from here — print the exact steps.
  process.stdout.write(
    '\n' + c.bold('To finish removing Claude Observatory:\n') +
      c.dim('  • CLI:        ') + 'npm rm -g claude-observatory\n' +
      c.dim('  • VS Code:    ') + 'uninstall the “Claude Observatory” extension (Extensions view)\n' +
      c.dim('  • JetBrains:  ') + 'Settings → Plugins → Claude Observatory → Uninstall\n' +
      (args.includes('--purge-store')
        ? ''
        : c.dim('  • Stored edits: ') + '`claude-observatory clean --all`  (or re-run with `--purge-store`)\n')
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
  const skips = session ? core.readSkips(session) : [];
  const by = (s: string) => log.filter((r) => r.status === s).length;

  if (args.includes('--json')) {
    emitJson({
      hooksInstalled: installed,
      hookScript,
      session,
      store: session ? core.storeDir(session) : null,
      lastCaptureTs: log.length ? core.maxOf(log.map((r) => r.ts)) : null,
      counts: session
        ? { total: log.length, pending: by('pending'), kept: by('kept'), undone: by('undone') }
        : null,
      skipped: session ? skips.length : null,
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
  const last = log.length ? core.relTime(core.maxOf(log.map((r) => r.ts))) : 'never';
  process.stdout.write(
    `active session:  ${session}\n` +
      `store:           ${core.storeDir(session)}\n` +
      `last capture:    ${last}\n` +
      `edits:           ${log.length}  ${c.dim(`(${by('pending')} pending · ${by('kept')} kept · ${by('undone')} undone)`)}\n`
  );
  if (skips.length) {
    process.stdout.write(
      c.yellow(`not captured:    ${skips.length} change(s)`) +
        c.dim(' — too large (>5MB) / binary, or a Bash tree too large to snapshot\n')
    );
  }
}

/** Does `bin` resolve on PATH? Cross-platform; null if we couldn't determine it. */
function onPath(bin: string): boolean | null {
  const cp = require('child_process');
  try {
    const res =
      process.platform === 'win32'
        ? cp.spawnSync('where', [bin], { stdio: 'ignore' })
        // Pass `bin` as $1, never interpolated into the shell string — no injection even if a future
        // caller passes a config-derived value.
        : cp.spawnSync('sh', ['-c', 'command -v "$1"', 'sh', bin], { stdio: 'ignore' });
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
  const icon = (l: string) => (l === 'ok' ? c.green('✓') : l === 'warn' ? c.yellow('⚠') : c.red('✗'));
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
          : c.green('all checks passed') + '\n')
  );
  process.exit(fails ? 1 : 0);
}

function cmdSessions(args: string[] = []): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  // This WORKSPACE's sessions by conversation recency, titled from a bounded sidecar-cached scan —
  // no per-session log parse, no pending counts (recency + name is what the switch decision needs).
  // --session pins the listing to the session being reviewed, so a pinned conversation with no edits
  // yet still appears in it rather than looking like another workspace's.
  const meta = core.sessionMeta(process.cwd(), args.includes('--session') ? getSessionId(args) : null);
  if (args.includes('--json')) {
    emitJson(meta);
    return;
  }
  if (meta.sessions.length === 0) {
    process.stdout.write(c.dim('no sessions for this workspace yet.\n'));
    return;
  }
  for (const s of meta.sessions) {
    const mark = s.current ? c.green('● ') : '  ';
    const name = s.title ? `${c.bold(s.title)}  ${c.dim(s.id)}` : c.bold(s.id);
    const did = s.edits
      ? `${s.edits} edit(s)` + (s.files ? ` · ${s.files} file(s)` : '') + (s.pending ? ` · ${s.pending} pending` : ' · reviewed')
      : 'no edits';
    process.stdout.write(`${mark}${name}  ${c.dim(`${did} · ${core.relTime(s.lastActiveMs)}`)}\n`);
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
  return c.dim('reverted');
}

function cmdList(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  let log = core.reviewEdits(session); // collapse same-code pending edits into one review unit (like the tree)

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
  const sub = flagValue(args, '--file');
  if (fi >= 0 && !sub) fail('`list --file <substr>` requires a value');
  if (sub) log = log.filter((r) => r.file.includes(sub));

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

/** `timeline` — a newest-first chronological feed of edits (time · id · status · Δ · file), the
 *  terminal counterpart to the editors' Timeline. `list` groups by file; this is time-ordered. */
function cmdTimeline(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const log = core.readLog(session);
  if (args.includes('--json')) {
    emitJson({
      session,
      edits: [...log]
        .reverse()
        .map((r) => {
          const d = core.lineDelta(session, r);
          return { id: r.id, ts: r.ts, tool: r.tool, file: r.file, status: r.status, added: d.added, removed: d.removed };
        }),
    });
    return;
  }
  if (log.length === 0) {
    process.stdout.write(c.dim(`no edits (session ${session}).\n`));
    return;
  }
  const pending = log.filter((r) => r.status === 'pending').length;
  process.stdout.write(
    c.bold('Timeline') + c.dim(`  ${log.length} edit(s) · ${pending} pending · newest first · session ${session}\n\n`)
  );
  for (const r of [...log].reverse()) {
    const { added, removed } = core.lineDelta(session, r);
    const delta = c.green(`+${added}`) + ' ' + c.red(`-${removed}`);
    process.stdout.write(
      `${c.dim(core.relTime(r.ts).padEnd(12))} ${c.bold('#' + r.id)}  ${statusLabel(r.status).padEnd(7)} ${delta}  ${c.cyan(relFile(r.file))} ${c.dim(r.tool)}\n`
    );
  }
}

/** The full, typed action timeline (every tool call Claude made) — zero-token, mined from the transcript. */
function cmdActions(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const actions = core.parseActions(process.cwd(), session);
  if (args.includes('--json')) {
    // Emit the flat actions AND the category-grouped view-model (curated unless --all) — the editors
    // render `groups` directly so the curated/ordering logic lives only in core.
    const showAll = args.includes('--all');
    const subagents = core.parseSubagents(process.cwd(), session);
    const fleet = core.listSiblings(process.cwd(), session);
    emitJson({
      session,
      summary: core.summarizeActions(actions),
      actions,
      groups: core.buildActionGroups(actions, { showAll }),
      egress: core.buildEgressReport(actions),
      subagents,
      subagentsSummary: core.summarizeSubagents(subagents),
      fleet,
      fleetSummary: core.summarizeFleet(fleet),
    });
    return;
  }
  if (actions.length === 0) {
    process.stdout.write(c.dim(`no actions (no transcript found for session ${session}).\n`));
    return;
  }
  const sum = core.summarizeActions(actions);
  const cats = Object.entries(sum.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(' · ');
  process.stdout.write(
    c.bold('Actions') +
      c.dim(`  ${sum.total} total · ${cats}${sum.errors ? ` · ${sum.errors} error(s)` : ''} · session ${session}\n\n`)
  );
  const ci = args.indexOf('--category');
  const catFilter = ci >= 0 ? args[ci + 1] : '';
  const li = args.indexOf('--limit');
  const limit = li >= 0 && args[li + 1] ? parseInt(args[li + 1], 10) : 0;
  let rows = actions;
  if (catFilter) rows = rows.filter((a) => a.category === catFilter);
  if (args.includes('--errors')) rows = rows.filter((a) => a.isError);
  if (limit > 0) rows = rows.slice(-limit);
  for (const a of rows) {
    const when = c.dim(core.relTime(a.ts).padEnd(11));
    const mark = a.isError ? c.red('✗') : ' ';
    const tag = c.cyan(`[${a.category}]`.padEnd(9));
    const link = a.editId != null ? c.dim(` edit#${a.editId}`) : '';
    const detail = a.detail ? c.dim(`  (${a.detail})`) : '';
    process.stdout.write(`${when} ${mark} ${tag} ${c.bold(a.tool.padEnd(10))} ${(a.target || '').slice(0, 80)}${link}${detail}\n`);
  }
}

/** Command risk: the shell commands Claude ran that can destroy data / escalate / touch secrets. */
function cmdRisk(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const rri = args.indexOf('--root'); // the workspace boundary for "outside", like changemap/footprint
  const root = rri >= 0 && args[rri + 1] ? args[rri + 1] : process.cwd();
  if (noTranscript(session, args.includes('--json'))) return;
  const risky = core
    .parseActions(process.cwd(), session)
    .filter((a) => a.risk)
    .map((a) => ({ ts: a.ts, tool: a.tool, target: a.target, level: a.risk!.level, reasons: a.risk!.reasons }));
  const high = risky.filter((r) => r.level === 'high').length;
  if (args.includes('--json')) {
    // The folded footprint's damaging half: edits that landed outside the workspace boundary.
    emitJson({ session, count: risky.length, high, risky, outsideWrites: core.outsideWrites(core.parseActions(process.cwd(), session), root) });
    return;
  }
  if (risky.length === 0 && !core.outsideWrites(core.parseActions(process.cwd(), session), root).length) {
    process.stdout.write(c.dim(`no risky commands flagged (session ${session}).\n`));
    return;
  }
  process.stdout.write(c.bold('Risk') + c.dim(`  ${risky.length} flagged · ${high} high · session ${session}\n\n`));
  for (const r of risky) {
    const badge = r.level === 'high' ? c.red('● HIGH') : c.yellow('● MED ');
    process.stdout.write(`${badge}  ${(r.target || '').slice(0, 74)}\n       ${c.dim(r.reasons.join(' · '))}\n`);
  }

  // Writes that left the workspace. Risk otherwise only inspects commands, but "it edited files outside
  // the directory you pointed it at" is the same class of fact, and the edits ledger cannot say it —
  // every path there is shown workspace-relative. Stated as an observation, not scored as a danger.
  const outside = core.outsideWrites(core.parseActions(process.cwd(), session), root);
  if (outside.length) {
    const total = outside.reduce((n, w) => n + w.count, 0);
    process.stdout.write('\n' + c.bold('Outside the workspace') + c.dim(`  ${total} edit(s) across ${outside.length} file(s)\n`));
    for (const w of outside.slice(0, args.includes('--all') ? 200 : 8)) {
      process.stdout.write(`  ${c.yellow('↗')} ${w.file}${w.count > 1 ? c.dim(` ×${w.count}`) : ''}\n`);
    }
    const hidden = outside.length - Math.min(outside.length, args.includes('--all') ? 200 : 8);
    if (hidden) process.stdout.write(c.dim(`     … ${hidden} more (--all)\n`));
  }
}

/** Egress: what this session touched off-machine — web / MCP / network-shell destinations. */
function cmdEgress(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  if (noTranscript(session, args.includes('--json'))) return;
  const eri = args.indexOf('--root'); // the workspace boundary for the `file` channels below
  const eroot = eri >= 0 && args[eri + 1] ? args[eri + 1] : process.cwd();
  const acts = core.parseActions(process.cwd(), session);
  // Reads that left the workspace are reach, exactly like a fetch — the same question this audit
  // already answers for the network, so they are channels of the same report rather than a second one.
  const channels = [...core.buildEgressReport(acts), ...core.outsideReads(acts, eroot)];
  const sum = core.summarizeEgress(channels);
  if (args.includes('--json')) {
    emitJson({ session, ...sum });
    return;
  }
  if (channels.length === 0) {
    process.stdout.write(c.dim(`no off-machine egress detected (session ${session}).\n`));
    return;
  }
  process.stdout.write(
    c.bold('Egress') + c.dim(`  ${channels.length} destination(s) · ${sum.remote} remote · session ${session}\n\n`)
  );
  for (const ch of channels) {
    // 'local' is a FACT (it stayed on this machine but left the workspace); 'unknown' is an admission
    // that we could not classify the destination. Printing the first as the second would be a lie.
    const scope = ch.scope === 'remote' ? c.red('remote ') : ch.scope === 'local' ? c.yellow('outside') : c.dim('unknown');
    process.stdout.write(`${scope}  ${c.cyan(ch.kind.padEnd(5))} ${ch.target}${ch.count > 1 ? c.dim(` ×${ch.count}`) : ''}\n`);
  }
}

/** Every audit verb reads the transcript. When there ISN'T one (another project's session, a bad id),
 *  an empty result means "we couldn't look", not "nothing happened" — and printing the second is a false
 *  statement of absence. Returns true when the caller should stop. */
function noTranscript(session: string, json: boolean): boolean {
  const core = require('@claude-observatory/core') as Core;
  if (core.findTranscript(process.cwd(), session)) return false;
  if (json) emitJson({ session, transcript: null, error: 'no transcript found for this session under this directory' });
  else process.stdout.write(c.dim(`no transcript found for session ${session} under this directory — nothing to audit.\n`));
  return true;
}

/** `footprint`/`capabilities` — folded into `risk` and `egress` in 0.8.7. The two facts it alone
 *  reported now live where they belong: reads that left the workspace are egress (reach), writes that
 *  left it are risk (damage). One audit surface instead of two. */
function cmdFootprint(args: string[]): void {
  process.stderr.write(
    c.dim('`footprint` was folded into `risk` and `egress` in 0.8.7 — reads that left the workspace are\n' +
      'reported by `egress`, writes that left it by `risk`. Showing both.\n\n')
  );
  // `--json` has to stay ONE document. Running both verbs straight through emitted two concatenated
  // objects, so every caller's JSON.parse threw ("Unexpected non-whitespace character after JSON").
  if (args.includes('--json')) {
    const grab = (run: () => void): unknown => {
      const real = process.stdout.write.bind(process.stdout);
      let buf = '';
      (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
        buf += chunk;
        return true;
      };
      try {
        run();
      } finally {
        (process.stdout as unknown as { write: typeof real }).write = real;
      }
      try {
        return JSON.parse(buf);
      } catch {
        return null;
      }
    };
    emitJson({ risk: grab(() => cmdRisk(args)), egress: grab(() => cmdEgress(args)) });
    return;
  }
  cmdRisk(args);
  process.stdout.write('\n');
  cmdEgress(args);
}

/** `processes` — the background shells this session launched with `run_in_background` and left running,
 *  with the detail the harness's own Background panel omits: runtime, exit code, output volume. There is
 *  no OS pid here on purpose — the transcript never records one, and guessing it from local processes
 *  would be wrong whenever the agent runs on another machine (SSH / devcontainer / another worktree). */
function cmdProcesses(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  if (noTranscript(session, args.includes('--json'))) return;
  const list = core.sessionProcesses(process.cwd(), session);
  const sum = core.summarizeProcesses(list);
  // `--id <shell>` drills into ONE shell: the full command it is running, plus a tail of its output —
  // for a job that is still going, that tail is the only view of what it is actually doing.
  const want = flagValue(args, '--id');
  if (want) {
    const p = list.find((x) => x.id === want);
    if (!p) fail(`no background shell "${want}" in session ${session}.`);
    const tail = core.processOutputTail(p!.outputPath);
    if (args.includes('--json')) {
      emitJson({ session, process: p, outputTail: tail });
      return;
    }
    process.stdout.write(c.bold(p!.id) + c.dim(`  ${p!.running ? 'running' : p!.status}${p!.exitCode !== null ? ` (exit ${p!.exitCode})` : ''} · ${fmtDur(p!.runtimeMs)}\n\n`));
    if (p!.description) process.stdout.write(c.dim(`${p!.description}\n\n`));
    process.stdout.write(`${p!.command}\n`);
    if (p!.outputPath) process.stdout.write(c.dim(`\noutput → ${p!.outputPath}\n`));
    if (tail) process.stdout.write(c.dim('\n--- last output ---\n') + tail + '\n');
    return;
  }
  if (args.includes('--json')) {
    emitJson({ session, summary: sum, processes: list });
    return;
  }
  if (!list.length) {
    process.stdout.write(c.dim(`no background shells in session ${session}.\n`));
    return;
  }
  process.stdout.write(
    c.bold('Processes') + c.dim(`  ${sum.running} running · ${sum.total} total${sum.failed ? ` · ${sum.failed} failed` : ''} · session ${session}\n\n`)
  );
  for (const p of list) {
    const state = p.running
      ? c.green('running')
      : p.exitCode === null
        ? c.dim(p.status)
        : p.exitCode === 0
          ? c.dim('exit 0 ')
          : c.red(`exit ${p.exitCode}`);
    const out = p.outputBytes ? c.dim(` · ${human(p.outputBytes)}B out`) : '';
    process.stdout.write(`${state}  ${c.cyan(p.id.padEnd(11))} ${fmtDur(p.runtimeMs).padStart(7)}${out}\n`);
    process.stdout.write(c.dim(`             ${(p.description || p.command).replace(/\s+/g, ' ').slice(0, 84)}\n`));
  }
  process.stdout.write(c.dim('\nshell ids are the harness’s own — no OS pid is recorded in the transcript\n'));
}

/** `feed` — what ONE thing is doing right now: an agent, a workflow run, a task, a background shell, or
 *  the session itself. A bounded tail of the file that thing writes as it works, so the editors can poll
 *  it on their existing watcher tick without re-reading whole transcripts. */
function cmdFeed(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const kind = (flagValue(args, '--kind') || 'session') as 'session' | 'agent' | 'workflow' | 'task' | 'process';
  if (!['session', 'agent', 'workflow', 'task', 'process'].includes(kind)) fail(`--kind must be session|agent|workflow|task|process (got "${kind}").`);
  const id = flagValue(args, '--id') || '';
  if (kind !== 'session' && !id) fail(`--id <${kind} id> is required for --kind ${kind}.`);
  const limitRaw = flagValue(args, '--limit');
  const limit = limitRaw ? Math.max(1, Number(limitRaw) || 0) : undefined;
  const res = core.liveFeed(process.cwd(), session, { kind, id }, limit ? { limit } : {});
  if (args.includes('--json')) {
    emitJson(res);
    return;
  }
  const age = res.lastTs ? core.relTime(res.lastTs) : 'no activity yet';
  // Print core's own mode, not a re-derived running/idle: live-vs-audit IS the feature, and both editors
  // and the docs present it in exactly these words.
  const mode = res.mode === 'live' ? c.green('● live') : c.dim('▣ audit log');
  process.stdout.write(c.bold(res.title) + c.dim(`  `) + mode + c.dim(` · ${age} · ${kind}\n`));
  if (res.note) process.stdout.write(c.dim(`${res.note}\n`));
  process.stdout.write('\n');
  if (res.truncated) process.stdout.write(c.dim(`… ${res.truncated} earlier entr${res.truncated === 1 ? 'y' : 'ies'} not shown\n`));
  for (const e of res.entries) {
    if (e.kind === 'output') {
      process.stdout.write(`${e.label}\n`);
      continue;
    }
    // LOCAL time: this is the only wall clock the CLI prints, and UTC put it hours off the reader's
    // own clock (rolling past midnight mid-list). Both editors already format the same ts locally.
    const when = e.ts ? c.dim(new Date(e.ts).toTimeString().slice(0, 8) + ' ') : '';
    const mark = e.ok === false ? c.red('✗ ') : '  ';
    process.stdout.write(`${when}${mark}${c.cyan(e.label)}${e.detail ? c.dim(' ' + e.detail.replace(/\s+/g, ' ').slice(0, 90)) : ''}\n`);
  }
  if (!res.entries.length) process.stdout.write(c.dim('nothing recorded yet\n'));
}

/** `prompts` — the session broken into what the USER asked for, in order, each carrying what it
 *  produced. Every other view organizes work the way the agent saw it (rollups by task, file or
 *  agent); this is the only one that answers "what happened when I asked for X". */
function cmdPrompts(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  if (noTranscript(session, args.includes('--json'))) return;
  const reqs = core.sessionPrompts(process.cwd(), session);
  const want = flagValue(args, '--id');
  if (want) {
    const r = reqs.find((x) => x.id === want || String(x.index) === want);
    if (!r) fail(`no prompt "${want}" in session ${session} (1..${reqs.length}).`);
    // `--response`: Claude's own prose in reply to this ask (its tool calls stripped) — the log a
    // reviewer expands to read. Fetched lazily because it can be large.
    if (args.includes('--response')) {
      const resp = core.promptResponse(process.cwd(), session, r!.id);
      if (args.includes('--json')) {
        emitJson({ session, response: resp });
        return;
      }
      if (!resp || !resp.text) {
        process.stdout.write(c.dim(`no assistant response recorded for prompt #${r!.index}.\n`));
        return;
      }
      process.stdout.write(c.bold(`#${r!.index}`) + c.dim(`  Claude’s response · ${resp.turns} turn(s)\n\n`));
      process.stdout.write(`${resp.text}\n`);
      if (resp.truncated) process.stdout.write(c.dim(`\n… ${fmtBytes(resp.truncated)} more not shown (--json for the capped text)\n`));
      return;
    }
    if (args.includes('--json')) {
      emitJson({ session, prompt: r });
      return;
    }
    process.stdout.write(c.bold(`#${r!.index}`) + c.dim(`  ${core.relTime(r!.ts)} · ${fmtDur(r!.durationMs)}\n\n`));
    process.stdout.write(`${r!.text}\n\n`);
    const bits: string[] = [];
    if (r!.edits) bits.push(`${r!.edits} edit(s) (+${r!.added}/−${r!.removed}) · ${r!.pending} pending · ${r!.kept} accepted · ${r!.undone} reverted`);
    if (r!.files) bits.push(`${r!.files} file(s) · ${r!.folders} folder(s)`);
    if (r!.tokens) bits.push(`${fmtTok(r!.tokens)} tokens`);
    if (r!.actions) bits.push(`${r!.actions} tool call(s)${r!.errors ? ` · ${r!.errors} failed` : ''}`);
    if (r!.tasks) bits.push(`${r!.tasks} task(s) worked`);
    if (r!.agents.length) bits.push(`${r!.agents.length} subagent(s)`);
    if (r!.workflows.length) bits.push(`${r!.workflows.length} workflow run(s)`);
    if (r!.processes.length) bits.push(`${r!.processes.length} background shell(s)`);
    if (r!.compactions) bits.push(`${r!.compactions} compaction(s)`);
    for (const b of bits) process.stdout.write(c.dim(`  ${b}\n`));
    if (r!.editIds.length) process.stdout.write(c.dim(`\n  edits: ${r!.editIds.slice(0, 40).join(', ')}${r!.editIds.length > 40 ? ` … ${r!.editIds.length - 40} more (--json)` : ''}\n`));
    return;
  }
  if (args.includes('--json')) {
    emitJson({ session, summary: core.summarizePrompts(reqs), prompts: reqs });
    return;
  }
  const sum = core.summarizePrompts(reqs);
  if (!reqs.length) {
    process.stdout.write(c.dim(`no user prompts recorded in session ${session}.\n`));
    return;
  }
  process.stdout.write(c.bold('Prompts') + c.dim(`  ${sum.total} asked · ${sum.withEdits} produced edits · ${sum.edits} edit(s) total · session ${session}\n\n`));
  for (const r of reqs) {
    const facts: string[] = [];
    if (r.edits) facts.push(c.cyan(`${r.edits}e`) + c.dim(` ${r.files}f ${r.folders}fo`));
    if (r.tokens) facts.push(`${fmtTok(r.tokens)} tok`);
    if (r.tasks) facts.push(`${r.tasks}t`);
    if (r.agents.length) facts.push(`${r.agents.length}a`);
    if (r.workflows.length) facts.push(`${r.workflows.length}w`);
    if (r.processes.length) facts.push(`${r.processes.length}p`);
    if (r.compactions) facts.push('⤺');
    // The ask is printed WHOLE, wrapped over as many lines as it needs — never clipped to a width.
    // A truncated prompt is the one thing on this list a reader can't reconstruct from anywhere else.
    const lines = wrapText(r.text, Math.max(40, (process.stdout.columns || 100) - 5));
    process.stdout.write(c.dim(`#${String(r.index).padEnd(3)}`) + `${lines[0]}\n`);
    for (const ln of lines.slice(1)) process.stdout.write(`     ${ln}\n`);
    process.stdout.write(c.dim(`     ${fmtDur(r.durationMs).padStart(7)}${facts.length ? '  ' + facts.join(' · ') : ''}\n`));
  }
  process.stdout.write(c.dim('\nwork is attributed to the prompt that STARTED it — a shell launched here belongs here even if it exits later\n'));
}

/** Break text onto lines at word boundaries — used wherever a full sentence must survive a narrow
 *  terminal. Wrapping, never clipping: an ellipsis loses the only copy of what the user actually said.
 *  A word longer than the width (a path, a URL) gets its own line rather than being cut mid-token. */
function wrapText(s: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of String(s ?? '').split(/\s+/).filter(Boolean)) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Compact token count (1.2M / 45k / 900) — the total incl. cache, as the Stats panel sums it. */
function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return `${n}`;
}

/** ms → compact human duration (450ms / 3.2s / 2m 5s). */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0).replace(/\.0$/, '')}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem ? ` ${rem}s` : ''}`;
}

/** `subagents` (alias `agents`) — every subagent this session spawned, each with its own action
 *  timeline + metrics (duration / tokens), mined zero-token from subagents/*.jsonl. */
function cmdSubagents(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const subs = core.parseSubagents(process.cwd(), session);
  const sum = core.summarizeSubagents(subs);
  if (args.includes('--json')) {
    emitJson({ session, summary: sum, subagents: subs });
    return;
  }
  if (subs.length === 0) {
    process.stdout.write(c.dim(`no subagents in this session (${session}).\n`));
    return;
  }
  const head = [
    `${sum.count} subagent(s)`,
    `${sum.totalActions} action(s)`,
    sum.totalEdits ? `${sum.totalEdits} edit(s)` : null,
    sum.totalDurationMs ? fmtDur(sum.totalDurationMs) : null,
    sum.totalTokens ? `${human(sum.totalTokens)} tok` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  process.stdout.write(c.bold('Subagents') + c.dim(`  ${head} · session ${session}\n\n`));
  const limit = args.includes('--all') ? Infinity : 8;
  for (const s of subs) {
    const title = s.agentType || s.description || s.agentId.slice(0, 12);
    const meta = [
      s.durationMs ? fmtDur(s.durationMs) : null,
      s.tokens ? `${human(s.tokens)} tok` : null,
      `${s.summary.total} action(s)`,
      s.edits ? `${s.edits} edit(s)` : null,
      s.summary.errors ? c.red(`${s.summary.errors} err`) : null,
      s.status && s.status !== 'completed' ? c.yellow(s.status) : null,
    ]
      .filter(Boolean)
      .join(' · ');
    process.stdout.write(c.cyan('▸ ') + c.bold(title) + c.dim(`  ${meta}\n`));
    if (s.description && s.agentType) process.stdout.write('   ' + c.dim(s.description.slice(0, 100)) + '\n');
    for (const a of s.actions.slice(0, limit)) {
      const mark = a.isError ? c.red('✗') : ' ';
      process.stdout.write(`   ${mark} ${c.dim(`[${a.category}]`.padEnd(9))} ${c.bold(a.tool)} ${(a.target || '').slice(0, 56)}\n`);
    }
    if (s.actions.length > limit) process.stdout.write(c.dim(`   … ${s.actions.length - limit} more (\`--all\` to expand)\n`));
    process.stdout.write('\n');
  }
}

/** `siblings` (alias `fleet`) — the other Claude Code sessions in THIS project: active/idle, pending
 *  edits, files touched, risk flags. Agent-facing digest (call it mid-run to see what siblings touch);
 *  --json defaults to siblings only (excludes self), --all includes self. */
function cmdSiblings(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  // --repo widens the scope from this project dir to every WORKTREE of the same git repo (§S3):
  // each sibling then carries its worktree/gitBranch/phase, and the summary's conflicts count comes
  // from the UNCAPPED file set. Same-dir listSiblings stays the default (cheap, no repo resolution).
  const sessions = args.includes('--repo')
    ? core.listRepoSiblings(process.cwd(), session)
    : core.listSiblings(process.cwd(), session);
  const sum = core.summarizeFleet(sessions);
  if (args.includes('--json')) {
    const list = args.includes('--all') ? sessions : sessions.filter((s) => !s.self);
    emitJson({ session, summary: sum, siblings: list });
    return;
  }
  if (sessions.filter((s) => !s.self).length === 0) {
    process.stdout.write(c.dim(`no sibling sessions in this project (only ${session}).\n`));
    return;
  }
  process.stdout.write(
    c.bold('Fleet') +
      c.dim(`  ${sum.total} session(s) · ${sum.active} active · ${sum.siblings} sibling(s) · ${sum.pending} pending across siblings\n\n`)
  );
  for (const s of sessions) {
    const dot = s.active ? c.green('●') : c.dim('○');
    const you = s.self ? c.cyan(' (you)') : '';
    const risk = s.risk.total ? (s.risk.high ? c.red(` ⚠ ${s.risk.high} high`) : c.yellow(` ⚠ ${s.risk.total}`)) : '';
    process.stdout.write(
      `${dot} ${c.bold(s.id.slice(0, 8))}${you}  ${c.dim(`${s.edits} edit(s) · ${s.pending} pending · ${core.relTime(s.lastMs)}`)}${risk}\n`
    );
    if (s.files.length) {
      const shown = s.files.slice(0, 5).map((f) => relFile(f));
      process.stdout.write('   ' + c.dim(shown.join(', ') + (s.moreFiles ? ` +${s.moreFiles} more` : '')) + '\n');
    }
  }
}


/** `multitask` (§4) — the multi-agent bottom-panel view: one row per running agent across every
 *  worktree of this repo (live phase, sparkline, ±lines, risk), its nested subagents (phase + current
 *  task/todos + ±lines), and the cross-agent live file conflicts. One JSON payload; both editors render it
 *  thin, no client aggregation. Zero token, git-free, path-only. */
function cmdMultitask(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const ri = args.indexOf('--root'); // repo-scoped: honor --root like changemap/tree (editors point it at the workspace)
  const cwd = flagValue(args, '--root') ?? process.cwd();
  const siblings = core.listRepoSiblings(cwd, session);
  const fleet = core.summarizeFleet(siblings);
  const collisions = core.fleetConflicts(siblings); // live conflicts: a file pending in 2+ both-active siblings

  const agents = siblings.map((sib) => {
    const transcript = core.findTranscript(sib.worktree, sib.id);
    const pd = transcript
      ? core.agentPhaseDetail(transcript)
      : { phase: 'idle' as const, confidence: 'heuristic' as const };
    // Full (slow-tier) payload: whole-file builds per agent — aggregated HERE so renderers stay thin.
    // EVERY sibling, the session under review included, comes from the on-disk cache: it is keyed to the
    // (transcript, log) stamps, so a session that is still being written misses it naturally and a
    // finished one hits it. The old special case rebuilt "the active session" unconditionally, which is
    // right for the live conversation and badly wrong for a PINNED one — switching to a long finished
    // session paid seconds of transcript parsing on every refresh tick, forever. Live facts (phase,
    // subagent phases) are computed below, outside the cache, so nothing frozen is reported as current.
    const view = core.siblingOverview(sib.worktree, sib.id, { root: sib.worktree });
    const map = view.map;
    const sibActions = core.parseActions(sib.worktree, sib.id); // memoized — the sparkline used it too
    // Per-sibling tokens + wall-clock (one light transcript pass) — so Fleet shows the same metric style
    // as Workflows already do. Cached on this slow tier alongside buildChangeMap.
    const usage = core.sessionUsage(sib.worktree, sib.id);
    const subRoll = new Map(map.rollupBySubagent.map((r) => [r.subagentId, r])); // per-subagent ±lines
    // Digests, not full parses: a fleet row needs identity, plan and live phase — never the subagent's
    // action list, which is what made this the slowest remaining part of a refresh.
    const subagents = core.subagentDigests(sib.worktree, sib.id).map((s) => {
      const roll = subRoll.get(s.agentId);
      return {
        agentId: s.agentId,
        agentType: s.agentType ?? null,
        description: s.description ?? null,
        phase: s.phase,
        phaseConfidence: s.phaseConfidence, // 'high' | 'heuristic' — renderers dim staleness-inferred phases
        todos: s.todos,
        currentTask: s.currentTask,
        edits: roll ? roll.edits : 0,
        added: roll ? roll.added : 0,
        removed: roll ? roll.removed : 0,
      };
    });
    return {
      session: sib.id,
      worktree: sib.worktree,
      gitBranch: sib.gitBranch,
      self: sib.self,
      phase: pd.phase,
      phaseConfidence: pd.confidence,
      sparkline: view.sparkline,
      todos: view.todos,
      subagents,
      files: sib.files,
      diff: { added: map.summary.added, removed: map.summary.removed },
      tokens: usage.total,
      durationMs: usage.durationMs,
      risk: sib.risk,
      // Boundary crossings for the fleet row's ↗ suffix — the footprint's one unique fact, kept after
      // the badge row was folded into risk/egress. Computed off the actions already parsed for the
      // sparkline, never a second scan.
      outside: {
        reads: core.outsideReads(sibActions, sib.worktree).length,
        writes: core.outsideWrites(sibActions, sib.worktree).length,
      },
      compactions: map.summary.compactions,
    };
  });

  // The distinct worktrees in play (branch + the sessions launched in each) — a compact repo index.
  const wtBy = new Map<string, { worktree: string; gitBranch: string | null; sessions: string[] }>();
  for (const sib of siblings) {
    let w = wtBy.get(sib.worktree);
    if (!w) {
      w = { worktree: sib.worktree, gitBranch: sib.gitBranch, sessions: [] };
      wtBy.set(sib.worktree, w);
    }
    w.sessions.push(sib.id);
  }

  // The active session's curated tool-call timeline (0.8.0: Actions folded into Multitasking). Drop the
  // `agent` (Subagents) category — those are already the fleet/subagent rows above — and pair it with the
  // egress sub-report. Both editors render this `actions` section below the fleet; no client aggregation.
  const sessionActions = core.parseActions(cwd, session);
  const actions = {
    groups: core.buildActionGroups(sessionActions).filter((g) => g.category !== 'agent'),
    egress: core.buildEgressReport(sessionActions),
  };

  emitJson({
    agents,
    collisions,
    worktrees: [...wtBy.values()],
    // Workflow runs (one level above subagents) for the ACTIVE session — aggregated in core, rendered thin.
    workflows: core.parseWorkflows(cwd, session),
    // The ACTIVE session's task list for the Overview's Tasks tab, across BOTH task generations:
    // the legacy numbered TaskCreate/TaskUpdate list (transcript history ∪ live dir state) unioned
    // with one row per background Agent run — the current harness's task system. Each row carries the
    // strict taskId that joins it to rollupByTask / taskEditIds. [] for sessions with neither.
    tasks: core.allSessionTaskRows(cwd, session),
    actions,
    summary: { active: fleet.active, conflicts: fleet.conflicts },
  });
}

/** `tasklog` (§2.5) — the cross-agent task log: one row per stable taskId, unioned across every
 *  worktree-sibling + subagent of this repo. Always JSON (TaskLogEntry[]). Zero token, git-free. */
function cmdTaskLog(_args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  emitJson(core.crossAgentTaskLog(process.cwd()));
}

/** `metrics` — session numbers: ±lines, action/error counts, per-subagent duration/tokens, tool latency. */
function cmdMetrics(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const m = core.sessionMetrics(process.cwd(), session);
  if (args.includes('--json')) {
    emitJson(m);
    return;
  }
  process.stdout.write(c.bold('Metrics') + c.dim(`  session ${session}\n\n`));
  process.stdout.write(
    `  edits         ${m.edits.count}  ${c.green('+' + m.edits.added)} ${c.red('-' + m.edits.removed)}  ` +
      c.dim(`${m.edits.pending} pending · ${m.edits.kept} kept · ${m.edits.undone} undone`) +
      '\n'
  );
  process.stdout.write(`  actions       ${m.actions.total}${m.actions.errors ? c.red(`  ${m.actions.errors} error(s)`) : ''}\n`);
  process.stdout.write(
    `  subagents     ${m.subagents.count}` +
      (m.subagents.count
        ? c.dim(
            `  ${m.subagents.totalActions} action(s) · ${m.subagents.totalEdits} edit(s)` +
              (m.subagents.totalDurationMs ? ` · ${fmtDur(m.subagents.totalDurationMs)}` : '') +
              (m.subagents.totalTokens ? ` · ${human(m.subagents.totalTokens)} tok` : '')
          )
        : '') +
      '\n'
  );
  if (m.toolLatency.count)
    process.stdout.write(
      `  tool latency  ` +
        c.dim(`median ${fmtDur(m.toolLatency.medianMs)} · p95 ${fmtDur(m.toolLatency.p95Ms)} · max ${fmtDur(m.toolLatency.maxMs)} (${m.toolLatency.count} call(s))`) +
        '\n'
    );
  if (m.spanMs) process.stdout.write(`  span          ${c.dim(fmtDur(m.spanMs))}\n`);
}

/**
 * The value following a `--flag`, or undefined when the flag is absent OR was given without one.
 *
 * A following token that itself starts with `--` is NOT a value. Without that rule every caller here
 * silently acted on a flag name: `locate --file --json` resolved `<cwd>/--json` as the path to place
 * edits in, `list --file --json` filtered for files containing "--json" and reported an empty result,
 * and `clean --session --json` operated on a session literally named `--json` — which passes
 * `isSafeSessionId`, since `-` is in its character class. Returning undefined lets each caller fail
 * loudly instead of acting on the wrong thing.
 */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v !== undefined && !v.startsWith('--') ? v : undefined;
}

/** Flags that consume the token after them — so a numeric VALUE is never read as a positional id. */
const VALUE_FLAGS = new Set(['--session', '--file', '--under', '--ids', '--root', '--filter', '--dir']);

/**
 * The positional edit id if one was typed, else undefined — requireId's scan without the failure.
 *
 * Used to REFUSE a scoped verb that also names an id. `keep`/`undo`/`redo` take the scope branch
 * (`--all` / `--file` / `--under` / `--ids`) before `requireId` is ever reached, so the id was silently
 * discarded: `undo --file src 2` reverted every pending edit under `src`, wrote them all to disk, and
 * exited 0 reporting `{"undone":2}`. Asking for one edit must never revert a whole scope.
 */
function positionalId(args: string[]): number | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i++; // skip the flag's VALUE
      continue;
    }
    if (args[i].startsWith('--')) continue;
    if (/^\d+$/.test(args[i])) return Number(args[i]);
  }
  return undefined;
}

/** Refuse a scope-wide verb that also names a single edit — the two mean different things. */
function refuseScopeWithId(args: string[], verb: string): void {
  const id = positionalId(args);
  if (id === undefined) return;
  fail(
    `\`${verb}\` was given both a scope flag and edit id ${id}, which mean different things.\n` +
      `  For just that edit:   claude-observatory ${verb} ${id}\n` +
      `  For the whole scope:  drop the id and re-run.`
  );
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
  process.stdout.write(c.dim(`keep #${id} · undo #${id}\n`));
}

function cmdKeep(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const json = args.includes('--json');
  // Bulk: --all (every pending), --file <substr> (pending edits in matching files), or --under <path>
  // (pending edits at-or-beneath a file/folder path — the editors' folder/file Accept action, so
  // file-scope and folder-scope share one exact rule).
  // --ids <a,b,c>: an explicit set, so an editor accepting a file / folder / task / prompt spends ONE
  // process instead of one per edit (the JetBrains plugin has no in-process core).
  const idi = args.indexOf('--ids');
  if (idi >= 0) {
    const raw = args[idi + 1];
    if (!raw) fail('`keep --ids <a,b,c>` requires a comma-separated id list');
    const ids = raw.split(',').map((x) => parseInt(x.trim(), 10)).filter((n) => Number.isFinite(n));
    if (!ids.length) fail('`keep --ids <a,b,c>` got no valid integer ids');
    const kept = core.setStatusMany(session, ids, 'kept');
    core.autoClearDemo(session);
    if (json) {
      emitJson({ kept: kept.length, ids: kept });
      return;
    }
    if (!kept.length) {
      process.stdout.write(c.dim('no pending edits to keep in that set\n'));
      return;
    }
    process.stdout.write(c.green('✓ ') + `kept ${kept.length} edit(s)\n`);
    return;
  }
  const fi = args.indexOf('--file');
  const ui = args.indexOf('--under');
  if (args.includes('--all') || fi >= 0 || ui >= 0) {
    refuseScopeWithId(args, "keep");
    const fileSub = flagValue(args, "--file");
    if (fi >= 0 && !fileSub) fail('`keep --file <substr>` requires a value');
    const under = flagValue(args, "--under");
    if (ui >= 0 && !under) fail('`keep --under <path>` requires a value');
    const targets = core
      .readLog(session)
      .filter(
        (r) =>
          r.status === 'pending' &&
          (!fileSub || r.file.includes(fileSub)) &&
          (!under || core.isUnderPath(r.file, under))
      );
    core.setStatusMany(session, targets.map((r) => r.id), 'kept'); // one parse + one append
    core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
    if (json) {
      emitJson({ kept: targets.length, ids: targets.map((r) => r.id) });
      return;
    }
    const scope = fileSub ? ` in files matching "${fileSub}"` : under ? ` under ${relFile(under)}` : '';
    if (targets.length === 0) {
      // Nothing matched the scope — an honest "nothing to do", never a green ✓ 0 that reads as success.
      process.stdout.write(c.dim(`no pending edits to keep${scope}\n`));
      return;
    }
    process.stdout.write(c.green('✓ ') + `kept ${targets.length} edit(s)${scope}\n`);
    return;
  }
  const id = requireId(args);
  const rec = core.findRecord(session, id);
  if (!rec) fail(`no edit #${id} in session ${session}`);
  const g = core.keepGroup(session, id); // keep the whole same-code review unit (collapsed group)
  core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
  if (json) {
    emitJson({ kept: g.kept, ids: g.ids });
    return;
  }
  if (g.kept === 0) {
    // keepGroup flips only PENDING edits, so nothing happened — never a green ✓ over a no-op. Mirrors
    // the scope branch's "no pending edits to keep" above; the --json path already reported kept: 0.
    process.stdout.write(
      c.dim(
        rec.status === 'undone'
          ? `edit #${id} is reverted — nothing kept (\`redo ${id}\` to restore it first)\n`
          : `edit #${id} is already kept — nothing to do\n`
      )
    );
    return;
  }
  const label = g.kept > 1 ? `${g.kept} edits for this change` : `edit #${id}`;
  process.stdout.write(c.green('✓ ') + `kept ${label} (${relFile(rec.file)})\n`);
}

function cmdUndo(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  // Bulk: --all (every pending in the session), --file <substr> (pending edits in matching files),
  // --under <path> (pending edits at-or-beneath a file/folder path — the editors' folder/file Revert),
  // or --ids <a,b,c> (an explicit pending-edit id set — the Overview's Folder-axis Reject, which acts
  // on ONE module bucket's exact edits, not the recursive subtree a path scope would catch).
  // Already-Accepted (kept) edits are left on disk — revert those individually. All share core.undoScope,
  // the single scoped-revert implementation both editors also use.
  const fi = args.indexOf('--file');
  const ui = args.indexOf('--under');
  const idi = args.indexOf('--ids');
  if (args.includes('--all') || fi >= 0 || ui >= 0 || idi >= 0) {
    refuseScopeWithId(args, "undo");
    const fileSub = flagValue(args, "--file");
    if (fi >= 0 && !fileSub) fail('`undo --file <substr>` requires a value');
    const under = flagValue(args, "--under");
    if (ui >= 0 && !under) fail('`undo --under <path>` requires a value');
    let ids: number[] | undefined;
    if (idi >= 0) {
      const raw = args[idi + 1];
      if (!raw) fail('`undo --ids <a,b,c>` requires a comma-separated id list');
      ids = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
      if (!ids.length) fail('`undo --ids <a,b,c>` got no valid integer ids');
    }
    const res = core.undoScope(session, { under, fileSubstr: fileSub, ids });
    core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
    if (args.includes('--json')) {
      emitJson({ undone: res.undone, conflicts: res.conflicts, total: res.total });
      return;
    }
    const scope = fileSub ? ` in files matching "${fileSub}"` : under ? ` under ${relFile(under)}` : ids ? ` in ${ids.length} selected edit(s)` : '';
    if (res.total === 0) {
      // No pending edits matched the scope — an honest "nothing to do", never a green ✓ 0.
      process.stdout.write(c.dim(`no pending edits to revert${scope}\n`));
      return;
    }
    process.stdout.write(
      (res.conflicts ? c.yellow('⚠ ') : c.green('✓ ')) +
        `reverted ${res.undone} edit(s)${scope}` +
        (res.conflicts ? ` · ${res.conflicts} conflict(s) left (undo individually with --force)` : '') +
        '\n'
    );
    return;
  }
  const id = requireId(args);
  const force = args.includes('--force');
  // Undo the whole same-code review unit (collapsed group), newest-first; --force is the per-file fallback.
  const res = force ? core.restoreFile(session, id) : core.undoGroup(session, id);
  core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
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
  // Bulk: --all (every undone in the session) | --file <substr> | --under <path> | --ids <a,b,c> —
  // the forward mirror of `undo`'s selectors, via the shared core.redoScope.
  const fi = args.indexOf('--file');
  const ui = args.indexOf('--under');
  const idi = args.indexOf('--ids');
  if (args.includes('--all') || fi >= 0 || ui >= 0 || idi >= 0) {
    refuseScopeWithId(args, "redo");
    const fileSub = flagValue(args, "--file");
    if (fi >= 0 && !fileSub) fail('`redo --file <substr>` requires a value');
    const under = flagValue(args, "--under");
    if (ui >= 0 && !under) fail('`redo --under <path>` requires a value');
    let bulkIds: number[] | undefined;
    if (idi >= 0) {
      const raw = args[idi + 1];
      if (!raw) fail('`redo --ids <a,b,c>` requires a comma-separated id list');
      bulkIds = raw.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n));
      if (!bulkIds.length) fail('`redo --ids <a,b,c>` got no valid integer ids');
    }
    const bulk = core.redoScope(session, { under, fileSubstr: fileSub, ids: bulkIds });
    if (args.includes('--json')) {
      emitJson({ redone: bulk.redone, conflicts: bulk.conflicts, total: bulk.total });
      return;
    }
    const scope = fileSub ? ` in files matching "${fileSub}"` : under ? ` under ${relFile(under)}` : bulkIds ? ` in ${bulkIds.length} selected edit(s)` : '';
    if (bulk.total === 0) {
      process.stdout.write(c.dim(`no undone edits to redo${scope}\n`));
      return;
    }
    process.stdout.write(
      (bulk.conflicts ? c.yellow('⚠ ') : c.green('✓ ')) +
        `re-applied ${bulk.redone} edit(s)${scope}` +
        (bulk.conflicts ? ` · ${bulk.conflicts} conflict(s) left (redo individually with --force)` : '') +
        '\n'
    );
    return;
  }
  const id = requireId(args);
  const force = args.includes('--force');
  const res = force ? core.reapplyFile(session, id) : core.redoGroup(session, id);
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

/** Resolve the taskId argument: `--task <id>`, else the first positional (skipping flags + the
 *  --session value). A taskId is a content-hash slug (§2.1), never a path — no traversal to guard. */
function requireTaskId(args: string[], session: string): string {
  const flag = flagValue(args, '--task');
  const found = flag || pickTaskIdArg(args);
  if (!found) {
    // `tasklog` unions taskIds across worktrees and subagents, so an id it lists may belong to a
    // SIBLING session and have no strict span here. `changemap.tasks[]` is the per-session source.
    fail('expected a taskId, e.g. `claude-observatory task-keep <taskId>` (ids: `changemap` tasks[] / rollupByTask)');
  }
  // A taskId this session never had is a MISTAKE, not an empty result. keepTask/undoTask answer both
  // with a bare zero, so `task-keep <garbage>` printed a green "kept 0 edit(s)" and exited 0 — the
  // caller could not tell a typo from a task that simply had nothing pending. (no-silent-fail)
  const core = require('@claude-observatory/core') as Core;
  const known = core.sessionTaskIds(process.cwd(), session);
  if (!known.includes(found)) {
    fail(
      `no task ${found} in session ${session}.\n` +
        (known.length
          ? `  This session's task ids: ${known.join(', ')}`
          : '  This session has no tasks (nothing ever entered in_progress).')
    );
  }
  return found;
}

function pickTaskIdArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) {
      i++; // skip the flag's VALUE
      continue;
    }
    if (!args[i].startsWith('--')) return args[i];
  }
  return undefined;
}

/** `task-keep` (§6) — mark every PENDING edit in a task's STRICT in_progress span kept. Honest by
 *  construction: only edits made while the task was actually in progress are in the set (core
 *  taskEditIds) — an edit that cannot be strictly placed is never included. */
function cmdTaskKeep(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const taskId = requireTaskId(args, session);
  const res = core.keepTask(process.cwd(), session, taskId);
  core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
  if (args.includes('--json')) {
    emitJson({ kept: res.kept, total: res.total, ids: res.ids });
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `kept ${res.kept} edit(s) in task ${taskId}` +
      (res.total !== res.kept ? c.dim(` (${res.total} in the task's strict span)`) : '') +
      '\n'
  );
}

/** `task-undo` (§6) — revert every PENDING edit in a task's STRICT in_progress span, newest-first.
 *  Same strict set as task-keep; each revert stays conflict-guarded per edit. */
function cmdTaskUndo(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const taskId = requireTaskId(args, session);
  const res = core.undoTask(process.cwd(), session, taskId);
  core.autoClearDemo(session); // a fully reviewed demo session leaves no residue
  if (args.includes('--json')) {
    emitJson({ undone: res.undone, conflicts: res.conflicts, total: res.total, ids: res.ids });
    return;
  }
  process.stdout.write(
    (res.conflicts ? c.yellow('⚠ ') : c.green('✓ ')) +
      `reverted ${res.undone} edit(s) in task ${taskId}` +
      (res.conflicts ? ` · ${res.conflicts} conflict(s) left (undo individually with --force)` : '') +
      '\n'
  );
}

/** `task-clear` (§C) — drop the RESOLVED (kept/undone) edits of a task's STRICT edit set
 *  (core.taskEditIds → core.clearResolvedIds); pending edits are preserved. `--completed` clears
 *  every SETTLED task (edits present, none pending, none undone). */
function cmdTaskClear(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const json = args.includes('--json');
  if (args.includes('--completed')) {
    const map = core.buildChangeMap(process.cwd(), session, { root: process.cwd() });
    // A settled task: strict-attributed edits present, none pending, none undone.
    const settled = map.rollupByTask.filter((t) => t.taskId !== null && t.edits > 0 && t.pending === 0 && t.undone === 0);
    let cleared = 0;
    const ids: number[] = [];
    const tasks: { taskId: string; cleared: number }[] = [];
    for (const t of settled) {
      const res = core.clearResolvedIds(session, core.taskEditIds(process.cwd(), session, t.taskId!));
      cleared += res.cleared;
      ids.push(...res.ids);
      tasks.push({ taskId: t.taskId!, cleared: res.cleared });
    }
    if (json) {
      emitJson({ cleared, ids, tasks });
      return;
    }
    process.stdout.write(
      c.green('✓ ') + `cleared ${cleared} resolved edit(s) across ${tasks.length} completed task(s)\n`
    );
    return;
  }
  const taskId = requireTaskId(args, session);
  const res = core.clearResolvedIds(session, core.taskEditIds(process.cwd(), session, taskId));
  if (json) {
    emitJson({ cleared: res.cleared, ids: res.ids });
    return;
  }
  process.stdout.write(c.green('✓ ') + `cleared ${res.cleared} resolved edit(s) in task ${taskId}\n`);
}

/** `demo` (0.8.0) — the live simulator: replays a scripted Claude session through the REAL pipeline
 *  (transcript, captured edits, a subagent, a workflow) in an isolated demo-* session + folder, so
 *  every panel updates live and review/undo genuinely work. `--fast` lands the whole scenario in
 *  well under a second (the automated-test mode); `--clean` removes every trace. Zero token. */
async function cmdDemo(args: string[]): Promise<void> {
  const core = require('@claude-observatory/core') as Core;
  const dir = flagValue(args, '--dir');
  const json = args.includes('--json');
  // The tour's script, printed rather than replayed. Both editors read the --json form, so the tour
  // they render and the one this prints can never be two different tours.
  if (args.includes('--tour')) {
    // Three tracks over ONE script: `essentials` is the marked subset, `remainder` its exact complement
    // (so finishing the short track can resume rather than restart), both in script order.
    if (args.includes('--essentials') && args.includes('--remainder')) {
      fail('`demo --tour` takes --essentials or --remainder, not both — they are complementary halves of one script');
    }
    const track = args.includes('--essentials') ? 'essentials' : args.includes('--remainder') ? 'remainder' : 'everything';
    const steps = core.demoTour(track);
    if (json) {
      emitJson({ track, steps, sizes: core.demoTrackSizes(), blurb: core.demoTrackBlurb(track) });
      return;
    }
    steps.forEach((s, i) => {
      const where = s.view === 'overview' ? `Overview · ${s.tab}` : s.view;
      process.stdout.write(`\n${c.bold(`${i + 1}. ${s.title}`)}  ${c.dim(`— ${where}`)}\n`);
      for (const line of wrapText(s.body, 76)) process.stdout.write(`   ${line}\n`);
      // The one-line gloss both editors render under the body. Dropping it here made the printed tour
      // quietly shorter than the driven one, which is exactly the drift core owning the script prevents.
      if (s.tip) for (const line of wrapText(s.tip, 76)) process.stdout.write(c.dim(`   ${line}\n`));
      if (s.tryIt) for (const line of wrapText(`try: ${s.tryIt}`, 76)) process.stdout.write(c.dim(`   ${line}\n`));
      // The same two labels the editors' panels use, so the printed tour and the driven one read alike.
      if (s.action) {
        const label = s.action.mode === 'auto' ? 'the tour does this:' : 'your turn:';
        const text = s.action.mode === 'auto' ? s.action.done ?? s.action.hint : s.action.hint;
        for (const line of wrapText(`${label} ${text}`, 76)) process.stdout.write(c.cyan(`   ${line}\n`));
      }
    });
    const sizes = core.demoTrackSizes();
    process.stdout.write(c.dim(`\n${core.demoTrackBlurb(track)}\n`));
    process.stdout.write(
      c.dim(
        `${steps.length} steps · start the session they describe with: claude-observatory demo\n` +
          (track === 'everything'
            ? `  the short track is ${sizes.essentials} of these: demo --tour --essentials\n`
            : track === 'essentials'
              ? `  the other ${sizes.remainder}: demo --tour --remainder   ·   all ${sizes.everything}: demo --tour\n`
              : `  all ${sizes.everything} steps: demo --tour\n`)
      )
    );
    return;
  }
  // Keep a running demo inside the fleet's 60s active window while a tour explains it (mtime only —
  // nothing is written, no activity is invented). The editors call this on each step advance.
  if (args.includes('--touch')) {
    const touched = core.demoHeartbeat({ dir: dir || undefined });
    if (json) emitJson({ touched });
    else process.stdout.write(c.dim(`touched ${touched.length} demo transcript(s)\n`));
    return;
  }
  if (args.includes('--clean')) {
    const res = core.cleanDemo({ dir: dir || undefined });
    if (json) {
      emitJson(res);
      return;
    }
    if (!res.sessions.length && !res.workspaces.length && !res.scratch.length) {
      process.stdout.write(c.dim('nothing to remove — no demo recorded for this folder\n'));
      return;
    }
    process.stdout.write(
      c.green('✓ ') +
        `removed ${res.sessions.length} demo session(s)` +
        (res.workspaces.length ? ` and ${res.workspaces.map(relFile).join(', ')}` : '') +
        (res.scratch.length ? ` and ${res.scratch.length} scratch dir(s)` : '') +
        '\n'
    );
    return;
  }
  // `demo --status --json` — does a demo exist for this folder? The editors ask so they can keep
  // offering Exit after session resolution has moved on to a real session.
  if (args.includes('--status')) {
    const sessions = core.demoSessionsFor({ dir: dir || undefined });
    if (json) emitJson({ sessions });
    else process.stdout.write(sessions.length ? `${sessions.length} demo session(s): ${sessions.join(', ')}\n` : 'no demo recorded for this folder\n');
    return;
  }
  const speedRaw = flagValue(args, '--speed');
  const speed = speedRaw ? parseFloat(speedRaw) : undefined;
  let res: Awaited<ReturnType<Core['runDemo']>>;
  try {
    res = await core.runDemo({
      dir: dir || undefined,
      fast: args.includes('--fast'),
      speed,
      fleet: !args.includes('--no-fleet'),
      log: json ? undefined : (line) => process.stdout.write(c.dim(line) + '\n'),
    });
  } catch (e) {
    // A refused `--dir`, a read-only parent, a vanished cwd. These are the user's mistakes to correct,
    // so they get a sentence — never a stack trace.
    fail(e instanceof Error ? e.message : String(e));
  }
  if (json) {
    emitJson(res);
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `demo session ${res.session} is live — ${res.edits} pending edits in ${relFile(res.workspace)}` +
      (res.sibling ? ', plus a second agent on demo/hotfix' : '') +
      '\n' +
      c.dim('  guided tour: claude-observatory demo --tour   ·   remove every trace: claude-observatory demo --clean\n')
  );
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
  const json = args.includes('--json'); // structured results for front-ends/scripts (sibling to keep/undo)
  // Drop resolved (kept/undone) edits in the active session, keep pending. --under <path> scopes it to
  // a file/folder (the editors' folder/file Clear action).
  if (args.includes('--resolved')) {
    const ui = args.indexOf('--under');
    const under = flagValue(args, "--under");
    if (ui >= 0 && !under) fail('`clean --resolved --under <path>` requires a value');
    // --ids <a,b,c> clears an EXPLICIT edit set — the scope a prompt names, which no path can express
    // (one ask edits many folders). Same resolver both editors use, so neither invents its own scope.
    const idi = args.indexOf('--ids');
    if (idi >= 0) {
      const raw = args[idi + 1];
      if (!raw) fail('`clean --resolved --ids <a,b,c>` requires a comma-separated id list');
      const ids = raw
        .split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((n) => Number.isFinite(n));
      if (!ids.length) fail('`clean --resolved --ids <a,b,c>` got no valid integer ids');
      const res = core.clearResolvedIds(getSessionId(args), ids);
      if (json) {
        emitJson({ cleared: res.cleared, ids: res.ids });
        return;
      }
      process.stdout.write(c.green('✓ ') + `cleared ${res.cleared} resolved edit(s)\n`);
      return;
    }
    const n = core.clearResolved(getSessionId(args), under);
    if (json) {
      emitJson({ cleared: n, under: under ?? null });
      return;
    }
    process.stdout.write(c.green('✓ ') + `cleared ${n} resolved edit(s)${under ? ` under ${relFile(under)}` : ''}\n`);
    return;
  }
  // Destructive: drop a specific session.
  const di = args.indexOf('--drop');
  if (di >= 0) {
    const id = args[di + 1];
    if (!id) fail('`--drop <session-id>` requires a session id');
    if (!core.isSafeSessionId(id)) fail(`invalid session id "${id}" — refusing to delete.`);
    core.removeSession(id);
    if (json) {
      emitJson({ dropped: [id] });
      return;
    }
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
    if (json) {
      emitJson({ dropped: stale.map((s) => s.id), olderThan: spec });
      return;
    }
    process.stdout.write(c.green('✓ ') + `dropped ${stale.length} session(s) inactive > ${spec}\n`);
    return;
  }
  // Destructive: drop everything.
  if (args.includes('--all')) {
    const all = core.listSessions();
    for (const s of all) core.removeSession(s.id);
    if (json) {
      emitJson({ dropped: all.map((s) => s.id) });
      return;
    }
    process.stdout.write(c.green('✓ ') + `dropped all ${all.length} session(s)\n`);
    return;
  }
  // Safe default: garbage-collect orphaned blobs (optionally scoped to --session <id>), then
  // reclaim stub-session husks — dirs with no log that hold only Bash-walk snapshots. Iterates the
  // store root directly: listSessions skips log-less dirs, which made stubs unreclaimable.
  const si = args.indexOf('--session');
  const only = flagValue(args, '--session');
  // A missing value used to widen the scope from ONE session to the whole store — and this verb's sink
  // is pruneEmptySession → removeSession → recursive rm. Scope-widening on a typo is not a default.
  if (si >= 0 && !only) fail('`clean --session <id>` requires a session id');
  if (only && !core.isSafeSessionId(only)) fail(`invalid session id: ${JSON.stringify(only)}`);
  const targets = only ? [only] : core.allStoreSessionIds();
  let removed = 0;
  let bytes = 0;
  let pruned = 0;
  for (const id of targets) {
    const r = core.gcSession(id);
    removed += r.removed;
    bytes += r.bytes;
    if (core.pruneEmptySession(id)) pruned++;
  }
  if (json) {
    emitJson({ removed, bytes, pruned });
    return;
  }
  process.stdout.write(
    c.green('✓ ') +
      `garbage-collected ${removed} orphaned blob(s), freed ${fmtBytes(bytes)}` +
      (pruned ? `, pruned ${pruned} empty stub session(s)` : '') +
      '\n'
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
  if (i >= 0 && args[i + 1]) {
    sid = args[i + 1];
    // Guard a user-provided id like getSessionId does — computeStats derives a store path from it.
    if (!core.isSafeSessionId(sid)) fail(`invalid session id "${sid}" (letters, digits, dot, dash, underscore only).`);
  } else sid = core.resolveSessionId(process.cwd()) || undefined; // no session → global/default window
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
  const file = flagValue(args, '--file');
  if (!file) fail('`locate --file <path>` is required (current buffer text on stdin)');
  const abs = path.resolve(file);
  let current: string;
  try {
    current = fs.readFileSync(0, 'utf8'); // stdin
  } catch {
    fail('locate reads the current buffer on stdin, e.g. `claude-observatory locate --file f.ts < f.ts`');
  }
  // readLog is chronological and .filter keeps that order — which is what lets locateEditsInCurrent
  // compose one-edit-wide hops instead of re-aligning the whole buffer once per edit.
  const recs = core.readLog(session).filter((r) => r.status === 'pending' && r.file === abs);
  const blob = (sha: string | null): string => (sha ? core.readBlob(session, sha).toString('utf8') : '');
  const placed = core.locateEditsInCurrent(
    recs.length,
    (i) => ({ before: blob(recs[i].beforeBlob), after: blob(recs[i].afterBlob) }),
    current
  );
  // `removed` rides along for free now that one pass computes both — JetBrains renders no deletion
  // ghost text today only because this payload never carried it.
  const placements = recs.map((r, i) => ({ id: r.id, lines: placed[i].lines, removed: placed[i].removed }));
  emitJson({ file: abs, placements });
}

/** The full folder→file→class→edit tree (with exact deltas) — the shared view-model for both editors. */
function cmdTree(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const session = getSessionId(args);
  const ri = args.indexOf('--root');
  const root = flagValue(args, '--root') ?? process.cwd();
  const fi = args.indexOf('--filter');
  const filter = flagValue(args, '--filter');
  if (args.indexOf('--filter') >= 0 && !filter) fail('`tree --filter <substr>` requires a value');
  emitJson(core.buildEditTree(session, { root, filter }));
}

/** The session change-map: edits placed as module→file→class + strict per-task rollups, for the map webview.
 *  0.8.0 additive keys (removing nothing): the base build already carries per-edit `taskId` (strict
 *  spans) + `rollupByTask`/`rollupBySubagent`; this adds `rollupByAgent`, an `agents[]` array of a
 *  per-sibling change-map for every worktree of this repo (aggregated HERE — renderers stay thin), and
 *  the explicit `unassigned` task bucket (§3/§5). */
/**
 * Several read-only views in ONE process.
 *
 * The JetBrains plugin is a thin renderer with no way to call core in-process the way the VS Code
 * extension does, so it spawned one CLI per view — eight of them, every three-second tick. Two costs
 * follow, and only the first is obvious:
 *   · ~70 ms of node start-up per spawn before any work at all — measured, and paid eight times over;
 *   · every process re-derives the SAME transcript and log parses from cold, because core's memoization
 *     (`cachedByFiles`) dies with the process that holds it.
 * Run together they share those parses, which is the larger of the two savings.
 *
 * Each view is produced by CALLING ITS OWN COMMAND and capturing what it writes, so a batched payload is
 * byte-identical to the single-command one by construction — there is no second implementation to drift.
 * A view that fails is `null` rather than fatal: one unbuildable section must not cost the reader the
 * other seven, and `fail()`'s `process.exit` is caught for the same reason.
 */
function cmdViews(args: string[]): void {
  const vi = args.indexOf('--views');
  const DEFAULT = 'changemap,multitask,prompts,processes,sessions,observations,risk,egress';
  if (vi >= 0 && !flagValue(args, '--views')) fail('`views --views <a,b,c>` requires a comma-separated list');
  const names = (flagValue(args, '--views') ?? DEFAULT)
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  // Drop OUR selector, and only ours. `indexOf` returns -1 when `--views` is absent, and filtering on
  // `i !== vi + 1` then quietly removes argument ZERO — which is `--session`. Every view resolved the
  // newest session for the cwd instead of the one asked for, and the payloads looked plausible while
  // describing the wrong session entirely.
  const rest = vi >= 0 ? args.filter((_, i) => i !== vi && i !== vi + 1) : args;
  const viewArgs = rest.includes('--json') ? rest : [...rest, '--json'];
  const out: Record<string, unknown> = {};
  const realWrite = process.stdout.write.bind(process.stdout);
  const realExit = process.exit.bind(process);
  for (const name of names) {
    let buf = '';
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (chunk: string) => {
      buf += chunk;
      return true;
    };
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      throw new Error(`view ${name} exited ${code ?? 0}`);
    }) as (code?: number) => never;
    try {
      runView(name, viewArgs);
      out[name] = buf ? JSON.parse(buf) : null;
    } catch {
      out[name] = null;
    } finally {
      (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
      (process as unknown as { exit: typeof realExit }).exit = realExit;
    }
  }
  emitJson(out);
}

/** The views `views` may batch. An allow-list on purpose: nothing that MUTATES belongs in a poll. */
function runView(name: string, args: string[]): void {
  switch (name) {
    case 'changemap':
      return cmdChangeMap(args);
    case 'multitask':
      return cmdMultitask(args);
    case 'prompts':
      return cmdPrompts(args);
    case 'processes':
      return cmdProcesses(args);
    case 'sessions':
      return cmdSessions(args);
    case 'observations':
      return cmdObservations(args);
    case 'risk':
      return cmdRisk(args);
    case 'egress':
      return cmdEgress(args);
    case 'stats':
      return cmdStats(args);
    default:
      throw new Error(`unknown view ${name}`);
  }
}

function cmdChangeMap(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const ri = args.indexOf('--root');
  const root = flagValue(args, '--root') ?? process.cwd();
  // The composition lives in core (`overviewChangeMap`) so the VS Code extension — which bundles core
  // and calls it in-process everywhere else — can have this payload WITHOUT spawning a node process for
  // it. Two copies of fifty lines of sibling projection is how the front-ends stop agreeing.
  emitJson(core.overviewChangeMap(process.cwd(), session, { root }));
}


/** `chat-context` (§2.6/§7) — the zero-token chat handoff: assemble a ready-to-paste prompt about one
 *  action (`--tool-use-id`)/edit (`--edit`)/subagent (`--agent`)/task (`--task`), built in core (the
 *  single backend both editors call). Always JSON `{ prompt }`. NEVER spawns a process or calls a model. */
function cmdChatContext(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const ref: { toolUseId?: string; editId?: number; agentId?: string; taskId?: string } = {};
  const tu = flagValue(args, '--tool-use-id');
  if (tu) ref.toolUseId = tu;
  const ed = flagValue(args, '--edit');
  if (ed && /^\d+$/.test(ed)) ref.editId = parseInt(ed, 10);
  const ag = flagValue(args, '--agent');
  if (ag) ref.agentId = ag;
  const tk = flagValue(args, '--task');
  if (tk) ref.taskId = tk;
  emitJson({ prompt: core.assembleChatContext(process.cwd(), session, ref) });
}

type Core = typeof import('@claude-observatory/core');

/** Build the Observations payload (recap + per-edit reasoning/flags/memory) once — shared by the
 *  machine `observe --json` surface and the human `insights` view. */
function buildObserve(core: Core, session: string, cwd: string) {
  const log = core.readLog(session);
  const reasoning = core.reasoningByEdit(cwd, session);
  const insights = core.transcriptInsights(cwd, session);
  // Core owns the recap definition now (analysis > auto-title > last summary, with its source), so the
  // CLI and both editors can no longer disagree about what "recap" means.
  const recap = core.buildObservations(process.cwd(), session).recap || null;
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
  return { session, recap, insights, suggestions, edits };
}

/** One JSON payload for an Observations-style view: recap + per-edit reasoning/flags/memory. */
function cmdObserve(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  emitJson(buildObserve(core, getSessionId(args), process.cwd()));
}

/** `observations` (§B) — the 0.8.0 Observations view-model (Timeline folded in): a session recap on
 *  top, the edit timeline as coalesced same-file ×N runs (most-recent first) each edit carrying
 *  Claude's reasoning, and the still-open next steps at the end. Always JSON; both editors render it
 *  thin (or recompute the same shape from the same core fns). Zero token. */
function cmdObservations(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const ri = args.indexOf('--root'); // display-relative paths (editors point it at the workspace)
  const root = flagValue(args, '--root') ?? process.cwd();
  emitJson(core.buildObservations(process.cwd(), session, { root }));
}

/** `insights` — the human-readable Observations view (recap + per-edit summary/reasoning/flags/
 *  file-memory + next steps). The terminal counterpart to the editors' Observations panel. */
function cmdInsights(args: string[]): void {
  const core = require('@claude-observatory/core') as Core;
  const session = getSessionId(args);
  const p = buildObserve(core, session, process.cwd());
  if (args.includes('--json')) {
    emitJson(p);
    return;
  }
  if (p.edits.length === 0) {
    process.stdout.write(c.dim(`no edits yet (session ${session}).\n`));
    return;
  }
  process.stdout.write(c.bold('Observations') + c.dim(`  session ${session}\n`));
  if (p.recap) process.stdout.write(c.dim(p.recap) + '\n');
  process.stdout.write('\n');
  for (const e of p.edits) {
    process.stdout.write(
      `${c.bold('#' + e.id)}  ${statusLabel(e.status).padEnd(7)}  ${c.cyan(relFile(e.file))}  ${c.dim(e.summary)}\n`
    );
    if (e.reasoning) process.stdout.write('     ' + c.dim(e.reasoning.split('\n')[0].slice(0, 140)) + '\n');
    for (const f of e.flags) {
      process.stdout.write('     ' + (f.level === 'warn' ? c.yellow('⚠ ') : c.dim('· ')) + f.message + '\n');
    }
    if (e.memory.risky) process.stdout.write('     ' + c.yellow('⚑ ') + c.dim(e.memory.summary) + '\n');
  }
  if (p.suggestions.length) {
    process.stdout.write('\n' + c.bold('Next steps') + '\n');
    for (const s of p.suggestions) process.stdout.write('  • ' + s + '\n');
  }
}

/** The UsageLine snapshot (ctx / 5h / week) + the session's input/output/cache token split + its
 *  model/effort/compaction vitals + the shared staleness threshold; always JSON. Both editors' Stats
 *  panels consume this. */
function cmdUsage(args: string[]): void {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const si = args.indexOf('--session');
  const provided = si >= 0 && args[si + 1] ? args[si + 1] : undefined;
  // Guard a user-provided id like getSessionId does — usageLine derives a store path from it.
  if (provided && !core.isSafeSessionId(provided)) fail(`invalid session id "${provided}" (letters, digits, dot, dash, underscore only).`);
  const sid = provided || core.resolveSessionId(process.cwd()) || '';
  // sessionTokens = the session's cumulative input/output/cache split (+ cache hit rate), which the
  // editors' stats panels render under the session title; ctx/5h/week above are point-in-time limits.
  // vitals = which model/effort served the session, its compactions, and the context-fill series —
  // free here, since it shares the cursor sessionUsage just advanced.
  emitJson({
    ...core.usageLine(process.cwd(), sid),
    sessionTokens: core.sessionUsage(process.cwd(), sid),
    vitals: core.sessionVitals(process.cwd(), sid),
    staleMs: core.USAGE_STALE_MS,
  });
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
// The VS Code-family extension id (publisher.name). We detect the extension by its install DIR (like
// the JetBrains plugin dirs) so detection never depends on the editor CLI being on PATH; the CLI is
// only needed to APPLY the update, and is resolved from app-bundle locations when it's off PATH.
const VSCODE_EXT_ID = 'cell-observatory.claude-observatory-vscode';
// The id before 0.8.6, when the publisher changed (claude-observatory → cell-observatory). Editors
// treat it as a separate extension, so old-id installs must still be detected — and removed after a
// successful update to the renamed .vsix, or every migrated editor ends up with two Observatories.
const VSCODE_EXT_ID_OLD = 'claude-observatory.claude-observatory-vscode';
// One row per VS Code-family editor: where it keeps installed extensions (relative to $HOME), the CLI
// that drives `--install-extension`, and the macOS .app name used to locate that CLI when off PATH.
const VSCODE_EDITORS: { label: string; extDirs: string[]; cli: string; app: string }[] = [
  { label: 'VS Code', extDirs: ['.vscode/extensions', '.vscode-server/extensions'], cli: 'code', app: 'Visual Studio Code' },
  { label: 'Cursor', extDirs: ['.cursor/extensions'], cli: 'cursor', app: 'Cursor' },
  { label: 'VSCodium', extDirs: ['.vscodium/extensions'], cli: 'codium', app: 'VSCodium' },
  { label: 'Windsurf', extDirs: ['.windsurf/extensions'], cli: 'windsurf', app: 'Windsurf' },
];
// The JetBrains plugin unzips to this dir inside each IDE's plugins/ folder; we drop a version
// sentinel beside it so a later `update` can tell whether the installed plugin is already current.
const JB_PLUGIN_DIRNAME = 'claude-observatory-jetbrains';
const JB_VERSION_SENTINEL = '.observatory-version';
// The self-hosted JetBrains plugin repository, regenerated + attached to every GitHub Release by
// .github/workflows/release.yml. Add it ONCE under Settings → Plugins → ⚙ → Manage Plugin
// Repositories and the IDE auto-updates the plugin natively from then on (no more Install-from-Disk).
const JB_PLUGIN_REPO_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/updatePlugins.xml`;

type ReleaseAsset = { name: string; browser_download_url: string; digest?: string };

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

/** Verify downloaded bytes against GitHub's per-asset sha256 `digest`. Fails hard on mismatch (we're
 *  about to execute/extract them); warns if the release published no checksum. */
function assertDigest(bytes: Buffer, asset: ReleaseAsset): void {
  const crypto = require('crypto');
  const expected =
    typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : null;
  if (!expected) {
    process.stdout.write(c.yellow(`  ⚠ no published checksum for ${asset.name} — skipping integrity check\n`));
    return;
  }
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) {
    fail(`integrity check FAILED for ${asset.name} (sha256 ${actual} ≠ ${expected}) — refusing to install.`);
  }
  process.stdout.write(c.dim(`  ✓ sha256 verified (${asset.name})\n`));
}

/** Download a release asset to a fresh private temp file (0700 dir, 0600 file, exclusive create —
 *  no predictable-path symlink/TOCTOU on /tmp), integrity-checked before it lands. Returns the path. */
async function downloadAsset(asset: ReleaseAsset): Promise<string> {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  process.stdout.write(c.dim(`downloading ${asset.name} …\n`));
  const bytes = await httpGet(asset.browser_download_url);
  assertDigest(bytes, asset);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-observatory-'));
  const dest = path.join(dir, path.basename(asset.name));
  fs.writeFileSync(dest, bytes, { flag: 'wx', mode: 0o600 });
  return dest;
}

/** Download the CLI tarball from the release and `npm i -g` it (integrity-checked first — the tarball
 *  runs install lifecycle scripts as the current user). */
async function updateCliBinary(assets: ReleaseAsset[], latest: string, current: string): Promise<void> {
  const tgz = assets.find((a) => /\.tgz$/.test(a.name));
  if (!tgz) fail(`release v${latest} has no CLI tarball asset to install.`);
  const dest = await downloadAsset(tgz!);
  const cp = require('child_process');
  process.stdout.write(c.dim('installing globally (npm i -g) …\n'));
  const r = cp.spawnSync('npm', ['i', '-g', dest], { stdio: 'inherit' });
  if (r.status !== 0) fail(`npm install failed (exit ${r.status ?? '?'}). Try: npm i -g ${dest}`);
  process.stdout.write(c.green('✓ ') + `updated the CLI ${current} → ${latest}\n`);
}

/** Editors in the VS Code family (code/cursor/…) on PATH that already have our extension, with the
 *  installed version parsed from `--list-extensions --show-versions` (ids are lowercased by VS Code). */
/** Resolve an editor's CLI to an absolute path: PATH first, else known app-bundle locations (macOS
 *  .app bundles, Windows Programs dirs, common Linux dirs). Returns null when not found — the extension
 *  is still DETECTED via its dir, so a null means "installed but we can't drive an update", which the
 *  caller must SURFACE, never swallow. Mirrors core.resolveBin (candidates → PATH fallback). */
function resolveEditorCli(cli: string, app: string): string | null {
  if (onPath(cli)) return cli; // bare name; spawnSync resolves it via PATH
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const home = os.homedir();
  const cands: string[] = [];
  if (process.platform === 'darwin') {
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      cands.push(path.join(root, `${app}.app`, 'Contents', 'Resources', 'app', 'bin', cli));
    }
  } else if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) cands.push(path.join(process.env.LOCALAPPDATA, 'Programs', app, 'bin', `${cli}.cmd`));
    if (process.env.ProgramFiles) cands.push(path.join(process.env.ProgramFiles, app, 'bin', `${cli}.cmd`));
  } else {
    cands.push(`/usr/share/${cli}/bin/${cli}`, `/usr/bin/${cli}`, `/snap/bin/${cli}`, path.join(home, '.local', 'bin', cli));
  }
  for (const p of cands) {
    try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  return null;
}

/** Parse the version out of a VS Code extension folder named `<id>-<version>` (fallback: its
 *  package.json). Returns null if neither yields a semver. */
function versionFromExtFolder(folderPath: string, folderName: string, id: string): string | null {
  const suffix = folderName.slice(id.length + 1); // drop the `<id>-` prefix
  if (/^\d+\.\d+\.\d+/.test(suffix)) return suffix;
  try {
    const fs = require('fs');
    const path = require('path');
    return JSON.parse(fs.readFileSync(path.join(folderPath, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** VS Code-family installs of our extension, detected by their extensions DIR (CLI-independent, like
 *  the JetBrains plugin dirs). `version` = the newest install folder for that editor (old or new id);
 *  `cli` = the resolved absolute CLI path to apply an update, or null if none was found; `hasOld` =
 *  an install under the pre-0.8.6 id is present and should be removed once the renamed one is in. */
function vscodeInstalls(): { label: string; version: string; cli: string | null; extDirs: string[]; hasOld: boolean }[] {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const home = os.homedir();
  const out: { label: string; version: string; cli: string | null; extDirs: string[]; hasOld: boolean }[] = [];
  for (const ed of VSCODE_EDITORS) {
    let best: string | null = null; // newest version across this editor's extension dirs
    let hasOld = false;
    for (const rel of ed.extDirs) {
      const dir = path.join(home, rel);
      let entries: string[] = [];
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const e of entries) {
        // VS Code names extension folders `<publisher>.<name>-<version>` (lowercased).
        const id = [VSCODE_EXT_ID, VSCODE_EXT_ID_OLD].find((i) => e.toLowerCase().startsWith(i + '-'));
        if (!id) continue;
        if (id === VSCODE_EXT_ID_OLD) hasOld = true;
        const v = versionFromExtFolder(path.join(dir, e), e, id);
        if (v && (best === null || core.isNewer(v, best))) best = v;
      }
    }
    if (best !== null) out.push({ label: ed.label, version: best, cli: resolveEditorCli(ed.cli, ed.app), extDirs: ed.extDirs, hasOld });
  }
  return out;
}

/** Whether any of an editor's extension dirs (home-relative) holds an install folder of `id`. */
function hasExtFolder(extDirs: string[], id: string): boolean {
  const fs = require('fs');
  const path = require('path');
  const home = require('os').homedir();
  for (const rel of extDirs) {
    let entries: string[] = [];
    try { entries = fs.readdirSync(path.join(home, rel)); } catch { continue; }
    if (entries.some((e: string) => e.toLowerCase().startsWith(id + '-'))) return true;
  }
  return false;
}

/** Refresh the VS Code-family extension in every editor that already has it (never installs into an
 *  editor that lacks it). Downloads the .vsix once and `--install-extension --force`s it. */
async function refreshVscodeExtension(
  assets: ReleaseAsset[],
  latest: string,
  force: boolean
): Promise<'updated' | 'current' | 'blocked' | 'absent'> {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const installs = vscodeInstalls();
  if (installs.length === 0) return 'absent'; // genuinely not installed — the only OK silent case
  const stale = installs.filter((h) => force || core.isNewer(latest, h.version));
  if (stale.length === 0) {
    process.stdout.write(c.green('✓ ') + `VS Code extension up to date (${installs[0].version})\n`);
    return 'current';
  }
  // Installed but no CLI could be located: SURFACE it loudly with a fix — never skip in silence.
  const noCli = stale.filter((h) => !h.cli);
  for (const h of noCli) {
    process.stdout.write(
      c.yellow('  ⚠ ') +
        `${h.label} extension ${h.version} is installed, but its CLI wasn't found on PATH or in the usual app locations — can't auto-update it.\n` +
        c.dim(`    Fix: in ${h.label}, ⇧⌘P → "Shell Command: Install 'code' command in PATH", then re-run \`claude-observatory update\`;\n`) +
        c.dim(`    or install claude-observatory-vscode-v${latest}.vsix from the release manually.\n`)
    );
  }
  const actionable = stale.filter((h) => h.cli);
  let installed = 0;
  if (actionable.length) {
    const vsix = assets.find((a) => /\.vsix$/i.test(a.name));
    if (!vsix) {
      process.stdout.write(c.yellow(`  ⚠ release v${latest} has no .vsix asset — could not update the VS Code extension\n`));
    } else {
      const cp = require('child_process');
      const dest = await downloadAsset(vsix);
      for (const h of actionable) {
        const r = cp.spawnSync(h.cli as string, ['--install-extension', dest, '--force'], { stdio: 'inherit' });
        if (r.status === 0) {
          process.stdout.write(c.green('✓ ') + `${h.label} extension ${h.version} → ${latest}\n`);
          installed++;
          // Publisher change (0.8.6): drop the old-id install, but only once the renamed extension is
          // confirmed on disk — a --force reinstall of a pre-rename .vsix must not uninstall itself.
          if (h.hasOld && hasExtFolder(h.extDirs, VSCODE_EXT_ID)) {
            const u = cp.spawnSync(h.cli as string, ['--uninstall-extension', VSCODE_EXT_ID_OLD], { stdio: 'pipe' });
            if (u.status === 0) process.stdout.write(c.dim(`  removed the old ${VSCODE_EXT_ID_OLD} install (publisher changed in 0.8.6).\n`));
            else process.stdout.write(c.yellow(`  ⚠ ${h.label} still has the pre-0.8.6 install — uninstall the older "Claude Observatory" entry in its Extensions view.\n`));
          }
        } else {
          process.stdout.write(c.yellow(`  ⚠ ${h.label} --install-extension failed — install the .vsix manually from the release\n`));
        }
      }
      if (installed) process.stdout.write(c.dim('  fully quit the editor (⌘Q) once so the activity-bar icon refreshes.\n'));
    }
  }
  // 'blocked' when any stale install couldn't be applied (no CLI, no asset, or a failed install).
  return installed === stale.length ? 'updated' : 'blocked';
}

/** JetBrains plugin dirs across platforms — ports the detection in scripts/install-jetbrains.sh so
 *  `update` also works on an SSH host serving JetBrains Remote Development. */
function jetbrainsPluginDirs(): string[] {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const home = os.homedir();
  const PRODUCTS = ['PyCharm', 'IntelliJIdea', 'WebStorm', 'GoLand'];
  const dirs: string[] = [];
  const isDir = (p: string): boolean => {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  };
  const productDirs = (parent: string, sub: string | null): void => {
    let entries: string[] = [];
    try { entries = fs.readdirSync(parent); } catch { return; }
    for (const e of entries) {
      if (!PRODUCTS.some((p) => e.startsWith(p))) continue;
      const target = sub ? path.join(parent, e, sub) : path.join(parent, e);
      if (isDir(target)) dirs.push(target);
    }
  };
  // macOS: ~/Library/Application Support/JetBrains/<Product>*/plugins
  productDirs(path.join(home, 'Library', 'Application Support', 'JetBrains'), 'plugins');
  // Linux desktop: ~/.local/share/JetBrains/<Product>*  (plugins live directly in this dir)
  productDirs(path.join(home, '.local', 'share', 'JetBrains'), null);
  // Remote Development backends: ~/.config/JetBrains/RemoteDev-*/<project>/plugins
  const rd = path.join(home, '.config', 'JetBrains');
  try {
    for (const e of fs.readdirSync(rd)) {
      if (!e.startsWith('RemoteDev-')) continue;
      const projRoot = path.join(rd, e);
      try {
        for (const proj of fs.readdirSync(projRoot)) {
          const t = path.join(projRoot, proj, 'plugins');
          if (isDir(t)) dirs.push(t);
        }
      } catch {
        /* not a dir */
      }
    }
  } catch {
    /* no RemoteDev root */
  }
  // Windows: %APPDATA%\JetBrains\<Product>*\plugins
  if (process.env.APPDATA) productDirs(path.join(process.env.APPDATA, 'JetBrains'), 'plugins');
  return dirs;
}

/** Extract a .zip into destDir (unzip on macOS/Linux; Expand-Archive on Windows). */
function extractZip(zip: string, destDir: string): boolean {
  const cp = require('child_process');
  if (process.platform === 'win32') {
    const r = cp.spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${destDir}" -Force`],
      { stdio: 'ignore' }
    );
    return r.status === 0;
  }
  return cp.spawnSync('unzip', ['-qo', zip, '-d', destDir], { stdio: 'ignore' }).status === 0;
}

/** The installed JetBrains plugin version, read from its own jar (`lib/claude-observatory-jetbrains-
 *  <version>.jar`, laid down by every install method — `install-jetbrains.sh`, the IDE's "Install Plugin
 *  from Disk", and `update`), falling back to the `.observatory-version` sentinel that `update` also
 *  writes. Returns null only when neither is present. `pluginDir` = `.../plugins/claude-observatory-jetbrains`.
 *  (Before this, only `update` wrote the sentinel, so script/IDE installs read as null → perpetually "stale".) */
function jbInstalledVersion(pluginDir: string): string | null {
  const fs = require('fs');
  const path = require('path');
  try {
    for (const f of fs.readdirSync(path.join(pluginDir, 'lib'))) {
      if (f.includes('searchableOptions')) continue; // the -searchableOptions.jar carries the version too
      const m = /^claude-observatory-jetbrains-(\d+\.\d+\.\d+(?:[-.+][0-9A-Za-z.-]+)?)\.jar$/.exec(f);
      if (m) return m[1];
    }
  } catch {
    /* no lib/ dir — fall through to the sentinel */
  }
  try {
    return fs.readFileSync(path.join(pluginDir, JB_VERSION_SENTINEL), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** One-time setup line that turns a side-loaded JetBrains plugin into an auto-updating one: once
 *  JB_PLUGIN_REPO_URL is registered as a custom plugin repository, the IDE polls it for new releases. */
function jetbrainsAutoUpdateHint(): string {
  return (
    c.dim('  Auto-update future releases (one time): Settings → Plugins → ⚙ → Manage Plugin Repositories → +\n') +
    c.dim(`    → paste ${JB_PLUGIN_REPO_URL}\n`)
  );
}

/** Refresh the JetBrains plugin in every IDE plugins dir that already has it, by unzipping the release
 *  zip in place (the plugin can't hot-swap — the IDE must fully restart). Idempotent via a version
 *  sentinel written beside the plugin. */
async function refreshJetbrainsPlugin(
  assets: ReleaseAsset[],
  latest: string,
  force: boolean
): Promise<'updated' | 'current' | 'blocked' | 'absent'> {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const fs = require('fs');
  const path = require('path');
  const holders = jetbrainsPluginDirs().filter((d) => fs.existsSync(path.join(d, JB_PLUGIN_DIRNAME)));
  if (holders.length === 0) return 'absent';
  const stale = holders.filter((d) => {
    const v = jbInstalledVersion(path.join(d, JB_PLUGIN_DIRNAME));
    return force || v === null || core.isNewer(latest, v);
  });
  if (stale.length === 0) {
    process.stdout.write(c.green('✓ ') + `JetBrains plugin up to date (${latest})\n`);
    return 'current';
  }
  if (process.platform !== 'win32' && !onPath('unzip')) {
    process.stdout.write(c.yellow(`  ⚠ JetBrains plugin is out of date but \`unzip\` was not found — can't update it (install unzip, then re-run)\n`));
    return 'blocked';
  }
  const zip = assets.find((a) => /jetbrains.*\.zip$/i.test(a.name));
  if (!zip) {
    process.stdout.write(c.yellow(`  ⚠ release v${latest} has no JetBrains .zip asset — could not update the plugin\n`));
    return 'blocked';
  }
  const dest = await downloadAsset(zip);
  let installed = 0;
  for (const d of stale) {
    const pluginDir = path.join(d, JB_PLUGIN_DIRNAME);
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true }); // drop files gone from the new build
      if (!extractZip(dest, d)) throw new Error('extract failed');
      fs.writeFileSync(path.join(pluginDir, JB_VERSION_SENTINEL), latest);
      process.stdout.write(c.green('✓ ') + `JetBrains plugin → ${latest} (${d})\n`);
      installed++;
    } catch (e: any) {
      process.stdout.write(c.yellow(`  ⚠ could not install the JetBrains plugin into ${d}: ${e?.message || e}\n`));
    }
  }
  if (installed) {
    process.stdout.write(c.dim('  fully restart the IDE (⌘Q → reopen) — a running JVM can’t hot-swap plugin classes.\n'));
    process.stdout.write(jetbrainsAutoUpdateHint());
  }
  return installed === stale.length ? 'updated' : 'blocked'; // any dir that failed to extract → surface it
}

/**
 * `update` — refresh the CLI AND the locally-installed editor extensions from the latest GitHub
 * Release (marketplace-free). The CLI self-updates via `npm i -g`; the VS Code extension via
 * `code --install-extension --force`; the JetBrains plugin by unzipping into the IDE plugin dirs.
 * `--check` reports only; `--cli-only` is the old CLI-only behavior; `--force` reinstalls even if
 * already current.
 */
async function cmdUpdate(args: string[]): Promise<void> {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const current = version();
  const cliOnly = args.includes('--cli-only');
  const checkOnly = args.includes('--check');
  const force = args.includes('--force');
  let release: any;
  try {
    release = JSON.parse((await httpGet(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`)).toString('utf8'));
  } catch (e: any) {
    fail(`could not check for updates (need network access to github.com): ${e?.message || e}`);
  }
  const latest = String(release.tag_name || '').replace(/^v/i, '');
  if (!latest) fail('no published release found for the repository.');
  const assets: ReleaseAsset[] = release.assets || [];
  const cliStale = core.isNewer(latest, current);

  if (checkOnly) {
    process.stdout.write(cliStale ? c.yellow(`CLI: update available ${current} → ${latest}\n`) : c.green(`CLI: up to date (${current})\n`));
    if (!cliOnly) {
      const vs = vscodeInstalls();
      if (vs.length === 0) process.stdout.write(c.dim('VS Code: extension not detected\n'));
      else for (const h of vs) {
        if (!core.isNewer(latest, h.version)) process.stdout.write(c.green(`${h.label}: up to date (${h.version})\n`));
        else process.stdout.write(c.yellow(`${h.label}: ${h.version} → ${latest}`) + (h.cli ? '\n' : c.yellow('  (installed but no CLI found to update — install the shell `code` command)\n')));
      }
      const fs = require('fs');
      const path = require('path');
      const jb = jetbrainsPluginDirs().filter((d) => fs.existsSync(path.join(d, JB_PLUGIN_DIRNAME)));
      if (jb.length === 0) process.stdout.write(c.dim('JetBrains: plugin not detected\n'));
      else for (const d of jb) {
        const v = jbInstalledVersion(path.join(d, JB_PLUGIN_DIRNAME));
        process.stdout.write(v && !core.isNewer(latest, v) ? c.green(`JetBrains: up to date (${v})\n`) : c.yellow(`JetBrains: ${v || 'installed'} → ${latest} (${d})\n`));
      }
    }
    process.stdout.write(c.dim('run `claude-observatory update` to apply.\n'));
    return;
  }

  if (cliOnly) {
    if (cliStale) await updateCliBinary(assets, latest, current);
    else process.stdout.write(c.green('✓ ') + `claude-observatory CLI is up to date (${current})\n`);
    return;
  }

  if (cliStale) await updateCliBinary(assets, latest, current);
  const vscode = await refreshVscodeExtension(assets, latest, force);
  const jetbrains = await refreshJetbrainsPlugin(assets, latest, force);
  if (vscode === 'blocked' || jetbrains === 'blocked') {
    // Something is installed but couldn't be updated — never let this pass as success/silence.
    process.stdout.write(c.yellow('⚠ ') + 'an installed extension could not be updated (see the note above).\n');
    process.exitCode = 1;
    return;
  }
  if (!(cliStale || vscode === 'updated' || jetbrains === 'updated')) {
    if (vscode === 'absent' && jetbrains === 'absent') {
      process.stdout.write(
        c.green('✓ ') +
          `CLI is up to date (${latest}); no editor extensions detected locally.\n` +
          c.dim('  install the VS Code / JetBrains extensions via scripts/bootstrap.sh or the release assets.\n')
      );
    } else {
      process.stdout.write(c.green('✓ ') + `everything is up to date (${latest})\n`);
    }
  }
}

/** `version` — print the installed CLI version; with `--check` (or `--latest`), also fetch the newest
 *  GitHub Release live (not the daily cache) and say whether an update is available. The flag forms
 *  `-v` / `--version` stay a pure one-line print so scripts can rely on them. */
async function cmdVersion(args: string[]): Promise<void> {
  const cur = version();
  if (!(args.includes('--check') || args.includes('--latest'))) {
    process.stdout.write(`claude-observatory ${cur}\n`);
    return;
  }
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  let latest = '';
  try {
    const release = JSON.parse(
      (await httpGet(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`)).toString('utf8')
    );
    latest = String(release.tag_name || '').replace(/^v/i, '');
  } catch (e: any) {
    fail(`could not fetch the latest release (installed ${cur}; need network access to github.com): ${e?.message || e}`);
  }
  if (!latest) fail('no published release found for the repository.');
  writeUpdateCache({ checkedMs: Date.now(), latestTag: latest }); // an explicit check also freshens the daily nudge
  const newer = core.isNewer(latest, cur);
  process.stdout.write(
    `installed   ${c.bold(cur)}\n` +
      `latest      ${c.bold(latest)}   ${newer ? c.yellow('← update available') : c.green('✓ up to date')}\n`
  );
  if (newer) {
    process.stdout.write(c.dim('run `claude-observatory update` to apply, or `update --check` to see every surface.\n'));
  }
}

function usage(): void {
  process.stdout.write(
    `claude-observatory — per-edit Keep/Undo for Claude Code\n\n` +
      `  init [--project] [--with-statusline]\n` +
      `                       install capture hooks (--project = repo ./.claude/settings.json;\n` +
      `                       --with-statusline also installs the bundled status line)\n` +
      `  statusline           install/refresh the bundled claude-statusline (usage bars; needs bash+jq)\n` +
      `  uninstall [--project] [--all] [--purge-store]\n` +
      `                       remove the capture hooks (--all also reverts the bundled status line +\n` +
      `                       prints teardown steps; --purge-store also deletes the stored edits)\n` +
      `  status               show hooks + hook-path health + session + edit counts\n` +
      `  doctor [--json]      diagnose setup (hooks, PATH, config dir, session, status line) with fixes;\n` +
      `                       --markdown (--md) emits the report as Markdown\n` +
      `  update [--check] [--cli-only] [--force]\n` +
      `                       update the CLI AND refresh the locally-installed editor extensions from\n` +
      `                       the latest GitHub Release (VS Code via \`code --install-extension\`;\n` +
      `                       JetBrains by unzip into plugin dirs). --check reports only; --cli-only\n` +
      `                       skips the extensions; --force reinstalls even if already current\n` +
      `  sessions             this workspace's sessions, newest conversation first (● = this directory's)\n` +
      `  list [filters]       list edits (grouped by file); filters: --pending|--kept|--undone, --file <substr>\n` +
      `  timeline [--json]    edits newest-first as a chronological feed (time · id · Δ · file)\n` +
      `  actions [--json]     the full action timeline: EVERY tool call Claude made (reads, greps, bash,\n` +
      `                       web, subagents, to-dos), each with its result (alias: trace); --category <c> | --errors | --limit <n>\n` +

      `  egress [--json]      what this session reached beyond here: web hosts, MCP servers, network shell,\n` +
      `                       and the files it READ from outside the workspace (--root <d>)\n` +
      `  risk [--json]        shell commands that can destroy data / escalate privilege / touch secrets,\n` +
      `                       plus the edits that landed OUTSIDE the workspace (--all, --root <d>)\n` +
      `                       (with risk tiers), MCP servers, network, subagents — exercised, not approved\n` +
      `  processes [--json]   background shells this session left running (runtime · exit code · output);\n` +
      `                       --id <shell> shows one shell's full command + a tail of its output\n` +
      `  prompts [--json]     the session as the list of things YOU asked for, each with the edits,\n` +
      `                       files, folders, tokens, agents, workflows, tasks and shells it produced;\n` +
      `                       --id <n> drills into one; --id <n> --response prints Claude’s reply to it\n` +
      `  feed [--json]        what ONE thing is doing now — a tail of its activity;\n` +
      `                       --kind session|agent|workflow|task|process --id <id> [--limit <n>]\n` +
      `  subagents [--json]   every subagent this session spawned, each with its own action timeline + metrics (alias: agents)\n` +
      `  siblings [--json]    the other Claude Code sessions in THIS project (active/idle · pending · files · risk);\n` +
      `                       agent-facing digest for cross-agent awareness (alias: fleet); --all includes self;\n` +
      `                       --repo widens to every WORKTREE of the repo (adds worktree/branch/phase + conflicts)\n` +
      `  multitask                the multi-agent view: one row per running agent across every worktree (live phase,\n` +
      `                       sparkline, ±lines, risk) + nested subagents (phase/current task) + live file conflicts\n` +
      `  tasklog                    cross-agent task log: one row per stable taskId, unioned across worktrees + subagents\n` +
      `  metrics [--json]     session numbers: ±lines, action/error counts, subagent duration/tokens, tool latency\n` +
      `  diff <id>            show before/after for an edit\n` +
      `  keep <id>            mark an edit kept; bulk: --all | --file <substr> | --under <path>\n` +
      `                       an id and a bulk flag are mutually exclusive (they mean different things)\n` +
      `  undo <id> [--force]  surgically undo an edit (--force = per-file restore);\n` +
      `                       bulk (pending only): --all | --file <substr> | --under <path> | --ids <a,b,c>\n` +
      `                       an id and a bulk flag are mutually exclusive\n` +
      `  redo <id> [--force]  re-apply an undone edit;\n` +
      `                       bulk (undone only): --all | --file <substr> | --under <path> | --ids <a,b,c>\n` +
      `                       an id and a bulk flag are mutually exclusive\n` +
      `  task-keep <taskId>   keep every pending edit in a task's strict in-progress span (--json)\n` +
      `  task-undo <taskId>   revert every pending edit in a task's strict in-progress span (--json)\n` +
      `  task-clear <taskId>  drop a task's resolved (kept/undone) edits (--json);\n` +
      `                       --completed clears every settled task (edits present, all kept)\n` +
      `  demo [--fast] [--speed <n>] [--dir <folder>] [--no-fleet] [--json]\n` +
      `                       simulate a Claude session LIVE in an isolated demo-* session and folder:\n` +
      `                       a real transcript + captured edits + a subagent + a three-phase workflow\n` +
      `                       + a second agent in a sibling worktree — watch every panel update, then\n` +
      `                       review/undo for real; --fast for scripts/tests, --no-fleet for one agent.\n` +
      `                       Running it again RESETS the demo (it replaces any previous demo here)\n` +
      `  demo --tour [--essentials | --remainder] [--json]\n` +
      `                       the guided tour: what to look at, panel by panel. --essentials is the\n` +
      `                       short track through the same script; --remainder is its exact complement\n` +
      `  demo --touch [--json]  keep a running demo inside the fleet's active window (mtime only)\n` +
      `  demo --clean [--json]  remove every trace (both sessions, stores, demo folder, scratch dir)\n` +
      `  demo --status [--json] whether a demo is recorded for this folder\n` +
      `  clean [opts]         GC orphaned blobs (--session <id> scopes; --json for structured output);\n` +
      `                       --drop <id> | --older-than <Nd> | --all | --resolved [--under <path> | --ids <a,b,c>]\n` +
      `  stats [--json]       usage stats (edits/tokens/messages/thinking/output) by session & window\n` +
      `  summary [--markdown] per-session review recap (kept/reverted per file); --markdown to export\n` +
      `  insights [--json]    Observations view: recap + per-edit reasoning/flags/file-memory + next steps\n\n` +
      `machine-readable (for front-ends/scripts; list/status/sessions/keep/undo/redo also take --json):\n` +
      `  blob <sha>           raw blob bytes to stdout\n` +
      `  tree [--root <d>] [--filter <q>]   folder→file→class→edit view-model as JSON (both editors)\n` +
      `  changemap [--root <d>]             session change-map (edits + per-file/per-folder rollups + per-agent slices) as JSON\n` +
      `  views [--views <a,b,c>] [--root <d>]\n` +
      `                       run several READ-ONLY views in ONE process and emit {name: payload} —\n` +
      `                       each is byte-identical to its own command. Default set: changemap,\n` +
      `                       multitask, prompts, processes, sessions, observations, risk, egress;\n` +
      `                       stats is accepted by name too, though nothing batches it by default.\n` +
      `                       A view that fails is null rather than fatal to the batch; a mutating\n` +
      `                       verb is refused. The JetBrains Overview polls its eight views through it.\n` +
      `  chat-context [--tool-use-id <id> | --edit <n> | --agent <id> | --task <id>]\n` +
      `                       assemble a zero-token, ready-to-paste chat prompt about an action/edit/subagent/task\n` +
      `  locate --file <f>    per-pending-edit line indices in the live buffer (text on stdin; JSON out)\n` +
      `  observe              recap + per-edit reasoning/flags/memory as JSON\n` +
      `  observations [--root <d>]   Observations view-model: recap + timeline runs (adjacent same-file\n` +
      `                       edits coalesced ×N, each with reasoning) + next steps, as JSON\n` +
      `  usage                ctx / 5h / week snapshot + session token split + model/effort/compaction\n` +
      `                       vitals, as JSON\n\n` +
      `opt-in, token-spending (runs \`claude -p\`; returns the cached result unless --fresh):\n` +
      `  analyze <id>         deep-analyze one edit    [--json --fresh --claude-bin <path>]\n` +
      `  recap                one-line session recap   [--json --fresh --claude-bin <path>]\n` +
      `  suggest              next-steps + suggestions [--json --fresh --claude-bin <path>]\n\n` +
      `  --session <id>       target a specific session instead of the newest\n` +
      `  version [--check]    print the installed version; --check (or --latest) also shows the latest release\n` +
      `  --version            print the installed CLI version\n`
  );
}

// --- once-a-day "update available" nudge -------------------------------------------------------
// Cache-first + detached refresh (like npm's update-notifier): reading the cache is synchronous and
// offline-safe, so a real command is NEVER delayed; the network check runs in a detached child that
// fills the cache for the NEXT run. Only for interactive (TTY) human invocations — never the capture
// hot path, `--json` output, or the JetBrains plugin. Opt out: CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1.

type UpdateCache = { checkedMs: number; latestTag: string | null };

function updateCachePath(): string {
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  return require('path').join(core.rootDir(), '.update-check');
}

function readUpdateCache(): UpdateCache | null {
  try {
    const j = JSON.parse(require('fs').readFileSync(updateCachePath(), 'utf8'));
    if (typeof j?.checkedMs === 'number') {
      return { checkedMs: j.checkedMs, latestTag: typeof j.latestTag === 'string' ? j.latestTag : null };
    }
  } catch {
    /* no cache yet / unreadable — treated as "never checked" */
  }
  return null;
}

function writeUpdateCache(v: UpdateCache): void {
  try {
    const fs = require('fs');
    const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
    fs.mkdirSync(core.rootDir(), { recursive: true });
    fs.writeFileSync(updateCachePath(), JSON.stringify(v));
  } catch {
    /* best-effort — the nudge is non-essential, never fail a command over it */
  }
}

/** The internal `__update-check` command (spawned detached): fetch the latest release tag and cache it.
 *  Prints nothing; failures are swallowed so an offline machine just keeps the previous cached tag. */
async function refreshUpdateCache(): Promise<void> {
  try {
    const release = JSON.parse(
      (await httpGet(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`)).toString('utf8')
    );
    const tag = String(release.tag_name || '').replace(/^v/i, '') || null;
    writeUpdateCache({ checkedMs: Date.now(), latestTag: tag });
  } catch {
    /* offline / rate-limited: the parent already wrote a throttle timestamp; keep the old tag */
  }
}

function shouldCheckUpdates(cmd: string | undefined, rest: string[]): boolean {
  if (process.env.CLAUDE_OBSERVATORY_NO_UPDATE_CHECK) return false;
  if (!process.stderr.isTTY) return false; // pipes, the JetBrains plugin, CI, cron — never nudged
  if (rest.includes('--json')) return false; // a machine-readable invocation
  // The capture hot path, self/redundant commands, and non-work invocations get no nudge.
  const SKIP = new Set(['capture', '__update-check', 'update', 'demo', 'version', '--version', '-v', 'help', '--help', '-h']);
  return cmd !== undefined && !SKIP.has(cmd);
}

/** Register the once-a-day update nudge (which prints on the NEXT run, after the command's own output)
 *  and kick a detached refresh if the cached check is older than a day. Cheap and non-blocking. */
function maybeCheckForUpdate(cmd: string | undefined, rest: string[]): void {
  if (!shouldCheckUpdates(cmd, rest)) return;
  const core = require('@claude-observatory/core') as typeof import('@claude-observatory/core');
  const cache = readUpdateCache();
  const cur = version();
  if (cache?.latestTag && core.isNewer(cache.latestTag, cur)) {
    const latest = cache.latestTag;
    // Print AFTER the command's output, once, to stderr — never pollutes stdout / --json consumers.
    process.on('exit', () => {
      try {
        process.stderr.write(c.dim(`\nupdate available (${cur} → ${latest}) — run \`claude-observatory update\`\n`));
      } catch {
        /* stream already closed */
      }
    });
  }
  const DAY = 24 * 60 * 60 * 1000;
  if (!cache || Date.now() - cache.checkedMs > DAY) {
    writeUpdateCache({ checkedMs: Date.now(), latestTag: cache?.latestTag ?? null }); // optimistic throttle
    try {
      require('child_process')
        .spawn(process.execPath, [__filename, '__update-check'], { detached: true, stdio: 'ignore' })
        .unref();
    } catch {
      /* couldn't spawn the background check — no nudge this cycle, no harm */
    }
  }
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
  // A subcommand invoked with --help/-h prints usage instead of erroring on a missing positional arg
  // (e.g. `diff --help`, `task-keep --help`); do it before the nudge so a help invocation stays quiet.
  if (cmd !== undefined && (rest.includes('--help') || rest.includes('-h'))) {
    usage();
    return;
  }
  maybeCheckForUpdate(cmd, rest); // register a once-a-day "update available" nudge (never blocks)
  // A throw from a SYNC command should surface as `claude-observatory: <msg>`, not a raw Node stack.
  // process.exit() throws nothing, so a command's own exit is never caught here; async commands keep
  // their own .catch(fail) below.
  try {
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
      cmdUninstall(rest);
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
    case 'timeline':
      cmdTimeline(rest);
      break;
    case 'actions':
    case 'trace':
      cmdActions(rest);
      break;
    case 'risk':
      cmdRisk(rest);
      break;
    case 'egress':
      cmdEgress(rest);
      break;
    case 'footprint':
      cmdFootprint(rest);
      break;
    case 'capabilities':
      // 0.8.6 shipped this verb; 0.8.7 renamed it to `footprint`. Keep it working rather than answering
      // an upgrade with "unknown command", and put the notice on STDERR — a line on stdout would corrupt
      // `capabilities --json` for anything already piping it.
      process.stderr.write(c.dim('`capabilities` was renamed to `footprint` in 0.8.7 — running `footprint`.\n'));
      cmdFootprint(rest);
      break;
    case 'processes':
      cmdProcesses(rest);
      break;
    case 'prompts':
      cmdPrompts(rest);
      break;
    case 'feed':
      cmdFeed(rest);
      break;
    case 'subagents':
    case 'agents':
      cmdSubagents(rest);
      break;
    case 'siblings':
    case 'fleet':
      cmdSiblings(rest);
      break;
    case 'multitask':
      cmdMultitask(rest);
      break;
    case 'tasklog':
      cmdTaskLog(rest);
      break;
    case 'metrics':
      cmdMetrics(rest);
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
    case 'task-keep':
      cmdTaskKeep(rest);
      break;
    case 'task-undo':
      cmdTaskUndo(rest);
      break;
    case 'task-clear':
      cmdTaskClear(rest);
      break;
    case 'demo':
      void cmdDemo(rest);
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
    case 'views':
      cmdViews(rest);
      break;
    case 'changemap':
      cmdChangeMap(rest);
      break;
    case 'chat-context':
      cmdChatContext(rest);
      break;
    case 'observe':
      cmdObserve(rest);
      break;
    case 'observations':
      cmdObservations(rest);
      break;
    case 'insights':
      cmdInsights(rest);
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
    case '__update-check':
      // Internal, hidden: spawned detached by maybeCheckForUpdate to refresh the update cache.
      void refreshUpdateCache();
      break;
    case 'suggest':
      cmdSuggest(rest).catch((e) => fail(String(e?.message || e)));
      break;
    case '--version':
    case '-v':
      process.stdout.write(`claude-observatory ${version()}\n`);
      break;
    case 'version':
      cmdVersion(rest).catch((e) => fail(String(e?.message || e)));
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
  } catch (e: any) {
    fail(String(e?.message || e));
  }
}

main();
