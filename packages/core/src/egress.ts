/**
 * Egress report (zero-token): "what did this session touch off-machine, and where?" Derived from the
 * action timeline — WebFetch/WebSearch destinations, MCP servers invoked, and network-touching shell
 * commands — so you can see a session's outbound surface at a glance. Adapted from CortexIDE's egressReport.
 */
import * as path from 'path';
import { ActionRecord } from './actions';

/** 'remote' left the machine · 'local' stayed on it but crossed the workspace boundary · 'unknown' is
 *  a destination we could not classify. Never collapse 'local' into 'unknown': one is a fact, the
 *  other is an admission. */
export type EgressScope = 'remote' | 'local' | 'unknown';

export interface EgressChannel {
  kind: 'web' | 'mcp' | 'shell' | 'file';
  /** The destination: a domain, an MCP server name, the network command/host, or — for `file` — a path
   *  the session READ from outside the workspace. */
  target: string;
  scope: EgressScope;
  count: number;
}

/** Network-touching shell commands (a session's off-machine shell surface). */
const NET_CMD =
  /\b(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|dig|nslookup|host|npm|pnpm|yarn|npx|pip[0-9.]*|brew|apt|apt-get|gh|aws|gcloud|az|docker|kubectl|helm|terraform)\b/i;
/** …but only when the invocation actually reaches out (installs, fetches, remote git, a URL). Bare `i`
 *  is intentionally excluded — it's `npm i` shorthand but matches a stray "i" almost anywhere. */
const NET_INTENT =
  /\bhttps?:\/\/|\b(?:install|ci|publish|pull|push|fetch|clone|update|upgrade|remote|login|deploy|apply)\b/i;

/** Best-effort host from a URL or bare host string. */
function hostOf(s: string): string {
  const m = s.match(/https?:\/\/([^/\s'"]+)/i);
  if (m) return m[1].replace(/^www\./, '');
  return s;
}

/**
 * The distinct outbound channels this session used, most-used first. `remote` = definitely leaves the
 * machine (web, network shell); `unknown` = an MCP server we can't tell stdio-local from remote by name.
 */
/**
 * Reads that landed OUTSIDE the workspace. A file the agent opened in your home directory is reach
 * beyond the boundary you gave it — the same question egress already answers for the network — and
 * nothing else in the product states it: the ledger is presented workspace-relative, and risk only
 * looks at commands. `root` is the workspace boundary (the change map's display root, not the process
 * cwd, which differs whenever an editor passes --root).
 */
export function outsideReads(actions: ActionRecord[], root: string): EgressChannel[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const byPath = new Map<string, number>();
  for (const a of actions) {
    if (a.category !== 'read' || !a.target) continue;
    const abs = path.isAbsolute(a.target) ? a.target : path.resolve(root, a.target);
    const rel = path.relative(root, abs);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) continue; // inside the workspace
    // Forward-slashed + home-shortened, like every other path shown (Windows carries backslashes on
    // both `abs` and `home`, so normalize before comparing/slicing — see outsideWrites in risk.ts).
    const absN = abs.replace(/\\/g, '/');
    const homeN = home.replace(/\\/g, '/');
    const shown = homeN && absN.startsWith(homeN) ? '~' + absN.slice(homeN.length) : absN;
    byPath.set(shown, (byPath.get(shown) ?? 0) + 1);
  }
  return [...byPath.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([target, count]) => ({ kind: 'file' as const, target, scope: 'local' as const, count }));
}

export function buildEgressReport(actions: ActionRecord[]): EgressChannel[] {
  const map = new Map<string, EgressChannel>();
  const bump = (kind: EgressChannel['kind'], target: string, scope: EgressScope) => {
    const key = `${kind}|${target}`;
    const e = map.get(key);
    if (e) e.count++;
    else map.set(key, { kind, target, scope, count: 1 });
  };
  for (const a of actions) {
    if (a.tool === 'WebFetch') bump('web', hostOf(a.target), 'remote');
    else if (a.tool === 'WebSearch') bump('web', 'web search', 'remote');
    else if (a.tool.startsWith('mcp__')) bump('mcp', a.tool.split('__')[1] || a.tool, 'unknown'); // mcp__<server>__<tool>
    else if (a.category === 'exec' && NET_CMD.test(a.target) && NET_INTENT.test(a.target)) {
      const url = a.target.match(/https?:\/\/[^\s'"]+/i);
      const cmd = a.target.match(NET_CMD);
      bump('shell', url ? hostOf(url[0]) : cmd ? cmd[1].toLowerCase() : 'shell', 'remote');
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

export interface EgressSummary {
  channels: EgressChannel[];
  remote: number; // distinct definitely-off-machine destinations
  byKind: Record<string, number>;
}

export function summarizeEgress(channels: EgressChannel[]): EgressSummary {
  const byKind: Record<string, number> = {};
  let remote = 0;
  for (const c of channels) {
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    if (c.scope === 'remote') remote++;
  }
  return { channels, remote, byKind };
}
