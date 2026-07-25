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
out['buildEditTree cold'] = ms(() => core.buildEditTree(SESSION, { root: ws }));
out['buildEditTree warm'] = best(() => core.buildEditTree(SESSION, { root: ws }));
out['buildChangeMap cold'] = ms(() => core.buildChangeMap(ws, SESSION, { root: ws }));
out['buildChangeMap warm'] = best(() => core.buildChangeMap(ws, SESSION, { root: ws }));
out['listSessions'] = best(() => core.listSessions());
if (core.sessionMeta) out['sessionMeta'] = best(() => core.sessionMeta(ws));
out['changemap --json spawn'] = ms(() =>
  execFileSync('node', [CLI, 'changemap', '--json', '--session', SESSION], { cwd: ws, env: process.env, maxBuffer: 64 * 1024 * 1024 })
);

console.log(JSON.stringify({ edits: N, files: FILES, node: process.version, timings_ms: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Math.round(v * 10) / 10])) }, null, 2));
fs.rmSync(tmp, { recursive: true, force: true });
