/**
 * Command risk scoring (zero-token): flag the shell commands an agent ran that can destroy data,
 * escalate privilege, execute remote code, or touch credentials. Pure pattern-matching over the Bash
 * command strings already in the action timeline — no model calls. Adapted from CortexIDE's commandRisk.
 *
 * Deliberately conservative + few rules: a noisy risk signal gets ignored. High = irreversible / remote
 * code / data loss; Medium = elevated privilege or credential access worth a second look.
 */
export type RiskLevel = 'high' | 'medium';

export interface CommandRisk {
  level: RiskLevel;
  reasons: string[];
}

interface Rule {
  level: RiskLevel;
  re: RegExp;
  reason: string;
}

// Patterns are simple/linear (no nested quantifiers) so they can't backtrack catastrophically on a
// crafted command string. Command-name rules are guarded by CMD (start / whitespace / a shell operator)
// AND require the command to be followed by whitespace + args — so a risky token that merely appears as
// TEXT (an echoed `"sudo …"`, a path like `a/curl|sh/b`, a grep pattern) doesn't false-positive.
const CMD = String.raw`(?:^|[\s;&|(])`;
const RULES: Rule[] = [
  // --- HIGH: destructive / irreversible ---
  { level: 'high', re: new RegExp(`${CMD}rm\\s+(?:-\\S+\\s+)*-\\S*(?:rf|fr)\\S*`, 'i'), reason: 'recursive/forced delete (rm -rf)' },
  { level: 'high', re: new RegExp(`${CMD}git\\s+reset\\s+--hard\\b`, 'i'), reason: 'git reset --hard — discards local changes' },
  { level: 'high', re: new RegExp(`${CMD}git\\s+clean\\s+-\\S*f`, 'i'), reason: 'git clean -f — deletes untracked files' },
  { level: 'high', re: new RegExp(`${CMD}git\\s+push\\b[^|]*?\\s-{1,2}f(?:orce)?(?:-with-lease)?\\b`, 'i'), reason: 'force push — rewrites remote history' },
  { level: 'high', re: new RegExp(`${CMD}(?:mkfs\\S*|shred|fdisk)\\s`, 'i'), reason: 'destructive disk/filesystem operation' },
  { level: 'high', re: new RegExp(`${CMD}dd\\s+[^\\n|]*\\bof=`, 'i'), reason: 'dd — raw disk write' },
  { level: 'high', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, reason: 'fork bomb' },
  { level: 'high', re: new RegExp(`${CMD}chmod\\s+-R\\s+0*777\\b`, 'i'), reason: 'chmod -R 777 — world-writable' },
  // --- HIGH: remote code execution — a download piped straight into a SHELL (the classic curl|sh).
  // Restricted to shells on purpose: `curl … | python3 -c "…"` / `| node` is usually *parsing*, not
  // executing downloaded code. `curl\s` (space + a URL arg) rules out the literal text "curl|sh".
  { level: 'high', re: new RegExp(`${CMD}(?:curl|wget|fetch)\\s[^|]*\\|\\s*(?:sudo\\s+)?(?:sh|bash|zsh|ksh|dash|fish)\\b`, 'i'), reason: 'pipes a download straight into a shell (curl | sh)' },
  // --- MEDIUM: elevated privilege (must be `sudo <cmd>`, not the word "sudo" in a string) ---
  { level: 'medium', re: new RegExp(`${CMD}(?:sudo|doas)\\s`, 'i'), reason: 'elevated privilege (sudo/doas)' },
  // --- MEDIUM: credential / secret access (path-based) ---
  { level: 'medium', re: /(?:^|[\s'"/=])(?:\.env(?:\.|\b)|\.ssh\/|\.aws\/credentials|\.npmrc|\.netrc|id_(?:rsa|ed25519)|\.git-credentials)/i, reason: 'touches a credential/secret file' },
];

/** Score one shell command. Returns null when nothing risky matched. Level = highest matched rule. */
export function scoreCommand(command: string): CommandRisk | null {
  if (!command) return null;
  const reasons: string[] = [];
  let high = false;
  for (const r of RULES) {
    if (r.re.test(command)) {
      reasons.push(r.reason);
      if (r.level === 'high') high = true;
    }
  }
  if (reasons.length === 0) return null;
  return { level: high ? 'high' : 'medium', reasons };
}
