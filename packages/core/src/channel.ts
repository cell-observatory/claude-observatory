/**
 * The update CHANNEL — which release stream this install follows.
 *
 *   stable  →  the newest regular GitHub Release (`releases/latest` semantics)
 *   dev     →  the newest release MARKED prerelease — the rolling build CI refreshes from the
 *              `dev` branch ("Pre-release" everywhere a human reads it)
 *
 * One word in `<store root>/channel`, absent = stable. It lives in core because every surface
 * follows it: the CLI's `update`/`version --check`/daily nudge, and both editors' version
 * dropdowns (which shell out to the CLI, the single backend). Switching channels is
 * `update --channel <stable|dev>` — the CLI persists the choice and installs that channel's
 * newest in the same breath, so the state on disk never says one thing while the binaries are
 * another's.
 */
import * as fs from 'fs';
import * as path from 'path';
import { rootDir } from './store';
import { isNewer } from './semver';

export type UpdateChannel = 'stable' | 'dev';

export function getUpdateChannel(): UpdateChannel {
  try {
    const raw = fs.readFileSync(path.join(rootDir(), 'channel'), 'utf8').trim();
    if (raw === 'dev') return 'dev';
  } catch {
    /* absent/unreadable → stable */
  }
  return 'stable';
}

export function setUpdateChannel(ch: UpdateChannel): void {
  fs.mkdirSync(rootDir(), { recursive: true });
  fs.writeFileSync(path.join(rootDir(), 'channel'), ch + '\n');
}

/** Accepts every spelling a human will type for the pre-release channel. Null = not a channel. */
export function normalizeChannel(s: string): UpdateChannel | null {
  const t = s.trim().toLowerCase();
  if (t === 'stable' || t === 'main' || t === 'release') return 'stable';
  if (t === 'dev' || t === 'pre' || t === 'prerelease' || t === 'pre-release') return 'dev';
  return null;
}

/** The slice of a GitHub release object the resolver needs — parsed JSON, no client here. */
export interface ReleaseInfo {
  tag_name?: string;
  name?: string;
  prerelease?: boolean;
  draft?: boolean;
  assets?: unknown[];
}

/**
 * A release's VERSION. Stable releases carry it in the tag (`v0.9.0`); the ROLLING pre-release keeps
 * a fixed tag (`dev-latest`, so its URLs never move) and carries the version in its title
 * ("Pre-release 0.9.0-dev.123 (rolling, from dev)") — so: the tag when it is version-shaped, else
 * the first semver in the title, else null. Every surface derives versions through here; deriving
 * from the tag alone made the dev channel compare against the literal string "dev-latest".
 */
export function versionOfRelease(r: { tag_name?: string; name?: string } | null | undefined): string | null {
  if (!r) return null;
  const tag = String(r.tag_name ?? '')
    .trim()
    .replace(/^v/i, '');
  if (/^\d{1,9}\.\d{1,9}\.\d{1,9}/.test(tag)) return tag;
  // Bounded quantifiers + a hard input cap: the title arrives from a release API (overridable to a
  // mirror), and an unanchored scan with unbounded `\d+` runs is polynomial on adversarial digit
  // strings. Nine digits per component and a 128-char suffix cover every version this project can
  // ever mint, at provably linear cost.
  const m = String(r.name ?? '')
    .slice(0, 256)
    .match(/\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z][0-9A-Za-z.-]{0,127})?/);
  return m ? m[0] : null;
}

/**
 * Pick a channel's newest release from the `/releases` LIST (newest-first, as GitHub returns it).
 * Pure over parsed JSON so the choice is unit-testable: stable = the first regular release
 * (matching `releases/latest`, which never serves prereleases), dev = the first prerelease —
 * falling back to stable when no prerelease exists yet, so a fresh repo state degrades to
 * "you're on the newest there is" instead of an error.
 */
export function resolveReleaseFromList<T extends ReleaseInfo>(releases: T[], channel: UpdateChannel): T | null {
  const usable = releases.filter((r) => !r.draft);
  const stable = usable.find((r) => r.prerelease !== true) ?? null;
  if (channel === 'dev') {
    const pre = usable.find((r) => r.prerelease === true);
    // The dev channel serves the NEWEST thing, which right after a promote is the stable itself:
    // 0.10.0 outranks 0.10.0-dev.N until the next push to dev. Without this compare, a dev-channel
    // install read "up to date" while semver said the stable release was ahead of it.
    if (pre && stable) {
      const pv = versionOfRelease(pre);
      const sv = versionOfRelease(stable);
      return pv && sv && isNewer(sv, pv) ? stable : pre;
    }
    if (pre) return pre;
  }
  return stable;
}
