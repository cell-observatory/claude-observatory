/**
 * The data hub behind a live CLI surface: spawn, coalesce, mutate, and notice when the world changed.
 *
 * Every read re-executes THIS CLI's own verbs in a child process rather than calling core in-process.
 * That is not caution about speed in the average case — it is that the worst case blocks. A cold
 * change-map build is measured in seconds on a real session, and the on-disk cache is keyed to the
 * transcript and log stamps, so every new edit invalidates it — continuously, in exactly the scenario
 * a live dashboard exists for. In an editor that cost showed up as a frozen host; in a terminal UI it
 * is a dead keyboard.
 */
import * as fs from 'fs';
import * as path from 'path';

type Core = typeof import('@claude-observatory/core');

export interface Backend {
  /** Ask for a set of views. Identical in-flight requests are dropped; a different one queues. */
  request(views: string[], session: string, extra?: string[]): void;
  onData(fn: (payload: Record<string, unknown> | null, err: string | null) => void): void;
  /** Serialized, and never dropped. Resolves with the CLI's own JSON. */
  mutate(verb: 'keep' | 'undo' | 'redo', ids: number[], session: string): Promise<{ ok: boolean; json: unknown; err: string | null }>;
  /** Keep or undo everything pending at-or-beneath one path — the change map's file/folder action.
   *  `--under` is the CLI's own scope, so file-scope and folder-scope share one exact rule with the
   *  editors instead of this surface re-deriving an id set the two could disagree about. */
  mutateUnder(verb: 'keep' | 'undo', under: string, session: string): Promise<{ ok: boolean; json: unknown; err: string | null }>;
  /** The coloured unified patch for one edit, as the `diff` verb prints it. */
  diff(id: number, session: string): Promise<string>;
  /** True once the CLI on disk is no longer the one this process is running. */
  updateSkew(): boolean;
  /** What `version --check` reports. Spawned, because it reaches the network and a dashboard that
   *  blocked its repaint on a release lookup would read as hung. */
  check(): Promise<string>;
  /** Run one CLI verb and hand back its plain output — command mode's door. The caller passes an
   *  ALLOW-LISTED argv, never a user string: this spawns a process, and a text field that reaches a
   *  process is how a prompt becomes a shell. */
  run(args: readonly string[]): Promise<string>;
  watcherMode(): string;
  close(): void;
}

/** Never below this between reads, even under a storm of filesystem events. */
const MIN_TICK_MS = 3000;

export function createBackend(opts: {
  core: Core;
  cwd: string;
  session: string;
  onDegrade: (why: string) => void;
}): Backend {
  const { core } = opts;
  const listeners: ((p: Record<string, unknown> | null, e: string | null) => void)[] = [];
  let inflight: string | null = null;
  let rerun: { views: string[]; session: string; extra: string[] } | null = null;
  let lastStart = 0;
  let lastDuration = 0;
  let closed = false;
  let mode = 'native';
  let queue: Promise<unknown> = Promise.resolve();

  // The CLI can be replaced underneath a long-running dashboard (`update` rewrites it in place), after
  // which every child is a different build from the parent. Stat-ing argv[1] costs nothing and is the
  // only signal available — the payloads deliberately carry no version, because adding one would break
  // their byte-identity with the standalone commands.
  const selfPath = process.argv[1];
  const stampSelf = (): string => {
    try {
      const st = fs.statSync(selfPath);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return '';
    }
  };
  const bootStamp = stampSelf();

  /**
   * Run one of our own verbs in a child.
   *
   * `process.execPath` sidesteps every Windows spawn rule at once: it ends in `.exe`, so the launcher
   * takes the direct path — no shell, no quoting, no PATH lookup, and a genuine ENOENT if it is wrong.
   * It also guarantees the child is the same build as the parent.
   */
  const spawnSelf = (args: string[]): Promise<{ out: string; err: string; code: number | null }> =>
    new Promise((resolve) => {
      const child = core.spawnTool(process.execPath, [selfPath, ...args], {
        cwd: opts.cwd,
        // stdin 'ignore': with 'inherit' the child competes for the parent's raw-mode stdin and eats
        // keystrokes. stderr 'pipe': `views` never redirects stderr, so 'inherit' would paint a failing
        // view's red text straight onto the alternate screen — and 'ignore' would swallow the reason.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' },
      });
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      child.stdout?.on('data', (d: Buffer) => outChunks.push(d));
      child.stderr?.on('data', (d: Buffer) => errChunks.push(d));
      child.on('error', (e: Error) => resolve({ out: '', err: String(e.message || e), code: null }));
      child.on('close', (code: number | null) =>
        resolve({ out: Buffer.concat(outChunks).toString('utf8'), err: Buffer.concat(errChunks).toString('utf8').trim(), code })
      );
    });

  const emit = (p: Record<string, unknown> | null, e: string | null) => {
    for (const fn of listeners) fn(p, e);
  };

  const run = async (views: string[], session: string, extra: string[]) => {
    const key = `${views.join(',')}|${session}|${extra.join(',')}`;
    if (inflight) {
      // An identical request while one is running is redundant; a DIFFERENT one is the newest truth,
      // so it replaces whatever was queued rather than joining a backlog.
      if (inflight !== key) rerun = { views, session, extra };
      return;
    }
    inflight = key;
    lastStart = Date.now();
    const t0 = Date.now();
    const { out, err, code } = await spawnSelf(['views', '--views', views.join(','), '--json', '--session', session, ...extra]);
    lastDuration = Date.now() - t0;
    inflight = null;
    if (!closed) {
      let parsed: Record<string, unknown> | null = null;
      let problem: string | null = null;
      try {
        // Parse regardless of the exit code: several verbs exit non-zero while still emitting their
        // full JSON (`undo` does exactly that on a conflict), so treating a code as failure would turn
        // a real answer into an error.
        parsed = out.trim() ? (JSON.parse(out) as Record<string, unknown>) : null;
      } catch {
        problem = err || `views exited ${code ?? '?'} without valid JSON`;
      }
      if (!parsed && !problem) problem = err || 'views produced no output';
      // A payload can arrive whole and still carry broken views: `views` emits `__problems` naming
      // each one it could not build. Without this the dashboard painted those views as zeros and said
      // "ready" — "could not read" and "nothing happened" produced byte-identical frames, which is the
      // failure this project's no-silent-fail rule exists to prevent.
      if (parsed && parsed.__problems && typeof parsed.__problems === 'object') {
        const bad = Object.entries(parsed.__problems as Record<string, string>);
        if (bad.length && !problem) {
          problem = bad.length === 1
            ? `${bad[0][0]} could not be read — ${bad[0][1]}`
            : `${bad.length} views could not be read (${bad.map(([k]) => k).join(', ')}) — ${bad[0][1]}`;
        }
      }
      emit(parsed, problem);
    }
    const next = rerun;
    rerun = null;
    if (next && !closed) void run(next.views, next.session, next.extra);
  };

  let lastRequest: { views: string[]; session: string; extra: string[] } | null = null;

  const watcher = core.createWatcher({
    roots: core.observatoryRoots({ cwd: opts.cwd, session: opts.session }),
    onChange: () => {
      if (closed || !lastRequest) return;
      // Back off to twice the last build when that is slower than the floor: a cold six-second read on
      // a fixed three-second tick queues children faster than they finish.
      const floor = Math.max(MIN_TICK_MS, lastDuration * 2);
      if (Date.now() - lastStart < floor) return;
      void run(lastRequest.views, lastRequest.session, lastRequest.extra);
    },
    onDegrade: (dir, why) => {
      mode = 'poll';
      opts.onDegrade(`watching ${path.basename(dir)} degraded: ${why}`);
    },
  });
  mode = watcher.stats().every((s) => s.mode === 'poll') ? 'poll' : watcher.stats()[0]?.mode ?? 'native';

  return {
    request(views, session, extra = []) {
      lastRequest = { views, session, extra };
      void run(views, session, extra);
    },
    onData(fn) {
      listeners.push(fn);
    },
    mutate(verb, ids, session) {
      // Serialized: the undo engine appends to a shared log, and two concurrent bulk verbs would
      // interleave. Mutations are never deduped and never dropped — a reviewer's decision is not
      // something to coalesce.
      const p = queue.then(async () => {
        // EXPAND EVERY ID TO ITS REVIEW GROUP FIRST. What a surface displays as one row is often
        // several raw records: `reviewEdits` collapses a same-code chain (a→ab→a) into a single unit
        // and shows the most recent member's id. `--ids` is group-UNAWARE — it acts on raw records —
        // so sending the displayed id alone keeps or reverts one member and leaves the rest pending,
        // at an intermediate state no surface can name. Measured on a real session: 365 raw records
        // collapse to 323 units, 35 of them multi-member, so roughly one row in ten was affected.
        // The single-id CLI verbs already expand via keepGroup/undoGroup; this is the same rule for
        // the id-set path. `groupMembers` returns [id] for an ungrouped edit, so this is safe for all,
        // and `undoScope` sorts newest-first, which is the order a chained group must be reverted in.
        const expanded: number[] = [];
        const seen = new Set<number>();
        for (const id of ids) {
          for (const m of core.groupMembers(session, id)) {
            if (!seen.has(m)) {
              seen.add(m);
              expanded.push(m);
            }
          }
        }
        const { out, err, code } = await spawnSelf([verb, '--ids', expanded.join(','), '--session', session, '--json']);
        let json: unknown = null;
        try {
          json = out.trim() ? JSON.parse(out) : null;
        } catch {
          /* reported through err below */
        }
        // A conflict exits 1 WITH a full payload, so `ok` follows the JSON, not the exit code.
        return { ok: json !== null, json, err: json === null ? err || `${verb} exited ${code ?? '?'}` : null };
      });
      queue = p.catch(() => undefined);
      return p;
    },
    mutateUnder(verb, under, session) {
      // Same queue as `mutate`: two decisions must not interleave, whichever scope they came from.
      // No id expansion here — `--under` resolves its own set inside the CLI, over whole records, so
      // a review group cannot be half-acted-on the way an `--ids` list could.
      const p = queue.then(async () => {
        const { out, err, code } = await spawnSelf([verb, '--under', under, '--session', session, '--json']);
        let json: unknown = null;
        try {
          json = out.trim() ? JSON.parse(out) : null;
        } catch {
          /* reported through err below */
        }
        return { ok: json !== null, json, err: json === null ? err || `${verb} --under exited ${code ?? '?'}` : null };
      });
      queue = p.catch(() => undefined);
      return p;
    },
    async diff(id, session) {
      // The `diff` verb already renders a unified patch with colour — the same one the CLI prints —
      // so the dashboard shows exactly what `claude-observatory diff <id>` shows rather than a second
      // formatting of the same blobs that could drift from it.
      // `--patch`: the trailer the verb prints for a human ("keep #5 · undo #5") is not diff, and the
      // renderer has no way to tell — it arrived as a context line at the foot of every edit.
      const { out, err } = await spawnSelf(['diff', String(id), '--patch', '--session', session]);
      return out || err;
    },
    async check() {
      const { out, err } = await spawnSelf(['version', '--check']);
      const text = (out || err || '').trim();
      // No silent fail: an empty answer is reported as one, never as "up to date".
      return text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || 'no update information came back';
    },
    updateSkew() {
      return bootStamp !== '' && stampSelf() !== bootStamp;
    },
    async run(args) {
      const { out, err, code } = await spawnSelf([...args]);
      return code === 0 ? out : (err || out || `exited ${code}`);
    },
    watcherMode() {
      return mode;
    },
    close() {
      closed = true;
      watcher.close();
    },
  };
}
