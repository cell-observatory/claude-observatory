/**
 * Capability footprint (zero-token): what a session actually REACHED FOR — files outside the
 * workspace, shell commands (and how risky they were), MCP servers, the network, subagents.
 *
 * Honest framing, and the reason this isn't called "permissions": Claude Code writes nothing to the
 * transcript when it prompts for approval, so no read-only observer can know what was auto-approved
 * versus what a human waved through. What IS recorded is every call that ran. So this counts
 * EXERCISED capability, never granted permission — the badges say "this session did X", not "this
 * session was allowed to do X".
 *
 * A pure fold over an ActionRecord[] the caller already parsed: no file reads, no transcript pass.
 * buildChangeMap runs once per fleet sibling, so anything here multiplies by fleet size.
 */
import * as path from 'path';
import { ActionRecord } from './actions';

/** One in/out-of-workspace file-touch tally. */
export interface CapabilityBadge {
  count: number;
  /** How many of those landed OUTSIDE the workspace root. */
  outOfRoot: number;
  /** Up to a few example out-of-root paths (home-shortened), for the badge tooltip. */
  samples: string[];
}

export interface CapabilityFootprint {
  reads: CapabilityBadge;
  edits: CapabilityBadge;
  /** Shell commands, with the risk tiers risk.ts already scored on each record. */
  exec: { count: number; risky: number; high: number };
  /** MCP tool calls and the distinct servers behind them. */
  mcp: { calls: number; servers: string[] };
  /** Network reach: WebFetch/WebSearch calls and the distinct hosts fetched. */
  web: { calls: number; hosts: string[] };
  /** Subagent spawns (Task/Agent). */
  agents: { spawns: number };
}

/** The caveat every surface prints beside a footprint. Defined ONCE here, like `ContextSourcesReport`'s
 *  note, so the CLI and both editors can't drift into wording that implies permission was granted. */
export const CAPABILITIES_NOTE = 'exercised, not approved — permission prompts are never written to the transcript';

const SAMPLE_CAP = 3;

/** Shorten a home-relative path for display, so a tooltip reads `~/.claude/CLAUDE.md`. */
function tilde(p: string): string {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

/** Is this file target outside the workspace root? Mirrors the change map's "(external)" rule. */
function outside(root: string, target: string): boolean {
  if (!target) return false;
  const abs = path.isAbsolute(target) ? target : path.resolve(root, target);
  const rel = path.relative(root, abs);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function emptyBadge(): CapabilityBadge {
  return { count: 0, outOfRoot: 0, samples: [] };
}

/** Count one file touch into a badge, recording a sample when it's out-of-root and new. */
function tally(b: CapabilityBadge, root: string, target: string): void {
  b.count++;
  if (!outside(root, target)) return;
  b.outOfRoot++;
  const shown = tilde(path.isAbsolute(target) ? target : path.resolve(root, target));
  if (b.samples.length < SAMPLE_CAP && !b.samples.includes(shown)) b.samples.push(shown);
}

/**
 * Fold an action stream into its capability footprint. `root` is the workspace the session belongs to
 * (the change map's display root, not the process cwd — an editor passes `--root <workspace>` from a
 * different working directory, and using cwd would mislabel every path).
 */
export function buildCapabilities(actions: ActionRecord[], opts: { root: string }): CapabilityFootprint {
  const root = opts.root;
  const out: CapabilityFootprint = {
    reads: emptyBadge(),
    edits: emptyBadge(),
    exec: { count: 0, risky: 0, high: 0 },
    mcp: { calls: 0, servers: [] },
    web: { calls: 0, hosts: [] },
    agents: { spawns: 0 },
  };
  const servers = new Map<string, number>();
  const hosts = new Map<string, number>();

  for (const a of actions) {
    switch (a.category) {
      case 'read':
        tally(out.reads, root, a.target);
        break;
      case 'edit':
        tally(out.edits, root, a.target);
        break;
      case 'exec':
        // A shell command can of course write files anywhere; that stays counted HERE (with its risk
        // score) rather than being guessed into `edits`, which only ever means a file-edit tool call.
        out.exec.count++;
        if (a.risk) {
          out.exec.risky++;
          if (a.risk.level === 'high') out.exec.high++;
        }
        break;
      case 'mcp': {
        out.mcp.calls++;
        // mcp__<server>__<tool> — the server is the middle segment.
        const server = a.tool.split('__')[1] || '';
        if (server) servers.set(server, (servers.get(server) || 0) + 1);
        break;
      }
      case 'web': {
        out.web.calls++;
        try {
          const h = new URL(a.target).host;
          if (h) hosts.set(h, (hosts.get(h) || 0) + 1);
        } catch {
          /* WebSearch targets are queries, not URLs — they count as a call with no host */
        }
        break;
      }
      case 'agent':
        out.agents.spawns++;
        break;
      default:
        break;
    }
  }

  const byUseDesc = (m: Map<string, number>): string[] =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  out.mcp.servers = byUseDesc(servers);
  out.web.hosts = byUseDesc(hosts);
  return out;
}
