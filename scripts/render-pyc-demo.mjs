// The demo session as it looks in PYCHARM — an animated mockup of the JetBrains Overview tool window
// (docs/media/demo-pyc.gif), beat-for-beat the same story record-demo.mjs records from the real VS Code
// webview: plan → the task list filling → a subagent → a workflow run → review → auto-clear.
//
// This one is a hand-authored mockup animation (the Swing panel can't render headlessly), faithful to
// ChangeMapPanel.kt's real layout: the Fleet/Workflows/Tasks/Sessions nav tabs, the folder strip, and
// the churn-ranked file ledger — in the PyCharm 2026 New UI dark palette
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
  /* The bottom dock is ONE "Dashboards" content holding three titled panes side by side; the window's
     title bar carries a show/hide toggle per foldable pane. There is no tab strip here. */
  .tw-toggles{display:flex;gap:8px;margin-left:8px;color:var(--dim);font-size:11px}
  .tw-toggles span{border:1px solid var(--border2);border-radius:5px;padding:1px 7px;background:var(--panel2)}
  .tw-toggles .on{color:var(--ink);border-color:var(--blue)}
  /* The axes row: icons only, each axis named by its own n/m counter (0.8.9). */
  .axrow{height:30px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--border);background:var(--panel);flex:none;font-size:11.5px;color:var(--dim);white-space:nowrap}
  .axrow .b{border:1px solid var(--border2);border-radius:6px;padding:1px 7px;background:var(--panel2)}
  .axrow .ct{color:var(--ink);font-family:var(--mono);font-size:11px}
  .axrow .sep{width:1px;align-self:stretch;background:var(--border2);margin:5px 4px}
  .toolbar{margin-left:auto;display:flex;gap:10px;align-items:center;color:var(--dim);font-size:11.5px;white-space:nowrap}
  .toolbar .b{border:1px solid var(--border2);border-radius:6px;padding:2px 9px;background:var(--panel2)}
  .toolbar .b.tog{color:var(--ink);border-color:var(--blue)}
  .toolbar .sep{width:1px;align-self:stretch;background:var(--border2);margin:1px 2px}
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
const R = '#E5534B', O = '#D9822B', P = '#9A6AC2', BLUE = '#4C8BF5';
// Emoji-free mini icons — the platform icons the JB chips/toolbar actually show (commit-check /
// VCS history / GC trash / find / bulb), as tiny inline SVGs.
const ico = (d) => `<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px">${d}</svg>`;
const icoCommit = ico('<circle cx="8" cy="8" r="6"/><path d="M5.2 8.2l2 2 3.6-4"/>');
const icoHistory = ico('<path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9"/><path d="M2.5 8L1.2 6.5M2.5 8L4 6.8"/><path d="M8 5.2V8l2.2 1.6"/>');
const icoTrash = ico('<path d="M2.5 4.5h11M6.5 2.5h3M4.5 4.5l.7 9h5.6l.7-9M6.7 7v4M9.3 7v4"/>');
const icoFind = ico('<circle cx="6.8" cy="6.8" r="4.5"/><path d="M10.2 10.2L14 14"/>');
const icoBulb = ico('<path d="M6 12.5h4M6.7 14.5h2.6M8 1.8a4.4 4.4 0 0 0-2.6 7.9c.7.5 1.1 1.1 1.1 1.8v.5h3v-.5c0-.7.4-1.3 1.1-1.8A4.4 4.4 0 0 0 8 1.8z"/>');

const agentRow = ({ phase, phaseColor, added, removed, sub, sel }) => `
  <div class="agent${sel ? ' sel' : ''}">
    <div class="arow"><span class="badge" style="background:${phaseColor}">${phase}</span>
      <span style="font-family:var(--mono)">demo <span style="color:${F}">⑂demo/pipeline</span></span>
      <span style="margin-left:auto">${spark([0.3, 0.7, 0.5, 0.9, 0.6, 1])}</span>
      <span style="font-family:var(--mono);font-size:10px"><span style="color:${G}">+${added}</span> <span style="color:${Y}">−${removed}</span></span></div>
    ${sub ? `<div class="sub"><span class="badge" style="background:${sub.done ? F : B};font-size:8px">${sub.phase}</span> general-purpose · <i>Write pipeline tests</i> · +12 −0</div>` : ''}
  </div>`;

// One row of the Tasks tab — Claude's own numbered to-do, with the ±/edit counts of its STRICT span
// (the edits captured while it was actually in progress). ● done · ◐ in progress · ○ planned.
const taskRow = ({ g, gc, num, title, m, pending }) => `
  <div class="chrow"><span class="g" style="color:${gc}">${g}</span>
    <span style="font-family:var(--mono);font-size:10.5px;color:${F};flex:none">#${num}</span>
    <span class="t">${title}</span>
    <span class="m">${m}${pending ? ` · <span style="color:${Y}">${pending}</span>` : ''}</span>
  </div>`;

// One row of the Sessions tab — every session in this workspace, most recent conversation first.
const sessRow = ({ live, title, when }) => `
  <div class="chrow"><span class="g" style="color:${live ? B : F}">${live ? '●' : '○'}</span>
    <span class="t"${live ? '' : ' style="color:var(--dim)"'}>${title}</span>
    <span class="m">${when}${live ? ' · active' : ''}</span>
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

/** One frame of the PyCharm Overview: nav tab + rows, folder strip, file ledger, caption. */
const frame = ({ tab = 'fleet', agent, wf, tasks, sessions, mods, files, empty, cap }) => `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
  <div class="tw-head"><span class="title">Observatory Dashboards</span>
    <span class="tw-toggles"><span>Stats</span></span>
    <span class="toolbar"><span style="font-family:var(--mono);font-size:10.5px">\u{1F52C} Extend the training pipeline</span><span class="b" style="color:${G}">${icoCommit} Accept All</span><span class="b" style="color:${R}">${icoHistory} Reject All</span><span class="b" style="color:${O}">${icoTrash} Clear Resolved</span><span class="b" style="color:${BLUE}">↗ Export</span><span class="sep"></span><span class="b" style="color:${P}">${icoFind} Search</span><span class="b tog">Active only</span><span class="b" style="color:${P}">${icoBulb} Spotlight</span><span class="b">⟳</span></span></div>
  <div class="axrow"><span class="b" style="color:${B}">▲</span><span class="ct">Diff 1/2</span><span class="b" style="color:${B}">▼</span><span class="b" style="color:${G}">✓</span><span class="b" style="color:${R}">↩</span><span class="sep"></span><span class="b" style="color:${B}">◀</span><span class="ct">File 1/3</span><span class="b" style="color:${B}">▶</span><span class="b" style="color:${G}">✓✓</span><span class="b" style="color:${R}">✕</span><span class="sep"></span><span class="b" style="color:${B}">◀</span><span class="ct">Folder 1/2</span><span class="b" style="color:${B}">▶</span><span class="b" style="color:${G}">✓✓</span><span class="b" style="color:${R}">✕</span><span class="sep"></span><span class="b" style="color:${B}">◀</span><span class="ct">Prompt 1/2</span><span class="b" style="color:${B}">▶</span><span class="b" style="color:${B}">▷</span><span class="b" style="color:${G}">✓✓</span><span class="b" style="color:${R}">✕</span></div>
  <div class="main">
    <div class="nav">
      <div class="nav-tabs"><span class="${tab === 'sessions' ? 'on' : ''}">Sessions ${sessions ? sessions.length : 4}</span><span class="${tab === 'fleet' ? 'on' : ''}">Fleet</span><span class="${tab === 'workflows' ? 'on' : ''}">Workflows</span><span class="${tab === 'tasks' ? 'on' : ''}">Tasks ${tasks ? `${tasks.filter((t) => t.g === '●').length}/${tasks.length}` : '2/3'}</span></div>
      <div class="nav-body">${
        tab === 'tasks' ? (tasks || []).map(taskRow).join('')
        : tab === 'sessions' ? (sessions || []).map(sessRow).join('')
        : tab === 'workflows' ? (wf ? wfRun(wf) : '<div class="none">No workflow runs — orchestrations appear here</div>')
        : (agent ? agentRow(agent) : '<div class="none">No agents yet — this fills in as Claude Code sessions run</div>')
      }</div>
    </div>
    <div class="detail">
      ${mods ? strip(mods) : ''}
      ${(files || []).map(led).join('')}
      ${empty ? `<div class="empty">${empty}</div>` : ''}
    </div>
  </div>
  <div class="cap"><b>PyCharm</b> · same payloads, native panels&nbsp;&nbsp;·&nbsp;&nbsp;${cap}</div>
</body></html>`;

// --- the beats (mirrors the demo scenario + the recorded VS Code angles) ----------------------------
// Captions are the demo's OWN narration lines and the CLI's own output, so the recording never claims
// something the commands did not print.
const T1 = 'Add feature scaling to the pipeline';
const T2 = 'Validate the training dataset';
const T3 = 'Tests and docs';
const T4 = 'Retire the legacy scaler';
const T5 = 'Profile the pipeline';
const T6 = 'Tune the scaler for sparse columns'; // the sixth, still in progress when the demo ends
const beats = [
  {
    tab: 'tasks',
    cap: '\u25B8 plan \u2014 three to-dos + the numbered task list',
    tasks: [
      { g: '\u25D0', gc: Y, num: 1, title: T1, m: '' },
      { g: '\u25CB', gc: F, num: 2, title: T2, m: '' },
      { g: '\u25CB', gc: F, num: 3, title: T3, m: '' },
      { g: '\u25CB', gc: F, num: 4, title: T4, m: '' },
      { g: '\u25CB', gc: F, num: 5, title: T5, m: '' },
      { g: '\u25CB', gc: F, num: 6, title: T6, m: '' },
    ],
    empty: 'No edits yet. This fills in as Claude edits files.',
  },
  {
    tab: 'tasks',
    cap: '\u25B8 task 1 \u2014 feature scaling (2 edits)',
    tasks: [
      { g: '\u25D0', gc: Y, num: 1, title: T1, m: '+9 \u22123', pending: '2\u29D7' },
      { g: '\u25CB', gc: F, num: 2, title: T2, m: '' },
      { g: '\u25CB', gc: F, num: 3, title: T3, m: '' },
      { g: '\u25CB', gc: F, num: 4, title: T4, m: '' },
      { g: '\u25CB', gc: F, num: 5, title: T5, m: '' },
      { g: '\u25CB', gc: F, num: 6, title: T6, m: '' },
    ],
    mods: [['observatory-demo', Y]],
    files: [
      { c: Y, f: 'features.py', mod: 'observatory-demo', w: 80, pm: '+6', st: '1\u29D7', stc: Y },
      { c: Y, f: 'train.py', mod: 'observatory-demo', w: 55, pm: '+3', st: '1\u29D7', stc: Y },
    ],
  },
  {
    tab: 'tasks',
    cap: '\u25B8 task 2 \u2014 dataset validation',
    tasks: [
      { g: '\u25CF', gc: G, num: 1, title: T1, m: '+9 \u22123', pending: '2\u29D7' },
      { g: '\u25D0', gc: Y, num: 2, title: T2, m: '+7 \u22120', pending: '1\u29D7' },
      { g: '\u25CB', gc: F, num: 3, title: T3, m: '' },
      { g: '\u25CB', gc: F, num: 4, title: T4, m: '' },
      { g: '\u25CB', gc: F, num: 5, title: T5, m: '' },
      { g: '\u25CB', gc: F, num: 6, title: T6, m: '' },
    ],
    mods: [['observatory-demo', Y], ['src/models', Y]],
    files: [
      { c: Y, f: 'dataset.py', mod: 'src/models', w: 80, pm: '+7', st: '1\u29D7', stc: Y },
      { c: Y, f: 'features.py', mod: 'observatory-demo', w: 75, pm: '+6', st: '1\u29D7', stc: Y },
      { c: Y, f: 'train.py', mod: 'observatory-demo', w: 50, pm: '+3', st: '1\u29D7', stc: Y },
    ],
  },
  {
    cap: '\u25B8 task 3 \u2014 tests, written by a subagent',
    agent: { phase: 'working', phaseColor: G, added: 28, removed: 3, sub: { phase: 'working' } },
    mods: [['observatory-demo', Y], ['tests', Y], ['src/models', Y]],
    files: [
      { c: Y, f: 'test_pipeline.py', mod: 'tests', w: 95, pm: '+12', st: '1\u29D7', stc: Y },
      { c: Y, f: 'dataset.py', mod: 'src/models', w: 58, pm: '+7', st: '1\u29D7', stc: Y },
      { c: Y, f: 'features.py', mod: 'observatory-demo', w: 55, pm: '+6', st: '1\u29D7', stc: Y },
      { c: Y, f: 'train.py', mod: 'observatory-demo', w: 30, pm: '+3', st: '1\u29D7', stc: Y },
    ],
  },
  {
    tab: 'workflows',
    cap: '\u25B8 a workflow run starts \u2014 the nav focuses it',
    wf: { running: true, sel: true },
    empty: 'The run\u2019s change-map fills in as its agents edit.',
  },
  {
    tab: 'workflows',
    cap: '\u25B8 the workflow completes \u2014 phases, agents, and its own change-map slice',
    wf: { running: false, sel: true },
    mods: [['docs', Y]],
    files: [{ c: Y, f: 'USAGE.md', mod: 'docs', w: 95, pm: '+12', st: '1\u29D7', stc: Y }],
  },
  {
    tab: 'tasks',
    cap: '\u2713 kept 2 edit(s) in task \u201CAdd feature scaling\u201D \u2014 its strict in-progress span',
    tasks: [
      { g: '\u25CF', gc: G, num: 1, title: T1, m: '+9 \u22123' },
      { g: '\u25CF', gc: G, num: 2, title: T2, m: '+7 \u22120' },
      { g: '\u25D0', gc: Y, num: 3, title: T3, m: '+24 \u22120', pending: '2\u29D7' },
      { g: '\u25CB', gc: F, num: 4, title: T4, m: '' },
      { g: '\u25CB', gc: F, num: 5, title: T5, m: '' },
      { g: '\u25CB', gc: F, num: 6, title: T6, m: '' },
    ],
    mods: [['docs', Y], ['tests', Y], ['observatory-demo', G], ['src/models', G]],
    files: [
      { c: Y, f: 'USAGE.md', mod: 'docs', w: 95, pm: '+12', st: '1\u29D7', stc: Y },
      { c: Y, f: 'test_pipeline.py', mod: 'tests', w: 95, pm: '+12', st: '1\u29D7', stc: Y },
      { c: G, f: 'dataset.py', mod: 'src/models', w: 58, pm: '+7', st: '\u2713', stc: G },
      { c: G, f: 'features.py', mod: 'observatory-demo', w: 55, pm: '+6', st: '\u2713', stc: G },
    ],
  },
  {
    tab: 'sessions',
    cap: '\u2713 kept 2 edit(s) \u2014 the fully reviewed demo session clears its own store',
    sessions: [
      { live: true, title: 'Extend the training pipeline', when: 'now' },
      { live: false, title: 'Split the training loop out of models.py', when: '2h ago' },
      { live: false, title: 'Add type hints to the dataset module', when: 'yesterday' },
      { live: false, title: 'session 9f2ab6c1', when: '3d ago' },
    ],
    empty: 'Nothing left to review in this session \u2014 every edit was accepted, and the store cleared itself.',
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
      '--headless', '--disable-gpu', '--use-mock-keychain', '--password-store=basic', '--hide-scrollbars', '--force-device-scale-factor=1',
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
