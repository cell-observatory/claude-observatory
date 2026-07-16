// Record the demo as an animated GIF of the REAL Overview webview.
//
// The pipeline is faithful end-to-end: `runDemo` replays the scripted session through the real capture
// hooks in a hermetic HOME + workspace; at every beat this script snapshots the real `changemap --json`
// + `multitask --json` payloads; each snapshot is rendered by the ACTUAL webview code (the OVERVIEW_SCRIPT
// and shell style extracted from packages/vscode/src/extension.ts) in headless Chrome; the frames are
// assembled into three recordings (gifenc — no native deps, no ffmpeg): docs/media/demo-live.gif (the
// run), demo-workflow.gif (the workflow arc, Workflows angle), demo-review.gif (chapter review + auto-clear).
//
// Usage: node scripts/record-demo.mjs        (≈20s; requires Google Chrome + a built core/cli)
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
const W = 1180;
const H = 620;

// --- hermetic demo home + workspace (never touches real sessions) ---------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-rec-home-'));
const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'obs-rec-ws-')));
fs.mkdirSync(path.join(ws, '.git'), { recursive: true }); // plain dir → git-free repo key → fleet rows
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CLAUDE_CONFIG_DIR;
const core = require(path.join(ROOT, 'packages', 'core', 'dist', 'index.js'));

// --- extract the REAL webview (script + style) from the extension source --------------------------
const src = fs.readFileSync(path.join(ROOT, 'packages', 'vscode', 'src', 'extension.ts'), 'utf8');
const sMark = 'const OVERVIEW_SCRIPT = `';
const sStart = src.indexOf(sMark) + sMark.length;
// The real multitaskFilter, transcribed to plain JS (the TS source carries type annotations).
const MTF_JS =
  "(function(data, state){ var st=state||{}; var activeOnly=!!st.activeOnly; var dAg=st.dismissedAgents||{}; var dWf=st.dismissedWorkflows||{};" +
  " function isActive(p){ return p==='working'||p==='awaiting-input'||p==='awaiting-permission'; }" +
  " function agentActive(a){ if(isActive(a&&a.phase)) return true; var subs=(a&&a.subagents)||[]; for(var i=0;i<subs.length;i++) if(isActive(subs[i]&&subs[i].phase)) return true; return false; }" +
  " var allAg=(data&&data.agents)||[]; var agents=[]; var completedAgents=[]; var activeAgents=0; var hiddenAgents=0;" +
  " for(var i=0;i<allAg.length;i++){ var a=allAg[i]; var act=agentActive(a); if(act) activeAgents++; else completedAgents.push(String(a&&a.session)); if(activeOnly&&!act) continue; if(!act&&dAg[String(a&&a.session)]){ hiddenAgents++; continue; } agents.push(a); }" +
  " var allWf=(data&&data.workflows)||[]; var workflows=[]; var completedWorkflows=[]; var activeWorkflows=0; var hiddenWorkflows=0;" +
  " for(var j=0;j<allWf.length;j++){ var w=allWf[j]; var run=!!(w&&w.running); if(run) activeWorkflows++; else completedWorkflows.push(String(w&&w.id)); if(activeOnly&&!run) continue; if(!run&&dWf[String(w&&w.id)]){ hiddenWorkflows++; continue; } workflows.push(w); }" +
  " return { agents:agents, workflows:workflows, completedAgents:completedAgents, completedWorkflows:completedWorkflows, totalAgents:allAg.length, activeAgents:activeAgents, hiddenAgents:hiddenAgents, totalWorkflows:allWf.length, activeWorkflows:activeWorkflows, hiddenWorkflows:hiddenWorkflows }; })";
let script = src.slice(sStart, src.indexOf(String.fromCharCode(96) + ';', sStart));
script = script.replace(/\$\{multitaskFilter\.toString\(\)\}/g, MTF_JS).replace(/\$\{[^}]*\}/g, '');
const useIdx = src.indexOf('${OVERVIEW_SCRIPT}');
const styleStart = src.lastIndexOf('<style>', useIdx);
let style = src.slice(styleStart, src.indexOf('</style>', styleStart) + '</style>'.length);
const codSrc = fs.readFileSync(path.join(ROOT, 'packages', 'vscode', 'src', 'codicon.ts'), 'utf8');
style = style.replace('${CODICON_STYLE}', JSON.parse(codSrc.match(/export const CODICON_STYLE = (".*");/s)[1]));
// The shell BODY (toolbar + nav + detail), extracted from the same source so ids always match the script.
const bMark = 'const body =';
const bStart = src.indexOf(bMark, useIdx - 20000);
const bodyLit = src.slice(bStart, src.indexOf('`;', src.indexOf('`<div class="ov-toolbar">', bStart)));
const body = bodyLit
  .slice(bodyLit.indexOf('`<div') + 1)
  .replace(/`\s*\+\s*(?:\/\/[^\n]*\n\s*)*`/g, '') // join the chunk concatenation, skipping comment lines between chunks
  .replace(/\$\{[^}]*\}/g, '');

const esc = (o) => JSON.stringify(o).replace(/</g, '\\u003c');
const runJson = (args) =>
  JSON.parse(execFileSync('node', [CLI, ...args], { cwd: ws, env: process.env, encoding: 'utf8', maxBuffer: 1 << 30 }));

// --- run the demo, snapshotting the machine payloads at every beat ---------------------------------
const frames = []; // { cm, mt, session, caption }
let sessionId = null;
const snap = (caption) => {
  try {
    const args = sessionId ? ['--session', sessionId] : [];
    const cm = runJson(['changemap', '--json', '--root', ws, ...args]);
    const mt = runJson(['multitask', '--json', '--root', ws, ...args]);
    frames.push({ cm, mt, caption });
  } catch {
    frames.push({ cm: null, mt: null, caption }); // pre-transcript beat → the honest empty state
  }
};

console.log('▸ replaying the demo, one snapshot per beat…');
const res = await core.runDemo({
  fast: true,
  cwd: ws,
  log: (line) => {
    snap(line.trim());
    sessionId = sessionId; // (resolved after the first beats; runDemo returns it at the end)
  },
});
sessionId = res.session;
snap('✓ demo complete — 3 chapters, a subagent, a workflow, 5 pending edits');
console.log(`  ${frames.length} beats captured from ${res.session}`);

// --- the REVIEW sequence: real chapter ops against the demo store, one snapshot per decision --------
// This is the WYSIWYG story: each ✓ resolves exactly the edits its chapter row shows; Accept All on a
// fully-reviewed demo auto-clears the store (no residue).
const reviewFrames = [];
const rsnap = (cmd, caption) => {
  const cm = runJson(['changemap', '--json', '--root', ws, '--session', sessionId]);
  const mt = runJson(['multitask', '--json', '--root', ws, '--session', sessionId]);
  reviewFrames.push({ cm, mt, cmd, caption });
};
{
  const cm0 = runJson(['changemap', '--json', '--root', ws, '--session', sessionId]);
  const pending = cm0.summary.pending;
  reviewFrames.push({ cm: cm0, mt: runJson(['multitask', '--json', '--root', ws, '--session', sessionId]), cmd: 'demo', caption: `${pending} pending edits across ${cm0.chapters.length} chapters` });
  // Captions below are the CLI's OWN output lines — the recording shows exactly what the command printed.
  const runOp = (args) =>
    execFileSync('node', [CLI, ...args, '--session', sessionId], { cwd: ws, env: process.env, encoding: 'utf8' })
      .split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '').trim();
  const chs = cm0.chapters.filter((c) => c.edits > 0);
  for (const ch of chs.slice(0, 2)) {
    const out = runOp(['task-keep', ch.id]);
    rsnap(`task-keep ${ch.id.slice(0, 8)}`, out);
  }
  const out = runOp(['keep', '--all']);
  rsnap('keep --all', `${out} — the fully reviewed demo session clears its own store`);
}
console.log(`  ${reviewFrames.length} review snapshots captured`);

// --- render a snapshot through the real webview in headless Chrome ---------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-rec-frames-'));
let frameSeq = 0;
const renderFrame = (f, opts = {}) => {
  const focus = opts.workflows
    ? `var _t=document.querySelector('[data-nav="workflows"]'); if(_t) _t.click();
       var _r=document.querySelector('.mt-wrow[data-wf]'); if(_r) _r.click();`
    : '';
  const boot = f.cm
    ? `window.dispatchEvent(new MessageEvent('message', { data: { type:'overview', session:${esc(sessionId || '')}, cm: ${esc(f.cm)}, mt: ${esc(f.mt)} } })); ${focus}`
    : `document.getElementById('ov-empty').style.display='block'; document.getElementById('ov-empty').innerHTML='No agents yet. <span style="opacity:.75">This fills in as Claude works across your worktrees.</span>';`;
  const cmd = f.cmd || 'demo';
  const html = `<!doctype html><html><head><meta charset="utf-8">${style}
<style> html,body{height:100%;margin:0} body{background:#1e1e1e;color:#cccccc;font-family:-apple-system,'Segoe UI',sans-serif;font-size:13px;display:flex;flex-direction:column}
.rec-cap{flex:none;font:500 12px ui-monospace,Menlo,monospace;color:#d7ba7d;background:#252526;border-top:1px solid #333;padding:7px 14px;white-space:nowrap;overflow:hidden}</style>
</head><body>${body}<div class="rec-cap">$ claude-observatory ${cmd}&nbsp;&nbsp;·&nbsp;&nbsp;${f.caption.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
<script>
  window.acquireVsCodeApi = function(){ return { postMessage:function(){}, getState:function(){}, setState:function(){} }; };
  ${script}
  ${boot}
</script></body></html>`;
  const id = String(frameSeq++).padStart(3, '0');
  const file = path.join(tmp, `f${id}.html`);
  fs.writeFileSync(file, html);
  const png = path.join(tmp, `f${id}.png`);
  // A fresh --user-data-dir sidesteps the desktop Chrome's singleton profile lock, and the hard timeout
  // tolerates headless Chrome's occasional written-the-shot-but-never-exits wedge (the PNG is the truth).
  try {
    execFileSync(CHROME, [
      '--headless', '--disable-gpu', '--use-mock-keychain', '--password-store=basic', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(tmp, 'chrome-profile')}`,
      `--screenshot=${png}`, `--window-size=${W},${H}`, `file://${file}`,
    ], { stdio: 'pipe', timeout: 20_000, killSignal: 'SIGKILL' });
  } catch (e) {
    if (!fs.existsSync(png)) throw e;
  }
  console.log(`  frame ${id} — ${f.caption.slice(0, 60)}`);
  return png;
};

// --- assemble one GIF from rendered frames (256-color quantization, per-frame delays) ---------------
const encodeGif = (name, entries) => {
  const gif = GIFEncoder();
  entries.forEach(({ png: p, delay }) => {
    const png = PNG.sync.read(fs.readFileSync(p));
    const palette = quantize(png.data, 256);
    const index = applyPalette(png.data, palette);
    gif.writeFrame(index, png.width, png.height, { palette, delay });
  });
  gif.finish();
  const out = path.join(ROOT, 'docs', 'media', name);
  fs.writeFileSync(out, Buffer.from(gif.bytes()));
  console.log(`✓ docs/media/${name} — ${(fs.statSync(out).size / 1e6).toFixed(1)} MB, ${entries.length} frames`);
};

// 1) demo-live.gif — the whole run, Fleet angle (the default detail = the demo agent's change-map).
console.log('▸ rendering demo-live.gif (the run, Fleet angle)…');
const livePngs = frames.map((f) => renderFrame(f));
encodeGif('demo-live.gif', livePngs.map((p, i) => ({ png: p, delay: i === 0 ? 1400 : i === livePngs.length - 1 ? 4200 : 1600 })));

// 2) demo-workflow.gif — the workflow arc, Workflows angle: the empty tab, the run appearing (journal,
//    still running), its agent's edit landing, then the completed run with its phase groups — the
//    selected run's change-map slice (its own chapter rollup + files) on the right throughout.
console.log('▸ rendering demo-workflow.gif (the workflow arc, Workflows angle)…');
const wfStart = Math.max(0, frames.findIndex((f) => /WORKFLOW/i.test(f.caption)) - 1);
const wfFrames = frames.slice(wfStart);
const wfPngs = wfFrames.map((f) => renderFrame(f, { workflows: true }));
encodeGif('demo-workflow.gif', wfPngs.map((p, i) => ({ png: p, delay: i === wfPngs.length - 1 ? 4200 : 1900 })));

// 3) demo-review.gif — the WYSIWYG review: accept chapter by chapter, then Accept All → auto-clear.
console.log('▸ rendering demo-review.gif (chapter review + auto-clear)…');
const revPngs = reviewFrames.map((f) => renderFrame(f));
encodeGif('demo-review.gif', revPngs.map((p, i) => ({ png: p, delay: i === revPngs.length - 1 ? 4200 : 2300 })));

// --- hermetic cleanup (OBS_REC_KEEP=1 keeps the frame PNGs for inspection) --------------------------
core.cleanDemo({ cwd: ws });
fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(ws, { recursive: true, force: true });
if (process.env.OBS_REC_KEEP) console.log('frames kept at', tmp);
else fs.rmSync(tmp, { recursive: true, force: true });
