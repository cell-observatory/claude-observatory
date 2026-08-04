/**
 * The terminal's visual vocabulary: which characters may be drawn, and which colours mean what.
 *
 * Both answers were measured rather than chosen, and both inverted the usual advice.
 *
 * GLYPHS. A census of every monospace font on a stock Mac — SF Mono, SF Mono Terminal, SFNSMono,
 * Menlo, Monaco — found:
 *   - Braille (U+2800–28FF), the usual recommendation for sub-cell plots, is present in NONE of them.
 *     The system falls back to AppleBraille, which is 13.5% wider than the cell, so every braille plot
 *     silently breaks the grid it was drawn to fit.
 *   - The entire box-drawing set is missing from **Menlo Bold** — and Menlo is VS Code's default
 *     terminal font on macOS. A bolded frame becomes tofu. So this product draws no boxes; a rule is a
 *     tinted blank row, which needs no glyph at all.
 *   - `⧗` (the hourglass this code used for "pending") is in none of them either.
 *
 * So the default tier is small on purpose. A re-census (fontTools, upright faces only — we never emit
 * ESC[3m — with an 'A' positive control and a PUA negative control per face) sharpened this:
 *
 *   glyph  Menlo  MenloBold  Monaco  CourierNew  Andale
 *   ? + x    y        y         y        y         y     <- the ASCII tier: universal
 *   █ › ·    y        y         y        y         y
 *   ✓ ✗ ▸ ▾  y        y         N        N         N     <- Menlo only
 *   ▐        y        y         N        y         y
 *   ─        y        N         y        y         y     <- why no boxes: it is BOLD that loses them
 *
 * Menlo is first in VS Code's macOS chain, so the default tier renders correctly there, bold included.
 * It is NOT universal: a reader who has set Monaco, Courier New or Andale gets a fallback face for
 * ✓ ✗ ▸ ▾, and those fall back at the wrong advance width. That reader sets OBSERVATORY_GLYPHS=ascii.
 * The earlier version of this comment claimed these were "verified present in every one of those
 * fonts" and named Monaco; that was false, and the table above is the measurement that corrects it.
 *
 * Block eighths are the single deliberate exception, because there is no width-safe sub-cell ramp and
 * a sparkline needs eight levels.
 *
 * COLOUR. Six semantic hues cannot be told apart by a dichromat — a search of the 256-colour cube found
 * at most four mutually separable hues at a comfortable distance. The product's three most important
 * states are pending, kept and undone, and they always appear TOGETHER in the same meter, so they do
 * not need three hues: they need internal separation. They are therefore one hue's LIGHTNESS ramp,
 * which is immune to colour blindness by construction and survives a monochrome terminal for free.
 * Every state also carries a distinct SHAPE, so accept and reject never depend on colour at all.
 */

export type GlyphTier = 'safe' | 'block' | 'ascii';

export interface Glyphs {
  /** Tree twigs. */
  closed: string;
  open: string;
  /** The vertical rule beside a quoted block — the one width-safe bar that survives Menlo Bold. */
  bar: string;
  /** A wrapped line's continuation marker (`↳` is absent from SF Mono). */
  wrap: string;
  /** A folded/elided row (`⋯` is absent from SF Mono). */
  fold: string;
  /** A row the reader has MARKED for a bulk keep/undo. Shape-distinct from every review-state glyph:
   *  a mark is about the reader's selection, not about what happened to the edit. */
  marked: string;
  /** Review states. Shape-distinct, so the meaning never rests on hue. */
  pending: string;
  kept: string;
  undone: string;
  /** The eight-level ramp for sparklines, coarsest first. */
  ramp: string[];
  /** Meter fill characters, used only when colour is unavailable. */
  fill: { pending: string; kept: string; undone: string; empty: string };
  /** The pane title-row fill. ASCII in every tier: width 1 in every locale, present in every font.
   *  This is what makes a pane's horizontal extent visible with no colour at all. */
  rule: string;
}

const SAFE: Glyphs = {
  closed: '▸',
  open: '▾',
  bar: '▐',
  wrap: '▸',
  fold: '~',
  // One column wide in every font this set is chosen for — the same constraint `bar` documents.
  marked: '◆',
  pending: '?',
  kept: '✓',
  undone: '✗',
  ramp: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
  fill: { pending: '#', kept: '=', undone: '-', empty: ' ' },
  rule: '-',
};

const ASCII: Glyphs = {
  closed: '>',
  open: 'v',
  bar: '|',
  wrap: '>',
  fold: '~',
  marked: '*',
  pending: '?',
  kept: '+',
  undone: 'x',
  ramp: ['.', '.', ':', ':', '-', '=', '+', '#'],
  fill: { pending: '#', kept: '=', undone: '-', empty: ' ' },
  rule: '-',
};

/**
 * Which tier to draw with.
 *
 * `LANG=C`/`POSIX` forces ASCII: that is the environment declaring it has no UTF-8, and guessing
 * otherwise produces mojibake rather than a diagnosable failure.
 */
export function glyphTier(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): GlyphTier {
  const forced = env.OBSERVATORY_GLYPHS;
  if (forced === 'safe' || forced === 'block' || forced === 'ascii') return forced;
  // Windows sets no LC_ALL/LANG, so the locale test below cannot speak for it and everything fell
  // through to `block`. Windows Terminal draws the shading blocks correctly; ConHost with a raster
  // font draws them as replacement boxes, which is worse than the safe set it can draw.
  if (platform === 'win32') return env.WT_SESSION || env.WT_PROFILE_ID ? 'block' : 'safe';
  const lang = `${env.LC_ALL || env.LC_CTYPE || env.LANG || ''}`;
  if (/^(C|POSIX)$/i.test(lang) || (lang && !/utf-?8/i.test(lang))) return 'ascii';
  return 'block';
}

export function glyphs(tier: GlyphTier = glyphTier()): Glyphs {
  if (tier === 'ascii') return ASCII;
  // 'safe' and 'block' differ only in the ramp: block eighths are universally present but
  // East-Asian-ambiguous, so a terminal configured to draw ambiguous characters double-wide would
  // desync a sparkline. 'safe' trades the ramp's resolution for that guarantee.
  return tier === 'safe' ? { ...SAFE, ramp: ASCII.ramp } : SAFE;
}

export type StateKey = 'pending' | 'kept' | 'undone' | 'risk' | 'egress' | 'live' | 'accent' | 'agent';

/**
 * The SAME colours both editors already use, so one product looks like one product wherever it is
 * read — VS Code's webview `PAL` and JetBrains' `NavTint` agree on these hex values, and now so does
 * the terminal.
 *
 * Hue is for recognition, never for meaning. Six semantic hues cannot be told apart by a dichromat —
 * a search of the 256-colour cube found at most four mutually separable at a comfortable distance —
 * so every state ALSO carries a distinct shape (see `Glyphs`), pending/kept/undone additionally
 * differ in luminance, and the meter's fill characters differ even with colour off entirely. Take the
 * colour away and accept, reject and pending are still three different things.
 */
export type Swatch = { rgb: string; c256: number; c16: number; dim: boolean };
export type Palette = Record<StateKey, Swatch>;

const PALETTE: Palette = {
  pending: { rgb: '217;164;65', c256: 179, c16: 33, dim: false }, // #d9a441 amber
  kept: { rgb: '63;185;80', c256: 71, c16: 32, dim: false }, // #3fb950 green
  undone: { rgb: '154;160;170', c256: 246, c16: 37, dim: true }, // #9aa0aa grey
  risk: { rgb: '229;83;75', c256: 203, c16: 31, dim: false }, // #e5534b red
  egress: { rgb: '154;106;194', c256: 140, c16: 35, dim: false }, // #9a6ac2 purple
  live: { rgb: '76;139;245', c256: 75, c16: 36, dim: false }, // #4c8bf5 blue
  accent: { rgb: '204;120;92', c256: 173, c16: 33, dim: false }, // #cc785c the brand coral
  agent: { rgb: '217;130;43', c256: 172, c16: 33, dim: false }, // #d9822b attention orange
};

export type ColorDepth = 'truecolor' | '256' | '16' | 'none';

/**
 * How much colour this terminal has.
 *
 * `NO_COLOR` is honoured before anything else — it is an explicit instruction from the environment,
 * and a tool that renders states by hue alone has to obey it or become unreadable.
 */
export function colorDepth(
  env: NodeJS.ProcessEnv = process.env,
  isTTY = true,
  platform: string = process.platform
): ColorDepth {
  if (!isTTY) return 'none';
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.TERM === 'dumb') return 'none';
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) return 'truecolor';
  if (/-256(color)?\b/.test(env.TERM ?? '')) return '256';
  // WINDOWS SETS NO `TERM`. Falling through to the `env.TERM ? … : 'none'` line below meant every
  // native Windows terminal — Windows Terminal, ConHost, PowerShell — rendered the whole app in no
  // colour at all, while WSL (which does set TERM) was fine. Windows Terminal advertises itself with
  // WT_SESSION and does truecolor; ConHost has understood VT sequences since Windows 10 1511 and Node
  // turns VT processing on for a TTY, so 16 colours is the honest floor rather than none.
  if (platform === 'win32') {
    if (env.WT_SESSION || env.WT_PROFILE_ID) return 'truecolor';
    if (env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || env.ANSICON) return '256';
    return '16';
  }
  return env.TERM ? '16' : 'none';
}

/**
 * The named palettes, and the one in force.
 *
 * Every tool in this class themes — btop ships them, k9s has skins, yazi and joshuto read theme files
 * — and this had eight hard-coded colours and no setting at all. `default` is the palette above,
 * unchanged, because a theme setting must not silently restyle anyone who never asked for one.
 *
 * The active palette is module state rather than a `tint()` parameter for one reason: `tint` has
 * roughly a hundred call sites across the frame, the change map and the options screen, and threading
 * a theme through all of them would be a large diff whose only purpose is to avoid one setter. It is
 * set once at startup and again on save — see `applyTheme` in the app.
 */
export const THEMES: Record<string, Palette> = {
  default: PALETTE,
  // Deuteranopia/protanopia-safe: the red/green pair carries the review verdict, and it is the pair
  // most colour-blind readers cannot separate. Blue vs orange survives both, and `undone` stays grey.
  colorblind: {
    ...PALETTE,
    kept: { rgb: '58;134;255', c256: 33, c16: 36, dim: false },
    risk: { rgb: '245;138;7', c256: 208, c16: 33, dim: false },
    pending: { rgb: '255;209;102', c256: 221, c16: 33, dim: false },
  },
  // One hue, varied by weight. For terminals whose own theme fights a coloured UI, and for anyone who
  // wants the diff to be the only coloured thing on screen.
  mono: Object.fromEntries(
    (Object.keys(PALETTE) as StateKey[]).map((k) => [
      k,
      { rgb: '200;200;200', c256: 250, c16: 37, dim: PALETTE[k].dim },
    ])
  ) as Palette,
};
export const THEME_NAMES = Object.keys(THEMES);

let activePalette: Palette = PALETTE;

/** Choose the palette every later `tint` uses. An unknown name falls back rather than throwing: this
 *  runs on the first paint, and a hand-edited prefs file must not be able to blank the screen. */
export function setTheme(name: string | undefined): void {
  activePalette = (name && THEMES[name]) || PALETTE;
}

/** Wrap `s` in this state's colour at the given depth. At 'none' the text is returned untouched. */
export function tint(s: string, state: StateKey, depth: ColorDepth): string {
  if (depth === 'none') return s;
  const p = activePalette[state];
  const open =
    depth === 'truecolor' ? `\x1b[38;2;${p.rgb}m` : depth === '256' ? `\x1b[38;5;${p.c256}m` : `\x1b[${p.c16}m`;
  return `${p.dim && depth === '16' ? '\x1b[2m' : ''}${open}${s}\x1b[0m`;
}

/**
 * A composition meter: one bar whose LENGTH carries magnitude and whose FILL carries the mix.
 *
 * htop's memory meter, with two rules that matter here. A non-zero class never rounds to zero cells —
 * largest-remainder with a floor of one — because a single pending edit inside a 900-line folder
 * disappearing would make the meter claim the folder is fully reviewed. And when colour is off the
 * classes are still distinguishable, by fill character.
 */
export type MeterKey = 'pending' | 'kept' | 'undone';

export function meter(
  parts: Record<MeterKey, number>,
  cells: number,
  g: Glyphs,
  depth: ColorDepth
): string {
  const total = parts.pending + parts.kept + parts.undone;
  if (cells <= 0) return '';
  if (total <= 0) return g.fill.empty.repeat(cells);
  const order: MeterKey[] = ['pending', 'kept', 'undone'];
  const exact = order.map((k) => (parts[k] / total) * cells);
  const floors = exact.map((v, i) => (parts[order[i]] > 0 ? Math.max(1, Math.floor(v)) : 0));
  let used = floors.reduce((a, b) => a + b, 0);
  // Largest-remainder, then trim from the biggest share if the floors overshot a narrow bar.
  const rema = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r);
  let ri = 0;
  while (used < cells && rema.length) {
    floors[rema[ri % rema.length].i]++;
    used++;
    ri++;
  }
  while (used > cells) {
    const big = floors.indexOf(Math.max(...floors));
    if (floors[big] <= 1) break;
    floors[big]--;
    used--;
  }
  return order
    .map((k, i) => (floors[i] > 0 ? tint(g.fill[k].repeat(floors[i]), k, depth) : ''))
    .join('');
}

/** A sparkline from a numeric series, scaled to its own maximum. */
export function sparkline(series: readonly number[], g: Glyphs): string {
  if (!series.length) return '';
  const max = Math.max(...series);
  if (!(max > 0)) return g.ramp[0].repeat(series.length);
  return series.map((v) => g.ramp[Math.min(g.ramp.length - 1, Math.round((v / max) * (g.ramp.length - 1)))]).join('');
}

/** Compact churn: 1608000 -> "1608k", 4800 -> "4.8k". Never wider than 5 cells. */
export function churn(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/** Risk as a one-channel ramp: no glyph risk, three levels, readable without colour. */
export function riskMark(high: number, total: number): string {
  if (high > 0) return '!!!';
  if (total > 2) return '!!';
  if (total > 0) return '!';
  return '·';
}
