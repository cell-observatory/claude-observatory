/**
 * The edit, rendered the way the agent's own tools render it.
 *
 *   ● Update(packages/core/src/dashframe.ts)
 *     Added 11 lines, removed 4 lines
 *     373      out.push(fitVisible(statusText, cols));
 *     376 +    // Pick the widest hint that MEASURES within the budget
 *     378 -    : cols >= 96
 *
 * Three things here are deliberate and each cost something to get right.
 *
 * **The band is the signal, not the marker.** An added line is a full-width background run, so the
 * eye reads the shape of a change before reading a single character. A `+` in column one carries the
 * same information but only once you are already reading the line. The band therefore extends to the
 * right edge of the pane — a band that stops at the end of the text draws a ragged margin that reads
 * as noise.
 *
 * **Syntax colour is a SECOND channel layered on the first**, so it may only ever touch the
 * foreground. Tinting a background inside an added line would make two encodings fight over one
 * cell, and the reader cannot tell which won. Add/remove owns the background; syntax owns the text.
 *
 * **Both channels must survive losing colour.** At `depth === 'none'` the bands are gone, so the
 * `+`/`-` marker is what remains and it is always present — never replaced by the band, only
 * reinforced by it. A monochrome terminal loses the shape and keeps the meaning.
 */

import { displayWidth, fitVisible, sanitizeCell, sliceVisible, wrapVisible } from './textwidth';
import { ColorDepth, Glyphs, glyphs as defaultGlyphs } from './glyphs';
import { diffWordsWithSpace } from 'diff';

export type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffLine {
  kind: DiffLineKind;
  /** Half-open [start, end) character ranges within `text` that actually changed. */
  spans?: [number, number][];
  /** Line number in the file AFTER the edit; null for a removed line or a hunk header. */
  n: number | null;
  text: string;
}

export interface RichDiffOpts {
  cols: number;
  color: ColorDepth;
  glyphs?: Glyphs;
  /** Header verb — 'Update', 'Create', 'Delete'. */
  verb?: string;
  /** The path, shown WHOLE. A path the reader cannot read is a path they cannot review. */
  path?: string;
  added?: number;
  removed?: number;
  /**
   * Horizontal pan, in columns. When > 0 each source line stays ONE row and is shifted left by this
   * much instead of wrapping.
   *
   * This is not truncation by another name: wrapping remains the default, nothing is dropped, and the
   * reader chose to pan. It exists because on a wide patch column alignment is easier to read than
   * reflowed lines — the trade `delta` and `bat` both offer.
   */
  panX?: number;
}

/**
 * Backgrounds. Dark enough that the foreground palette stays readable on top of them.
 *
 * Each kind has TWO tones: the line band, and a brighter one marking the characters that actually
 * changed. That second tone is the whole point of a review diff — `cols - 1` becoming `cols - 2`
 * should show you the `1`/`2`, not two full-width stripes you have to compare by eye.
 */
const BAND = {
  add: { rgb: '18;46;24', c256: 22, hot: '26;86;38', hot256: 28 }, // deep green, brighter green
  del: { rgb: '58;22;22', c256: 52, hot: '106;30;30', hot256: 88 }, // deep red, brighter red
};

/** A conservative token pass. It never tries to be a parser — it marks the three things that carry
 *  meaning at a glance (strings, comments, numbers) plus a small keyword set, and leaves the rest
 *  alone. Being wrong here is worse than being plain, so every rule is anchored and non-greedy. */
const KEYWORDS =
  /\b(?:const|let|var|function|return|if|else|for|while|import|export|from|class|interface|type|new|await|async|try|catch|throw|null|undefined|true|false|def|fn|pub|impl|struct|enum|match|use|mod)\b/g;

function tintFg(s: string, rgb: string, c256: number, depth: ColorDepth): string {
  if (depth === 'none') return s;
  if (depth === 'truecolor') return `\x1b[38;2;${rgb}m${s}`;
  if (depth === '256') return `\x1b[38;5;${c256}m${s}`;
  return s; // at 16 colours the band already owns the cell; a second hue would muddy it
}

/** Syntax colour for ONE line's text, foreground only. Returns the text unchanged at depth 'none'. */
export function highlight(text: string, depth: ColorDepth): string {
  if (depth === 'none' || depth === '16') return text;
  // Comments win outright: everything after the marker is one span, so a `//` inside a string is the
  // only false positive and it is a cosmetic one.
  const comment = text.match(/(^|\s)(\/\/|#(?!!)|--\s).*$/);
  if (comment && comment.index !== undefined) {
    const head = text.slice(0, comment.index);
    const tail = text.slice(comment.index);
    return highlight(head, depth) + tintFg(tail, '110;116;128', 243, depth) + '\x1b[39m';
  }
  let out = '';
  let last = 0;
  const strings = /(['"`])(?:\\.|(?!\1)[^\\])*\1/g;
  let m: RegExpExecArray | null;
  while ((m = strings.exec(text))) {
    out += keywordsAndNumbers(text.slice(last, m.index), depth);
    out += tintFg(m[0], '196;138;110', 173, depth) + '\x1b[39m';
    last = m.index + m[0].length;
  }
  return out + keywordsAndNumbers(text.slice(last), depth);
}

/**
 * ONE pass, one alternation. Running two `.replace` calls in sequence let the second regex match the
 * digits inside the escape codes the first had just inserted — `\x1b[38;2;150;130;220m` contains
 * `38`, `2`, `150`, `130`, `220`, every one of which is a number literal — and the line came out as
 * shredded escape sequences. Any pass over already-styled text has to consume each character once.
 */
function keywordsAndNumbers(s: string, depth: ColorDepth): string {
  const token = new RegExp(`${KEYWORDS.source}|\\b\\d+(?:\\.\\d+)?\\b`, 'g');
  return s.replace(token, (t) =>
    /^\d/.test(t)
      ? tintFg(t, '140;180;230', 110, depth) + '\x1b[39m'
      : tintFg(t, '150;130;220', 140, depth) + '\x1b[39m'
  );
}

/**
 * Pair each removed line with the added line that replaced it, and mark the spans that differ.
 *
 * Only 1:1 replacements are paired. A hunk that removes three lines and adds one has no honest
 * pairing, and inventing one would highlight spans that never corresponded — worse than no
 * highlighting, because it asserts a relationship the reader would trust.
 */
export function markIntraline(lines: DiffLine[]): DiffLine[] {
  const out = lines.slice();
  let i = 0;
  while (i < out.length) {
    if (out[i].kind !== 'del') { i++; continue; }
    let d = i;
    while (d < out.length && out[d].kind === 'del') d++;
    let a = d;
    while (a < out.length && out[a].kind === 'add') a++;
    const dels = d - i;
    const adds = a - d;
    // Pair only when the runs are the SAME length, and pair positionally. A hunk that removes three
    // lines and adds one has no honest correspondence, and inventing one would highlight spans that
    // never matched — worse than no highlighting, because the reader would trust it.
    if (dels > 0 && dels === adds) {
      for (let k = 0; k < dels; k++) mark(out, i + k, d + k);
    }
    i = a > i ? a : i + 1;
  }
  return out;
}

function mark(out: DiffLine[], di: number, ai: number): void {
  const a = out[di].text;
  const b = out[ai].text;
  if (a === b || (!a.trim() && !b.trim())) return;
  const delSpans: [number, number][] = [];
  const addSpans: [number, number][] = [];
  let da = 0;
  let db = 0;
  for (const part of diffWordsWithSpace(a, b)) {
    const len = part.value.length;
    if (part.added) { addSpans.push([db, db + len]); db += len; }
    else if (part.removed) { delSpans.push([da, da + len]); da += len; }
    else { da += len; db += len; }
  }
  // If nearly everything differs, marking is noise rather than signal — leave the plain bands.
  const changed = delSpans.reduce((n, [x, y]) => n + (y - x), 0) + addSpans.reduce((n, [x, y]) => n + (y - x), 0);
  if (changed > (a.length + b.length) * 0.6) return;
  out[di] = { ...out[di], spans: delSpans };
  out[ai] = { ...out[ai], spans: addSpans };
}

/** Parse a unified patch into typed lines carrying post-edit line numbers. */
export function parsePatch(patch: string): DiffLine[] {
  const out: DiffLine[] = [];
  let n = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('Index:') || raw.startsWith('===')) {
      continue; // the header is re-rendered from real data, not echoed
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      n = m ? Number(m[1]) : n;
      out.push({ kind: 'hunk', n: null, text: raw });
      continue;
    }
    if (raw.startsWith('+')) out.push({ kind: 'add', n: n++, text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ kind: 'del', n: null, text: raw.slice(1) });
    else out.push({ kind: 'ctx', n: n++, text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  while (out.length && out[out.length - 1].kind === 'ctx' && out[out.length - 1].text === '') out.pop();
  return out;
}

/**
 * Render the whole thing. Pure: no clock, no filesystem, no terminal — the frame is a value, so a
 * band's width and a wrapped continuation can both be asserted in a unit test.
 */
export function renderRichDiff(patch: string, opts: RichDiffOpts): string[] {
  const { cols, color: depth } = opts;
  const g = opts.glyphs ?? defaultGlyphs();
  const lines = markIntraline(parsePatch(patch));
  const out: string[] = [];

  // Header: the verb and the WHOLE path, wrapped if it must be, never abbreviated.
  const verb = opts.verb ?? 'Update';
  const head = `● ${verb}(${opts.path ?? ''})`;
  for (const part of wrapVisible(head, cols)) {
    out.push(depth === 'none' ? fitVisible(part, cols) : fitVisible(`\x1b[1m${part}\x1b[0m`, cols));
  }
  if (opts.added !== undefined || opts.removed !== undefined) {
    const a = opts.added ?? 0;
    const r = opts.removed ?? 0;
    const sum = `  ${g.wrap} Added ${a} line${a === 1 ? '' : 's'}, removed ${r} line${r === 1 ? '' : 's'}`;
    out.push(depth === 'none' ? fitVisible(sum, cols) : fitVisible(`\x1b[2m${sum}\x1b[0m`, cols));
  }

  const gutter = Math.max(3, String(lines.reduce((mx, l) => Math.max(mx, l.n ?? 0), 0)).length);
  const bodyW = Math.max(1, cols - gutter - 2); // gutter + space + marker

  for (const l of lines) {
    if (l.kind === 'hunk') {
      out.push(fitVisible(depth === 'none' ? l.text : `\x1b[36m${l.text}\x1b[0m`, cols));
      continue;
    }
    const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    const num = (l.n === null ? '' : String(l.n)).padStart(gutter);
    // Content WRAPS: a diff line cut at the pane edge is content silently lost, and a reader cannot
    // reconstruct it from anywhere else on screen.
    //
    // HARD wrap, not word wrap. Word wrapping splits on spaces, which silently ate the leading
    // indentation of every wrapped line — `  return x` rendered as `return x`. In code that is a
    // fidelity bug and in Python it is a semantic one, so a diff must reproduce its bytes exactly and
    // break wherever the width runs out.
    const panned = opts.panX ? sliceVisible(sanitizeCell(l.text), opts.panX, bodyW) : null;
    const parts =
      panned !== null ? [panned] : displayWidth(l.text) <= bodyW ? [l.text] : hardWrap(sanitizeCell(l.text), bodyW);
    parts.forEach((part, i) => {
      const n = i === 0 ? num : ' '.repeat(gutter);
      const m = i === 0 ? mark : ' ';
      const plain = `${n} ${m}${part}`;
      if (depth === 'none' || l.kind === 'ctx') {
        out.push(fitVisible(pad(plain, cols), cols));
        return;
      }
      // The band runs the full width, so the shape of the change is legible before the text is.
      const band = BAND[l.kind === 'add' ? 'add' : 'del'];
      const bg = depth === 'truecolor' ? `\x1b[48;2;${band.rgb}m` : depth === '256' ? `\x1b[48;5;${band.c256}m` : l.kind === 'add' ? '\x1b[42m' : '\x1b[41m';
      // Paint the changed characters in the brighter tone, on top of the line band. Offsets are into
      // the ORIGINAL text, so they are shifted by where this wrapped part began.
      const offset = parts.slice(0, i).reduce((acc, q) => acc + q.length, 0);
      const body = `${dim(n, depth)} ${m}${l.spans && l.spans.length ? hot(part, l.spans, offset, band, depth) : highlight(part, depth)}`;
      out.push(`${bg}${fitVisible(pad(stripReset(body), cols), cols)}\x1b[0m`);
    });
  }
  return out;
}

/** Re-band just the changed spans of one (possibly wrapped) part of a line. */
function hot(part: string, spans: [number, number][], offset: number, band: { rgb: string; c256: number; hot: string; hot256: number }, depth: ColorDepth): string {
  const base = depth === 'truecolor' ? `\x1b[48;2;${band.rgb}m` : `\x1b[48;5;${band.c256}m`;
  const bright = depth === 'truecolor' ? `\x1b[48;2;${band.hot}m` : `\x1b[48;5;${band.hot256}m`;
  let out = '';
  for (let k = 0; k < part.length; k++) {
    const abs = offset + k;
    const inSpan = spans.some(([a, b]) => abs >= a && abs < b);
    const wasIn = k > 0 && spans.some(([a, b]) => offset + k - 1 >= a && offset + k - 1 < b);
    if (k === 0 || inSpan !== wasIn) out += inSpan ? bright : base;
    out += part[k];
  }
  return out + base;
}

const dim = (s: string, depth: ColorDepth) => (depth === 'none' ? s : `\x1b[2m${s}\x1b[22m`);
/** Drop full resets so they cannot cancel the band mid-line; attribute-scoped resets are kept. */
const stripReset = (s: string) => s.replace(/\x1b\[0m/g, '\x1b[39m');

/** Break at exactly `w` columns, preserving every character including leading whitespace. */
function hardWrap(s: string, w: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const ch of s) {
    if (displayWidth(line + ch) > w) {
      out.push(line);
      line = '';
    }
    line += ch;
  }
  out.push(line);
  return out;
}

function pad(s: string, w: number): string {
  const gap = w - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
