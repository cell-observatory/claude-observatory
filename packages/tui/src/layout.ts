/**
 * Where the windows go.
 *
 * The terminal mirrors the editors: **Prompts** on top, **Traces** left, **Dashboards** along the
 * bottom, docked around a centre. In an editor that centre is the code, because the code is the
 * object under review. A terminal has no buffer, but it has the same object in the only form review
 * needs — the before-and-after — so the centre is **Detail**: the selected edit's diff, or the
 * session's change map when nothing is selected.
 *
 * There is no right-hand sidebar. Observations and Actions used to live there as two stacked
 * sections; they are Dashboards tabs now. A third column cost Detail 30 columns of diff on every
 * terminal narrower than 98, which is most of them, to show two lists that are read after the diff
 * rather than beside it.
 *
 * Everything here is a pure function of `(cols, rows, minimized, zoom, focus, tab)`. No terminal, no
 * clock, no filesystem. That is what lets a 60-column degradation be asserted line by line in a unit
 * test instead of being discovered by a reader whose window was too small.
 *
 * Three rules earned their place by measurement rather than taste:
 *
 * **Zoom folds into minimize.** `zoom: X` means "every other pane is minimized". One code path serves
 * zoom, hand-minimize, and forced degradation, so all three are tested at once and zoom works for all
 * four panes rather than the two a centre-special-case would have covered.
 *
 * **The latch.** Shrinking the terminal may force a pane closed; growing it never re-opens one. This
 * is `ColumnLayout.dividerProportion`'s rule, already shipped and tested in both JetBrains surfaces,
 * ported here. Without it, growing an 80-column window from 27 to 28 rows *shrinks* Traces from 20
 * rows to 14 — the panel lurches while the reader is dragging the edge. The runtime owns `minimized`
 * and folds `forced` into it; only the reader takes a pane back out.
 *
 * **Refusal is loud.** A pane that will not fit lands in `blocked` with the number it would take, and
 * that reaches the status row. A layout that silently drops a window is a silent failure, and this
 * product does not have those.
 */

import { displayWidth } from './textwidth';

export type PaneId = 'prompts' | 'traces' | 'detail' | 'dashboards';
export type Dock = 'top' | 'left' | 'centre' | 'bottom';
/** `wide` is both columns; `stack` is one; `dock-only` is neither, leaving Prompts and Dashboards. */
export type LayoutMode = 'wide' | 'stack' | 'dock-only';

export interface PaneSpec {
  id: PaneId;
  /**
   * The function key that reaches this pane — see `BAR_ENTRIES`, which is the authority when a pane
   * has more than one (Detail answers to both F3 and F4, one per face). Pressing a pane's key when
   * it is already showing zooms it, and again puts it back.
   *
   * The digits are not available for this — they name EDITS, and an edit id is the thing a reviewer
   * says out loud ("undo 122"), so it outranks a window shortcut for the shorter key.
   */
  n: number;
  title: string;
  dock: Dock;
  /** Preferred extent along the dock's axis: COLUMNS for left/centre/right, ROWS for bottom. */
  want: number;
  /** Below this the pane cannot render honestly and is minimized instead. Same unit as `want`. */
  min: number;
  /** Who gives way first when space runs out. Lowest yields first; the focused pane is last. */
  yield: number;
  /**
   * This pane draws an action bar directly under its title, and the geometry has to KNOW that.
   * Detail's navbar used to be pushed in by the renderer alone, so `hitTest` called that row body:
   * every button was drawn where nothing was clickable, each body click landed one row off, and the
   * pane composed one line taller than its box, which the compositor dropped off the bottom.
   */
  nav?: boolean;
  /** The internal tab strip, mirroring the editors' views. */
  tabs: readonly string[];
  /** Which tab opens first, when the reader has not chosen one. Index into `tabs`; 0 if absent. */
  defaultTab?: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TabSpan {
  index: number;
  label: string;
  x: number;
  w: number;
  selected: boolean;
}

export interface PaneBox {
  id: PaneId;
  focused: boolean;
  selTab: number;
  /** The whole box: title row, tab row, body. */
  rect: Rect;
  titleRow: number;
  /** The action-bar row, or -1. Renderer and hit-tester both read THIS rather than each deciding. */
  navRow: number;
  tabsRow: number;
  /** Where each drawn tab sits. The renderer draws FROM these; it must never recompute them, or the
   *  mouse and the paint disagree and clicks land on the wrong tab. */
  tabSpans: readonly TabSpan[];
  /** Tabs the strip could not draw, named as a count. Chrome overflows by dropping whole tabs. */
  tabMore: {
    pre: { x: number; w: number; hidden: number } | null;
    post: { x: number; w: number; hidden: number } | null;
  };
  /** Content area, title and tab rows excluded. */
  body: Rect;
}

export interface BarChip {
  pane: PaneId;
  /** The function key that jumps here. Not an index: two chips can point at one pane. */
  key: number;
  /** What the chip is called. For a face chip this is the FACE's name, not the pane's. */
  title: string;
  /** Which of Detail's faces this chip selects, or undefined for a whole-pane chip. */
  face?: number;
  x: number;
  w: number;
  /** The one cell that toggles minimize. The rest of the chip focuses. */
  twigX: number;
  open: boolean;
  focused: boolean;
}

export interface Layout {
  mode: LayoutMode;
  cols: number;
  rows: number;
  bodyH: number;
  colH: number;
  dashH: number;
  /** Only OPEN panes. A minimized pane has no box — it lives on `bar`, keeping its counter. */
  boxes: readonly PaneBox[];
  bar: readonly BarChip[];
  /** What had to give, in words. */
  notes: readonly string[];
  /** Panes this resolve forced closed. The runtime latches these into `minimized`. */
  forced: readonly PaneId[];
  /** Panes the reader has a key for that this size cannot hold, and what it would take. */
  blocked: readonly { pane: PaneId; need?: number; needRows?: number }[];
  /**
   * The draggable boundaries. A vertical seam sits at column `x` across the column band; a
   * horizontal one sits at row `y` across the full width.
   *
   * `target` is the pane a drag actually resizes, and it is NOT always the pane on the left. The
   * centre is a flex pane whose width is computed as the remainder, so writing a size for it is
   * silently discarded — dragging the Traces|Detail seam therefore has to resize TRACES. `sign`
   * carries the direction: +1 when moving the pointer along the axis grows the target, -1 when it
   * shrinks it.
   */
  seams: readonly {
    axis: 'v' | 'h';
    x: number;
    y: number;
    left: PaneId;
    right: PaneId;
    target: PaneId;
    sign: 1 | -1;
  }[];
  zoom: PaneId | null;
  focus: PaneId;
  chrome: { top: number; bottom: number };
}

export interface LayoutRequest {
  cols: number;
  rows: number;
  minimized: ReadonlySet<PaneId>;
  zoom?: PaneId | null;
  focus: PaneId;
  tab?: Readonly<Partial<Record<PaneId, number>>>;
  /**
   * Widths the reader set by dragging a seam, overriding `want` for those panes. They ride the same
   * share/clamp path as the defaults — a second sizing route would drift from the tested one — and
   * they are still floored at `min`, so a drag can never produce a pane that cannot render honestly.
   */
  sizes?: Readonly<Partial<Record<PaneId, number>>>;
  /** Which of Detail's faces is showing (0 Diff, 1 Map). It decides which of the two Detail chips on
   *  the window bar is marked current — geometry cannot derive it, because it depends on whether an
   *  edit is selected, which is state this pure function is deliberately not given. */
  detailFace?: number;
}

/**
 * window bar · session-and-attention row.
 *
 * The window bar leads. It is the only row that names every region and carries its jump key, so it
 * is the frame's table of contents — and a table of contents printed third, under two rows of
 * session state, is one the reader has to go looking for.
 *
 * Two rows, not three: the session name and the attention counts are both short strings, and a
 * terminal is far shorter than it is wide. Giving each its own row spent a line of every window
 * below on whitespace the other one was already padding.
 */
export const CHROME_TOP = 2;
/** status row · keys row */
export const CHROME_BOTTOM = 2;
/** The column band never gives the bottom dock rows below this, by DEFAULT. */
export const COL_FLOOR = 16;
/** …but a reader who drags the seam may take it this low. Their instruction outranks our default. */
export const DRAG_COL_FLOOR = 6;

/**
 * Every tab here has a row producer behind it. The editors' windows carry a few views the terminal
 * cannot draw yet (File History, Stats), and listing them would buy a strip that matches the IDE
 * screenshot at the cost of tabs that open onto nothing — a hole the reader finds by clicking. They
 * are absent until they render; the docs say which, rather than the strip implying otherwise.
 */
export const PANE_SPECS: readonly PaneSpec[] = [
  // DECLARATION ORDER IS WINDOW-BAR ORDER, and the bar reads left to right as F1, F2, F3, F4. The
  // keys number the regions in the order a review moves through them — what was asked, what it
  // changed, what else is going on — and Detail is last because it is what the other three point at.
  //
  // Prompts leads, directly under the session selector: the session says WHOSE work this is and the
  // prompt says WHAT was asked, and every row below is downstream of those two facts.
  { id: 'prompts', n: 1, dock: 'top', title: 'Prompts', min: 3, want: 6, yield: 0, tabs: [] },
  // Edits and Diffs are ONE list. They were never two things — a diff is what an edit contains, so
  // splitting them made the reader switch tabs to see the thing they had already selected.
  // Titled for the WINDOW, not its contents: the editors call this Observatory Traces, and a reader
  // moving between the terminal and an IDE should not have to learn two names for one thing.
  { id: 'traces', n: 2, dock: 'left', title: 'Traces', min: 30, want: 42, yield: 3, tabs: [] },
  // The centre carries TWO faces — the selected edit's diff, and the session's change map — and only
  // ever one at a time. They are the same question at two scales, so giving each its own window would
  // put a third column in the band and take the whole layout back over 98 terminal columns to show
  // two things nobody reads at once. `nav` buys the row that carries the swap, and the review
  // buttons, without spending a second chrome row on a tab strip.
  { id: 'detail', n: 3, dock: 'centre', title: 'Detail', min: 36, want: 0, yield: 4, nav: true, tabs: [] },
  // Everything that is not the edit under review. Observations and Actions arrived here when the
  // right-hand sidebar went. Ordered by what a review reaches for: who did the work and under what
  // plan, then what was observed and what was run, then the machinery.
  {
    id: 'dashboards', n: 5, dock: 'bottom', title: 'Dashboards', min: 7, want: 10, yield: 2,
    tabs: ['Fleet', 'Workflows', 'Tasks', 'Observations', 'Actions', 'Processes', 'Feed'],
  },
];


/**
 * The window bar, chip by chip — and the function key that jumps to each.
 *
 * FIVE chips over four panes. Detail's two faces get a key each, because "show me the map" and "show
 * me this diff" are two different intentions and making the reader press one key and then swap is a
 * step for nothing. They are still ONE window: pressing either key focuses Detail and sets its face,
 * and only one of the two chips is ever marked current.
 */
export interface BarEntry {
  key: number;
  pane: PaneId;
  title: string;
  face?: number;
}
export const BAR_ENTRIES: readonly BarEntry[] = [
  { key: 1, pane: 'prompts', title: 'Prompts' },
  { key: 2, pane: 'traces', title: 'Traces' },
  { key: 3, pane: 'detail', title: 'Map', face: 1 },
  { key: 4, pane: 'detail', title: 'Diff', face: 0 },
  { key: 5, pane: 'dashboards', title: 'Dashboards' },
];

/**
 * Which screen produces a pane's rows. Panes with no tab strip take the first entry, except Detail,
 * which the renderer resolves from the selection.
 *
 * File History is gone: it had no "active editor" to follow in a terminal, so it could only ever
 * mirror whatever was already selected in the list beside it.
 */
export const TAB_SCREEN: Record<PaneId, readonly string[]> = {
  prompts: ['prompts'],
  traces: ['edits'],
  // Detail has no strip. Its face comes from the swap in its action bar, and from the selection when
  // the reader has not touched that — see `paneScreenOf`.
  detail: ['diff', 'map'],
  dashboards: ['agents', 'workflows', 'tasks', 'observations', 'audit', 'processes', 'feed'],
};

const BY_ID: Record<PaneId, PaneSpec> = Object.fromEntries(PANE_SPECS.map((p) => [p.id, p])) as Record<PaneId, PaneSpec>;
const COLUMNS: readonly PaneId[] = ['traces', 'detail'];

/** Widths for a set of panes: start at `min`, grow proportionally toward `want`, largest-remainder. */
function share(total: number, mins: number[], wants: number[]): number[] {
  const spanTotal = wants.reduce((a, w, i) => a + (w - mins[i]), 0);
  const room = total - mins.reduce((a, b) => a + b, 0);
  if (spanTotal <= 0 || room <= 0) return mins.slice();
  const t = Math.min(1, room / spanTotal);
  const exact = mins.map((m, i) => m + t * (wants[i] - m));
  const out = exact.map((v) => Math.floor(v));
  let used = out.reduce((a, b) => a + b, 0);
  const rema = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  let k = 0;
  while (used < total && k < rema.length * 8) {
    out[rema[k % rema.length].i]++;
    used++;
    k++;
  }
  return out;
}

const needCols = (ids: readonly PaneId[]): number =>
  ids.reduce((a, id) => a + BY_ID[id].min, 0) + Math.max(0, ids.length - 1);

export function resolveLayout(req: LayoutRequest): Layout {
  const { cols, rows, focus } = req;
  const zoom = req.zoom ?? null;
  const notes: string[] = [];
  const forced: PaneId[] = [];
  // A zoom IS a minimize of everything else. One path, so zoom is correct for all four panes.
  const min = new Set<PaneId>(zoom ? PANE_SPECS.filter((p) => p.id !== zoom).map((p) => p.id) : req.minimized);
  const bodyH = Math.max(0, rows - CHROME_TOP - CHROME_BOTTOM);

  let open = COLUMNS.filter((id) => !min.has(id));
  // The focused pane is never the victim while another column could go instead: at 60 columns you
  // want the list you are acting on, not a diff of something you can no longer select.
  const victims = open.filter((id) => id !== focus).sort((a, b) => BY_ID[a].yield - BY_ID[b].yield);
  while (open.length > 1 && needCols(open) > cols) {
    const v = victims.shift() ?? open.find((id) => id !== focus) ?? open[0];
    open = open.filter((id) => id !== v);
    min.add(v);
    forced.push(v);
    notes.push(`${BY_ID[v].title} minimized: ${cols} columns cannot hold it and still leave ${BY_ID.detail.min} for Detail`);
  }
  const mode: LayoutMode = open.length >= 2 ? 'wide' : open.length === 1 ? 'stack' : 'dock-only';
  if (open.length === 1 && cols < BY_ID[open[0]].min) {
    notes.push(`${cols} columns is under the ${BY_ID[open[0]].min} ${BY_ID[open[0]].title} wants; rows wrap`);
  }

  // The TOP band is carved first: Prompts sits under the session selector and above everything the
  // prompt caused. It yields before the bottom dock (yield 0) because the bottom dock is a summary
  // and the prompt is the question the whole screen is answering.
  let topH = 0;
  const topOpen = zoom === 'prompts' || (!min.has('prompts') && zoom === null);
  if (topOpen && open.length) {
    const room = bodyH - COL_FLOOR;
    if (room < BY_ID.prompts.min) {
      min.add('prompts');
      forced.push('prompts');
      notes.push(`Prompts minimized: it needs ${COL_FLOOR + BY_ID.prompts.min} body rows; this terminal has ${bodyH}`);
    } else {
      topH = Math.min(req.sizes?.prompts ?? BY_ID.prompts.want, room);
    }
  } else if (zoom === 'prompts') {
    topH = bodyH;
  }

  let dashOpen = zoom === 'dashboards' || !min.has('dashboards');
  let dashH = 0;
  if (open.length === 0) {
    dashH = dashOpen ? bodyH : 0;
  } else if (dashOpen) {
    // COL_FLOOR keeps the DEFAULT layout from starving the column band for a summary pane. A drag is
    // an explicit request, not a default, so a reader-set height may go past it — down to a floor
    // that still leaves the band readable. Refusing a direct instruction reads as the drag being broken.
    const floor = req.sizes?.dashboards !== undefined ? DRAG_COL_FLOOR : COL_FLOOR;
    const room = bodyH - topH - floor;
    if (room < BY_ID.dashboards.min) {
      dashOpen = false;
      min.add('dashboards');
      forced.push('dashboards');
      notes.push(`Dashboards minimized: it needs ${COL_FLOOR + BY_ID.dashboards.min} body rows; this terminal has ${bodyH - topH}`);
    } else {
      dashH = Math.min(Math.max(BY_ID.dashboards.min, req.sizes?.dashboards ?? BY_ID.dashboards.want), room);
    }
  }
  const colH = bodyH - dashH - topH;

  const boxes: PaneBox[] = [];
  if (topH > 0) boxes.push(makeBox('prompts', 0, CHROME_TOP, cols, topH, focus === 'prompts', 0));
  const y0 = CHROME_TOP + topH;
  if (open.length && colH > 0) {
    const avail = cols - (open.length - 1); // one seam column between adjacent panes
    let widths: number[];
    if (open.length === 1) {
      widths = [avail];
    } else if (open.includes('detail')) {
      // Sides take what they want up to the point Detail still has its minimum; Detail absorbs the
      // rest. The centre is the thing being read, so it is the one that grows with the window.
      const sides = open.filter((id) => id !== 'detail');
      const target = avail - BY_ID.detail.min;
      const wantOf = (id: PaneId) => Math.max(BY_ID[id].min, req.sizes?.[id] ?? BY_ID[id].want);
      const sw = share(
        Math.min(target, sides.reduce((a, id) => a + wantOf(id), 0)),
        sides.map((id) => BY_ID[id].min),
        sides.map((id) => wantOf(id))
      );
      const map: Partial<Record<PaneId, number>> = {};
      sides.forEach((id, i) => (map[id] = sw[i]));
      map.detail = avail - sw.reduce((a, b) => a + b, 0);
      widths = open.map((id) => map[id] as number);
    } else {
      const sw = share(
        avail,
        open.map((id) => BY_ID[id].min),
        open.map((id) => Math.max(BY_ID[id].min, req.sizes?.[id] ?? BY_ID[id].want))
      );
      sw[Math.max(0, open.indexOf(focus))] += avail - sw.reduce((a, b) => a + b, 0);
      widths = sw;
    }
    let x = 0;
    open.forEach((id, i) => {
      boxes.push(makeBox(id, x, y0, widths[i], colH, focus === id, req.tab?.[id] ?? BY_ID[id].defaultTab ?? 0, id === 'detail' && req.detailFace === 1));
      x += widths[i] + 1;
    });
  }
  if (dashH > 0) {
    boxes.push(makeBox('dashboards', 0, y0 + colH, cols, dashH, focus === 'dashboards', req.tab?.dashboards ?? BY_ID.dashboards.defaultTab ?? 0));
  }
  if (zoom === 'prompts' && !boxes.length) boxes.push(makeBox('prompts', 0, CHROME_TOP, cols, bodyH, true, 0));

  // Every pane keeps a chip whether or not it has a box, so a minimized pane never loses its counter.
  const bar: BarChip[] = [];
  let bx = 0;
  for (const e of BAR_ENTRIES) {
    const w = 3 + 1 + displayWidth(e.title); // "Fn " + twig + title
    bar.push({
      pane: e.pane,
      key: e.key,
      title: e.title,
      face: e.face,
      x: bx,
      w,
      twigX: bx + 3,
      open: boxes.some((b) => b.id === e.pane),
      // A face chip is current only when its pane is focused AND that face is the one showing —
      // otherwise both of Detail's chips would light up and the bar would stop answering "where am I".
      focused: focus === e.pane && (e.face === undefined || e.face === req.detailFace),
    });
    bx += w + 3;
  }

  // `blocked` is for panes the SIZE refused, never for panes the reader closed on purpose. Under a
  // zoom every other pane is absent by request, so reporting what each would cost turns the status
  // row into noise and buries whatever it was actually saying.
  const blocked: { pane: PaneId; need?: number; needRows?: number }[] = [];
  if (!zoom) {
    for (const id of COLUMNS) {
      if (boxes.some((b) => b.id === id)) continue;
      const n = needCols([...open, id]);
      if (n > cols) blocked.push({ pane: id, need: n });
    }
    if (!boxes.some((b) => b.id === 'dashboards') && bodyH - COL_FLOOR < BY_ID.dashboards.min && open.length) {
      blocked.push({ pane: 'dashboards', needRows: COL_FLOOR + BY_ID.dashboards.min });
    }
  }

  const band = boxes.filter((b) => b.id !== 'dashboards' && b.id !== 'prompts').sort((a, b) => a.rect.x - b.rect.x);
  const seams: Layout['seams'][number][] = band.slice(0, -1).map((b, i) => {
    const right = band[i + 1].id;
    // Resize whichever side is NOT the flex centre; dragging toward a right-hand target shrinks it.
    const target = b.id === 'detail' ? right : b.id;
    return { axis: 'v' as const, x: b.rect.x + b.rect.w, y: -1, left: b.id, right, target, sign: (target === b.id ? 1 : -1) as 1 | -1 };
  });
  const topBox = boxes.find((bx) => bx.id === 'prompts');
  const dashBox = boxes.find((bx) => bx.id === 'dashboards');
  if (topBox && band.length) {
    // The LAST row of Prompts, not the first row of the band below it. Panes are adjacent with no
    // gutter, so the boundary row belongs to somebody — and the row below is the next pane's TITLE,
    // which is itself a click target (it focuses the pane). A seam there silently ate that click.
    // The Dashboards seam already sits on the band's last row for the same reason; this matches it.
    seams.push({ axis: 'h', x: -1, y: topBox.rect.y + topBox.rect.h - 1, left: 'prompts', right: band[0].id, target: 'prompts', sign: 1 });
  }
  if (dashBox && band.length) {
    // The dock grows UPWARD, so moving the pointer down shrinks it.
    seams.push({ axis: 'h', x: -1, y: dashBox.rect.y - 1, left: band[0].id, right: 'dashboards', target: 'dashboards', sign: -1 });
  }

  return {
    mode, cols, rows, bodyH, colH, dashH, boxes, bar, notes, forced, blocked, zoom, focus, seams,
    chrome: { top: CHROME_TOP, bottom: CHROME_BOTTOM },
  };
}

function makeBox(id: PaneId, x: number, y: number, w: number, h: number, focused: boolean, selTab: number, mapFace = false): PaneBox {
  const p = BY_ID[id];
  const x0 = x + 1;
  const budget = x + w - x0;
  if (!p.tabs.length) {
    // No tab strip. An action bar, if the pane has one, takes the row under the title — and it is
    // accounted for HERE so that `navRow`, the body offset and the composed line count all come from
    // one number. Deciding it in the renderer instead is what made every Detail button undrawable-on
    // and unclickable at once.
    //
    // Detail's bar belongs to its DIFF face only: Keep, Undo, prev and next all act on the one edit
    // being shown, and the change map has no such edit. Drawing it there was a row of controls that
    // named nothing, and the map got that row back for a folder instead.
    const navRow = p.nav && !mapFace ? y + 1 : -1;
    const chrome = navRow >= 0 ? 2 : 1;
    return {
      id, focused, selTab: 0,
      rect: { x, y, w, h },
      titleRow: y,
      navRow,
      tabsRow: -1,
      tabSpans: [],
      tabMore: { pre: null, post: null },
      body: { x, y: y + chrome, w, h: Math.max(0, h - chrome) },
    };
  }
  const CHROME_ROWS = 2; // one title row, one tab row
  const cellW = (i: number) => displayWidth(p.tabs[i]) + 2;
  const sel = Math.max(0, Math.min(p.tabs.length - 1, selTab));

  // The strip overflows by dropping WHOLE tabs and naming the count, never by clipping a label — a
  // clipped tab name is the same defect class as a clipped path. It scrolls so the selected tab is
  // always among those drawn, and the spans are computed once, here, for renderer and hit-tester both.
  let from = 0;
  let spans: TabSpan[] = [];
  let pre: PaneBox['tabMore']['pre'] = null;
  let post: PaneBox['tabMore']['post'] = null;
  for (;;) {
    const preW = from > 0 ? String(from).length + 2 : 0;
    let used = preW;
    let to = from;
    const trial: number[] = [];
    while (to < p.tabs.length) {
      const tailW = to + 1 < p.tabs.length ? String(p.tabs.length - to - 1).length + 2 : 0;
      if (used + cellW(to) + tailW > budget) break;
      trial.push(to);
      used += cellW(to);
      to++;
    }
    if (to > from && to > sel && from <= sel) {
      let tx = x0;
      if (from > 0) {
        pre = { x: tx, w: String(from).length + 2, hidden: from };
        tx += pre.w;
      }
      spans = trial.map((i) => {
        const s: TabSpan = { index: i, label: p.tabs[i], x: tx, w: cellW(i), selected: i === sel };
        tx += s.w;
        return s;
      });
      if (to < p.tabs.length) post = { x: tx, w: String(p.tabs.length - to).length + 2, hidden: p.tabs.length - to };
      break;
    }
    if (from >= p.tabs.length - 1) {
      // Last resort: only the selected tab fits. It STILL has to say what it dropped — a strip that
      // shows one of eight tabs and reports nothing is a silent failure, and the reader has no way to
      // learn the other seven exist. Precise counts if both markers fit; one combined count if only
      // one does; nothing at all only when the width cannot hold even ` +N`.
      let tx = x0;
      const before = sel;
      const after = p.tabs.length - sel - 1;
      const preW = before ? String(before).length + 2 : 0;
      const postW = after ? String(after).length + 2 : 0;
      const bothW = String(p.tabs.length - 1).length + 2;
      if (preW + cellW(sel) + postW <= budget) {
        if (before) { pre = { x: tx, w: preW, hidden: before }; tx += preW; }
        spans = [{ index: sel, label: p.tabs[sel], x: tx, w: cellW(sel), selected: true }];
        if (after) post = { x: tx + cellW(sel), w: postW, hidden: after };
      } else if (cellW(sel) + bothW <= budget) {
        spans = [{ index: sel, label: p.tabs[sel], x: tx, w: cellW(sel), selected: true }];
        post = { x: tx + cellW(sel), w: bothW, hidden: p.tabs.length - 1 };
      } else {
        spans = [{ index: sel, label: p.tabs[sel], x: tx, w: cellW(sel), selected: true }];
      }
      break;
    }
    from++;
  }

  return {
    id, focused, selTab: sel,
    rect: { x, y, w, h },
    titleRow: y,
    navRow: -1,
    tabsRow: y + 1,
    tabSpans: spans,
    tabMore: { pre, post },
    body: { x, y: y + CHROME_ROWS, w, h: Math.max(0, h - CHROME_ROWS) },
  };
}

export type Hit =
  | { t: 'chrome'; part: 'session' | 'attention' | 'windowbar' | 'status' | 'keys' }
  | { t: 'windowbar'; pane: PaneId; part: 'chip' | 'twig'; face?: number }
  | { t: 'tab'; pane: PaneId; index: number }
  | { t: 'tabscroll'; pane: PaneId; dir: -1 | 1 }
  | { t: 'title'; pane: PaneId }
  /** A pane's action bar. The caller resolves the column through the same button list the renderer
   *  laid out, so a button is clickable in exactly the cells it was drawn in. */
  | { t: 'nav'; pane: PaneId }
  | { t: 'body'; pane: PaneId; row: number; col: number }
  | { t: 'seam'; index: number; left: PaneId; right: PaneId }
  | null;

/**
 * What is under the cursor. Pure, so the mouse can be tested without a terminal — and it reads the
 * SAME geometry the renderer drew from, which is the only way a click and a glyph agree.
 */
export function hitTest(layout: Layout, col: number, row: number): Hit {
  if (row === 0) {
    for (const b of layout.bar) {
      if (col >= b.x && col < b.x + b.w) return { t: 'windowbar', pane: b.pane, part: col === b.twigX ? 'twig' : 'chip', face: b.face };
    }
    return { t: 'chrome', part: 'windowbar' };
  }
  // The session chip and the attention counts share this row. Which half was clicked is a question
  // about the session's NAME width, which this pure function has no way to know — the caller resolves
  // it through `sessionChipWidth`, the same measure the renderer laid the row out with.
  if (row === 1) return { t: 'chrome', part: 'session' };
  if (row === layout.rows - 2) return { t: 'chrome', part: 'status' };
  if (row === layout.rows - 1) return { t: 'chrome', part: 'keys' };
  const bandTop = layout.chrome.top + (layout.boxes.find((b) => b.id === 'prompts')?.rect.h ?? 0);
  for (let i = 0; i < layout.seams.length; i++) {
    const sm = layout.seams[i];
    const hit =
      sm.axis === 'v'
        ? Math.abs(col - sm.x) <= 1 && row >= bandTop && row < bandTop + layout.colH
        : row === sm.y;
    if (hit) return { t: 'seam', index: i, left: sm.left, right: sm.right };
  }
  for (const b of layout.boxes) {
    const r = b.rect;
    if (col < r.x || col >= r.x + r.w || row < r.y || row >= r.y + r.h) continue;
    if (row === b.tabsRow) {
      for (const s of b.tabSpans) if (col >= s.x && col < s.x + s.w) return { t: 'tab', pane: b.id, index: s.index };
      const { pre, post } = b.tabMore;
      if (pre && col >= pre.x && col < pre.x + pre.w) return { t: 'tabscroll', pane: b.id, dir: -1 };
      if (post && col >= post.x && col < post.x + post.w) return { t: 'tabscroll', pane: b.id, dir: 1 };
      return { t: 'title', pane: b.id };
    }
    if (row === b.titleRow) return { t: 'title', pane: b.id };
    // Before the body test, always: the action bar sits between the two, and calling its row `body`
    // is exactly the bug that made every Detail button unclickable.
    if (row === b.navRow) return { t: 'nav', pane: b.id };
    if (row >= b.body.y && row < b.body.y + b.body.h) {
      return { t: 'body', pane: b.id, row: row - b.body.y, col: col - b.body.x };
    }
    return { t: 'title', pane: b.id };
  }
  return null;
}

/**
 * What is minimized before the reader has said anything. Consulted ONCE, at startup — it is a step
 * function, which is right for a first paint and wrong for a resize (see the latch, in the header).
 */
export function defaultMinimized(cols: number, rows: number): Set<PaneId> {
  const out = new Set<PaneId>();
  const bodyH = Math.max(0, rows - CHROME_TOP - CHROME_BOTTOM);
  if (bodyH - COL_FLOOR < BY_ID.dashboards.min) out.add('dashboards');
  // Detail yields before Traces at startup: with one column left, the list you act ON is worth more
  // than a diff of something you can no longer select.
  if (needCols(COLUMNS) > cols) out.add('detail');
  return out;
}


/**
 * Fold a resolve's forced closures into the reader's own minimized set — the latch.
 *
 * Shrinking the terminal may force a pane closed; growing it never re-opens one, because a pane
 * springing back while the reader is mid-drag is a lurch they did not ask for. Only the reader
 * clears it (`m`, a jump key, or `=`).
 *
 * This is exported because the runtime and its test must exercise the SAME code. A test that folds
 * `forced` in with its own two lines is asserting its own simulation, and would keep passing if the
 * runtime stopped latching entirely.
 */
export function latchMinimized(prev: ReadonlySet<PaneId>, lay: Layout): Set<PaneId> {
  const next = new Set(prev);
  for (const id of lay.forced) next.add(id);
  return next;
}
