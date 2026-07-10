/**
 * Shared match semantics for the "Search edits" filter, so the VS Code and JetBrains front-ends
 * filter identically: case-insensitive substring, and an empty query matches everything.
 * (JetBrains mirrors this one-liner until the tree moves onto the CLI `--json` backend.)
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return haystack.toLowerCase().includes(q);
}
