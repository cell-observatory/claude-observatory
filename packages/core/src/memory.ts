/**
 * Review memory (zero-token): what the observatory has LEARNED about a file across every session.
 *
 * The store already is a memory — every past session's edits, the reviewer's keep/undo verdicts, and
 * any cached `claude -p` analyses live under ~/.claude/claude-observatory/. This derives a per-file
 * history from it live (no new persistence, no staleness, no embeddings): how often edits to this
 * file were accepted vs reverted, the last verdict, and the latest Claude notes about it. Surfaced in
 * Observations so reviews get sharper the longer the tool is used.
 */
import * as fs from 'fs';
import * as path from 'path';
import { readLog, logPath, allStoreSessionIds, EditRecord } from './store';
import { cachedAnalysis } from './analyze';
import { cachedByFiles } from './fscache';

export interface FileMemory {
  edits: number; // total edits ever captured for this file (all sessions)
  kept: number;
  undone: number;
  pending: number;
  lastVerdict: { status: 'kept' | 'undone'; ts: number } | null; // most recent human decision
  notes: { ts: number; text: string }[]; // first lines of cached Claude analyses, newest first (≤3)
}

/**
 * Every session's edit records, grouped by the file they touched — built in ONE pass over the store.
 *
 * `fileMemory` used to walk every session's whole log per file, so a caller asking about N files paid
 * N × (sessions × records). Observations asks about every file a session edited: 405 files against a
 * 40-session store measured 4.7 ms each — ~1.9 s — and it got worse with every session ever recorded,
 * since the scan is over the STORE, not the session. Inverting it makes each lookup a map hit.
 *
 * Memoized on the set of log files by (mtime, size), so a store that has not changed is not re-walked,
 * and any log that grows rebuilds the index.
 */
function memoryIndex(): Map<string, { session: string; rec: EditRecord }[]> {
  // `allStoreSessionIds` is a readdir; `listSessions` readLOGs every session and copies every record,
  // which measured 289 ms of the 445 ms spent on 405 lookups — in FRONT of the memo, so the memo could
  // never help. The index only needs the ids and their log paths.
  const ids = allStoreSessionIds().filter((id) => fs.existsSync(logPath(id)));
  return cachedByFiles(
    'memoryIndex',
    ids.map((id) => logPath(id)),
    () => {
      const idx = new Map<string, { session: string; rec: EditRecord }[]>();
      for (const id of ids) {
        for (const rec of readLog(id)) {
          const key = path.resolve(rec.file);
          const arr = idx.get(key);
          if (arr) arr.push({ session: id, rec });
          else idx.set(key, [{ session: id, rec }]);
        }
      }
      return idx;
    }
  );
}

/** Cross-session review history for one file, derived live from the store. */
export function fileMemory(file: string): FileMemory {
  const m: FileMemory = { edits: 0, kept: 0, undone: 0, pending: 0, lastVerdict: null, notes: [] };
  for (const { session, rec } of memoryIndex().get(path.resolve(file)) ?? []) {
    m.edits++;
    if (rec.status === 'kept') m.kept++;
    else if (rec.status === 'undone') m.undone++;
    else m.pending++;
    if (rec.status === 'kept' || rec.status === 'undone') {
      if (!m.lastVerdict || rec.ts > m.lastVerdict.ts) m.lastVerdict = { status: rec.status, ts: rec.ts };
    }
    const a = cachedAnalysis(session, `edit-${rec.id}`);
    if (a) {
      const first = a.text.split('\n').find((l) => l.trim());
      if (first) m.notes.push({ ts: a.ts, text: first.replace(/^\*\*Summary:?\*\*:?\s*/i, '').trim() });
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
