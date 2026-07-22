/**
 * Per-process memoization for pure derivations of on-disk files, keyed by (path, mtimeMs, size).
 *
 * Why: one Overview refresh derives several views (change-map, multitask, observations) that each
 * re-read and re-parse the SAME multi-megabyte transcripts — a single `buildChangeMap` used to parse
 * the main transcript ~6 times (actions, subagents, insights, todo snapshots, reasoning, workflows),
 * and the per-sibling fleet views repeat that per agent. Memoizing the pure parsers collapses that to
 * one parse per file per process, which is what makes the Overview load fast on big sessions.
 *
 * Safety: an entry is valid only while its file's (mtimeMs, size) both match, so a long-lived host
 * (the VS Code extension calls core in-process) revalidates on every call and never serves a parse of
 * a file that has since changed. A one-shot CLI process gets pure wins. Derivations that depend on TWO
 * files (e.g. reasoning correlation = transcript × store log) key on both. Entries are capped per kind
 * (insertion-order eviction) so an editor host scanning many sessions can't grow unbounded.
 *
 * Contract for callers: the cached value is returned BY REFERENCE — compute() results must be treated
 * as immutable by every consumer, or the caller must hand out copies (see parseTranscriptActions,
 * whose action records are mutated by attribution and therefore copied per call).
 */
import * as fs from 'fs';

interface Entry {
  stamp: string;
  value: unknown;
}

/** Per kind. Sized for the real worst case: ONE session's own subagent transcripts (a big workflow run
 *  leaves 150+ under subagents/), times the fleet siblings an Overview refresh walks. The old cap of
 *  128 sat just under a single such session's file count, so each pass evicted the entries the next
 *  pass needed and the hit rate collapsed to ~0 — the cache cost stats without ever paying out. */
const CACHE_CAP = 1024;
const caches = new Map<string, Map<string, Entry>>();

/** (mtimeMs:size) for one file, or null when it can't be stat'd (then we never cache). */
function stampOf(p: string): string | null {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

/**
 * Memoize `compute()` against the current (mtimeMs, size) of `paths`. Any stat failure, or any file
 * changing, recomputes; the kind string namespaces independent derivations of the same file.
 */
export function cachedByFiles<T>(kind: string, paths: string[], compute: () => T): T {
  const stamps: string[] = [];
  for (const p of paths) {
    const s = stampOf(p);
    if (s === null) return compute(); // unstat-able input → never cache (result may embed the failure)
    stamps.push(s);
  }
  const key = JSON.stringify(paths); // one entry per file SET — a changed file replaces, never accumulates
  const stamp = stamps.join(' ');
  let cache = caches.get(kind);
  if (!cache) {
    cache = new Map();
    caches.set(kind, cache);
  }
  const hit = cache.get(key);
  if (hit && hit.stamp === stamp) {
    // Re-insert so eviction is least-RECENTLY-USED, not merely oldest-inserted: without this a working
    // set slightly larger than the cap evicts exactly the entries still in use.
    cache.delete(key);
    cache.set(key, hit);
    return hit.value as T;
  }
  const value = compute();
  if (cache.size >= CACHE_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { stamp, value });
  return value;
}

/** Drop every cached entry (tests re-point CLAUDE_CONFIG_DIR at fresh fixtures within one process). */
export function clearFsCache(): void {
  caches.clear();
}
