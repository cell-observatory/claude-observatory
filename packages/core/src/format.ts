/**
 * Presentation helpers shared by front-ends: per-edit line deltas and a colored unified diff.
 * Uses the `diff` package, so it is loaded only by review commands — never by the capture hook.
 */
import { createPatch, diffLines } from 'diff';
import { EditRecord, blobText as storeBlobText, hasBlob } from './store';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function blobText(sessionId: string, sha: string | null): string {
  if (sha === null) return '';
  try {
    return storeBlobText(sessionId, sha);
  } catch {
    return ''; // a GC'd/deleted blob must not crash lineDelta/coloredDiff (matches groups.ts/tree.ts)
  }
}

/** Compact relative time, e.g. "5s ago", "12m ago", "3h ago", "2d ago", "3w ago", "2mo ago".
 *
 *  A timestamp of 0 is "no time recorded", not the epoch: rows that carry one — a remote host that
 *  could not be reached, a session whose transcript is gone — were rendering as "679mo ago", which
 *  reads as a real and very old measurement rather than as an absent one. */
export function relTime(ts: number, now: number = Date.now()): string {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${d}d ago`;
  if (d < 61) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30.44)}mo ago`;
}

/** Added/removed line counts for an edit. New-file = all added; deletion = all removed. */
/** Memo for `lineDelta`, keyed by the two BLOB HASHES.
 *
 *  Blobs are content-addressed and immutable, so a (before, after) pair always yields the same delta —
 *  there is nothing to invalidate. This is worth caching because the change map computes a delta for
 *  every edit in the session on every build: at 1,100 edits the diff was ~1.6 s of a 3.5 s build, the
 *  single largest cost left, and the same pairs recur across the fleet/agent slices within one run. */
const deltaMemo = new Map<string, { added: number; removed: number }>();
const DELTA_MEMO_CAP = 20000; // bounded: a long-lived editor host must not grow without limit

export function lineDelta(sessionId: string, rec: EditRecord): { added: number; removed: number } {
  const key = `${rec.beforeBlob ?? ''}\u0000${rec.afterBlob ?? ''}`;
  const hit = deltaMemo.get(key);
  if (hit) return hit;
  // Blobs are content-addressed, but READABILITY is per session — and the key above is not. `blobText`
  // yields '' for a snapshot this session lost, so memoizing that answer under a content key hands the
  // wrong delta to every other session holding the same bytes. observe's delta cache then persists it
  // under a `hasBlob` guard that only ever inspected the HEALTHY session, so the bad number outlives
  // the process in a store that never lost anything. Compute it and return it; never publish it.
  const intact = hasBlob(sessionId, rec.beforeBlob) && hasBlob(sessionId, rec.afterBlob);
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = part.count ?? part.value.split('\n').length - 1;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  const out = { added, removed };
  if (intact) {
    if (deltaMemo.size >= DELTA_MEMO_CAP) deltaMemo.clear(); // simple bound; refills from the same blobs
    deltaMemo.set(key, out);
  }
  return out;
}

/** A raw model id → a short human label, e.g. 'claude-opus-4-8' → 'Opus 4.8', 'claude-sonnet-5' → 'Sonnet 5'.
 *  Unknown shapes pass through unchanged so nothing is ever mislabeled. Shared: the Workflows rows label
 *  each agent's model with it, and the Stats panel labels the session's own model with it — one labeler,
 *  so the two surfaces can never disagree about what "Opus 4.8" is called. */
export function friendlyModel(m: string): string {
  if (!m) return '';
  const mm = /claude-([a-z]+)-(\d+)(?:-(\d+))?/i.exec(m);
  if (!mm) return m;
  const fam = mm[1].charAt(0).toUpperCase() + mm[1].slice(1);
  const ver = mm[3] ? `${mm[2]}.${mm[3]}` : mm[2];
  return `${fam} ${ver}${/\[1m\]|-1m\b/i.test(m) ? ' (1M)' : ''}`;
}

/** ANSI-colored unified diff for one edit, ready to print to a terminal. */
export function coloredDiff(sessionId: string, rec: EditRecord, color = true): string {
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  const patch = createPatch(rec.file, before, after);
  if (!color) return patch;
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++') || line.startsWith('---')) return DIM + line + RESET;
      if (line.startsWith('@@')) return CYAN + line + RESET;
      if (line.startsWith('+')) return GREEN + line + RESET;
      if (line.startsWith('-')) return RED + line + RESET;
      return line;
    })
    .join('\n');
}


/**
 * A path relative to the workspace, for display.
 *
 * Renderers must never shorten a path by guessing. The terminal's guess kept the last two segments
 * at every width, so `packages/core/src/x.ts` and `packages/cli/src/x.ts` both read as `src/x.ts` —
 * two different files, indistinguishable, in a tool for deciding whether to revert one of them.
 * Outside the workspace the absolute path is returned UNCHANGED: it is genuinely elsewhere, and
 * saying so is the point.
 */
export function relPath(cwd: string, file: string): string {
  if (!file) return file;
  // The trailing-slash strip is a backwards scan, not `/\/+$/`: that shape re-tries from every
  // position, so a path ending in a long run of slashes is quadratic. This runs over transcript paths.
  const norm = (s: string) => {
    const f = s.replace(/\\/g, '/');
    let end = f.length;
    while (end > 0 && f[end - 1] === '/') end--;
    return end === f.length ? f : f.slice(0, end);
  };
  const root = norm(cwd);
  const f = norm(file);
  return f === root || f.startsWith(root + '/') ? f.slice(root.length + 1) || f : file;
}
