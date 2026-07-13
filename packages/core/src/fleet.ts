/**
 * Fleet / cross-agent awareness (zero-token): the OTHER Claude Code sessions working in the same
 * project as this one — so a human can watch a fleet of concurrent agents, and (via `siblings --json`)
 * so an agent can see what its siblings are touching and adjust in real time.
 *
 * "Sibling" = a session whose transcript lives in the same project dir (projectDir(cwd)). For each we
 * derive, live from the store + transcript: active/idle status (transcript freshness), pending edits,
 * the files it has touched, and a risk-flag count. Read-only and path-only — no file contents cross
 * between agents, so this can't leak one agent's secrets to another. No model calls, no network.
 */
import * as fs from 'fs';
import * as path from 'path';
import { projectDir } from './session';
import { readLog, isSafeSessionId } from './store';
import { parseActions } from './actions';

/** A session whose transcript mtime is within this of now is "active" (an agent is live in it). */
export const FLEET_ACTIVE_MS = 60_000;

export interface SiblingSession {
  id: string;
  /** True for the current (querying) session — so a UI can mark "you are here" and a digest can skip it. */
  self: boolean;
  /** Transcript touched within FLEET_ACTIVE_MS ⇒ an agent is live in this session right now. */
  active: boolean;
  /** Transcript mtime (ms epoch) — last activity. */
  lastMs: number;
  edits: number;
  pending: number;
  /** Distinct absolute files this session has edits for (capped; `moreFiles` = how many were elided). */
  files: string[];
  moreFiles: number;
  /** Risky shell commands this session ran (total + high-severity), for a conflict/safety heads-up. */
  risk: { total: number; high: number };
}

/** How many distinct files to list per sibling before eliding the rest (keeps the digest compact). */
const FILE_CAP = 20;

/** Session ids whose transcript lives in this project — CHEAP (one readdir, no store/transcript
 *  reads). Lets a UI decide whether to show a Fleet affordance before doing the full listSiblings parse. */
export function projectSessionIds(cwd: string): string[] {
  try {
    return fs
      .readdirSync(projectDir(cwd))
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.slice(0, -'.jsonl'.length))
      .filter(isSafeSessionId);
  } catch {
    return [];
  }
}

/**
 * Every session in the current project (siblings + self), newest activity first. `activeSessionId`
 * marks which one is `self`. Zero token — store reads plus one transcript parse per sibling for risk.
 */
export function listSiblings(cwd: string, activeSessionId?: string): SiblingSession[] {
  const dir = projectDir(cwd);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const out: SiblingSession[] = [];
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!isSafeSessionId(id)) continue;
    let lastMs = 0;
    try {
      lastMs = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    const log = readLog(id); // [] when the session captured no edits — still a real sibling agent
    const distinct: string[] = [];
    const seen = new Set<string>();
    let pending = 0;
    for (const r of log) {
      if (r.status === 'pending') pending++;
      if (!seen.has(r.file)) {
        seen.add(r.file);
        distinct.push(r.file);
      }
    }
    // Risk needs the transcript (Bash commands aren't in the store); parse it the same way the Actions
    // view does. Siblings in one project are few, so the extra parse per refresh is acceptable.
    let riskTotal = 0;
    let riskHigh = 0;
    for (const a of parseActions(cwd, id)) {
      if (a.risk) {
        riskTotal++;
        if (a.risk.level === 'high') riskHigh++;
      }
    }
    out.push({
      id,
      self: id === activeSessionId,
      active: now - lastMs <= FLEET_ACTIVE_MS,
      lastMs,
      edits: log.length,
      pending,
      files: distinct.slice(0, FILE_CAP),
      moreFiles: Math.max(0, distinct.length - FILE_CAP),
      risk: { total: riskTotal, high: riskHigh },
    });
  }
  return out.sort((a, b) => b.lastMs - a.lastMs);
}

export interface FleetSummary {
  total: number; // sessions in this project (including self)
  active: number; // how many are live right now
  siblings: number; // total minus self
  pending: number; // pending edits across siblings (excludes self)
}

/** Headline rollup for the fleet (the Actions "Fleet" node header + `siblings` non-JSON output). */
export function summarizeFleet(sessions: SiblingSession[]): FleetSummary {
  const siblings = sessions.filter((s) => !s.self);
  return {
    total: sessions.length,
    active: sessions.filter((s) => s.active).length,
    siblings: siblings.length,
    pending: siblings.reduce((n, s) => n + s.pending, 0),
  };
}
