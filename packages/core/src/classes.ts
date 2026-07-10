/**
 * Lightweight, language-agnostic class-span detection — used to group edits by the class they fall
 * in. Heuristic (regex + brace/indent matching, not a real parser); good enough for a review tree.
 */
export interface ClassSpan {
  name: string;
  start: number; // 0-based first line (the `class` declaration)
  end: number; // 0-based last line (inclusive)
}

function findOpenBrace(lines: string[], from: number): number {
  for (let i = from; i < Math.min(lines.length, from + 6); i++) {
    if (lines[i].includes('{')) return i;
  }
  return -1;
}

/** Naive brace matcher (ignores braces in strings/comments — acceptable for grouping). */
function matchBrace(lines: string[], openLine: number): number {
  let depth = 0;
  let started = false;
  for (let i = openLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
        if (started && depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/** Detect class declarations + their line spans (brace languages and Python). */
export function detectClasses(text: string): ClassSpan[] {
  const lines = text.split('\n');
  const out: ClassSpan[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Python: `class Name(...):` — allows a trailing comment; \s also eats a CR on CRLF files.
    const py = /^(\s*)class\s+([A-Za-z_$][\w$]*)\s*(?:\([^)]*\)\s*)?:\s*(?:#.*)?$/.exec(line);
    if (py) {
      const indent = py[1].length;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        const ind = lines[j].length - lines[j].trimStart().length;
        if (ind <= indent) break;
        end = j;
      }
      out.push({ name: py[2], start: i, end });
      continue;
    }
    // Brace languages: `export? default? abstract? class Name ... {`
    const br = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (br) {
      const openLine = findOpenBrace(lines, i);
      if (openLine >= 0) {
        const end = matchBrace(lines, openLine);
        if (end >= i) out.push({ name: br[1], start: i, end });
      }
    }
  }
  return out;
}

/** Innermost class span containing `line`, or null. (Smallest span wins for nested classes.) */
export function classAt(spans: ClassSpan[], line: number): ClassSpan | null {
  let best: ClassSpan | null = null;
  for (const s of spans) {
    if (line >= s.start && line <= s.end) {
      if (!best || s.end - s.start < best.end - best.start) best = s;
    }
  }
  return best;
}
