/**
 * Presentation helpers shared by front-ends: per-edit line deltas and a colored unified diff.
 * Uses the `diff` package, so it is loaded only by review commands — never by the capture hook.
 */
import { createPatch, diffLines, structuredPatch } from 'diff';
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

/**
 * A token count at a glance: `3.7M`, `812k`, `947`.
 *
 * The same thresholds and rounding the editors' `fmtTok` already uses, moved here so the terminal
 * cannot drift from what VS Code and JetBrains show for the same agent. (The webviews keep their own
 * inline copy: their script is a string, so it cannot import this. That duplication is deliberate and
 * pinned by a test rather than left to memory.)
 */
export function compactTokens(n: number): string {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${Math.round(v / 1e3)}k`;
  return String(v);
}

/** A duration at a glance: `23.4h`, `47m`, `12s`. Same rules as the editors' `fmtDur`. */
export function compactDuration(ms: number): string {
  const v = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${(m / 60).toFixed(1)}h`;
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

export interface DiffPreview {
  /** The windowed pair — a real diff of the part it shows, aligned by construction. */
  before: string;
  after: string;
  shownHunks: number;
  totalHunks: number;
  /** Changed lines left out. Zero means the preview IS the whole diff. */
  omittedLines: number;
}

/**
 * A BOUNDED window on one edit's diff: whole hunks until `maxLines` of changed lines, rebuilt into a
 * before/after pair.
 *
 * A unit that rewrote thousands of lines renders as a wall in any viewer that stacks diffs (VS
 * Code's multi-diff editor caps nothing per row), so the only lever left is the content handed to
 * it. Whole hunks are what keeps this honest: both sides are rebuilt from the same hunk lines, so
 * the window is a faithful diff of the part it shows rather than two independently truncated files
 * whose alignment is a coincidence. What is left out is NAMED — the caller renders `omittedLines`
 * beside the row, and one trailing marker line, identical on both sides so it can only ever read as
 * unchanged context, says the same thing inside the diff.
 */
export function previewPair(sessionId: string, rec: EditRecord, maxLines = 200): DiffPreview {
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  const hunks = structuredPatch(rec.file, rec.file, before, after, '', '', { context: 3 }).hunks;
  const changed = (h: { lines: string[] }) => h.lines.filter((l) => l.startsWith('+') || l.startsWith('-')).length;
  const total = hunks.reduce((n, h) => n + changed(h), 0);
  if (total <= maxLines) {
    return { before, after, shownHunks: hunks.length, totalHunks: hunks.length, omittedLines: 0 };
  }
  // Line-by-line rather than hunk-by-hunk: ONE hunk can be the whole rewrite (measured on a real
  // session: a single 13,083-line hunk), so a budget that only stops between hunks never stops.
  //
  // The budget is spent PER SIDE, half each. A unified hunk lists every `-` before every `+`, so a
  // single running counter spends the whole budget on removals and hands the reader a preview that
  // reads "−200 +0" for an edit the panel calls +500 −500 — Claude deleting a function and writing
  // nothing. Two counters make the window the first N removed lines against the first N added ones,
  // which is what the shape of a rewrite actually looks like.
  const half = Math.max(1, Math.floor(maxLines / 2));
  const b: string[] = [];
  const a: string[] = [];
  let spentDel = 0;
  let spentAdd = 0;
  let shown = 0;
  for (const h of hunks) {
    if (spentDel >= half && spentAdd >= half) break;
    let took = 0;
    for (const line of h.lines) {
      // `\ No newline at end of file` is diff METADATA, not content — emitting it would put a line
      // in the review that exists in neither blob.
      if (line.startsWith('\\')) continue;
      const text = line.slice(1);
      if (line.startsWith('-')) {
        if (spentDel >= half) continue;
        b.push(text);
        spentDel++;
      } else if (line.startsWith('+')) {
        if (spentAdd >= half) continue;
        a.push(text);
        spentAdd++;
      } else {
        // Context rides along only while there is still room on both sides, or a long tail of
        // unchanged lines would pad a preview whose changes are already cut.
        if (spentDel >= half && spentAdd >= half) continue;
        b.push(text);
        a.push(text);
      }
      took++;
    }
    if (took) shown++;
  }
  const omitted = total - spentDel - spentAdd;
  // Markers are IDENTICAL on both sides — one that differed would render as a change the agent never
  // made — and they carry what a windowed view otherwise loses: where in the file this starts (the
  // preview's own line numbers count from 1), and how much is not here.
  const head = `⋯ preview of #${rec.id} from line ${hunks[0]?.newStart ?? 1} — hunk${shown === 1 ? '' : 's'} 1–${shown} of ${hunks.length} ⋯`;
  const tail = `⋯ ${omitted.toLocaleString()} more changed line${omitted === 1 ? '' : 's'} — open the full diff for #${rec.id} ⋯`;
  return {
    before: [head, ...b, tail].join('\n') + '\n',
    after: [head, ...a, tail].join('\n') + '\n',
    shownHunks: shown,
    totalHunks: hunks.length,
    omittedLines: omitted,
  };
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
