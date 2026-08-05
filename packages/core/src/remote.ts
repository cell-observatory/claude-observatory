/**
 * Claude Code sessions on ANOTHER machine, over SSH.
 *
 * Read-only, deliberately and completely. Every command this module runs is `ls`, `stat` or `head`
 * against the remote's Claude config directory; nothing writes, nothing reverts, nothing is fetched
 * beyond the first few hundred bytes of a transcript. A reviewer's undo rewrites files on disk, and
 * doing that down an SSH pipe — against a working tree this machine cannot see, with no way to check
 * the result — is not a feature, it is a way to lose someone else's work.
 *
 * ONE round trip per host. A per-file `ssh` would be a TCP connection and a key exchange per
 * transcript; on a busy machine that is hundreds of them, and the listing would take longer than the
 * conversation it is listing. The remote runs a single `sh -c` that walks its projects directory and
 * prints one tab-separated line per transcript, which this side parses.
 *
 * Failure is REPORTED, never swallowed. A host that is down, a key that is not loaded, a machine with
 * no Claude Code on it and a machine with no sessions yet are four different facts, and a picker that
 * renders all of them as an empty list is a picker that lies about three of them.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnToolSync } from './spawn';
import { rootDir } from './store';
import { REMOTE_SCAN_PY } from './remote-scan.py';
// The SAME title rule the local rows use — a remote row and a local row for the same conversation
// have to read identically, and two copies of the regex is a promise kept by hand.
import { normalizeSessionTitle } from './observe';
import { CONFIG_DIR_OK, type Remote } from './prefs';

export type { Remote };

export interface RemoteSession {
  id: string;
  /** The remote workspace's slug, and a readable label derived the same way local ones are. */
  slug: string;
  workspace: string;
  lastActiveMs: number;
  bytes: number;
  /** True when the transcript is a single `bridge-session` pointer rather than a conversation. */
  bridged: boolean;
  /** Best-effort, from a bounded head of the transcript — never a whole-file scan across the wire. */
  title: string | null;
}

export interface RemoteListing {
  host: string;
  name: string;
  sessions: RemoteSession[];
  /** Null on success. A sentence naming what went wrong, otherwise — never an empty list standing in
   *  for a failure. */
  error: string | null;
  /** True when the host answered and simply has no sessions. Distinct from `error`. */
  reachable: boolean;
}

/**
 * The remote half, as one shell command.
 *
 * Everything is tab separated and each sample is stripped of tabs and newlines before it is printed,
 * so one transcript can never become two rows.
 */
function remoteScript(configDir: string): string {
  return [
    `d=${configDir}/projects`,
    `[ -d "$d" ] || { echo "NOPROJECTS"; exit 0; }`,
    `echo "OK"`,
    `for w in "$d"/*/; do`,
    `  [ -d "$w" ] || continue`,
    `  s=$(basename "$w")`,
    `  for f in "$w"*.jsonl; do`,
    `    [ -f "$f" ] || continue`,
    `    id=$(basename "$f" .jsonl)`,
    // seconds since epoch, portable across GNU/BSD stat
    `    m=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)`,
    `    b=$(wc -c < "$f" 2>/dev/null | tr -d " ")`,
    // TWO samples, because they answer different questions and the first line answers only one.
    // `p` is the first line, which is where a bridge pointer lives. `h` is the first summary/user
    // record within a bounded 64KB — a real transcript opens with a `mode` record, so reading only
    // line one produced a title of null for every remote session on the first host this ran against.
    // `head -c` bounds the READ, so this never pulls a 50MB transcript across the wire.
    `    p=$(head -c 200 "$f" 2>/dev/null | head -1 | tr -d "\\t\\r\\n")`,
    // The same exclusions the local first-prompt rule uses: a sidechain turn is a subagent's, and the
    // `<ide_opened_file>` / `<local-command-caveat>` records are wrappers Claude Code injects, not
    // anything a human typed. Without this the remote rows were titled with editor chatter.
    `    h=$(head -c 65536 "$f" 2>/dev/null | grep -E '"type":"(summary|user)"' | grep -v -E '<local-command|<ide_|<command-|tool_result|"isSidechain":true' | head -1 | head -c 400 | tr -d "\\t\\r\\n")`,
    `    printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$s" "$id" "$m" "$b" "$p" "$h"`,
    `  done`,
    `done`,
    // Joined with NEWLINES, not `; `. A `;` after `do` is a shell syntax error, and the first run of
    // this against a real host came back `sh: 1: Syntax error: ";" unexpected` — the script never got
    // as far as the projects directory. Newlines survive the single-quoting below intact.
  ].join('\n');
}

/**
 * The shell-fallback script for a config dir, exported so it can be RUN.
 *
 * Nothing executed this script before: the python scanner covers every host with python3, which is
 * most of them, so a fault in the fallback was invisible until someone hit a host without it. One
 * was there — a quoted `~` that `sh` will not expand, which made `[ -d "$d" ]` fail and every such
 * host report "reachable, no sessions". The test drives this against a real directory with `sh -c`.
 */
export function __remoteFallbackScript(configDir: string): string {
  // Python takes the path as argv and runs `os.path.expanduser`, so it wants a literal `~`, quoted.
  // `sh` cannot expand a tilde inside quotes, so the shell half gets `$HOME` — unquoted at the
  // assignment (which does not word-split) and quoted at every later use.
  const shCfg = configDir.startsWith('$')
    ? configDir
    : configDir === '~' || configDir.startsWith('~/')
      ? '"$HOME"' + configDir.slice(1)
      : quote(configDir);
  return remoteScript(shCfg);
}

/** Single-quote for `sh -c`, the only place a caller's string reaches a remote shell. */
function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const HOST_OK = /^[A-Za-z0-9._@-]+$/;

/**
 * List one remote's sessions. Never throws: every failure becomes a `RemoteListing` that says so.
 *
 * `BatchMode=yes` is what keeps this from hanging: without it a host whose key is not loaded stops at
 * a password prompt with no terminal to answer it, and the dashboard freezes on a refresh tick.
 */
export function listRemoteSessions(r: Remote, timeoutMs = 15000): RemoteListing {
  const base: RemoteListing = { host: r.host, name: r.name, sessions: [], error: null, reachable: false };
  if (!r.host || !HOST_OK.test(r.host)) {
    return { ...base, error: `“${r.host}” is not a usable ssh host name` };
  }
  const cfg = r.configDir?.trim() || '~/.claude';
  // Refused HERE as well as in prefs: this is the one string besides the host that reaches a remote
  // shell. The $-leading form is passed UNQUOTED so a variable expands there, which makes a
  // $(...) value command substitution on the OTHER machine — from a string the settings file could
  // hold. Two doors, because this module promises everything it runs is read-only.
  if (!CONFIG_DIR_OK.test(cfg)) {
    return { ...base, error: `“${cfg}” is not a usable config directory (a path, ~/…, or $VAR/…)` };
  }
  // The scanner runs THERE, so only finished titles cross the wire. Base64 so no shell it passes
  // through can corrupt the source, and a shell fallback for a host with no python3 — which still
  // lists every session, with weaker titles, and says so rather than pretending.
  const b64 = Buffer.from(REMOTE_SCAN_PY, 'utf8').toString('base64');
  const py = `echo ${b64} | base64 -d | python3 - ${quote(cfg)}`;
  const script = `if command -v python3 >/dev/null 2>&1; then ${py}; else ${__remoteFallbackScript(cfg)}; fi`;
  let out: { status: number | null; stdout: string; stderr: string; timedOut: boolean };
  try {
    const res = spawnToolSync(
      'ssh',
      [
        '-o', 'BatchMode=yes',
        '-o', 'ConnectTimeout=8',
        '-o', 'StrictHostKeyChecking=accept-new',
        r.host,
        `sh -c ${quote(script)}`,
      ],
      { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }
    );
    // `error` is the only place a TIMEOUT shows up — spawnSync leaves `status` null for it — so it
    // has to be carried out of this try block, not just status/stdout/stderr.
    const err = res.error as NodeJS.ErrnoException | undefined;
    out = {
      status: res.status,
      stdout: String(res.stdout ?? ''),
      stderr: String(res.stderr ?? ''),
      timedOut: !!err && /ETIMEDOUT|timed? ?out/i.test(String(err.code ?? err.message ?? '')),
    };
  } catch (e) {
    return { ...base, error: `could not run ssh: ${String((e as Error)?.message || e)}` };
  }
  if (out.status !== 0) {
    // A TIMEOUT is not an exit status: spawnSync sets `error` and leaves `status` null, so reading the
    // status alone reported "ssh exited ?" for the one failure a reader is most likely to hit — a host
    // that is up but not answering. Name it, and name the bound it broke.
    if (out.timedOut) return { ...base, error: `no answer within ${Math.round(timeoutMs / 1000)}s` };
    // The remote's own words, first line only — "Permission denied (publickey)" and "Could not resolve
    // hostname" are the two a reader can actually act on, and both arrive here.
    const why = out.stderr.split('\n').map((l) => l.trim()).filter(Boolean)[0] || `ssh exited ${out.status ?? '?'}`;
    return { ...base, error: why };
  }
  // Find the protocol's sentinel rather than assuming it is line 0. A login banner, an MOTD, or any
  // shell rc that prints puts its own lines first — and reading only line 0 then made a perfectly
  // healthy host report `reachable: true` with zero sessions and no error, which is precisely the
  // "an empty list standing in for a failure" this module's header forbids.
  const lines = out.stdout.split('\n');
  const at = lines.findIndex((l) => l.trim() === 'OK' || l.trim() === 'NOPROJECTS');
  if (at < 0) {
    return {
      ...base,
      error: 'unrecognized reply — the remote produced no scan output (is $CLAUDE_CONFIG_DIR readable there?)',
    };
  }
  if (lines[at].trim() === 'NOPROJECTS') {
    return { ...base, reachable: true, error: null }; // reachable, and Claude Code has never run there
  }
  return { ...base, reachable: true, sessions: __parseRemoteRows(lines.slice(at).join('\n')) };
}

/**
 * The row parser, split out so the wire contract can be tested without reaching a machine.
 *
 * Two producers write these rows and the fifth field tells them apart — a bare `0`/`1` is the python
 * scanner's bridged FLAG, anything else is the shell fallback's raw first line. Reading one as the
 * other gives every session the title "0".
 */
export function __parseRemoteRows(stdout: string): RemoteSession[] {
  const lines = stdout.split('\n');
  const sessions: RemoteSession[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split('\t');
    const [slug, id, mtime, bytes] = parts;
    if (!slug || !id) continue;
    const fromPython = parts[4] === '0' || parts[4] === '1';
    const bridged = fromPython ? parts[4] === '1' : !!parts[4] && parts[4].includes('"bridge-session"');
    const raw = bridged ? null : fromPython ? (parts[5] || '').trim() || null : titleFromFirstLine(parts[5] ?? '');
    sessions.push({
      id,
      slug,
      workspace: remoteWorkspaceLabel(slug),
      lastActiveMs: (Number(mtime) || 0) * 1000,
      bytes: Number(bytes) || 0,
      bridged,
      title: raw ? normalizeSessionTitle(raw) : null,
    });
  }
  return sessions.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
}

/**
 * A title from the shell fallback's sample, which is a BOUNDED head of the transcript and may stop
 * mid-record. Parse it whole if it parses; otherwise pull the first plausible value out textually,
 * including from a value the sample cut off before its closing quote.
 */
function titleFromFirstLine(head: string): string | null {
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
  const t = head.trim();
  if (!t) return null;
  if (t.startsWith('{')) {
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      for (const k of ['summary', 'title']) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) return clean(v);
      }
      const c = (o.message as { content?: unknown } | undefined)?.content;
      if (typeof c === 'string' && c.trim()) return clean(c);
      if (Array.isArray(c)) {
        for (const part of c) {
          const x = (part as { text?: unknown })?.text;
          if (typeof x === 'string' && x.trim()) return clean(x);
        }
      }
      return null;
    } catch {
      /* truncated mid-record — fall through to the textual pass, which is the common case */
    }
  }
  // `[^"\\]*(?:\\.[^"\\]*)*` walks escaped quotes, so a title containing \" is not cut at its own
  // escape; an unterminated final value is simply not matched and falls to the last pass.
  for (const re of [/"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/, /"content"\s*:\s*"((?:[^"\\]|\\.)*)"/, /"text"\s*:\s*"((?:[^"\\]|\\.)*)"/]) {
    const m = re.exec(head);
    if (m?.[1]?.trim()) return clean(m[1]);
  }
  const open = /"(?:summary|content|text)"\s*:\s*"((?:[^"\\]|\\.)+)$/.exec(head);
  return open?.[1] ? clean(open[1]) : null;
}

/**
 * A remote workspace slug as a label, bounded and MARKED when shortened.
 *
 * The same rule the local workspace list uses: the remote's own home reads as `~` rather than being
 * spelled out as a path, and anything past the cap is elided from the FRONT, because the tail is the
 * part that identifies a project.
 */
export function remoteWorkspaceLabel(slug: string): string {
  const CAP = 26;
  // The home directory ITSELF reads as `~`; anything beneath it drops the `-home-<user>-` prefix
  // entirely, because every row on that host would otherwise carry the same twelve useless
  // characters and the part that identifies the project would be the part that gets elided.
  if (/^-(?:home|Users)-[^-]+$/.test(slug)) return '~';
  let label = slug.replace(/^-(?:home|Users)-[^-]+-/, '');
  if (label.length > CAP) label = '…' + label.slice(-(CAP - 1));
  return label;
}

/**
 * Every enabled remote's sessions, as picker rows, with a short cache in TWO tiers.
 *
 * NOT on the refresh tick by intent: each host is a synchronous `ssh`, and paying that every three
 * seconds would make the whole dashboard stutter for a list that changes on the order of minutes.
 *
 * The DISK tier is what makes that true in practice. The in-process Map only helps a long-lived host;
 * every CLI-driven surface spawns a fresh process per refresh, so it never hit once — JetBrains
 * passes `--remote` on its ~3 s poll and was paying a full ssh per tick while a comment claimed the
 * cache absorbed it. The disk entry is shared by every process on the machine, so the ssh really does
 * happen at most once per TTL however the listing is asked for.
 *
 * A failing host yields a ROW, not silence: `origin: 'remote'` with the error in `title`, so a
 * machine that is down is visibly down instead of quietly absent.
 */
const remoteCache = new Map<string, { at: number; listing: RemoteListing }>();

/** Where the cross-process half of that cache lives. One small file per (host, configDir). */
function diskCachePath(key: string): string {
  const name = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
  return path.join(rootDir(), 'remote-cache', `${name}.json`);
}

function readDiskCache(key: string, now: number, ttl: number): { at: number; listing: RemoteListing } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(diskCachePath(key), 'utf8')) as { at?: number; listing?: RemoteListing };
    if (typeof raw?.at !== 'number' || !raw.listing) return null;
    if (now - raw.at >= ttl) return null;
    return { at: raw.at, listing: raw.listing };
  } catch {
    return null; // absent, unreadable or malformed — all mean "ask the host"
  }
}

function writeDiskCache(key: string, at: number, listing: RemoteListing): void {
  try {
    const p = diskCachePath(key);
    // 0700/0600, like the store's blobs: these entries hold session TITLES, which are derived from
    // what someone typed on another machine. A cache is not a reason to widen who can read them.
    fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ at, listing }), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch {
    /* a cache that cannot be written is a slower product, never a broken one */
  }
}

export interface RemoteRow {
  id: string;
  workspace: string;
  origin: 'remote';
  host: string;
  /** The machine this session lives on, as the reader named it. Its OWN field, not a prefix on
   *  `workspace`: that form had to be truncated to fit one column, and a truncated machine name is
   *  exactly as useless as a truncated path. Every picker renders it as a column. */
  machine: string;
  title: string | null;
  lastActiveMs: number;
  bridged: boolean;
  /** Set when this row IS the failure — nothing was listed, and this says why. */
  error?: string;
}

export function remoteRows(
  remotes: readonly Remote[],
  opts: { ttlMs?: number; now?: number } = {}
): RemoteRow[] {
  const ttl = opts.ttlMs ?? 60_000;
  const now = opts.now ?? Date.now();
  const out: RemoteRow[] = [];
  for (const r of remotes) {
    const key = `${r.host} ${r.configDir ?? ''}`;
    const hit = remoteCache.get(key) ?? readDiskCache(key, now, ttl);
    const listing = hit && now - hit.at < ttl ? hit.listing : listRemoteSessions(r);
    if (!hit || now - hit.at >= ttl) {
      remoteCache.set(key, { at: now, listing });
      writeDiskCache(key, now, listing);
    }
    if (listing.error) {
      out.push({
        id: `!${r.name}`,
        workspace: '',
        origin: 'remote',
        host: r.host,
        machine: r.name,
        title: listing.error,
        lastActiveMs: 0,
        bridged: false,
        error: listing.error,
      });
      continue;
    }
    for (const s of listing.sessions) {
      out.push({
        id: s.id,
        workspace: s.workspace,
        origin: 'remote',
        host: r.host,
        machine: r.name,
        title: s.title,
        lastActiveMs: s.lastActiveMs,
        bridged: s.bridged,
      });
    }
  }
  return out.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
}

/** Drop ONLY the in-process tier, so a test can force the disk tier to be the one that answers —
 *  which is the tier's whole reason to exist and was otherwise unreachable from a single process. */
export function __clearRemoteMemoOnly(): void {
  remoteCache.clear();
}

/** Drop the cache — for a manual refresh, and so a test never sees another test's hosts. */
export function clearRemoteCache(): void {
  remoteCache.clear();
  // The DISK tier too: it outlives this process, so clearing only the Map left "retry this host now"
  // serving the same stale answer for the rest of the TTL.
  try {
    fs.rmSync(path.join(rootDir(), 'remote-cache'), { recursive: true, force: true });
  } catch {
    /* nothing cached to clear */
  }
}
