/**
 * `dash` — the terminal dashboard.
 *
 * Five windows over one session — Claude, Prompts, Traces and Dashboards docked around Detail — with the same
 * review operations the editors have. Everything that can be a value is one: the frame comes from
 * `renderDashFrame`, a pure function, and this file is only the runtime around it — terminal
 * setup, key decoding, and the guarantee that the terminal is handed back intact no matter how the
 * process ends.
 *
 * The restore path is the part worth being paranoid about. A dashboard that exits leaving the alternate
 * screen active, the cursor hidden, or stdin in raw mode leaves the user with a shell that echoes
 * nothing and looks broken, with no hint that this program did it.
 */
import * as fs from 'fs';
import * as path from 'path';
// helpLines() is module-level so a test can read it; it cannot reach the `core` handle the app is
// constructed with, so it takes the keymap straight from the settings layer.
import { keymap as coreKeymap } from '@claude-observatory/core';
// The rendering half of this package. `core` stays a PARAMETER — it is the data layer, and
// injecting it is what lets the app be driven against a fixture store in tests.
import {
  BAR_ENTRIES,
  PANE_SPECS,
  TAB_SCREEN,
  applyOption,
  buildMapTree,
  colorDepth as detectColorDepth,
  createDecoder,
  defaultMinimized,
  detailFace,
  detailNavButtons,
  displayWidth,
  glyphTier,
  glyphs as glyphSet,
  hitTest,
  latchMinimized,
  mapRowActions,
  mapRows,
  optionRows,
  paneListRows,
  paneRowCount,
  paneScreenOf,
  paneVisible,
  promptRowActions,
  renderDashFrame,
  renderOptions,
  resolveLayout,
  rowsFor,
  selectableRows,
  selectionIds,
  setOption,
  tint,
  setTheme,
} from './index';
import type {
  Layout,
  ColorDepth,
  DashState,
  PaneId,
  PaneBox,
  DashRow,
  InputEvent,
} from './index';


type Core = typeof import('@claude-observatory/core');
type Backend = import('./backend').Backend;

/**
 * The keys this runtime binds live in core, as `KEY_BINDINGS`, beside the hint strings that
 * advertise them — what the frame promises and what this file answers are two halves of one
 * contract, and a test that cannot see both halves cannot check it. Every `case` below must appear
 * in that set under the name the decoder emits.
 */

/** Which views each screen needs. Asking for only these keeps a payload that reached 11.7 MB on a real
 *  session down to what is actually being rendered. */
const BASE = ['changemap', 'risk', 'egress', 'multitask', 'sessions'];
const VIEWS_FOR: Record<string, string[]> = {
  edits: [...BASE, 'list'],
  map: BASE,
  prompts: [...BASE, 'prompts'],
  tasks: BASE,
  workflows: BASE,
  agents: BASE,
  feed: [...BASE, 'feed'],
  audit: BASE,
  // The pane model added these two screens; without an entry here `viewsForLayoutOf` never asks for
  // the view, the payload arrives without it, and the pane renders an honest-looking "(0)". A missing
  // allow-list entry and a genuinely empty result are indistinguishable on screen, which is exactly
  // the failure this product forbids.
  observations: [...BASE, 'observations'],
  processes: [...BASE, 'processes'],
  // The Claude strip reads only views BASE already carries (sessions · multitask · changemap) plus
  // the prompts list for the newest ask. Review's PATCHES ride their own debounced spawn (`review
  // --prompt` needs a prompt id, and `views` hands ONE argument list to every view it batches — so
  // threading the id through would retarget the others and respawn the whole batch per selection).
  claude: [...BASE, 'prompts', 'feed'],
};

const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const PASTE_ON = '\x1b[?2004h';
const PASTE_OFF = '\x1b[?2004l';
/** SGR extended mouse reporting (1006) plus button-event tracking (1002). 1006 matters: the legacy
 *  encoding cannot express a column past 223, so a wide terminal silently reports the wrong cell. */
const MOUSE_ON = '\x1b[?1002h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l';
const FOCUS_ON = '\x1b[?1004h';
const FOCUS_OFF = '\x1b[?1004l';

/**
 * What to poll, keyed on the resolved LAYOUT rather than on one screen. A minimized pane genuinely
 * stops being fetched, so closing a window makes the poll cheaper instead of merely quieter. The
 * measured payloads make this load-bearing: `changemap` alone is 1.39 MB on a real session.
 */
function viewsForLayoutOf(core: Core, lay: Layout): string[] {
  const want = new Set(BASE);
  for (const box of lay.boxes) {
    const screen = TAB_SCREEN[box.id][box.selTab] ?? TAB_SCREEN[box.id][0];
    for (const v of VIEWS_FOR[screen] ?? []) want.add(v);
  }
  return [...want];
}

export function runTui(core: Core, args: string[], resolveSession: (a: string[]) => string): void {
  const flag = (name: string): string | null => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : null;
  };
  const once = args.includes('--once');
  // The reader's saved settings. A FLAG still wins over a preference, and the environment still wins
  // over both where it is an instruction rather than a default (NO_COLOR): the precedence is
  // flag > preference > environment, and it is applied here once rather than at each use.
  let prefs = core.readPrefs();
  // Before the first paint, not after: applying the theme later would flash the default palette on
  // startup for anyone who had chosen another one.
  setTheme(prefs.theme);
  const keys = (): Map<string, import('@claude-observatory/core').Action> => core.keymap(prefs);
  // Mouse tracking takes click-drag away from the terminal's own text selection, which is how people
  // copy things. `--no-mouse` turns it off for a session; most terminals also restore selection while
  // shift is held.
  let mouse = !args.includes('--no-mouse') && prefs.mouse !== false;
  // NO_COLOR is an explicit instruction from the environment; a surface that carries meaning in hue
  // has to obey it. `--no-color` remains as the per-invocation override.
  let colorDepth: ColorDepth = args.includes('--no-color')
    ? 'none'
    : process.env.NO_COLOR
      ? 'none'
      : prefs.color && prefs.color !== 'auto'
        ? prefs.color
        : detectColorDepth(process.env, Boolean(process.stdout.isTTY));
  let glyphs = glyphSet(prefs.glyphs && prefs.glyphs !== 'auto' ? prefs.glyphs : glyphTier(process.env));
  // `||`, never `??`: a TTY can report `columns === 0`, which `??` would pass straight through as a
  // real width. (`??` also cannot be mixed with `||` without parentheses.)
  const cols = Number(flag('--cols')) || process.stdout.columns || 100;
  const rows = Number(flag('--rows')) || process.stdout.rows || 30;
  const cwd = flag('--root') || process.cwd();
  /** The newest session already hinted about, so the status line says each newcomer ONCE. */
  let newerSessionHinted: string | null = null;
  let newerSessionCheckedAt = 0;
  /** The frame as last painted — what drag-to-copy extracts from, so the copied text is exactly
   *  what was on screen when the reader selected it. */
  let lastPainted: string[] = [];
  /** An armed text selection: a left press on a body cell that may become a drag-to-copy. */
  let textDrag: { startRow: number; lastRow: number; moved: boolean } | null = null;

  const session = resolveSession(args);

  const state: DashState = {
    views: null,
    screen: 'edits',
    cursor: 0,
    scroll: 0,
    session,
    sessionTitle: '',
    filter: '',
    // The STORED order, applied on the first frame. Reading it only when `S` is pressed would make a
    // persisted setting one that does nothing until you change it again.
    sort: prefs.sort ?? 'recent',
    marked: new Set<number>(),
    syntax: prefs.syntax === true,
    // The reader's keymap, so the frame can name a key instead of hard-coding a letter. Refreshed on
    // every save below, or a rebind made in the options window would not reach the surfaces that
    // advertise it until the next launch.
    keys: keys(),
    status: 'starting…',
    error: null,
    confirm: null,
    now: Date.now(),
    watcherMode: 'native',
    open: new Set<string>(),
    promptScope: null,
    overlay: null,
    panes: {
      minimized: defaultMinimized(cols, rows),
      zoom: null,
      // Both come from the reader's settings. `auto` leaves `tab.detail` unset, which is what makes
      // the centre window open on the change map until an edit is picked — the default, and what a
      // session with nothing selected always wants.
      focus: prefs.startFocus ?? 'traces',
      tab: prefs.startFace === 'map' ? { detail: 1 } : prefs.startFace === 'diff' ? { detail: 0 } : {},
      cursor: {},
      scroll: {},
      sizes: {},
    },
    goto: null,
  };

  // Non-interactive: one frame, plain, exit 0. `--once` is how CI and a pipe use this at all, and the
  // check must include stdin — `isTTY()` elsewhere in this CLI looks only at stdout, and a piped stdin
  // means `setRawMode` does not exist and would throw a TypeError instead of explaining itself.
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !once;
  if (!interactive) {
    const backend = createOnce(
      core, cwd, session,
      viewsForLayoutOf(core, resolveLayout({
        cols, rows, minimized: state.panes!.minimized, zoom: null, focus: 'traces', tab: {},
      }))
    );
    void backend.then((views) => {
      state.views = views;
      state.now = Date.now();
      state.status = views ? `${session.slice(0, 8)} · one frame (--once)` : 'no view data for this session';
      for (const line of renderDashFrame(state, { cols, rows, color: colorDepth, glyphs })) {
        process.stdout.write(line + '\n');
      }
    });
    return;
  }

  let restored = false;
  let filterOpen = false;
  let drag: {
    target: PaneId;
    axis: 'v' | 'h';
    sign: 1 | -1;
    start: number;
    startExtent: number;
    /** True while this is only a POSSIBLE drag: the press landed on a pane's own top edge, which is
     *  also a focus target. It becomes a real resize on the first motion and a plain click if the
     *  button comes up without any. A dock's title row is where a reader reaches to resize it — the
     *  one-row seam above it is invisible, and "I cannot resize this" is what that costs. */
    pending?: boolean;
  } | null = null;
  /** True once the reader has actually chosen an edit — moved the cursor, clicked a row, or typed an
   *  id. Until then the dashboard opens on the change map with nothing selected, which is the view
   *  that answers "what happened here" before you have picked anything to answer it about. */
  let picked = false;
  /** Command mode's buffer, and whether it owns the keyboard. */
  let cmdBuf = '';
  let cmdOpen = false;
  /** Find-in-diff's buffer, and whether it owns the keyboard. */
  let diffFind = '';
  let diffFindOpen = false;
  /** The options window's own state, or null when it is closed. Declared HERE, beside the rest of
   *  the runtime's state, because `paint` reads it — and `paint` runs once during setup, before any
   *  declaration further down the function body has initialised. A `let` down beside its handlers
   *  read beautifully and crashed the first frame with a temporal-dead-zone error. */
  let options: { cursor: number; scroll: number; capture: null | { id: string; kind: 'text' | 'key'; buf: string } } | null = null;
  /** Whether the overlay currently on screen is the OPTIONS window — so the paint knows whose layer
   *  to take down, and never clears a picker that happens to be open instead. */
  let optionsShown = false;
  let backend: Backend | null = null;
  let tick: NodeJS.Timeout | null = null;
  let repaintTimer: NodeJS.Timeout | null = null;

  /**
   * Hand the terminal back. Idempotent, and wired to every exit path there is.
   *
   * `writeSync` on fd 1 because the stream object may already be torn down inside an 'exit' handler,
   * and wrapped because on a hangup this very write is what raises EPIPE.
   */
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (tick) clearInterval(tick);
    if (repaintTimer) clearTimeout(repaintTimer);
    backend?.close();
    try {
      if (process.stdin.isTTY) {
        process.stdin.removeAllListeners('data');
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
    } catch {
      /* nothing left to restore */
    }
    try {
      fs.writeSync(1, PASTE_OFF + MOUSE_OFF + FOCUS_OFF + CURSOR_SHOW + ALT_OFF);
    } catch {
      /* the pipe is gone; the terminal state went with it */
    }
  };

  process.on('exit', restore);
  // SIGTERM, SIGHUP and SIGQUIT do NOT run 'exit' handlers, so each needs its own. SIGINT is handled
  // both ways: raw mode stops the tty driver turning ^C into a signal (so the decoder reads 0x03), but
  // an explicitly sent SIGINT still arrives here.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      restore();
      process.exit(0);
    });
  }
  process.on('uncaughtException', (e) => {
    restore(); // restore FIRST, so the error is readable in a working terminal
    process.stderr.write(`dash: ${e?.stack || e}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    restore();
    process.stderr.write(`dash: ${String(e)}\n`);
    process.exit(1);
  });

  let frameCols = cols;
  let frameRows = rows;
  let dirty = true;
  const REPAINT_FLOOR_MS = 60; // ~16 fps; TTY writes are blocking, so this is a budget on the key loop

  // Declared before `paint`, which calls syncDetailDiff on the first frame. These are `let`, so they
  // sit in a temporal dead zone until this line runs — and `syncDetailDiff` is a hoisted function
  // declaration, callable earlier. That combination crashed the interactive launch on frame one,
  // while `--once` never noticed because it renders without going through `paint`.
  let diffTimer: NodeJS.Timeout | null = null;
  let diffWanted = -1;

  const paint = (): void => {
    if (restored) return;
    state.now = Date.now();
    state.watcherMode = backend?.watcherMode() ?? 'native';
    if (backend?.updateSkew() && !state.error) state.status = 'the CLI was updated — restart dash to pick up the new build';
    // The focused pane's cursor lives in `state.cursor` so every existing helper keeps working; it is
    // mirrored into the per-pane maps here, at the one place that cannot be forgotten.
    if (state.panes) { syncPane(); syncDetailDiff(); }
    // The options window is a LAYER, painted through the same overlay slot the pickers use, so there
    // is one modal mechanism in this runtime rather than two that drift apart.
    //
    // The mirroring runs BOTH ways. It used to be write-only: closing the window set `options` to
    // null but left the overlay it had painted standing, so the window stayed on screen and `esc`
    // — which the window's own title advertises as "esc close" — appeared to do nothing. The second
    // press then fell through to onKey's generic closeOverlay and cleared the leftover. Two presses
    // to close a window that says one.
    if (!options && optionsShown) {
      state.overlay = null;
      optionsShown = false;
    }
    if (options) {
      optionsShown = true;
      const rows = optRows();
      const cap = options.capture;
      state.overlay = {
        title: cap
          ? cap.kind === 'key'
            ? 'press the key you want  —  esc keeps the current one'
            : `${rows[options.cursor]?.label ?? 'value'}: ${cap.buf}_   —  enter saves · esc cancels`
          // A measured ladder, never a cut: the widest form that FITS. The path used to ride here and
          // was chopped by the fitter at any ordinary width, which is exactly what this product
          // refuses to do to a path. It has its own row now, at the foot of the list.
          : ([
              'options  —  ↑↓ move · ←→ change · enter edit · esc close',
              'options  —  ↑↓ · ←→ · enter · esc',
              'options',
            ].find((t) => displayWidth(t) <= frameCols - 1) ?? 'options'),
        lines: renderOptions(rows, options.cursor, frameCols, options.scroll, Math.max(1, frameRows - 5), glyphs, colorDepth),
        scroll: 0,
      };
    }
    const lines = renderDashFrame(state, { cols: frameCols, rows: frameRows, color: colorDepth, glyphs });
    lastPainted = lines; // drag-to-copy reads the frame the reader actually selected from
    // Home, then clear each line as it is written. Never \x1b[2J: erasing the whole screen before
    // drawing is what makes a repaint flicker.
    let buf = '\x1b[H';
    for (let i = 0; i < lines.length; i++) buf += `\x1b[${i + 1};1H\x1b[K` + lines[i];
    process.stdout.write(buf);
  };

  const schedulePaint = (): void => {
    dirty = true;
    if (repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (dirty) {
        dirty = false;
        paint();
      }
    }, REPAINT_FLOOR_MS);
    repaintTimer.unref?.();
  };

  const refreshSize = (): void => {
    // Re-reading process.stdout.columns is a NO-OP: getWindowSize() returns the cached pair and only
    // _refreshSize() issues the syscall. Calling it also emits 'resize' itself, which covers both the
    // normal path and a terminal that never delivers SIGWINCH.
    try {
      (process.stdout as unknown as { _refreshSize?: () => void })._refreshSize?.();
    } catch {
      /* not available on this platform — the 'resize' listener below still applies */
    }
    frameCols = process.stdout.columns || frameCols;
    frameRows = process.stdout.rows || frameRows;
  };
  process.stdout.on('resize', () => {
    refreshSize();
    schedulePaint();
  });

  const startBackend = (): void => {
    // Close the outgoing one FIRST. Without this, toggling "Show ignored edits" left the previous
    // backend fully alive — its filesystem watcher still firing and its `onData` listener still
    // writing into the same `state` — so the next store write made both spawn `views`, and the stale
    // one's payload (computed under the OPPOSITE filter setting) landed on screen. Measured: one
    // store event produced children from every backend ever created, one leak per toggle, and the
    // header flipped between "5 files · 5 edits" and "…· 1 hidden by .observatoryignore" while the
    // setting sat unchanged. Worse than the flicker: a scoped confirm counts rows from whatever
    // payload is showing while the verb runs under the CURRENT setting, so "1 edit(s) under …" could
    // revert two files, one of them never displayed.
    backend?.close();
    backend = require('./backend').createBackend({
      core,
      cwd,
      session,
      onDegrade: (why: string) => {
        state.status = why; // never silent
        schedulePaint();
      },
    }) as Backend;
    // Registered HERE, not once at startup: toggling "Show ignored edits" builds a new backend, and a
    // listener attached to the old one would leave the dashboard on its last frame forever.
    backend.onData((payload, err) => {
      // From the PAYLOAD, not from this process: every view is built by a spawned child, so the
      // matcher that discovers an unreadable ignore file lives there. Reading our own copy here was
      // reading a map nothing in this process ever populates — the report never fired.
      const igProblems = payload && Array.isArray((payload as Record<string, unknown>).__ignoreProblems)
        ? ((payload as Record<string, unknown>).__ignoreProblems as string[])
        : [];
      if (igProblems.length) state.status = igProblems[0];
      if (payload) {
        // A long-lived dashboard resolves its session ONCE at launch; sessions started after that
        // would go unnoticed forever. When the reader did not pin one with --session, say — once per
        // newcomer — that a newer session is live. Never auto-switch: yanking the store out from
        // under an open review would lose the reader's place mid-decision.
        // Throttled to every 30s: outside a repo this is a machine-wide transcript scan (readdir +
        // stat of every session), and running it on every 3-second tick was a measurable drag.
        if (!args.includes('--session') && !process.env.CLAUDE_OBSERVATORY_SESSION && Date.now() - newerSessionCheckedAt > 30_000) {
          newerSessionCheckedAt = Date.now();
          // The SAME scope the launch default used (core.defaultTuiSession): inside a repo, that
          // workspace's newest; outside any repo, the machine-wide newest.
          const newest = core.defaultTuiSession(cwd);
          if (newest && newest !== state.session && newest !== newerSessionHinted) {
            newerSessionHinted = newest;
            state.status = 'a newer session is live — press b to switch';
          }
        }
        const follow = claudeAtTail(); // sampled against the frame the reader was actually looking at
        state.views = payload;
        const cm = payload.changemap as { summary?: { title?: string } } | null;
        state.sessionTitle = cm?.summary?.title || '';
        state.error = null;
        if (state.status === 'starting…') state.status = 'ready';
        if (follow) followClaudeTail();
      }
      if (err) state.error = err;
      clampCursor();
      schedulePaint();
    });
  };
  startBackend();

  /**
   * Bound the cursor to the FOCUSED PANE's own row count and scroll it within the PANE's body.
   * Clamping a pane's cursor against the whole terminal's height let j/k walk the selection past the
   * bottom of a 19-row window, so the highlighted row and the row `a`/`u` would act on were different
   * rows. `scroll` is a ROW index, matching `paneVisible`.
   */
  /**
   * The Claude pane is a LIVE TAIL: whenever fresh views land it re-pins to its newest row, so the
   * session's activity reads bottom-up like any tail. A reader INSIDE the pane keeps their place —
   * unless they sit on the LAST row, which is the follow position: `G` (or any walk to the bottom)
   * genuinely re-latches, exactly as the help and DEMO say. `claudeAtTail()` samples the OLD rows
   * before a refresh swaps them, because "was the reader at the bottom" is a fact about the frame
   * they were looking at, not the one that just arrived.
   */
  const claudeAtTail = (): boolean => {
    if (!state.panes || state.panes.focus !== 'claude') return true; // unfocused always follows
    const box = layout().boxes.find((b) => b.id === 'claude');
    if (!box) return true;
    const rows = paneRowCount(state, box);
    return !rows || state.cursor >= rows - 1;
  };

  const followClaudeTail = (): void => {
    if (!state.panes) return;
    const box = layout().boxes.find((b) => b.id === 'claude');
    if (!box) return;
    const rows = paneRowCount(state, box);
    if (!rows) return;
    state.panes = {
      ...state.panes,
      // SCROLL follows; the CURSOR moves only when the reader is IN the pane. An unfocused pane
      // paints its persisted cursor as a faint band, so dragging it to the newest row every refresh
      // put a moving "second selection" on screen beside whatever the reader actually clicked.
      cursor: state.panes.focus === 'claude' ? { ...state.panes.cursor, claude: rows - 1 } : state.panes.cursor,
      scroll: { ...state.panes.scroll, claude: Math.max(0, rows - paneListRows(state, box)) },
    };
    if (state.panes.focus === 'claude') state.cursor = rows - 1; // the live cursor is the focused one
  };

  /** True when the focused pane is a SCROLLER — a diff is read top to bottom, not picked from — so
   *  there is no cursor to clamp and `scroll` is bounded by the viewport instead. */
  const scrollerBox = (): PaneBox | null => {
    if (!state.panes) return null;
    const box = layout().boxes.find((b) => b.id === state.panes!.focus);
    return box && paneScreenOf(state, box) === 'diff' ? box : null;
  };

  const clampCursor = (): void => {
    const box = state.panes ? layout().boxes.find((b) => b.id === state.panes!.focus) : null;
    const sc = scrollerBox();
    if (sc) {
      // Bounded by the LAST FULL SCREEN, not by the line count: stopping at `n - 1` would let the
      // reader scroll a long diff until one line was left above an empty pane.
      const max = Math.max(0, paneRowCount(state, sc) - sc.body.h);
      state.cursor = 0;
      state.scroll = Math.min(max, Math.max(0, state.scroll));
      return;
    }
    const n = box ? paneRowCount(state, box) : state.views ? rowsFor(state).length : 0;
    if (state.cursor >= n) state.cursor = Math.max(0, n - 1);
    if (state.cursor < 0) state.cursor = 0;
    // The viewport is the pane's body LESS whatever fixed lines it draws above the list (a hint, the
    // map's legend). Counting those as list rows made the bottom entry unreachable: the cursor could
    // reach it and the viewport could not show it.
    const body = Math.max(1, box ? paneListRows(state, box) : frameRows - 5);
    if (state.cursor < state.scroll) state.scroll = state.cursor;
    if (state.cursor >= state.scroll + body) state.scroll = state.cursor - body + 1;
    if (state.scroll > state.cursor) state.scroll = state.cursor;
    if (state.scroll < 0) state.scroll = 0;
  };

  /**
   * The workspace the SESSION belongs to — not the directory this terminal happens to be in.
   *
   * The fleet is derived by correlating the repo's git worktrees, and `views` resolves that from
   * `--root`, defaulting to `process.cwd()`. So a dashboard launched anywhere but inside the
   * workspace — or pointed at a session from a different one via the picker — showed an EMPTY Fleet
   * while every other pane worked, because the rest read the store by session id and only this one
   * reads the filesystem. Measured on one session: 40 agents from inside the repo, 0 from `/tmp`.
   *
   * The session's real cwd is recorded in the first line of its own transcript, which is append-only,
   * so this is a fact about the session rather than a guess. Cached by core. When it cannot be
   * resolved — a remote session, a transcript not on this machine — `--root` is omitted and the old
   * cwd default applies, which is no worse than before.
   */
  const sessionRoot = (): string | null => {
    try {
      return core.sessionWorkspace(state.session);
    } catch {
      return null;
    }
  };

  const ask = (): void => {
    const root = sessionRoot();
    backend!.request(viewsForLayoutOf(core, layout()), state.session, root ? ['--root', root] : []);
  };

  /**
   * The screen the FOCUSED pane is showing, through the same resolver the renderer uses.
   *
   * `state.screen` is not that. It is a leftover from the single-screen product, it is only updated
   * on some focus changes, and it cannot name Detail's faces at all — so anything that reads it to
   * decide what the reader is looking at is reading a different pane's list. Two live defects came
   * out of exactly that: the arrows stepped the map's cursor over the edit list's rows, and focusing
   * Detail cleared the face the reader had just chosen.
   */
  const focusedScreen = (): string => {
    if (!state.panes) return state.screen;
    const box = layout().boxes.find((b) => b.id === state.panes!.focus);
    return box ? paneScreenOf(state, box) : state.screen;
  };

  /**
   * The rows of one pane, computed at the width that pane is DRAWN at.
   *
   * `rowsFor` defaults to 100 columns, which is a rendering width, not a neutral one: the change
   * map wraps a long folder name onto continuation rows, so a Detail pane 78 columns wide has a
   * different row LIST from the same data at 100. Every keyboard resolver that used the default was
   * therefore indexing a list the reader was not looking at — Enter folded the wrong node, and rows
   * past the first wrap were unreachable. The mouse path always passed the real width; the keyboard
   * path did not.
   */
  const rowsOf = (screen?: string, pane?: PaneId): DashRow[] => {
    const id = pane ?? state.panes?.focus;
    const box = id ? layout().boxes.find((b) => b.id === id) : undefined;
    return rowsFor(
      { ...state, screen: (screen ?? focusedScreen()) as typeof state.screen },
      Math.max(1, (box?.rect.w ?? frameCols) - 1),
      glyphs,
    );
  };

  /** Which of Detail's two faces is on screen, resolved through the SAME function the renderer uses. */
  const detailShows = (): 'diff' | 'map' | null => {
    const box = state.panes ? layout().boxes.find((b) => b.id === 'detail') : null;
    return box ? (paneScreenOf(state, box) as 'diff' | 'map') : null;
  };

  /**
   * The change-map node a DISPLAY row index points at.
   *
   * Resolved by PATH, not by position. `rowsFor` emits one display row per rendered line — a name too
   * wide for the pane occupies several — while `mapRows` emits one entry per node, so the two index
   * spaces diverge the moment any name wraps. Indexing the tree with a display index therefore acted
   * on a different file than the one under the cursor, and in this tool that means reverting
   * something nobody pointed at. `openPath` is on the display row precisely so this never has to
   * count.
   */
  const mapNodeAt = (rowIndex: number): { path: string; pending: number; isFile: boolean } | null => {
    const box = layout().boxes.find((b) => b.id === 'detail');
    const rows = rowsFor(
      { ...state, screen: 'map' },
      Math.max(1, (box?.rect.w ?? frameCols) - 1),
      glyphs
    );
    const path = rows[rowIndex]?.openPath;
    if (path === undefined) return null;
    const cm = (view(state, 'changemap') as { files?: unknown[] } | null)?.files;
    if (!Array.isArray(cm)) return null;
    const hit = mapRows(buildMapTree(cm as never), state.open).find((r) => r.node.path === path);
    return hit ? { path: hit.node.path, pending: hit.node.pending, isFile: hit.node.isFile } : null;
  };

  /** The change-map node under Detail's cursor, with the totals its actions need. */
  const selectedMapNode = () => mapNodeAt(state.panes?.cursor?.detail ?? 0);

  /**
   * The Keep/Undo cell under a click on the map, or null.
   *
   * Resolved through `mapRowActions` — the same function that laid the cells out — at the same width
   * the row was rendered at. Recomputing the columns here is how an action ends up drawn on one row
   * and pressable on another, and this one reverts a whole folder.
   */
  const mapActionAt = (
    box: PaneBox,
    rowIndex: number,
    col: number
  ): { action: 'keep' | 'undo'; node: { path: string; pending: number; isFile: boolean } } | null => {
    const node = mapNodeAt(rowIndex);
    if (!node) return null;
    const cm = (view(state, 'changemap') as { files?: unknown[] } | null)?.files;
    const row = Array.isArray(cm)
      ? mapRows(buildMapTree(cm as never), state.open).find((r) => r.node.path === node.path)
      : null;
    if (!row) return null;
    const inner = Math.max(1, box.rect.w - 1);
    const local = col - box.body.x - 1; // the cursor gutter is column 0 of every body row
    const hit = mapRowActions(row, inner).find((a) => local >= a.x && local < a.x + a.w);
    return hit ? { action: hit.action, node } : null;
  };

  /**
   * The [review] cell under a click on a Prompts row, or null — resolved through `promptRowActions`,
   * the same function that laid the cell out, at the same width. Same contract as `mapActionAt`: one
   * function owns the geometry, so the glyph and the pointer cannot disagree.
   */
  const promptActionAt = (box: PaneBox, col: number): boolean => {
    const inner = Math.max(1, box.rect.w - 1);
    const local = col - box.body.x - 1; // the cursor gutter is column 0 of every body row
    return promptRowActions(inner).some((a) => local >= a.x && local < a.x + a.w);
  };

  /** Swap Detail's face, explicitly. `null` hands it back to following the selection. */
  const setDetailFace = (face: 0 | 1 | null): void => {
    clearFind(); // the Map face is not the patch the find ran over
    const tab = { ...state.panes!.tab };
    if (face === null) delete (tab as Record<string, unknown>).detail;
    else tab.detail = face;
    state.panes = { ...state.panes!, tab, focus: 'detail' };
    state.cursor = state.panes.cursor.detail ?? 0;
    state.scroll = state.panes.scroll.detail ?? 0;
    clampCursor();
    ask();
    schedulePaint();
  };

  /**
   * Report a finished mutation the same way whatever its scope was — one place, one wording.
   *
   * REFUSALS are named, not folded into the count. `undoScope` returns three separate numbers —
   * `undone`, `conflicts` and `errors` — and an engine refusal (the #43 phantom guard, an unlink
   * that fails) lands in `errors` with its reason in `firstError`. Reporting only the first two
   * turns "every edit here refused, and here is why" into a bare "undo: 0 edit(s)", which reads as
   * "there was nothing to do".
   */
  const reportMutation = (verb: string, asked: number) => (r: { ok: boolean; json: unknown; err: string | null }) => {
    const j = (r.json ?? {}) as Record<string, unknown>;
    if (!r.ok) state.error = r.err;
    else if (typeof j.status === 'string') {
      // The single-unit verbs answer the engine's own result — its message IS the report, and a
      // refusal arrives named (dependents, closure) rather than as a count.
      const msg = typeof j.message === 'string' ? j.message : '';
      state.status = j.status === 'conflict' ? `conflict — ${msg.split('. ')[0]}` : msg || `${verb}: done`;
    } else {
      const n = Number(j.kept ?? j.undone ?? j.redone ?? asked) || 0;
      const conflicts = Number(j.conflicts ?? 0) || 0;
      const errors = Number(j.errors ?? 0) || 0;
      const first = typeof j.firstError === 'string' ? j.firstError : '';
      // The first conflict's NAMING sentence only — the CLI-flavoured remedy tail stays off the
      // status row (`u` on the named unit is one keystroke away here).
      const conflictName = (typeof j.firstConflict === 'string' ? j.firstConflict : '').split('. ')[0];
      const parts = [`${verb}: ${n} edit(s)`];
      if (conflicts)
        parts.push(
          conflictName
            ? `${conflicts} conflict(s) — ${conflictName}`
            : `${conflicts} conflict(s) left — act on them one at a time to force`
        );
      if (errors) parts.push(`${errors} refused${first ? ` — ${first}` : ''}`);
      state.status = parts.join(' · ');
    }
    ask(); // a mutation always forces a fresh read; stale counts must not outlive the action
    schedulePaint();
  };

  const applyUnder = (verb: 'keep' | 'undo', under: string): void => {
    state.status = `${verb}ing everything under ${under}…`;
    schedulePaint();
    void backend!.mutateUnder(verb, under, state.session).then(reportMutation(verb, 0));
  };

  const applyMutation = (verb: 'keep' | 'undo' | 'redo', ids: number[]): void => {
    state.status = `${verb}ing ${ids.length} edit(s)…`;
    schedulePaint();
    // Through `reportMutation`, like the scoped path: it inlined a copy of that function's body, so
    // the "one place, one wording" its doc comment promises was true of the rarer caller only, and
    // every keyboard keep/undo/redo took the copy that had drifted.
    // The marks are SPENT here. Leaving them standing means the next `a` silently re-acts on edits the
    // reader already dealt with, and the set is not on screen once its rows have gone.
    state.marked = new Set<number>();
    void backend!.mutate(verb, ids, state.session).then(reportMutation(verb, ids.length));
  };

  /**
   * Keep or undo everything beneath one change-map node.
   *
   * `--under <path>` is the CLI's own file-or-folder scope, so this spends ONE process and shares the
   * exact rule the editors' folder Accept uses. It always asks first with the real count: a folder
   * row can stand for hundreds of edits, and the number is the only thing that tells the reader
   * whether they are about to revert one file or a package.
   */
  const mutateUnder = (verb: 'keep' | 'undo', node: { path: string; pending: number; isFile: boolean }): void => {
    if (!node.pending) {
      state.status = `nothing pending under ${node.path} — there is nothing to ${verb}`;
      return schedulePaint();
    }
    state.confirm = {
      verb,
      ids: [],
      under: node.path,
      label: `${node.pending} edit(s) under ${node.isFile ? '' : 'everything in '}${node.path}`,
    };
    schedulePaint();
  };

  const mutateScope = (verb: 'keep' | 'undo' | 'redo', scope: 'one' | 'all'): void => {
    // `state.screen` cannot represent the Diff face, so focusPane leaves it on whatever the previous
    // window showed. Without this guard, pressing `a`/`u` with Detail focused silently kept or UNDID
    // an edit in the Traces list — a row the reader was not looking at, in a tool that reverts code.
    // The navbar's Keep/Undo act on the edit Detail is SHOWING. Detail's face is the diff, so the
    // guard below would refuse — but here the target is unambiguous, so resolve it directly.
    if (scope === 'one' && state.diffMeta && state.panes?.focus === 'detail' && detailShows() === 'diff') {
      return applyMutation(verb, [state.diffMeta.id]);
    }
    // On the Map face the cursor is on a FILE OR FOLDER, and keep/undo act on its whole subtree.
    if (scope === 'one' && verb !== 'redo' && detailShows() === 'map' && state.panes?.focus === 'detail') {
      const node = selectedMapNode();
      if (node) return mutateUnder(verb, node);
    }
    // The focused pane's box, which CAN be absent: a minimized window has none, and neither does one
    // the current size cannot fit. The `!` that used to stand here was a lie, and `paneScreenOf` then
    // dereferenced undefined — so `m` followed by `a` killed the dashboard outright, as did pressing
    // `a` with Prompts or Dashboards focused at any height under ~24 rows, where they fold onto the
    // bar by default. Every other `boxes.find` in this file already guards; this was the one that did
    // not, and the crash reached a keystroke that reverts code.
    const focusedBox = state.panes ? layout().boxes.find((b) => b.id === state.panes!.focus) : undefined;
    if (state.panes && !focusedBox) {
      const spec = PANE_SPECS.find((p) => p.id === state.panes!.focus);
      state.status = `${spec?.title ?? 'that window'} is not open at this size — press its key to restore it, or = to reset the layout`;
      return schedulePaint();
    }
    if (focusedBox && paneScreenOf(state, focusedBox) === 'diff') {
      state.status = `Detail is showing a diff — press F3 for Traces to ${verb} an edit`;
      return schedulePaint();
    }
    // The FOCUSED pane's screen, not `state.screen` — acting on a list the reader is not looking at
    // is the worst thing a tool that reverts code can do.
    const screen = focusedScreen() as typeof state.screen;
    // A MARKED set wins over the cursor for the single-row scope: marking six files and pressing `a`
    // is the whole point of marking, and acting on the one row under the cursor instead would revert
    // the reader's intent silently. `A`/`U` still mean "everything this window lists" — a mark set is
    // a narrowing, and having the everything-verb honour it would leave no way to say "all of them".
    const marks = [...(state.marked ?? [])];
    const ids = scope === 'one' && marks.length ? marks : selectionIds({ ...state, screen }, scope);
    if (ids.length === 0) {
      // Never a silent no-op: say WHY this screen cannot resolve an edit set.
      state.status =
        screen === 'audit' || screen === 'feed' || screen === 'agents'
          ? `${screen} rows are observations, not edits — use Traces or Prompts to ${verb}`
          : 'nothing selected';
      schedulePaint();
      return;
    }
    if (scope === 'all' || ids.length > 1) {
      const what = scope === 'all' ? 'every row listed' : marks.length ? `the ${marks.length} marked edit(s)` : 'this selection';
      state.confirm = { verb, ids, label: `${what} on ${screen}` };
      schedulePaint();
      return;
    }
    applyMutation(verb, ids);
  };

  /**
   * Hand the terminal to a CHILD, then take it back.
   *
   * Not `restore()`: that one is the exit path — it is idempotent-by-latch, closes the backend and
   * kills the timers, so calling it here would leave a dashboard that never repaints again. This
   * pair touches only the modes a child program needs owned: raw mode, the alternate screen, mouse
   * and paste reporting.
   */
  const enterTerminal = (): void => {
    process.stdout.write(ALT_ON + CURSOR_HIDE + PASTE_ON + MOUSE_OFF + (mouse ? MOUSE_ON : '') + FOCUS_ON);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
  };
  const suspendTerminal = (): void => {
    // Remembered across the handover so `resumeTerminal` can say what MOVED while the reader was in
    // $EDITOR — Claude keeps working, and coming back to a changed list with nothing saying so means
    // re-reading the whole pane to find out whether it is the one you left.
    awayPending = pendingCount();
    if (tick) clearInterval(tick);
    tick = null;
    try {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      /* already gone; the child will find out */
    }
    process.stdout.write(PASTE_OFF + MOUSE_OFF + FOCUS_OFF + CURSOR_SHOW + ALT_OFF);
  };
  /** The pending count when the terminal was handed to a child, so coming back can say what moved. */
  let awayPending: number | null = null;

  const resumeTerminal = (): void => {
    enterTerminal();
    refreshSize(); // the child may have been resized, or resized the window itself
    // A failed spawn fires BOTH 'error' and 'close', and each resumes — without this clear the
    // first interval leaks and the dashboard polls (and spawns a CLI) at double rate forever.
    if (tick) clearInterval(tick);
    tick = setInterval(() => {
      ask();
      schedulePaint();
    }, 3000);
    tick.unref?.();
    ask();
    // …and said on the way back in, once the refresh above has landed a fresh payload to compare with.
    const before = awayPending;
    awayPending = null;
    if (before !== null) {
      setTimeout(() => {
        const now = pendingCount();
        if (now !== before) {
          state.status = `back — ${now > before ? `${now - before} new edit(s) while you were away` : `${before - now} fewer pending`}`;
          schedulePaint();
        }
      }, 400);
    }
    paint();
  };

  /** Pending edits in the payload right now, or null when nothing has arrived yet. */
  function pendingCount(): number {
    const list =
      (state.views?.list as { edits?: { status?: string; cancelled?: boolean }[] } | undefined)?.edits ?? [];
    // Cancelled chains are not rows in the pane, so they are not in its counter either — the payload
    // flags them exactly so every renderer can agree on what "pending" means.
    return list.filter((e) => e?.status === 'pending' && e?.cancelled !== true).length;
  }

  /**
   * Open the selected file in `$EDITOR`. Advertised in the key row and the help since this command
   * shipped, and bound to nothing at all until now.
   *
   * The child gets the real terminal, inherited, and this process waits: `$EDITOR` is usually a
   * full-screen program, and handing it a pipe would leave the reader looking at a frozen dashboard
   * while vim waited for input it could not receive.
   */
  function openInEditor(): void {
    const row = rowsOf()[state.cursor];
    const path = state.diffMeta?.path || selectedPath(row);
    if (!path) {
      state.status = 'select an edit first — there is no file here to open';
      return schedulePaint();
    }
    // The READER'S OWN SETTING FIRST, then the environment. This read only the environment, so the
    // options window's editor row was decorative: you could pick one, it persisted to prefs.json, and
    // `e` still answered "no $EDITOR set". The row's own help has always promised this precedence
    // ("Blank follows $VISUAL then $EDITOR") — the key never honoured it.
    const ed = prefs.editor?.trim() || process.env.VISUAL || process.env.EDITOR;
    if (!ed) {
      // Name the fix that is one keystroke away before the one that needs a shell restart.
      state.status = 'no editor set — press o and pick one under EDITOR, or export $EDITOR';
      return schedulePaint();
    }
    // Split on whitespace so `EDITOR="code -w"` works. No shell: a path with a space in it must not
    // become two arguments, and this one comes from the store rather than from the reader.
    const parts = ed.split(/\s+/).filter(Boolean);
    suspendTerminal();
    let child;
    try {
      child = core.spawnTool(parts[0], [...parts.slice(1), path], { stdio: 'inherit', cwd });
    } catch (e) {
      resumeTerminal();
      state.status = `could not run $EDITOR (${ed}): ${String((e as Error)?.message || e)}`;
      return schedulePaint();
    }
    // Node emits BOTH 'error' and 'close' for a spawn that never started, and 'close' arrived last —
    // so the ENOENT was written to `state.error` and then the close handler overwrote the line with
    // "back from code", reporting success for an editor that does not exist. Remember the failure and
    // let it win.
    let failed = '';
    child.on('error', (e: Error) => {
      failed = `could not run $EDITOR (${ed}): ${e.message}`;
      resumeTerminal();
      state.status = failed;
      schedulePaint();
    });
    child.on('close', (code: number | null) => {
      resumeTerminal();
      if (failed) {
        state.status = failed; // the spawn never happened; 'close' says nothing about it
      } else if (code) {
        // A non-zero exit is not a crash of ours, but it is not "back from" either — the reader's
        // editor refused, and the file may be unsaved.
        state.status = `${parts[0]} exited ${code}`;
      } else {
        state.status = `back from ${parts[0]}`;
      }
      schedulePaint();
    });
  }

  /**
   * F1 again: hand the WHOLE terminal to `claude --resume <session>`, in the session's own workspace.
   *
   * The same suspend → spawn(stdio:'inherit') → resume pair `openInEditor` and ^Z use — Claude Code is
   * a full-screen program and gets the real terminal, so typing there is 100% the real CLI: colours,
   * mouse, slash commands, paste, resize. `resumeTerminal` already reports what moved while away,
   * which matters more here than for $EDITOR, because what moved is exactly what Claude just did.
   *
   * Two refusals happen BEFORE any terminal handover, so failing leaves the dashboard exactly where
   * it was:
   *  - no workspace on this machine → refuse. Falling back to the terminal's cwd would launch a
   *    WRITER in the wrong tree, which is strictly worse than not launching.
   *  - the session is LIVE → ask first (the wall below). Resuming a live session opens a second
   *    writer on the same transcript; `--fork-session` is the safe variant, and the reader chooses.
   */
  let claudeAsk: { live: boolean } | null = null;
  function openClaude(): void {
    // Liveness off the payload already on screen — core stamped both fields with its one 60s rule,
    // so this costs no spawn. If NEITHER field arrived, ask anyway and say so: "probably fine" is not
    // a thing this product prints.
    const sess = ((view(state, 'sessions') as { sessions?: Record<string, unknown>[] } | null)?.sessions ?? []).find(
      (s) => String(s.id) === state.session
    );
    const self = ((view(state, 'multitask') as { agents?: Record<string, unknown>[] } | null)?.agents ?? []).find(
      (a) => a.self === true
    );
    const live = sess?.active === true || String(self?.phase ?? '') === 'working';
    const known = sess !== undefined || self !== undefined;
    if (live || !known) {
      claudeAsk = { live };
      state.status = live
        ? 'this session is LIVE — Claude is writing its transcript now.  [r] resume anyway (two writers) · [f] fork a copy · [esc] cancel'
        : 'could not tell if this session is live.  [r] resume · [f] fork a copy · [esc] cancel';
      return schedulePaint();
    }
    launchClaude(false);
  }

  /**
   * KNOWN LIMIT, deliberate for now: while Claude owns the terminal there is no key that returns to
   * the observatory — the handoff is stdio-inherit, so OUR process cannot see keystrokes at all.
   * Exiting Claude (`/exit`, ctrl+c) returns instantly, and F1-F1 relaunches `--resume` just as
   * fast, so the loop is cheap. A true in-place toggle means owning Claude under a PTY and swapping
   * screens — a real feature with a native-dependency decision (node-pty vs the zero-native-deps
   * rule), queued for 0.10 rather than faked here.
   */
  function launchClaude(fork: boolean): void {
    const ws = sessionRoot();
    if (!ws) {
      // Refuse, loudly. This session's transcript is not under any workspace this machine can see —
      // resuming it from some other directory would hand a writer the wrong tree.
      state.status = `this session's workspace is not on this machine — F1 needs it to run Claude there`;
      return schedulePaint();
    }
    const bin = core.resolveClaudeBin();
    const cliArgs = ['--resume', state.session, ...(fork ? ['--fork-session'] : [])];
    suspendTerminal();
    let child;
    try {
      child = core.spawnTool(bin, cliArgs, { stdio: 'inherit', cwd: ws });
    } catch (e) {
      resumeTerminal();
      state.status = `could not run claude (${bin}): ${String((e as Error)?.message || e)} — set $CLAUDE_BIN or install the Claude Code CLI`;
      return schedulePaint();
    }
    // Node emits BOTH 'error' and 'close' for a spawn that never started, and 'close' arrives last —
    // remember the failure and let it win, or an ENOENT is overwritten by "back from Claude".
    let failed = '';
    child.on('error', (e: Error) => {
      failed = `could not run claude (${bin}): ${e.message} — set $CLAUDE_BIN or install the Claude Code CLI`;
      resumeTerminal();
      state.status = failed;
      schedulePaint();
    });
    child.on('close', (code: number | null) => {
      resumeTerminal();
      if (failed) {
        state.status = failed; // the spawn never happened; 'close' says nothing about it
      } else if (code) {
        state.status = `claude exited ${code}`;
      } else {
        state.status = 'back from Claude';
      }
      schedulePaint();
    });
  }

  /** The file a row points at, for the rows that point at one. */
  function rowFile(row: { ids: number[] } | undefined): string {
    if (!row || row.ids.length !== 1) return '';
    const edits = (view(state, 'list') as { edits?: Record<string, unknown>[] } | null)?.edits ?? [];
    const e = edits.find((x) => Number(x.id) === row.ids[0]);
    return String(e?.file ?? '');
  }

  /**
   * The file the SELECTED ROW is about — edit row or file header.
   *
   * `rowFile` answers only for a single-edit row, deliberately: a header addresses every edit in its
   * file, and the verbs that act on ids must not treat it as one. But "which file is this row about"
   * has an obvious answer for a header too, and once Traces grouped by file the header became the row
   * a reader is usually sitting on — so `e` answered "select an edit first" while a path was on
   * screen in front of them. One resolver, so `e` and `y` can never disagree about it.
   */
  function selectedPath(row: { ids: number[]; key?: string } | undefined): string {
    const single = rowFile(row);
    if (single) return single;
    if (row?.key?.startsWith('f') && row.ids.length !== 1) return row.key.slice(1);
    return '';
  }

  // --- terminal setup ---------------------------------------------------------------------------
  enterTerminal();
  refreshSize();
  paint(); // immediately, before any data: a blank terminal for several seconds reads as hung
  ask();
  tick = setInterval(() => {
    ask();
    schedulePaint(); // relTime stamps keep advancing even when nothing on disk moved
  }, 3000);
  tick.unref?.();

  // --- input ---------------------------------------------------------------------------------
  // Decoding is core's incremental decoder, not a per-chunk scan. The terminal splits sequences
  // wherever it likes and sends more than keystrokes — mouse reports, paste wrappers, and unsolicited
  // replies to capability queries. Measured against the old scanner: a background-colour reply arrived
  // as two dozen keys including `1`, a split arrow arrived as `A` (keep everything), and a split paste
  // containing `U` arrived as bulk undo. Over 3,000 randomised split points the scanner leaked a
  // destructive key 886 times; the decoder leaks none.
  const decoder = createDecoder();
  let escTimer: NodeJS.Timeout | null = null;

  const onEvent = (ev: InputEvent): void => {
    if (ev.t === 'reply' || ev.t === 'focus') return; // never keys, by construction
    if (ev.t === 'paste') {
      // A paste is routed to the filter when one is open and DISCARDED otherwise: in raw mode it is
      // indistinguishable from typing, and this keymap binds single letters to destructive verbs.
      if (filterOpen) {
        state.filter += ev.text.replace(/[\r\n]/g, '');
        clampCursor();
        schedulePaint();
      }
      return;
    }
    if (ev.t === 'mouse') return onMouse(ev);
    onKey(ev);
  };

  process.stdin.on('data', (buf: Buffer) => {
    if (escTimer) {
      clearTimeout(escTimer);
      escTimer = null;
    }
    for (const ev of decoder.push(buf)) onEvent(ev);
    // A lone ESC is the Escape KEY only once nothing follows it; otherwise every arrow would fire an
    // Escape first.
    if (decoder.pending() === '\x1b') {
      escTimer = setTimeout(() => {
        escTimer = null;
        for (const ev of decoder.flush()) onEvent(ev);
      }, 50);
      escTimer.unref?.();
    }
  });

  /** The layout this frame is using. Resolved from the same inputs the renderer resolves from, so a
   *  click and a glyph can never disagree about where a pane is. */
  function layout(): Layout {
    const l = resolveLayout({
      cols: frameCols,
      rows: frameRows,
      minimized: state.panes!.minimized,
      zoom: state.panes!.zoom,
      focus: state.panes!.focus,
      tab: state.panes!.tab,
      sizes: state.panes!.sizes,
      // Detail's face changes its CHROME — the map has no action bar — so the box's body starts a row
      // higher. Omitting this resolved a different geometry here than the renderer used, and every
      // click on the map landed one row above the thing under the pointer: clicking a folder opened
      // the one before it.
      detailFace: detailFace(state),
    });
    // The latch: shrinking may force a pane closed, growing never re-opens it behind the reader.
    // `latchMinimized` is shared with the test, so the test cannot pass against a runtime that
    // stopped latching.
    if (l.forced.length) {
      state.panes = { ...state.panes!, minimized: latchMinimized(state.panes!.minimized, l) };
    }
    return l;
  }

  /** The screen behind the focused pane's selected tab. */
  const paneScreen = (id: PaneId): string => {
    const t = state.panes!.tab[id] ?? 0;
    return TAB_SCREEN[id][t] ?? TAB_SCREEN[id][0];
  };

  /** Mirror the focused pane's cursor into the per-pane maps, so every pane keeps its OWN selection.
   *  Three lists on screen means three cursors, and only the focused one is what a keep/undo acts on. */
  function syncPane(): void {
    const f = state.panes!.focus;
    state.panes = {
      ...state.panes!,
      cursor: { ...state.panes!.cursor, [f]: state.cursor },
      scroll: { ...state.panes!.scroll, [f]: state.scroll },
    };
  }

  /** Move focus, restoring the pane if it was minimized, and swap in that pane's own selection. */
  function focusPane(id: PaneId): void {
    syncPane();
    const m = new Set(state.panes!.minimized);
    m.delete(id); // pressing a window's key restores it — the key is how you get it back
    state.panes = { ...state.panes!, minimized: m, focus: id };
    state.cursor = state.panes!.cursor[id] ?? 0;
    state.scroll = state.panes!.scroll[id] ?? 0;
    const sc = paneScreen(id);
    if (sc !== 'diff') state.screen = sc as typeof state.screen;
    // An explicit restore the carve then refuses must SAY so: the resolve latches the pane straight
    // back into `minimized`, and without this line the key silently does nothing. The note names the
    // exact row arithmetic, which is the only actionable answer ("make the terminal taller").
    const l = layout();
    if (l.forced.includes(id)) {
      const title = PANE_SPECS.find((p) => p.id === id)!.title;
      const note = l.notes.find((n) => n.startsWith(title));
      if (note) state.status = note;
    }
    ask();
    schedulePaint();
  }

  /** Zoom a pane to the whole body, or put it back. `zoom` folds into minimize inside `resolveLayout`,
   *  so full screen is not a second layout path — it is the same one with everything else closed. */
  function toggleZoom(id: PaneId): void {
    const on = state.panes!.zoom === id;
    state.panes = { ...state.panes!, zoom: on ? null : id, focus: id };
    state.status = on ? 'ready' : `${PANE_SPECS.find((p) => p.id === id)!.title} full screen — esc back`;
    ask();
    schedulePaint();
  }

  /**
   * Select the edit the reader typed the id of, wherever it is in the list, and show its diff.
   *
   * Resolved against the ROWS rather than against the payload: the row is what the cursor indexes,
   * and an id that is filtered or prompt-scoped out of view has no row to land on. Saying so beats
   * moving a cursor the reader cannot see.
   */
  function gotoEdit(): void {
    const want = Number(state.goto);
    state.goto = null;
    if (!Number.isFinite(want)) return schedulePaint();
    if (state.panes && state.panes.focus !== 'traces') focusPane('traces');
    const rows = rowsOf('edits', 'traces');
    const at = rows.findIndex((r) => !r.cont && r.ids.length === 1 && r.ids[0] === want);
    if (at < 0) {
      state.status = `no edit #${want} in view${state.filter ? ` — /${state.filter} is filtering` : ''}${state.promptScope ? ' — a prompt scope is active, esc clears it' : ''}`;
      return schedulePaint();
    }
    state.cursor = at;
    picked = true;
    state.status = `edit #${want}`;
    clampCursor();
    syncPane();
    syncDetailDiff();
    schedulePaint();
  }

  /** Copy screen rows [a..b] to the system clipboard via OSC 52 — the terminal-native path Claude
   *  Code's own UI uses, working over SSH and tmux alike. Plain text only: escapes stripped, right
   *  edges trimmed. */
  const copyRows = (a: number, b: number): void => {
    const text = lastPainted
      .slice(a, b + 1)
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, ''))
      .join('\n');
    process.stdout.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`);
    state.status = `copied ${b - a + 1} line(s)`;
    schedulePaint();
  };

  // `button` is on the wire and always has been — 0 left, 1 middle, 2 right — it simply was not in
  // this signature, so the right button arrived and was handled as a left click.
  function onMouse(ev: { kind: string; row: number; col: number; button?: number }): void {
    // An armed text selection owns move/up until the button comes up. Checked before the seam drag
    // for the same reason the seam drag is checked before hit-testing: motion leaves the start cell
    // immediately, and the press's own click has ALREADY done its work (selection is instant here).
    if (textDrag) {
      if (ev.kind === 'move') {
        if (ev.row !== textDrag.startRow) textDrag.moved = true;
        textDrag.lastRow = ev.row;
        if (textDrag.moved) {
          state.status = `selecting ${Math.abs(textDrag.lastRow - textDrag.startRow) + 1} line(s) — release to copy`;
          schedulePaint();
        }
        return;
      }
      if (ev.kind === 'up') {
        const td = textDrag;
        textDrag = null;
        if (td.moved) return copyRows(Math.min(td.startRow, td.lastRow), Math.max(td.startRow, td.lastRow));
        return;
      }
    }
    // A drag in progress owns the mouse until the button comes up. Checked FIRST: once the pointer
    // is moving it will leave the seam column almost immediately, and re-hit-testing every motion
    // event would drop the drag the moment it started working.
    if (drag) {
      if (ev.kind === 'up') {
        // A press that never moved is a CLICK, not a zero-pixel resize: the top edge focuses.
        const wasPending = drag.pending;
        const target = drag.target;
        drag = null;
        if (wasPending) return focusPane(target);
        state.status = 'ready';
        schedulePaint();
        return;
      }
      // `'drag'` used to be the other half of this condition and could never be true: MouseKind is
      // down | up | move | wheel-up | wheel-down, and a drag arrives as `move` with a button held.
      if (ev.kind === 'move') {
        const at = drag.axis === 'v' ? ev.col : ev.row;
        if (drag.pending) {
          if (at === drag.start) return; // still a click until the pointer actually moves
          drag = { ...drag, pending: false };
          state.status = `resizing ${PANE_SPECS.find((x) => x.id === drag!.target)!.title} — release to keep, = to reset`;
        }
        return dragTo(at);
      }
      return;
    }
    if (ev.kind === 'wheel-up' || ev.kind === 'wheel-down') {
      // The pane UNDER THE POINTER, not the focused one. Scrolling a window you are not pointing at
      // is the behaviour nobody expects from a wheel, and this app usually has four windows open.
      // Focus follows the scroll so the keyboard lands where the eye already is.
      if (!state.overlay) {
        const box = layout().boxes.find(
          (b) => ev.row >= b.rect.y && ev.row < b.rect.y + b.rect.h && ev.col >= b.rect.x && ev.col < b.rect.x + b.rect.w
        );
        if (box && box.id !== state.panes?.focus) focusPane(box.id);
      }
      return move(ev.kind === 'wheel-up' ? -3 : 3);
    }
    if (ev.kind !== 'down') return;
    if (state.overlay) {
      if (ev.row === 0) return void closeOverlay();
      return;
    }

    // Every mouse target comes out of the SAME hit-test the renderer drew from. Recomputing geometry
    // here is how a click and a glyph drift apart, and the reader has no way to tell that happened.
    const lay0 = layout();
    const hit = hitTest(lay0, ev.col, ev.row);
    if (!hit) return;

    /**
     * RIGHT-CLICK opens the row's verbs, the way k9s and lazygit do.
     *
     * Button 2 in the SGR protocol, which the decoder already reports — this needed no new event kind.
     * It selects the row first, then offers only what applies to it, so the menu can never act on
     * something other than what the reader pointed at. Everything it offers is a key that already
     * exists: this is a door, not a second implementation.
     */
    if (ev.button === 2 && hit.t === 'body') {
      if (hit.pane !== state.panes?.focus) focusPane(hit.pane);
      // Through `paneVisible`, exactly as the left-click path does: `hit.row` is a VISUAL line, and a
      // wrapped row above the pointer makes that a different edit than the one under it. A context
      // menu that acts on the wrong row is worse than no context menu.
      const rbox = layout().boxes.find((b) => b.id === hit.pane);
      if (!rbox) return;
      const rvis = paneVisible(state, rbox, glyphs, colorDepth)[hit.row];
      if (!rvis || rvis.row < 0) return;
      state.cursor = rvis.row;
      picked = true;
      clampCursor();
      syncPane();
      syncDetailDiff();
      const row = rowsOf()[state.cursor];
      const km = keys();
      const keyOf = (action: string): string => { for (const [k, a] of km) if (a === action) return k; return '?'; };
      const items: [string, string][] = [];
      if (row?.ids.length) {
        items.push([keyOf('keep'), `Keep ${row.ids.length === 1 ? `edit #${row.ids[0]}` : `these ${row.ids.length} edits`}`]);
        items.push([keyOf('undo'), `Undo ${row.ids.length === 1 ? `edit #${row.ids[0]}` : `these ${row.ids.length} edits`}`]);
        items.push([keyOf('mark'), 'Mark for a bulk keep or undo']);
      }
      if (selectedPath(row)) items.push([keyOf('copy'), 'Copy the path']);
      if (row?.ids.length === 1) items.push([keyOf('editor'), 'Open in $EDITOR']);
      if (!items.length) {
        state.status = 'nothing to do on this row';
        return schedulePaint();
      }
      state.overlay = {
        title: 'this row  —  ↑↓ move · enter run · esc close',
        lines: items.map(([k, what]) => `  ${k.padEnd(3)} ${what}`),
        scroll: 0,
        cursor: 0,
      };
      rowMenu = items.map(([k]) => k);
      return schedulePaint();
    }

    if (hit.t === 'seam') {
      const sm = lay0.seams[hit.index];
      const box = lay0.boxes.find((b) => b.id === sm.target);
      if (box) {
        drag = {
          target: sm.target,
          axis: sm.axis,
          sign: sm.sign,
          start: sm.axis === 'v' ? ev.col : ev.row,
          startExtent: sm.axis === 'v' ? box.rect.w : box.rect.h,
        };
        state.status = `resizing ${PANE_SPECS.find((x) => x.id === sm.target)!.title} — release to keep, = to reset`;
        schedulePaint();
      }
      return;
    }

    if (hit.t === 'chrome') {
      if (hit.part === 'session') return openSessionPicker(); // the session bar leads the frame
      return;
    }
    if (hit.t === 'windowbar') {
      if (hit.part === 'twig') {
        // The twig cell toggles minimize; the rest of the chip focuses. Two targets, one chip.
        const m = new Set(state.panes!.minimized);
        if (m.has(hit.pane)) m.delete(hit.pane);
        else m.add(hit.pane);
        state.panes = { ...state.panes!, minimized: m, zoom: null };
        ask();
        return schedulePaint();
      }
      // A face chip focuses Detail AND sets the face it names — clicking "Map" and landing on a diff
      // would make the bar a label rather than a control.
      if (hit.face !== undefined) return setDetailFace(hit.face as 0 | 1);
      return focusPane(hit.pane);
    }
    if (hit.t === 'nav') {
      // The action bar has its OWN hit kind now, because `makeBox` reserves its row. It used to be
      // guessed at here as "the title row plus one", which the hit-tester had already classified as
      // body — so this branch never ran and every button was dead to the mouse.
      const box = lay0.boxes.find((b) => b.id === hit.pane);
      const btn = box && detailNavButtons(box, state).find((b) => ev.col >= b.x && ev.col < b.x + b.w);
      if (!btn) return focusPane(hit.pane);
      if (!btn.live) {
        state.status = 'select an edit in Traces first — there is nothing here to keep or undo';
        return schedulePaint();
      }
      if (btn.action === 'keep') return mutateScope('keep', 'one');
      if (btn.action === 'undo') return mutateScope('undo', 'one');
      if (state.panes!.focus !== 'traces') focusPane('traces');
      return move(btn.action === 'next' ? 1 : -1);
    }
    if (hit.t === 'title') {
      // A horizontal dock's title row IS its top edge, so pressing there arms a resize — promoted on
      // the first motion, and released as a plain focus click if the pointer never moved. The
      // one-row seam above it is the geometry's boundary but nothing on screen says so, and reaching
      // for a panel's own edge is the gesture every reader tries first.
      const sm = lay0.seams.find((s) => s.axis === 'h' && s.target === hit.pane);
      const box = sm && lay0.boxes.find((b) => b.id === hit.pane);
      if (sm && box) {
        drag = { target: sm.target, axis: 'h', sign: sm.sign, start: ev.row, startExtent: box.rect.h, pending: true };
        return;
      }
      return focusPane(hit.pane);
    }
    if (hit.t === 'tabscroll') {
      const tabs = PANE_SPECS.find((x) => x.id === hit.pane)!.tabs;
      const at = state.panes!.tab[hit.pane] ?? 0;
      const next = Math.max(0, Math.min(tabs.length - 1, at + hit.dir));
      state.panes = { ...state.panes!, tab: { ...state.panes!.tab, [hit.pane]: next } };
      if (hit.pane === state.panes!.focus) { state.cursor = 0; state.scroll = 0; }
      ask();
      return schedulePaint();
    }
    if (hit.t === 'tab') {
      state.panes = { ...state.panes!, tab: { ...state.panes!.tab, [hit.pane]: hit.index } };
      if (hit.pane !== state.panes!.focus) return focusPane(hit.pane);
      state.cursor = 0;
      state.scroll = 0;
      const sc = paneScreen(hit.pane);
      if (sc !== 'diff') state.screen = sc as typeof state.screen;
      ask();
      return schedulePaint();
    }
    if (hit.t === 'body') {
      // Arm a text selection: if the pointer MOVES before release, the visible span is copied to
      // the clipboard (OSC 52); a press that never moves stays a plain click — which acts instantly,
      // exactly as before.
      if ((ev.button ?? 0) === 0) textDrag = { startRow: ev.row, lastRow: ev.row, moved: false };
      // Focus AND act, in one click. Returning here meant the first click into a pane only moved
      // focus, so selecting took two clicks and expanding a folder took three — which reads exactly
      // like "I have to click the next item to open this one".
      if (hit.pane !== state.panes!.focus) focusPane(hit.pane);
      // Resolve the click through the SAME visual->row map the renderer drew from. Adding the scroll
      // offset to the clicked line number assumed one line per row, so any wrapped row above the
      // pointer shifted the selection onto a different edit than the one under it.
      const box = layout().boxes.find((b) => b.id === hit.pane);
      if (!box) return;
      const vis = paneVisible(state, box, glyphs, colorDepth);
      const v = vis[hit.row];
      if (!v || v.row < 0) return;
      const i = v.row;
      const wasOn = state.cursor; // captured BEFORE the click moves it, for the drill-in test below
      // The change map's own Keep/Undo cells, resolved through the SAME layout the row was drawn
      // from. Checked before the selection changes: clicking ✓ means "keep this row", not "select
      // this row and also keep it", and in a tool that reverts code those must not be the same click.
      if (paneScreenOf(state, box) === 'map') {
        const act = mapActionAt(box, i, ev.col);
        if (act) return mutateUnder(act.action, act.node);
      }
      // The Prompts row's [review] cell — same rule, same ordering: resolved through the function
      // that drew it, and checked before the click becomes a selection.
      if (paneScreenOf(state, box) === 'prompts' && promptActionAt(box, ev.col)) {
        const row0 = rowsOf()[i];
        if (row0?.ids.length) {
          const m = /^#(\d+)/.exec(row0.cells.replace(/\x1b\[[0-9;]*m/g, ''));
          state.cursor = i;
          clampCursor();
          syncPane();
          return openReview(m ? Number(m[1]) : 0, row0.ids);
        }
      }
      // A second click on the row already selected opens it — the drill-in gesture, without a
      // double-click timer that would make every single click feel late.
      if (hit.pane === 'traces') picked = true;
      state.cursor = i;
      clampCursor();
      syncPane();
      // A FOLDER opens on the first click. Toggling a fold shows more of what is already on screen
      // and costs nothing to undo, so making it wait for a second click bought no safety — unlike an
      // edit, where the second click is a real drill-in and worth the confirmation of aiming twice.
      const row = rowsOf()[i];
      if (row?.openPath !== undefined) return openSelected();
      if (wasOn === i) openSelected();
      schedulePaint();
    }
  }

  /**
   * Resize the pane left of the seam to follow the pointer.
   *
   * The width is written into `panes.sizes` and re-resolved, so the reader's number goes through the
   * same clamp as every default: it can never drive a pane below `min`, and it can never squeeze the
   * centre below the width at which a diff stops being a diff. `resolveLayout` is pure, so a drag is
   * just a value changing — there is no separate "dragging" render path to keep in step.
   */
  function dragTo(at: number): void {
    if (!drag || !state.panes) return;
    const next = Math.max(1, drag.startExtent + (at - drag.start) * drag.sign);
    state.panes = { ...state.panes, sizes: { ...state.panes.sizes, [drag.target]: next } };
    clampCursor();
    ask();
    schedulePaint();
  }

  /**
   * Nudge the focused pane along ITS OWN axis, so `--no-mouse` can do everything a drag can.
   *
   * The axis is the pane's dock, not a fixed one: Prompts and Dashboards are horizontal docks whose
   * adjustable extent is HEIGHT, and looking only for a vertical seam meant the keyboard refused
   * them both — "that window has no seam to move" — for two panes the mouse could resize all along.
   */
  function nudgeSize(delta: number): void {
    if (!state.panes) return;
    const id: PaneId = state.panes.focus;
    const lay = layout();
    const axis: 'v' | 'h' = id === 'prompts' || id === 'dashboards' || id === 'claude' ? 'h' : 'v';
    // Detail is the flex centre: a size written for it is discarded, so nudge its neighbour instead
    // and invert, which keeps `<` meaning "the focused pane gets smaller" either way.
    const seam = lay.seams.find((sm) => sm.axis === axis && (sm.target === id || sm.left === id || sm.right === id));
    const target = id === 'detail' ? seam?.target ?? id : id;
    const box = lay.boxes.find((b) => b.id === target);
    if (!box || !seam) {
      state.status = `${PANE_SPECS.find((p) => p.id === id)!.title} has no seam to move at this size`;
      return schedulePaint();
    }
    const invert = target !== id ? -1 : 1;
    const extent = axis === 'v' ? box.rect.w : box.rect.h;
    state.panes = { ...state.panes, sizes: { ...state.panes.sizes, [target]: Math.max(1, extent + delta * invert) } };
    clampCursor();
    ask();
    schedulePaint();
  }



  /**
   * Put one ask under review: scope the Traces EDITS list to exactly its ids — same rows, same
   * keys, ↵ on a unit opens its net diff, esc clears. The editors keep a Review LIST whose diffs
   * open in the editor; in a terminal the filtered list IS that surface. (A dedicated Review tab
   * shipped briefly and was removed: it duplicated this list behind a second fetch cadence, and
   * rebuilding an entire ask's patches per refresh made a large session crawl.)
   */
  function openReview(index: number, ids: readonly number[]): void {
    state.promptScope = { index, ids: new Set(ids) };
    state.status = `prompt #${index} under review — esc clears`;
    focusPane('traces');
  }

  /** Enter / second click: open a map folder, else show the row's edit full screen. */
  function openSelected(): void {
    // The FOCUSED pane's rows. Reading `state.screen` here meant Enter on a change-map folder looked
    // up an EDIT row instead, found no `openPath`, and the folder never expanded.
    const row = rowsOf()[state.cursor];
    if (!row) return;
    // A prompt is a unit of work: opening one puts it UNDER REVIEW — the Traces Edits list scopes to
    // exactly that ask's rows, the terminal's equivalent of the editors' Review list. Focus follows,
    // or the reader would have to guess where the result went.
    if (state.panes && state.panes.focus === 'prompts') {
      const m = /^#(\d+)/.exec(row.cells.replace(/\x1b\[[0-9;]*m/g, ''));
      if (!row.ids.length) {
        // A silent no-op reads as a broken key. Say why there is nothing to open.
        state.status = `ask #${m ? m[1] : '?'} produced no edits — nothing to review`;
        return schedulePaint();
      }
      openReview(m ? Number(m[1]) : 0, row.ids);
      return;
    }
    if (row.openPath !== undefined) {
      const open = new Set(state.open);
      if (open.has(row.openPath)) open.delete(row.openPath);
      else open.add(row.openPath);
      state.open = open;
      schedulePaint();
      return;
    }
    // Opening an edit ZOOMS Detail rather than raising a separate full-screen reader. The overlay it
    // replaces re-printed the `diff` verb's piped output — no bands, no intra-line marks, no syntax,
    // no navbar and no address — which is a second diff renderer to keep in step with the first, and
    // the one the reader reached for when a diff was too long to read in the pane.
    if (row.ids.length === 1) {
      syncDetailDiff();
      state.panes = { ...state.panes!, zoom: 'detail', focus: 'detail', scroll: { ...state.panes!.scroll, detail: 0 } };
      state.scroll = 0;
      state.status = `edit #${row.ids[row.ids.length - 1]} full screen — esc back`;
      ask();
      schedulePaint();
    }
  }

  // --- the options window ------------------------------------------------------------------------
  /**
   * btop's settings screen, in this product's vocabulary: one list, headings for categories, the
   * value on the right, left/right to change it in place, and every change written the moment it is
   * made. No OK button — a settings screen with one has a state where what you see and what is saved
   * disagree, and the reader finds out by closing it.
   *
   * It REPLACED an app menu whose four entries were three reports and a link. Two of those facts
   * (where this reads from, which version) are rows here; the other two were a jump to a pane and an
   * update check, which the pane's own key and the status row already do.
   */
  /** Detected ONCE. `optRows` runs on every paint of the options window, and a PATH sweep per frame
   *  would stat a few hundred paths to answer a question whose answer cannot change mid-run. */
  const detectedEditors = core.detectEditors();
  const optEnv = () => ({
    editor: process.env.VISUAL || process.env.EDITOR,
    term: process.env.TERM,
    file: core.prefsPath(),
    editors: detectedEditors,
    // Resolved on every open, not captured once: a move performed from this very screen has to be
    // reflected the moment it happens.
    store: core.rootDir(),
  });
  const optRows = () => optionRows(prefs, optEnv());

  function openOptions(): void {
    const rows = optRows();
    options = { cursor: selectableRows(rows)[0] ?? 0, scroll: 0, capture: null };
    state.status = 'options — ←→ change · enter edit · esc close';
    schedulePaint();
  }

  /** Persist, then re-apply the ones that change how this session already looks. */
  function saveOptions(next: import('@claude-observatory/core').Prefs): void {
    // A value the settings layer refused comes back carrying its reason instead of being dropped on
    // the floor. Show it and keep the old setting; never write the marker to disk.
    if (next.__reject) {
      state.status = next.__reject;
      return schedulePaint();
    }
    prefs = next;
    state.keys = keys(); // a rebind reaches the frame's own prose on the same paint
    setTheme(prefs.theme); // …and a theme change reaches the very next paint, not the next launch
    state.syntax = prefs.syntax === true;
    try {
      core.writePrefs(prefs);
    } catch (e) {
      // A settings screen that cannot save must SAY so. Silently keeping the value in memory would
      // have the reader set it once and find it gone at the next start with no explanation.
      // `state.status`, not `state.error`: the backend owns `error` and clears it on the next
      // successful payload, so a failed SAVE — which the reader must see, because their setting did
      // not persist — vanished within one refresh tick.
      state.status = `could not save preferences: ${String((e as Error)?.message || e)}`;
      return schedulePaint();
    }
    if (!args.includes('--no-color') && !process.env.NO_COLOR) {
      colorDepth = prefs.color && prefs.color !== 'auto' ? prefs.color : detectColorDepth(process.env, Boolean(process.stdout.isTTY));
    }
    glyphs = glyphSet(prefs.glyphs && prefs.glyphs !== 'auto' ? prefs.glyphs : glyphTier(process.env));
    const wantMouse = !args.includes('--no-mouse') && prefs.mouse !== false;
    if (wantMouse !== mouse) {
      mouse = wantMouse;
      process.stdout.write(mouse ? MOUSE_ON : MOUSE_OFF);
    }
    if (tick) {
      clearInterval(tick);
      tick = setInterval(() => { ask(); schedulePaint(); }, Math.max(1, prefs.refreshSeconds ?? 3) * 1000);
      tick.unref?.();
    }
    schedulePaint();
  }

  /** Keys while the options window owns the keyboard. Returns true when it consumed the event. */
  function optionsKey(ev: { key: string; ctrl: boolean; alt: boolean }): boolean {
    if (!options) return false;
    const rows = optRows();
    const sel = selectableRows(rows);

    // A capture is a WALL, like the filter: it reads one key or one line and nothing escapes into the
    // verb switch, which in this app binds single letters to actions that revert files.
    if (options.capture) {
      const cap = options.capture;
      if (ev.key === 'escape') { options.capture = null; return (schedulePaint(), true); }
      if (cap.kind === 'key') {
        if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
          options.capture = null;
          saveOptions(setOption(prefs, cap.id, ev.key));
        } else {
          state.status = 'that is not a single printable key — press one, or esc to keep the current binding';
          options.capture = null;
          schedulePaint();
        }
        return true;
      }
      if (ev.key === 'enter') {
        options.capture = null;
        // The store row MOVES data — a real filesystem operation, so it cannot live in the pure
        // applier. Blank restores the default location, which is also a move.
        if (cap.id === 'storeDir') {
          const want = cap.buf.trim();
          const target = want || path.join(core.claudeConfigDir(), 'claude-observatory');
          const parsed = want ? core.parseStorePath(want) : { dir: target };
          if ('error' in parsed) {
            state.status = parsed.error;
            return (schedulePaint(), true);
          }
          const res = core.moveStore(parsed.dir);
          if ('error' in res) {
            state.status = `store not moved — ${res.error}`;
            return (schedulePaint(), true);
          }
          const next = { ...prefs };
          if (want) next.storeDir = parsed.dir;
          else delete next.storeDir;
          saveOptions(next);
          state.status = `store moved to ${res.to}`;
          ask();
          return (schedulePaint(), true);
        }
        saveOptions(setOption(prefs, cap.id, cap.buf));
        return true;
      }
      if (ev.key === 'backspace' || ev.key === 'delete') { cap.buf = cap.buf.slice(0, -1); return (schedulePaint(), true); }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) { cap.buf += ev.key; return (schedulePaint(), true); }
      return true;
    }

    if (ev.key === 'escape' || (ev.key.length === 1 && keys().get(ev.key) === 'options')) {
      options = null;
      state.status = 'ready';
      return (schedulePaint(), true);
    }
    const at = sel.indexOf(options.cursor);
    // The view FOLLOWS the cursor. Without this the list scrolled never, so every row past the
    // seventeenth — which is all of the KEYS section — could be selected and could not be seen.
    const follow = () => {
      const body = Math.max(1, frameRows - 5);
      // Each row can draw up to three lines (row, problem, help), so the window is bounded by the
      // worst case rather than by a row count that would let the selected row fall off the bottom.
      const visible = Math.max(1, Math.floor(body / 3));
      if (options!.cursor < options!.scroll) options!.scroll = options!.cursor;
      if (options!.cursor >= options!.scroll + visible) options!.scroll = options!.cursor - visible + 1;
      if (options!.scroll < 0) options!.scroll = 0;
    };
    if (ev.key === 'down') { options.cursor = sel[Math.min(sel.length - 1, at + 1)]; follow(); return (schedulePaint(), true); }
    if (ev.key === 'up') { options.cursor = sel[Math.max(0, at - 1)]; follow(); return (schedulePaint(), true); }
    if (ev.key === 'pgdn') { options.cursor = sel[Math.min(sel.length - 1, at + 5)]; follow(); return (schedulePaint(), true); }
    if (ev.key === 'pgup') { options.cursor = sel[Math.max(0, at - 5)]; follow(); return (schedulePaint(), true); }
    const row = rows[options.cursor];
    if (!row) return true;
    if (ev.key === 'left' || ev.key === 'right') {
      // `choices` is what makes a TEXT row steppable: the editor row offers what this machine has AND
      // still takes anything typed, so it is both. Stepping reads the same list the row rendered.
      if (row.kind === 'choice' || row.kind === 'toggle' || row.kind === 'number' || row.choices?.length) {
        saveOptions(applyOption(prefs, row.id, ev.key === 'right' ? 1 : -1, optEnv()));
      }
      return true;
    }
    if (ev.key === 'enter') {
      if (row.kind === 'text') {
        // Seeded from the row being edited, not from one hard-coded field: the remote rows are text
        // too, and starting them at the editor command would have the reader delete it every time.
        const seed = row.id === 'editor' ? prefs.editor ?? '' : row.id === 'storeDir' ? prefs.storeDir ?? '' : '';
        options.capture = { id: row.id, kind: 'text', buf: seed };
      } else if (row.kind === 'toggle' && row.id.startsWith('remote:')) {
        // A remote's ←→ toggles it; enter EDITS it, seeded with what is stored so a small change is
        // a small edit rather than a retype.
        const i = Number(row.id.slice(7));
        const r = prefs.remotes?.[i];
        options.capture = { id: row.id, kind: 'text', buf: r ? [r.name, r.host, r.configDir ?? ''].filter(Boolean).join(' ') : '' };
      }
      else if (row.kind === 'key') options.capture = { id: row.id, kind: 'key', buf: '' };
      else if (row.kind === 'toggle') saveOptions(applyOption(prefs, row.id, 1));
      else if (row.id === 'reset') {
        saveOptions({});
        state.status = 'every option is back to its default';
      }
      return (schedulePaint(), true);
    }
    return true; // the window owns every other key while it is open
  }

  /** The session picker, opened from the top bar. Switching re-scopes the whole dashboard. */
  let pickerIds: string[] = [];
  /** Remote rows, and whether they have been fetched for this picker session. The fetch is a
   *  synchronous ssh, so it happens AFTER the first paint; these carry the result back to it. */
  let remoteRowsCache: Record<string, unknown>[] = [];
  let remoteRowsFetched = false;
  /** True while the session picker is the overlay on screen — the deferred fetch must not repaint a
   *  picker the reader has already left. */
  let pickerOpen = false;
  /** The ROWS behind those ids — a picker row carries origin/host/title, and the selection handler
   *  needs them to refuse a row this machine cannot open. */
  let pickerRows: Record<string, unknown>[] = [];
  /** This build's version, read the same way the CLI's own `version` verb reads it. */
  function version(): string {
    try {
      return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || 'unknown';
    } catch {
      return 'unknown';
    }
  }
  /** What the reader has typed to narrow the session picker. Null when the picker is closed. */
  let pickerFilter: string | null = null;

  /**
   * The session picker.
   *
   * It lists EVERY workspace, so each row names the one it came from — the old listing mixed
   * ancestor-directory sessions in with this repo's and named none of them. And it FILTERS, because
   * "every workspace" is 95 rows on this machine and scrolling a list that long to find one
   * conversation is not choosing, it is hunting.
   */
  function openSessionPicker(): void {
    pickerFilter = '';
    pickerOpen = true;
    // Re-fetched once per OPEN: a host that was down a minute ago may be up now, and `remoteRows`
    // has its own TTL beneath this, so re-asking is cheap when nothing has changed.
    remoteRowsFetched = false;
    renderSessionPicker();
  }

  /**
   * Colour a picker row's machine cell by what it MEANS for reviewing that session.
   *
   * One palette, one meaning: `egress` is already "this left your machine", which is exactly what a
   * remote session is, so the chip and the picker cannot disagree about what purple says. A local
   * row is deliberately dim — it is the common case, and the common case should not shout.
   */
  const tintMachine = (padded: string, row: Record<string, unknown>): string => {
    if (row.error) return tint(padded, 'risk', colorDepth);
    if (row.origin === 'remote') return tint(padded, 'egress', colorDepth);
    if (row.origin === 'bridged') return tint(padded, 'undone', colorDepth);
    return colorDepth === 'none' ? padded : `\x1b[2m${padded}\x1b[0m`;
  };

  function renderSessionPicker(): void {
    const local = (state.views?.sessions as { sessions?: Record<string, unknown>[] } | undefined)?.sessions ?? [];
    // Remotes are fetched HERE, on open, and never on the refresh tick: each host is a synchronous
    // ssh, and paying that every three seconds would stutter the whole dashboard for a list that
    // changes on the order of minutes. `remoteRows` caches, so re-opening the picker is instant.
    // Painted FIRST, remotes second. `remoteRows` is synchronous ssh — up to 8 seconds per
    // unreachable host, and the keyboard is dead for all of it — so doing it before the first paint
    // left the reader looking at the old frame with no indication that anything was happening. Now
    // the local list is on screen immediately, saying what it is waiting for, and the hosts are
    // fetched on the next tick of the event loop.
    const enabled = (prefs.remotes ?? []).filter((r) => r.enabled !== false);
    // Removing or disabling the LAST machine has to clear what was cached. The refetch below is
    // gated on `enabled.length`, so without this the picker kept listing a machine prefs.json no
    // longer contains — tinted, clickable, and refused on click — for the life of the process.
    if (!enabled.length) remoteRowsCache = [];
    let remote: Record<string, unknown>[] = remoteRowsCache;
    if (enabled.length && !remoteRowsFetched) {
      setTimeout(() => {
        try {
          remoteRowsCache = core.remoteRows(enabled) as unknown as Record<string, unknown>[];
        } catch (e) {
          state.status = `could not reach a configured machine: ${String((e as Error)?.message || e)}`;
        }
        remoteRowsFetched = true;
        // Only if the picker is STILL open — the reader may have chosen or escaped while ssh ran.
        if (state.overlay && pickerIds.length >= 0 && pickerOpen) renderSessionPicker();
      }, 0).unref?.();
    }
    const all = [...local, ...remote];
    const waiting = enabled.length && !remoteRowsFetched
      ? `  … contacting ${enabled.length} configured machine(s)`
      : null;
    if (!all.length) {
      pickerFilter = null;
      state.status = 'no sessions found — this machine has no Claude Code transcripts yet';
      return schedulePaint();
    }
    const f = (pickerFilter ?? '').toLowerCase();
    const list = f
      ? all.filter((x) => `${x.title ?? ''} ${x.id} ${x.workspace ?? ''}`.toLowerCase().includes(f))
      : all;
    pickerIds = list.map((x) => String(x.id));
    pickerRows = list as Record<string, unknown>[];
    // Columns sized from the DATA, so nothing is cut. The old picker sliced every title at 44
    // characters mid-word with no marker — 12 of 63 rows on this machine — which is the one thing
    // this product does not do to content.
    const wsW = Math.min(28, Math.max(1, ...list.map((x) => String(x.workspace ?? '').length)));
    // WHICH MACHINE, as its own column. It used to be jammed onto the front of the workspace label
    // and truncated to fit — and a truncated machine name answers the question no better than no
    // machine name at all. Sized from the data, like every other column here.
    const mcW = Math.max(1, ...list.map((x) => String(x.machine ?? '').length));
    // How many rows share each title, so only the ambiguous ones get an id appended.
    const titleCounts = new Map<string, number>();
    for (const x of list) {
      const t = String(x.title || '') || String(x.id).slice(0, 8);
      titleCounts.set(t, (titleCounts.get(t) ?? 0) + 1);
    }
    // Padded from the DATA and capped: a single very long title must not push every other row's
    // columns off to the right, and nothing is ever cut — a long one simply overflows its own row.
    // Every column sized from the DATA, so nothing is cut and nothing is padded to a guess.
    const dW = Math.max(1, ...list.map((x) => String(Math.max(Number(x.added) || 0, Number(x.removed) || 0)).length + 1));
    const costW = Math.max(0, ...list.map((x) => {
      const t = Number(x.tokens) ? `${core.compactTokens(Number(x.tokens))} tok` : '';
      const d = Number(x.durationMs) ? core.compactDuration(Number(x.durationMs)) : '';
      return [t, d].filter(Boolean).join(' · ').length;
    }));
    const brainW = Math.max(0, ...list.map((x) =>
      [String(x.model || ''), String(x.effort || '') && `${x.effort} effort`].filter(Boolean).join(' · ').length));
    const titleW = Math.min(46, Math.max(1, ...list.map((x) => {
      const t = String(x.title || '') || String(x.id).slice(0, 8);
      return t.length + ((titleCounts.get(t) ?? 0) > 1 ? 10 : 0);
    })));
    // WHAT FITS. Every optional column costs width, and a row wider than the terminal wraps — so the
    // narrow-terminal answer is to drop whole columns, cheapest-to-the-reader first, rather than let
    // the table re-flow. The order is what a reader chooses a session BY: the name and its age never
    // go; the workspace is the longest and least discriminating, so it goes first.
    const whenW = Math.max(1, ...list.map((x) => core.relTime(Number(x.lastActiveMs) || 0).length));
    const keep = new Set(['machine', 'workspace', 'churn', 'cost', 'brain']);
    const widthOf = (): number =>
      1 + 1 + 1 + titleW +
      (keep.has('machine') ? 2 + mcW : 0) +
      (keep.has('workspace') ? 2 + wsW : 0) +
      (keep.has('churn') ? 2 + dW * 2 + 1 : 0) +
      2 + 13 +
      (keep.has('cost') ? 2 + costW : 0) +
      (keep.has('brain') ? 2 + brainW : 0) +
      2 + whenW;
    // One column is reserved: the selected row is drawn in reverse video across its full width, and a
    // row sized to exactly the terminal leaves no cell for the cursor glyph in the `--no-color` path.
    for (const drop of ['workspace', 'churn', 'brain', 'cost', 'machine']) {
      if (widthOf() <= frameCols - 1) break;
      keep.delete(drop);
    }
    const lines = list.map((x) => {
      const cur = x.current ? '*' : ' '; // '*' = the session in effect; '>' is the picker's cursor
      const ws = String(x.workspace ?? '?').padEnd(wsW);
      // The machine carries MEANING, not just a name: purple is the palette's "off this machine",
      // the same hue the ⇅ egress chip uses, so a session you cannot review from here is obvious
      // before you press enter on it. Padded BEFORE tinting — `padEnd` counts escape bytes, so
      // tinting first makes every coloured cell short by the length of its escape sequence.
      const machine = tintMachine(String(x.machine ?? '?').padEnd(mcW), x);
      const bridged = x.origin === 'bridged';
      const state_ = x.error
        ? 'unreachable'
        : x.origin === 'remote'
          ? 'read-only'
          : bridged
            ? 'on the bridge'
            : Number(x.pending) || 0
              ? `${String(Number(x.pending) || 0).padStart(5)} pending`
              : '   no edits';
      const when = core.relTime(Number(x.lastActiveMs) || 0);
      // THE NAME LEADS. It is what a reader is scanning for — the machine and workspace are how they
      // narrow, not how they choose — and it used to sit last, past four columns of metadata.
      //
      // A title is derived from the session's first ask, so several sessions genuinely share one:
      // five rows here read "Check Claude effort environment variable". They are not duplicates and
      // must not be hidden, but they are indistinguishable, so a repeated title carries its short id.
      // Only repeats pay for it — tagging every row would add noise to the ones that never needed it.
      const title = String(x.title || '') || String(x.id).slice(0, 8);
      const shown = (titleCounts.get(title) ?? 0) > 1 ? `${title}  ${String(x.id).slice(0, 8)}` : title;
      // WHAT THE SESSION COST, the way the editors' session row shows it. Every field here was already
      // in this payload and none of it was displayed: choosing a session to review meant choosing on a
      // name and an age alone, with its size, spend and model one keystroke out of reach.
      //
      // Padded before tinting — `padEnd` counts escape bytes, so tinting first leaves every coloured
      // cell short by the length of its own escape sequence.
      const churn = Number(x.added) || Number(x.removed)
        ? `${tint(`+${Number(x.added) || 0}`.padStart(dW), 'kept', colorDepth)} ${tint(`−${Number(x.removed) || 0}`.padEnd(dW), 'risk', colorDepth)}`
        : ' '.repeat(dW * 2 + 1);
      const cost = [
        Number(x.tokens) ? `${core.compactTokens(Number(x.tokens))} tok` : '',
        Number(x.durationMs) ? core.compactDuration(Number(x.durationMs)) : '',
      ].filter(Boolean).join(' · ');
      const brain = [String(x.model || ''), String(x.effort || '') && `${x.effort} effort`].filter(Boolean).join(' · ');
      // Assembled from the columns this width can afford, widest-to-narrowest in DROP order. A table
      // is the one thing the overlay must not wrap: it re-flows a row onto a second visual line, and
      // a two-line row in a list you are arrowing through costs the alignment that made it a table.
      // Nothing is cut mid-word either way — a column is present in full or not at all.
      const cells: string[] = [` ${cur} ${shown.padEnd(titleW)}`];
      if (keep.has('machine')) cells.push(machine);
      if (keep.has('workspace')) cells.push(ws);
      if (keep.has('churn')) cells.push(churn);
      cells.push(state_.padEnd(13));
      if (keep.has('cost')) cells.push(tint(cost.padEnd(costW), 'undone', colorDepth));
      if (keep.has('brain')) cells.push(tint(brain.padEnd(brainW), 'undone', colorDepth));
      cells.push(when);
      return cells.join('  ');
    });
    if (!lines.length) {
      lines.push(`  nothing matches “${pickerFilter}” — backspace to widen it`);
      pickerIds = [];
      pickerRows = [];
    }
    // Never an empty tail standing in for "still asking": a configured machine that has not answered
    // yet reads exactly like one with no sessions unless the list says which.
    if (waiting) lines.push(waiting);
    const at = Math.max(0, pickerIds.indexOf(state.session));
    state.overlay = {
      title: `browse sessions  —  type to filter${pickerFilter ? ` (${pickerFilter}_)` : ''} · ↑↓ move · enter select · esc cancel`,
      lines,
      scroll: 0,
      cursor: at,
    };
    schedulePaint();
  }
  /**
   * Enter inside one of the two OVERLAYS that are not the session picker.
   *
   * Separate from `choosePicked` on purpose: that function declares its own `picked` for a picker row,
   * which shadows the outer selection flag for its whole body — so the jump below could not set the
   * thing it exists to set. Two small handlers beat one that cannot say what it means.
   *
   * Returns true when it consumed the Enter.
   */
  function chooseOverlayAction(): boolean {
    const o = state.overlay;
    if (!o || o.cursor === undefined) return false;
    if (jumpRows) {
      const to = jumpRows[o.cursor];
      jumpRows = null;
      state.overlay = null;
      if (to !== undefined) {
        focusPane('traces');
        state.cursor = to;
        picked = true;
        clampCursor();
        syncPane();
        syncDetailDiff();
      }
      schedulePaint();
      return true;
    }
    if (rowMenu) {
      // Everything the row menu offers is a key that already exists, so choosing simply presses it —
      // the menu can never do something the keyboard cannot.
      const key = rowMenu[o.cursor];
      rowMenu = null;
      state.overlay = null;
      if (key) onKey({ key, ctrl: false, alt: false });
      else schedulePaint();
      return true;
    }
    return false;
  }

  function choosePicked(): void {
    pickerFilter = null;
    pickerOpen = false;
    const o = state.overlay;
    if (!o || o.cursor === undefined) return;
    const id = pickerIds[o.cursor];
    state.overlay = null;
    if (!id || id === state.session) {
      state.status = 'ready';
      return schedulePaint();
    }
    // Not every ROW in this picker is a session this machine can open, and two of them would break
    // the product if selected. A host that failed to answer is rendered as a row whose id is
    // `!<name>` carrying the error as its title — `isSafeSessionId` rejects that, and `storeDir`
    // THROWS on it. A reachable REMOTE session is a real id, but its transcript and store are on the
    // other machine, so switching to it empties every window and then explains the emptiness wrongly.
    // Refuse both, and say which one this is.
    if (!core.isSafeSessionId(id)) {
      const row = pickerRows.find((r) => String(r.id) === id);
      state.status = `that host could not be reached — ${String(row?.title || 'no answer')}`;
      return schedulePaint();
    }
    const picked = pickerRows.find((r) => String(r.id) === id);
    if (picked && picked.origin === 'remote') {
      state.status = `${id.slice(0, 8)} lives on ${String(picked.host || 'another machine')} — this dashboard reviews local sessions only`;
      return schedulePaint();
    }
    // Everything below the top bar is scoped to one session, so switching resets the view rather than
    // leaving a cursor pointing into the previous session's rows.
    state.session = id;
    state.views = null;
    state.cursor = 0;
    state.scroll = 0;
    state.sessionTitle = '';
    state.status = `switched to ${id.slice(0, 8)}`;
    ask();
    schedulePaint();
  }

  /**
   * Keep Detail's Diff face in step with the Traces selection.
   *
   * On demand, never on the poll: `cmdViews` hands ONE argument list to every view in a batch, so a
   * per-edit diff cannot ride alongside the other views without blanking them. Debounced, because
   * holding `j` would otherwise spawn one CLI per keypress.
   */
  const view = (st: typeof state, name: string): unknown =>
    st.views && typeof st.views === 'object' ? (st.views as Record<string, unknown>)[name] : null;
  function syncDetailDiff(): void {
    if (!state.panes) return;
    // Resolved from the TRACES pane's own list and cursor — never from `state.screen`/`state.cursor`,
    // which follow whichever window has focus. Reading those meant that merely focusing Detail
    // indexed the edit list with Detail's cursor, reported a "new selection", and cleared the face
    // the reader had just chosen: pressing F3 for the map landed on the diff, every time.
    // Nothing is selected until the reader SELECTS something. The dashboard used to fetch the newest
    // edit's diff on its very first paint, so it opened on one file's diff — and the session's change
    // map, which is what you want before you have picked anything, was a keystroke away and never the
    // thing you saw first. A cursor index cannot express this: `syncPane` writes 0 into the pane's
    // cursor on the first paint, so "index 0" and "nothing yet" are the same value.
    // The traces pane's ACTIVE tab, not a hardcoded 'edits' — on the Review tab the cursor walks
    // review rows, and indexing the edits list with it would fetch a different row's diff.
    const tracesBox = layout().boxes.find((b) => b.id === 'traces');
    const tracesScreen = tracesBox ? paneScreenOf(state, tracesBox) : 'edits';
    const rows = rowsOf(tracesScreen, 'traces');
    const row = picked ? rows[state.panes.cursor.traces ?? 0] : undefined;
    const id = row && row.ids.length === 1 ? row.ids[0] : -1;
    if (id === diffWanted) return;
    diffWanted = id;
    // The selection changed, so Detail goes back to FOLLOWING it. Without this, a reader who swapped
    // to the map once would drill into every later edit and land on the map again, with the diff they
    // asked for one keystroke away and nothing on screen saying so.
    if (state.panes?.tab.detail !== undefined) {
      const tab = { ...state.panes.tab };
      delete (tab as Record<string, unknown>).detail;
      state.panes = { ...state.panes, tab };
    }
    if (id < 0) {
      state.diffPatch = undefined;
      state.diffMeta = undefined;
      return;
    }
    if (diffTimer) clearTimeout(diffTimer);
    diffTimer = setTimeout(() => {
      const want = diffWanted;
      void backend!.diff(want, state.session).then((text) => {
        if (want !== diffWanted) return; // the reader moved on; a late arrival must not overwrite
        const edits = (view(state, 'list') as { edits?: Record<string, unknown>[] } | null)?.edits ?? [];
        const e = edits.find((x) => Number(x.id) === want);
        state.diffPatch = text || '';
        state.diffMeta = {
          id: want,
          path: String(e?.file ?? ''),
          added: Number(e?.added ?? 0),
          removed: Number(e?.removed ?? 0),
          // The tool the agent actually used, which `list` already carries. Heading every edit with
          // one hard-coded verb said "Update" over a file that had just been created.
          verb: String(e?.tool ?? '') || 'Edit',
        };
        schedulePaint();
      });
    }, 90);
    diffTimer.unref?.();
  }

  function closeOverlay(): boolean {
    rowMenu = null; // the overlay is shared; a stale menu would answer the NEXT overlay's Enter
    jumpRows = null;
    if (!state.overlay) return false;
    pickerFilter = null; // one place every dismissal goes through, so the mode cannot outlive the overlay
    // …and the picker's open flag with it, so a deferred remote fetch that lands after the reader has
    // escaped cannot repaint an overlay they already dismissed.
    pickerOpen = false;
    // Reset the mode HERE, at the one place every dismissal goes through. Clearing it only in the
    // menu's own handlers left it set after an `esc`, so the next session picker's Enter dispatched
    // a menu action instead of switching session — the reader picks a session and gets "Update".
    state.overlay = null;
    state.status = 'ready';
    schedulePaint();
    return true;
  }


  /**
   * Scroll the Diff face to the next line containing `needle`, wrapping at the end.
   *
   * Scrolls rather than highlights: the diff is already SGR-dense (added/removed banding, intraline
   * marks), and threading a second highlight through `renderRichDiff` risks composing badly with the
   * wrap it already does. Moving the viewport is the part that was actually missing.
   */
  function jumpToMatch(needle: string, dir: 1 | -1): void {
    if (!needle) {
      state.status = 'ready';
      return schedulePaint();
    }
    const lines = (state.diffPatch ?? '').split('\n');
    if (!lines.length) {
      state.status = 'no diff on screen to search';
      return schedulePaint();
    }
    const n = needle.toLowerCase();
    const from = state.scroll;
    // Searched over the PATCH's own lines, and the pane's scroll is in rendered rows — close enough
    // to land the match on screen, which is what "find" has to do; the reader takes it from there.
    let hit = -1;
    for (let i = 1; i <= lines.length; i++) {
      const at = (from + i * dir + lines.length * 2) % lines.length;
      if (lines[at].toLowerCase().includes(n)) {
        hit = at;
        break;
      }
    }
    if (hit < 0) {
      state.status = `“${needle}” is not in this diff`;
      return schedulePaint();
    }
    lastFind = needle;
    state.findNeedle = needle; // …and MARK them, not just scroll to them
    state.scroll = Math.max(0, hit - 2); // a couple of lines of lead-in, so the match is not the top row
    state.status = `“${needle}” — line ${hit + 1} of ${lines.length} · n / p for the next`;
    return schedulePaint();
  }
  /**
   * MARKS — `'a` to set one here, `` `a `` to come back.
   *
   * vim's pair is `m` to set and `'` to jump, and `m` is taken here: it minimizes the focused window,
   * and has since before this existed. So the two JUMP keys take both jobs — `'` sets, `` ` `` goes —
   * which keeps half the muscle memory (both are vim's mark keys, on adjacent physical keys) and
   * costs nothing that was already bound.
   *
   * A mark is a row's EDIT ID, not its index: sorting, filtering and Claude appending more edits all
   * move indices around, and a mark that quietly pointed at a different file after a re-sort would be
   * worse than no mark at all. Runtime only, like the mark SET — a jump target from yesterday's
   * session is not a thing anyone wants restored.
   */
  const marks = new Map<string, number>();
  /** Which mark key is being captured: `set` after `'`, `jump` after `` ` ``, else null. */
  let markPending: 'set' | 'jump' | null = null;

  /** The keys the right-click menu is currently offering, in the order it drew them. Null when no row
   *  menu is open — the overlay is shared with the pickers, and only this says which one it is. */
  let rowMenu: string[] | null = null;

  /** Traces row indexes the jump-to-file overlay is offering, in the order it drew them. */
  let jumpRows: number[] | null = null;

  /** The last find, so `n`/`p`/`N` can repeat it while the Diff face has focus. */
  let lastFind = '';

  /**
   * Forget the standing find, which is what hands `n`/`p` back to the review stepper.
   *
   * Called wherever the find stops describing what is on screen: a different selection (the patch under
   * it is not the one that was searched), a face or focus change, and `esc` out of the find prompt.
   * Without this the flag was one-way — set on the first successful find and never cleared — so the
   * Diff face silently kept `n`/`p` for the rest of the session.
   */
  function clearFind(): void {
    lastFind = '';
    state.findNeedle = undefined;
  }

  function runCommand(line: string): void {
    if (!line) {
      state.status = 'ready';
      return schedulePaint();
    }
    const [name, ...rest] = line.split(/\s+/).filter(Boolean);
    // hasOwn, not a bare index: COMMANDS is an object literal, so `:constructor`, `:toString` and
    // `:valueOf` all found something truthy on the prototype, walked past the refusal below, and threw
    // `cmd.args is not a function` out of the key handler.
    const cmd = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    if (!cmd) {
      // Names the alternatives rather than only refusing — a prompt that says "no" and stops is a
      // prompt nobody uses twice.
      state.status = `no command “${name}” — try: ${Object.keys(COMMANDS).join(', ')}`;
      return schedulePaint();
    }
    // `rest` is deliberately DROPPED, not forwarded — see COMMANDS. Say so rather than ignoring it
    // silently, or `:store --move /tmp/x` looks like it worked.
    state.status = rest.length ? `${name} takes no arguments here — running the plain form…` : `running ${name}…`;
    schedulePaint();
    void backend!.run(cmd.args()).then((out) => {
      const first = out.trim().split('\n').filter(Boolean);
      state.status = first.length ? first[0].replace(/\x1b\[[0-9;]*m/g, '') : `${name}: nothing to report`;
      // The full answer goes to the overlay, because a status row is one line and these verbs answer
      // in paragraphs. Same overlay the help uses, so esc closes it the way esc closes everything.
      if (first.length > 1) {
        state.overlay = {
          title: `${name}  —  esc to close`,
          lines: out.split('\n').map((l) => '  ' + l.replace(/\x1b\[[0-9;]*m/g, '')),
          scroll: 0,
        };
      }
      ask();
      schedulePaint();
    });
  }

  function move(delta: number): void {
    if (state.overlay) {
      const o = state.overlay;
      if (o.cursor !== undefined) {
        // A picker moves its SELECTION, and the view follows it — scrolling a list you are choosing
        // from without moving the choice is the classic picker bug.
        const cur = Math.min(o.lines.length - 1, Math.max(0, o.cursor + delta));
        const view = Math.max(0, frameRows - 6);
        const scroll = cur < o.scroll ? cur : cur >= o.scroll + view ? cur - view + 1 : o.scroll;
        state.overlay = { ...o, cursor: cur, scroll };
      } else {
        const max = Math.max(0, o.lines.length - (frameRows - 5));
        state.overlay = { ...o, scroll: Math.min(max, Math.max(0, o.scroll + delta)) };
      }
      return schedulePaint();
    }
    // Detail's diff SCROLLS. It has no rows to step between — `paneRowCount` reports visual lines
    // here — so a delta moves the viewport and the cursor stays put. Before this it was pinned at 0
    // by a row count that read a field nothing ever assigned, and a long edit could not be read past
    // its first screen.
    const sc = scrollerBox();
    if (sc) {
      const max = Math.max(0, paneRowCount(state, sc) - sc.body.h);
      state.scroll = Math.min(max, Math.max(0, state.scroll + delta));
      syncPane();
      return schedulePaint();
    }
    // Past the scroller branch, a move changes the SELECTION rather than scrolling the diff — so the
    // patch a standing find ran over is about to stop being the one on screen. (Above it is the Diff
    // face scrolling, which is exactly when the find must survive: that is what n/p repeat.)
    clearFind();
    // The FOCUSED pane's own rows, resolved through `paneScreenOf` — not `state.screen`, which lags
    // behind focus and cannot represent Detail's faces at all. Stepping the map's cursor over the
    // EDIT list's rows skipped every entry whose counterpart there was a continuation line, and ran
    // the cursor off the end of a much shorter list until it vanished.
    const rows = rowsOf();
    if (state.panes?.focus === 'traces') picked = true; // moving the edit cursor IS choosing one
    const step = delta === 0 ? 0 : delta > 0 ? 1 : -1;
    // What arrows STEP: in the Review list the edits are the targets and file headers are furniture
    // (edit rows carry key `e<id>` and are the `cont` ones — the old skip-cont rule walked HEADERS
    // and skipped every edit, the exact inversion of reviewing). Elsewhere continuation lines skip.
    const box = state.panes ? layout().boxes.find((b) => b.id === state.panes!.focus) : null;
    const editsList = (box ? paneScreenOf(state, box) : state.screen) === 'edits';
    const skip = (r?: { cont?: boolean; key?: string }): boolean =>
      // …and the cancelled-out footer, which is a target too: it advertises `a` to dismiss, so a
      // cursor that could never land on it would be advertising a key the reader cannot press.
      editsList ? !(r?.key?.startsWith('e') || r?.key === 'cancelled') : !!r?.cont;
    let next = state.cursor + delta;
    while (rows[next] && skip(rows[next])) next += step;
    if (next < 0) next = 0;
    if (next >= rows.length) next = Math.max(0, rows.length - 1);
    while (next > 0 && skip(rows[next])) next--;
    while (next < rows.length - 1 && skip(rows[next])) next++;
    state.cursor = next;
    clampCursor();
    syncPane();
    syncDetailDiff();
    schedulePaint();
  }
  function onKey(ev: { key: string; ctrl: boolean; alt: boolean }): void {
    // ^C arrives as a NAMED key with `ctrl` set — `{key:'c'}` — never as the raw byte. A `case '\x04'`
    // in the verb switch was therefore dead. ^D used to be folded in here too and quit alongside it;
    // it is a pager key now (see the ctrl layer below), because in vim, less and everything that
    // borrows from them ^D is half-page-down, and quitting on it ended the review of whoever scrolled
    // a long diff the way they scroll everything else. ^C alone keeps the quit — that one is universal.
    const ch = ev.ctrl && ev.key === 'c' ? '\x03' : ev.key;
    // ^C still quits from inside the options window; everything else there belongs to it.
    if (ch !== '\x03' && optionsKey(ev)) return;
    // Escape and ^C are reachable from EVERY mode — including with a filter open, where the old
    // handler swallowed them as filter text and left no way out at all.
    if (ev.key === 'escape') {
      /**
       * THE TEXT WALLS COME FIRST, because this ladder RETURNS.
       *
       * Command mode and find-in-diff each have their own escape handler further down, and both were
       * unreachable whenever an earlier rung matched — which the last rung, "unselect", does as soon
       * as anything is selected. So with an edit picked, `:` followed by esc unselected the edit and
       * left the prompt OPEN, its status row overwritten by the unselect message, so nothing on
       * screen said the next letters were still going into a command instead of running as keys.
       *
       * It looked fine from a test that opened the prompt without selecting anything first: with
       * nothing picked the ladder falls off the end and reaches the wall's own handler.
       */
      if (cmdOpen) {
        cmdOpen = false;
        state.status = 'ready';
        return schedulePaint();
      }
      if (diffFindOpen) {
        diffFindOpen = false;
        clearFind(); // esc means "done searching", so n/p go back to stepping the review
        state.status = 'ready';
        return schedulePaint();
      }
      if (closeOverlay()) return;
      // A zoom is a mode, and esc is how every mode here ends. Without this the reader who opened an
      // edit full screen had to remember which key had zoomed it.
      if (state.panes?.zoom) {
        state.panes = { ...state.panes, zoom: null };
        state.status = 'ready';
        ask();
        return schedulePaint();
      }
      if (state.goto !== null && state.goto !== undefined) {
        state.goto = null;
        return schedulePaint();
      }
      if (state.promptScope) {
        state.promptScope = null; // the Edits list widens back to the whole session
        state.cursor = 0;
        state.scroll = 0;
        state.status = 'showing every edit again';
        clampCursor();
        return schedulePaint();
      }
      if (state.marked?.size) {
        state.marked = new Set<number>();
        state.status = 'marks cleared';
        return schedulePaint();
      }
      if (filterOpen) {
        filterOpen = false;
        state.filterOpen = false;
        state.filter = '';
        clampCursor();
        syncPane();
        return schedulePaint();
      }
      if (state.confirm) {
        state.confirm = null;
        state.status = 'cancelled';
        return schedulePaint();
      }
      // Last rung: with no mode left to leave, esc UNSELECTS. Detail follows the selection, so
      // dropping it puts the change map back on screen — the view that answers "what happened here"
      // before you have picked anything to answer it about, and the one the dashboard opens on.
      // Any explicitly chosen face is dropped too: the reader is asking for the default, and leaving
      // a pinned Diff face behind would show an empty diff pane with nothing selected to fill it.
      if (picked || state.panes?.tab.detail !== undefined) {
        picked = false;
        // Both halves of "nothing is selected", together: `diffWanted` is what syncDetailDiff
        // compares against, so leaving it on the old id would make the next sync a no-op and strand
        // the patch on screen.
        diffWanted = -1;
        state.diffPatch = undefined;
        state.diffMeta = undefined;
        if (state.panes) {
          const tab = { ...state.panes.tab };
          delete (tab as Record<string, unknown>).detail;
          state.panes = { ...state.panes, tab };
        }
        state.status = 'nothing selected — showing the change map';
        return schedulePaint();
      }
    }
    if (ch === '\x03') {
      restore();
      return process.exit(0);
    }

    // ------------------------------------------------------------------------------------------
    // MODAL GATES. Both of these swallow every key they do not themselves consume, and they come
    // BEFORE the jump table and the verb switch. This keymap binds single letters to destructive
    // verbs — `u` surgically reverts a file on disk — so any mode that reads text must be a wall,
    // not a filter. Falling through was the defect: typing "readme" after `/` ran r(efresh),
    // a(keep) and m(inimize), and a(keep) actually mutated the store.
    // ------------------------------------------------------------------------------------------

    // A pending confirmation owns the keyboard until it is answered. Enter must NOT fall through to
    // openSelected, or a diff opens underneath the prompt while the question is still on screen.
    if (state.confirm) {
      if (ch === 'y' || ch === 'Y') {
        const { verb, ids, under } = state.confirm;
        state.confirm = null;
        // A path scope is not an id set. Sending `ids` (empty, for a `--under` question) would exit 0
        // having done nothing and report "keep: 0 edit(s)" — a confirmed action that silently did not
        // happen, which is the worst outcome a y/n prompt can produce.
        if (under && verb !== 'redo') return applyUnder(verb, under);
        return applyMutation(verb, ids);
      }
      if (ch === 'n' || ch === 'N' || ch === 'q') {
        state.confirm = null;
        state.status = 'cancelled';
        return schedulePaint();
      }
      return; // everything else is swallowed while the question stands
    }

    // The Claude-launch question is a wall like the others: it owns the keyboard until answered, it
    // was visible the moment it opened (the status row asked it), and every key it ADVERTISES is
    // bound — the A/U prompt once rendered [y/n] with neither key handled, and this class of wall is
    // how that stays fixed. Any other key cancels: the safe default for a question about opening a
    // second writer on a live transcript.
    if (claudeAsk) {
      claudeAsk = null;
      if (ev.key === 'r') return launchClaude(false);
      if (ev.key === 'f') return launchClaude(true);
      state.status = 'ready';
      return schedulePaint();
    }

    // A pending mark letter is a one-key wall, for the same reason the others are: the very next key
    // is a NAME, and letting it fall through would run `a` (keep) as the name of a mark.
    if (markPending) {
      const mode = markPending;
      markPending = null;
      if (ev.key === 'escape' || ev.key.length !== 1 || ev.ctrl || ev.alt) {
        state.status = 'ready';
        return schedulePaint();
      }
      const name = ev.key;
      if (mode === 'set') {
        const row = rowsOf()[state.cursor];
        const id = row?.ids.length === 1 ? row.ids[0] : undefined;
        if (id === undefined) {
          state.status = `mark ‘${name}’ needs a single edit — a file header stands for all of its edits`;
          return schedulePaint();
        }
        marks.set(name, id);
        state.status = `mark ‘${name}’ set on edit #${id}`;
        return schedulePaint();
      }
      const want = marks.get(name);
      if (want === undefined) {
        state.status = `no mark ‘${name}’ — set one with ’${name} first`;
        return schedulePaint();
      }
      const rows = rowsOf();
      const at = rows.findIndex((r) => !r.cont && r.ids.length === 1 && r.ids[0] === want);
      if (at < 0) {
        state.status = `mark ‘${name}’ is on edit #${want}, which this window is not showing`;
        return schedulePaint();
      }
      focusPane('traces');
      state.cursor = at;
      picked = true;
      clampCursor();
      syncPane();
      syncDetailDiff();
      state.status = `mark ‘${name}’ — edit #${want}`;
      return schedulePaint();
    }

    // Find-in-diff is a wall too, for the same reason.
    if (diffFindOpen) {
      if (ev.key === 'escape') {
        diffFindOpen = false;
        clearFind(); // esc means "done searching", so n/p go back to stepping the review
        state.status = 'ready';
        return schedulePaint();
      }
      if (ev.key === 'enter') {
        diffFindOpen = false;
        return jumpToMatch(diffFind.trim(), 1);
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        diffFind = diffFind.slice(0, -1);
        state.status = `find in diff: ${diffFind}`;
        return schedulePaint();
      }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        diffFind += ev.key;
        state.status = `find in diff: ${diffFind}`;
        return schedulePaint();
      }
      return;
    }

    // Command mode is a WALL, like the filter and the confirmation: it reads one line and nothing
    // escapes into the verb switch, which in this app binds single letters to actions that revert
    // files.
    if (cmdOpen) {
      if (ev.key === 'escape') {
        cmdOpen = false;
        state.status = 'ready';
        return schedulePaint();
      }
      if (ev.key === 'enter') {
        cmdOpen = false;
        return runCommand(cmdBuf.trim());
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        cmdBuf = cmdBuf.slice(0, -1);
        state.status = `: ${cmdBuf}`;
        return schedulePaint();
      }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        cmdBuf += ev.key;
        state.status = `: ${cmdBuf}`;
        return schedulePaint();
      }
      return;
    }

    // An open filter consumes typing. Escape (handled above) clears and closes it; Enter keeps the
    // filter and hands the keyboard back so the reader can act on what they narrowed to.
    if (filterOpen) {
      if (ev.key === 'enter') {
        filterOpen = false;
        state.filterOpen = false;
        return schedulePaint();
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        state.filter = state.filter.slice(0, -1);
        clampCursor();
        syncPane();
        return schedulePaint();
      }
      // Printable, unmodified keys only — a stray ctrl/alt chord must not become filter text.
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        state.filter += ev.key;
        clampCursor();
        syncPane();
        return schedulePaint();
      }
      return; // and nothing else escapes into the verb switch
    }

    // The session picker TYPES. It is a wall like the filter and the options capture: this keymap
    // binds single letters to verbs that revert files, so a mode that reads text must consume every
    // key it does not itself act on rather than letting `s` or `u` fall through to the switch.
    if (state.overlay && pickerFilter !== null) {
      if (ev.key === 'enter') return choosePicked();
      if (ev.key === 'escape') { pickerFilter = null; return void closeOverlay(); }
      if (ev.key === 'up' || ev.key === 'down' || ev.key === 'pgup' || ev.key === 'pgdn') {
        return move(ev.key === 'down' ? 1 : ev.key === 'up' ? -1 : ev.key === 'pgdn' ? 10 : -10);
      }
      if (ev.key === 'backspace' || ev.key === 'delete') {
        pickerFilter = pickerFilter.slice(0, -1);
        return renderSessionPicker();
      }
      if (ev.key.length === 1 && !ev.ctrl && !ev.alt) {
        pickerFilter += ev.key;
        return renderSessionPicker();
      }
      return; // nothing else escapes while the picker is open
    }
    if (state.overlay) {
      if (ev.key === 'enter' && state.overlay.cursor !== undefined) {
        if (chooseOverlayAction()) return;
        return choosePicked();
      }
      // `?` toggles: the key that opened the help closes it. Only `q`/enter closing it meant the
      // advertised key appeared to do nothing on the second press.
      if (ch === 'q' || ch === '?' || ev.key === 'enter') return void closeOverlay();
    }
    // F1..F5 are the window bar, left to right. Detail answers to two of them, one per face, so F3
    // means "the map" and F4 means "this diff" rather than "the centre, and then find the swap".
    // Pressing the key for what is ALREADY showing zooms it, and again puts it back — the same
    // second-press-drills-in gesture the edit list uses, so full screen costs no new key and no timer.
    // ONE exception, documented on BAR_ENTRIES: the Claude strip has nothing to zoom into, so its
    // second press LAUNCHES Claude — the drill-in, applied to the pane whose drill-in is the agent.
    const fkey = BAR_ENTRIES.find((e) => ev.key === `f${e.key}`);
    if (fkey) {
      const showing = state.panes!.focus === fkey.pane && (fkey.face === undefined || fkey.face === detailFace(state));
      if (showing && !state.overlay) {
        if (fkey.pane === 'claude') return openClaude();
        return toggleZoom(fkey.pane);
      }
      if (fkey.face !== undefined) return setDetailFace(fkey.face as 0 | 1);
      return focusPane(fkey.pane);
    }
    // Digits name an EDIT, not a window. They accumulate, because ids run well past 9, and the
    // number is shown before Enter commits to it — this moves the selection that `u` reverts.
    if (!state.overlay && /^[0-9]$/.test(ch)) {
      state.goto = (state.goto ?? '') + ch;
      return schedulePaint();
    }
    if (state.goto !== null && state.goto !== undefined) {
      if (ev.key === 'enter') return gotoEdit();
      if (ev.key === 'backspace' || ev.key === 'delete') {
        const next = state.goto.slice(0, -1);
        state.goto = next.length ? next : null;
        return schedulePaint();
      }
      // Any other key abandons the number and is then handled normally: a half-typed id that silently
      // swallowed the next verb would be a mode with no exit.
      state.goto = null;
    }
    // Arrows. The decoder has always emitted these and the README has always documented them; the
    // switch below only ever matched `j`/`k`, so every arrow key silently did nothing.
    if (ev.key === 'down') return move(1);
    if (ev.key === 'up') return move(-1);
    // `pgdn`/`pgup` — the decoder's own names (tui/input.ts CSI_TILDE). Spelled `pagedown`/`pageup`
    // here, these were the fourth and fifth keys bound to a string the decoder never emits.
    if (ev.key === 'pgdn') return move(10);
    if (ev.key === 'pgup') return move(-10);
    if (ev.key === 'right' || ev.key === 'left') {
      const f = state.panes?.focus;
      // PANNING takes the arrows while it is on, because that is the whole of what `w` offers: long
      // lines kept long and reached by moving sideways. Swapping the face here instead would leave the
      // mode with no way to see the right-hand end of a line, which is truncation with extra steps.
      if (f === 'detail' && state.noWrap && detailFace(state) === 0) {
        const step = Math.max(1, Math.floor(frameCols / 4));
        const next = (state.panX ?? 0) + (ev.key === 'right' ? step : -step);
        // Clamped at 0 and at the widest line: past the end there is nothing to show, and a pan that
        // ran off into blank columns would look exactly like a diff that had lost its content.
        const widest = (state.diffPatch ?? '').split('\n').reduce((w, l) => Math.max(w, l.length), 0);
        state.panX = Math.max(0, Math.min(next, Math.max(0, widest - 8)));
        state.status = state.panX ? `panned ${state.panX} columns — ←→ to pan, w to wrap` : 'at the left edge';
        return schedulePaint();
      }
      // Detail has two faces and no tab strip, so its arrows swap the face the strip would have.
      if (f === 'detail') return setDetailFace(detailFace(state) === 1 ? 0 : 1);
      if (f) {
        const tabs = PANE_SPECS.find((x) => x.id === f)!.tabs;
        if (tabs.length) {
          const at = state.panes!.tab[f] ?? 0;
          const next = (at + (ev.key === 'right' ? 1 : tabs.length - 1)) % tabs.length;
          state.panes = { ...state.panes!, tab: { ...state.panes!.tab, [f]: next } };
          state.cursor = 0;
          state.scroll = 0;
          const sc = paneScreen(f);
          if (sc !== 'diff') state.screen = sc as typeof state.screen;
          ask();
          return schedulePaint();
        }
      }
      return;
    }
    /**
     * CTRL CHORDS ARE THEIR OWN LAYER, and nothing falls out of it.
     *
     * This sits here, below every wall, so a chord acts only when no confirmation, filter, find or
     * command prompt is standing — the walls above already refuse to take a ctrl chord as text, and
     * before this they then let it drop straight through to the verb switch. Which was the bug: the
     * switch dispatches on `keys().get(ch)` where `ch` is the BARE letter, so every unbound chord ran
     * its plain key's verb. ^U reverted an edit, ^A kept one, ^E handed the terminal to $EDITOR, ^Y
     * copied and ^Q quit — ^U in particular being the kill-line reflex of every terminal there is.
     *
     * The paging set is vim's and every pager's: ^D/^U half, ^F/^B whole (a "page" is the ten rows
     * PgDn/PgUp already move, so ^F and PgDn agree). ^R is vim's redo. Anything else is SWALLOWED by
     * the return at the end, which is the whole point — an unbound chord must do nothing, not
     * something.
     */
    if (ev.ctrl) {
      if (ev.key === 'd') return move(5);
      if (ev.key === 'u') return move(-5);
      if (ev.key === 'f') return move(10);
      if (ev.key === 'b') return move(-10);
      if (ev.key === 'r') return mutateScope('redo', 'one');
      /**
       * ^Z — JOB CONTROL, which every terminal app is expected to honour and this one owns the whole
       * screen of. Raw mode means the driver never turns this into a signal for us, so it arrives as a
       * key and we raise it ourselves.
       *
       * The terminal has to be handed back FIRST — alternate screen off, raw mode off, mouse reporting
       * off — or the shell the reader lands in is drawing into our alternate buffer with echo disabled,
       * which looks exactly like a hung terminal. That is the same handover `e` already does for
       * $EDITOR, so it is the same pair of functions; the only new part is re-entering on SIGCONT,
       * which fires when the reader types `fg`.
       */
      if (ev.key === 'z') {
        suspendTerminal();
        process.once('SIGCONT', () => resumeTerminal());
        process.kill(process.pid, 'SIGTSTP');
        return;
      }
      return;
    }
    // Verbs dispatch on the ACTION a key is bound to, not on the key itself — that indirection is
    // what makes the options window's rebinds real rather than a list of numbers it saves and nothing
    // reads. Structural keys (F1-F6, arrows, Tab, Enter, Esc, Space, digits) are handled above and are
    // deliberately not rebindable: several of them are the only way out of a mode.
    const verb = keys().get(ch) ?? null;
    switch (verb ?? ch) {
      // VIM MOVEMENT, bound but deliberately NOT advertised. The key row promises arrows, because
      // that is what a reader who has never used vi will try — but every tool in this class binds
      // j/k, and a vim user pressing them into a dead keymap concludes the app is broken. Both work;
      // only one is taught.
      case ':': {
        /**
         * COMMAND MODE — k9s's colon.
         *
         * The product has grown verbs the app itself cannot reach: `remotes`, `store`, `ignore`,
         * `clean`, `resolve`. Reaching them meant quitting to a shell, which is a strange thing to
         * have to do inside the app that exists to review the thing they act on. One prompt, the
         * CLI's own verbs, and its output on the status row.
         *
         * Deliberately a SHORT allow-list, not a shell: this is a text field inside an app whose
         * other verbs revert files, and passing an arbitrary string to a process is how a settings
         * box becomes a shell. Closed on both halves — the verb AND its arguments — so every entry
         * is a read that cannot be turned into a write by what the reader types after it. See
         * COMMANDS for what that cost and why the arguments went.
         */
        cmdBuf = '';
        cmdOpen = true;
        state.status = ': ';
        return schedulePaint();
      }
      /**
       * MARK / UNMARK the row under the cursor, for acting on several at once.
       *
       * The review workflow this app is for is "read six files, then accept them together", and until
       * now that meant six keeps and six confirmations. A file HEADER marks every edit in its file,
       * which is the same rule `a` on a header already follows — the mark set is ids, so the two
       * cannot disagree about what a row stands for.
       */
      case 'mark': {
        const row = rowsOf()[state.cursor];
        if (!row?.ids.length) {
          state.status = 'nothing to mark on this row';
          return schedulePaint();
        }
        const marked = new Set(state.marked ?? []);
        const already = row.ids.every((id) => marked.has(id));
        for (const id of row.ids) (already ? marked.delete(id) : marked.add(id));
        state.marked = marked;
        state.status = marked.size
          ? `${marked.size} edit(s) marked — a/u act on all of them, esc clears`
          : 'nothing marked';
        return schedulePaint();
      }
      case "'":
        markPending = 'set';
        state.status = "set mark: press a letter (esc cancels)";
        return schedulePaint();
      case '`':
        markPending = 'jump';
        state.status = marks.size
          ? `go to mark: ${[...marks.keys()].sort().join(' ')} (esc cancels)`
          : 'no marks yet — set one with ’ then a letter';
        return schedulePaint();
      case 'sort': {
        // Through applyOption, the same call the options window's Order row makes, rather than a third
        // copy of the order list beside SORT_KEYS and that row. The key and the row cycle one
        // implementation, so they cannot end up offering different orders in different places.
        const cycled = applyOption(prefs, 'sort', 1);
        const next = cycled.sort ?? 'recent';
        saveOptions(cycled);
        state.sort = next;
        state.cursor = 0;
        state.scroll = 0;
        syncPane();
        state.status =
          next === 'recent' ? 'newest first' : next === 'path' ? 'sorted by path' : 'sorted by churn — biggest changes first';
        return schedulePaint();
      }
      case 'wrap': {
        // Wrapping is the default and stays the default — this product never truncates content. The
        // toggle turns on HORIZONTAL SCROLLING instead, which is what `delta` and `bat` offer: on a
        // wide patch, alignment is easier to read than reflowed lines, and nothing is hidden because
        // the pane scrolls to it.
        state.noWrap = !state.noWrap;
        // Back to 0 on the way out, and on the way in. Leaving a pan behind means the next patch opens
        // already scrolled sideways, with its left column — where a diff's +/- markers live — off screen
        // for a reader who never panned this one.
        state.panX = 0;
        state.status = state.noWrap
          ? 'long lines pan sideways — ←→ to pan, w to wrap again'
          : 'long lines wrap again';
        return schedulePaint();
      }
      case 'copy': {
        // WHAT IS ON SCREEN, to the system clipboard, over OSC-52.
        //
        // OSC-52 rather than pbcopy/xclip for one reason that matters here: this app lists sessions
        // on other machines, and a reader reviewing over ssh has no local clipboard tool to shell
        // out to — the escape travels the wire and the TERMINAL does the copying. Terminals that do
        // not implement it ignore an unknown OSC, so the cost of trying is nothing.
        //
        // What gets copied follows what you are LOOKING at: the diff face copies the patch, anything
        // else copies the selected row's file path. Copying "the selection" from a pane whose
        // selection is a file means the path — that is the thing anyone pastes into a message.
        const onDiff = state.panes?.focus === 'detail' && detailFace(state) === 0;
        const row = rowsOf()[state.cursor];
        // A FILE HEADER addresses every edit in its file, so `rowFile` (which answers only for a
        // single-edit row, by design) returns nothing for it — and the header is exactly the row a
        // reader is sitting on when they want the path. Its key carries that path.
        const text = onDiff ? state.diffPatch ?? '' : selectedPath(row) || state.diffMeta?.path || '';
        if (!text) {
          state.status = 'nothing here to copy — select an edit, or open its diff';
          return schedulePaint();
        }
        // Base64 without a line-wrap: a wrapped payload is a spec violation several terminals reject.
        const payload = Buffer.from(text, 'utf8').toString('base64');
        /**
         * BOUNDED, because over the limit this fails SILENTLY.
         *
         * A terminal that receives an OSC-52 longer than it will buffer drops the whole sequence —
         * no error, no reply, nothing this end can observe. tmux's documented ceiling is 74,994
         * bytes and several terminals are lower. Unbounded, a 4,000-line patch encoded past every
         * one of them while this line still said "copied the diff (4000 lines)", and the reader
         * pasted whatever was on their clipboard BEFORE — which is a worse outcome than not offering
         * the copy at all, because nothing tells them it did not happen.
         *
         * So it is refused, loudly, and names the way that does work. No truncation: half a patch on
         * the clipboard looks like a whole one.
         */
        const OSC52_MAX = 74_994 - 16; // the sequence's own wrapper is the rest
        if (payload.length > OSC52_MAX) {
          const id = state.diffMeta?.id;
          state.status =
            `too large to copy through the terminal (${Math.round(payload.length / 1024)}KB, limit ~73KB)` +
            (id !== undefined ? ` — try: claude-observatory diff ${id}` : '');
          return schedulePaint();
        }
        process.stdout.write(`\x1b]52;c;${payload}\x07`);
        const what = onDiff ? `the diff (${text.split('\n').length} lines)` : text;
        state.status = `copied ${what}`;
        return schedulePaint();
      }
      case 'j':
        return void onKey({ ...ev, key: 'down' });
      case 'k':
        return void onKey({ ...ev, key: 'up' });
      // …and the jumps. `g`/`G` are universal, and a 2,000-row Traces pane without them means holding
      // a key for a page at a time.
      case 'g': {
        state.cursor = 0;
        state.scroll = 0;
        syncPane();
        return schedulePaint();
      }
      case 'G': {
        state.cursor = Math.max(0, rowsOf().length - 1);
        clampCursor();
        syncPane();
        return schedulePaint();
      }
      // `case '\x03'` used to sit here too, and was dead: `ch === '\x03'` already returned 200 lines
      // above, at the only place ^C can reach. Two spellings of one key, one of them unreachable.
      case 'quit':
        restore();
        process.exit(0);
        return;
      // `case '\t'` here was dead: the decoder names this key `tab` (tui/input.ts CTRL_NAME), and
      // `ch` is that name, so the comparison could never be true. `enter` next door was right, which
      // is what made the bug invisible — one key in the table spelled as a byte, the rest as names.
      case 'tab': {
        // Tab cycles the OPEN panes in dock order. A minimized pane is not in the rotation — landing
        // focus on a window with no box would leave the reader pressing arrows at nothing.
        const open = layout().boxes.map((b) => b.id);
        if (!open.length) return;
        const at = open.indexOf(state.panes!.focus);
        return focusPane(open[(at + 1) % open.length]);
      }
      case 'minimize': {
        // Minimize/restore the focused pane. The dual of zoom, and the pane keeps its chip and its
        // counter on the window bar — a tool does not withdraw its alarm to save a row.
        const m = new Set(state.panes!.minimized);
        const f = state.panes!.focus;
        if (m.has(f)) m.delete(f);
        else m.add(f);
        state.panes = { ...state.panes!, minimized: m, zoom: null };
        const open = resolveLayout({ cols: frameCols, rows: frameRows, minimized: m, zoom: null, focus: f, tab: state.panes!.tab }).boxes;
        if (open.length && !open.some((b) => b.id === f)) return focusPane(open[0].id);
        ask();
        return schedulePaint();
      }
      case 'zoom':
      case '+':
        return toggleZoom(state.panes!.focus);
      case '<':
      case ',':
        return nudgeSize(-2);
      case '>':
      case '.':
        return nudgeSize(2);
      case 'reset':
      case '_':
        // One key back to the resolved default, btop's preset spirit.
        state.panes = { ...state.panes!, minimized: defaultMinimized(frameCols, frameRows), zoom: null, sizes: {} };
        state.status = 'layout reset';
        ask();
        return schedulePaint();
      case '[':
      case ']': {
        const f = state.panes!.focus;
        const tabs = PANE_SPECS.find((x) => x.id === f)!.tabs;
        // Three of the four panes have no strip, and `% 0` is NaN — which went straight into
        // `panes.tab` and made the pane render nothing at all until the layout was reset.
        if (!tabs.length) {
          state.status = `${PANE_SPECS.find((x) => x.id === f)!.title} has no tabs`;
          return schedulePaint();
        }
        const at = state.panes!.tab[f] ?? 0;
        const next = (at + (ch === ']' ? 1 : tabs.length - 1)) % tabs.length;
        state.panes = { ...state.panes!, tab: { ...state.panes!.tab, [f]: next } };
        state.cursor = 0;
        state.scroll = 0;
        const sc = paneScreen(f);
        if (sc !== 'diff') state.screen = sc as typeof state.screen;
        ask();
        return schedulePaint();
      }
      // `N` is next/previous MATCH, the pairing every tool with a find uses. It only ever means that:
      // with no find standing it says so rather than falling through to the review stepper, because
      // `n` and `N` doing two unrelated things depending on hidden state is the thing this fixes.
      /**
       * JUMP TO A PATH, rather than narrowing to it.
       *
       * The filter answers "show me only these"; this answers "take me there and leave the list
       * alone", which is the other half and the one a 546-file session actually needs. It reuses the
       * session picker's overlay machinery — a filtered list you arrow through and Enter — because a
       * second picker implementation is a second set of edge cases.
       */
      case 'P': {
        const rows = rowsOf('edits', 'traces').map((r, i) => ({ r, i })).filter(({ r }) => r.key?.startsWith('f'));
        if (!rows.length) {
          state.status = 'no files to jump to yet';
          return schedulePaint();
        }
        jumpRows = rows.map(({ i }) => i);
        state.overlay = {
          title: 'go to file  —  ↑↓ move · enter open · esc cancel',
          lines: rows.map(({ r }) => `  ${r.cells.trim()}`),
          scroll: 0,
          cursor: 0,
        };
        return schedulePaint();
      }
      case 'N':
        if (!lastFind) {
          state.status = 'no find to repeat — / filters the list, and the Diff face has its own find';
          return schedulePaint();
        }
        return jumpToMatch(lastFind, -1);
      case 'next':
      case 'prev': {
        // WITH A FIND STANDING on the Diff face, these repeat it — `n`/`p` mean "next match" in every
        // tool that has a find, and stepping to another edit would throw away the search you just ran.
        // Anywhere else they keep their review meaning, which is what the navbar advertises.
        //
        // `lastFind` is CLEARED when the reader leaves that state (see clearFind), so this branch is
        // reachable in both directions. It used to be set once and never unset: after a single
        // successful find, `n`/`p` meant "next match" on the Diff face for the rest of the session,
        // even after selecting a different edit with a different patch, and no key got the review
        // stepper back.
        if (lastFind && state.panes?.focus === 'detail' && detailFace(state) === 0) {
          return jumpToMatch(lastFind, verb === 'next' ? 1 : -1);
        }
        // Step the review one edit at a time from ANY window — the navbar advertises these, so they
        // must not require focusing Traces first.
        const f = state.panes?.focus;
        if (f && f !== 'traces') focusPane('traces');
        return move(verb === 'next' ? 1 : -1);
      }
      case 'editor':
        return openInEditor();
      case 'options':
        return openOptions();
      case 'keep':
        return mutateScope('keep', 'one');
      case 'undo':
        return mutateScope('undo', 'one');
      case 'keepAll':
        return mutateScope('keep', 'all');
      case 'undoAll':
        return mutateScope('undo', 'all');
      case ' ':
        // Space is the fold key everywhere a tree exists — and on a row that is not a folder it does
        // nothing rather than drilling in, because Enter already means "open this" and a space bar
        // that sometimes opens a diff is a space bar nobody presses twice.
        {
          const row = rowsOf()[state.cursor];
          if (row?.openPath === undefined) {
            state.status = 'space folds a change-map folder — this row is not one';
            return schedulePaint();
          }
          return openSelected();
        }
      case 'enter':
        openSelected();
        return;
      case 'session':
        openSessionPicker();
        return;
      case 'refresh':
        state.status = 'refreshing…';
        ask();
        return schedulePaint();
      case 'filter':
        // ON THE DIFF FACE, `/` searches the PATCH. Everywhere else it filters the list.
        //
        // The list filter cannot help inside a 341-line diff — it narrows rows, and the diff is one
        // row's contents. `delta`, `tig` and `lazygit` all search within the patch, and without it a
        // long edit can only be read by scrolling past what you are looking for.
        if (state.panes?.focus === 'detail' && detailFace(state) === 0) {
          diffFindOpen = true;
          diffFind = '';
          state.status = 'find in diff: ';
          return schedulePaint();
        }
        filterOpen = true;
        state.filterOpen = true;
        state.filter = '';
        return schedulePaint();
      case 'help': {
        state.overlay = { title: 'keys  —  esc or ? to close', lines: helpLines(prefs), scroll: 0 };
        return schedulePaint();
      }
      default:
        return;
    }
  }
}

/**
 * Command mode's allow-list: the whole of what `:` can run.
 *
 * An ALLOW-LIST, never a shell — and closed on ARGUMENTS as well as verbs, which it was not. Three of
 * these took the rest of the line and handed it to the CLI, so `:store --move /tmp/x` relocated every
 * session's edits, snapshots and caches and rewrote prefs, with no confirmation, from a text field
 * inside an app whose other keys revert files. `:remotes --add` and `:ignore` were the same shape. The
 * documented contract was always "an allow-list of READ-ONLY verbs", so the fix is the code, not the
 * sentence: each entry now runs its bare reading form and nothing else. Moving the store and editing
 * remotes have real UI in the options window, where they can say what they are about to do.
 *
 * Exported so a test can assert the list is what it claims — see the command-mode checks in
 * `core.test.js` and `tty-drive.js`.
 */
export const COMMANDS: Readonly<Record<string, { args: () => string[]; what: string }>> = {
  help: { args: () => ['help'], what: 'the CLI’s own help — every verb this build has' },
  // `?` is the key the frame advertises for help everywhere else, so it is the thing a reader types
  // into a prompt first. It answered "no command" until now.
  '?': { args: () => ['help'], what: 'the CLI’s own help — every verb this build has' },
  remotes: { args: () => ['remotes'], what: 'the machines to look for sessions on' },
  store: { args: () => ['store'], what: 'where the observatory keeps its data' },
  ignore: { args: () => ['ignore'], what: 'what .observatoryignore covers' },
  doctor: { args: () => ['doctor'], what: 'check the setup' },
  status: { args: () => ['status'], what: 'hooks, session and edit counts' },
  version: { args: () => ['version'], what: 'this build' },
};

/**
 * The `?` overlay's lines, built from the reader's OWN keymap.
 *
 * A function, and exported, so a test can read what this screen actually says. It used to be a literal
 * inside the key handler, reachable only by pressing `?` — which is how `sort` and `wrap` came to be
 * bound to keys that no surface in the product named. `keymapCoverage` in the core tests walks this
 * against REBINDABLE and fails on the next verb that ships without a door.
 */
export function helpLines(prefs: import('@claude-observatory/core').Prefs): string[] {
  const keys = () => coreKeymap(prefs);
  /**
   * Rows built from the reader's OWN keymap.
   *
   * This screen used to hard-code its letters, which is how it came to advertise "1-6 screens"
   * for a build that had none — and once keys became rebindable, a hard-coded list is a list
   * that lies to exactly the reader who customised it.
   */
  const boundRows = (rows: readonly (readonly [string, string])[]): string[] => {
    const km = keys();
    const keyFor = (action: string): string => {
      for (const [k, a] of km) if (a === action) return k;
      return '—'; // rebound onto a key another action won: keyConflicts already says so
    };
    return rows.map(([action, what]) => `    ${keyFor(action).padEnd(14)} ${what}`);
  };
  // A real help surface, not a one-line status. It listed "1-6 screens" — a keymap that never
  // existed in this build (there were eight, and now there are five windows), and `?` is the
  // key the frame itself advertises, so it is the one thing that must not be stale.
  return [
      '  WINDOWS',
      '    F1                  focus Claude — the live tail of what the agent is doing; press it',
      '                        AGAIN to hand this terminal to `claude --resume` for this session',
      '                        (a live session asks first; G follows the newest entry)',
      '    F2 / F3             focus Prompts / Traces',
      '    F4 / F5             the CENTRE window, showing its Map or its Diff face',
      '    F6                  focus Dashboards',
      '                        (a minimized window comes back; pressing its key again zooms it',
      '                         to the whole frame, and once more puts it back — except Claude,',
      '                         whose second press launches the agent)',
      '    0 - 9               type an EDIT id, then Enter to select it — digits are not',
      '                        window keys; the F-keys are',
      '    Tab                 next open window        [ ]   previous / next tab in it',
      '    m                   minimize or restore     z     zoom the focused window',
      '    < / >               grow / shrink the focused window along its own axis — width for',
      '                        Traces and Detail, height for Claude, Prompts and Dashboards',
      '                        (same as dragging its seam)',
      '    =                   reset the layout, and any widths you set, to what this size gives',
      '',
      '    drag the seam between two windows to resize them.',
      '    drag across a window body to copy those lines to the clipboard (OSC 52).',
      '',
      '  THE DETAIL NAVBAR  (click a button, or use the key)',
      '    Keep / Undo    a / u — act on the edit Detail is SHOWING',
      '    prev / next    p / n — step the review one edit at a time, from any window',
      '                   (with a find standing on the Diff face they repeat it instead, and',
      '                    N goes back a match; esc or moving the selection ends the find)',
      '',
      '  MOVING',
      '    up / down       move the selection in the FOCUSED window; on Detail, scroll the diff',
      '    left / right    previous / next tab       PgUp / PgDn   move ten',
      '    0-9 then enter  go to an edit by its id (esc cancels, backspace deletes)',
      '    space           fold or unfold a change-map folder',
      '    enter           open — a folder on Map, otherwise the edit full screen',
      '    esc             back — closes a zoom, a prompt scope, a filter or an overlay',
      '    /               filter (esc clears and closes, enter keeps it)',
      '',
      '  REVIEWING  (these act on the focused window only)',
      ...boundRows([
        ['keep', 'keep the selection'],
        ['undo', 'undo the selection'],
        ['keepAll', 'keep everything the window lists — asks first, with the count'],
        ['undoAll', 'undo everything the window lists — asks first, with the count'],
      ]),
      '    ^R             redo — vim’s own. Not rebindable: the ctrl chords are a fixed layer',
      '    y / n          answer a confirmation while one is standing (that question is a wall:',
      '                   it takes every key until you answer, so y means yes there and copy',
      '                   everywhere else)',
      '',
      '  CTRL  (a fixed layer — every other ctrl chord does nothing, on purpose)',
      '    ^D / ^U        half a page down / up          ^F / ^B   a whole page',
      '    ^R             redo          ^Z   suspend (fg brings it back)          ^C   quit',
      '',
      '    P              go to a file — a picker, not a filter: it takes you there and leaves the',
      '                   list alone (the filter narrows; this jumps)',
      '',
      '  MARKS  (vim’s `m` is taken — it minimizes a window — so both jump keys do the work)',
      '    ’ then a letter   set a mark on the selected edit',
      '    ` then a letter   go back to it. Marks follow the EDIT, so a re-sort or a filter cannot',
      '                      leave one pointing at a different file. They last for this session.',
      '',
      '  MOVING',
      '    ↑↓ or j/k      move            g / G   first / last row',
      '    PgUp / PgDn    a page          /       filter (matches scattered letters: pcsi finds',
      '                                           packages/core/src/index.ts)',
      '',
      '  THE LIST',
      ...boundRows([
        ['mark', 'mark or unmark this row — then a / u act on every marked edit at once, and esc clears'],
        ['sort', 'order Traces by newest / by path / by churn — cycles, and says which is in force'],
        ['wrap', 'wrap long diff lines, or leave them long and pan across with ← →'],
        ['filter', 'filter (matches scattered letters: pcsi finds packages/core/src/index.ts)'],
      ]),
      '',
      '  SESSION AND APP',
      ...boundRows([
        ['session', 'browse sessions — type to filter, on this machine and any remotes'],
        ['refresh', 'refresh'],
        ['copy', 'copy the selected path — or the diff, when the Diff face is focused'],
        ['editor', 'open the selection in $EDITOR (hands over the terminal until it exits)'],
        ['options', 'options (editor, display, store, machines, keys)'],
        ['help', 'these keys'],
        ['quit', 'quit'],
      ]),
      '',
      '  Every key in the two lists above is READ FROM YOUR OWN KEYMAP, so a rebind shows here',
      '  the moment you make it. They can all be rebound from the options window; the structural',
      '  keys cannot — F1-F6, the arrows, Tab, Enter, Esc, Space and the digits are how you leave',
      '  a mode, and a rebind that took one away would leave no way out.',
  ];
}

/** One-shot read for the non-interactive path: no watcher, no timers, no terminal state. */
function createOnce(core: Core, cwd: string, session: string, views: string[]): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const child = core.spawnTool(
      process.execPath,
      [process.argv[1], 'views', '--views', views.join(','), '--json', '--session', session],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_OBSERVATORY_NO_UPDATE_CHECK: '1' } }
    );
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const out = Buffer.concat(chunks).toString('utf8');
        resolve(out.trim() ? (JSON.parse(out) as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
  });
}
