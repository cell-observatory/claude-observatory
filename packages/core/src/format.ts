/**
 * Presentation helpers shared by front-ends: per-edit line deltas and a colored unified diff.
 * Uses the `diff` package, so it is loaded only by review commands — never by the capture hook.
 */
import { createPatch, diffLines } from 'diff';
import { EditRecord, readBlob } from './store';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';

function blobText(sessionId: string, sha: string | null): string {
  return sha === null ? '' : readBlob(sessionId, sha).toString('utf8');
}

/** Compact relative time, e.g. "5s ago", "12m ago", "3h ago", "2d ago", "3w ago", "2mo ago". */
export function relTime(ts: number, now: number = Date.now()): string {
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
export function lineDelta(sessionId: string, rec: EditRecord): { added: number; removed: number } {
  const before = blobText(sessionId, rec.beforeBlob);
  const after = blobText(sessionId, rec.afterBlob);
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const lines = part.count ?? part.value.split('\n').length - 1;
    if (part.added) added += lines;
    else if (part.removed) removed += lines;
  }
  return { added, removed };
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
