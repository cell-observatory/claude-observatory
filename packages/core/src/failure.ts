/**
 * What an editor should SHOW when a CLI run fails.
 *
 * This exists because of a real report (#45): a Windows user clicked "Update now", the update failed
 * for a concrete and fixable reason, and the toast said
 *
 *     Claude Observatory: update failed — (node:326100) [DEP0190] DeprecationWarning: Passing args to
 *     a child process with shell option true can lead to security vulnerabilities…
 *
 * Both editors rendered `stderr || stdout`. The reason was on STDOUT (the CLI's `⚠ an installed
 * extension could not be updated` line), while stderr held nothing but a Node deprecation warning the
 * CLI's own npm spawn had emitted. The warning won, and the person reading it had no way to reach the
 * actual problem.
 *
 * "Just prefer stdout" is the wrong correction — stderr genuinely carries the CLI's `fail()` output,
 * which IS the reason whenever it is present. The rule is: discard runtime NOISE from stderr, prefer
 * whatever is left, and only then fall back to stdout — and when falling back, pick the lines that
 * look like a problem rather than the first 300 characters of a progress log.
 *
 * Kept in core, not in the extension, so the CLI can be the single source of this judgement. The
 * JetBrains plugin cannot import TypeScript and mirrors it in Kotlin
 * (`core/ObservatoryCli.kt: failureMessage`); the two are pinned together by a source assertion in
 * the test suite, because a silent divergence here is exactly the class of bug this fixes.
 */

/** Node's own runtime chatter on stderr: `(node:123) [DEP0190] DeprecationWarning: …` and the
 *  `(Use \`node --trace-deprecation …\`)` hint that follows it. Never a failure reason. */
const NODE_NOISE = /^\s*(?:\(node:\d+\)|\(Use `node )/;

/** Lines that read as a problem rather than as progress — used only when falling back to stdout. */
const LOOKS_LIKE_TROUBLE = /(?:^\s*[⚠✗✘✖!]|\b(?:fail(?:ed|ure)?|could not|couldn't|cannot|can't|unable|denied|refused|missing|not found|no such)\b)/i;

/**
 * The one line (or few) to put in front of a person when a CLI invocation failed.
 *
 * @param stdout  the run's stdout
 * @param stderr  the run's stderr
 * @param fallback shown when the process said nothing useful at all (e.g. "is the CLI installed?")
 * @param maxLen  hard cap, so a toast can never be a wall of text
 */
export function cliFailureMessage(
  stdout: string | null | undefined,
  stderr: string | null | undefined,
  fallback: string,
  maxLen = 300
): string {
  const cap = (s: string) => (s.length > maxLen ? s.slice(0, maxLen - 1).trimEnd() + '…' : s);
  const lines = (s: string | null | undefined) =>
    String(s ?? '')
      .split(/\r?\n/)
      .map((l) => l.trimEnd());

  // 1. stderr, minus Node's warnings. `fail()` writes here, so anything left is THE reason.
  const realStderr = lines(stderr)
    .filter((l) => l.trim() !== '' && !NODE_NOISE.test(l))
    .join('\n')
    .trim();
  if (realStderr) return cap(realStderr);

  // 2. stdout, but only the lines that read as trouble — the CLI's progress log is long and its ⚠ is
  //    at the END, so a naive head-of-stdout would show "downloading …" and hide the reason.
  const out = lines(stdout).filter((l) => l.trim() !== '');
  const trouble = out.filter((l) => LOOKS_LIKE_TROUBLE.test(l));
  if (trouble.length) return cap(trouble.join('\n').trim());

  // 3. Something was said, just nothing we can classify — show the TAIL, where a summary lives.
  if (out.length) return cap(out.slice(-3).join('\n').trim());

  return fallback;
}
