/**
 * The terminal dashboard's frame, as a PURE function of state.
 *
 * Nothing here reads `process`, the clock, or the filesystem: `now` is injected and the colour depth
 * and glyph tier are arguments. That is what makes a frame a value you can assert line by line, at any
 * width, without a terminal — and it is why the CLI's own human renderers could not be reused, since
 * they decide their own colour at call time and can exit the process.
 *
 * The vocabulary it draws with is in ./tui/glyphs, chosen by measurement (see that file's header): no
 * box drawing, because it is missing from Menlo Bold; no braille, because it is missing from every
 * monospace font on macOS; and review states carried by SHAPE as well as colour, so accept and reject
 * never depend on hue.
 */
import { displayWidth, fitVisible, fuzzyMatch, highlightVisible, sanitizeCell, trimTrailing, wrapVisible } from './textwidth';
import {
  resolveLayout, hitTest, PANE_SPECS, TAB_SCREEN, BAR_ENTRIES, CHROME_TOP, CHROME_BOTTOM,
  type Layout, type PaneBox, type PaneId,
} from './layout';
import { relTime } from '@claude-observatory/core';
import { Glyphs, ColorDepth, StateKey, glyphs as defaultGlyphs, tint, sparkline, riskMark } from './glyphs';
import { buildMapTree, mapRows, renderMapRow, mapHeader, mapColumnHeader, MapNode } from './changemap';
import { renderRichDiff } from './richdiff';
import { highlightSource } from './syntax';
import { REBINDABLE, SortKey } from '@claude-observatory/core';

export type ScreenId = 'edits' | 'map' | 'prompts' | 'tasks' | 'workflows' | 'agents' | 'feed' | 'audit' | 'observations' | 'processes';

/**
 * Every key the dashboard binds, under the NAME `tui/input`'s decoder emits for it.
 *
 * It lives beside the hint ladders below on purpose: what the frame ADVERTISES and what the runtime
 * ANSWERS are two halves of one promise, and they drifted apart three times. `e` was printed in the
 * key row and the help with no handler anywhere; `Tab` and `^D` were written in the runtime as the
 * bytes `'\t'` and `'\x04'` while the decoder hands over `tab` and `d`+ctrl, so those comparisons
 * could never be true. Reading the source would not have caught the last two — running the decoder
 * against this set does, which is what `dash: every advertised key is bound` now does on every run.
 */
export const KEY_BINDINGS: ReadonlySet<string> = new Set([
  // Marks: `'` sets, `` ` `` jumps. Not in REBINDABLE — they open a one-key capture for the mark's
  // NAME, and a rebind onto a letter would make that letter unusable as a name.
  "'", '`',
  // `P` jumps to a file; `N` is previous-match. Both are fixed, for the same reason the mark keys are.
  'P', 'N',
  // STRUCTURAL keys. Not rebindable, on purpose: several are the only way out of a mode, and a
  // settings screen that lets a reader lock themselves into a dashboard has handed them a footgun.
  // Five window keys over four panes, because Detail's two faces get one each.
  'f1', 'f2', 'f3', 'f4', 'f5', 'tab', '+', '<', ',', '>', '.', '_', '[', ']',
  'up', 'down', 'left', 'right', 'pgup', 'pgdn', 'enter', 'escape', 'backspace', 'delete', ' ',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  // Answering a confirmation.
  'y', 'Y', 'N',
  // ^C and ^D both arrive named, with `ctrl` set
  'c', 'd',
  // …plus every VERB, at its default key. Derived rather than listed, so a new action or a changed
  // default cannot leave this set behind — the drift these two halves are here to catch.
  ...REBINDABLE.map((r) => r.fallback),
]);

/**
 * The key row, widest first. Every tier is MEASURED against the budget rather than chosen by a
 * hand-written width threshold — a `cols >= 96` once selected a 100-column string fit to `cols - 1`,
 * so every width from 96 to 100 silently cut the last keys and the row read "q qui".
 */
export const KEY_HINTS: readonly string[] = [
  'F1-F5 window (twice zooms) · 0-9 edit · Tab next · ↑↓ move · ←→ tab · space fold · x mark · a keep · u undo · y copy · e $EDITOR · s sort · : command · o options · ? keys · q quit',
  'F1-F5 window · 0-9 edit · Tab · ↑↓ · ←→ · space fold · a/u · y · e · o · ? · q',
  'F1-F5 · 0-9 · Tab · ↑↓ · ←→ · a/u · e · o · ? · q',
  '? keys · q quit',
];

export const SCREENS: { id: ScreenId; label: string }[] = [
  { id: 'edits', label: 'Edits' },
  { id: 'map', label: 'Map' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'workflows', label: 'Flows' },
  { id: 'agents', label: 'Agents' },
  { id: 'feed', label: 'Feed' },
  { id: 'audit', label: 'Audit' },
];

export interface DashState {
  /** The `views --json` payload, or null while the first build is still running. */
  views: Record<string, unknown> | null;
  screen: ScreenId;
  cursor: number;
  scroll: number;
  session: string;
  sessionTitle: string;
  filter: string;
  status: string;
  /** Captured child stderr. Shown, never discarded. */
  error: string | null;
  /** A pending question. `under` names a change-map path when the action is scoped to a whole file or
   *  folder rather than to an id set — the count in `label` is what the reader is answering about. */
  confirm: { verb: 'keep' | 'undo' | 'redo'; ids: number[]; under?: string; label: string } | null;
  /** Injected: relTime's reference point, so a snapshot compares one render against itself. */
  now: number;
  /** 'native' | 'fanout' | 'poll' — surfaced, because a degraded watcher must not look healthy. */
  watcherMode: string;
  /** Which change-map folders the reader has opened, by path. */
  open: ReadonlySet<string>;
  /** When set, Traces shows only the edits this prompt produced. The editors scope the edit list to
   *  the selected prompt the same way — a prompt is the unit of work, and reviewing one means
   *  reviewing what it changed, not everything the session ever did. */
  promptScope?: { index: number; ids: ReadonlySet<number> } | null;
  /** A full-body overlay — the diff view, or a picker. Rendered instead of the list.
   *  `cursor` is present only for a picker, where a row can be chosen. */
  overlay: { title: string; lines: readonly string[]; scroll: number; cursor?: number } | null;
  /** True while the reader is typing a filter. Distinct from a non-empty `filter`, because the
   *  prompt has to appear the moment the mode opens — an invisible mode that eats keystrokes is
   *  indistinguishable from a frozen dashboard. */
  filterOpen?: boolean;
  /** Digits typed so far toward an edit id, or null. Shown before it acts: this jumps the selection
   *  in a tool where the selection is what `u` reverts, so the reader sees the number they are about
   *  to commit to. Same rule as the filter — a mode that eats keystrokes invisibly is a frozen UI. */
  goto?: string | null;
  /** The three-window layout. Absent renders the original single screen, which is what the
   *  non-TTY one-shot and every existing snapshot still use. */
  panes?: PaneState | null;
  /** The selected edit's diff, for Detail's Diff face. Fetched on demand, never on the poll.
   *  The RAW patch is kept, not pre-rendered lines: the pane re-renders it at whatever width the
   *  layout resolves to, so a resize reflows the diff instead of leaving it fitted to the old one. */
  diffPatch?: string;
  /** `verb` is the tool the agent used — Edit, Write, MultiEdit — and heads the rendered diff. */
  diffMeta?: { id: number; path: string; added: number; removed: number; verb?: string };
  /** How Traces is ordered. Persisted (`prefs.sort`), so it is read back on the first frame rather
   *  than resetting to `recent` every launch. */
  sort?: SortKey;
  /** True while the Diff face leaves long lines long and pans across them instead of wrapping.
   *  Runtime only, unlike `sort` — deliberately, because wrapping is this product's default and
   *  nothing is ever truncated; panning is a per-patch choice, not a setting. */
  noWrap?: boolean;
  /** Edit ids the reader has MARKED, for acting on several at once. Runtime only and per-session: a
   *  mark set that survived a restart would have the reader keep a selection they made yesterday and
   *  cannot see. Empty means "act on the row under the cursor", which is what a/u always did. */
  marked?: ReadonlySet<number>;
  /** Syntax colour on the diff's context lines. Off unless the reader turned it on — the one setting
   *  whose cost is on the render path. */
  syntax?: boolean;
  /** The standing find on the Diff face, so its matches can be MARKED rather than only scrolled to.
   *  Cleared with the find itself — a highlight that outlived the search would mark a patch nobody
   *  searched. */
  findNeedle?: string;
  /** The reader's own keymap, key → action. Present so the frame can NAME a key without hard-coding
   *  a letter: the session bar advertised "s to switch" and went on saying it after `s` became sort,
   *  and would have lied to anyone who rebound it in any case. Absent falls back to the defaults. */
  keys?: ReadonlyMap<string, string>;
  /** Horizontal pan on the Diff face, in columns, while `noWrap` is on.
   *
   *  Its OWN number, not the pane's `scroll`: that one is the vertical position, and a single field
   *  driving both axes means paging down also slides the text sideways, with no way to be at line 200
   *  column 0. Panning off the end of a line must never be able to hide content that no key can bring
   *  back — this product does not truncate — so this is clamped to the widest line on screen. */
  panX?: number;
}

/** Per-pane reader state. Each pane carries its OWN cursor: with three lists on screen there are
 *  three cursors and only one of them is what `a`/`u` will act on. In a tool that reverts code,
 *  getting that wrong is a data-loss bug, so the selection is never shared between panes. */
export interface PaneState {
  minimized: ReadonlySet<PaneId>;
  zoom: PaneId | null;
  focus: PaneId;
  tab: Readonly<Partial<Record<PaneId, number>>>;
  cursor: Readonly<Partial<Record<PaneId, number>>>;
  scroll: Readonly<Partial<Record<PaneId, number>>>;
  /** Widths the reader set by dragging a seam. Empty until they do. */
  sizes?: Readonly<Partial<Record<PaneId, number>>>;
}

export interface FrameOpts {
  cols: number;
  rows: number;
  color: ColorDepth | boolean;
  glyphs?: Glyphs;
}

/** One body line, the edit ids it resolves to, and what it points at. */
export interface DashRow {
  cells: string;
  ids: number[];
  /** A stable identity, so a live refresh can keep the same thing selected as rows move. */
  key: string;
  /** For the map: the tree path this row can open or close. */
  openPath?: string;
  /** A continuation of the row above — the same subject, not a new one. The cursor skips it, so
   *  j/k moves between EDITS rather than between lines. */
  cont?: boolean;
}

/**
 * A row's human name, or a NAMED fallback — never a bare identifier.
 *
 * Every dashboard here answers "what is this thing", and an id answers it for nobody: the Tasks pane
 * listed nineteen rows of `a3f21c...` because it read `content`/`title`, which the plan harness stopped
 * emitting when tasks gained `subject`. The editors were already right — VS Code reads `t.subject` and
 * JetBrains reads it with a `task #N` fallback — so this was the terminal drifting away from them, and
 * the fallback below is deliberately the shape JetBrains uses.
 *
 * `what` names the KIND, so an unnamed row still says what it is rather than showing a digest. The id
 * is trimmed because a 40-hex sha in a pane column is noise wearing the costume of information.
 */
function named(candidates: readonly (string | undefined)[], what: string, id: string): string {
  for (const c of candidates) if (c && c.trim()) return c.trim();
  const short = id.length > 8 ? id.slice(0, 8) : id;
  return short ? `${what} ${short}` : `(unnamed ${what})`;
}

function view<T>(state: DashState, name: string): T | null {
  const v = state.views?.[name];
  return v === undefined || v === null ? null : (v as T);
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

/** The basename plus its immediate folder — enough to identify a file without ellipsising a path. */
/**
 * A path shortened to what identifies it, without ever losing a segment the reader needs.
 *
 * This used to keep only the last two segments at EVERY width, so `packages/core/src/dashframe.ts`
 * and `packages/cli/src/dashframe.ts` both rendered as `src/dashframe.ts` — two different files,
 * indistinguishable, in a tool whose job is deciding whether to revert one of them.
 *
 * It now drops only the ABSOLUTE prefix (everything up to and including the workspace root, which is
 * the same for every row and therefore identifies nothing) and returns the rest whole. Panes wrap it.
 */
function tail(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  if (parts.length <= 2) return p;
  // An absolute path carries a machine-specific head. Keep from the first segment that varies —
  // in practice the repo directory — rather than a fixed count from the end.
  if (/^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) {
    const marker = parts.findIndex((x) => x === 'packages' || x === 'src' || x === 'docs' || x === 'scripts' || x === 'test');
    if (marker > 0) return parts.slice(marker - 1).join('/');
    return parts.slice(-3).join('/');
  }
  return parts.join('/');
}

/** Pad to a DISPLAY width — `padEnd` counts escape bytes and would over-pad every tinted cell. */
function pad(s: string, w: number): string {
  const gap = w - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

function statusGlyph(s: string, g: Glyphs): string {
  return s === 'kept' ? g.kept : s === 'undone' ? g.undone : g.pending;
}

/**
 * The rows for a screen, and what each one means for keep/undo.
 *
 * Selection semantics are defined per screen rather than assumed: rows are not all the same kind of
 * thing, and a key that means "one edit" on one screen and "every edit in the session" on another is
 * how a reviewer destroys work they meant to keep.
 */
/**
 * ONE FRAME BUILDS THE SAME ROWS EIGHT TIMES, so it builds them once.
 *
 * `rowsFor` enumerates EVERY row of the session — 2,730 of them for the 546-file session this product
 * is sized against — and a pane draws about 43. That would be tolerable once. It is not once: measured
 * at **8 calls per frame**, because `paneVisible` and `paneRowCount` each need the list for every pane,
 * and the frame is re-rendered on every keystroke. 0.75 ms × 8 on a session that big.
 *
 * Keyed on what this function actually READS — the payload, the screen, the filter, the sort, the
 * prompt scope, the open folders, and the width. Not on `cursor` or `scroll`, which is the whole point:
 * moving the selection and scrolling are the two things a reader does continuously, and neither changes
 * a single row. `views`, `promptScope` and `open` are compared by IDENTITY, which is sound because the
 * app replaces all three rather than mutating them (`state.open = new Set(state.open)`).
 *
 * Small and fixed rather than unbounded: the callers differ by screen and width, so a handful of
 * entries covers a frame, and a Map that grew per keystroke would be the leak this is meant to avoid.
 */
const rowsMemo = new Map<string, { views: unknown; scope: unknown; open: unknown; rows: DashRow[] }>();
/** A stable token per glyph SET, for the key. The sets are shared constants, so identity is the right
 *  comparison; this only turns that identity into something a string key can hold. */
const glyphIds = new WeakMap<Glyphs, number>();
let glyphSeq = 0;
const glyphId = (g: Glyphs): number => {
  let id = glyphIds.get(g);
  if (id === undefined) glyphIds.set(g, (id = ++glyphSeq));
  return id;
};

export function rowsFor(state: DashState, cols = 100, g: Glyphs = defaultGlyphs(), depth: ColorDepth = 'none'): DashRow[] {
  // `now` is in the key, bucketed to the SECOND. Rows carry ages — `relTime` renders "5s ago" — so a
  // memo that ignored it would freeze every timestamp on screen, which is a correctness bug dressed as
  // a speed-up. One second is `relTime`'s own finest granularity, so this is the coarsest bucket that
  // cannot be seen: keystrokes within a second are free, and the rebuild happens exactly when a
  // rendered age would have changed anyway.
  const key = `${state.screen}\u001f${cols}\u001f${depth}\u001f${glyphId(g)}\u001f${state.filter}\u001f${state.sort ?? ''}\u001f${Math.floor(state.now / 1000)}`;
  const hit = rowsMemo.get(key);
  if (hit && hit.views === state.views && hit.scope === state.promptScope && hit.open === state.open) return hit.rows;
  const rows = rowsForUncached(state, cols, g, depth);
  // Bounded: one entry per (screen, width, depth, filter, sort) a frame actually asks for. A filter
  // being typed churns the key, so the map is cleared rather than grown past a frame's worth.
  if (rowsMemo.size > 24) rowsMemo.clear();
  rowsMemo.set(key, { views: state.views, scope: state.promptScope, open: state.open, rows });
  return rows;
}

function rowsForUncached(state: DashState, cols = 100, g: Glyphs = defaultGlyphs(), depth: ColorDepth = 'none'): DashRow[] {
  const f = state.filter.toLowerCase();
  /**
   * FZF'S RULE, not `includes`: `pcsi` finds `packages/core/src/index.ts`.
   *
   * Every filtered pane goes through this one predicate, so the Traces list, the change map, the
   * prompts, the actions and the processes all narrow the same way — a filter that meant one thing on
   * one pane and another next door would be worse than no filter. `fuzzyMatch` tries a contiguous hit
   * FIRST, so a literal query like `.ts` behaves exactly as it always did and never loses to a
   * scattered match.
   */
  const keep = (s: string) => !f || fuzzyMatch(s, f) !== null;
  const rows: DashRow[] = [];

  if (state.screen === 'edits') {
    /**
     * GROUPED BY FILE, like the editors' trees.
     *
     * Every edit used to print its own full path, so a file touched eight times produced eight
     * identical headers and the pane read as a wall of repeated paths — `packages/cli/src/index.ts`
     * three times in one screenful, with the actual edits scattered between the copies. One header
     * per file now carries the path and what that file is waiting on; its edits nest beneath it.
     *
     * File order is the reader's, via `state.sort`. The default is the payload's first appearance —
     * newest-first, as the list already arrives — so the pane still reads chronologically at the top
     * rather than re-sorting under anyone who has not asked for it.
     */
    const scope = state.promptScope;
    const byFile = new Map<string, { label: string; edits: Record<string, unknown>[] }>();
    for (const e of arr(view<{ edits?: unknown[] }>(state, 'list')?.edits)) {
      const file = str(e.file);
      if (!keep(file)) continue;
      if (scope && !scope.ids.has(num(e.id))) continue;
      const label = str(e.rel) || tail(file);
      let g0 = byFile.get(file);
      if (!g0) byFile.set(file, (g0 = { label, edits: [] }));
      g0.edits.push(e);
    }
    /**
     * …and here is where that choice is applied, to the FILE groups rather than to the edits.
     *
     * A session is read one file at a time — the edits inside a file are its history and stay in id
     * order, so "next edit" means the same thing under every ordering. Only the order the files come
     * at the reader changes: `path` groups a package together, `churn` puts the biggest changes on
     * top, and `recent` is the Map's own insertion order, which is the payload's.
     */
    const churnOf = (grp: { edits: Record<string, unknown>[] }): number =>
      grp.edits.reduce((n, e) => n + num(e.added) + num(e.removed), 0);
    const groups = [...byFile.entries()];
    if (state.sort === 'path') groups.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    else if (state.sort === 'churn') groups.sort((a, b) => churnOf(b[1]) - churnOf(a[1]));
    for (const [file, grp] of groups) {
      const pending = grp.edits.filter((e) => str(e.status) === 'pending').length;
      // The file's own state: still waiting if ANY of its edits is, else settled. One glyph, one
      // meaning — the same rule a folder row on the change map follows.
      const fileKey: 'pending' | 'kept' = pending ? 'pending' : 'kept';
      const n = grp.edits.length;
      const count = `${n} edit${n === 1 ? '' : 's'}${pending ? ` · ${pending} pending` : ''}`;
      rows.push({
        // The header addresses EVERY edit in the file, so `a`/`u` on it keep or revert the file —
        // which is what a reader who selected a file row means, and what the editors' file rows do.
        ids: grp.edits.map((e) => num(e.id)),
        key: `f${file}`,
        cells: `${tint(statusGlyph(pending ? 'pending' : 'kept', g), fileKey, depth)} ${grp.label}   ${tint(count, 'undone', depth)}`,
      });
      for (const e of grp.edits) {
        const id = num(e.id);
        // Colour is for recognition — the eye finds the pending rows without reading. Meaning still
        // rests on the glyph, so this is all still legible with colour off.
        const st = str(e.status);
        const stateKey: 'pending' | 'kept' | 'undone' = st === 'kept' ? 'kept' : st === 'undone' ? 'undone' : 'pending';
        const delta = pad(`${tint(`+${num(e.added)}`, 'kept', depth)} ${tint(`−${num(e.removed)}`, 'risk', depth)}`, 12);
        rows.push({
          ids: [id],
          key: `e${id}`,
          // Indented under its file, and carrying the glyph itself: a nested row still has to say
          // whether IT is pending, because the header only says whether ANY of them is.
          cells: `   ${tint(statusGlyph(st, g), stateKey, depth)} ${tint(`#${String(id).padEnd(5)}`, 'accent', depth)} ${relTime(num(e.ts), state.now).padEnd(8)} ${delta}`,
          cont: true,
        });
      }
    }
  } else if (state.screen === 'map') {
    const cm = view<{ files?: unknown[] }>(state, 'changemap');
    const tree = buildMapTree(arr(cm?.files) as never);
    for (const r of mapRows(tree, state.open)) {
      if (!keep(r.label)) continue;
      const painted = renderMapRow(r, cols, g, depth);
      rows.push({ ids: [], key: `m${r.node.path}`, openPath: r.node.path, cells: painted[0] });
      // A wrapped name stays part of the SAME row: `cont` keeps the cursor stepping between entries.
      for (let ci = 1; ci < painted.length; ci++) {
        rows.push({ ids: [], key: `m${r.node.path}:${ci}`, openPath: r.node.path, cells: painted[ci], cont: true });
      }
    }
  } else if (state.screen === 'prompts') {
    // Newest first: the most recent ask is the one being reviewed, so making the reader scroll to
    // the end to reach it inverts the common case. `slice()` first — the view's array is shared.
    for (const p of arr(view<{ prompts?: unknown[] }>(state, 'prompts')?.prompts).slice().reverse()) {
      const title = str(p.title) || str(p.text);
      if (!keep(title)) continue;
      const ids = Array.isArray(p.editIds) ? (p.editIds as number[]) : [];
      rows.push({
        ids,
        key: `p${str(p.id) || num(p.index)}`,
        cells: `${tint(`#${num(p.index)}`.padEnd(5), 'accent', depth)} ${relTime(num(p.ts), state.now).padEnd(8)} ${String(ids.length).padStart(4)} edits  ${title}`,
      });
    }
  } else if (state.screen === 'tasks') {
    // Tasks ride inside `multitask`, joined to changemap's per-task rollup for the review counts. The
    // editors do the same join; building from changemap.tasks instead would show a different, much
    // shorter list, because that one is scoped to strict in-progress spans that produced edits.
    const roll = new Map<string, Record<string, unknown>>();
    for (const r of arr(view<{ rollupByTask?: unknown[] }>(state, 'changemap')?.rollupByTask)) {
      roll.set(str(r.taskId), r);
    }
    for (const t of arr(view<{ tasks?: unknown[] }>(state, 'multitask')?.tasks)) {
      // `subject` FIRST: that is what the plan harness emits today. `content` and `title` are the
      // older spellings, kept so an archived session still reads correctly rather than turning into a
      // wall of digests the moment it is opened.
      const label = named([str(t.subject), str(t.content), str(t.title)], 'task', str(t.id) || str(t.taskId));
      if (!keep(label)) continue;
      const id = str(t.taskId);
      const r = roll.get(id) ?? {};
      const st = str(t.status);
      const key: 'kept' | 'live' | 'pending' = st === 'completed' ? 'kept' : st === 'in_progress' ? 'live' : 'pending';
      const mark = st === 'completed' ? g.kept : st === 'in_progress' ? g.open : g.closed;
      rows.push({
        ids: [],
        key: `t${id}`,
        cells: `${tint(mark, key, depth)} ${tint(st.padEnd(12), key, depth)} ${String(num(r.edits)).padStart(4)} edits  ${tint(`+${num(r.added)}`, 'kept', depth)} ${tint(`−${num(r.removed)}`, 'risk', depth)}  ${label}`,
      });
    }
  } else if (state.screen === 'workflows') {
    const roll = new Map<string, Record<string, unknown>>();
    for (const r of arr(view<{ rollupByWorkflow?: unknown[] }>(state, 'changemap')?.rollupByWorkflow)) {
      roll.set(str(r.workflowId), r);
    }
    for (const w of arr(view<{ workflows?: unknown[] }>(state, 'multitask')?.workflows)) {
      const label = named([str(w.name)], 'workflow', str(w.id));
      if (!keep(label)) continue;
      const r = roll.get(str(w.id)) ?? {};
      const live = w.running === true;
      const phase = str(w.phase) || (live ? 'running' : 'done');
      rows.push({
        ids: [],
        key: `w${str(w.id)}`,
        cells: `${live ? tint(g.closed, 'live', depth) : ' '} ${phase.padEnd(12)} ${String(num(r.edits)).padStart(4)} edits  ${label}`,
      });
    }
  } else if (state.screen === 'agents') {
    for (const a of arr(view<{ agents?: unknown[] }>(state, 'multitask')?.agents)) {
      const label = named([str(a.gitBranch), str(a.worktree)], 'session', str(a.session));
      if (!keep(label)) continue;
      const d = (a.diff ?? {}) as Record<string, unknown>;
      // The payload's sparkline is a NUMBER ARRAY. Coercing it to a string drew nothing at all, which
      // is exactly what shipped: an empty column that looked like "no activity".
      const spark = Array.isArray(a.sparkline) ? sparkline(a.sparkline as number[], g) : '';
      // A heuristic phase is dimmed rather than marked, so a guess never reads as a fact.
      const phase = str(a.phase);
      const pk: StateKey = phase === 'working' ? 'live' : phase === 'done' ? 'kept' : phase.startsWith('awaiting') ? 'agent' : 'undone';
      // A heuristic phase is DIMMED rather than marked, so a guess never reads as a fact.
      const heur = str(a.phaseConfidence) === 'heuristic';
      const shown = depth === 'none' ? phase : `${heur ? '\x1b[2m' : ''}${tint(phase, pk, depth)}`;
      const delta = pad(`${tint(`+${num(d.added)}`, 'kept', depth)} ${tint(`−${num(d.removed)}`, 'risk', depth)}`, 14);
      rows.push({
        ids: [],
        key: `a${str(a.session)}`,
        cells: `${a.self ? tint(g.closed, 'accent', depth) : ' '} ${shown}${' '.repeat(Math.max(0, 16 - displayWidth(phase)))} ${delta} ${tint(spark.padEnd(10), pk, depth)} ${tail(label)}`,
      });
    }
  } else if (state.screen === 'feed') {
    for (const en of arr(view<{ entries?: unknown[] }>(state, 'feed')?.entries)) {
      const label = str(en.label) || str(en.text);
      if (!keep(label)) continue;
      rows.push({ ids: [], key: `f${num(en.ts)}${label.slice(0, 12)}`, cells: `${relTime(num(en.ts), state.now).padEnd(8)} ${label}` });
    }
  } else if (state.screen === 'observations') {
    const ob = view<{ runs?: unknown[]; nextSteps?: unknown[] }>(state, 'observations');
    for (const r of arr(ob?.runs)) {
      const rel = str(r.rel) || str(r.file);
      if (!keep(rel)) continue;
      const st = str(r.status);
      rows.push({
        ids: Array.isArray(r.edits) ? (r.edits as number[]) : [],
        key: `ob${rel}`,
        cells: `${statusGlyph(st, g)} ${String(num(r.count)).padStart(3)}× ${tint(`+${num(r.added)}`, 'kept', depth)} ${tint(`−${num(r.removed)}`, 'risk', depth)}  ${tail(rel)}`,
      });
    }
    for (const n of arr(ob?.nextSteps)) {
      const t = typeof n === 'string' ? n : str((n as Record<string, unknown>).text);
      if (!t || !keep(t)) continue;
      rows.push({ ids: [], key: `ns${t.slice(0, 24)}`, cells: `${tint(g.closed, 'pending', depth)} ${t}` });
    }
  } else if (state.screen === 'processes') {
    const pr = view<{ processes?: unknown[] }>(state, 'processes');
    for (const x of arr(pr?.processes)) {
      const cmd = str(x.command) || str(x.cmd) || str(x.id);
      if (!keep(cmd)) continue;
      const st = str(x.status) || str(x.state);
      rows.push({ ids: [], key: `pr${str(x.id) || cmd.slice(0, 16)}`, cells: `${statusGlyph(st, g)} ${st.padEnd(10)} ${cmd}` });
    }
  } else if (state.screen === 'audit') {
    const risk = view<{ risky?: unknown[]; outsideWrites?: unknown[] }>(state, 'risk');
    const eg = view<{ channels?: unknown[] }>(state, 'egress');
    for (const r of arr(risk?.risky)) {
      const target = str(r.target);
      if (!keep(target)) continue;
      const lvl = str(r.level).toUpperCase();
      rows.push({ ids: [], key: `r${num(r.ts)}${target.slice(0, 12)}`, cells: `${tint(lvl === 'HIGH' ? '!!!' : '!!', 'risk', depth)} ${lvl.padEnd(6)} ${str(r.tool).padEnd(8)} ${target}` });
    }
    for (const w of arr(risk?.outsideWrites)) {
      const file = str(w.file);
      if (!keep(file)) continue;
      rows.push({ ids: [], key: `o${file}`, cells: `${tint('!!', 'risk', depth)} WRITE  ${String(num(w.count)).padStart(3)}×    ${tail(file)}` });
    }
    for (const c of arr(eg?.channels)) {
      const target = str(c.target);
      if (!keep(target)) continue;
      rows.push({ ids: [], key: `g${target}`, cells: `${tint('>', 'egress', depth)}  ${str(c.scope).padEnd(7)} ${str(c.kind).padEnd(6)} ${target}` });
    }
  }
  return rows;
}

/**
 * The edit ids the current selection resolves to.
 *
 * `'one'` is the row under the cursor; `'all'` is every row the screen currently lists, which respects
 * the active filter — so "accept everything" means what is on screen, not what is in the session.
 * Screens whose rows are observations rather than edits return nothing, and the caller says why.
 */
export function selectionIds(state: DashState, scope: 'one' | 'all'): number[] {
  const rows = rowsFor(state);
  if (scope === 'one') return rows[state.cursor] ? [...rows[state.cursor].ids] : [];
  const out = new Set<number>();
  for (const r of rows) for (const id of r.ids) out.add(id);
  return [...out];
}

/**
 * The very top row: which session everything below is about, and that it can be changed.
 *
 * It leads the frame for the same reason it leads the editors' Timeline window — every count, row and
 * verb underneath is scoped to this one session, so a reader who has not noticed which one is selected
 * can misread the entire screen. The marker says it opens; the session key and a click both do.
 */
/** The key currently bound to `action` — the reader's, or the default when no keymap was handed over. */
function keyFor(state: DashState, action: string): string {
  if (state.keys) for (const [k, a] of state.keys) if (a === action) return k;
  return REBINDABLE.find((r) => r.action === action)?.fallback ?? '?';
}

function sessionBar(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): string {
  const list = view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions;
  const n = Array.isArray(list) ? list.length : 0;
  const name = state.sessionTitle || state.session.slice(0, 8);
  const left = `🔬 ${tint(name, 'accent', depth)} ${g.open}`;
  const right = n > 1 ? `${n} sessions · ${keyFor(state, 'session')} to switch` : '';
  const gap = Math.max(1, cols - displayWidth(left) - displayWidth(right) - 1);
  return fitVisible(`${left}${' '.repeat(gap)}${depth === 'none' ? right : `\x1b[2m${right}\x1b[0m`}`, cols);
}

/**
 * How wide the session chip is — the part of the top row that opens the picker when clicked.
 *
 * Exported so the mouse and the renderer measure it the same way. The counters share this row now,
 * and they are a readout, not a control: without this the whole row would be one click target and a
 * reader aiming at "3 conflicts" would get the session picker.
 */
export function sessionChipWidth(state: DashState, g: Glyphs = defaultGlyphs()): number {
  const name = state.sessionTitle || state.session.slice(0, 8);
  return displayWidth(`🔬 ${name} ${g.open}`);
}

/**
 * The session and the attention counts, on ONE row: whose work this is on the left, and what about
 * it should stop you on the right.
 *
 * They were two rows. Both are single short strings, and a terminal has far fewer rows than columns —
 * so the second row cost the windows below a line of content to say something that fits in the space
 * the first one was already padding with blanks.
 */
function sessionRow(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): string {
  const list = view<{ sessions?: unknown[] }>(state, 'sessions')?.sessions;
  const n = Array.isArray(list) ? list.length : 0;
  const name = state.sessionTitle || state.session.slice(0, 8);
  const left = `🔬 ${tint(name, 'accent', depth)} ${g.open}`;
  const leftW = sessionChipWidth(state, g);
  // The counters get whatever the session name did not take, and choose their own tier inside it, so
  // a long session title shortens the labels rather than pushing a count off the end.
  const room = Math.max(0, cols - leftW - 2);
  // A backwards scan, not `/\s+$/`: that shape re-tries the match from every position, so a long run
  // of trailing spaces is quadratic — and this runs on a row rebuilt every keystroke.
  const right = trimTrailing(attention(state, room, g, depth), (c: string) => c === ' ' || c === '\t');
  const gap = Math.max(1, cols - leftW - displayWidth(right) - 1);
  return fitVisible(`${left}${' '.repeat(gap)}${right}`, cols);
}

function depthOf(color: ColorDepth | boolean): ColorDepth {
  return color === true ? '256' : color === false ? 'none' : color;
}

/**
 * The attention header: the counts that decide whether to stop, on EVERY screen.
 *
 * Budgeted rather than clipped — at a narrow width the labels shorten instead of the last two counts
 * silently disappearing, which is what happened when this was a plain join.
 */

function attention(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): string {
  const cm = view<{ summary?: Record<string, unknown> }>(state, 'changemap')?.summary ?? {};
  const risk = view<{ high?: unknown; count?: unknown }>(state, 'risk');
  const eg = view<{ remote?: unknown }>(state, 'egress');
  const mt = view<{ summary?: Record<string, unknown> }>(state, 'multitask')?.summary ?? {};
  // Every tier is MEASURED, never guessed at from a width threshold. Sharing a row with the session
  // name means the room left over depends on the session's title, so a hand-picked `cols >= 92` would
  // cut a count on exactly the sessions whose names are longest.
  const tier = (labels: boolean, all: boolean): string => {
    const bits = [
      tint(`${g.pending} ${num(cm.pending)}${labels ? ' pending' : ''}`, 'pending', depth),
      all ? tint(`${g.kept} ${num(cm.kept)}${labels ? ' kept' : ''}`, 'kept', depth) : '',
      tint(`${riskMark(num(risk?.high), num(risk?.count))} ${num(risk?.high)}${labels ? ' high risk' : ''}`, 'risk', depth),
      all ? tint(`> ${num(eg?.remote)}${labels ? ' remote' : ''}`, 'egress', depth) : '',
      all ? tint(`${g.closed} ${num(mt.active)}${labels ? ' active' : ''}`, 'live', depth) : '',
      `${num(mt.conflicts)}${labels ? ' conflicts' : 'c'}`,
    ].filter(Boolean);
    return bits.join('  ');
  };
  // Labels go before counts do, and the last thing standing is pending, high risk and conflicts —
  // the three that decide whether to stop. A cut number is worse than an absent one: "334 conflicts"
  // clipped to "33" is not a smaller truth, it is a false one.
  const fits = [tier(true, true), tier(false, true), tier(false, false)].find((s) => displayWidth(s) <= cols);
  return fits ?? '';
}

function navRow(state: DashState, cols: number, g: Glyphs, depth: ColorDepth): string {
  const tabs = SCREENS.map((s, i) => {
    const label = cols >= 88 ? `${i + 1} ${s.label}` : String(i + 1);
    return s.id === state.screen ? `\x1b[7m ${label} \x1b[0m` : ` ${label} `;
  });
  const plain = SCREENS.map((s, i) => (cols >= 88 ? ` ${i + 1} ${s.label} ` : ` ${i + 1} `)).join('');
  const mode = state.watcherMode === 'poll' ? `  watcher: poll` : '';
  return fitVisible((depth === 'none' ? plain : tabs.join('')) + mode, cols);
}

/**
 * Render exactly `rows` lines, each at most `cols` display columns.
 *
 * The last cell of the last row is never written: on most terminals printing there triggers auto-wrap
 * and scrolls the alternate screen, shifting the whole frame up by one on every repaint.
 */

// ---------------------------------------------------------------------------
// The three-window composition.
// ---------------------------------------------------------------------------

/** A pane's counter, tiered and dropped WHOLE rather than clipped — a cut counter in the chrome is
 *  the same defect as a cut path in the body. */
function paneCounter(state: DashState, id: PaneId): string[] {
  const n = (name: string, key: string): number => {
    const v = view<Record<string, unknown[]>>(state, name);
    return Array.isArray(v?.[key]) ? (v![key] as unknown[]).length : 0;
  };
  if (id === 'traces') {
    const sc = state.promptScope;
    if (sc) return [`prompt #${sc.index} · ${sc.ids.size} edits · esc clears`, `#${sc.index} · ${sc.ids.size}`, `#${sc.index}`];
    const c = n('list', 'edits');
    // This list is ignore-FILTERED, so when it drops rows it has to say so — otherwise "12 edits"
    // over a session that made 400 is indistinguishable from a session that made 12. The hidden
    // count rides the widest tiers and falls away first, like every other secondary number here.
    return c ? [`${c.toLocaleString('en-US')} edits`, `${c}`] : [];
  }
  if (id === 'prompts') {
    const c = n('prompts', 'prompts');
    return c ? [`${c} asked`, `${c}`] : [];
  }
  if (id === 'dashboards') {
    const a = n('multitask', 'agents');
    // The risky-action count arrived here with Observations and Actions. It is the safety-critical
    // number on this pane, so it rides every tier that has room for anything at all — a pane does
    // not drop its alarm to save four columns.
    const risky = n('risk', 'risky') + n('risk', 'outsideWrites') + n('egress', 'channels');
    const wide = [a ? `${a} agents` : null, risky ? `${risky} actions` : null].filter(Boolean).join(' · ');
    const tight = [a ? `${a}` : null, risky ? `!${risky}` : null].filter(Boolean).join(' ');
    return wide ? [wide, tight] : [];
  }
  return [];
}

/** The title row: focus marker, jump key, name, an ASCII rule to the counter, then the counter.
 *  The rule is what makes each pane's horizontal EXTENT visible with no colour at all. */
function paneTitle(state: DashState, box: PaneBox, g: Glyphs, depth: ColorDepth): string {
  const spec = PANE_SPECS.find((p) => p.id === box.id)!;
  const w = box.rect.w;
  // btop's panels read cleanly because every one is a closed shape with its name set into the edge.
  // It gets that from box-drawing, which this product cannot use — the set is missing from Menlo
  // Bold, VS Code's default macOS terminal font, so a bolded frame turns to tofu. The same clarity
  // comes from three channels that need no glyph: a filled title BAND across the pane's full width,
  // the name bracketed so it reads as a label rather than as content, and the rule running out to
  // the counter so the pane's extent is visible even with colour off.
  // Detail is titled by the FACE it is showing, with that face's own key — the reader pressed F3 or
  // F4 to get here, and a title reading "F3 Detail" over a diff would contradict the key they used.
  const chip = box.id === 'detail'
    ? BAR_ENTRIES.find((e) => e.pane === 'detail' && e.face === detailFace(state))
    : BAR_ENTRIES.find((e) => e.pane === box.id);
  const head = `${box.focused ? '>' : ' '}F${chip?.key ?? spec.n} ${chip?.title ?? spec.title} `;
  let line = head;
  for (const c of [...paneCounter(state, box.id), '']) {
    const suffix = c ? `  ${c} ` : '';
    const fill = w - displayWidth(head) - displayWidth(suffix);
    if (fill >= 1) {
      line = head + g.rule.repeat(fill) + suffix;
      break;
    }
  }
  const fitted = fitVisible(pad(line, w), w);
  if (depth === 'none') return fitted;
  // Focused: a solid band, so the active pane is unmistakable at a glance. Unfocused: a dimmer band
  // rather than plain text — every pane keeps a visible edge, which is what makes the grid read as
  // panels instead of columns of text that happen to sit side by side.
  const bg =
    depth === 'truecolor'
      ? box.focused
        ? '\x1b[48;2;62;68;82m\x1b[97m'
        : '\x1b[48;2;38;42;52m\x1b[38;2;154;160;170m'
      : box.focused
        ? '\x1b[48;5;239m\x1b[97m'
        : '\x1b[48;5;236m\x1b[38;5;246m';
  return `${bg}${fitted}\x1b[0m`;
}

/** The tab strip, drawn FROM the spans the layout computed so a click lands where the label is. */
function paneTabs(box: PaneBox, g: Glyphs, depth: ColorDepth): string {
  const cells: string[] = [];
  let at = box.rect.x;
  const put = (x: number, text: string) => {
    if (x > at) cells.push(' '.repeat(x - at));
    cells.push(text);
    at = x + displayWidth(text.replace(/\x1b\[[0-9;]*m/g, ''));
  };
  const { pre, post } = box.tabMore;
  if (pre) put(pre.x, tint(`-${pre.hidden} `, 'undone', depth));
  for (const s of box.tabSpans) {
    const label = s.selected ? `[${s.label}]` : ` ${s.label} `;
    put(s.x, s.selected ? tint(label, box.focused ? 'accent' : 'undone', depth) : depth === 'none' ? label : `\x1b[2m${label}\x1b[0m`);
  }
  if (post) put(post.x, tint(` +${post.hidden}`, 'undone', depth));
  const line = cells.join('');
  return fitVisible(pad(line, box.rect.w), box.rect.w);
}

/**
 * The visible body lines of one pane, each tagged with the LOGICAL row it belongs to.
 *
 * Two rules that cost real defects to learn:
 *
 * `scroll` and `cursor` are ROW indices, never visual-line indices. A wrapped row occupies several
 * lines, so the two counts diverge — and when the runtime clamped a row cursor against a visual-line
 * offset (sized to the whole terminal rather than to the pane), j/k walked the selection off the pane
 * and a click landed on a different edit than the one under the pointer. In a tool that reverts code,
 * acting on the wrong row is the worst thing this can do.
 *
 * Only the VISIBLE window is wrapped. Wrapping the whole list on every frame made the frame 15-18x
 * more expensive on a real session, for lines nobody can see.
 */
/**
 * Which face a pane is showing. Detail has no tab strip — an edit selected means its diff, nothing
 * selected means the change map — so it is resolved from the SELECTION. Asking the reader to pick
 * would be asking them to restate what they already said.
 *
 * Exported because `paneVisible`, `paneRowCount` and `paneListRows` must all agree. They did not
 * before: `paneRowCount` read the tab table where `paneVisible` read the selection, so Detail
 * reported zero rows for a face that was rendering fine, and its cursor and scroll were pinned to 0
 * on every frame.
 */
export function paneScreenOf(state: DashState, box: PaneBox): string {
  if (box.id === 'detail') return detailFace(state) === 1 ? 'map' : 'diff';
  return TAB_SCREEN[box.id][box.selTab] ?? TAB_SCREEN[box.id][0];
}

/**
 * Which of Detail's two faces is showing: 0 Diff, 1 Map.
 *
 * The default FOLLOWS the selection — an edit selected means its diff, nothing selected means the
 * session's change map — because that is the answer the reader has already given by selecting. The
 * swap in the action bar overrides it, and the override lasts until the selection changes, so
 * choosing "show me the map" is honoured while browsing and drilling into a new edit still lands on
 * that edit's diff rather than on whatever face was left over.
 */
export function detailFace(state: DashState): number {
  const chosen = state.panes?.tab?.detail;
  if (chosen === 0 || chosen === 1) return chosen;
  return state.diffPatch ? 0 : 1;
}

/**
 * The rich diff for the current selection, rendered ONCE per (patch, width, depth).
 *
 * `paneVisible` needs the lines and `paneRowCount` needs their count, on the same frame, at the same
 * width. Rendering twice would double the cost of the most expensive face on screen — a real diff
 * runs to thousands of lines with a per-character intra-line pass — so the second caller gets the
 * first one's answer. One entry is enough: there is exactly one Detail pane.
 */
let richMemo: { key: string; depth: ColorDepth; lines: string[] } | null = null;
function richDiffFor(state: DashState, inner: number, g: Glyphs, depth: ColorDepth): string[] {
  const patch = state.diffPatch ?? '';
  const m = state.diffMeta;
  // Depth is checked but not KEYED. Colour changes what each line contains, never how many there
  // are — every wrap decision measures the raw text — so a count taken at one depth is valid at the
  // other, and the two callers share one entry instead of evicting each other on every frame.
  // panX and noWrap are KEYED: unlike depth, they change how many lines come back — panning keeps
  // every source line on one row where wrapping split it across several — so a count taken under one
  // is wrong under the other, and the memo would hand the stale one to paneRowCount.
  const pan = state.noWrap ? Math.max(0, state.panX ?? 0) : 0;
  const key = [m?.id ?? -1, inner, m?.verb ?? '', pan, patch.length, patch].join('\u001f');
  if (richMemo && richMemo.key === key && richMemo.depth === depth) return richMemo.lines;
  const lines = renderRichDiff(patch, {
    cols: inner,
    color: depth,
    glyphs: g,
    // The tool the agent actually used. Defaulting every edit to one verb told the reader a file was
    // updated when it had been created.
    verb: m?.verb || 'Edit',
    path: m?.path,
    added: m?.added,
    removed: m?.removed,
    // 0 means "wrap", which is the default and what every other surface does.
    panX: pan,
  });
  richMemo = { key, depth, lines };
  return lines;
}

/**
 * Fixed lines a pane draws ABOVE its scrolling list — a hint, a legend. They do not scroll and they
 * are not selectable, so they are not rows; but they do consume body height, which is why
 * `paneListRows` subtracts them. Counting them as rows is how a list's last entry becomes
 * unreachable: the cursor can reach it and the viewport cannot show it.
 */
function decorLines(state: DashState, box: PaneBox, screen: string, inner: number, g: Glyphs, depth: ColorDepth): string[] {
  const out: string[] = [];
  // Only on the DIFF face, and only when there is no diff. On the map it was an instruction to do
  // something else, printed above the thing the reader had just asked to see.
  // An empty list with a live ignore file explains itself, on the pane the reader is looking at.
  if (box.id === 'detail' && screen === 'diff' && !state.diffPatch) {
    for (const part of wrapVisible('select an edit in Traces to see its diff', Math.max(1, inner - 2))) {
      out.push(depth === 'none' ? ` ${part}` : `\x1b[2m ${part}\x1b[0m`);
    }
  }
  if (screen === 'map' && state.views !== null) {
    const tree = buildMapTree(arr(view<{ files?: unknown[] }>(state, 'changemap')?.files) as never);
    out.push(mapHeader(tree as MapNode, inner, g));
    // The column headings, from the same layout the rows use, so a label can never sit over the
    // wrong number.
    out.push(mapColumnHeader(inner, g, depth));
  }
  return out;
}

/** Body rows a pane's LIST may use: its height, less the fixed lines drawn above it. */
export function paneListRows(state: DashState, box: PaneBox, g: Glyphs = defaultGlyphs()): number {
  const screen = paneScreenOf(state, box);
  if (screen === 'diff') return box.body.h;
  const inner = Math.max(1, box.rect.w - 1);
  return Math.max(1, box.body.h - decorLines(state, box, screen, inner, g, 'none').length);
}

export function paneVisible(
  state: DashState,
  box: PaneBox,
  g: Glyphs = defaultGlyphs(),
  depth: ColorDepth = 'none'
): { text: string; row: number }[] {
  const w = box.rect.w;
  const h = box.body.h;
  const inner = Math.max(1, w - 1); // one column is the cursor gutter
  const screen = paneScreenOf(state, box);
  const out: { text: string; row: number }[] = [];
  const wrapWidth = Math.max(1, inner - 3);

  const push = (text: string, row: number) => {
    if (displayWidth(text) <= inner) {
      out.push({ text, row });
      return;
    }
    // Wrap ONCE, at one width, and never rejoin: wrapping to the full width and re-wrapping the
    // remainder welded a hard-broken token back together with a space, so `…handler.md` rendered as
    // `…handle` + `r.md` — a path that does not exist and the reader cannot tell is wrong.
    const parts = wrapVisible(text, wrapWidth);
    out.push({ text: parts[0] ?? '', row });
    for (const part of parts.slice(1)) out.push({ text: `  ${g.wrap}${part}`, row });
  };

  if (state.views === null) {
    out.push({ text: '  building…', row: -1 });
    return out;
  }

  if (screen === 'diff') {
    const rich = richDiffFor(state, inner, g, depth);
    // A diff is READ, not picked from: every line is tagged -1 so no cursor band lands on one. The
    // pane scrolls instead, which is what `panes.scroll.detail` is for.
    const from = Math.max(0, Math.min(state.panes?.scroll?.detail ?? 0, Math.max(0, rich.length - 1)));
    // A standing find MARKS its matches, and does so only on the rows actually drawn — the highlighter
    // walks a line's escapes, so paying for it on a 4,000-line patch to style the 30 on screen would be
    // a per-keystroke cost for nothing. Applied AFTER the memo, deliberately: the memo is keyed on the
    // patch and the width, and folding a needle into it would evict the whole render on every keypress
    // of a search.
    for (let i = from; i < rich.length && out.length < h; i++) {
      let text = rich[i];
      // SYNTAX first, FIND second. A find mark is reverse-video and composes over any foreground; doing
      // it the other way round would have the tokenizer walk escapes the highlighter had just inserted.
      // Context lines only, and identified by what they carry rather than by re-parsing the patch: an
      // added or removed line arrives already wearing its band, and `\x1b[` at the head is exactly what
      // says so. Restricting it here — on the drawn rows — is what keeps a 4,000-line patch costing
      // the same as a 40-line one.
      if (state.syntax && depth !== 'none' && !text.startsWith('\x1b[')) text = highlightSource(text, depth);
      if (state.findNeedle) text = highlightVisible(text, state.findNeedle);
      out.push({ text, row: -1 });
    }
    return out;
  }

  const sub: DashState = {
    ...state,
    screen: screen as ScreenId,
    cursor: state.panes?.cursor?.[box.id] ?? 0,
    scroll: state.panes?.scroll?.[box.id] ?? 0,
  };
  for (const text of decorLines(state, box, screen, inner, g, depth)) out.push({ text, row: -1 });
  const rows = rowsFor(sub, inner, g, depth);
  if (!rows.length) {
    /**
     * AN EMPTY PANE SAYS WHAT TO DO NEXT, not only that it is empty.
     *
     * "nothing on Traces" is true and useless: it reads the same whether Claude has not edited
     * anything yet or the reader has a filter standing that hides every row, and those need different
     * next actions. The pane is the only place anyone is looking, so it is where the answer goes.
     *
     * The pre-payload case is NOT here: `views === null` never reaches this branch, because the panes
     * already draw "building…" while the first read is in flight. A third message for it would be
     * unreachable code that reads like a covered case.
     */
    const spec = PANE_SPECS.find((p) => p.id === box.id)!;
    // The TAB, not the pane. "nothing on Dashboards" is the same sentence whether Fleet is empty,
    // Tasks is empty, or Processes is — and a reader looking at Fleet wants to know about Fleet.
    const tabIdx = state.panes?.tab?.[box.id] ?? 0;
    const title = spec.tabs.length ? (spec.tabs[tabIdx] ?? spec.title) : spec.title;
    /**
     * "EMPTY" AND "NEVER ASKED FOR" ARE DIFFERENT ANSWERS, and this pane used to give the same one to
     * both. The allow-list in app.ts decides which views a screen requests; a screen missing from it
     * gets a payload without its view and renders an honest-looking nothing — the failure that file's
     * own comment calls out as forbidden. Naming the absent view turns a shrug into a lead.
     */
    const feeds: Record<string, string> = {
      agents: 'multitask', workflows: 'multitask', tasks: 'multitask',
      prompts: 'prompts', feed: 'feed', observations: 'observations',
      processes: 'processes', edits: 'list', audit: 'risk',
    };
    const feed = feeds[screen];
    const missing = feed !== undefined && view(state, feed) === null;
    const why = state.filter
      ? `nothing on ${title} matching /${state.filter} — esc clears the filter`
      : missing
        ? `${title} has no data to draw: the “${feed}” view did not arrive in this refresh`
        : `nothing on ${title} yet — it fills in as Claude works`;
    for (const part of wrapVisible(why, Math.max(1, inner - 2))) {
      out.push({ text: depth === 'none' ? `  ${part}` : `\x1b[2m  ${part}\x1b[0m`, row: -1 });
    }
    return out;
  }
  const from = Math.max(0, Math.min(sub.scroll, Math.max(0, rows.length - 1)));
  /**
   * A STICKY FILE HEADER while the pane is scrolled into a file's edits.
   *
   * Traces groups by file, and a file with forty edits scrolls its own header off the top — so the
   * reader is looking at "#231 +4 −1" rows with nothing on screen saying which file they belong to,
   * in a tool whose next keystroke reverts one of them. The path is exactly the thing you lose while
   * scrolling, so it is pinned: the nearest header at or above the first visible row, drawn once at
   * the top and skipped in the body so it never appears twice.
   */
  let sticky = -1;
  if (screen === 'edits' && from > 0) {
    for (let r = from; r >= 0; r--) {
      if (rows[r].key?.startsWith('f')) { sticky = r; break; }
    }
    if (sticky >= 0 && sticky < from) {
      out.push({ text: depth === 'none' ? rows[sticky].cells : `\x1b[2m${rows[sticky].cells}\x1b[0m`, row: -1 });
    }
  }
  for (let r = from; r < rows.length && out.length < h; r++) {
    // A MARKED row says so, on the row itself. A selection set the reader cannot see is a set they
    // will act on by accident — and `a` acting on six files instead of the one under the cursor is
    // exactly the surprise this product exists to prevent.
    const row = rows[r];
    const isMarked = state.marked?.size && row.ids.length > 0 && row.ids.every((id) => state.marked!.has(id));
    push(isMarked ? `${g.marked ?? '*'}${row.cells.replace(/^ /, '')}` : row.cells, r);
  }
  return out;
}

/**
 * How many LOGICAL rows this pane's face has — what the cursor, or the scroll, is bounded by.
 *
 * For the Diff face that is VISUAL lines, because a diff is scrolled rather than picked from. It
 * resolves the face through `paneScreenOf` for the same reason `paneVisible` does: reading the tab
 * table here while the renderer read the selection is what made Detail report zero rows for a face
 * that was drawing correctly, which pinned its scroll at the top forever.
 */
export function paneRowCount(state: DashState, box: PaneBox, g: Glyphs = defaultGlyphs()): number {
  const screen = paneScreenOf(state, box);
  if (screen === 'diff') return richDiffFor(state, Math.max(1, box.rect.w - 1), g, 'none').length;
  if (state.views === null) return 0;
  const sub: DashState = { ...state, screen: screen as ScreenId };
  return rowsFor(sub, Math.max(1, box.rect.w - 1), g).length;
}

/** Body lines for one pane: exactly `box.body.h` of them, each exactly `box.rect.w` wide. */
function paneBody(state: DashState, box: PaneBox, g: Glyphs, depth: ColorDepth): string[] {
  const w = box.rect.w;
  const h = box.body.h;
  const fit = (t: string) => fitVisible(pad(sanitizeCell(t), w), w);
  const gut = (mark: string, t: string) => fit(`${mark}${t}`);
  const cursorRow = state.panes?.cursor?.[box.id] ?? -1;
  // A two-line edit highlights BOTH lines: they are one subject, and banding only the first makes
  // the stats line look like it belongs to the edit below it.
  const screen = paneScreenOf(state, box);
  const rowsNow = state.views === null || screen === 'diff' ? [] : rowsFor({ ...state, screen: screen as ScreenId }, Math.max(1, box.rect.w - 1), g);
  const inCursor = (r: number) => r === cursorRow || (r === cursorRow + 1 && rowsNow[r]?.cont === true);
  const vis = paneVisible(state, box, g, depth);
  const out: string[] = [];
  for (let i = 0; i < h; i++) {
    const v = vis[i];
    if (!v) {
      out.push(fit(''));
      continue;
    }
    const on = v.row >= 0 && inCursor(v.row);
    // NO ARROW when there is colour. The selection used to be stated twice — a `>` in the gutter AND
    // a band — and two marks for one fact is one mark of noise on every list on screen. The marker is
    // what is left when colour is gone, so it survives at depth 'none' and only there. The gutter
    // column itself stays reserved either way, so pane geometry does not change with the palette.
    const line = gut(on && depth === 'none' ? '>' : ' ', v.text);
    if (!on || depth === 'none') {
      out.push(line);
      continue;
    }
    // Several lists means several cursors, and only the focused pane's is what a keep or undo acts
    // on. The focused one is reverse video; the others get a faint band. Not DIMMING: with the arrow
    // gone, a dimmed row reads as disabled, which is the opposite of selected.
    if (box.focused) {
      out.push(`\x1b[7m${line}\x1b[0m`);
      continue;
    }
    const rest = depth === 'truecolor' ? '\x1b[48;2;54;58;70m' : '\x1b[100m';
    out.push(`${rest}${line}\x1b[0m`);
  }
  return out;
}

/**
 * Detail's navbar: which edit is shown, its position in the list, and the keys that move between
 * them. Without it the centre is a diff with no address — the reader can see the change but not
 * where they are in the review, which is the question a review tool exists to answer.
 */
export type NavAction = 'keep' | 'undo' | 'prev' | 'next' | 'face-diff' | 'face-map';

export interface NavButton {
  action: NavAction;
  label: string;
  x: number;
  w: number;
  /** False when the button cannot act — nothing selected, or the edit is already resolved. */
  live: boolean;
}

/**
 * The Diff/Map swap lives on the WINDOW BAR, not in this action bar — Detail contributes two chips
 * there, one per face, each with its own function key (see `BAR_ENTRIES`). A second swap inside the
 * pane would be the same control drawn twice, costing width on the row that carries Keep and Undo.
 */

/**
 * The Detail navbar's buttons, laid out once so the renderer and the mouse read the SAME geometry.
 * Recomputing them at the click site is how a button ends up drawn in one place and clickable in
 * another, with nothing on screen to reveal the drift.
 *
 * Buttons are dropped whole, widest-first, when the pane is too narrow — never clipped to a stub
 * that still looks pressable. The keys keep working at every width, so a dropped button costs
 * discoverability, not capability.
 */
export function detailNavButtons(box: PaneBox, state: DashState, g: Glyphs = defaultGlyphs()): NavButton[] {
  const m = state.diffMeta;
  const live = !!m;
  // With nothing selected there is nothing to keep or undo, so those two are ABSENT rather than
  // drawn-but-dim: without colour a dim button and a live one render identically, and a button that
  // looks pressable and silently refuses is worse than one that was never offered. prev/next stay —
  // they still move the review on.
  const all: { action: NavAction; label: string }[] = live
    ? [
        { action: 'keep', label: `${g.kept} Keep` },
        { action: 'undo', label: `${g.undone} Undo` },
        { action: 'prev', label: '‹ prev' },
        { action: 'next', label: 'next ›' },
      ]
    : [
        { action: 'prev', label: '‹ prev' },
        { action: 'next', label: 'next ›' },
      ];
  // Reserve room for the edit's identity on the left; buttons sit to the right of it.
  const idText = m ? ` ✦ #${m.id}  +${m.added} −${m.removed} ` : ' ';
  for (let drop = 0; drop <= all.length; drop++) {
    const shown = all.slice(0, all.length - drop);
    const need = shown.reduce((n, b) => n + displayWidth(b.label) + 3, 0);
    if (displayWidth(idText) + need + 1 > box.rect.w) continue;
    let x = box.rect.x + box.rect.w - need - 1;
    return shown.map((b) => {
      const w = displayWidth(b.label) + 2;
      const at = x + 1;
      x += w + 1;
      return { ...b, x: at, w, live };
    });
  }
  return [];
}

function detailNav(state: DashState, box: PaneBox, g: Glyphs, depth: ColorDepth): string {
  const w = box.rect.w;
  const m = state.diffMeta;
  const btns = detailNavButtons(box, state, g);

  const rows = state.views === null ? [] : rowsFor({ ...state, screen: 'edits' }, 40, g);
  const ids: number[] = [];
  for (const r of rows) for (const id of r.ids) if (!ids.includes(id)) ids.push(id);
  const at = m ? ids.indexOf(m.id) : -1;
  const left = m
    ? ` ${tint(`✦ #${m.id}`, 'accent', depth)}  ${tint(`+${m.added}`, 'kept', depth)} ${tint(`−${m.removed}`, 'risk', depth)}${at >= 0 ? `  ${at + 1}/${ids.length}` : ''} `
    : ' ';

  // Assemble by absolute column so what is drawn lands exactly where `detailNavButtons` says.
  const cells: string[] = [left];
  let cur = box.rect.x + displayWidth(left.replace(/\x1b\[[0-9;]*m/g, ''));
  for (const b of btns) {
    if (b.x > cur) { cells.push(' '.repeat(b.x - cur)); cur = b.x; }
    const face = ` ${b.label} `;
    cells.push(
      depth === 'none'
        ? face
        : b.live
          ? `${b.action === 'keep' ? '\x1b[48;2;28;70;36m' : b.action === 'undo' ? '\x1b[48;2;86;30;30m' : '\x1b[48;2;54;58;70m'}\x1b[97m${face}\x1b[0m`
          : `\x1b[2m${face}\x1b[0m`
    );
    cur += b.w;
  }
  return fitVisible(pad(cells.join(''), w), w);
}

/** Compose one pane into its full box: title row, tab row, body. */
function paneLines(state: DashState, box: PaneBox, g: Glyphs, depth: ColorDepth): string[] {
  const head = [paneTitle(state, box, g, depth)];
  // Driven by the GEOMETRY, never by the pane's name. Deciding here that Detail draws an action bar,
  // while `makeBox` did not reserve a row for it, is what made every button undrawable-on: the
  // hit-tester called that row body, and the pane composed one line taller than its own box.
  if (box.navRow >= 0) head.push(detailNav(state, box, g, depth));
  // No tabs means no tab row — spending a line on an empty strip cost every tab-less pane a row of
  // content and drew a blank band under its title.
  if (box.tabSpans.length) head.push(paneTabs(box, g, depth));
  return [...head, ...paneBody(state, box, g, depth)];
}

/** The window bar: every pane, open or not, with its jump key and its minimize twig. */
function windowBar(lay: Layout, cols: number, g: Glyphs, depth: ColorDepth): string {
  const cells: string[] = [];
  let at = 0;
  for (const chip of lay.bar) {
    if (chip.x > at) { cells.push(' '.repeat(chip.x - at)); at = chip.x; }
    const twig = chip.open ? g.open : g.closed;
    // The chip's OWN key and title — Detail contributes two of these, one per face, and they are the
    // two things a reader navigates by.
    const text = `F${chip.key} ${twig}${chip.title}`;
    cells.push(chip.focused ? tint(text, 'accent', depth) : chip.open ? text : depth === 'none' ? text : `\x1b[2m${text}\x1b[0m`);
    at = chip.x + chip.w;
  }
  let line = cells.join('');
  if (lay.zoom) {
    // A zoom that is not announced leaves "why can I only see one thing" with no answer on screen.
    const spec = PANE_SPECS.find((p) => p.id === lay.zoom)!;
    const flag = `ZOOM ${spec.title}`;
    const gap = cols - at - displayWidth(flag) - 1;
    if (gap > 0) line += ' '.repeat(gap) + tint(flag, 'pending', depth);
  }
  return fitVisible(pad(line, cols), cols);
}

/**
 * The status row, when Detail is zoomed to the whole terminal: which edit is on screen, and where it
 * lives. Full screen is where the surrounding list is GONE, so the one line that still has room has
 * to carry the edit's identity — otherwise the reader is looking at a diff with no address.
 *
 * A measured ladder, not a `fitVisible` cut. A path trimmed to fit is a path that does not exist,
 * and this one names the file a keystroke away from being reverted.
 */
function zoomedEditBar(state: DashState, lay: Layout, cols: number, depth: ColorDepth): string | null {
  if (lay.zoom !== 'detail') return null;
  const m = state.diffMeta;
  if (!m) return null;
  const id = tint(`edit #${m.id}`, 'accent', depth);
  const plain = tail(m.path);
  const cand = [`${id} · ${m.path}`, `${id} · ${plain}`, `${id}`];
  return cand.find((s) => displayWidth(s) <= cols) ?? `edit #${m.id}`;
}

/** Render the four-window frame. Same contract as `renderDashFrame`: exactly `rows` lines, every
 *  one within the column budget. */
function renderPanes(state: DashState, opts: FrameOpts, lay: Layout, g: Glyphs, depth: ColorDepth): string[] {
  const { cols, rows } = opts;
  // The window bar LEADS. It is the frame's table of contents — every region, its jump key, whether
  // it is open — and a table of contents printed under two rows of session state is one the reader
  // has to hunt for.
  const out: string[] = [windowBar(lay, cols, g, depth), sessionRow(state, cols, g, depth)];

  const grid: string[] = [];
  // The horizontal band is the COLUMN docks only. Filtering on "not dashboards" swept the new top
  // dock into the band and the compositor tried to place Prompts side-by-side with Traces, which
  // left the whole column band unrendered.
  const band = lay.boxes.filter((b) => b.id !== 'dashboards' && b.id !== 'prompts').sort((a, b) => a.rect.x - b.rect.x);
  const top = lay.boxes.find((b) => b.id === 'prompts');
  const rendered = new Map<PaneId, string[]>();
  for (const b of lay.boxes) rendered.set(b.id, paneLines(state, b, g, depth));

  // The top dock is drawn ABOVE the column band, full width.
  if (top) for (let y = 0; y < top.rect.h; y++) grid.push(rendered.get('prompts')![y] ?? pad('', cols));
  // The seam is the panel edge: dim enough not to compete with content, present enough to divide.
  const seam = depth === 'none' ? g.bar : `\x1b[38;2;72;78;92m${g.bar}\x1b[0m`;
  for (let y = 0; y < lay.colH; y++) {
    grid.push(band.map((b) => rendered.get(b.id)![y] ?? pad('', b.rect.w)).join(seam));
  }
  const dash = lay.boxes.find((b) => b.id === 'dashboards');
  if (dash) for (let y = 0; y < dash.rect.h; y++) grid.push(rendered.get('dashboards')![y] ?? pad('', cols));

  const bodyH = Math.max(0, rows - CHROME_TOP - CHROME_BOTTOM);
  for (let i = 0; i < bodyH; i++) out.push(fitVisible(grid[i] ?? '', cols));

  // Refusal is loud: a pane the reader has a key for that this size cannot hold says what it costs.
  const blocked = lay.blocked
    .map((b) => `${PANE_SPECS.find((p) => p.id === b.pane)!.title} needs ${b.need ? `${b.need} cols` : `${b.needRows} body rows`}`)
    .join(' · ');
  const status = state.confirm
    ? tint(`${state.confirm.verb} ${state.confirm.ids.length} edit(s) — ${state.confirm.label}?  [y/n]`, 'pending', depth)
    : state.error
      ? tint(`! ${state.error}`, 'risk', depth)
      : state.goto
        ? tint(`go to edit #${state.goto}_`, 'accent', depth)
        : blocked
          ? tint(`at this size: ${blocked}`, 'undone', depth)
          : zoomedEditBar(state, lay, cols, depth) ?? state.status;
  out.push(fitVisible(status, cols));

  const budget = cols - 1;
  const keys = state.filterOpen || state.filter
    ? `/${state.filter}${state.filterOpen ? '_' : ''}`
    : state.goto
      ? '↵ select · esc cancel'
      : KEY_HINTS.find((s) => displayWidth(s) <= budget) ?? '?';
  out.push(fitVisible(depth === 'none' ? keys : `\x1b[2m${keys}\x1b[0m`, budget));
  return out.slice(0, rows);
}

export function renderDashFrame(state: DashState, opts: FrameOpts): string[] {
  const { cols, rows } = opts;
  const depth = depthOf(opts.color);
  const g = opts.glyphs ?? defaultGlyphs();
  const lay = state.panes
    ? resolveLayout({
        cols, rows,
        minimized: state.panes.minimized,
        zoom: state.panes.zoom,
        focus: state.panes.focus,
        tab: state.panes.tab,
        sizes: state.panes.sizes,
        detailFace: detailFace(state),
      })
    : null;
  if (lay && !state.overlay) return renderPanes(state, opts, lay, g, depth);
  // An overlay is a layer OVER the windows, not a different product. Painting the retired
  // eight-screen nav here told the reader their windows had vanished the moment they pressed `s`.
  // The window bar leads, exactly as it does in the pane frame — but the legacy screen nav does NOT,
  // because it is a tab strip rather than a map of the frame, and that frame's own lead is its
  // session line.
  const out: string[] = lay
    ? [windowBar(lay, cols, g, depth), sessionRow(state, cols, g, depth)]
    : [sessionBar(state, cols, g, depth), attention(state, cols, g, depth), navRow(state, cols, g, depth)];

  // Derived from the chrome actually emitted above, not from a constant: the pane frame carries two
  // top rows and the legacy one carries three, and a hard-coded 5 leaves the taller of them a line
  // short of filling the terminal.
  const bodyRows = Math.max(0, rows - out.length - CHROME_BOTTOM);
  if (state.overlay) {
    // The diff takes the whole body. Its lines already carry the CLI's own colouring, so they are
    // width-fitted but never re-styled — what is shown is exactly what `diff <id>` prints.
    const o = state.overlay;
    out.push(fitVisible(tint(o.title, 'accent', depth), cols));
    // Expand to visual lines first: a diff line wider than the terminal WRAPS onto a continuation
    // that reclaims the full width. Fitting it cut the tail off silently, and a diff you cannot read
    // to the end is a diff you cannot review. Only the visible window is expanded.
    const slice: string[] = [];
    for (let r = o.scroll; r < o.lines.length && slice.length < bodyRows - 1; r++) {
      const raw = o.lines[r] ?? '';
      if (displayWidth(raw) <= cols) { slice.push(raw); continue; }
      const parts = wrapVisible(raw, Math.max(1, cols - 2));
      slice.push(parts[0] ?? '');
      for (const part of parts.slice(1)) slice.push(`${g.wrap}${part}`);
    }
    for (let i = 0; i < bodyRows - 1; i++) {
      const line = slice[i] ?? '';
      const picked = o.cursor !== undefined && o.scroll + i === o.cursor;
      // Without colour the cursor REPLACES the row's leading space rather than being prepended:
      // prepending shifts every column right by one and collides with the marker a picker row may
      // already carry (the current session's own '>'), so two different meanings share a glyph AND
      // the columns stop lining up.
      const marked = picked ? (depth === 'none' ? `>${line.slice(1)}` : `\x1b[7m${line}\x1b[0m`) : line;
      out.push(fitVisible(marked, cols));
    }
  } else if (state.views === null) {
    out.push(fitVisible('  building the session view…', cols));
    for (let i = 1; i < bodyRows; i++) out.push(fitVisible('', cols));
  } else {
    // The map draws its own legend row; every other screen spends the line on data.
    let all = rowsFor(state, cols, g, depth);
    let header: string | null = null;
    if (state.screen === 'map') {
      const tree = buildMapTree(arr(view<{ files?: unknown[] }>(state, 'changemap')?.files) as never);
      header = mapHeader(tree as MapNode, cols, g);
    }
    const avail = header ? bodyRows - 1 : bodyRows;
    if (header) out.push(header);
    const start = Math.min(state.scroll, Math.max(0, all.length - avail));
    const slice = all.slice(start, start + avail);
    for (let i = 0; i < avail; i++) {
      const r = slice[i];
      if (!r) {
        out.push(fitVisible('', cols));
        continue;
      }
      const selected = start + i === state.cursor;
      const text = sanitizeCell(r.cells);
      out.push(fitVisible(selected && depth !== 'none' ? `\x1b[7m ${text}\x1b[0m` : selected ? `>${text}` : ` ${text}`, cols));
    }
    if (all.length === 0 && bodyRows > 0) {
      out[3] = fitVisible(
        state.screen === 'feed'
          ? '  no feed subject selected — pick an agent or workflow, then press 7'
          : '  nothing on this screen for this session',
        cols
      );
    }
  }

  const statusText = state.confirm
    ? tint(`${state.confirm.verb} ${state.confirm.ids.length} edit(s) — ${state.confirm.label}?  [y/n]`, 'pending', depth)
    : state.error
      ? tint(`! ${state.error}`, 'risk', depth)
      : state.status;
  out.push(fitVisible(statusText, cols));
  // Pick the widest hint that MEASURES within the budget rather than guessing a threshold: a
  // hand-written `cols >= 96` selected a 100-column string fit to `cols - 1`, so every width from
  // 96 to 100 silently cut the last keys ("q qui"). The budget is the only honest threshold.
  const budget = cols - 1;
  // The SAME ladder the pane frame uses. This path had its own copy, which still advertised the
  // window keys as digits long after the digits had been given to edits — so opening any overlay
  // replaced the key row with instructions for a keymap that no longer existed.
  const keys = state.filterOpen || state.filter
    ? `/${state.filter}${state.filterOpen ? '_' : ''}`
    : KEY_HINTS.find((s) => displayWidth(s) <= budget) ?? '?';
  out.push(fitVisible(depth === 'none' ? keys : `\x1b[2m${keys}\x1b[0m`, budget));
  return out.slice(0, rows);
}
