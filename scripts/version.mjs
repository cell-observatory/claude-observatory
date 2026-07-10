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

const read = (rel) => readFileSync(join(root, rel), 'utf8');

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

const arg = process.argv[2];

// `node scripts/version.mjs <version>` — set an explicit version everywhere.
if (arg && arg !== '--write' && arg !== 'check') {
  if (!/^\d+\.\d+\.\d+([-.+].*)?$/.test(arg)) {
    console.error(`bad version "${arg}" — expected semver like 0.4.0`);
    process.exit(1);
  }
  for (const t of targets) setVersion(t, arg);
  for (const t of CORE_PIN_FILES) setCorePin(t, arg);
  console.log(`✓ set version ${arg} across ${targets.length} files (+ ${CORE_PIN_FILES.length} core pins)`);
  process.exit(0);
}

const rootVersion = versionOf('package.json');

// `--write` — sync every package to the current root version.
if (arg === '--write') {
  for (const t of targets) setVersion(t, rootVersion);
  for (const t of CORE_PIN_FILES) setCorePin(t, rootVersion);
  console.log(`✓ propagated root version ${rootVersion} to ${targets.length} files (+ ${CORE_PIN_FILES.length} core pins)`);
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
if (drift) {
  console.error(`\nversion drift — root is ${rootVersion}. Run \`node scripts/version.mjs --write\` to fix.`);
  process.exit(1);
}
console.log(`\nall versions consistent: ${rootVersion}`);
