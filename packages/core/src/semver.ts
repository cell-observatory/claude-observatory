/**
 * Minimal semver compare for the self-updater — no deps. Compares major.minor.patch numerically,
 * then prerelease identifiers by the semver §11 rules the release channels need: a prerelease
 * ORDERS BELOW its release (`0.10.0-dev.4 < 0.10.0`), and two prereleases compare identifier by
 * identifier (numeric identifiers numerically, and a longer identifier list wins a shared prefix —
 * `dev.10 > dev.9 > dev`). Build metadata (`+…`) is ignored. The pre-release channel's rolling
 * `<base>-dev.<run>` versions depend on this ordering in BOTH directions: a dev build must read as
 * an update over the stable it forked from, and the eventual stable release must read as an update
 * over every dev build that led to it.
 */
export function parseVersion(s: string): [number, number, number] {
  const m = String(s).trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [Number(m[1] || 0), Number(m[2] || 0), Number(m[3] || 0)];
}

/** The dot-split prerelease identifiers of a version, or null when it has none (a release). */
function prereleaseOf(s: string): string[] | null {
  const m = String(s).trim().replace(/^v/i, '').match(/^[\d.]+-([^+]+)/);
  return m ? m[1].split('.') : null;
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  const ra = prereleaseOf(a);
  const rb = prereleaseOf(b);
  if (ra === null && rb === null) return 0;
  if (ra === null) return 1; // a is the release, b the prerelease of it
  if (rb === null) return -1;
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const ia = ra[i];
    const ib = rb[i];
    if (ia === undefined) return -1; // shared prefix, b has more identifiers → b is newer
    if (ib === undefined) return 1;
    const na = /^\d+$/.test(ia);
    const nb = /^\d+$/.test(ib);
    if (na && nb) {
      if (Number(ia) !== Number(ib)) return Number(ia) < Number(ib) ? -1 : 1;
    } else if (na !== nb) {
      return na ? -1 : 1; // numeric identifiers order below alphanumeric ones
    } else if (ia !== ib) {
      return ia < ib ? -1 : 1;
    }
  }
  return 0;
}

/** True when `latest` is strictly newer than `current`. */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}
