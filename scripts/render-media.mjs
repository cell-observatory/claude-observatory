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
  <div class="trow" style="padding-left:26px"><span class="tw">▾</span><span class="ic">📄</span>features.py<span class="meta">1 edit · 1 pending</span></div>
  <div class="trow mono" style="padding-left:60px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#1&nbsp; +6 −1<span class="meta"><span class="pill p-pending">pending</span></span></div>
  <div class="trow" style="padding-left:26px"><span class="tw">▾</span><span class="ic">📄</span>train.py<span class="meta">1 edit · 1 pending</span></div>
  <div class="trow mono" style="padding-left:60px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#2&nbsp; +3 −2<span class="meta"><span class="pill p-pending">pending</span></span></div>
  <div class="trow" style="padding-left:26px"><span class="tw">▾</span><span class="ic">📁</span>models</div>
  <div class="trow" style="padding-left:42px"><span class="tw">▾</span><span class="ic">📄</span>dataset.py<span class="meta">1 edit · 1 pending</span></div>
  <div class="trow" style="padding-left:58px"><span class="tw">▾</span><span class="ic" style="color:var(--orange)">◆</span>class Dataset<span class="meta">1 edit · 1 pending</span></div>
  <div class="trow mono" style="padding-left:76px"><span class="dot" style="background:var(--pending)"></span>&nbsp;#3&nbsp; +7 −0<span class="meta"><span class="pill p-pending">pending</span></span></div>`;

const editorCode = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    <div class="codelens"><a>✨ #1 +6 −1 view changes</a><a>✓ Keep</a><a>↩ Undo</a><a>💬 Chat</a><a>⧉ View diff</a></div>
    <div class="codeline hl"><span class="ln">1</span><span><span class="tok-k">from</span> <span class="tok-v">statistics</span> <span class="tok-k">import</span> <span class="tok-v">mean</span>, <span class="tok-v">stdev</span></span></div>
    <div class="codeline"><span class="ln">2</span><span></span></div>
    <div class="codeline"><span class="ln">3</span><span></span></div>
    <div class="codeline"><span class="ln">4</span><span><span class="tok-k">def</span> <span class="tok-f">summarize</span>(<span class="tok-v">values</span>):</span></div>
    <div class="codeline"><span class="ln">5</span><span>    <span class="tok-k">return</span> {<span class="tok-s">"count"</span>: <span class="tok-f">len</span>(values), <span class="tok-s">"mean"</span>: <span class="tok-f">mean</span>(values)}</span></div>
    <div class="codeline"><span class="ln">6</span><span></span></div>
    <div class="codeline hl"><span class="ln">7</span><span></span></div>
    <div class="codeline hl"><span class="ln">8</span><span class="gutstar">✨</span><span><span class="tok-k">def</span> <span class="tok-f">scale</span>(<span class="tok-v">values</span>):</span></div>
    <div class="codeline hl"><span class="ln">9</span><span>    mu, sigma = <span class="tok-f">mean</span>(values), <span class="tok-f">stdev</span>(values)</span></div>
    <div class="codeline hl"><span class="ln">10</span><span>    <span class="tok-k">return</span> [(v - mu) / sigma <span class="tok-k">for</span> v <span class="tok-k">in</span> values]</span></div>
  </div>`;

// inline frame showing a single edit that BOTH adds (green) and deletes (red rule) — feature closeup
const editorCodeCombined = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    <div class="codelens"><a>✨ #2 +3 −2 view changes</a><a>✓ Keep</a><a>↩ Undo</a><a>💬 Chat</a><a>⧉ View diff</a></div>
    <div class="codeline hl"><span class="ln">1</span><span class="gutstar">✨</span><span><span class="tok-k">from</span> <span class="tok-v">features</span> <span class="tok-k">import</span> <span class="tok-v">summarize</span>, <span class="tok-v">scale</span></span></div>
    <div class="codeline"><span class="ln">2</span><span></span></div>
    <div class="codeline hl"><span class="ln">3</span><span>features = <span class="tok-f">scale</span>([<span class="tok-v">1.0</span>, <span class="tok-v">2.0</span>, <span class="tok-v">3.0</span>])</span></div>
    <div class="codeline del"><span class="ln">4</span><span><span class="tok-f">print</span>(<span class="tok-f">summarize</span>(features))<span class="delnote">− print(summarize([1.0, 2.0, 3.0]))</span></span></div>
  </div>`;

// the inline review bubble that "view changes" opens at the edit (comment-thread widget): the diff in
// git's own colors + reasoning + counts in the body, Accept/Revert/Chat/Prev/Next on its toolbar
const dl = (kind, text) => `<span class="dl ${kind}">${text}</span>`;
const reviewBubble = () => `
  <div class="bubble">
    <div class="bb-head">
      <span class="bb-title">✨ Claude edit <span class="bb-id">#2</span></span>
      <span class="bb-id">+3 −2</span>
      <span class="bb-why">💭 scaling the features in the training entrypoint before they reach the model</span>
      <span class="bb-tools"><span>✓ Accept</span><span>↩ Revert</span><span>💬 Chat</span><span>↑ Prev</span><span>↓ Next</span></span>
    </div>
    <div class="bb-diff">
      ${dl('hunk', '@@ -1,3 +1,4 @@')}
      ${dl('rem', '-from features import summarize')}
      ${dl('add', '+from features import summarize, scale')}
      ${dl('ctx', ' ')}
      ${dl('rem', '-print(summarize([1.0, 2.0, 3.0]))')}
      ${dl('add', '+features = scale([1.0, 2.0, 3.0])')}
      ${dl('add', '+print(summarize(features))')}
    </div>
  </div>`;

const observationsCol = `
  <div class="obsrow"><span>🧭</span><span class="id" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Pipeline: scaling, validation, tests</span><span class="r" style="flex:none">session recap</span></div>
  <div class="obsrow"><span class="dot" style="background:var(--pending)"></span><span class="id mono">features.py</span><span class="r">14:02 · +6 −1 · change-feed (Timeline folded in)</span></div>
  <div class="obsrow"><span style="color:var(--dim)">👁</span><span class="id">#3</span><span class="r">edited dataset.py (+7 −0) — "Adding Dataset.validate() — matching feature/label lengths…"</span></div>
  <div class="obsrow"><span style="color:var(--dim)">👁</span><span class="id">#2</span><span class="r">edited train.py (+3 −2) — "Scaling the features in the training entrypoint…"</span></div>
  <div class="obsrow"><span style="color:var(--pending)">⚠</span><span class="id">#1</span><span class="r">edited features.py — 🧠 6 edits across sessions · 50% accepted</span></div>`;

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

// Actions — every tool call this session, as collapsed category groups (moved into the sidebar in 0.8.0);
// Fleet + Subagents graduated to Overview. Egress node + the ⚠-error styling on Commands stay.
const actionsCol = `
  <div class="obsrow"><span>⇅</span><span class="id">Egress</span><span class="r">3 destinations · 3 remote</span></div>
  <div class="obsrow"><span>▸</span><span class="id">Edits</span><span class="r">185</span></div>
  <div class="obsrow"><span>▸</span><span class="id">Commands</span><span class="r"><span style="color:var(--pending)">⚠ 229 · 2 errors</span></span></div>
  <div class="obsrow"><span>▸</span><span class="id">Reads</span><span class="r">142</span></div>
  <div class="obsrow"><span>▸</span><span class="id">Searches</span><span class="r">57</span></div>
  <div class="obsrow"><span>▸</span><span class="id">To-dos</span><span class="r">30</span></div>`;

// Change Map — chapters on top, an equal-width module strip, then files ranked by churn
const cmChapter = (glyph, color, name) => `<span style="white-space:nowrap"><span style="color:${color}">${glyph}</span> ${name}</span>`;
const cmSeg = (color, name) => `<span style="flex:1;min-width:0;background:${color};box-shadow:inset 1px 0 0 var(--panel);display:flex;align-items:center;justify-content:center;font-size:9px;color:rgba(0,0,0,.78);font-weight:600;overflow:hidden">${name}</span>`;
const cmRow = (color, file, mod, barPct, num, pend) => `
  <div style="display:flex;align-items:center;gap:8px;font-size:11.5px;padding:2.5px 0">
    <span style="width:6px;height:6px;border-radius:2px;background:${color};flex:none"></span>
    <span class="mono" style="color:var(--ink);flex:0 1 auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:60px;max-width:44%">${file}</span>
    <span style="font-size:9px;color:var(--faint);flex:none">${mod}</span>
    <span style="flex:1;height:5px;border-radius:2px;background:var(--panel);overflow:hidden;min-width:16px"><span style="display:block;height:100%;width:${barPct}%;background:${color}"></span></span>
    <span class="mono" style="font-size:10px;color:var(--faint);width:40px;text-align:right;flex:none">${num}</span>
    <span class="mono" style="font-size:10px;width:26px;text-align:right;flex:none;color:${pend ? 'var(--pending)' : 'var(--kept)'}">${pend || '✓'}</span>
  </div>`;

// the terminal front-end: status → list → surgical undo that preserves later edits
const terminalBody = () => `
  <div class="term">
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">status</span></div>
    <div class="out"><span class="ok">✓</span> hooks installed · session <span class="id2">0c396c6b</span> · <span class="warn">3 pending</span> · 42 kept · 5 reverted</div>
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">list --pending</span></div>
    <div class="out"><span class="file2">src/features.py</span></div>
    <div class="out">  <span class="warn">●</span> <span class="id2">#1</span>  <span class="add2">+6</span>  <span class="rem2">−1</span>   Edit    added scale() — z-score standardization</div>
    <div class="out"><span class="file2">src/train.py</span></div>
    <div class="out">  <span class="warn">●</span> <span class="id2">#2</span>  <span class="add2">+3</span>  <span class="rem2">−2</span>   Edit    scaled the features in the entrypoint</div>
    <div class="out"><span class="file2">src/models/dataset.py</span></div>
    <div class="out">  <span class="warn">●</span> <span class="id2">#3</span>  <span class="add2">+7</span>  <span class="rem2">−0</span>   Edit    added Dataset.validate()</div>
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">diff 2</span></div>
    <div class="out"><span style="color:var(--blue)">@@ src/train.py  +3 −2 @@</span></div>
    <div class="out"><span class="rem2">-from features import summarize</span></div>
    <div class="out"><span class="add2">+from features import summarize, scale</span></div>
    <div class="out"><span class="add2">+features = scale([1.0, 2.0, 3.0])</span></div>
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">undo 2</span></div>
    <div class="out"><span class="ok">↩</span> undone <span class="id2">#2</span> · later edits to train.py preserved (surgical 3-way merge)</div>
    <div class="cmd"><span class="pr">$</span><span class="cursor">&nbsp;</span></div>
  </div>`;

// conflict → --force fallback (position-anchored undo refuses to clobber overlapping edits)
const conflictBody = () => `
  <div class="term">
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">undo 1</span></div>
    <div class="out"><span class="warn">⚠ conflict</span> — edit <span class="id2">#1</span> overlaps later changes on the same lines; won't guess.</div>
    <div class="out">  Re-run with <span class="fl">--force</span> to restore the file to its pre-#1 state (drops the overlapping later edits).</div>
    <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">undo 1 --force</span></div>
    <div class="out"><span class="ok">↩</span> restored src/features.py · <span class="id2">#1</span> reverted</div>
    <div class="cmd"><span class="pr">$</span><span class="cursor">&nbsp;</span></div>
  </div>`;

// a single edit opened as its own full diff tab (the Diffs surface), git colors, title-bar Prev/Next
const diffTabBody = () => `
  <div class="difftab">
    <div class="tab">train.py  ⟷  Claude #2</div>
    <div class="acts"><span>⧉ #2 +3 −2</span><span>✓ Keep</span><span>↩ Undo</span><span>💬 Chat</span><span>↑ Prev</span><span>↓ Next</span></div>
  </div>
  <div class="bb-diff" style="background:var(--bg);padding:12px 0;font-size:12.5px;line-height:1.85;">
    ${dl('hunk', '@@ -1,3 +1,4 @@')}
    ${dl('rem', '-from features import summarize')}
    ${dl('add', '+from features import summarize, scale')}
    ${dl('ctx', ' ')}
    ${dl('rem', '-print(summarize([1.0, 2.0, 3.0]))')}
    ${dl('add', '+features = scale([1.0, 2.0, 3.0])')}
    ${dl('add', '+print(summarize(features))')}
  </div>`;

// file heatmap — unmodified lines dimmed so the edit is a spotlight (📄 toggle)
const heatmapEditor = () => `
  <div style="background:var(--bg);padding:10px 0 14px;">
    <div class="codelens"><a>✨ #1 +6 −1 view changes</a><a>✓ Keep</a><a>↩ Undo</a><a>💬 Chat</a><a>⧉ View diff</a><a style="color:var(--coral)">📄 Heatmap</a></div>
    <div class="codeline hl"><span class="ln">1</span><span><span class="tok-k">from</span> <span class="tok-v">statistics</span> <span class="tok-k">import</span> <span class="tok-v">mean</span>, <span class="tok-v">stdev</span></span></div>
    <div class="codeline dim"><span class="ln">2</span><span></span></div>
    <div class="codeline dim"><span class="ln">3</span><span></span></div>
    <div class="codeline dim"><span class="ln">4</span><span><span class="tok-k">def</span> <span class="tok-f">summarize</span>(<span class="tok-v">values</span>):</span></div>
    <div class="codeline dim"><span class="ln">5</span><span>    <span class="tok-k">return</span> {<span class="tok-s">"count"</span>: <span class="tok-f">len</span>(values), <span class="tok-s">"mean"</span>: <span class="tok-f">mean</span>(values)}</span></div>
    <div class="codeline dim"><span class="ln">6</span><span></span></div>
    <div class="codeline hl"><span class="ln">7</span><span></span></div>
    <div class="codeline hl"><span class="ln">8</span><span class="gutstar">✨</span><span><span class="tok-k">def</span> <span class="tok-f">scale</span>(<span class="tok-v">values</span>):</span></div>
    <div class="codeline hl"><span class="ln">9</span><span>    mu, sigma = <span class="tok-f">mean</span>(values), <span class="tok-f">stdev</span>(values)</span></div>
    <div class="codeline hl"><span class="ln">10</span><span>    <span class="tok-k">return</span> [(v - mu) / sigma <span class="tok-k">for</span> v <span class="tok-k">in</span> values]</span></div>
  </div>`;

// File History — a flat, chronological list of just the active file's edits (follows the editor)
const fileHistoryCol = `
  <div class="obsrow"><span class="dot" style="background:var(--pending)"></span><span class="id mono">#1</span><span class="r">14:02 · +6 −1 · <span style="color:var(--pending)">pending</span> · added scale() — z-score standardization</span></div>`;

// A numbered annotation pin (a coral circle) + a callout label, absolutely placed over a mockup.
const pin = (n, x, y) => `<span style="position:absolute;left:${x};top:${y};width:20px;height:20px;border-radius:50%;background:var(--coral);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;font-family:-apple-system,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.5);z-index:3">${n}</span>`;
const note = (n, name, desc) => `<div style="display:flex;gap:9px;align-items:flex-start"><span style="flex:none;width:19px;height:19px;border-radius:50%;background:var(--coral);color:#fff;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center">${n}</span><div style="font-size:12.5px;line-height:1.45"><b style="color:var(--ink)">${name}</b> <span style="color:var(--dim)">— ${desc}</span></div></div>`;
// A coral corner-label for the master map — outlines a region without shifting layout (inset shadow).
const clabel = (text) => `<span style="position:absolute;top:-8px;left:9px;background:var(--coral);color:#fff;font-size:9px;font-weight:700;letter-spacing:.04em;padding:1.5px 7px;border-radius:4px;z-index:5;white-space:nowrap;">${text}</span>`;
// A pane header chip — sits fully INSIDE the pane (the tab row is directly above, so it can't straddle
// upward like clabel does). Doubles as the pane's name, replacing the gray colhead.
const plabel = (text) => `<span style="position:absolute;top:7px;left:12px;background:var(--coral);color:#fff;font-size:9px;font-weight:700;letter-spacing:.05em;padding:2px 8px;border-radius:4px;z-index:5;white-space:nowrap;">${text}</span>`;
// One labelled panel-pane for the master map: coral outline + inside header chip + clipped content.
const mapPane = (flex, name, content, last) => `<div class="col" style="position:relative;flex:${flex};${last ? '' : 'border-right:1px solid var(--border);'}box-shadow:inset 0 0 0 2px var(--coral);padding-top:32px;">${plabel(name)}${content}</div>`;
// A per-window diagram: the real panel mockup in a titled frame (left) + a numbered legend (right).
const winDiag = (title, mock, notes) => `
  <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:26px;align-items:start;font-family:-apple-system,'Segoe UI',sans-serif;">
    <div style="border:1px solid var(--border2);border-radius:10px;overflow:hidden;background:var(--bg);box-shadow:0 12px 40px -18px rgba(0,0,0,.6);">
      <div style="background:var(--panel);border-bottom:1px solid var(--border);padding:8px 15px;font-size:10.5px;letter-spacing:.09em;color:var(--coral);font-weight:700;">${title}</div>
      <div style="padding:8px 0;">${mock}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:13px;padding-top:4px;">${notes}</div>
  </div>`;

// ---------- 0.8.0: multitasking + per-agent overview tabs ----------
// Phase badge — colored by agent state (working blue · awaiting orange · errored red · done green · idle grey).
const phase = (label, color) => `<span style="font-size:9px;font-weight:700;letter-spacing:.02em;padding:1.5px 7px;border-radius:9px;color:${color};border:1px solid ${color};white-space:nowrap;text-transform:uppercase">${label}</span>`;
// A tiny activity sparkline (bars), like the real per-agent one.
const spark = (bars, color) => `<span style="display:inline-flex;align-items:flex-end;gap:1.5px;height:13px">${bars.map(h => `<span style="width:2.5px;height:${Math.max(2, Math.round(h * 13))}px;background:${color};border-radius:1px"></span>`).join('')}</span>`;
const gADD = '#7ee787', gREM = '#ffa198';
// A compact fleet row for the Overview's LEFT master rail: phase dot · worktree ⑂branch · sparkline.
const cmFleetRow = (dot, name, branch, bars, sel) => `
  <div style="display:flex;align-items:center;gap:7px;font-size:11px;padding:3px 0${sel ? ';box-shadow:inset 2px 0 0 var(--accent);background:var(--hl)' : ''}">
    <span class="dot" style="background:${dot};flex:none"></span>
    <span class="mono" style="color:${sel ? 'var(--ink)' : 'var(--dim)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto">${name} <span style="color:var(--faint)">⑂${branch}</span></span>
    <span style="margin-left:auto;flex:none">${spark(bars, dot)}</span>
  </div>`;
// Overview (formerly Change Map) — now MASTER-DETAIL: a thin left rail (Fleet · Workflows tabs + a few
// agent rows) feeds the right change-map detail (chapter ribbon + module strip + churn-ranked ledger).
const changeMapCol = `
  <div style="display:flex;align-items:stretch">
    <div style="flex:0 0 36%;min-width:0;padding:2px 12px 8px 16px;border-right:1px solid var(--border)">
      <div style="display:flex;gap:11px;font-size:9.5px;letter-spacing:.04em;margin-bottom:6px">
        <span style="color:var(--ink);border-bottom:1.5px solid var(--accent);padding-bottom:3px">Fleet</span>
        <span style="color:var(--faint)">Workflows</span>
      </div>
      ${cmFleetRow('var(--blue)', 'demo', 'demo/pipeline', [.3, .6, .4, .8, .5, .9, .7, 1], true)}
      ${cmFleetRow('var(--pending)', 'demo', 'feat-x', [.5, .7, .3, .6, .8, .4, .6, .5], false)}
      ${cmFleetRow('var(--kept)', 'demo', 'hotfix', [.4, .8, .6, .3, .7, .5, .2, .4], false)}
    </div>
    <div style="flex:1;min-width:0;padding:2px 16px 8px 14px">
      <div style="display:flex;gap:9px;font-size:10px;color:var(--dim);margin-bottom:8px;flex-wrap:wrap">
        ${cmChapter('●', 'var(--kept)', '1 Feature scaling')}${cmChapter('◐', 'var(--pending)', '2 Dataset validation')}${cmChapter('○', 'var(--faint)', '3 Tests and docs')}
      </div>
      <div style="display:flex;height:16px;border-radius:3px;overflow:hidden;margin-bottom:9px">
        ${cmSeg('var(--kept)', 'docs')}${cmSeg('var(--pending)', 'tests')}${cmSeg('var(--pending)', 'src')}${cmSeg('var(--kept)', 'src/models')}
      </div>
      ${cmRow('var(--kept)', 'USAGE.md', 'docs', 100, '+12', '')}
      ${cmRow('var(--pending)', 'test_pipeline.py', 'tests', 96, '+12', '1⏳')}
      ${cmRow('var(--kept)', 'dataset.py', 'src/models', 58, '+7', '')}
      ${cmRow('var(--pending)', 'features.py', 'src', 55, '+6', '1⏳')}
    </div>
  </div>`;
// One agent (worktree) row: badge · worktree ⑂branch · self tag · sparkline · ± · ⚠risk · ⇄collisions.
const agentRow = (badge, name, branch, self, bars, sparkColor, added, removed, risk, coll) => `
  <div style="display:flex;align-items:center;gap:9px;padding:7px 16px;font-size:12.5px">
    ${badge}
    <span class="mono" style="color:var(--ink)">${name}</span>
    <span class="mono" style="color:var(--dim);font-size:11.5px">⑂${branch}</span>
    ${self ? `<span style="font-size:8.5px;font-weight:700;color:var(--coral);border:1px solid var(--coral);border-radius:8px;padding:0 6px">self</span>` : ''}
    <span style="margin-left:auto;display:flex;align-items:center;gap:13px">
      ${spark(bars, sparkColor)}
      <span class="mono" style="font-size:11px;white-space:nowrap"><span style="color:${gADD}">+${added}</span> <span style="color:${gREM}">−${removed}</span></span>
      ${risk != null ? `<span style="font-size:11px;color:var(--pending);white-space:nowrap">⚠ ${risk}</span>` : ''}
      ${coll != null ? `<span style="font-size:11px;color:var(--dim);white-space:nowrap">⇄ ${coll}</span>` : ''}
    </span>
  </div>`;
// A nested subagent row under an agent: badge · agentType + italic description · current task · ± · 💬.
const subRow = (badge, type, desc, task, added, removed) => `
  <div style="display:flex;align-items:center;gap:8px;padding:4px 16px 4px 42px;font-size:11.5px">
    <span style="color:var(--faint)">└</span>
    ${badge}
    <span style="color:var(--purple);white-space:nowrap">${type}</span>
    <span style="color:var(--faint);font-style:italic;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto">${desc}</span>
    <span style="color:var(--dim);font-size:10.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto">${task}</span>
    <span style="margin-left:auto;display:flex;align-items:center;gap:11px;white-space:nowrap">
      <span class="mono" style="font-size:10.5px"><span style="color:${gADD}">+${added}</span> <span style="color:${gREM}">−${removed}</span></span>
      <span style="color:var(--dim)">💬</span>
    </span>
  </div>`;
// The FILE COLLISIONS strip — files touched by more than one agent, with agent count + pending state.
const collisionStrip = `
  <div style="border-top:1px solid var(--border);margin-top:6px;padding:9px 16px 5px">
    <div style="font-size:10px;letter-spacing:.08em;color:var(--dim);font-weight:600;margin-bottom:7px">FILE COLLISIONS (1)</div>
    <div style="display:flex;align-items:center;gap:9px;font-size:11.5px;padding:2px 0">
      <span style="color:var(--pending)">⇄</span>
      <span class="mono" style="color:var(--ink)">src/models/dataset.py</span>
      <span style="margin-left:auto;display:flex;gap:11px;align-items:center;color:var(--dim);font-size:11px">
        <span>2 agents</span><span class="pill p-pending">pending</span>
      </span>
    </div>
  </div>`;
// The Overview's Fleet tab — every agent (worktree) in this project, its subagents, and the collisions
// strip (0.8.0: folded in from the old Multitasking window; header is now the Fleet · Workflows nav).
const multitaskingBody = `
  <div style="display:flex;align-items:center;gap:14px;padding:9px 16px 0;border-bottom:1px solid var(--border);font-size:12px">
    <span style="color:var(--ink);border-bottom:1.5px solid var(--accent);padding-bottom:8px">Fleet</span>
    <span style="color:var(--faint);padding-bottom:8px">Workflows</span>
    <span style="color:var(--faint)">·</span><span style="color:var(--dim)">3 agents</span>
    <span style="color:var(--blue)">1 active</span>
    <span style="color:var(--pending)">1 conflict</span>
    <span style="margin-left:auto;display:flex;gap:14px;color:var(--faint);font-size:11px;padding-bottom:8px"><span>Active only</span><span>Clear completed</span></span>
  </div>
  ${agentRow(phase('working', 'var(--blue)'), 'demo', 'main', true, [.3, .6, .4, .8, .5, .9, .7, 1], 'var(--blue)', 15, 0, 1, 1)}
  ${subRow(phase('working', 'var(--blue)'), 'Explore', 'maps the models layer', 'reading src/models/*.py', 0, 0)}
  ${subRow(phase('done', 'var(--kept)'), 'Explore', 'audits the import graph', '12 files scanned', 0, 0)}
  ${agentRow(phase('awaiting', 'var(--pending)'), 'demo-feat-x', 'feat-x', false, [.5, .7, .3, .6, .8, .4, .6, .5], 'var(--pending)', 42, 7, 2, 1)}
  ${agentRow(phase('done', 'var(--kept)'), 'demo-hotfix', 'hotfix', false, [.4, .8, .6, .3, .7, .5, .2, .4], 'var(--kept)', 6, 0, null, null)}
  ${collisionStrip}`;

// A task-ribbon pill — a status dot + label + ±delta (0.8.0 redesign: labelled wrapping pills, with
// completed tasks collapsed behind a "N done" toggle, so many chapters stay readable).
const taskPill = (label, delta, color, dashed) =>
  `<span style="display:inline-flex;align-items:center;gap:6px;max-width:210px;background:var(--side);border:1px ${dashed ? 'dashed' : 'solid'} var(--border2);border-radius:99px;padding:3px 10px;font-size:12px;white-space:nowrap;overflow:hidden">` +
  `<span style="width:9px;height:9px;border-radius:50%;background:${color};flex:none"></span>` +
  `<span style="color:var(--dim);overflow:hidden;text-overflow:ellipsis">${label}</span>` +
  (delta ? `<span class="mono" style="color:var(--faint);font-size:10px;flex:none">${delta}</span>` : '') + `</span>`;
// One vertical chapter row (the JetBrains-style ribbon): status glyph · title · ± · pending · actions.
// `actable` gates the ✓/↩/🧹 buttons; `synthetic` renders the dimmed display-only session chapter.
const chapterRow = (glyph, color, title, delta, pending, actable, synthetic) => `
  <div style="display:flex;align-items:center;gap:9px;padding:5px 16px;font-size:12px${synthetic ? ';opacity:.62' : ''}">
    <span style="color:${color};flex:none">${glyph}</span>
    <span style="color:var(--${synthetic ? 'faint' : 'ink'});white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</span>
    ${synthetic ? '<span style="font-size:9.5px;color:var(--faint);border:1px solid var(--border2);border-radius:8px;padding:0 6px;flex:none">session</span>' : ''}
    <span class="mono" style="margin-left:auto;color:var(--faint);font-size:10.5px;flex:none">${delta}${pending ? ` · <span style="color:var(--pending)">${pending}</span>` : ''}</span>
    ${actable ? `<span style="display:flex;gap:8px;font-size:11.5px;flex:none"><span style="color:var(--kept)">✓</span><span style="color:var(--pending)">↩</span><span style="color:var(--dim)">🧹</span></span>` : '<span style="width:44px;flex:none"></span>'}
  </div>`;
// Overview MASTER-DETAIL — a left nav (Fleet · Workflows: agent rows + workflow runs) drives the right
// change-map detail (session chip + task ribbon + module strip + file ledger). Self/orchestrator selected.
const ovAgentRow = (dot, branch, self, bars, added, removed, sel) => `
  <div style="display:flex;align-items:center;gap:7px;padding:6px 12px;font-size:11.5px${sel ? ';background:var(--bg);box-shadow:inset 2px 0 0 var(--accent)' : ''}">
    <span class="dot" style="background:${dot};flex:none"></span>
    <span class="mono" style="color:${sel ? 'var(--ink)' : 'var(--dim)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;min-width:0">demo <span style="color:var(--faint)">⑂${branch}</span></span>
    ${self ? `<span style="font-size:8px;font-weight:700;color:var(--coral);border:1px solid var(--coral);border-radius:8px;padding:0 5px;flex:none">self</span>` : ''}
    <span style="margin-left:auto;display:flex;align-items:center;gap:7px;flex:none">${spark(bars, dot)}<span class="mono" style="font-size:9.5px"><span style="color:${gADD}">+${added}</span> <span style="color:${gREM}">−${removed}</span></span></span>
  </div>`;
const overviewTabsBody = `
  <div style="display:flex;align-items:stretch">
    <div style="flex:0 0 35%;min-width:0;background:var(--side);border-right:1px solid var(--border)">
      <div style="display:flex;gap:12px;padding:9px 12px 7px;border-bottom:1px solid var(--border);font-size:11.5px">
        <span style="color:var(--ink);border-bottom:1.5px solid var(--accent);padding-bottom:6px;margin-bottom:-8px">Fleet</span>
        <span style="color:var(--faint)">Workflows</span>
      </div>
      ${ovAgentRow('var(--blue)', 'demo/pipeline', true, [.3, .6, .4, .8, .5, .9, .7, 1], 40, 3, true)}
      ${ovAgentRow('var(--pending)', 'feat-x', false, [.5, .7, .3, .6, .8, .4, .6, .5], 42, 7, false)}
      ${ovAgentRow('var(--kept)', 'hotfix', false, [.4, .8, .6, .3, .7, .5, .2, .4], 6, 0, false)}
      <div style="font-size:9px;letter-spacing:.08em;color:var(--faint);font-weight:600;padding:9px 12px 2px;border-top:1px solid var(--border);margin-top:5px">WORKFLOWS</div>
      <div style="display:flex;align-items:center;gap:7px;padding:5px 12px;font-size:11px">
        <span class="dot" style="background:var(--blue);flex:none"></span>
        <span style="color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">ship-release <span style="color:var(--faint)">3/5</span></span>
        <span style="margin-left:auto;flex:none">${spark([.4, .5, .7, .6, .9, .5, .8, .6], 'var(--blue)')}</span>
      </div>
    </div>
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:9px;padding:10px 16px 6px;font-size:11.5px">
        <span style="background:var(--side);border:1px solid var(--border2);border-radius:12px;padding:2px 11px;display:inline-flex;gap:9px;align-items:center;white-space:nowrap">
          <span class="mono" style="color:var(--ink)">demo <span style="color:var(--faint)">⑂demo/pipeline</span></span>
          <span style="color:var(--faint)">·</span><span>${microscope}</span><span class="mono" style="color:var(--coral)">0c396c6b</span>
          <span style="color:var(--faint)">·</span><span style="color:var(--dim)">5 edits</span>
          <span style="color:var(--pending)">2⏳</span><span style="color:var(--kept)">3✓</span>
          <span style="color:var(--faint)">·</span><span style="color:var(--ink)">60%</span>
        </span>
      </div>
      <div style="display:flex;align-items:center;gap:5px;padding:4px 16px 10px;flex-wrap:wrap">
        ${taskPill('Tests and docs', '+24 −0', 'var(--pending)', false)}
        <span style="display:inline-flex;align-items:center;gap:6px;border:1px dashed var(--border2);border-radius:99px;padding:3px 10px;font-size:12px;color:var(--dim);white-space:nowrap"><span style="width:9px;height:9px;border-radius:50%;background:var(--kept)"></span>2 done ▸</span>
      </div>
      <div style="display:flex;height:16px;border-radius:3px;overflow:hidden;margin:0 16px 10px">
        ${cmSeg('var(--pending)', 'docs')}${cmSeg('var(--pending)', 'tests')}${cmSeg('var(--kept)', 'src')}${cmSeg('var(--kept)', 'src/models')}
      </div>
      <div style="padding:0 16px 8px">
        ${cmRow('var(--pending)', 'USAGE.md', 'docs', 100, '+12', '1⏳')}
        ${cmRow('var(--pending)', 'test_pipeline.py', 'tests', 96, '+12', '1⏳')}
        ${cmRow('var(--kept)', 'dataset.py', 'src/models', 58, '+7', '')}
        ${cmRow('var(--kept)', 'features.py', 'src', 55, '+6', '')}
      </div>
    </div>
  </div>`;

// ---------- scenes ----------
const scenes = {
  // The inline review bubble — faithful to the real widget, every area numbered + named alongside.
  'bubble': scene(1200, `
    <div style="display:grid;grid-template-columns:1.55fr 1fr;gap:26px;align-items:start;font-family:-apple-system,'Segoe UI',sans-serif;">
      <div style="position:relative;">
        ${pin('1', '2px', '9px')}${pin('2', '452px', '9px')}${pin('3', '10px', '150px')}${pin('4', '10px', '206px')}
        <div style="border:1px solid var(--border2);border-radius:8px;background:#252526;overflow:hidden;box-shadow:0 12px 40px -18px rgba(0,0,0,.7);margin-left:26px;">
          <div style="display:flex;align-items:center;gap:12px;padding:9px 14px;background:var(--side);border-bottom:1px solid var(--border);">
            <span style="color:var(--coral);font-family:'SF Mono',Menlo,monospace;font-size:12.5px;">Claude edit #1</span>
            <span style="color:var(--dim);font-family:'SF Mono',Menlo,monospace;font-size:12px;">·  +6 −1  ·  <b style="color:var(--ink)">Diff 1/1</b>  ·  <b style="color:var(--ink)">File 4/5</b></span>
            <span style="margin-left:auto;display:flex;gap:12px;font-size:13px;color:var(--dim);white-space:nowrap;">
              <span>↑</span><span>↓</span><span>←</span><span>→</span><span style="color:var(--kept)">✓</span><span style="color:var(--pending)">↩</span><span style="color:var(--kept)">✓✓</span><span style="color:#f85149">✕</span><span>💬</span><span>🧹</span><span>💡</span><span>🔍</span>
            </span>
          </div>
          <div style="padding:12px 16px;">
            <div style="font-weight:600;margin-bottom:7px;font-size:13px;">Claude Observatory</div>
            <div style="font-family:'SF Mono',Menlo,monospace;font-size:12.5px;color:var(--ink);margin-bottom:8px;">✨ <b>Claude edit #1</b>  ·  +6 −1  ·  Edit  ·  <b>Diff 1/1</b>  ·  <b>File 4/5</b></div>
            <div style="color:var(--faint);font-style:italic;font-size:12.5px;margin-bottom:11px;">💭 I'm positioning the changeMapShell function to insert after the statsData closing brace at line 152…</div>
            <div style="font-family:'SF Mono',Menlo,monospace;font-size:12px;line-height:1.75;">
              ${dl('hunk', '@@ −461,9 +461,14 @@')}
              ${dl('ctx', '    const thread = this.controller.createCommentThread(doc.uri, range, [comment]);')}
              ${dl('ctx', '    thread.canReply = false;')}
              ${dl('rem', '−    thread.label = `Claude edit #${id}  ·  +${d.added} −${d.removed}` + (diffPos ? …')}
              ${dl('add', '+    // Show BOTH axes in the title (Diff n/m · File i/k), like the status-bar nav bar')}
              ${dl('add', '+    thread.label =')}
            </div>
          </div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:13px;padding-top:6px;">
        <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--coral);font-weight:700;">Inline review bubble</div>
        ${note('1', 'Title', 'The edit id, its ± delta, and the live <b style="color:var(--ink)">Diff&nbsp;n/m · File&nbsp;i/k</b> position.')}
        ${note('2', 'Toolbar', 'Mirrors the status-bar nav bar: ↑↓ prev/next&nbsp;edit · ←→ prev/next&nbsp;file · <span style="color:#3fb950">✓</span>&nbsp;Keep · <span style="color:#d9a441">↩</span>&nbsp;Undo · <span style="color:#3fb950">✓✓</span>&nbsp;Accept&nbsp;File · <span style="color:#f85149">✕</span>&nbsp;Reject&nbsp;File · 💬&nbsp;Chat · 🧹&nbsp;Clear · 💡&nbsp;Spotlight · 🔍&nbsp;Search.')}
        ${note('3', 'Reasoning', 'Claude&rsquo;s own words for this edit, mined from the transcript (💭).')}
        ${note('4', 'Diff', 'The edit&rsquo;s before ⟷ after, in git&rsquo;s red/green.')}
      </div>
    </div>`),
  // Anatomy — a labelled outline of every surface, so each section can be referred to by name.
  // Per-window diagrams — the real panel mockup + a numbered legend of its parts.
  'win-overview': scene(1200, winDiag('OVERVIEW', changeMapCol, [
    note('1', 'Fleet · Workflows nav', 'The left rail — running agents across git worktrees + workflow runs, each with phase · sparkline · ± · tokens · time. Pick one to drive the detail.'),
    note('2', 'Chapter ribbon', 'The selected item&rsquo;s to-dos across the top (● done · ◐ in progress · ○ planned). Click one to <b style="color:var(--ink)">brush</b> the map to just its files.'),
    note('3', 'Module strip + ledger', 'One equal-width segment per module (click to filter), then every file ranked by churn with a bar. Hover for the class + reasoning; click to open the diff.'),
  ].join(''))),
  'win-actions': scene(1200, winDiag('ACTIONS', actionsCol, [
    note('1', 'Category groups', 'Now a sidebar tab (moved from the panel), collapsed by default — Edits · Commands · Reads · Searches · To-dos. Curated; errors always surface.'),
    note('2', 'Egress', 'Everywhere the session reached off-machine — web · MCP · network shell.'),
    note('3', 'Audits', 'Risk &amp; egress audits ride the Observations change-feed alongside the edits they flag.'),
    note('4', 'Review links', 'A row with an edit links straight to its inline review.'),
  ].join(''))),
  'win-observations': scene(1180, winDiag('OBSERVATIONS', observationsCol, [
    note('1', 'Session recap', 'Claude Code&rsquo;s own title for the session (zero-token; ✨ to refine).'),
    note('2', 'Change-feed + reasoning', 'The former Timeline folds in here: same-file edits coalesce into a <b style="color:var(--ink)">×N</b> run, above one row per edit with Claude&rsquo;s actual words + file-memory (🧠) across sessions.'),
  ].join(''))),
  'win-stats': scene(1120, winDiag('STATS', statsCol(40, 40), [
    note('1', 'Review scoreboard', 'Live pending / accepted / reverted counts + a progress bar that fills as you review.'),
    note('2', 'Range toggle', 'Today · 7&nbsp;days · 30&nbsp;days for the plots below.'),
    note('3', 'Token plot', 'Total / input / output tokens over the window (log scale, crosshair tooltip).'),
    note('4', 'Usage bars', 'Context fill + 5-hour / weekly plan usage, with reset countdowns.'),
  ].join(''))),
  // Anatomy — the SAME spatial layout as layout.png, every region labelled in place.
  'anatomy': scene(1760, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — Visual Studio Code</span></div>
      <div class="row" style="align-items:stretch;height:300px;">
        <div style="width:126px;background:var(--side);border-right:1px solid var(--border);padding:12px 11px;display:flex;flex-direction:column;gap:9px;">
          <div style="font-size:9.5px;font-weight:700;color:var(--coral);letter-spacing:.05em;">① ACTIVITY BAR</div>
          <div style="font-size:20px;position:relative;width:26px;">${microscope}<span style="position:absolute;right:-6px;bottom:-4px;background:var(--accent);color:#fff;border-radius:8px;font-size:9px;padding:0 4px;">3</span></div>
          <div style="font-size:11px;color:var(--dim);line-height:1.45;">The <b style="color:var(--ink)">Claude&nbsp;Edits</b> container, badged with the pending count.</div>
        </div>
        <div style="width:320px;background:var(--side);border-right:1px solid var(--border);padding:12px 14px;">
          <div style="font-size:9.5px;font-weight:700;color:var(--coral);letter-spacing:.05em;margin-bottom:7px;">② SIDEBAR · Claude Edits</div>
          <div style="font-size:12px;color:var(--dim);line-height:1.55;"><b style="color:var(--ink)">Edits</b> (folder → file → class) · <b style="color:var(--ink)">Diffs</b> · <b style="color:var(--ink)">File&nbsp;History</b> · <b style="color:var(--ink)">Actions</b>.<br>Per-row Keep&nbsp;/&nbsp;Undo. Title bar: Search · Review&nbsp;◄► · Accept/Revert&nbsp;All · Clear · Switch&nbsp;session.</div>
        </div>
        <div style="flex:1;padding:12px 16px;">
          <div style="font-size:9.5px;font-weight:700;color:var(--coral);letter-spacing:.05em;margin-bottom:7px;">③ EDITOR</div>
          <div style="font-size:12px;color:var(--dim);line-height:1.6;"><b style="color:var(--ink)">Inline review</b> — ✨ markers + tinted lines on Claude&rsquo;s edits, with a <b style="color:var(--ink)">CodeLens</b> per edit (Keep&nbsp;/&nbsp;Undo&nbsp;/&nbsp;Chat&nbsp;/&nbsp;diff, showing the Diff&nbsp;·&nbsp;File position).<br><br><b style="color:var(--ink)">Tab-bar toolbar</b> (on a file with pending edits): ◄►&nbsp;Diff · Keep · Undo · Clear · 💡&nbsp;Spotlight · 🔍&nbsp;Search · ⇄&nbsp;Session.</div>
        </div>
      </div>
      <div style="border-top:1px solid var(--border);background:var(--panel);">
        <div class="paneltabs"><span>PROBLEMS</span><span>OUTPUT</span><span>TERMINAL</span><span class="on">④ CLAUDE OBSERVATORY</span></div>
        <div class="row" style="align-items:stretch;height:168px;">
          ${['OBSERVATIONS|Each edit paired with Claude&rsquo;s own reasoning, under a session recap — with the coalesced ×N change-feed (Timeline) folded in.'].map(c => {
            const [h, d] = c.split('|');
            return `<div class="col" style="flex:1.1;border-right:1px solid var(--border);"><div class="colhead" style="color:var(--coral)">${h}</div><div style="font-size:11px;color:var(--dim);padding:2px 16px;line-height:1.5;">${d}</div></div>`;
          }).join('')}
          <div class="col" style="flex:1.5;border-right:1px solid var(--border);">
            <div class="colhead" style="color:var(--coral)">OVERVIEW</div>
            <div style="font-size:11px;color:var(--dim);padding:2px 16px;line-height:1.55;">Master–detail — a left nav drives the change-map:
              <div style="margin-top:5px;"><b style="color:var(--blue)">ⓐ Fleet · Workflows</b> — running agents / workflow runs</div>
              <div><b style="color:var(--kept)">ⓑ chapter ribbon</b> — the selection&rsquo;s to-dos; click to brush</div>
              <div><b style="color:var(--pending)">ⓒ module strip + ledger</b> — files ranked by churn</div>
            </div>
          </div>
          <div class="col" style="flex:1;"><div class="colhead" style="color:var(--coral)">STATS</div><div style="font-size:11px;color:var(--dim);padding:2px 16px;line-height:1.5;">Review scoreboard · token plots · context&nbsp;/&nbsp;plan usage bars.</div></div>
        </div>
      </div>
      <div class="statusbar">
        <span class="sb-warn">${microscope} 3</span>
        <span style="color:var(--coral);font-size:10px;font-weight:700;letter-spacing:.05em;">⑤ STATUS BAR</span>
        <span style="color:var(--dim);font-size:11px;">navigation bar: File&nbsp;◄► · Diff&nbsp;◄► · Keep · Undo · Accept&nbsp;/&nbsp;Reject&nbsp;File · Clear · 💡&nbsp;Spotlight · 🔍&nbsp;Search</span>
      </div>
    </div>`),
  // A. the full observatory layout
  // The master map — the real workspace mockup with a coral callout box + label on every region.
  'map': scene(1760, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — Visual Studio Code</span></div>
      <div class="row" style="align-items:stretch; height:392px;">
        <div style="position:relative;width:60px;background:var(--side);border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding-top:20px;gap:20px;box-shadow:inset 0 0 0 2px var(--coral);">
          <span style="position:absolute;top:-8px;left:6px;background:var(--coral);color:#fff;font-size:10px;font-weight:700;padding:1.5px 6px;border-radius:4px;z-index:5;">①</span>
          <span style="opacity:.4">🗎</span><span style="opacity:.4">🔍</span>
          <span style="position:relative;font-size:18px">${microscope}<span style="position:absolute;right:-7px;bottom:-5px;background:var(--accent);color:#fff;border-radius:8px;font-size:9px;padding:0 4px;">3</span></span>
          <span style="opacity:.4">⚙</span>
        </div>
        <div style="position:relative;width:300px;background:var(--side);border-right:1px solid var(--border);box-shadow:inset 0 0 0 2px var(--coral);">
          <span style="position:absolute;top:-8px;left:9px;background:var(--coral);color:#fff;font-size:9px;font-weight:700;letter-spacing:.04em;padding:1.5px 7px;border-radius:4px;z-index:5;white-space:nowrap;">① Activity bar · ② Sidebar (Claude Edits: Edits·Diffs·File History·Actions)</span>
          <div style="padding:10px 14px 2px;font-size:11px;color:var(--dim);letter-spacing:.06em;">CLAUDE EDITS</div>
          ${editsTree}
          <div class="viewhead" style="border-top:1px solid var(--border);margin-top:8px;">DIFFS</div>
          <div class="viewhead" style="border-top:1px solid var(--border);">FILE HISTORY <span style="float:right;color:var(--faint)">features.py</span></div>
          <div class="viewhead" style="border-top:1px solid var(--border);">ACTIONS</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;">
          <div style="position:relative;display:flex;align-items:center;background:var(--side);border-bottom:1px solid var(--border);box-shadow:inset 0 0 0 2px var(--coral);">
            ${clabel('③ EDITOR TAB BAR')}
            <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">features.py</div>
            <span style="margin-left:auto;display:flex;gap:12px;padding-right:14px;color:var(--dim);font-size:13px;">‹ › <span style="color:var(--kept)">✓</span> <span style="color:var(--pending)">↩</span> 🧹 💡 🔍 ⇄</span>
          </div>
          ${editorCode()}
        </div>
      </div>
      <div style="border-top:1px solid var(--border);background:var(--panel);">
        <div class="paneltabs"><span>PROBLEMS</span><span>OUTPUT</span><span>TERMINAL</span><span class="on">④ CLAUDE OBSERVATORY</span></div>
        <div class="row" style="align-items:stretch;height:184px;">
          ${mapPane('1', 'OBSERVATIONS', observationsCol)}
          ${mapPane('1.55', 'OVERVIEW', changeMapCol)}
          ${mapPane('1', 'STATS', statsCol(30, 30).replace(/<div class="uhead">USAGE<\/div>[\s\S]*$/, '<div class="urow"><span class="lbl">ctx</span><span class="track"><span class="fill" style="width:39%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">39%</span><span class="sub">390k/1M</span></div>'), true)}
        </div>
      </div>
      <div class="statusbar" style="position:relative;box-shadow:inset 0 0 0 2px var(--coral);">
        ${clabel('⑤ STATUS BAR · navigation bar')}
        <span class="sb-warn">${microscope} 3</span>
        <span style="display:flex;gap:9px;color:var(--dim);font-size:11px;font-family:'SF Mono',Menlo,monospace;">⌃ 2/3 ⌄ · ‹ 1/3 › · <span style="color:#3fb950">✓</span> <span style="color:#d9a441">↩</span> <span style="color:#3fb950">✓✓</span> <span style="color:#f85149">✕</span> · 🧹 💡 🔍</span>
        <span style="margin-left:auto">⎇ main</span>
      </div>
    </div>`),
  'layout': scene(1760, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — Visual Studio Code</span></div>
      <div class="row" style="align-items:stretch; height:472px;">
        <div style="width:48px;background:var(--side);border-right:1px solid var(--border);display:flex;flex-direction:column;align-items:center;padding-top:12px;gap:20px;">
          <span style="opacity:.4">🗎</span><span style="opacity:.4">🔍</span>
          <span style="position:relative;font-size:18px">${microscope}<span style="position:absolute;right:-7px;bottom:-5px;background:var(--accent);color:#fff;border-radius:8px;font-size:9px;padding:0 4px;">3</span></span>
          <span style="opacity:.4">⚙</span>
        </div>
        <div style="width:300px;background:var(--side);border-right:1px solid var(--border);">
          <div style="padding:10px 14px 2px;font-size:11px;color:var(--dim);letter-spacing:.06em;">CLAUDE EDITS</div>
          ${editsTree}
          <div class="viewhead" style="border-top:1px solid var(--border);margin-top:8px;">DIFFS</div>
          <div class="viewhead" style="border-top:1px solid var(--border);">FILE HISTORY <span style="float:right;color:var(--faint)">features.py</span></div>
          <div class="viewhead" style="border-top:1px solid var(--border);">ACTIONS</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;">
          <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
            <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">features.py</div>
          </div>
          ${editorCode()}
        </div>
      </div>
      <div style="border-top:1px solid var(--border);background:var(--panel);">
        <div class="paneltabs"><span>PROBLEMS</span><span>OUTPUT</span><span>TERMINAL</span><span class="on">CLAUDE OBSERVATORY</span></div>
        <div class="row" style="align-items:stretch;height:212px;">
          <div class="col" style="flex:1;border-right:1px solid var(--border);"><div class="colhead">OBSERVATIONS</div>${observationsCol}</div>
          <div class="col" style="flex:1.55;border-right:1px solid var(--border);"><div class="colhead">OVERVIEW</div>${changeMapCol}</div>
          <div class="col" style="flex:1;"><div class="colhead">STATS</div>${statsCol(34, 34).replace(/<div class="uhead">USAGE<\/div>[\s\S]*$/, '<div class="urow"><span class="lbl">ctx</span><span class="track"><span class="fill" style="width:39%;background:var(--kept)"></span></span><span class="pct" style="color:var(--kept)">39%</span><span class="sub">390k/1M</span></div>')}</div>
        </div>
      </div>
      <div class="statusbar">
        <span class="sb-warn">${microscope} 3</span>
        <span>⎇ main</span><span style="margin-left:auto">Ln 8, Col 1&nbsp;&nbsp;UTF-8&nbsp;&nbsp;Python</span>
      </div>
    </div>`),

  // B. inline review closeup
  'inline-review': scene(980, `
    <div class="window">
      <div style="display:flex;background:var(--side);border-bottom:1px solid var(--border);">
        <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">train.py</div>
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
        <b>#1 edited features.py</b><br>
        <span style="color:var(--dim)">💭 "Adding scale() — z-score standardization so features share a range before training."</span><br>
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
        <div style="padding:8px 18px;background:var(--bg);border-right:1px solid var(--border);font-size:12.5px;">features.py</div>
      </div>
      ${heatmapEditor()}
      <div class="statusbar"><span class="sb-warn">${microscope} 3</span><span style="color:var(--faint)">📄 Heatmap on — every unmodified line dimmed</span></div>
    </div>`),

  // I. File History — the active file's edits, chronological, follows the editor
  'file-history': scene(720, `
    <div class="window" style="padding-bottom:8px;">
      <div class="viewhead" style="padding-top:12px;">FILE HISTORY <span style="float:right;color:var(--faint)">features.py</span></div>
      ${fileHistoryCol}
    </div>`),

  // J. 0.8.0 — the Overview's Fleet tab: every agent (worktree) in this project, its subagents, collisions.
  'multitasking': scene(820, `
    <div class="window" style="padding-bottom:8px;">
      ${multitaskingBody}
    </div>`),

  // K. 0.8.0 — Overview master-detail: Fleet · Workflows left nav + the change-map detail (right).
  'overview-tabs': scene(760, `
    <div class="window" style="padding-bottom:10px;">
      ${overviewTabsBody}
    </div>`),

  // L. 0.8.0 — task chapters: every edit under a named chapter (total — no "unassigned"); per-chapter
  //    Accept/Reject/Clear act WYSIWYG on the row's displayed edits — the dimmed synthesized session
  //    chapter is reviewable like any other.
  'chapters': scene(720, `
    <div class="window" style="padding-bottom:10px;">
      <div class="viewhead" style="padding-top:12px;">OVERVIEW · CHAPTERS <span style="float:right;color:var(--faint)">session 0c396c6b</span></div>
      ${chapterRow('●', 'var(--kept)', 'Add feature scaling to the pipeline', '+9 −3', '', true)}
      ${chapterRow('●', 'var(--kept)', 'Validate the training dataset', '+7 −0', '', true)}
      ${chapterRow('◐', 'var(--pending)', 'Tests and docs', '+24 −0', '2⏳', true)}
      ${chapterRow('◐', 'var(--pending)', 'Pipeline: scaling, validation, tests', '', '', true, true)}
      <div style="display:flex;align-items:center;gap:8px;padding:6px 16px 2px;font-size:11.5px;color:var(--dim)">
        <span style="width:9px;height:9px;border-radius:50%;background:var(--kept)"></span>2 done ▸
        <span style="margin-left:auto;color:var(--faint)">🧹 clear completed</span>
      </div>
    </div>`),

  // M. 0.8.0 — the zero-token chat handoff: chat-context assembles the prompt, copied to the clipboard.
  'chat': scene(860, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">Chat about Claude edit #2 — context assembled, zero tokens</span></div>
      <div style="padding:14px 18px;font-size:12.5px;line-height:1.7">
        <div class="mono" style="color:var(--dim);border:1px solid var(--border2);border-radius:6px;padding:12px 14px;background:var(--side)">
          <div>I'm reviewing an edit you made with Claude Observatory. Context:</div>
          <div style="margin-top:8px"><span style="color:var(--ink)">Edit #2</span> · Edit · <span class="add2">+3</span> <span class="rem2">−2</span> · <span style="color:var(--ink)">src/train.py</span> · task: <span style="color:var(--coral)">Add feature scaling to the pipeline</span></div>
          <div style="margin-top:6px;color:var(--faint);font-style:italic">Your reasoning at the time: "Scaling the features in the training entrypoint before they reach the model."</div>
          <div style="margin-top:8px;color:var(--blue)">@@ src/train.py +3 −2 @@</div>
          <div><span class="rem2">-from features import summarize</span></div>
          <div><span class="add2">+from features import summarize, scale</span></div>
          <div><span class="add2">+features = scale([1.0, 2.0, 3.0])</span></div>
          <div><span class="add2">+print(summarize(features))</span></div>
          <div style="margin-top:8px;color:var(--ink)">My question: …</div>
        </div>
        <div style="display:flex;align-items:center;gap:9px;margin-top:12px;font-size:12px;color:var(--dim)">
          <span style="color:var(--kept)">✓</span> copied to the clipboard · opening your Claude — works for any edit, action, subagent, or chapter
        </div>
      </div>
    </div>`),

  // N. 0.8.0 — the live demo: one command simulates a full session through the real pipeline.
  'demo': scene(880, `
    <div class="window">
      <div class="titlebar"><span class="tl" style="background:#ff5f57"></span><span class="tl" style="background:#febc2e"></span><span class="tl" style="background:#28c840"></span><span class="t">demo — claude-observatory</span></div>
      <div class="term">
        <div class="cmd"><span class="pr">$</span>claude-observatory <span class="fl">demo</span></div>
        <div class="out">▸ prompt — asking Claude to extend the training pipeline</div>
        <div class="out">▸ plan — three to-dos (the Overview chapters)</div>
        <div class="out">▸ chapter 1 — feature scaling (2 edits)</div>
        <div class="out">▸ chapter 2 — dataset validation</div>
        <div class="out">▸ chapter 3 — tests, written by a <span class="file2">subagent</span></div>
        <div class="out">▸ a <span class="file2">workflow</span> run starts — documentation, one level above the subagents</div>
        <div class="out">▸ recap — plan complete, next steps surfaced</div>
        <div class="out"><span class="ok">✓</span> demo session <span class="id2">demo-3cc31d01</span> is live — <span class="warn">5 pending edits</span> in observatory-demo/</div>
        <div class="out">  open the Overview / Observations panels, review the chapters, then: <span class="fl">demo --clean</span></div>
        <div class="cmd"><span class="pr">$</span><span class="cursor">&nbsp;</span></div>
      </div>
    </div>`),
};

// ---------- render ----------
// per-scene capture viewport (width = sceneW + 48px body padding; height tuned to content)
const SIZE = {
  layout: '1808,860', anatomy: '1808,700', map: '1808,706', bubble: '1248,368',
  'win-overview': '1248,320', 'win-actions': '1248,300', 'win-observations': '1228,288', 'win-stats': '1168,420',
  stats: '808,478', 'inline-review': '1028,440', observations: '1028,368',
  cli: '948,540', conflict: '928,290', diffs: '1028,330', heatmap: '1028,400',
  'file-history': '768,130',
  multitasking: '868,352', 'overview-tabs': '808,248',
  chapters: '768,224', chat: '908,440', demo: '928,392',
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
    '--window-size=1900,860',
    `file://${join(OUT, `${name}.src.html`)}`,
  ], { stdio: 'pipe' });
  console.log('rendered', `${name}.png`);
}
rmSync(tmp, { recursive: true, force: true });
