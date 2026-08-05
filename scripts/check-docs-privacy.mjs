#!/usr/bin/env node
/**
 * Refuse to ship documentation that leaks a real session.
 *
 * Everything this project publishes — the site, the READMEs, DEMO.md, ARCHITECTURE.md — quotes real
 * command output, and the easiest way to produce that output is to run the command against the session
 * you happen to be in. That is exactly how a maintainer's home path, a real session id, and a verbatim
 * transcript excerpt ended up in a published walkthrough. The rule is simple: quoted output must come
 * from `claude-observatory demo`, whose session is synthetic and disposable.
 *
 * Run: node scripts/check-docs-privacy.mjs   (exit 1 on any finding; part of `npm test`)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Anything published from docs/ counts, at any depth — the devcontainer recipe and the mock sources
 *  ship with the site exactly as the pages do. Source files are excluded on purpose: a path in a code
 *  comment explains a code path. */
const TEXT = /\.(html|md|sh|json|txt|ya?ml|svg)$/i;
function walk(dir, out = []) {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (TEXT.test(entry)) out.push(rel);
  }
  return out;
}
const FILES = [
  'README.md',
  'CHANGELOG.md',
  ...walk('docs'),
  ...['cli', 'vscode', 'jetbrains'].map((p) => join('packages', p, 'README.md')),
];

const RULES = [
  {
    id: 'home-path',
    // A real absolute home directory. `~/…`, `/Users/you/…` and `$HOME/…` are the documented forms.
    re: /\/(?:Users|home)\/(?!(?:you|user|me)\b)[a-z0-9][a-z0-9._-]*/gi,
    why: 'an absolute home path names a real machine and its owner — write ~/… or /Users/you/… instead',
  },
  {
    id: 'machine-temp',
    // A scratch directory on someone's machine. Structural, not keyword-based: `mktemp -d` output looks
    // nothing like "claude" and is exactly what the remediation below produces, so anything under a temp
    // root is suspect unless it is one of the two sanctioned literals the docs use as examples.
    re: /\/(?:private\/)?(?:tmp|var\/folders)\/(?!obs-demo\b|your-temp-dir\b)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/g,
    why: 'that is a scratch directory on a real machine — write /tmp/obs-demo/… or run the demo there',
  },
  {
    id: 'session-link',
    re: /claude\.ai\/code\/session|Claude-Session:/g,
    why: 'a Claude session URL or trailer identifies a private working session',
  },
  {
    id: 'transcript-path',
    re: /\.claude\/projects\/-[A-Za-z0-9-]+/g,
    why: 'a mangled project path points at a real transcript directory',
  },
  {
    // Plan and memory files are private working state in exactly the way a transcript is, and this
    // check did not look for them: a real `~/.claude/plans/<name>.md` path reached a committed doc and
    // a source comment as an example of a long filename, carrying the plan's generated name with it.
    id: 'plan-or-memory-path',
    re: /\.claude\/(?:plans|memory)\b/g,
    why: 'a plan or memory path is private working state — use a neutral example filename',
  },
  {
    id: 'real-session-id',
    // Claude Code session ids are v4 UUIDs. Demo sessions are `demo-xxxxxxxx`, which is the only kind
    // of id that belongs in published output.
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
    why: 'that is a real Claude Code session id — quote a demo session (demo-xxxxxxxx) instead',
  },
  {
    id: 'session-id-prefix',
    // The dashboard and both editors DISPLAY a session by its first 8 hex characters, so that is the
    // form a leak actually takes — a full UUID is what nobody pastes. The published README shipped
    // "🔬 1da03a90" (a live session, with its live counts beside it) and the UUID rule above matched
    // nothing. Anchored to the shapes that mean "session" so an ordinary 8-hex string — a colour, a
    // short commit — is not a false alarm.
    re: /(?:🔬\s*|session\s+|--session\s+)(?!demo-)\b[0-9a-f]{8}\b/gi,
    why: 'that is a real session id as the product displays it — use the demo session (demo-xxxxxxxx)',
  },
  {
    id: 'long-agent-id',
    // Subagent ids are 17 hex chars; the demo's are readable (`demosub1`).
    re: /\b[0-9a-f]{17,}\b/g,
    why: 'that looks like a real subagent id from a live session — use the demo session’s ids',
  },
];

let findings = 0;
for (const rel of FILES) {
  let text;
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    continue; // a file listed but absent (a redirect stub replaced it, say) is not a leak
  }
  const lines = text.split('\n');
  for (const rule of RULES) {
    lines.forEach((line, i) => {
      // A `privacy-ok` comment documents a deliberate exception. It counts on the line itself or the
      // line above, because a continued shell line has nowhere to put a trailing comment.
      if (/privacy-ok/.test(line) || (i > 0 && /privacy-ok/.test(lines[i - 1]))) return;
      const hits = line.match(rule.re);
      if (!hits) return;
      findings++;
      console.error(`${rel}:${i + 1}  [${rule.id}]  ${hits[0]}\n    ${rule.why}`);
    });
  }
}

if (findings) {
  console.error(
    `\n✗ ${findings} privacy finding(s) in published documentation.\n` +
      '  Regenerate the affected output from the demo session:\n' +
      '    export CLAUDE_CONFIG_DIR=$(mktemp -d) && cd "$(mktemp -d)"\n' +
      '    claude-observatory demo --fast && claude-observatory <command>\n' +
      '    claude-observatory demo --clean\n'
  );
  process.exit(1);
}
console.log(`✓ no session leaks in ${FILES.length} published file(s)`);
