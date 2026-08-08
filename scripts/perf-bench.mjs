#!/usr/bin/env node
// perf-bench — times the hot paths against a synthetic many-edit session in an isolated store.
// Usage: node scripts/perf-bench.mjs [edits] [files]   (defaults: 3000 edits over 150 files)
// The store lives in a temp CLAUDE_CONFIG_DIR and is removed afterward; nothing touches the real store.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const N = parseInt(process.argv[2] ?? '3000', 10);
const FILES = parseInt(process.argv[3] ?? '150', 10);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-bench-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

const require = createRequire(import.meta.url);
const core = require(path.resolve('packages/core/dist/index.js'));
const CLI = path.resolve('packages/cli/dist/index.js');

const SESSION = 'bench-0000000000000001';
const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, 'src'), { recursive: true });

// --- generate: N edits over FILES files; per-file chains so adjacent-pending pairs exist ---
core.ensureStore(SESSION);
const t0 = Date.now();
const fileState = new Map();
for (let i = 0; i < N; i++) {
  const f = path.join(ws, 'src', `mod${i % FILES}.py`);
  const prev = fileState.get(f) ?? Array.from({ length: 40 }, (_, k) => `line ${k} of ${path.basename(f)}`).join('\n') + '\n';
  const next = prev.replace(`line ${i % 40} `, `line ${i % 40} v${i} `);
  fileState.set(f, next);
  const beforeBlob = core.writeBlob(SESSION, Buffer.from(prev));
  const afterBlob = core.writeBlob(SESSION, Buffer.from(next));
  core.appendLog(SESSION, { ts: t0 + i * 10, tool: 'Edit', file: f, beforeBlob, afterBlob, status: 'pending' });
}

const ms = (fn) => {
  const s = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - s) / 1e6;
};
const best = (fn, reps = 3) => Math.min(...Array.from({ length: reps }, () => ms(fn)));
const out = {};

out['appendLog (1 record, incl. nextId)'] = ms(() =>
  core.appendLog(SESSION, { ts: Date.now(), tool: 'Edit', file: path.join(ws, 'src', 'mod0.py'), beforeBlob: null, afterBlob: null, status: 'pending' })
);
out['readLog cold'] = ms(() => core.readLog(SESSION));
out['readLog warm x100'] = ms(() => { for (let i = 0; i < 100; i++) core.readLog(SESSION); });
// The review-unit derivation itself. It sits under buildEditTree and `list`, and EVERY capture
// invalidates its memo, so a cold number is what a session actually pays per new edit — not a rarity.
out['pendingGroups cold'] = ms(() => core.pendingGroups(SESSION));
out['pendingGroups warm'] = best(() => core.pendingGroups(SESSION));

// MANY SPANS IN ONE FILE — the shape the fixture above cannot make (its 20 edits per file all touch
// one region, so each file collapses to a single unit). Every per-file pass that walks spans against
// each other is quadratic HERE and nowhere else: a cancel-out scan written that way cost 1.2 s at
// 8,000 spans while this benchmark's number did not move at all. Distinct line per edit ⇒ one span
// per edit.
const SPANS = parseInt(process.argv[4] ?? '1200', 10);
const S2 = 'bench-spans-000000000000001';
core.ensureStore(S2);
{
  const f2 = path.join(ws, 'src', 'wide.py');
  let prev = Array.from({ length: SPANS + 20 }, (_, k) => `line ${k}`).join('\n') + '\n';
  for (let i = 0; i < SPANS; i++) {
    const next = prev.replace(`line ${i}\n`, `line ${i} touched\n`);
    core.appendLog(S2, {
      ts: t0 + i * 10, tool: 'Edit', file: f2,
      beforeBlob: core.writeBlob(S2, Buffer.from(prev)),
      afterBlob: core.writeBlob(S2, Buffer.from(next)),
      status: 'pending',
    });
    prev = next;
  }
}
out[`pendingGroups cold (${SPANS} spans, ONE file)`] = ms(() => core.pendingGroups(S2));
out['…spans it found'] = core.pendingGroups(S2).size;

// SPANS THAT MEET AT ABSENCE — every span above carries real blobs on both sides, so the fold's
// merge-across-null pass and its chain extension never run. This is the shape the Bash-capture bug
// produced in bulk (one file deleted and re-created over and over), and the one where PASS 1 merges
// maximally and PASS 2's chain becomes the whole file: exactly where a quadratic term would show.
const S3 = 'bench-nulls-000000000000001';
core.ensureStore(S3);
{
  const f3 = path.join(ws, 'src', 'flicker.py');
  const text = Array.from({ length: 40 }, (_, k) => `line ${k}`).join('\n') + '\n';
  const sha = core.writeBlob(S3, Buffer.from(text));
  for (let i = 0; i < SPANS; i++) {
    const del = i % 2 === 0;
    core.appendLog(S3, {
      ts: t0 + i * 10, tool: 'Bash', file: f3,
      beforeBlob: del ? sha : null,
      afterBlob: del ? null : sha,
      status: 'pending',
    });
  }
}
out[`pendingGroups cold (${SPANS} null-alternating spans, ONE file)`] = ms(() => core.pendingGroups(S3));
out['…units it found'] = core.pendingGroups(S3).size;
out['reviewEdits cold'] = ms(() => core.reviewEdits(SESSION));
// The dependency walk shares its hop shapes with the unit walk above, so its cold cost should be
// bookkeeping, not diffing. Gate: pendingGroups cold + unitDeps cold must stay ≤ 1.6× pendingGroups
// alone at 3000/150, ≤ 1.4× at 2000/1 — past that the set translation has gone quadratic.
out['unitDeps cold'] = ms(() => core.unitDeps(SESSION));
// How much the collapse actually buys, and how big it lets a single decision get. A unit that swallows
// a whole file is the failure mode this design exists to avoid, so the bench reports it rather than
// leaving it to be discovered on a real session.
{
  const groups = core.pendingGroups(SESSION);
  const sizes = [...groups.values()].map((m) => m.length);
  out['#units'] = sizes.length;
  out['#records'] = core.readLog(SESSION).filter((r) => r.status === 'pending').length;
  out['max unit size'] = sizes.length ? Math.max(...sizes) : 0;
  out['multi-member units'] = sizes.filter((n) => n > 1).length;
}
out['buildEditTree cold'] = ms(() => core.buildEditTree(SESSION, { root: ws }));
out['buildEditTree warm'] = best(() => core.buildEditTree(SESSION, { root: ws }));
out['buildChangeMap cold'] = ms(() => core.buildChangeMap(ws, SESSION, { root: ws }));
out['buildChangeMap warm'] = best(() => core.buildChangeMap(ws, SESSION, { root: ws }));
out['listSessions'] = best(() => core.listSessions());
if (core.sessionMeta) out['sessionMeta'] = best(() => core.sessionMeta(ws));
out['changemap --json spawn'] = ms(() =>
  execFileSync('node', [CLI, 'changemap', '--json', '--session', SESSION], { cwd: ws, env: process.env, maxBuffer: 64 * 1024 * 1024 })
);
// Bulk revert — LAST, it mutates the store the rows above measured. The scoped path used to append
// one status op per record, invalidating the readLog memo each time: O(N) full log parses per bulk
// revert. With the deferred one-flush write this is ~O(N) file work instead.
{
  for (const [f, content] of fileState) fs.writeFileSync(f, content); // disk at the final state
  const ids = core.readLog(SESSION).filter((r) => r.status === 'pending').map((r) => r.id).slice(-500);
  out['undoScope 500 ids'] = ms(() => core.undoScope(SESSION, { ids }));
}

console.log(JSON.stringify({ edits: N, files: FILES, node: process.version, timings_ms: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v * 10) / 10])) }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
