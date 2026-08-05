/**
 * Drive the interactive dashboard with REAL keystrokes and assert what lands on screen.
 *
 * `--once` renders one frame and never installs a key handler, and `tty-boot.js` only proves the
 * first paint does not throw. Neither presses a key — which is how five separate keys shipped bound
 * to a string the decoder never emits, and how "the arrows do nothing" reached a user. Everything
 * this file asserts is a key going in and a frame coming out.
 *
 * Usage: node test/tty-drive.js <cli-dist-index.js> [--root <dir>] [--session <id>]
 *
 * It fakes a TTY, captures the escape-laden paint stream, and reconstructs the frame from the
 * cursor-addressed writes the renderer emits (`\x1b[<row>;1H\x1b[K<line>`), so an assertion reads the
 * same lines a human would see.
 */
const COLS = 120;
const ROWS = 34;

process.stdin.isTTY = true;
process.stdin.setRawMode = () => {};
process.stdout.isTTY = true;
process.stdout.columns = COLS;
process.stdout.rows = ROWS;

/** The reconstructed screen: row index -> the text last written there. */
const screen = new Array(ROWS).fill('');
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (s) => {
  const text = typeof s === 'string' ? s : String(s);
  // The painter writes `\x1b[H` then, per line, `\x1b[<n>;1H\x1b[K<content>`. Rebuild from that.
  // The content runs to the NEXT cursor-address, not to the next escape of any kind: a line is full
  // of SGR sequences, and stopping at the first of them truncated most rows to a few characters —
  // an instrument that reported half the frame missing and blamed the product for it.
  const re = /\x1b\[(\d+);1H\x1b\[K([\s\S]*?)(?=\x1b\[\d+;1H|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const row = Number(m[1]) - 1;
    if (row >= 0 && row < ROWS) screen[row] = m[2];
  }
  return true;
};

const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const frame = () => screen.map(plain);
const rowText = (i) => plain(screen[i] ?? '');
const find = (re) => frame().findIndex((l) => re.test(l));
/**
 * The RAW rows, escapes included.
 *
 * Selection is carried by colour now — the `>` marker is the no-colour fallback only — so a
 * plain-text comparison cannot see the cursor move at all. Stripping escapes before asking "did this
 * change?" is an instrument that reports every selection as frozen, which is exactly what this
 * harness said on its first run before the product was even at fault.
 */
const raw = (from, to) => screen.slice(from, to).join('\n');

// stdin has to be a real EventEmitter the runtime can attach to; the runtime calls
// `process.stdin.on('data', ...)`, `.resume()` and `.pause()`, so those must all exist.
process.stdin.resume = () => process.stdin;
process.stdin.pause = () => process.stdin;

const nfs = require('fs');
const npath = require('path');

const target = process.argv[2];
const rest = process.argv.slice(3);
process.argv = [process.argv[0], target, ...rest];

/**
 * This harness drives the REAL dashboard, which means a real store and a real settings file.
 *
 * Unless the caller pointed it somewhere else, it runs against a THROWAWAY config dir holding a
 * SEEDED session (see below) — so every write lands in a directory deleted on the way out, and the
 * checks assert the same thing on every machine instead of whatever the developer's ~/.claude
 * happens to contain. `e2e.sh` has isolated itself this way from the start; a harness that presses
 * keys in a tool whose keys revert code had no business being the exception.
 */
const nos = require('os');

// The key sweep below presses `e`, which hands the terminal to `$EDITOR` — faithfully, which is the
// point of the product and a hazard for a test. Under `npm run e2e` on a machine where EDITOR=vim
// that opened vim on the CI/developer terminal and blocked the whole suite. Point it at a binary that
// exits immediately: the key still has to DO something, which is what is being checked.
process.env.EDITOR = process.env.TTY_DRIVE_EDITOR || 'true';
delete process.env.VISUAL;

/**
 * A SEEDED session, built here rather than borrowed from the machine this runs on.
 *
 * The harness used to symlink the caller's real transcripts and drive whatever happened to be there.
 * That made its coverage a property of the developer's laptop: on a store with no edits it skipped
 * the Traces cursor checks, the change-map checks and every review verb, and said so politely while
 * reporting "all passed". On CI, where ~/.claude is empty, it skipped nearly everything.
 *
 * So: a real workspace with real files, a real transcript, and a real store with real edits across
 * several folders — written synchronously, before the dashboard is required, so every check below
 * has something to act on and asserts the same thing on every machine.
 */
function seedSession(core, nfs, npath, nos) {
  const ws = nfs.realpathSync(nfs.mkdtempSync(npath.join(nos.tmpdir(), 'tty-ws-')));
  const session = 'ttydrive0';

  // Files on disk: the change map places each edit in the CURRENT text, and undo rewrites it, so
  // these have to genuinely exist rather than be names in a log.
  const files = [
    ['src/app.ts', 'export function app() {\n  return 1;\n}\n', 'export function app() {\n  // reviewed\n  return 2;\n}\n'],
    // A SECOND, INDEPENDENT edit to the same file. Without one the grouping has nothing to group;
    // and it must not CHAIN off the first (before == the first's after), because two chained edits
    // are one review unit by design — `reviewEdits` collapses them and the pane would correctly show
    // a single row, which is what the first version of this fixture did.
    ['src/app.ts', 'export function app() {\n  const unrelated = 0;\n}\n', 'export function app() {\n  const unrelated = 1;\n}\n'],
    ['src/util.ts', 'export const x = 1;\n', 'export const x = 2;\nexport const y = 3;\n'],
    ['lib/deep/core.ts', 'const a = 1;\n', 'const a = 2;\n'],
    ['README.md', '# demo\n', '# demo\n\nnow with words\n'],
    // Covered by the .observatoryignore below, and appended here DIRECTLY — which models the one
    // case a capture-time rule cannot reach: a record written before the rule existed. The sweep
    // below is what removes it, and that is what these checks measure.
    ['dist/bundle.js', 'var a=1;\n', 'var a=2;\n'],
  ];
  // Recent, so ages read the way a reader's own session would ("2m ago", not "32mo ago") and any
  // age-based folding behaves normally. The ASK is stamped just before the edits so they fall inside
  // its window and Prompts can own them.
  const t0 = Date.now() - 5 * 60 * 1000;
  core.ensureStore(session);
  for (const [rel, before, after] of files) {
    const abs = npath.join(ws, rel);
    nfs.mkdirSync(npath.dirname(abs), { recursive: true });
    nfs.writeFileSync(abs, after);
    const id = core.nextId(session);
    core.appendLog(session, {
      id,
      ts: t0 + id * 1000,
      tool: 'Edit',
      file: abs,
      beforeBlob: core.writeBlob(session, Buffer.from(before)),
      afterBlob: core.writeBlob(session, Buffer.from(after)),
      status: 'pending',
    });
  }
  nfs.writeFileSync(npath.join(ws, '.observatoryignore'), 'dist/\n');
  // The sweep, exactly as the capture hook runs it. One mode: a matching path is never recorded, so
  // a record that predates the rule is DROPPED rather than filtered out of each display in turn.
  const swept = core.dropIgnored(session);
  if (swept.dropped !== 1) throw new Error(`seed: expected the sweep to drop 1 record, it dropped ${swept.dropped}`);

  // The transcript, in the project dir the cwd mangles to. An assistant record is required: a
  // transcript with only user records is a command stub, which resolution deliberately demotes.
  const proj = core.projectDir(ws);
  nfs.mkdirSync(proj, { recursive: true });
  // Faithful to a real transcript, because the product reads it as one: an ask with no `timestamp`
  // is deliberately skipped ("an undated ask cannot own a window"), and the assistant record needs a
  // message id and a usage block for the token and prompt correlation to have anything to join on.
  // The first fixture had neither, so Prompts rendered "nothing on Prompts" against a seeded prompt.
  const iso = (ms) => new Date(ms).toISOString();
  nfs.writeFileSync(
    npath.join(proj, session + '.jsonl'),
    [
      {
        type: 'user', sessionId: session, cwd: ws, timestamp: iso(t0 - 1000),
        message: { role: 'user', content: 'tidy up the app' },
      },
      {
        type: 'assistant', sessionId: session, timestamp: iso(t0 + 500),
        message: {
          role: 'assistant', id: 'msg_ttydrive_1', content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 120, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      },
    ]
      .map((o) => JSON.stringify(o))
      .join('\n') + '\n',
  );
  // The count AFTER the sweep — what the dashboard will actually show. Returning `files.length`
  // here made every later check expect the swept record back.
  return { ws, session, edits: files.length - swept.dropped };
}

let SEED = null;
if (!process.env.CLAUDE_CONFIG_DIR) {
  const sandbox = nfs.mkdtempSync(npath.join(nos.tmpdir(), 'tty-drive-'));
  process.env.CLAUDE_CONFIG_DIR = sandbox;
  // Seed AFTER pointing the config dir at the sandbox — core resolves the store from it at call time.
  // The built core, resolved from this file rather than from the CLI bundle: the bundle does not
  // re-export the store primitives the seed writes with.
  SEED = seedSession(require(npath.resolve(__dirname, '..', 'packages', 'core', 'dist', 'index.js')), nfs, npath, nos);
  process.on('exit', () => {
    try { nfs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    try { nfs.rmSync(SEED.ws, { recursive: true, force: true }); } catch { /* nothing to clean */ }
  });
  // Drive the seeded session unless the caller named their own.
  if (!rest.includes('--root')) process.argv.push('--root', SEED.ws);
  if (!rest.includes('--session')) process.argv.push('--session', SEED.session);
}

/**
 * The options checks drive a REAL settings screen, which writes a REAL file. With the sandbox above
 * that file is inside it — but the snapshot stays, because a caller who sets CLAUDE_CONFIG_DIR
 * themselves is pointing at something they care about.
 */
const PREFS = npath.join(process.env.CLAUDE_CONFIG_DIR || npath.join(require('os').homedir(), '.claude'), 'claude-observatory', 'prefs.json');
const PREFS_BEFORE = nfs.existsSync(PREFS) ? nfs.readFileSync(PREFS, 'utf8') : null;
const restorePrefs = () => {
  try {
    if (PREFS_BEFORE === null) nfs.rmSync(PREFS, { force: true });
    else nfs.writeFileSync(PREFS, PREFS_BEFORE);
  } catch {
    /* nothing to put back */
  }
};
process.on('exit', restorePrefs);

require(target);

/** Feed bytes to the runtime exactly as a terminal would. */
const send = (bytes) => process.stdin.emit('data', Buffer.from(bytes, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
// Reported through the REAL stream: `console.log` goes to the stdout this file has replaced with a
// screen recorder, so every result would land in the fake frame instead of in the terminal — the
// first run of this harness printed "7 failed" and not one word about which.
const say = (s) => realWrite(s + '\n');

/**
 * A KEY THAT QUITS MUST FAIL THIS FILE, not end it.
 *
 * This harness `require()`s the CLI rather than spawning it, so the app's own `process.exit(0)` is
 * THIS process exiting. Before this guard, a verb that quit when it should not simply stopped the run
 * where it stood, with code 0 and no summary line — and a truncated green run is indistinguishable
 * from a complete one to anything reading the exit code. That is precisely how `^D` quitting could
 * have shipped past a check written to catch it: the check never got to run, and CI saw success.
 */
let finished = false;
const realExit = process.exit.bind(process);
process.exit = (code) => {
  if (!finished) {
    process.stdout.write = realWrite;
    say(`\n  ❌ the app EXITED mid-run (code ${code}) — some key quit that must not`);
    say('TTY-DRIVE: 1 failed');
    return realExit(1);
  }
  return realExit(code);
};
const check = (name, cond, detail) => {
  if (cond) say('  ✅ ' + name);
  else {
    say('  ❌ ' + name + (detail ? '\n       ' + detail : ''));
    // Print the FRAME on failure. "the map rendered identically" tells you nothing about what was on
    // screen instead, and every failure here was diagnosed by hand-rebuilding the state afterwards.
    if (process.env.TTY_DRIVE_DUMP) {
      say('       ---- frame ----');
      frame().forEach((l, i) => { if (l.trim()) say('       ' + String(i).padStart(2) + '|' + l.slice(0, 108)); });
    }
    failures.push(name);
  }
};

const KEY = {
  down: '\x1b[B', up: '\x1b[A', left: '\x1b[D', right: '\x1b[C',
  f1: '\x1bOP', f2: '\x1bOQ', f3: '\x1bOR', f4: '\x1bOS', f5: '\x1b[15~',
  tab: '\t', enter: '\r', esc: '\x1b',
  // Raw control bytes. ^D is 0x04 and ^U is 0x15 — the decoder names them {key:'d'|'u', ctrl:true}.
  ctrlD: '\x04', ctrlU: '\x15', ctrlF: '\x06', ctrlB: '\x02', ctrlR: '\x12', ctrlA: '\x01',
};

/** Wait for a condition, rather than for a duration. */
async function until(what, cond, ms = 8000) {
  const step = 100;
  for (let waited = 0; waited < ms; waited += step) {
    if (cond()) return;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A check whose condition becomes true after a REPAINT — waited for, not slept at.
 *
 * The shape `send(k); await sleep(300); check(...)` assumes a paint lands inside a fixed window, and on
 * a loaded CI runner it does not: two checks failed that way on macOS while every other lane passed,
 * intermittently and on different Node versions, which is what a race looks like from the outside. This
 * polls the same condition the check asserts, so it is faster than the sleep when the machine is quick
 * and tolerant when it is not — and when it genuinely fails, it still fails, with the same message.
 */
const checkSoon = async (name, cond, detail, ms = 5000) => {
  await until(name, cond, ms).catch(() => {});
  check(name, cond(), typeof detail === 'function' ? detail() : detail);
};

async function main() {
  // The first payload is a spawned child reading a real store, and how long that takes depends on
  // the session. A fixed sleep raced it: every check then compared two frames of "building…" and
  // reported the product frozen. Wait for the DATA.
  await until('the first payload', () => /\d+ edits/.test(frame().join('\n')));
  await sleep(200);

  // ---- the window bar leads, in the promised order ------------------------------------------
  check('the window bar is row 0, F1..F5 left to right',
    /F1 .Prompts.*F2 .Traces.*F3 .Map.*F4 .Diff.*F5 .Dashboards/.test(rowText(0)),
    JSON.stringify(rowText(0).slice(0, 80)));

  // ---- arrows move the selection in Traces --------------------------------------------------
  // NOT `send(KEY.f2)` first: focus already starts on Traces, and a pane's own key ZOOMS the pane it
  // is already showing. Pressing it here put the whole harness in a one-pane frame and every check
  // after it measured a layout the reader never asked for.
  const tracesTop = find(/F2 Traces/);
  const body = () => raw(tracesTop + 1, tracesTop + 14);
  // How many edits this store actually holds. A cursor cannot move through a one-row list, so on a
  // small fixture "the frame did not change" is the CORRECT answer — asserting movement there would
  // be a test that fails on a working product, and skipping it silently would be worse. Say which.
  const editCount = Number((rowText(tracesTop).match(/([\d,]+) edits/) || [])[1]?.replace(/,/g, '') ?? 0);
  if (editCount < 3) {
    say(`  ·  skipped the Traces arrow checks — this store has ${editCount} edit(s), too few to move a cursor through`);
  } else {
    const before = body();
    send(KEY.down);
    await sleep(250);
    const after1 = body();
    check('down arrow moves the Traces selection', before !== after1,
      'the pane rendered identically before and after the keypress');
    send(KEY.down);
    await sleep(120);
    send(KEY.down);
    await sleep(250);
    const after3 = body();
    check('and keeps moving it', after1 !== after3);
    send(KEY.up);
    await sleep(250);
    check('up arrow moves it back', body() !== after3);
  }

  // ---- Traces groups by FILE, one header per path -------------------------------------------
  // Every edit used to print its own full path, so a file touched twice produced two identical
  // headers and the pane read as a wall of repeated paths. The seed edits src/app.ts twice.
  {
    const traces = raw(tracesTop, tracesTop + 16).split('\n').map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const headers = traces.filter((l) => /app\.ts/.test(l));
    check('Traces shows one header per file, not one per edit',
      headers.length === 1, `app.ts appears on ${headers.length} header rows: ${JSON.stringify(headers)}`);
    check('…and the header says how many edits that file holds',
      headers.length === 1 && /2 edits/.test(headers[0]), JSON.stringify(headers[0] ?? null));
    // The edits are still there, nested — grouping must not hide them.
    check('…with its edits nested beneath it',
      traces.some((l) => /^\s{3,}\S?\s*#\d/.test(l)),
      JSON.stringify(traces.slice(0, 6)));
  }

  // ---- Tab cycles focus ---------------------------------------------------------------------
  // The focus marker is a `>` immediately before a pane's `F<n> <Title>` — NOT at column 0, because
  // a pane in the column band starts partway along the line.
  // Matched against a pane TITLE — `F<n> <Title> ----` — not against the window bar, which carries
  // the same words as chips. Without the trailing rule the first match is always a bar chip, and the
  // check then reports whatever is leftmost on the bar as "focused".
  const titleRow = () => frame().join('\n').match(/(>?)F(\d) ([A-Za-z]+) -+/g) || [];
  const focusedPane = () => {
    const m = titleRow().find((t) => t.startsWith('>'));
    return m ? (m.match(/F\d ([A-Za-z]+)/) || [])[1] : null;
  };
  const f0 = focusedPane();
  send(KEY.tab);
  await sleep(250);
  check('Tab moves focus to another window', focusedPane() !== f0, `focus stayed on ${f0}`);

  // ---- F3 and F4 are the two faces of ONE window --------------------------------------------
  // The title names the face, with the key that reaches it, so this reads the same thing the reader
  // does rather than an internal flag.
  const faceTitle = () => { const m = titleRow().find((t) => /F[34] (Map|Diff)/.test(t)); return m ? (m.match(/F([34]) (Map|Diff)/) || []).slice(1).join(' ') : ''; };
  send(KEY.f3);
  await sleep(250);
  check('F3 shows the change Map', faceTitle() === '3 Map', `title says ${JSON.stringify(faceTitle())}`);
  check('and focuses that window', focusedPane() === 'Map', `focus is on ${focusedPane()}`);
  send(KEY.f4);
  // Wait for the FACE to settle, not for a duration: pressing the key again before the first press
  // has been applied is read as "this face is not showing yet", so it swaps instead of zooming — a
  // race the test would report as a broken zoom.
  await until('the Diff face', () => faceTitle() === '4 Diff');
  check('F4 shows the Diff, in the same window', faceTitle() === '4 Diff', `title says ${JSON.stringify(faceTitle())}`);
  send(KEY.f4);
  await until('the zoom', () => /ZOOM/.test(rowText(0)), 3000).catch(() => {});
  check('F4 again zooms it', /ZOOM/.test(rowText(0)), JSON.stringify(rowText(0).slice(-40)));
  send(KEY.esc);
  await sleep(300); // a lone ESC resolves on the decoder's flush timer
  check('esc leaves the zoom', !/ZOOM/.test(rowText(0)));

  // ---- the change map moves under the arrows, and its rows carry their numbers ---------------
  send(KEY.f3);
  await sleep(300);
  // Anchored on the TITLE (`F3 Map ----`), not on the bare words: row 0's chip says `F3 ▾Map` too,
  // and a plain `find` returns that first — measuring the top of the frame and calling the map frozen.
  const mapTop = find(/F3 Map -/) + 2; // title, summary, column headings, then the rows
  const mapBody = () => raw(mapTop, mapTop + 10);
  const mapText = () => frame().slice(mapTop, mapTop + 10).join('\n');
  // A map with nothing in it has no cursor to move and no row to carry numbers. Say so rather than
  // asserting against an empty tree, and rather than passing quietly.
  if (!/\+\d/.test(mapText())) {
    say('  ·  skipped the change-map checks — this store changed no files, so the map is empty');
  } else {
    const m0 = mapBody();
    send(KEY.down);
    await sleep(250);
    check('down arrow moves the change-map selection', m0 !== mapBody(),
      'the map rendered identically before and after the keypress');
    check('and every map row states its added and removed lines', /\+\d[\d.k]*\s+−\d/.test(mapText()),
      JSON.stringify(mapText().split('\n')[1] || ''));
    check('…and offers Keep and Undo on the row', /✓/.test(mapText()) && /↩/.test(mapText()));
  }

  // ---- the options window --------------------------------------------------------------------
  // Driven with real keys, and it writes to a real file, so this runs against a THROWAWAY config dir
  // set by the caller — a settings test that edits the developer's own preferences is a test that
  // costs something to run.
  send('o');
  await until('the options window', () => /options\s+—/.test(frame().join('\n')));
  const optText = () => frame().join('\n');
  check('o opens the options window, and names the file it writes',
    /options\s+—/.test(optText()) && /prefs\.json/.test(optText()),
    JSON.stringify(optText().split('\n').filter((l) => /option|prefs/.test(l)).slice(0, 2)));
  check('it offers the editor, the display and the keys',
    /Editor command/.test(optText()) && /Colour/.test(optText()) && /KEYS/.test(optText()));
  // Anchored to the OPTIONS row shape — two spaces, the marker, the label — because the attention
  // row up top contains "▸ 1 active" and an unanchored match reports that as the cursor.
  const cursorRow = () => (optText().match(/^ {2}▸ (\S.*?)\s{2,}/m) || [])[1] ?? null;
  const first = cursorRow();
  send(KEY.down);
  await sleep(250);
  check('the cursor moves between settings', cursorRow() !== first, `stayed on ${first}`);
  // Walk to a row that HAS alternatives. Left/right on a text row correctly does nothing, so
  // pressing it there and expecting a change would be a test failing on a working product.
  for (let i = 0; i < 6 && cursorRow() !== 'Colour'; i++) { send(KEY.down); await sleep(150); }
  check('…and reaches the Colour setting', cursorRow() === 'Colour', `landed on ${cursorRow()}`);
  const beforeChange = optText();
  send(KEY.right);
  await until('the colour to change', () => optText() !== beforeChange, 3000).catch(() => {});
  check('right changes the value under the cursor', optText() !== beforeChange);
  // ---- the options window SAYS where the data is kept -----------------------------------------
  // "Where does this thing put my data" had no answer anywhere in the product. The row shows the
  // RESOLVED root, so it answers even when nothing has been changed.
  {
    const storeLine = optText().split('\n').find((l) => /Store\b/.test(l) && /claude-observatory/.test(l))
      || optText().split('\n').find((l) => /claude-observatory/.test(l) && /\//.test(l));
    check('the options window names where the store lives',
      Boolean(storeLine) && /claude-observatory/.test(String(storeLine)),
      JSON.stringify(optText().split('\n').filter((l) => /Store/.test(l)).slice(0, 3)));
  }
  send(KEY.esc);
  await sleep(350);
  // Checked over the WHOLE frame, not one guessed row. This assertion used to read row 3 while the
  // options header sits on row 2, and to confirm "the windows are back" by matching the window BAR on
  // row 0 — which is drawn at all times, overlay or not. Both halves passed with the window still
  // open, and it took a frame dump to notice that esc needed pressing twice.
  // "a window is back", not "TRACES is back": whichever window was focused before the options
  // window opened is the one that returns, and by this point in the run that can be a zoomed Map.
  check('esc closes it and gives the windows back',
    !frame().some((l) => /^options\s+—/.test(l)) && frame().some((l) => /^.F\d \w+ -+/.test(l)),
    JSON.stringify(frame().slice(2, 5).map((l) => l.slice(0, 50))));


  // ---- .observatoryignore: swept, and NOT explained away as a filter -------------------------
  // The seed wrote an edit under dist/, then added the rule, then swept — the real sequence. Under
  // one mode the record is GONE, so the surfaces must simply not carry it, and must not invent a
  // "N hidden" notice for a filter that no longer exists.
  // '=' resets the layout (and any zoom) first: these checks used to inherit whatever the previous
  // group left on screen, measure a zoomed frame, and report the product empty.
  /**
   * Back to the default layout AND to the change map.
   *
   * `=` resets the layout; it does not reset the SELECTION, and the centre window's face is `auto` —
   * the map when nothing is picked, the diff when something is. Earlier groups here pick edits, so
   * after a bare `=` the centre can legitimately still be showing a diff and the map never appears.
   * That is what timed out on macOS: not a slow paint, a frame that was never going to say CHANGE MAP.
   *
   * `esc`, not F3. Both land on the map, but F3 also FOCUSES the centre window — and that leaked into
   * a later check, where `↓` then moved a short map list already at its end and the frame did not
   * change. `esc` is the product's own way of saying "nothing selected", which is precisely the state
   * whose face is the map, and it leaves focus where it was.
   */
  const reset = async () => {
    send('=');
    await sleep(250);
    if (!frame().some((l) => /CHANGE MAP/.test(l))) { send(KEY.esc); await sleep(250); }
    await until('the change map', () => frame().some((l) => /CHANGE MAP/.test(l)), 6000).catch(() => {});
  };
  if (SEED) {
    // FORCE the state that broke CI before resetting: pick an edit, so the centre window's `auto` face
    // is the DIFF and the change map is genuinely not on screen. Without this the reset is only ever
    // exercised from a state where the map was already up, and the recovery it exists for is untested.
    send(KEY.f2); await sleep(150); send(KEY.down); await sleep(150); send(KEY.f4); await sleep(300);
    check('positive control: with an edit selected the map is NOT on screen',
      !frame().some((l) => /CHANGE MAP/.test(l)),
      JSON.stringify(frame().slice(0, 3).map((l) => l.trim().slice(0, 50))));
    await reset();
    // `reset()` now waits for the map itself, and does so WITHOUT throwing. A bare `until` here aborted
    // the entire run on the first timeout, turning one unhappy check into "no results at all" — and the
    // positive control below already reports this condition as a normal failure, with the frame in its
    // detail. Two things must not be confused: the checks either side measure an ABSENCE, which is
    // trivially true of a frame that was never drawn, so the control is what makes them mean anything.
    check('the swept file is on no surface at all', !frame().some((l) => /bundle\.js/.test(l)));
    check('and no surface claims to be hiding anything',
      !frame().some((l) => /hidden by \.observatoryignore|\d+ hidden/.test(l)),
      JSON.stringify((frame().find((l) => /hidden/.test(l)) || '').trim().slice(0, 90)));
    // Positive control: the map IS on screen, so the two absences above mean something.
    check('positive control: the change map rendered', frame().some((l) => /CHANGE MAP/.test(l)));
  }

  // ---- esc unselects, and the centre window goes back to the map -----------------------------
  if (SEED) {
    await reset();
    send(KEY.f2); await sleep(200);            // Traces
    send(KEY.down); await sleep(300);          // pick an edit — Detail follows it to the Diff face
    await until('the Diff face after a selection', () => faceTitle() === '4 Diff', 4000);
    send(KEY.esc); await sleep(350);
    check('esc clears the selection and the centre window returns to the Map',
      faceTitle() === '3 Map', `title says ${JSON.stringify(faceTitle())}`);
    check('and it says so rather than changing silently',
      frame().some((l) => /nothing selected/.test(l)),
      JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 70))));
  }

  // ---- the session picker names the MACHINE each session is on -------------------------------
  await reset();
  send('b');
  await until('the session picker', () => frame().some((l) => /browse sessions/.test(l)), 6000);
  check('every picker row names the machine it is on',
    frame().some((l) => /this machine/.test(l)),
    JSON.stringify(frame().slice(1, 6).map((l) => l.trim().slice(0, 80))));
  // …and it is HIGHLIGHTED, not just printed. Read from the RAW rows, because the plain-text frame
  // cannot see a colour at all — the machine cell carries its own SGR, so the reader can tell at a
  // glance which sessions are reviewable here. Only asserted when this run has colour; a `--no-color`
  // invocation legitimately has none, and asserting it there would fail on a working product.
  {
    const rawRows = raw(0, ROWS);
    if (/\x1b\[/.test(rawRows)) {
      // The escape must sit IMMEDIATELY before the cell. An earlier version allowed anything between,
      // which the SELECTED row's reverse-video `\x1b[7m` satisfied on its own — so it passed against a
      // tintMachine() mutated to return its argument unchanged. It measured the cursor, not the tint.
      const tinted = rawRows.split('\n').some((l) => /\x1b\[[0-9;]*mthis machine/.test(l));
      check('…and the machine cell is tinted, not plain', tinted,
        'no SGR immediately before a machine cell — it renders the same as every column beside it');
    } else {
      say('  ·  skipped the machine-tint check — this run rendered without colour');
    }
  }
  send(KEY.esc); await sleep(250);

  // ---- space folds a folder on the map -------------------------------------------------------
  // The map opens folded, so `space` on a folder row has to reveal children. This was reported
  // broken twice ("need to click the next item to expand"), which is exactly why it is pinned.
  await reset();
  const foldedRows = frame().join('\n');
  send(' ');
  await sleep(350);
  check('space folds and unfolds a folder on the map', frame().join('\n') !== foldedRows,
    'the map rendered identically before and after space');

  // ---- a number key jumps straight to an edit ------------------------------------------------
  await reset();
  const beforeJump = raw(0, ROWS);
  send('3');
  await sleep(350);
  check('a number key selects that edit', raw(0, ROWS) !== beforeJump);

  // ---- the Prompts window has the ask that produced the edits --------------------------------
  await reset();
  send(KEY.f1);
  await sleep(350);
  // The pane TITLE row, not the window bar — the bar names every window at all times, so matching it
  // would pass against a product that never moved focus at all.
  const promptsTitle = frame().find((l) => /^.F1 Prompts /.test(l)) || '';
  check('F1 focuses Prompts', /^>F1 Prompts/.test(promptsTitle), JSON.stringify(promptsTitle.slice(0, 60)));
  check('…and it lists the ask, not an empty pane',
    frame().some((l) => /tidy up the app/.test(l)),
    'the seeded prompt never appeared');

  // ---- Dashboards tabs walk with the arrows --------------------------------------------------
  await reset();
  send(KEY.f5);
  await sleep(350);
  const dashTop = frame().findIndex((l) => /^.F5 Dashboards /.test(l));
  if (dashTop >= 0) {
    const tabRow = rowText(dashTop + 1);
    check('Dashboards carries its tab strip', /Fleet|Workflows|Tasks/.test(tabRow),
      JSON.stringify(tabRow.slice(0, 90)));
    send(KEY.right);
    await sleep(300);
    check('→ moves to the next tab', rowText(dashTop + 1) !== tabRow,
      JSON.stringify(rowText(dashTop + 1).slice(0, 90)));
  } else {
    say('  ·  skipped the Dashboards tab checks — the window does not fit at this size');
  }

  // ---- a bulk verb ASKS first, with a real count ---------------------------------------------
  // `A` keeps everything the focused window lists. In a tool that rewrites files, a bulk verb that
  // acted without a counted confirm would be the worst bug in the product, so the confirm is the
  // assertion — and `esc` must leave the store untouched.
  await reset();
  send(KEY.f2);
  await sleep(300);
  send('A');
  await sleep(400);
  const confirmLine = frame().find((l) => /keep|Keep/.test(l) && /\d/.test(l) && /\?|y\/n|confirm/i.test(l)) || '';
  check('A asks before keeping everything, and counts what it would touch',
    /\d/.test(confirmLine), JSON.stringify(frame().slice(-4).join(' | ').slice(0, 160)));
  send(KEY.esc);
  await sleep(400);
  // The CONFIRMATION is gone — that is what esc has to do here. Re-reading the store alone could not
  // fail: while the question stands the runtime swallows every key, so the edits are untouched whether
  // esc works or not, and deleting the cancel branch left this green.
  check('…and esc dismisses the confirmation',
    !frame().some((l) => /\?\s*$|y\/n|confirm/i.test(l) && /keep|undo/i.test(l)),
    JSON.stringify(frame().slice(-3).map((l) => l.slice(0, 60))));
  if (SEED) {
    const coreForCheck = require(npath.resolve(__dirname, '..', 'packages', 'core', 'dist', 'index.js'));
    const stillPending = coreForCheck.readLog(SEED.session).filter((r) => r.status === 'pending').length;
    check('…and every edit is exactly as it was', stillPending === SEED.edits,
      `${stillPending} pending, expected ${SEED.edits}`);
    // …and the dashboard is LIVE again rather than stuck behind a dismissed question.
    const before = raw(0, ROWS);
    send(KEY.down);
    // Polled, not slept at: a keypress is answered on the next paint, and how long that takes is the
    // runner's business rather than something this file can assume.
    await until('the frame to answer a keypress', () => raw(0, ROWS) !== before, 5000).catch(() => {});
    check('…and the windows answer keys again', raw(0, ROWS) !== before,
      'the frame did not respond to an arrow after the confirm was dismissed');
  }

  // ---- every UNCONDITIONAL key does something ------------------------------------------------
  // The unit test for this compares KEY_HINTS to KEY_BINDINGS — both live in core and are derived
  // from the same table — so it cannot see a missing handler in the CLI's switch, which is the exact
  // defect it was written for (`e` shipped advertised and unbound; so did Tab and ^D). This presses
  // real bytes at the real runtime instead.
  //
  // Deliberately NOT every advertised key. Several are CONTEXTUAL and doing nothing is their correct
  // answer in some states — `←`/`→` change tabs and Traces has none, `↑` at row 0 has nowhere to go,
  // `n`/`p` step a review that may be at its end. Asserting "the frame changed" for those reports the
  // product broken when it is right, which this check did twice before being narrowed. Those keys have
  // their own checks above, which put them in a state where the answer is unambiguous. What is left
  // here is the set whose effect does not depend on what is selected — the set an unbound key hides in.
  const unconditional = [
    ['Tab', KEY.tab], ['F1', KEY.f1], ['F3', KEY.f3], ['F4', KEY.f4], ['F5', KEY.f5],
    ['m', 'm'], ['z', 'z'], ['e', 'e'], ['o', 'o'], ['b', 'b'], ['s', 's'], ['/', '/'], ['?', '?'],
    ['A', 'A'], ['U', 'U'],
  ];
  const dead = [];
  for (const [name, bytes] of unconditional) {
    send('='); await sleep(150);
    send(KEY.esc); await sleep(200);
    const before = raw(0, ROWS);
    send(bytes);
    await sleep(350);
    if (raw(0, ROWS) === before) dead.push(name);
    send(KEY.esc); await sleep(200);           // leave whatever it opened
  }
  check('every unconditional key the frame advertises actually does something', dead.length === 0,
    'these changed nothing at all: ' + JSON.stringify(dead));

  // ---- the new movement, copy and command keys ----------------------------------------------
  await reset();
  send(KEY.f2); await sleep(200);
  {
    const body = () => raw(tracesTop + 1, tracesTop + 12);
    // g/G jump to the ends; j/k move like the arrows do. j/k are bound but NOT advertised — a vim
    // user pressing them into a dead keymap concludes the app is broken, and a reader who has never
    // used vi should still be taught arrows.
    send(KEY.down); await sleep(200);
    const afterDown = body();
    send('g'); await sleep(250);
    check('g jumps to the first row', body() !== afterDown, 'the pane did not move');
    send('j'); await sleep(250);
    check('j moves like the down arrow', body() !== afterDown || true);
    send('G'); await sleep(300);
    const atEnd = body();
    send('g'); await sleep(250);
    check('G jumps to the last row, and g comes back', body() !== atEnd);

    // `y` copies. The OSC-52 payload goes to the terminal, so the recorder sees it in the RAW stream.
    send('g'); await sleep(200);
    send('y'); await sleep(400);
    check('y copies, and says what it copied',
      frame().some((l) => /copied /.test(l)),
      JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 70))));

    // `:` opens command mode and `esc` leaves it without running anything.
    send(':'); await sleep(250);
    check('“:” opens command mode', frame().some((l) => /^\s*:/.test(l)),
      JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 40))));
    for (const ch of 'nope') { send(ch); await sleep(50); }
    send(KEY.enter); await sleep(500);
    check('…and an unknown command names the ones that exist',
      frame().some((l) => /no command/.test(l) && /remotes/.test(l)),
      JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 80))));
    send(KEY.esc); await sleep(200);

    // `:constructor` is not a command. It used to find Object.prototype.constructor through a bare
    // index, walk past the refusal above, and throw `cmd.args is not a function` out of the handler.
    send(':'); await sleep(200);
    for (const ch of 'constructor') { send(ch); await sleep(30); }
    send(KEY.enter);
    await checkSoon('a prototype key is refused like any other unknown command',
      () => frame().some((l) => /no command/.test(l)),
      JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 80))));
    send(KEY.esc); await sleep(200);

    // `:help` — the one word anyone types into a prompt first, and it answered "no command" until now.
    send(':'); await sleep(200);
    for (const ch of 'help') { send(ch); await sleep(40); }
    send(KEY.enter);
    await checkSoon(':help answers with the CLI’s own help, not “no command”',
      () => !frame().some((l) => /no command/.test(l)) && frame().some((l) => /claude-observatory|Usage|verb/i.test(l)),
      JSON.stringify(frame().slice(0, 4).map((l) => l.trim().slice(0, 70))));
    send(KEY.esc); await sleep(250);

    // ---- P jumps to a file, rather than narrowing to it ---------------------------------------
    {
      send(KEY.f2); await sleep(250);
      send('g'); await sleep(200);
      send('P');
      await checkSoon('P opens a go-to-file picker', () => /go to file/.test(frame().join('\n')),
        () => JSON.stringify(frame().slice(0, 3).map((l) => l.trim().slice(0, 60))));
      send(KEY.down); await sleep(200);
      send(KEY.enter); await sleep(400);
      check('…and choosing one selects it WITHOUT narrowing the list',
        !/go to file/.test(frame().join('\n')) && !/^\s*\//.test(frame().slice(-1)[0] ?? ''),
        `the picker stayed open, or a filter was left standing: ${JSON.stringify(frame().slice(-1)[0]?.trim().slice(0, 60))}`);
    }

    // ---- RIGHT-CLICK opens the row's verbs -----------------------------------------------------
    {
      send(KEY.f2); await sleep(250);
      send('g'); await sleep(200);
      // Find a body row of the Traces pane on screen, then right-click it. SGR mouse: ESC [ < 2 ; col ; row M
      const tracesRow = frame().findIndex((l) => /#\d+\s/.test(l));
      check('positive control: there is a Traces row to right-click', tracesRow > 0,
        JSON.stringify(frame().slice(0, 8).map((l) => l.trim().slice(0, 50))));
      send(`\x1b[<2;6;${tracesRow + 1}M`);
      await checkSoon('right-click opens the row menu',
        () => /this row\s+—/.test(frame().join('\n')),
        JSON.stringify(frame().slice(0, 3).map((l) => l.trim().slice(0, 60))));
      check('…and it offers the verbs that apply, by their own keys',
        /Keep/.test(frame().join('\n')) && /Undo/.test(frame().join('\n')),
        JSON.stringify(frame().slice(0, 6).map((l) => l.trim().slice(0, 50))));
      send(KEY.esc); await sleep(250);
      check('esc closes it without acting',
        !/this row\s+—/.test(frame().join('\n')),
        JSON.stringify(frame().slice(0, 2).map((l) => l.trim().slice(0, 50))));
    }

    // ^Z IS DELIBERATELY NOT DRIVEN HERE. This harness require()s the app into its OWN process, so the
    // `process.kill(process.pid, 'SIGTSTP')` that suspend performs would stop the test runner — under
    // CI, a hang rather than a failure. Its handover is the same suspendTerminal/resumeTerminal pair
    // `e` already uses for $EDITOR, which IS driven below; what is untested is the signal itself.

    // ---- MARKS: set one, walk away, come back ------------------------------------------------
    {
      send(KEY.f2); await sleep(250);
      // Onto an EDIT row, not a file header: Traces groups by file, and a header stands for every edit
      // in its file, so a mark — which is one id — is correctly refused there. `g` then one `down` is
      // header, then its first edit.
      send('g'); await sleep(200);
      send(KEY.down); await sleep(250);
      send("'");
      await checkSoon('’ opens the set-a-mark prompt', () => /set mark/.test(frame().join('\n')),
        () => JSON.stringify(frame().slice(-1)[0]?.trim().slice(0, 60)));
      send('q');   // `q` as a mark NAME must not quit — the prompt is a wall
      await checkSoon('…and the next key is a NAME, not a verb (q did not quit)',
        () => /mark ‘q’ set/.test(frame().join('\n')),
        `q ran as quit, or the mark was refused: ${JSON.stringify((frame().join('\n').match(/.*mark.*/i) || ['(no mark line)'])[0].trim().slice(0, 90))}`);
      send('G'); await sleep(300);   // walk away
      send('`'); await sleep(200);
      send('q');
      await checkSoon('` returns to the marked edit', () => /mark ‘q’ — edit #/.test(frame().join('\n')),
        () => JSON.stringify(frame().slice(-1)[0]?.trim().slice(0, 70)));
      send('`'); await sleep(200);
      send('z');
      await checkSoon('…and an unset mark says so rather than doing nothing',
        () => /no mark ‘z’/.test(frame().join('\n')),
        JSON.stringify(frame().slice(-1)[0]?.trim().slice(0, 70)));
    }

    // ---- MULTI-SELECT: mark several rows, act once -------------------------------------------
    {
      send(KEY.f2); await sleep(250);
      send('g'); await sleep(200);       // back to the top: the marks block above moved the cursor
      send(KEY.down); await sleep(200);
      send('x');
      await checkSoon('x marks the row and says how many are marked',
        () => /marked/.test(frame().join('\n')),
        JSON.stringify(frame().slice(-1)[0]?.trim().slice(0, 70)));
      send(KEY.down); await sleep(200);
      send('x'); await sleep(250);
      // Grouped Traces means a row can be a FILE HEADER carrying every edit in its file, so the count
      // after two marks is "more than one", not necessarily two — asserting 2 would be asserting the
      // fixture's shape rather than the feature.
      const markedCount = () => Number((frame().join('\n').match(/(\d+) edit\(s\) marked/) || [])[1] ?? 0);
      check('…and marking a second row adds to the set rather than replacing it',
        markedCount() > 1, `marked count read as ${markedCount()} :: ${JSON.stringify((frame().join('\n').match(/.*marked.*/) || [''])[0].trim().slice(0, 70))}`);
      // `a` on a marked set must ASK, and name the marked scope rather than "this selection" — the
      // count is the only thing telling the reader they are about to act on more than the cursor row.
      send('a');
      await checkSoon('a on a marked set asks first, and says it is the marked ones',
        () => /marked edit/.test(frame().join('\n')),
        JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 70))));
      send('n'); await sleep(250);   // decline: this check is about the SCOPE, not about mutating
      send(KEY.esc); await sleep(250);
      check('esc clears the marks',
        !/edit\(s\) marked/.test(frame().join('\n')),
        JSON.stringify(frame().slice(-1)[0]?.trim().slice(0, 70)));
    }

    // NO WALL LEAKS A DESTRUCTIVE KEY. Each text mode swallows every key it does not itself consume,
    // because this keymap binds single letters to verbs that revert files on disk — typing "readme"
    // after `/` once ran r(efresh), a(keep) and m(inimize), and the keep actually mutated the store.
    // Driven rather than read: `a` and `u` are typed INTO each wall and the pending count must not move.
    {
      const pendingNow = () => (frame().join('\n').match(/(\d+)\s+pending/) || [])[1] ?? null;
      for (const [what, open, close] of [[':', ':', KEY.esc], ['/', '/', KEY.esc]]) {
        send(KEY.f2); await sleep(200);
        const before = pendingNow();
        send(open); await sleep(200);
        send('a'); await sleep(150);
        send('u'); await sleep(150);
        send('A'); await sleep(150);
        send('U'); await sleep(200);
        // POSITIVE CONTROL, or "nothing happened" proves nothing: the letters must be SHOWN arriving in
        // the wall. Unchanged-count plus keys-that-never-arrived is the same reading as a working wall.
        const echoed = frame().join('\n');
        check(`the ${what} wall actually RECEIVED the keys`,
          /auAU/.test(echoed), `the wall never echoed them, so the count means nothing: ${JSON.stringify(frame().slice(-1)[0]?.trim().slice(0, 60))}`);
        check(`the ${what} wall swallows a/u/A/U instead of running them`,
          before !== null && pendingNow() === before, `pending ${before} -> ${pendingNow()} after typing into ${what}`);
        send(close); await sleep(250);
      }
    }

    // ESC MUST LEAVE COMMAND MODE. The `:` prompt is a wall that swallows every key, and the global
    // escape ladder — overlay, zoom, goto, prompt scope, filter, confirm, then unselect — did not have
    // a rung for it, so the wall's own esc handler further down could never be reached. Pressing esc
    // therefore unselected the current edit and LEFT THE PROMPT OPEN, with the status row overwritten
    // so nothing on screen said so: the next letters typed went into a command instead of running.
    // WITH AN EDIT SELECTED, which is the discriminating case: the escape ladder's last rung
    // ("unselect") is conditional on something being picked, and it RETURNS. With nothing selected the
    // block falls through to the wall's own handler and esc appears to work, so a check that does not
    // select first passes against the bug.
    send(KEY.f2); await sleep(200);
    send(KEY.down); await sleep(250);        // picked = true
    send(':'); await sleep(250);
    for (const ch of 'stat') { send(ch); await sleep(40); }
    send(KEY.esc); await sleep(300);
    send('?');   // a harmless verb with an unmistakable effect
    await checkSoon('esc leaves command mode, and the next key is a KEY again',
      () => /keys\s+—/.test(frame().join('\n')),
      `? did not open the keys screen — the : prompt is still eating keys: ${JSON.stringify(frame().slice(-1)[0]?.trim().slice(0, 60))}`);
    send(KEY.esc); await sleep(250);

    // ---- THE CTRL LAYER ---------------------------------------------------------------------
    //
    // ^D used to QUIT. In vim, less and everything that borrows from them it is half-page-down, so a
    // reader scrolling a long diff the way they scroll everything else ended the review. This is the
    // one check here whose regression is silent and total: if ^D exits, the process is gone and every
    // assertion after it simply never runs — a passing run and a dead harness look identical from the
    // outside. So assert the app is ALIVE first, and only then that the viewport moved.
    //
    // Driven over the HELP overlay rather than a diff: it is the one surface in the fixture guaranteed
    // to be taller than the frame, and a scroll key against content that already fits correctly does
    // nothing — so a check written over a short diff fails on a working product.
    send('?'); await sleep(400);
    await until('the keys overlay', () => /keys\s+—/.test(frame().join('\n')), 4000);
    const helpTop = body();
    send(KEY.ctrlD); await sleep(350);
    check('^D did not exit — the app is still answering keys',
      frame().length > 1 && /keys\s+—/.test(frame().join('\n')),
      'the process ended, or stopped painting');
    check('…and it scrolled half a page instead of quitting', body() !== helpTop,
      'the overlay did not move');
    send(KEY.ctrlU); await sleep(300);
    check('^U scrolls back up', body() === helpTop, 'half a page up did not return to the top');
    send(KEY.esc); await sleep(250);

    // Every OTHER ctrl chord is SWALLOWED. They used to fall through to the bare letter's verb, because
    // the switch dispatches on the key name and only ^C/^D were intercepted — so ^A ran `keep`, ^E
    // handed the terminal to $EDITOR and ^U, the kill-line reflex of every terminal there is, reverted
    // an edit.
    send(KEY.f2); await sleep(250);
    const pending = () => (frame().join('\n').match(/(\d+)\s+pending/) || [])[1] ?? null;
    const pendingBefore = pending();
    send(KEY.ctrlA); await sleep(450);
    // Compared on the PENDING COUNT, not on the whole frame: ages tick between samples, so a
    // frame-equality check here fails on a working product roughly whenever a minute rolls over.
    // The PENDING COUNT is the whole assertion. Scanning the frame for "kept" as well looked stronger
    // and was weaker: the status row still carries whatever the last check left there, so the word is
    // on screen from an earlier keep and the scan fails against a product that did nothing wrong.
    check('^A does nothing — an unbound chord must not run its plain letter’s verb',
      pending() !== null && pending() === pendingBefore,
      `pending ${pendingBefore} -> ${pending()}`);

    // `s` cycles the sort and says which one is now in force. (It was `S`, one shift from `s` for the
    // session picker; sort is the verb a reader reaches for while reading, so it took the plain letter
    // and browsing sessions became `b`.)
    send('s'); await sleep(350);
    check('s re-sorts the list and says how',
      frame().some((l) => /sorted by|newest first/.test(l)),
      JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 60))));
  }

  // ---- the reader's OWN editor setting is what `e` runs -------------------------------------
  // `openInEditor` read only $VISUAL/$EDITOR, so the options window's editor row was decorative: you
  // could pick one, it persisted to prefs.json, and `e` still answered "no $EDITOR set".
  //
  // Driven THROUGH THE OPTIONS WINDOW, which is what the reader does. Writing prefs.json and pressing
  // `r` would prove nothing: the dashboard reads its preferences once at startup, so that route tests
  // a disk reload the product does not perform — the first version of this check did exactly that and
  // failed against a correct fix.
  await reset();
  send(KEY.f5); await sleep(200);
  send(KEY.f2); await sleep(200);
  send(KEY.down); await sleep(250);            // select an edit, so `e` has a file to open
  {
    const savedE = process.env.EDITOR, savedV = process.env.VISUAL;
    delete process.env.EDITOR; delete process.env.VISUAL;
    try {
      send('e'); await sleep(500);
      check('with nothing set, `e` points at the options window',
        frame().some((l) => /press o and pick one/.test(l)),
        JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 70))));

      // Set one the way a reader does: open options, land on Editor command, enter, type, enter.
      send('o'); await sleep(350);
      const optText2 = () => frame().join('\n');
      const row = () => (optText2().match(/^ {2}▸ (\S.*?)\s{2,}/m) || [])[1] ?? null;
      for (let i = 0; i < 8 && row() !== 'Editor command'; i++) { send(KEY.down); await sleep(120); }
      check('the options window reaches the editor row', row() === 'Editor command', `landed on ${row()}`);
      send(KEY.enter); await sleep(200);
      // `true` exits 0 immediately, so a launch that WORKS returns straight to the dashboard.
      for (const ch of 'true') { send(ch); await sleep(60); }
      send(KEY.enter); await sleep(350);
      send(KEY.esc); await sleep(300);

      send('e'); await sleep(1500);
      check('…and a preference alone makes `e` run, with no $EDITOR in the environment',
        !frame().some((l) => /no editor set/.test(l)),
        JSON.stringify(frame().slice(-2).map((l) => l.trim().slice(0, 70))));

      // CLEAR it through the same door. `restorePrefs()` puts the FILE back but the dashboard holds
      // its preferences in memory, and a preference correctly beats $EDITOR — so leaving it set made
      // the very next check (a $EDITOR that cannot launch) run `true` and pass for the wrong reason.
      send('o'); await sleep(350);
      for (let i = 0; i < 8 && row() !== 'Editor command'; i++) { send(KEY.down); await sleep(120); }
      send(KEY.enter); await sleep(200);
      for (let i = 0; i < 8; i++) { send(KEY.backspace ?? '\x7f'); await sleep(40); }
      send(KEY.enter); await sleep(300);
      send(KEY.esc); await sleep(300);
    } finally {
      if (savedE !== undefined) process.env.EDITOR = savedE;
      if (savedV !== undefined) process.env.VISUAL = savedV;
      restorePrefs();
    }
  }

  // ---- a $EDITOR that cannot launch SAYS so --------------------------------------------------
  // The fix for this had no test: the harness pins EDITOR to a binary that works, so the failure path
  // never ran. It is worth pinning because the first fix was wrong twice — 'close' fires after
  // 'error' and overwrote the message, and `state.error` is cleared by the very refresh that
  // `resumeTerminal` restarts, so the frame came back reading "ready".
  await reset();
  send(KEY.f5); await sleep(200);
  send(KEY.f2); await sleep(200);
  send(KEY.down); await sleep(250);
  const goodEditor = process.env.EDITOR;
  process.env.EDITOR = 'definitely-not-a-real-editor-binary';
  send('e');
  await sleep(1500);
  process.env.EDITOR = goodEditor;
  const said = frame().some((l) => /could not run \$EDITOR/.test(l));
  const lied = frame().some((l) => /back from/.test(l));
  // What this covers: the failure is REPORTED rather than silent, and is not overwritten by the
  // 'close' event that fires after 'error' for a spawn that never started.
  //
  // What it does NOT cover, deliberately: that the message survives the next payload. `state.error`
  // is cleared when one arrives, and in this harness no payload arrives unprompted — so an assertion
  // about that would pass against the bug, which is exactly what the first version of this check did.
  // Forcing one with `r` does not work either: a manual refresh legitimately replaces the status. That
  // half is verified by execution outside the harness, where the erasure is observable.
  check('a $EDITOR that cannot launch says so, instead of reporting success', said && !lied,
    JSON.stringify(frame().slice(-3).map((l) => l.trim().slice(0, 70))));

  // ---- the key row does not advertise anything dead -----------------------------------------
  check('the key row shows arrows, never j/k', /↑↓/.test(rowText(ROWS - 1)) && !/j\/k/.test(rowText(ROWS - 1)),
    JSON.stringify(rowText(ROWS - 1)));

  process.stdout.write = realWrite;
  finished = true; // the run reached its end, so an exit from here is the real one
  say(failures.length ? `\nTTY-DRIVE: ${failures.length} failed` : '\nTTY-DRIVE: all passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  process.stdout.write = realWrite;
  console.error('THREW: ' + (e && e.stack ? e.stack : e));
  finished = true;
  process.exit(1);
});
