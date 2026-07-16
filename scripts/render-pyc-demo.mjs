// The demo session as it looks in PYCHARM — an animated mockup of the JetBrains Overview tool window
// (docs/media/demo-pyc.gif), beat-for-beat the same story record-demo.mjs records from the real VS Code
// webview: plan → chapters filling → a subagent → a workflow run → WYSIWYG review → auto-clear.
//
// This one is a hand-authored mockup animation (the Swing panel can't render headlessly), faithful to
// ChangeMapPanel.kt's real layout: the Fleet/Workflows nav tabs, vertical chapter rows with ✓ ↩ 🧹
// mini-buttons, the module strip, and the ledger list — in the PyCharm 2026 New UI dark palette
// (same tokens as docs/media/pyc-layout.src.html).
//
// Usage: node scripts/render-pyc-demo.mjs   (≈10s; requires Google Chrome)
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { PNG } = require('pngjs');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = path.join(ROOT, 'docs', 'media', 'demo-pyc.gif');
const W = 1180;
const H = 620;

const CSS = `
  :root{
    --bg:#1e1f22; --panel:#2b2d30; --panel2:#26282b; --border:#393b40; --border2:#43454a;
    --ink:#dfe1e5; --dim:#9da0a8; --faint:#6f737a; --blue:#3574f0; --sel:#2e436e;
    --green:#5fad65; --yellow:#d6ae58; --red:#e5534b;
    --mono:"JetBrains Mono","SF Mono",Menlo,monospace;
    --ui:-apple-system,"SF Pro Text","Segoe UI",sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${W}px;height:${H}px;overflow:hidden}
  body{background:var(--bg);color:var(--ink);font-family:var(--ui);font-size:12.5px;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column}
  .tw-head{height:36px;display:flex;align-items:center;padding:0 12px;gap:14px;border-bottom:1px solid var(--border);background:var(--panel);flex:none}
  .tw-head .title{font-weight:600}
  .tw-tabs{display:flex;gap:10px;margin-left:8px;color:var(--dim);font-size:12px}
  .tw-tabs .on{color:var(--ink);border-bottom:1.5px solid var(--blue);padding-bottom:8px;margin-bottom:-9.5px}
  .toolbar{margin-left:auto;display:flex;gap:10px;align-items:center;color:var(--dim);font-size:11.5px;white-space:nowrap}
  .toolbar .b{border:1px solid var(--border2);border-radius:6px;padding:2px 9px;background:var(--panel2)}
  .toolbar .b.tog{color:var(--ink);border-color:var(--blue)}
  .main{flex:1;display:flex;min-height:0}
  .nav{width:25%;min-width:230px;border-right:1px solid var(--border);background:var(--panel2);display:flex;flex-direction:column}
  .nav-tabs{display:flex;gap:2px;padding:7px 10px 0;border-bottom:1px solid var(--border);font-size:12px;color:var(--dim)}
  .nav-tabs span{padding:4px 12px 7px;border-radius:6px 6px 0 0}
  .nav-tabs .on{background:var(--bg);color:var(--ink);border:1px solid var(--border);border-bottom-color:var(--bg)}
  .nav-body{padding:8px;flex:1;overflow:hidden}
  .agent{border:1px solid var(--border2);border-radius:7px;padding:6px 8px;margin-bottom:6px}
  .agent.sel{border-color:var(--blue);background:var(--sel)}
  .arow{display:flex;align-items:center;gap:7px;font-size:11.5px;white-space:nowrap}
  .badge{font-size:8.5px;font-weight:700;border-radius:8px;padding:1px 6px;color:#fff}
  .spark{display:inline-flex;align-items:flex-end;gap:1.5px;height:11px}
  .spark i{width:3px;background:var(--blue);border-radius:1px;display:inline-block}
  .sub{display:flex;align-items:center;gap:7px;font-size:11px;color:var(--dim);padding:4px 0 0 16px;white-space:nowrap}
  .none{color:var(--faint);font-size:11.5px;padding:10px 6px}
  .wf{border:1px solid var(--border2);border-radius:7px;padding:6px 8px;margin-bottom:6px}
  .wf.sel{border-color:var(--blue);background:var(--sel)}
  .wf .ph{font-size:10px;color:var(--faint);letter-spacing:.06em;padding:5px 0 1px 4px}
  .detail{flex:1;min-width:0;padding:8px 14px;display:flex;flex-direction:column;overflow:hidden}
  .chrow{display:flex;align-items:center;gap:9px;font-size:12px;padding:4px 2px;white-space:nowrap}
  .chrow .g{flex:none;width:12px;text-align:center}
  .chrow .t{overflow:hidden;text-overflow:ellipsis}
  .chrow .t.dim{color:var(--faint)}
  .chrow .m{margin-left:auto;font-family:var(--mono);font-size:10.5px;color:var(--faint);flex:none}
  .chrow .acts{display:flex;gap:8px;font-size:11.5px;flex:none}
  .chip{font-size:8.5px;color:var(--faint);border:1px solid var(--border2);border-radius:8px;padding:0 6px}
  .strip{display:flex;height:15px;border-radius:3px;overflow:hidden;margin:7px 0}
  .strip span{flex:1;display:flex;align-items:center;justify-content:center;font-size:8.5px;color:rgba(0,0,0,.8);font-weight:600;box-shadow:inset 1px 0 0 var(--panel2)}
  .led{display:flex;align-items:center;gap:7px;font-size:11px;padding:3px 0;white-space:nowrap}
  .led .d{width:6px;height:6px;border-radius:2px;flex:none}
  .led .f{font-family:var(--mono);color:var(--ink)}
  .led .mod{font-size:8.5px;color:var(--faint)}
  .led .bar{flex:1;height:5px;border-radius:2px;background:var(--panel);overflow:hidden;min-width:14px}
  .led .bar i{display:block;height:100%}
  .led .pm{font-family:var(--mono);font-size:9.5px;color:var(--faint);width:36px;text-align:right}
  .led .st{font-family:var(--mono);font-size:9.5px;width:26px;text-align:right}
  .empty{color:var(--faint);font-size:12px;padding:18px 4px}
  .cap{flex:none;font:500 12px var(--mono);color:var(--yellow);background:var(--panel);border-top:1px solid var(--border);padding:7px 14px;white-space:nowrap;overflow:hidden}
  .cap b{color:var(--ink);font-weight:600}
`;

const spark = (bars) => `<span class="spark">${bars.map((b) => `<i style="height:${Math.max(2, Math.round(b * 11))}px"></i>`).join('')}</span>`;
const Y = 'var(--yellow)', G = 'var(--green)', B = 'var(--blue)', F = 'var(--faint)';

const agentRow = ({ phase, phaseColor, added, removed, sub, sel }) => `
  <div class="agent${sel ? ' sel' : ''}">
    <div class="arow"><span class="badge" style="background:${phaseColor}">${phase}</span>
      <span style="font-family:var(--mono)">demo <span style="color:${F}">⑂demo/pipeline</span></span>
      <span style="margin-left:auto">${spark([0.3, 0.7, 0.5, 0.9, 0.6, 1])}</span>
      <span style="font-family:var(--mono);font-size:10px"><span style="color:${G}">+${added}</span> <span style="color:${Y}">−${removed}</span></span></div>
    ${sub ? `<div class="sub"><span class="badge" style="background:${sub.done ? F : B};font-size:8px">${sub.phase}</span> general-purpose · <i>Write pipeline tests</i> · +12 −0</div>` : ''}
  </div>`;

const chRow = ({ g, gc, title, syn, m, pending, act, kept }) => `
  <div class="chrow"><span class="g" style="color:${gc}">${g}</span>
    <span class="t${syn ? ' dim' : ''}">${title}</span>${syn ? '<span class="chip">session</span>' : ''}
    <span class="m">${m}${pending ? ` · <span style="color:${Y}">${pending}</span>` : ''}</span>
    ${act ? `<span class="acts"><span style="color:${G}">✓</span><span style="color:${Y}">↩</span><span style="color:${F}">🧹</span></span>` : '<span style="width:44px"></span>'}
  </div>`;

const led = ({ c, f, mod, w, pm, st, stc }) => `
  <div class="led"><span class="d" style="background:${c}"></span><span class="f">${f}</span><span class="mod">${mod}</span>
    <span class="bar"><i style="width:${w}%;background:${c}"></i></span><span class="pm">${pm}</span><span class="st" style="color:${stc}">${st}</span></div>`;

const strip = (mods) => `<div class="strip">${mods.map(([label, color]) => `<span style="background:${color}">${label}</span>`).join('')}</div>`;

const wfRun = ({ running, sel }) => `
  <div class="wf${sel ? ' sel' : ''}">
    <div class="arow"><span class="badge" style="background:${running ? G : F}">${running ? '▶ running' : '✓ done'}</span>
      <span>Write usage docs for the training pipeline</span></div>
    <div class="arow" style="margin-top:3px;color:${F};font-size:10.5px">${spark([0.8, 0.2, 0.6, 1])}<span style="font-family:var(--mono)">1 ag · 240 tok · 4s · <span style="color:${G}">+12</span> <span style="color:${Y}">−0</span></span></div>
    <div class="ph">DOCS ${running ? '0/1' : '1/1'}</div>
    <div class="sub" style="padding-left:6px"><span style="color:${running ? B : G}">${running ? '○' : '●'}</span> docs-writer ${spark([0.5, 0.9, 0.4])} · 240 tok · 1 edit</div>
  </div>`;

/** One frame of the PyCharm Overview: nav tab + rows, chapters, strip, ledger, caption. */
const frame = ({ tab = 'fleet', agent, wf, chapters, mods, files, empty, cap }) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="tw-head"><span class="title">Claude Observatory Dashboards</span>
    <span class="tw-tabs"><span>Observations</span><span class="on">Overview</span><span>Stats</span></span>
    <span class="toolbar"><span class="b">Accept All</span><span class="b">Revert All</span><span class="b">Clear Resolved</span><span class="b tog">Active only</span><span class="b">⟳</span></span></div>
  <div class="main">
    <div class="nav">
      <div class="nav-tabs"><span class="${tab === 'fleet' ? 'on' : ''}">Fleet</span><span class="${tab === 'workflows' ? 'on' : ''}">Workflows</span></div>
      <div class="nav-body">${tab === 'fleet' ? (agent ? agentRow(agent) : '<div class="none">No agents yet — this fills in as Claude Code sessions run</div>') : (wf ? wfRun(wf) : '<div class="none">No workflow runs — orchestrations appear here</div>')}</div>
    </div>
    <div class="detail">
      ${(chapters || []).map(chRow).join('')}
      ${mods ? strip(mods) : ''}
      ${(files || []).map(led).join('')}
      ${empty ? `<div class="empty">${empty}</div>` : ''}
    </div>
  </div>
  <div class="cap"><b>PyCharm</b> · same payloads, native panels&nbsp;&nbsp;·&nbsp;&nbsp;${cap}</div>
</body></html>`;

// --- the beats (mirrors the demo scenario + the recorded VS Code angles) ----------------------------
const beats = [
  {
    cap: '▸ plan — three to-dos become the chapters',
    agent: { phase: 'working', phaseColor: G, added: 0, removed: 0 },
    chapters: [
      { g: '◐', gc: Y, title: 'Add feature scaling to the pipeline', m: '', act: false },
      { g: '○', gc: F, title: 'Validate the training dataset', m: '', act: false },
      { g: '○', gc: F, title: 'Tests and docs', m: '', act: false },
    ],
    empty: 'No edits yet. This fills in as Claude edits files.',
  },
  {
    cap: '▸ chapter 1 — feature scaling (2 edits land)',
    agent: { phase: 'working', phaseColor: G, added: 9, removed: 3 },
    chapters: [
      { g: '◐', gc: Y, title: 'Add feature scaling to the pipeline', m: '+9 −3', pending: '2⏳', act: true },
      { g: '○', gc: F, title: 'Validate the training dataset', m: '', act: false },
      { g: '○', gc: F, title: 'Tests and docs', m: '', act: false },
    ],
    mods: [['observatory-demo', Y]],
    files: [
      { c: Y, f: 'features.py', mod: 'observatory-demo', w: 80, pm: '+6', st: '1⏳', stc: Y },
      { c: Y, f: 'train.py', mod: 'observatory-demo', w: 55, pm: '+3', st: '1⏳', stc: Y },
    ],
  },
  {
    cap: '▸ chapter 2 — dataset validation',
    agent: { phase: 'working', phaseColor: G, added: 16, removed: 3 },
    chapters: [
      { g: '◐', gc: Y, title: 'Add feature scaling to the pipeline', m: '+9 −3', pending: '2⏳', act: true },
      { g: '◐', gc: Y, title: 'Validate the training dataset', m: '+7 −0', pending: '1⏳', act: true },
      { g: '○', gc: F, title: 'Tests and docs', m: '', act: false },
    ],
    mods: [['observatory-demo', Y], ['src/models', Y]],
    files: [
      { c: Y, f: 'dataset.py', mod: 'src/models', w: 80, pm: '+7', st: '1⏳', stc: Y },
      { c: Y, f: 'features.py', mod: 'observatory-demo', w: 75, pm: '+6', st: '1⏳', stc: Y },
      { c: Y, f: 'train.py', mod: 'observatory-demo', w: 50, pm: '+3', st: '1⏳', stc: Y },
    ],
  },
  {
    cap: '▸ chapter 3 — tests, written by a subagent',
    agent: { phase: 'working', phaseColor: G, added: 28, removed: 3, sub: { phase: 'working' } },
    chapters: [
      { g: '◐', gc: Y, title: 'Add feature scaling to the pipeline', m: '+9 −3', pending: '2⏳', act: true },
      { g: '◐', gc: Y, title: 'Validate the training dataset', m: '+7 −0', pending: '1⏳', act: true },
      { g: '◐', gc: Y, title: 'Tests and docs', m: '+12 −0', pending: '1⏳', act: true },
    ],
    mods: [['observatory-demo', Y], ['tests', Y], ['src/models', Y]],
    files: [
      { c: Y, f: 'test_pipeline.py', mod: 'tests', w: 95, pm: '+12', st: '1⏳', stc: Y },
      { c: Y, f: 'dataset.py', mod: 'src/models', w: 58, pm: '+7', st: '1⏳', stc: Y },
      { c: Y, f: 'features.py', mod: 'observatory-demo', w: 55, pm: '+6', st: '1⏳', stc: Y },
      { c: Y, f: 'train.py', mod: 'observatory-demo', w: 30, pm: '+3', st: '1⏳', stc: Y },
    ],
  },
  {
    tab: 'workflows',
    cap: '▸ a workflow run starts — the nav focuses it',
    wf: { running: true, sel: true },
    chapters: [{ g: '◐', gc: Y, title: 'Tests and docs', m: '+0 −0', act: false }],
    empty: 'The run’s change-map fills in as its agents edit.',
  },
  {
    tab: 'workflows',
    cap: '▸ the workflow completes — phases, agents, and its own chapter rollup',
    wf: { running: false, sel: true },
    chapters: [{ g: '◐', gc: Y, title: 'Tests and docs', m: '+12 −0', pending: '1⏳', act: true }],
    mods: [['docs', Y]],
    files: [{ c: Y, f: 'USAGE.md', mod: 'docs', w: 95, pm: '+12', st: '1⏳', stc: Y }],
  },
  {
    cap: '✓ kept 1 edit(s) in task 500567ef — per-chapter accept',
    agent: { phase: '~idle', phaseColor: F, added: 40, removed: 3, sub: { phase: 'done', done: true } },
    chapters: [
      { g: '●', gc: G, title: 'Add feature scaling to the pipeline', m: '+9 −3', act: true },
      { g: '●', gc: G, title: 'Validate the training dataset', m: '+7 −0', act: true },
      { g: '◐', gc: Y, title: 'Tests and docs', m: '+24 −0', pending: '2⏳', act: true },
    ],
    mods: [['docs', Y], ['tests', Y], ['observatory-demo', G], ['src/models', G]],
    files: [
      { c: Y, f: 'USAGE.md', mod: 'docs', w: 95, pm: '+12', st: '1⏳', stc: Y },
      { c: Y, f: 'test_pipeline.py', mod: 'tests', w: 95, pm: '+12', st: '1⏳', stc: Y },
      { c: G, f: 'dataset.py', mod: 'src/models', w: 58, pm: '+7', st: '✓', stc: G },
      { c: G, f: 'features.py', mod: 'observatory-demo', w: 55, pm: '+6', st: '✓', stc: G },
    ],
  },
  {
    cap: '✓ kept 2 edit(s) — the fully reviewed demo session clears its own store',
    agent: { phase: '~idle', phaseColor: F, added: 0, removed: 0, sub: { phase: 'done', done: true } },
    chapters: [],
    empty: 'No edits for this agent yet. This fills in as Claude edits files.',
  },
];

// --- render + encode --------------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-pyc-frames-'));
const pngs = beats.map((b, i) => {
  const file = path.join(tmp, `f${i}.html`);
  fs.writeFileSync(file, frame(b));
  const png = path.join(tmp, `f${i}.png`);
  try {
    execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(tmp, 'chrome-profile')}`,
      `--screenshot=${png}`, `--window-size=${W},${H}`, `file://${file}`,
    ], { stdio: 'pipe', timeout: 20_000, killSignal: 'SIGKILL' });
  } catch (e) {
    if (!fs.existsSync(png)) throw e;
  }
  console.log(`  frame ${i + 1}/${beats.length} — ${b.cap.slice(0, 60)}`);
  return png;
});

const gif = GIFEncoder();
pngs.forEach((p, i) => {
  const png = PNG.sync.read(fs.readFileSync(p));
  const palette = quantize(png.data, 256);
  const index = applyPalette(png.data, palette);
  gif.writeFrame(index, png.width, png.height, { palette, delay: i === pngs.length - 1 ? 4200 : 2100 });
});
gif.finish();
fs.writeFileSync(OUT, Buffer.from(gif.bytes()));
console.log(`✓ ${path.relative(ROOT, OUT)} — ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB, ${pngs.length} frames`);
if (!process.env.OBS_REC_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
else console.log('frames kept at', tmp);
