// Record the terminal dashboard as an animated GIF, from the REAL renderer.
//
// The pipeline is faithful end-to-end and adds no dependency: `runDemo` replays the scripted session
// through the real capture hooks in a hermetic HOME + workspace; at every beat this script snapshots
// the real `views --json` payloads and renders them with the ACTUAL `renderDashFrame` the `dash`
// command uses; each frame's ANSI is converted to spans in a <pre> page and screenshotted by the same
// headless Chrome + gifenc assembly `record-demo.mjs` already uses.
//
// Rendering the real function rather than a mockup is the point: a recorded terminal that drifts from
// the product is a claim nobody can check.
//
// Usage: node scripts/record-dash.mjs        (≈25s; requires Google Chrome + a built core/cli)
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
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'index.js');
const COLS = 108;
const ROWS = 26;

// --- hermetic demo home + workspace (never touches real sessions) ---------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-dash-home-'));
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obs-dash-ws-')));
fs.mkdirSync(path.join(ws, '.git'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CLAUDE_CONFIG_DIR;
const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));
// The terminal's renderer lives in `packages/tui` since the split. This script reached for it on
// `core` and kept doing so afterwards, because nothing here is type-checked and the call sat behind a
// session-resolution step that fails first on a machine with no session — so the recorder looked
// merely unrunnable rather than broken, and the GIF it produces could not be regenerated.
const tui = require(path.join(ROOT, 'packages', 'tui', 'dist', 'index.js'));

const runJson = (args) =>
  JSON.parse(execFileSync('node', [CLI, ...args], { cwd: ws, env: process.env, encoding: 'utf8', maxBuffer: 1 << 30 }));

// --- replay the demo, snapshotting the machine payloads at every beat ------------------------------
const beats = [];
let sessionId = null;
const VIEWS = 'changemap,list,prompts,multitask,risk,egress';
const snap = (caption) => {
  // `sessionId` is still null for the first several beats — `snap` IS runDemo's log callback, so it
  // runs while the demo is still writing. That is not a bug and does not need fixing here: with no
  // `--session`, the child resolves the session from its own cwd, which IS `ws`. Verified by
  // recording with and without an explicit id — byte-identical GIFs. The early beats come back empty
  // because at that moment the session genuinely does not exist yet, which is the honest frame.
  try {
    const args = sessionId ? ['--session', sessionId] : [];
    beats.push({ views: runJson(['views', '--views', VIEWS, '--json', '--root', ws, ...args]), caption });
  } catch {
    beats.push({ views: null, caption }); // pre-transcript beat → the honest empty state
  }
};

console.log('▸ replaying the demo, one snapshot per beat…');
const res = await core.runDemo({ fast: true, cwd: ws, log: (line) => snap(line.trim()) });
sessionId = res.session;
// The pane counts REVIEW UNITS minus the chains that cancel out; `res.edits` is raw records, so
// captioning with it put a different number beside the list it describes.
const pendingUnits = core.reviewUnits(res.session, 'pending').filter((u) => !u.cancelled).length;
snap(`✓ demo complete — ${pendingUnits} pending change(s) to review`);
console.log(`  ${beats.length} beats captured`);

// --- render each beat through the REAL frame renderer, walking the windows -------------------------
// The dashboard is Claude, Prompts, Traces and Dashboards docked around Detail, and Detail has TWO
// faces the window bar reaches with their own keys (F4 Map, F5 Diff). So the tour walks focus and
// FACE rather than a list of screens — cycling the retired screen ids here would still render,
// because the pane compositor ignores `screen`, and would silently record a product that no longer
// exists. The Claude window cannot OPEN at 26 recording rows (it folds below ~40), so its beat zooms
// it instead — which is also the frame that shows the window whole.
//
// It also plants a real `diffPatch`. The previous tour set `diffLines`, a field that was removed, so
// every recording showed Detail's diff face empty — the GIF advertised a blank centre pane.
const TOUR = [
  { focus: 'prompts', tab: {} },
  { focus: 'claude', tab: {}, zoom: 'claude' }, // F1 — the agent's own window, zoomed to fit 26 rows
  { focus: 'traces', tab: {} },
  { focus: 'detail', tab: { detail: 1 } },   // F4 — the change map
  { focus: 'detail', tab: { detail: 0 } },   // F5 — the selected edit's diff
  { focus: 'dashboards', tab: { dashboards: 0 } },
  { focus: 'dashboards', tab: { dashboards: 3 } },
];
const DEMO_PATCH = [
  '@@ -18,7 +18,9 @@',
  ' export function resolveLayout(req) {',
  '-  const open = COLUMNS.filter((id) => !min.has(id));',
  '+  // The focused pane is never the victim while another column could go instead.',
  '+  const open = COLUMNS.filter((id) => !min.has(id));',
  '+  const victims = open.filter((id) => id !== focus).sort((a, b) => a.yield - b.yield);',
  '   const mode = open.length >= 2 ? \'wide\' : \'stack\';',
].join('\n');
const frames = beats.map((b, i) => {
  const step = TOUR[Math.floor((i / Math.max(1, beats.length - 1)) * (TOUR.length - 1))];
  return {
  lines: tui.renderDashFrame(
    {
      views: b.views,
      screen: 'edits',
      panes: {
        minimized: tui.defaultMinimized(COLS, ROWS),
        zoom: step.zoom ?? null,
        focus: step.focus,
        tab: step.tab,
        cursor: { [step.focus]: Math.min(3, i) },
        scroll: {},
        sizes: {},
      },
      // A REAL patch, so the recording shows the diff face doing its job — bands, line numbers and
      // the header naming the tool — instead of the empty pane the removed `diffLines` field produced.
      diffPatch: DEMO_PATCH,
      diffMeta: { id: 12, path: 'packages/core/src/tui/layout.ts', added: 3, removed: 1, verb: 'Edit' },
      cursor: Math.min(3, i),
      scroll: 0,
      session: sessionId || '',
      sessionTitle: 'demo',
      filter: '',
      status: b.caption,
      error: null,
      confirm: null,
      // Fixed, so the recording is reproducible: relTime would otherwise stamp every re-record
      // differently and the GIF would churn in git for no reason.
      now: 1_700_000_000_000,
      watcherMode: 'native',
      open: new Set(['packages', 'packages/core']),
      overlay: null,
    },
    // TRUECOLOR, not `true`. `depthOf(true)` is '256', so every tint() emitted `\x1b[38;5;Nm` — codes
    // `ansiToHtml` could not read, which dropped the product's whole palette on the floor. The GIF had
    // exactly one saturated colour in it (a stray `\x1b[36m`); measured from its own colour table.
    { cols: COLS, rows: ROWS, color: 'truecolor' }
  ),
};
});

// --- ANSI → HTML, so the existing Chrome+gifenc pipeline can rasterize a terminal -------------------
// The 16-colour fallbacks, for the few places that emit a bare SGR rather than going through tint().
// Everything else arrives as 38;2;R;G;B and is used VERBATIM — the recording carries the product's own
// PALETTE rather than an approximation of it, which is the whole point of rendering the real frame.
const SGR_COLORS = { 30: '#000', 31: '#e5534b', 32: '#3fb950', 33: '#d9a441', 34: '#4c8bf5', 35: '#9a6ac2', 36: '#39c5cf', 37: '#cccccc' };

/** xterm-256 → hex, for the 256-colour depth. Only the cube + greys; 0–15 fall back to SGR_COLORS. */
function xterm256(n) {
  if (n < 16) return SGR_COLORS[30 + (n % 8)] ?? '#cccccc';
  if (n < 232) {
    const i = n - 16;
    const step = (v) => (v === 0 ? 0 : 55 + v * 40);
    const [r, g, b] = [step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6)];
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  const v = (8 + (n - 232) * 10).toString(16).padStart(2, '0');
  return '#' + v + v + v;
}
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function ansiToHtml(line) {
  let out = '';
  let open = 0;
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let m;
  while ((m = re.exec(line))) {
    out += esc(line.slice(last, m.index));
    last = m.index + m[0].length;
    const codes = m[1].split(';').filter(Boolean).map(Number);
    if (codes.length === 0 || codes.includes(0)) {
      out += '</span>'.repeat(open);
      open = 0;
      continue;
    }
    const style = [];
    for (let k = 0; k < codes.length; k++) {
      const c = codes[k];
      // Extended colour is a SEQUENCE, not a code: 38;2;R;G;B and 38;5;N. Reading them one at a time
      // matched none of them and silently emitted an empty span — which is how the product's palette
      // vanished from every recording.
      if (c === 38 && codes[k + 1] === 2) {
        style.push(`color:rgb(${codes[k + 2] | 0},${codes[k + 3] | 0},${codes[k + 4] | 0})`);
        k += 4;
      } else if (c === 38 && codes[k + 1] === 5) {
        style.push(`color:${xterm256(codes[k + 2] | 0)}`);
        k += 2;
      } else if (c === 1) style.push('font-weight:700');
      else if (c === 2) style.push('opacity:.62');
      else if (c === 7) style.push('background:#cccccc;color:#101010');
      else if (SGR_COLORS[c]) style.push(`color:${SGR_COLORS[c]}`);
    }
    out += `<span style="${style.join(';')}">`;
    open++;
  }
  out += esc(line.slice(last)) + '</span>'.repeat(open);
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-dash-frames-'));
let seq = 0;
const renderFrame = (frame) => {
  const body = frame.lines.map(ansiToHtml).join('\n');
  const html = `<!doctype html><meta charset="utf-8"><style>
    html,body{margin:0;background:#101010}
    pre{margin:0;padding:14px 16px;font:13px/1.36 'SF Mono',Menlo,'DejaVu Sans Mono',monospace;
        color:#cccccc;white-space:pre;letter-spacing:0}
  </style><pre>${body}</pre>`;
  const id = String(seq++).padStart(3, '0');
  const file = path.join(tmp, `f${id}.html`);
  fs.writeFileSync(file, html);
  const png = path.join(tmp, `f${id}.png`);
  try {
    execFileSync(
      CHROME,
      [
        '--headless', '--disable-gpu', '--use-mock-keychain', '--password-store=basic', '--hide-scrollbars',
        '--force-device-scale-factor=2', '--no-first-run', '--no-default-browser-check',
        `--user-data-dir=${path.join(tmp, 'chrome-profile')}`,
        `--screenshot=${png}`, `--window-size=${COLS * 8 + 34},${ROWS * 18 + 30}`, `file://${file}`,
      ],
      { stdio: 'pipe', timeout: 20_000, killSignal: 'SIGKILL' }
    );
  } catch (e) {
    // Headless Chrome sometimes writes the shot and then never exits; the PNG is the truth.
    if (!fs.existsSync(png)) throw e;
  }
  console.log(`  frame ${id}`);
  return png;
};

console.log('▸ rendering frames…');
const pngs = frames.map(renderFrame);

const gif = GIFEncoder();
pngs.forEach((p, i) => {
  const png = PNG.sync.read(fs.readFileSync(p));
  const palette = quantize(png.data, 256);
  gif.writeFrame(applyPalette(png.data, palette), png.width, png.height, {
    palette,
    delay: i === pngs.length - 1 ? 4200 : 1600,
  });
});
gif.finish();
const out = path.join(ROOT, 'docs', 'media', 'demo-dash.gif');
fs.writeFileSync(out, Buffer.from(gif.bytes()));
console.log(`✓ docs/media/demo-dash.gif — ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${pngs.length} frames`);

// --- hermetic cleanup ------------------------------------------------------------------------------
core.cleanDemo({ cwd: ws });
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });
if (process.env.OBS_REC_KEEP) console.log('frames kept at', tmp);
else fs.rmSync(tmp, { recursive: true, force: true });
