/**
 * Review memory (zero-token): what the observatory has LEARNED about a file across every session.
 *
 * The store already is a memory — every past session's edits, the reviewer's keep/undo verdicts, and
 * any cached `claude -p` analyses live under ~/.claude/claude-observatory/. This derives a per-file
 * history from it live (no new persistence, no staleness, no embeddings): how often edits to this
 * file were accepted vs reverted, the last verdict, and the latest Claude notes about it. Surfaced in
 * Observations so reviews get sharper the longer the tool is used.
 */
import * as path from 'path';
import { listSessions, readLog } from './store';
import { cachedAnalysis } from './analyze';

export interface FileMemory {
  edits: number; // total edits ever captured for this file (all sessions)
  kept: number;
  undone: number;
  pending: number;
  lastVerdict: { status: 'kept' | 'undone'; ts: number } | null; // most recent human decision
  notes: { ts: number; text: string }[]; // first lines of cached Claude analyses, newest first (≤3)
}

/** Cross-session review history for one file, derived live from the store. */
export function fileMemory(file: string): FileMemory {
  const target = path.resolve(file);
  const m: FileMemory = { edits: 0, kept: 0, undone: 0, pending: 0, lastVerdict: null, notes: [] };
  for (const s of listSessions()) {
    for (const rec of readLog(s.id)) {
      if (path.resolve(rec.file) !== target) continue;
      m.edits++;
      if (rec.status === 'kept') m.kept++;
      else if (rec.status === 'undone') m.undone++;
      else m.pending++;
      if (rec.status === 'kept' || rec.status === 'undone') {
        if (!m.lastVerdict || rec.ts > m.lastVerdict.ts) m.lastVerdict = { status: rec.status, ts: rec.ts };
      }
      const a = cachedAnalysis(s.id, `edit-${rec.id}`);
      if (a) {
        const first = a.text.split('\n').find((l) => l.trim());
        if (first) m.notes.push({ ts: a.ts, text: first.replace(/^\*\*Summary:?\*\*:?\s*/i, '').trim() });
      }
    }
  }
  m.notes.sort((a, b) => b.ts - a.ts);
  m.notes = m.notes.slice(0, 3);
  return m;
}

/** True when this file's track record says "review extra carefully" (≥2 reverts and reverts ≥ keeps). */
export function isRiskyFile(m: FileMemory): boolean {
  return m.undone >= 2 && m.undone >= m.kept;
}

/** One-line human summary of a file's review history ('' when there is no history yet). */
export function memorySummary(m: FileMemory, nowMs?: number): string {
  const decided = m.kept + m.undone;
  if (m.edits === 0 || decided === 0) return '';
  const pct = Math.round((m.kept / decided) * 100);
  let last = '';
  if (m.lastVerdict) {
    const mins = Math.max(1, Math.round(((nowMs ?? Date.now()) - m.lastVerdict.ts) / 60000));
    const ago = mins >= 1440 ? `${Math.floor(mins / 1440)}d ago` : mins >= 60 ? `${Math.floor(mins / 60)}h ago` : `${mins}m ago`;
    last = ` · last ${m.lastVerdict.status === 'kept' ? 'accepted' : 'reverted'} ${ago}`;
  }
  return `${m.edits} edit${m.edits === 1 ? '' : 's'} across sessions · ${pct}% accepted${last}`;
}
