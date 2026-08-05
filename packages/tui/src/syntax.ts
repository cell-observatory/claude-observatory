/**
 * Syntax colour for a diff's CONTEXT lines.
 *
 * Last of the terminal features on purpose, and the only one that ships off by default, because it is
 * the only one whose cost lands on the render path — and this frame re-renders on every keystroke.
 * Three decisions keep it affordable and keep it from fighting the thing it sits inside:
 *
 * 1. CONTEXT LINES ONLY. An added or removed line already carries colour that means something — the
 *    add/remove band, plus the brighter intra-line tone marking the characters that actually changed.
 *    That is the review signal, and it is the whole point of a review diff. Painting a keyword blue on
 *    top of it would put two colour languages on one row and cost the reader the one that matters.
 *    Context lines carry no band, so this is additive rather than competing.
 *
 * 2. PER DRAWN ROW, never per patch line. The caller applies this to the ~40 rows on screen, so a
 *    4,000-line patch costs the same as a 40-line one. Tokenising inside the diff renderer instead
 *    would put the whole patch through it on every cache miss.
 *
 * 3. NOT A PARSER, and it never tries to be — the same rule `markIntraline` follows next door. It
 *    marks four things that are unambiguous enough to be worth colouring and cheap enough to be free:
 *    line comments, quoted strings, numbers, and a small shared keyword set. Anything it is unsure of
 *    it leaves alone, because a wrong highlight in a review tool is worse than none: it makes the
 *    reader doubt what else on the row is being shown to them accurately.
 */
import { ColorDepth } from './glyphs';

/** Deliberately muted. These sit UNDER the review colours in the visual hierarchy — context is what
 *  you read past to reach the change, and anything loud here competes with the band beside it. */
const HUE = {
  comment: { rgb: '106;115;125', c256: 245, c16: 37 },
  string: { rgb: '152;195;121', c256: 108, c16: 32 },
  number: { rgb: '209;154;102', c256: 173, c16: 33 },
  keyword: { rgb: '150;140;200', c256: 104, c16: 35 },
} as const;

type Hue = keyof typeof HUE;

function open(h: Hue, depth: ColorDepth): string {
  const p = HUE[h];
  return depth === 'truecolor' ? `\x1b[38;2;${p.rgb}m` : depth === '256' ? `\x1b[38;5;${p.c256}m` : `\x1b[${p.c16}m`;
}

/**
 * One keyword set across languages rather than one per language.
 *
 * The alternative is detecting the language from the file extension and carrying a table per language,
 * which is a lot of surface for a context line. These words are keywords in most of what anyone reviews
 * here and are not ordinary identifiers in the rest, so the false-positive rate is low and the failure
 * mode when it does miss is simply "not coloured".
 */
const KEYWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'break', 'continue',
  'class', 'extends', 'implements', 'interface', 'type', 'enum', 'import', 'export', 'from', 'as',
  'new', 'this', 'super', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'yield',
  'def', 'elif', 'lambda', 'pass', 'raise', 'with', 'in', 'is', 'not', 'and', 'or', 'None', 'True', 'False',
  'fun', 'val', 'object', 'when', 'null', 'true', 'false', 'public', 'private', 'protected', 'static',
  'void', 'struct', 'impl', 'trait', 'match', 'mut', 'pub', 'fn', 'use',
]);

/**
 * Colour one line of source. Returns it unchanged at `none`, and unchanged for anything it is not
 * confident about.
 *
 * The scan is single-pass and left-to-right: a comment swallows the rest of the line, a quote swallows
 * to its matching close, and only what is left is considered for numbers and keywords. That ordering is
 * what stops `// const x` colouring `const` inside a comment.
 */
export function highlightSource(line: string, depth: ColorDepth): string {
  if (depth === 'none' || !line) return line;
  const R = '\x1b[39m'; // default FOREGROUND only — this runs inside a line that may carry a background
  let out = '';
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    // A line comment takes everything after it, so it is checked first.
    const c = /^(\/\/|#(?!!)|--\s)/.exec(rest);
    if (c) return `${out}${open('comment', depth)}${line.slice(i)}${R}`;
    const q = /^(['"`])/.exec(rest);
    if (q) {
      const quote = q[1];
      let j = i + 1;
      while (j < line.length && line[j] !== quote) j += line[j] === '\\' ? 2 : 1;
      const end = Math.min(j + 1, line.length);
      out += `${open('string', depth)}${line.slice(i, end)}${R}`;
      i = end;
      continue;
    }
    const w = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(rest);
    if (w) {
      out += KEYWORDS.has(w[0]) ? `${open('keyword', depth)}${w[0]}${R}` : w[0];
      i += w[0].length;
      continue;
    }
    // A number, but not one glued to an identifier — `x2` is a name, not a name and a number.
    const n = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (n) {
      out += `${open('number', depth)}${n[0]}${R}`;
      i += n[0].length;
      continue;
    }
    out += line[i];
    i += 1;
  }
  return out;
}
