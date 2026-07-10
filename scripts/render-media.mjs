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
    --blue:#4c8bf5; --purple:#9a6ac2; --orange:#c9713f; --accent:#4c8bf5; --coral:#cc785c;
    --hl:rgba(63,185,80,0.09); --hlborder:#cc785c; --delborder:#f85149; --delhl:rgba(248,81,73,0.09);
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
  /* deletion: red line highlight + bar with the removed line shown as red "ghost" text */
  .codeline.del { background:var(--delhl); box-shadow:inset 3px 0 0 var(--delborder); }
  .delnote { color:var(--delborder); font-style:italic; font-size:11.5px; margin-left:26px; }
  .codelens { font-size:11px; color:var(--dim); padding:2px 0 0 60px; font-family:-apple-system,sans-serif; }
  .codelens a { color:var(--dim); text-decoration:none; margin-right:15px; }
  .codelens a.why { font-style:italic; color:var(--faint); }
  .tok-k{color:#569cd6} .tok-f{color:#dcdcaa} .tok-s{color:#ce9178} .tok-c{color:#6a9955} .tok-v{color:#9cdcfe}
  .gutstar { color:var(--coral); font-size:11px; margin-right:6px; }
  /* inline review bubble — the comment-thread widget "view changes" opens, diff in git's colors */
  .bubble { margin:4px 0 8px 60px; border:1px solid var(--border2); border-radius:6px; background:#252526;
            overflow:hidden; max-width:900px; }
  .bb-head { display:flex; align-items:center; gap:14px; padding:8px 13px; background:var(--side);
             border-bottom:1px solid var(--border); font-size:12px; white-space:nowrap; }
  .bb-head .bb-title { color:var(--ink); }
  .bb-head .bb-id { color:var(--coral); font-family:'SF Mono',Menlo,monospace; }
  .bb-head .bb-why { color:var(--faint); font-style:italic; overflow:hidden; text-overflow:ellipsis; }
  .bb-tools { margin-left:auto; display:flex; gap:16px; white-space:nowrap; }
  .bb-tools span { color:var(--dim); font-size:12px; }
  .bb-diff { font-family:'SF Mono',Menlo,monospace; font-size:12px; line-height:1.7; padding:8px 0; }
  .bb-diff .dl { display:block; padding:0 13px; white-space:pre; }
  .bb-diff .add { background:rgba(63,185,80,0.15); color:#7ee787; }
  .bb-diff .rem { background:rgba(248,81,73,0.15); color:#ffa198; }
  .bb-diff .ctx { color:var(--dim); }
  .bb-diff .hunk { color:var(--blue); }
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
  /* review scoreboard (Stats) */
  .scoreboard { display:flex; gap:6px; margin:2px 16px 8px; }
  .sc { flex:1; text-align:center; border:1px solid var(--border); border-radius:6px; padding:6px 2px; }
  .scn { font-size:18px; font-weight:600; line-height:1.05; font-family:'SF Mono',Menlo,monospace; }
  .scl { font-size:8.5px; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); margin-top:2px; }
  .scmeta { display:flex; justify-content:space-between; font-size:9px; color:var(--dim); margin:5px 16px 0;
            font-family:'SF Mono',Menlo,monospace; }
  /* terminal (CLI + conflict scenes) — the terminal is a first-class front-end */
  .term { font-family:'SF Mono',Menlo,monospace; font-size:13px; line-height:1.9; padding:14px 20px; background:#141414; }
  .term .cmd { color:var(--ink); } .term .cmd .pr { color:var(--kept); margin-right:9px; } .term .cmd .fl { color:var(--blue); }
  .term .out { color:var(--dim); white-space:pre; } .term .ok { color:var(--kept); } .term .warn { color:var(--pending); }
  .term .id2 { color:var(--coral); } .term .add2 { color:#7ee787; } .term .rem2 { color:#ffa198; } .term .file2 { color:var(--ink); }
  .term .cursor { background:var(--ink); color:#141414; }
  /* file heatmap: dim every unmodified line so Claude's edits spotlight */
  .codeline.dim { opacity:.3; }
  .difftab { display:flex; align-items:center; background:var(--side); border-bottom:1px solid var(--border); }
  .difftab .tab { padding:8px 16px; background:var(--bg); border-right:1px solid var(--border); font-size:12.5px; }
  .difftab .acts { margin-left:auto; padding:0 14px; color:var(--dim); font-size:11.5px; }
  .difftab .acts span { margin-left:15px; }
`;

const scene = (w, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
   <body style="width:${w}px;padding:24px;">${body}</body></html>`;

const microscope = '🔬';

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

const editorCode = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    <div class="codelens"><a>✨ #2 +4 −0 view changes</a><a>✓ Keep</a><a>↩ Undo</a><a>💬 Chat</a><a>⧉ View diff</a></div>
    <div class="codeline"><span class="ln">5</span><span>  <span class="tok-f">greet</span>() {</span></div>
    <div class="codeline"><span class="ln">6</span><span>    <span class="tok-k">return</span> <span class="tok-s">\`Hello, my name is \${</span><span class="tok-v">this</span><span class="tok-s">.name}!\`</span>;</span></div>
    <div class="codeline"><span class="ln">7</span><span>  }</span></div>
    <div class="codeline hl"><span class="ln">8</span><span></span></div>
    <div class="codeline hl"><span class="ln">9</span><span class="gutstar">✨</span><span>  <span class="tok-f">farewell</span>() {</span></div>
    <div class="codeline hl"><span class="ln">10</span><span>    <span class="tok-k">return</span> <span class="tok-s">\`Goodbye from \${</span><span class="tok-v">this</span><span class="tok-s">.name}!\`</span>;</span></div>
    <div class="codeline hl"><span class="ln">11</span><span>  }</span></div>
    <div class="codeline"><span class="ln">12</span><span>}</span></div>
  </div>`;

// inline frame showing a single edit that BOTH adds (green) and deletes (red rule) — feature closeup
const editorCodeCombined = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    <div class="codelens"><a>✨ #5 +2 −4 view changes</a><a>✓ Keep</a><a>↩ Undo</a><a>💬 Chat</a><a>⧉ View diff</a></div>
    <div class="codeline"><span class="ln">2</span><span>  <span class="tok-f">constructor</span>(<span class="tok-v">name</span>) {</span></div>
    <div class="codeline"><span class="ln">3</span><span>    <span class="tok-v">this</span>.name = name;</span></div>
    <div class="codeline"><span class="ln">4</span><span>  }</span></div>
    <div class="codeline del"><span class="ln">5</span><span>}<span class="delnote">− greet() { …(+3)</span></span></div>
    <div class="codeline"><span class="ln">6</span><span></span></div>
    <div class="codeline hl"><span class="ln">7</span><span class="gutstar">✨</span><span><span class="tok-v">User</span>.role = <span class="tok-s">'member'</span>;</span></div>
    <div class="codeline"><span class="ln">8</span><span></span></div>
    <div class="codeline"><span class="ln">9</span><span><span class="tok-k">module</span>.exports = <span class="tok-v">User</span>;</span></div>
  </div>`;

// the inline review bubble that "view changes" opens at the edit (comment-thread widget): the diff in
// git's own colors + reasoning + counts in the body, Accept/Revert/Chat/Prev/Next on its toolbar
const dl = (kind, text) => `<span class="dl ${kind}">${text}</span>`;
const reviewBubble = () => `
  <div class="bubble">
    <div class="bb-head">
      <span class="bb-title">✨ Claude edit <span class="bb-id">#5</span></span>
      <span class="bb-id">+2 −4</span>
      <span class="bb-why">💭 dropped greet(); added a role field</span>
      <span class="bb-tools"><span>✓ Accept</span><span>↩ Revert</span><span>💬 Chat</span><span>↑ Prev</span><span>↓ Next</span></span>
    </div>
    <div class="bb-diff">
      ${dl('hunk', '@@ -2,9 +2,7 @@')}
      ${dl('ctx', '   constructor(name) {')}
      ${dl('ctx', '     this.name = name;')}
      ${dl('ctx', '   }')}
      ${dl('rem', '-  greet() {')}
      ${dl('rem', '-    return `Hello, my name is ${this.name}!`;')}
      ${dl('rem', '-  }')}
      ${dl('rem', '-')}
      ${dl('add', "+  User.role = 'member';")}
      ${dl('add', '+  User.active = true;')}
      ${dl('ctx', '     module.exports = User;')}
    </div>
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

// Live review scoreboard: pending / accepted / reverted counts + a progress bar (reviewed / total).
const reviewBoard = `
  <div class="scoreboard">
    <div class="sc"><div class="scn" style="color:var(--pending)">3</div><div class="scl">pending</div></div>
    <div class="sc"><div class="scn" style="color:var(--kept)">42</div><div class="scl">accepted</div></div>
    <div class="sc"><div class="scn" style="color:var(--reverted)">5</div><div class="scl">reverted</div></div>
  </div>
  <div class="track" style="margin:0 16px"><span class="fill" style="width:94%;background:var(--blue)"></span></div>
  <div class="scmeta"><span>47 of 50 reviewed (94%)</span><span>89% accepted</span></div>`;

const statsCol = (H1 = 52, H2 = 52) => `
  ${reviewBoard}
  <div style="border-top:1px solid var(--border);margin:10px 16px 6px"></div>
  <div class="seg"><div>Today</div><div class="on">7 days</div><div>30 days</div></div>
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

// the terminal front-end: status → list → surgical undo that preserves later edits
const terminalBody = () => `
  <div class="term">
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">status</span></div>
    <div class="out"><span class="ok">✓</span> hooks installed · session <span class="id2">0c396c6b</span> · <span class="warn">3 pending</span> · 42 kept · 5 reverted</div>
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">list --pending</span></div>
    <div class="out"><span class="file2">src/models/User.js</span></div>
    <div class="out">  <span class="warn">●</span> <span class="id2">#1</span>  <span class="add2">+11</span> <span class="rem2">−0</span>   Write   created the User class</div>
    <div class="out">  <span class="warn">●</span> <span class="id2">#2</span>  <span class="add2">+4</span>  <span class="rem2">−0</span>   Edit    added a farewell() method</div>
    <div class="out"><span class="file2">src/index.js</span></div>
    <div class="out">  <span class="warn">●</span> <span class="id2">#3</span>  <span class="add2">+4</span>  <span class="rem2">−0</span>   Write   import User + greet()</div>
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">diff 2</span></div>
    <div class="out"><span style="color:var(--blue)">@@ src/models/User.js  +4 −0 @@</span></div>
    <div class="out"><span class="add2">+  farewell() {</span></div>
    <div class="out"><span class="add2">+    return \`Goodbye from \${this.name}!\`;</span></div>
    <div class="out"><span class="add2">+  }</span></div>
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">undo 2</span></div>
    <div class="out"><span class="ok">↩</span> undone <span class="id2">#2</span> · later edits to User.js preserved (surgical 3-way merge)</div>
    <div class="cmd"><span class="pr">$</span><span class="cursor">&nbsp;</span></div>
  </div>`;

// conflict → --force fallback (position-anchored undo refuses to clobber overlapping edits)
const conflictBody = () => `
  <div class="term">
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">undo 1</span></div>
    <div class="out"><span class="warn">⚠ conflict</span> — edit <span class="id2">#1</span> overlaps later changes on the same lines; won't guess.</div>
    <div class="out">  Re-run with <span class="fl">--force</span> to restore the file to its pre-#1 state (drops the overlapping later edits).</div>
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">undo 1 --force</span></div>
    <div class="out"><span class="ok">↩</span> restored src/models/User.js · <span class="id2">#1</span> reverted</div>
    <div class="cmd"><span class="pr">$</span><span class="cursor">&nbsp;</span></div>
  </div>`;

// a single edit opened as its own full diff tab (the Diffs surface), git colors, title-bar Prev/Next
const diffTabBody = () => `
  <div class="difftab">
    <div class="tab">User.js  ⟷  Claude #2</div>
    <div class="acts"><span>⧉ #2 +4 −0</span><span>✓ Keep</span><span>↩ Undo</span><span>💬 Chat</span><span>↑ Prev</span><span>↓ Next</span></div>
  </div>
  <div class="bb-diff" style="background:var(--bg);padding:12px 0;font-size:12.5px;line-height:1.85;">
    ${dl('hunk', '@@ -4,4 +4,8 @@ class User')}
    ${dl('ctx', '     this.name = name;')}
    ${dl('ctx', '   }')}
    ${dl('add', '+  farewell() {')}
    ${dl('add', '+    return `Goodbye from ${this.name}!`;')}
    ${dl('add', '+  }')}
    ${dl('add', '+')}
    ${dl('ctx', '   greet() {')}
  </div>`;

// file heatmap — unmodified lines dimmed so the edit is a spotlight (📄 toggle)
const heatmapEditor = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    <div class="codelens"><a>✨ #2 +4 −0 view changes</a><a>✓ Keep</a><a>↩ Undo</a><a>💬 Chat</a><a>⧉ View diff</a><a style="color:var(--coral)">📄 Heatmap</a></div>
    <div class="codeline dim"><span class="ln">1</span><span><span class="tok-k">class</span> <span class="tok-v">User</span> {</span></div>
    <div class="codeline dim"><span class="ln">2</span><span>  <span class="tok-f">constructor</span>(<span class="tok-v">name</span>) { <span class="tok-v">this</span>.name = name; }</span></div>
    <div class="codeline dim"><span class="ln">3</span><span>  <span class="tok-f">greet</span>() { <span class="tok-k">return</span> <span class="tok-s">\`Hi \${this.name}\`</span>; }</span></div>
    <div class="codeline dim"><span class="ln">4</span><span></span></div>
    <div class="codeline hl"><span class="ln">5</span><span class="gutstar">✨</span><span>  <span class="tok-f">farewell</span>() {</span></div>
    <div class="codeline hl"><span class="ln">6</span><span>    <span class="tok-k">return</span> <span class="tok-s">\`Goodbye from \${</span><span class="tok-v">this</span><span class="tok-s">.name}!\`</span>;</span></div>
    <div class="codeline hl"><span class="ln">7</span><span>  }</span></div>
    <div class="codeline dim"><span class="ln">8</span><span>}</span></div>
    <div class="codeline dim"><span class="ln">9</span><span><span class="tok-k">module</span>.exports = <span class="tok-v">User</span>;</span></div>
  </div>`;

// File History — a flat, chronological list of just the active file's edits (follows the editor)
const fileHistoryCol = `
  <div class="obsrow"><span class="dot" style="background:var(--pending)"></span><span class="id mono">#2</span><span class="r">14:02 · +4 −0 · <span style="color:var(--pending)">pending</span> · added a farewell() method to mirror greet()</span></div>
  <div class="obsrow"><span class="dot" style="background:var(--kept)"></span><span class="id mono strike">#1</span><span class="r strike">14:01 · +11 −0 · kept · created the User class</span></div>`;

// ---------- scenes ----------
const scenes = {
  // A. the full observatory layout
  'layout': scene(1520, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — Visual Studio Code</span></div>
      <div class="row" style="align-items:stretch; height:472px;">
        <div style="width:48px;background:var(--side);border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding-top:12px;gap:20px;">
          <span style="opacity:.4">🗎</span><span style="opacity:.4">🔍</span>
          <span style="position:relative;font-size:18px">${microscope}<span style="position:absolute;right:-7px;bottom:-5px;background:var(--accent);color:#fff;border-radius:8px;font-size:9px;padding:0 4px;">3</span></span>
          <span style="opacity:.4">⚙</span>
        </div>
        <div style="width:300px;background:var(--side);border-right:1px solid var(--border);">
          <div style="padding:10px 14px 2px;font-size:11px;color:var(--dim);letter-spacing:.06em;">CLAUDE OBSERVATORY</div>
          ${editsTree}
          <div class="viewhead" style="border-top:1px solid var(--border);margin-top:8px;">DIFFS</div>
          <div class="viewhead" style="border-top:1px solid var(--border);">FILE HISTORY <span style="float:right;color:var(--faint)">User.js</span></div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;">
          <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
            <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">User.js</div>
          </div>
          ${editorCode()}
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
        <span class="sb-warn">${microscope} 3</span>
        <span>⎇ main</span><span style="margin-left:auto">Ln 9, Col 14&nbsp;&nbsp;UTF-8&nbsp;&nbsp;JavaScript</span>
      </div>
    </div>`),

  // B. inline review closeup
  'inline-review': scene(980, `
    <div class="window">
      <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
        <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">User.js</div>
      </div>
      ${editorCodeCombined()}
      ${reviewBubble()}
      <div class="statusbar"><span class="sb-warn">${microscope} 3</span><span style="color:var(--faint)">⌥⌘N next · ⌥⌘Y keep · ⌥⌘U undo · ⌥⌘[ / ⌥⌘] revisions</span></div>
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

  // E. the terminal front-end — status, list, surgical undo
  'cli': scene(900, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — claude-observatory</span></div>
      ${terminalBody()}
    </div>`),

  // F. surgical-undo conflict → --force fallback
  'conflict': scene(880, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — claude-observatory</span></div>
      ${conflictBody()}
    </div>`),

  // G. one edit as its own diff tab (the Diffs surface)
  'diffs': scene(980, `
    <div class="window">
      ${diffTabBody()}
      <div class="statusbar"><span class="sb-warn">${microscope} 3</span><span style="color:var(--faint)">Diffs — click any edit in the tree for its before ⟷ after</span></div>
    </div>`),

  // H. file heatmap spotlight
  'heatmap': scene(980, `
    <div class="window">
      <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
        <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">User.js</div>
      </div>
      ${heatmapEditor()}
      <div class="statusbar"><span class="sb-warn">${microscope} 3</span><span style="color:var(--faint)">📄 Heatmap on — every unmodified line dimmed</span></div>
    </div>`),

  // I. File History — the active file's edits, chronological, follows the editor
  'file-history': scene(720, `
    <div class="window" style="padding-bottom:8px;">
      <div class="viewhead" style="padding-top:12px;">FILE HISTORY <span style="float:right;color:var(--faint)">User.js</span></div>
      ${fileHistoryCol}
    </div>`),

  // J. standalone Timeline — files by recent activity, runs coalesced
  'timeline': scene(720, `
    <div class="window" style="padding-bottom:8px;">
      <div class="paneltabs"><span>TERMINAL</span><span class="on">CLAUDE OBSERVATORY</span></div>
      <div class="colhead" style="padding-top:10px;">TIMELINE</div>
      ${timelineCol}
    </div>`),
};

// ---------- render ----------
// per-scene capture viewport (width = sceneW + 48px body padding; height tuned to content)
const SIZE = {
  layout: '1568,830', stats: '808,478', 'inline-review': '1028,720', observations: '1028,344',
  cli: '948,500', conflict: '928,290', diffs: '1028,330', heatmap: '1028,400',
  'file-history': '768,150', timeline: '768,230',
};
const tmp = join(tmpdir(), 'obs-media');
mkdirSync(tmp, { recursive: true });
for (const [name, html] of Object.entries(scenes)) {
  const src = join(tmp, `${name}.html`);
  writeFileSync(src, html);
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--default-background-color=00000000',
    '--force-device-scale-factor=2', '--hide-scrollbars',
    `--screenshot=${join(OUT, `${name}.png`)}`,
    `--window-size=${SIZE[name] || '1028,344'}`,
    `file://${src}`,
  ], { stdio: 'pipe' });
  console.log('rendered', `${name}.png`);
}

// Full-window mockups authored as standalone .src.html (their own PyCharm/JetBrains New-UI styling,
// which the shared VS Code scene bits above don't cover). Each sets its own 1568x830 body size.
for (const name of ['pyc-layout']) {
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--default-background-color=00000000',
    '--force-device-scale-factor=2', '--hide-scrollbars',
    `--screenshot=${join(OUT, `${name}.png`)}`,
    '--window-size=1568,830',
    `file://${join(OUT, `${name}.src.html`)}`,
  ], { stdio: 'pipe' });
  console.log('rendered', `${name}.png`);
}
rmSync(tmp, { recursive: true, force: true });
