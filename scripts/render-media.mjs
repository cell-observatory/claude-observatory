#!/usr/bin/env node
/**
 * Renders the README's feature images (docs/media/*.png) — faithful mockups of the extension UI,
 * rasterized with headless Chrome at 2x. Regenerate after UI changes: `node scripts/render-media.mjs`.
 */
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';

const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = new URL('../docs/media/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// ---------- shared look (VS Code Dark Modern-ish + the extension's own colors) ----------
const CSS = `
  * { box-sizing: border-box; margin: 0; }
  :root {
    --bg:#1f1f1f; --side:#181818; --panel:#181818; --border:#2b2b2b; --border2:#3c3c3c;
    --ink:#cccccc; --dim:#9d9d9d; --faint:#6e6e6e;
    --pending:#d9a441; --kept:#3fb950; --reverted:#8b949e;
    --blue:#4c8bf5; --purple:#9a6ac2; --orange:#c9713f; --accent:#4c8bf5;
    --hl:rgba(63,185,80,0.10); --hlborder:#2ea043;
  }
  body { font-family:-apple-system,'Segoe UI',sans-serif; font-size:13px; color:var(--ink); background:#000; }
  .mono { font-family:'SF Mono',Menlo,monospace; }
  .window { background:var(--bg); border:1px solid #000; border-radius:10px; overflow:hidden;
            box-shadow:0 20px 60px rgba(0,0,0,.6); }
  .titlebar { height:36px; background:#2a2a2a; display:flex; align-items:center; padding:0 14px; gap:8px;
              border-bottom:1px solid var(--border); }
  .tl { width:12px; height:12px; border-radius:50%; }
  .titlebar .t { flex:1; text-align:center; color:var(--dim); font-size:12px; }
  .row { display:flex; align-items:center; }
  /* tree */
  .viewhead { font-size:11px; letter-spacing:.08em; color:var(--dim); padding:8px 14px 4px; font-weight:600; }
  .trow { display:flex; align-items:center; gap:7px; padding:3.5px 10px; font-size:13px; }
  .trow .tw { color:var(--faint); width:12px; font-size:10px; }
  .trow .ic { width:16px; text-align:center; }
  .trow .meta { margin-left:auto; color:var(--faint); font-size:11px; white-space:nowrap; }
  .pill { font-size:10px; padding:1px 7px; border-radius:9px; border:1px solid currentColor; }
  .p-pending{color:var(--pending)} .p-kept{color:var(--kept)} .p-reverted{color:var(--reverted)}
  .strike { text-decoration:line-through; color:var(--faint); }
  .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  /* editor */
  .codeline { display:flex; font-family:'SF Mono',Menlo,monospace; font-size:12.5px; line-height:1.75; }
  .codeline > span:last-child { white-space:pre; }
  .codeline .ln { width:44px; text-align:right; padding-right:16px; color:#6e7681; user-select:none; }
  .codeline.hl { background:var(--hl); box-shadow:inset 3px 0 0 var(--hlborder); }
  .codelens { font-size:11px; color:var(--dim); padding:2px 0 0 60px; font-family:-apple-system,sans-serif; }
  .codelens a { color:var(--dim); text-decoration:none; margin-right:14px; }
  .tok-k{color:#569cd6} .tok-f{color:#dcdcaa} .tok-s{color:#ce9178} .tok-c{color:#6a9955} .tok-v{color:#9cdcfe}
  .sparkle { color:#8b8b8b; font-style:italic; font-size:11.5px; margin-left:26px; }
  /* panel bits */
  .paneltabs { display:flex; gap:18px; padding:6px 16px 0; font-size:11px; letter-spacing:.05em; color:var(--faint);
               border-bottom:1px solid var(--border); background:var(--panel); }
  .paneltabs .on { color:var(--ink); border-bottom:1.5px solid var(--accent); padding-bottom:6px; }
  .paneltabs span { padding-bottom:6px; }
  .col { padding:8px 0; overflow:hidden; }
  .colhead { font-size:10.5px; letter-spacing:.09em; color:var(--dim); padding:4px 16px 6px; font-weight:600; }
  .obsrow { display:flex; gap:8px; padding:4px 16px; font-size:12.5px; align-items:baseline; }
  .obsrow .r { color:var(--dim); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .obsrow .id { color:var(--ink); }
  /* stats */
  .seg { display:flex; border:1px solid var(--border2); border-radius:5px; overflow:hidden; margin:10px 16px; }
  .seg div { flex:1; text-align:center; font-size:10.5px; padding:4px 0; color:var(--dim); }
  .seg .on { background:var(--accent); color:#111; font-weight:600; }
  .plothead { display:flex; justify-content:space-between; padding:2px 16px 4px; }
  .pname { font-size:10px; letter-spacing:.1em; color:var(--dim); font-family:'SF Mono',Menlo,monospace; }
  .legend { display:flex; gap:9px; font-size:9.5px; color:var(--dim); }
  .legend i { width:9px; height:2.5px; display:inline-block; border-radius:1px; margin-right:4px; vertical-align:middle; }
  .plotbody { padding:0 16px 6px 46px; position:relative; }
  .yt { position:absolute; left:8px; width:32px; text-align:right; font-size:8.5px; color:var(--faint);
        font-family:'SF Mono',Menlo,monospace; transform:translateY(-50%); }
  .pax { display:flex; justify-content:space-between; font-size:9px; color:var(--faint); padding:2px 16px 8px 46px;
         font-family:'SF Mono',Menlo,monospace; }
  .uhead { font-size:10px; letter-spacing:.1em; color:var(--dim); padding:8px 16px 4px; font-family:'SF Mono',Menlo,monospace; }
  .urow { display:flex; align-items:center; gap:8px; padding:2px 16px; height:20px; font-family:'SF Mono',Menlo,monospace; font-size:11px; }
  .urow .lbl { width:24px; color:var(--dim); }
  .track { flex:1; height:5px; border-radius:3px; background:#333; overflow:hidden; }
  .fill { display:block; height:100%; border-radius:3px; }
  .pct { width:34px; text-align:right; }
  .sub { min-width:86px; color:var(--faint); }
  /* status bar */
  .statusbar { height:24px; background:#181818; border-top:1px solid var(--border); display:flex; align-items:center;
               padding:0 10px; gap:14px; font-size:11.5px; color:var(--dim); }
  .sb-warn { background:#8a6d00; color:#fff; padding:1px 8px; border-radius:3px; display:flex; gap:5px; align-items:center; }
  .hovercard { background:#252526; border:1px solid #454545; border-radius:5px; padding:10px 12px;
               box-shadow:0 6px 24px rgba(0,0,0,.5); font-size:12px; width:340px; }
  .hovercard .actions { display:flex; gap:12px; margin-top:8px; }
  .hovercard .actions span { color:var(--accent); font-size:12px; }
`;

const scene = (w, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
   <body style="width:${w}px;padding:24px;">${body}</body></html>`;

const telescope = `<svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="#ccc" stroke-width="2.4">
  <path d="M4 22.5 L19 8.2 a3 3 0 0 1 4.3 0 l1.5 1.6 a3 3 0 0 1 0 4.2 L10.6 28.4" stroke-linejoin="round"/>
  <path d="M6.6 20 l5.6 5.7"/><path d="M25.5 3.5 l0.9 2.6 2.6 0.9 -2.6 0.9 -0.9 2.6 -0.9 -2.6 L22.5 7 l2.6 -0.9 z" fill="#ccc" stroke="none"/></svg>`;

// ---------- scene bits reused across images ----------
const editsTree = `
  <div class="viewhead">EDITS <span style="float:right;color:var(--faint)">session 0c396c6b</span></div>
  <div class="trow"><span class="tw">▾</span><span class="ic">📁</span>src</div>
  <div class="trow" style="padding-left:26px"><span class="tw">▾</span><span class="ic">📁</span>models</div>
  <div class="trow" style="padding-left:42px"><span class="tw">▾</span><span class="ic">📄</span>User.js<span class="meta">2 edits · 2 pending</span></div>
  <div class="trow" style="padding-left:58px"><span class="tw">▾</span><span class="ic" style="color:var(--orange)">◆</span>class User<span class="meta">2 edits · 2 pending</span></div>
  <div class="trow mono" style="padding-left:76px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#1&nbsp; +11 −0<span class="meta"><span class="pill p-pending">pending</span></span></div>
  <div class="trow mono" style="padding-left:76px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#2&nbsp; +4 −0<span class="meta"><span class="pill p-pending">pending</span></span></div>
  <div class="trow" style="padding-left:26px"><span class="tw"></span><span class="ic">📄</span>index.js<span class="meta">1 edit · 1 pending</span></div>
  <div class="trow mono" style="padding-left:60px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#3&nbsp; +4 −0<span class="meta"><span class="pill p-pending">pending</span></span></div>`;

const editorCode = (withHover) => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    <div class="codelens"><a>✓ Keep #2</a><a>↩ Undo</a><a>± Diff</a></div>
    <div class="codeline"><span class="ln">5</span><span>  <span class="tok-f">greet</span>() {</span></div>
    <div class="codeline"><span class="ln">6</span><span>    <span class="tok-k">return</span> <span class="tok-s">\`Hello, my name is \${</span><span class="tok-v">this</span><span class="tok-s">.name}!\`</span>;</span></div>
    <div class="codeline"><span class="ln">7</span><span>  }</span></div>
    <div class="codeline hl"><span class="ln">8</span><span></span></div>
    <div class="codeline hl"><span class="ln">9</span><span>  <span class="tok-f">farewell</span>() {<span class="sparkle">✨ #2</span></span></div>
    <div class="codeline hl"><span class="ln">10</span><span>    <span class="tok-k">return</span> <span class="tok-s">\`Goodbye from \${</span><span class="tok-v">this</span><span class="tok-s">.name}!\`</span>;</span></div>
    <div class="codeline hl"><span class="ln">11</span><span>  }</span></div>
    <div class="codeline"><span class="ln">12</span><span>}</span></div>
    ${withHover ? `<div class="hovercard" style="margin:10px 0 0 120px;">
      <b>Claude edit #2</b> · Edit<br>
      <span style="color:var(--dim)">💭 "Operation 2 — edit that existing file to add a farewell() method…"</span>
      <div class="actions"><span>✓ Keep</span><span>↩ Undo</span><span>± Diff</span><span>💬 Chat</span></div>
    </div>` : ''}
  </div>`;

const observationsCol = `
  <div class="obsrow"><span>🧭</span><span class="id" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Create User class and test imports</span><span class="r" style="flex:none">session recap</span></div>
  <div class="obsrow"><span style="color:var(--dim)">👁</span><span class="id">#3</span><span class="r">created index.js — "Operation 3 — create src/index.js that imports User…"</span></div>
  <div class="obsrow"><span style="color:var(--dim)">👁</span><span class="id">#2</span><span class="r">edited User.js (+4 −0) — "Operation 2 — add a farewell() method…"</span></div>
  <div class="obsrow"><span style="color:var(--pending)">⚠</span><span class="id">#1</span><span class="r">created User.js — 🧠 6 edits across sessions · 50% accepted</span></div>`;

const timelineCol = `
  <div class="obsrow"><span class="dot" style="background:var(--pending)"></span><span class="id mono">14:02&nbsp; User.js&nbsp; ×2</span><span class="r">+15 −0 · added farewell() to mirror greet()</span></div>
  <div class="obsrow" style="padding-left:34px"><span class="dot" style="background:var(--pending)"></span><span class="id mono">#2</span><span class="r">14:02 · +4 −0</span></div>
  <div class="obsrow" style="padding-left:34px"><span class="dot" style="background:var(--pending)"></span><span class="id mono">#1</span><span class="r">14:01 · +11 −0</span></div>
  <div class="obsrow"><span class="dot" style="background:var(--pending)"></span><span class="id mono">14:02&nbsp; index.js</span><span class="r">+4 −0 · created index.js</span></div>`;

const stepPlot = (name, legend, paths, yticks, H) => `
  <div class="plothead"><span class="pname">${name}</span><div class="legend">${legend}</div></div>
  <div class="plotbody">
    ${yticks.map(([label, y]) => `<span class="yt" style="top:${y + 6}px">${label}</span>`).join('')}
    <svg width="100%" height="${H}" viewBox="0 0 100 ${H}" preserveAspectRatio="none" style="display:block">
      <line x1="0" y1="${H - 0.5}" x2="100" y2="${H - 0.5}" stroke="#3c3c3c" stroke-width="1" vector-effect="non-scaling-stroke"/>
      ${paths}
    </svg>
  </div>
  <div class="pax"><span>7/1</span><span>7/2</span><span>7/3</span><span>7/4</span><span>7/5</span><span>7/6</span><span>7/7</span></div>`;

const step = (pts, color, H) => {
  // pts: value 0..1 per bucket → step-after path
  const n = pts.length;
  let d = '';
  pts.forEach((v, i) => {
    const y = (H - 3) * (1 - v) + 1.5;
    const x0 = (i * 100) / n, x1 = ((i + 1) * 100) / n;
    d += `${i ? 'L' : 'M'}${x0},${y}L${x1},${y}`;
  });
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
};

const statsCol = (H1 = 52, H2 = 52) => `
  <div class="seg"><div>Today</div><div class="on">7 days</div><div>30 days</div></div>
  ${stepPlot('EDITS',
    `<span><i style="background:var(--pending)"></i>pending</span><span><i style="background:var(--kept)"></i>accepted</span><span><i style="background:var(--reverted)"></i>reverted</span>`,
    step([0.05, 0.1, 0.05, 0.3, 0.15, 0.9, 0.55], 'var(--pending)', H1) +
    step([0.02, 0.3, 0.4, 0.15, 0.5, 0.6, 0.75], 'var(--kept)', H1) +
    step([0, 0.05, 0.02, 0.05, 0.1, 0.15, 0.08], 'var(--reverted)', H1),
    [['58', 4], ['29', H1 / 2]], H1)}
  ${stepPlot('TOKENS',
    `<span><i style="background:var(--blue)"></i>total</span><span><i style="background:var(--purple)"></i>input</span><span><i style="background:var(--orange)"></i>output</span>`,
    step([0.55, 0.7, 0.6, 0.75, 0.65, 0.97, 0.9], 'var(--blue)', H2) +
    step([0.53, 0.68, 0.58, 0.73, 0.63, 0.95, 0.88], 'var(--purple)', H2) +
    step([0.2, 0.3, 0.25, 0.35, 0.3, 0.5, 0.45], 'var(--orange)', H2),
    [['1B', 4], ['1M', H2 * 0.45], ['1k', H2 * 0.85]], H2)}
  <div style="border-top:1px solid var(--border);margin:4px 16px 0"></div>
  <div class="uhead">USAGE</div>
  <div class="urow"><span class="lbl">ctx</span><span class="track"><span class="fill" style="width:39%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">39%</span><span class="sub">390k/1M</span></div>
  <div class="urow"><span class="lbl">5h</span><span class="track"><span class="fill" style="width:11%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">11%</span><span class="sub">1h30m · ~10M</span></div>
  <div class="urow"><span class="lbl">wk</span><span class="track"><span class="fill" style="width:35%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">35%</span><span class="sub">1d2h · ~37M</span></div>`;

// ---------- scenes ----------
const scenes = {
  // A. the full observatory layout
  'layout': scene(1520, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — Visual Studio Code</span></div>
      <div class="row" style="align-items:stretch; height:472px;">
        <div style="width:48px;background:var(--side);border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding-top:12px;gap:20px;">
          <span style="opacity:.4">🗎</span><span style="opacity:.4">🔍</span>
          <span style="position:relative">${telescope}<span style="position:absolute;right:-7px;bottom:-5px;background:var(--accent);color:#fff;border-radius:8px;font-size:9px;padding:0 4px;">3</span></span>
          <span style="opacity:.4">⚙</span>
        </div>
        <div style="width:300px;background:var(--side);border-right:1px solid var(--border);">
          <div style="padding:10px 14px 2px;font-size:11px;color:var(--dim);letter-spacing:.06em;">CLAUDE OBSERVATORY</div>
          ${editsTree}
          <div class="viewhead" style="border-top:1px solid var(--border);margin-top:8px;">DIFFS</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;">
          <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
            <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">User.js</div>
          </div>
          ${editorCode(false)}
        </div>
      </div>
      <div style="border-top:1px solid var(--border);background:var(--panel);">
        <div class="paneltabs"><span>PROBLEMS</span><span>OUTPUT</span><span>TERMINAL</span><span class="on">CLAUDE OBSERVATORY</span></div>
        <div class="row" style="align-items:stretch;height:212px;">
          <div class="col" style="flex:1.2;border-right:1px solid var(--border);"><div class="colhead">OBSERVATIONS</div>${observationsCol}</div>
          <div class="col" style="flex:1.1;border-right:1px solid var(--border);"><div class="colhead">TIMELINE</div>${timelineCol}</div>
          <div class="col" style="flex:1;"><div class="colhead">STATS</div>${statsCol(34, 34).replace('USAGE', 'USAGE').replace(/<div class="uhead">USAGE<\/div>[\s\S]*$/, '<div class="urow"><span class="lbl">ctx</span><span class="track"><span class="fill" style="width:39%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">39%</span><span class="sub">390k/1M</span></div>')}</div>
        </div>
      </div>
      <div class="statusbar">
        <span class="sb-warn">${telescope.replace('width="22" height="22"', 'width="12" height="12"').replace(/#ccc/g, '#fff')} 3</span>
        <span>⎇ main</span><span style="margin-left:auto">Ln 9, Col 14&nbsp;&nbsp;UTF-8&nbsp;&nbsp;JavaScript</span>
      </div>
    </div>`),

  // B. inline review closeup
  'inline-review': scene(980, `
    <div class="window">
      <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
        <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">User.js</div>
      </div>
      ${editorCode(true)}
      <div class="statusbar"><span class="sb-warn">${telescope.replace('width="22" height="22"', 'width="12" height="12"').replace(/#ccc/g, '#fff')} 3</span><span style="color:var(--faint)">⌥⌘N next · ⌥⌘Y keep · ⌥⌘U undo</span></div>
    </div>`),

  // C. observations panel closeup
  'observations': scene(980, `
    <div class="window" style="padding-bottom:8px;">
      <div class="paneltabs"><span>TERMINAL</span><span class="on">CLAUDE OBSERVATORY</span></div>
      <div class="colhead" style="padding-top:10px;">OBSERVATIONS</div>
      ${observationsCol}
      <div class="hovercard" style="margin:10px 16px 8px 40px;width:430px;">
        <b>#1 created User.js</b><br>
        <span style="color:var(--dim)">💭 "I'll do the three operations in order. First, a quick check of the demo directory…"</span><br>
        <span style="color:var(--pending)">⚠ history: edits to this file get reverted often (3 of 5 verdicts)</span><br>
        <span style="color:var(--dim)">🧠 6 edits across sessions · 50% accepted · last reverted 2d ago</span>
      </div>
    </div>`),

  // D. stats panel closeup
  'stats': scene(760, `
    <div class="window" style="padding-bottom:10px;">
      <div class="paneltabs"><span>TERMINAL</span><span class="on">CLAUDE OBSERVATORY</span></div>
      <div class="colhead" style="padding-top:10px;">STATS</div>
      ${statsCol(56, 56)}
    </div>`),
};

// ---------- render ----------
const tmp = join(tmpdir(), 'obs-media');
mkdirSync(tmp, { recursive: true });
for (const [name, html] of Object.entries(scenes)) {
  const src = join(tmp, `${name}.html`);
  writeFileSync(src, html);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--default-background-color=00000000',
    '--force-device-scale-factor=2', '--hide-scrollbars',
    `--screenshot=${join(OUT, `${name}.png`)}`,
    `--window-size=${name === 'layout' ? '1568,830' : name === 'stats' ? '808,478' : name === 'inline-review' ? '1028,436' : '1028,344'}`,
    `file://${src}`,
  ], { stdio: 'pipe' });
  console.log('rendered', `${name}.png`);
}
rmSync(tmp, { recursive: true, force: true });
