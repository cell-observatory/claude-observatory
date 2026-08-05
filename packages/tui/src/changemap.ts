/**
 * The change map, in character cells.
 *
 * Three forms were measured against the real data before this one was chosen.
 *
 * A TREEMAP does not survive. A 100x14 viewport is 1,400 cells; a readable label needs about ten
 * contiguous cells on one row; at 3,957 files that is under one cell each. Neither `ncdu` nor `dust` —
 * the closest prior art for showing a file tree by size in text — draws one either.
 *
 * A GLOBAL TOP-N LEDGER lies by omission. On a real 3,957-file session the top twenty rows cover 18.2%
 * of the churn while looking like the whole story; half the churn needs 109 files and 95% needs 1,218.
 *
 * The existing flat `modules[]` is not a grouping at all: its label is the immediate parent directory,
 * so that same session has five buckets for 3,957 files, with labels up to 92 characters.
 *
 * So: a ROLLED PREFIX TREE — `ncdu`'s scope-and-rescale with `dust`'s roll-up. Aggregation is by path
 * prefix, never by rank, which means every file stays reachable by walking down, and whatever is not
 * shown is always represented by a visible ancestor row carrying its own churn. Nothing is silently
 * dropped, which is the property a top-N list cannot offer.
 *
 * The form also surfaced something a flat ledger had buried: on that session 3,950 of 3,957 files, and
 * 99.98% of all churn, are OUTSIDE the workspace — the agent's own harness directories. The tree says
 * so in one row.
 */
import { displayWidth, fitVisible } from './textwidth';
import { Glyphs, ColorDepth, meter, churn, riskMark, tint } from './glyphs';

/** The subset of a `changemap --json` file row this module needs. */
export interface MapFile {
  rel?: string;
  file?: string;
  added?: number;
  removed?: number;
  cnt?: number;
  pending?: number;
  kept?: number;
  undone?: number;
  risk?: number;
}

export interface MapNode {
  /** Path segment as displayed. */
  name: string;
  /** Full path from the root, '/'-joined — the stable identity for selection and folding. */
  path: string;
  depth: number;
  isFile: boolean;
  churn: number;
  /** Lines added and removed beneath this node, kept APART. `churn` is their sum and stays for the
   *  bar's magnitude, but a reviewer deciding whether to revert needs to know which way a file moved:
   *  +900 −4 and +4 −900 are the same churn and are not remotely the same change. */
  added: number;
  removed: number;
  files: number;
  edits: number;
  pending: number;
  kept: number;
  undone: number;
  risk: number;
  children: MapNode[];
}

const empty = (name: string, path: string, depth: number, isFile: boolean): MapNode => ({
  name, path, depth, isFile,
  churn: 0, added: 0, removed: 0, files: 0, edits: 0, pending: 0, kept: 0, undone: 0, risk: 0,
  children: [],
});

/** Everything not under the workspace collapses into this one row rather than dominating the tree. */
export const OUTSIDE = '(outside the workspace)';

/**
 * Build the tree from a `changemap --json` `files[]` array.
 *
 * `root` is the workspace. A file outside it is not given a synthetic deep path — it is bucketed under
 * a single OUTSIDE node, because on real sessions those paths are the agent's harness directories and
 * threading them through the tree would bury the user's own code under thousands of rows.
 */
export function buildMapTree(files: readonly MapFile[]): MapNode {
  const tree = empty('', '', -1, false);
  for (const f of files) {
    // `rel` is the workspace-relative path and is the ONLY path field to reason with: the payload's
    // `file` is the basename, so any startsWith(root) test against it is false for every row and
    // silently buckets the entire session as outside the workspace.
    const rel = String(f.rel ?? '');
    const outside = !rel || rel.startsWith('..');
    const segments = outside ? [OUTSIDE] : rel.split(/[/\\]/).filter(Boolean);
    if (!segments.length) continue;

    const add = (n: MapNode) => {
      n.churn += (f.added ?? 0) + (f.removed ?? 0);
      n.added += f.added ?? 0;
      n.removed += f.removed ?? 0;
      n.edits += f.cnt ?? 0;
      n.pending += f.pending ?? 0;
      n.kept += f.kept ?? 0;
      n.undone += f.undone ?? 0;
      n.risk += f.risk ?? 0;
    };
    add(tree);
    tree.files++;

    let cur = tree;
    segments.forEach((seg, i) => {
      const last = i === segments.length - 1;
      const path = segments.slice(0, i + 1).join('/');
      let next = cur.children.find((c) => c.name === seg);
      if (!next) {
        next = empty(seg, path, i, last && !outside);
        cur.children.push(next);
      }
      add(next);
      // A directory counts DISTINCT files beneath it; a file row counts itself once.
      next.files++;
      cur = next;
    });
  }
  sortTree(tree);
  return tree;
}

function sortTree(n: MapNode): void {
  n.children.sort((a, b) => b.churn - a.churn || a.name.localeCompare(b.name));
  for (const c of n.children) sortTree(c);
}

/**
 * Collapse chains of single-child directories into one row (`packages/core/src` rather than three
 * rows), which is what `dust` does and what keeps the tree shallow enough to read. Capped, so a deeply
 * nested single chain cannot produce a label wider than the column.
 */
function collapsedLabel(n: MapNode, cap = 40): { label: string; node: MapNode } {
  let cur = n;
  let label = n.name;
  while (cur.children.length === 1 && !cur.children[0].isFile) {
    const next = cur.children[0];
    if (displayWidth(`${label}/${next.name}`) > cap) break;
    label = `${label}/${next.name}`;
    cur = next;
  }
  return { label, node: cur };
}

export interface MapRow {
  node: MapNode;
  label: string;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  /** This row's churn against the largest of its SIBLINGS, 0..1 — the bar's length. Normalised per
   *  level rather than globally, so descending into a small folder still shows its internal shape
   *  instead of a row of one-cell stubs. */
  share: number;
}

/**
 * Flatten to display rows, honouring which paths the reader has opened.
 *
 * A directory is shown expanded only if its path is in `open`; everything else contributes exactly one
 * row carrying its whole subtree's totals. That is what makes the residual visible rather than lost.
 */
export function mapRows(tree: MapNode, open: ReadonlySet<string>, max = 500): MapRow[] {
  const out: MapRow[] = [];
  const walk = (n: MapNode, depth: number) => {
    const top = Math.max(1, ...n.children.map((c) => c.churn));
    for (const child of n.children) {
      if (out.length >= max) return;
      const { label, node } = collapsedLabel(child);
      const expandable = node.children.length > 0;
      const expanded = expandable && open.has(node.path);
      out.push({ node, label, depth, expandable, expanded, share: child.churn / top });
      if (expanded) walk(node, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** The two per-row actions, and the exact cells each occupies. */
export interface MapAction {
  action: 'keep' | 'undo';
  label: string;
  /** Column offset WITHIN the row, so a caller adds its pane's own x. */
  x: number;
  w: number;
}

/**
 * What each column of a map row costs, and which of them this width can afford.
 *
 * Laid out ONCE, here, because the renderer draws from it and the mouse resolves clicks through it.
 * Recomputing the button cells at the click site is how an action ends up drawn in one place and
 * pressable in another — and this action reverts files on disk, so the cost of that drift is a
 * folder the reader never meant to touch.
 *
 * Columns drop WHOLE, cheapest first, and the name keeps whatever is left. Nothing is ever clipped:
 * a `+1.2k` cut to `+1.` is not a smaller number, it is a wrong one.
 */
export interface MapColumns {
  delta: number;
  review: number;
  count: number;
  actions: number;
  risk: number;
  name: number;
}

const ACT_KEEP = ' ✓ ';
const ACT_UNDO = ' ↩ ';
/**
 * Column widths, in the order they are given up.
 *
 * There is no bar. A proportional meter answers "which of these is biggest", which is what SORTING
 * already answers — the rows are churn-ranked — and it spent up to 27 columns doing it, next to
 * numbers that say the same thing exactly. The numbers stayed.
 */
const W_DELTA = 16; // 7 + space + 7 + space — 7 so the word `removed` fits over its column
const W_REVIEW = 11; // 5 + space + 4 + space
const W_COUNT = 6;
const W_ACTIONS = displayWidth(ACT_KEEP) + displayWidth(ACT_UNDO);
const W_RISK = 3;

export function mapColumns(cols: number, depth = 0): MapColumns {
  // indent + twig + the space before the name + the space AFTER it. Counting the trailing separator
  // is not optional book-keeping: one uncounted column puts EVERY row one over its pane, and the pane
  // then wraps each of them onto a continuation line that says nothing.
  const prefix = 2 * (depth + 1) + 3;
  // Ordered by what a reviewer gives up last: the name, then the actions that act on it, then how
  // much changed, then how much of it is still pending, then the counts, then risk.
  const tiers: Omit<MapColumns, 'name'>[] = [
    { delta: W_DELTA, review: W_REVIEW, count: W_COUNT, actions: W_ACTIONS, risk: W_RISK },
    { delta: W_DELTA, review: W_REVIEW, count: 0, actions: W_ACTIONS, risk: W_RISK },
    { delta: W_DELTA, review: 0, count: 0, actions: W_ACTIONS, risk: 0 },
    { delta: 0, review: 0, count: 0, actions: W_ACTIONS, risk: 0 },
    { delta: 0, review: 0, count: 0, actions: 0, risk: 0 },
  ];
  const MIN_NAME = 10;
  for (const t of tiers) {
    const used = t.delta + t.review + t.count + t.actions + t.risk;
    if (prefix + MIN_NAME + used <= cols) return { ...t, name: cols - prefix - used };
  }
  const last = tiers[tiers.length - 1];
  return { ...last, name: Math.max(8, cols - prefix) };
}

/**
 * The column headings, aligned to the cells beneath them.
 *
 * Built from the SAME `mapColumns` the rows are, so a label can never sit over the wrong column.
 * Without it every number was a bare figure with a glyph stuck to it, and the reader had to infer
 * from context whether `1018?` was pending edits, files, or something else again.
 */
export function mapColumnHeader(cols: number, g: Glyphs, depth: ColorDepth = 'none'): string {
  const c = mapColumns(cols, 0);
  const prefix = 2 + 2; // one level of indent, twig, space — the shallowest row's own prefix
  const head =
    ' '.repeat(prefix) +
    pad('', c.name + 1) +
    (c.delta ? `${'added'.padStart(7)} ${'removed'.padStart(7)} ` : '') +
    (c.review ? `${'pend'.padStart(5)} ${'kept'.padStart(4)} ` : '') +
    (c.count ? 'files'.padStart(c.count) : '') +
    ' '.repeat(c.actions) +
    ' '.repeat(c.risk);
  return fitVisible(depth === 'none' ? head : `\x1b[2m${head}\x1b[0m`, cols);
}

/** Where this row's Keep/Undo cells sit, or `[]` when the width could not afford them. */
export function mapRowActions(row: MapRow, cols: number): MapAction[] {
  const c = mapColumns(cols, row.depth);
  if (!c.actions) return [];
  const x = cols - c.risk - c.actions;
  return [
    { action: 'keep', label: ACT_KEEP, x, w: displayWidth(ACT_KEEP) },
    { action: 'undo', label: ACT_UNDO, x: x + displayWidth(ACT_KEEP), w: displayWidth(ACT_UNDO) },
  ];
}

/**
 * Render one row.
 *
 * Columns are laid out from the RIGHT — risk, actions, count, meter, review, delta — and the name
 * absorbs whatever is left. That is what lets the same renderer serve 60 and 200 columns without a
 * separate narrow layout, and it is why nothing here ellipsises: the name column is sized to fit,
 * not the name clipped to the column.
 */
export function renderMapRow(row: MapRow, cols: number, g: Glyphs, depth: ColorDepth): string[] {
  const n = row.node;
  const c = mapColumns(cols, row.depth);
  const riskCol = c.risk ? riskMark(0, n.risk).padStart(c.risk) : '';
  const countCol = c.count ? `${n.isFile ? n.edits : n.files}${n.isFile ? 'e' : 'f'}`.padStart(c.count) : '';
  // Added and removed, apart. `churn` is still what sizes the bar; it is not what a reviewer reads.
  const deltaCol = c.delta
    ? `${tint(`+${churn(n.added)}`.padStart(7), 'kept', depth)} ${tint(`−${churn(n.removed)}`.padStart(7), 'risk', depth)} `
    : '';
  // Pending and accepted as NUMBERS, not only as a bar fill: "how much is left to review here" is
  // the question this map exists to answer, and a proportion cannot answer it.
  // The SAME glyphs the edit list marks a row with, not the meter's fill characters: `966#` beside a
  // `#`-filled bar reads as part of the bar, and the reader has to consult a legend to learn it is a
  // count. `?` and `✓` already mean pending and kept everywhere else on screen.
  const reviewCol = c.review
    ? `${tint(`${n.pending}${g.pending}`.padStart(5), 'pending', depth)} ${tint(`${n.kept}${g.kept}`.padStart(4), 'kept', depth)} `
    : '';
  const twig = row.expandable ? (row.expanded ? g.open : g.closed) : n.isFile ? ' ' : g.fold;
  const indent = '  '.repeat(row.depth + 1);
  // The name is CONTENT, so it is never cut. When it does not fit, the row keeps its first part and
  // the caller draws the rest on continuation lines — a folder called `dash-review-findings.md`
  // clipped to `dash-review-fin` is a name the reader cannot match against anything.
  const parts = displayWidth(row.label) <= c.name ? [row.label] : hardWrapName(row.label, c.name);
  const name = pad(parts[0], c.name);
  const risk = c.risk ? (n.risk > 0 ? tint(riskCol, 'risk', depth) : riskCol) : '';
  // Only a node with something still pending can be kept or undone. A cell that looks pressable and
  // silently refuses is worse than one drawn plainly, so the dead ones are dimmed and — with no
  // colour to dim with — spelled as blanks rather than as glyphs that promise an action.
  const acts = mapRowActions(row, cols).map((a) => {
    if (!n.pending) return depth === 'none' ? ' '.repeat(a.w) : `\x1b[2m${a.label}\x1b[0m`;
    if (depth === 'none') return a.label;
    return `${a.action === 'keep' ? '\x1b[48;2;28;70;36m' : '\x1b[48;2;86;30;30m'}\x1b[97m${a.label}\x1b[0m`;
  }).join('');
  const first = `${indent}${twig} ${name} ${deltaCol}${reviewCol}${countCol}${acts}${risk}`;
  if (parts.length === 1) return [first];
  // Continuations reclaim the width the numbers occupied: there is nothing to align them with.
  const contIndent = `${indent}  ${g.wrap}`;
  return [first, ...parts.slice(1).map((t) => fitVisible(`${contIndent}${t}`, cols))];
}

/** Break a name at exactly `w` columns, keeping every character. Paths have no spaces to break on. */
function hardWrapName(s: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of s) {
    if (displayWidth(line + ch) > w) { out.push(line); line = ''; }
    line += ch;
  }
  out.push(line);
  return out;
}

function pad(s: string, w: number): string {
  const gap = w - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/**
 * The summary line above the ledger.
 *
 * It no longer says "churn", and it no longer explains a meter's fills, because there is no meter.
 * Every row states its own `added`/`removed`/`pend`/`kept` under a heading that names each one — a
 * legend exists to decode a symbol, and a number under its own label needs no decoding.
 */
export function mapHeader(tree: MapNode, cols: number, g: Glyphs): string {
  void g;
  return fitVisible(`  CHANGE MAP  ${tree.files} files · ${tree.edits} edits`, cols);
}
