#!/usr/bin/env node
/**
 * Single source of truth for the monorepo version.
 *
 *   node scripts/version.mjs            check every package matches the root version (exit 1 on drift)
 *   node scripts/version.mjs <version>  set the root + every package/plugin to <version>
 *   node scripts/version.mjs --write    propagate the current root version to every package/plugin
 *
 * Keeps the four package.json versions and the JetBrains build.gradle.kts in lockstep, so
 * `claude-observatory --version`, the .vsix, and the plugin zip can never disagree again.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PKGS = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/vscode/package.json',
];
const GRADLE = 'packages/jetbrains/build.gradle.kts';
const targets = [...PKGS, GRADLE];

const pkgVersionRe = /("version":\s*")([^"]+)(")/;
const gradleVersionRe = /^(version\s*=\s*")([^"]+)(")/m;
const reFor = (rel) => (rel === GRADLE ? gradleVersionRe : pkgVersionRe);

// @claude-observatory/core is repo-only (never published): cli + vscode pin it exactly, and if a pin
// drifts from the workspace version, `npm ci` falls back to the registry and 404s. Lockstep these too.
const CORE_PIN_FILES = ['packages/cli/package.json', 'packages/vscode/package.json'];
const corePinRe = /("@claude-observatory\/core":\s*")([^"]+)(")/;

// The lockfile records the same versions again (`npm ci` in CI + release hard-fails if it disagrees
// with package.json). A bump that skips it passes this drift check but reddens every CI run — so we
// sync + verify it here too. Patched by field (round-trip is byte-identical) to avoid npm/network churn.
const LOCKFILE = 'package-lock.json';
const WORKSPACE_KEYS = ['packages/core', 'packages/cli', 'packages/vscode'];

const read = (rel) => readFileSync(join(root, rel), 'utf8');

// The README's static version badge — stamped here rather than shields' GitHub-API-backed
// "latest release" badge, which reads "inaccessible" whenever GitHub's REST API hiccups.
const README = 'README.md';
const badgeRe = /(badge\/version-v)([0-9][^-]*)(-blue)/;
function badgeVersionOf() {
  const m = read(README).match(badgeRe);
  if (!m) throw new Error(`no version badge found in ${README}`);
  return m[2];
}
function setBadgeVersion(next) {
  writeFileSync(join(root, README), read(README).replace(badgeRe, (_all, a, _v, c) => `${a}${next}${c}`));
}

function versionOf(rel) {
  const m = read(rel).match(reFor(rel));
  if (!m) throw new Error(`no version field found in ${rel}`);
  return m[2];
}

function setVersion(rel, next) {
  const out = read(rel).replace(reFor(rel), (_all, a, _v, c) => `${a}${next}${c}`);
  writeFileSync(join(root, rel), out);
}

function corePinOf(rel) {
  const m = read(rel).match(corePinRe);
  if (!m) throw new Error(`no @claude-observatory/core pin found in ${rel}`);
  return m[2];
}

function setCorePin(rel, next) {
  const out = read(rel).replace(corePinRe, (_all, a, _v, c) => `${a}${next}${c}`);
  writeFileSync(join(root, rel), out);
}

/** The version fields the lockfile derives from the workspace manifests (all must equal `next`). */
function lockfileVersionFields(lock) {
  const out = [];
  out.push({ label: 'top', get: () => lock.version, set: (v) => (lock.version = v) });
  if (lock.packages?.['']) out.push({ label: 'packages[""]', get: () => lock.packages[''].version, set: (v) => (lock.packages[''].version = v) });
  for (const k of WORKSPACE_KEYS) {
    const p = lock.packages?.[k];
    if (!p) continue;
    if (p.version !== undefined) out.push({ label: `${k}#version`, get: () => p.version, set: (v) => (p.version = v) });
    for (const dep of ['dependencies', 'devDependencies']) {
      if (p[dep]?.['@claude-observatory/core'] !== undefined)
        out.push({ label: `${k}#${dep}.core`, get: () => p[dep]['@claude-observatory/core'], set: (v) => (p[dep]['@claude-observatory/core'] = v) });
    }
  }
  return out;
}

function setLockfileVersions(next) {
  const lock = JSON.parse(read(LOCKFILE));
  for (const f of lockfileVersionFields(lock)) f.set(next);
  writeFileSync(join(root, LOCKFILE), JSON.stringify(lock, null, 2) + '\n');
}

/** Returns true on drift; logs each field. */
function checkLockfile(rootVersion) {
  let drift = false;
  const lock = JSON.parse(read(LOCKFILE));
  for (const f of lockfileVersionFields(lock)) {
    const v = f.get();
    if (v !== rootVersion) drift = true;
    console.log(`${v === rootVersion ? '✓' : '✗'} ${LOCKFILE} (${f.label}): ${v}`);
  }
  return drift;
}

const arg = process.argv[2];

// `node scripts/version.mjs <version>` — set an explicit version everywhere.
if (arg && arg !== '--write' && arg !== 'check') {
  if (!/^\d+\.\d+\.\d+([-.+].*)?$/.test(arg)) {
    console.error(`bad version "${arg}" — expected semver like 0.4.0`);
    process.exit(1);
  }
  for (const t of targets) setVersion(t, arg);
  for (const t of CORE_PIN_FILES) setCorePin(t, arg);
  setLockfileVersions(arg);
  setBadgeVersion(arg);
  console.log(`✓ set version ${arg} across ${targets.length} files (+ ${CORE_PIN_FILES.length} core pins + ${LOCKFILE} + the README badge)`);
  process.exit(0);
}

const rootVersion = versionOf('package.json');

// `--write` — sync every package to the current root version.
if (arg === '--write') {
  for (const t of targets) setVersion(t, rootVersion);
  for (const t of CORE_PIN_FILES) setCorePin(t, rootVersion);
  setLockfileVersions(rootVersion);
  setBadgeVersion(rootVersion);
  console.log(`✓ propagated root version ${rootVersion} to ${targets.length} files (+ ${CORE_PIN_FILES.length} core pins + ${LOCKFILE} + the README badge)`);
  process.exit(0);
}

// default — check for drift.
let drift = false;
for (const t of targets) {
  const v = versionOf(t);
  if (v !== rootVersion) drift = true;
  console.log(`${v === rootVersion ? '✓' : '✗'} ${t}: ${v}`);
}
for (const t of CORE_PIN_FILES) {
  const v = corePinOf(t);
  if (v !== rootVersion) drift = true;
  console.log(`${v === rootVersion ? '✓' : '✗'} ${t} (core pin): ${v}`);
}
if (checkLockfile(rootVersion)) drift = true;
{
  const v = badgeVersionOf();
  if (v !== rootVersion) drift = true;
  console.log(`${v === rootVersion ? '✓' : '✗'} ${README} (version badge): ${v}`);
}
if (drift) {
  console.error(`\nversion drift — root is ${rootVersion}. Run \`node scripts/version.mjs --write\` to fix.`);
  process.exit(1);
}
console.log(`\nall versions consistent: ${rootVersion}`);
