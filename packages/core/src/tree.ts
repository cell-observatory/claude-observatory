/**
 * Edit-tree view-model — the single source of the folder → file → class → edit structure that the
 * VS Code and JetBrains front-ends render. Folder-chain compaction, class grouping, and exact line
 * deltas all live here (and are exposed as `tree --json`), so the two editors stop reimplementing
 * them. Renderers walk the returned structure; they no longer compute it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { EditRecord, EditStatus, readLog, readBlob } from './store';
import { lineDelta } from './format';
import { detectClasses, classAt } from './classes';
import * as crypto from 'crypto';
import { locateEditsInCurrent } from './ranges';
import { matchesQuery } from './filter';
import { reviewEdits } from './groups';

export interface TreeEdit {
  id: number;
  ts: number;
  tool: string;
  file: string;
  status: EditStatus;
  beforeBlob: string | null;
  afterBlob: string | null;
  added: number;
  removed: number;
}
export interface TreeClass {
  name: string;
  edits: TreeEdit[];
}
export interface TreeFile {
  rel: string;
  file: string;
  classes: TreeClass[];
  loose: TreeEdit[]; // edits not inside any detected class
}
export interface TreeFolder {
  label: string; // may be a compacted chain like "src/utils"
  path: string; // absolute directory path (drives scoped folder Accept/Revert/Clear)
  folders: TreeFolder[];
  files: TreeFile[];
}
export interface EditTree {
  folders: TreeFolder[];
  files: TreeFile[];
}

/** Immediate folder segments + files directly under `prefix` (no compaction). */
function immediate(rels: string[], prefix: string): { folderSegs: Set<string>; files: string[] } {
  const folderSegs = new Set<string>();
  const files: string[] = [];
  for (const rel of rels) {
    if (!rel.startsWith(prefix)) continue;
    const rem = rel.slice(prefix.length);
    const slash = rem.indexOf('/');
    if (slash >= 0) folderSegs.add(rem.slice(0, slash));
    else files.push(rel);
  }
  return { folderSegs, files };
}

/** Any descendant file of a folder (folders only exist because some file lives beneath them). */
function firstFile(f: { folders: TreeFolder[]; files: TreeFile[] }): TreeFile | undefined {
  if (f.files.length) return f.files[0];
  for (const c of f.folders) {
    const r = firstFile(c);
    if (r) return r;
  }
  return undefined;
}

/** Absolute directory path for the folder at rel-prefix `p`, derived from a descendant file's
 *  absolute path (so it's correct regardless of `opts.root` or the OS separator). */
function folderAbs(prefix: string, node: { folders: TreeFolder[]; files: TreeFile[] }): string {
  const sample = firstFile(node);
  if (!sample) return '';
  const nativeTail = sample.rel.slice(prefix.length).split('/').join(path.sep); // file's path below the folder
  let abs = sample.file.slice(0, sample.file.length - nativeTail.length);
  if (abs.endsWith(path.sep)) abs = abs.slice(0, -1);
  return abs;
}

/** Folders + files under `prefix`, with single-child folder chains compacted (src/utils/…). */
function subtree(rels: string[], prefix: string, byRel: Map<string, TreeFile>): { folders: TreeFolder[]; files: TreeFile[] } {
  const { folderSegs, files } = immediate(rels, prefix);
  const folders: TreeFolder[] = [...folderSegs].sort().map((seg) => {
    let p = prefix + seg + '/';
    let label = seg;
    for (;;) {
      const sub = immediate(rels, p);
      if (sub.files.length === 0 && sub.folderSegs.size === 1) {
        const only = [...sub.folderSegs][0];
        p = p + only + '/';
        label = label + '/' + only;
      } else break;
    }
    const child = subtree(rels, p, byRel);
    return { label, path: folderAbs(p, child), folders: child.folders, files: child.files };
  });
  const fileNodes = files.sort().map((rel) => byRel.get(rel) as TreeFile);
  return { folders, files: fileNodes };
}

function toEdit(session: string, rec: EditRecord): TreeEdit {
  const d = lineDelta(session, rec);
  return {
    id: rec.id, ts: rec.ts, tool: rec.tool, file: rec.file, status: rec.status,
    beforeBlob: rec.beforeBlob, afterBlob: rec.afterBlob, added: d.added, removed: d.removed,
  };
}

/** Group a file's edits under the class each currently falls in (line geometry from ranges.ts). */
function buildFile(session: string, rel: string, file: string, recs: EditRecord[]): TreeFile {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    /* file gone / unreadable — render flat */
  }
  const spans = text ? detectClasses(text) : [];
  if (spans.length === 0) {
    return { rel, file, classes: [], loose: recs.map((r) => toEdit(session, r)) };
  }
  const readText = (sha: string | null): string => {
    if (!sha) return '';
    try {
      return readBlob(session, sha).toString('utf8');
    } catch {
      return '';
    }
  };
  const byClass = new Map<string, TreeClass>();
  const loose: TreeEdit[] = [];
  // One hash per FILE (not per edit) identifies the current text for the memo below.
  const textKey = `${text.length}:${crypto.createHash('sha1').update(text).digest('hex').slice(0, 16)}`;
  // `recs` arrive in log order (reviewEdits walks the log), i.e. chronological — which is what keeps
  // each composed hop one edit wide. Out-of-order input would still be correct, only slower.
  const lines = locateCached(textKey, recs, readText, text);
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const line = lines[i];
    const cls = line !== undefined ? classAt(spans, line) : null;
    if (cls) {
      const key = `${cls.name}@${cls.start}`;
      if (!byClass.has(key)) byClass.set(key, { name: cls.name, edits: [] });
      byClass.get(key)!.edits.push(toEdit(session, r));
    } else {
      loose.push(toEdit(session, r));
    }
  }
  return { rel, file, classes: [...byClass.values()], loose };
}

/**
 * Build the full edit tree for a session.
 * - `root`: workspace root, used to compute display-relative paths (defaults to the raw absolute path).
 * - `filter`: optional Search filter (matched against the relative path).
 */
/** Memo for the per-FILE placement pass, keyed by (current file text, the file's whole edit chain).
 *
 *  Placing a file's edits composes the edit chain in ONE backwards pass (see locateEditsInCurrent), so
 *  the unit worth caching is the FILE, not the edit — one entry now covers every edit in it. All inputs
 *  are content-identified (blobs are immutable; the file text is hashed once per file), so a hit is
 *  exact: when the file on disk changes, or any edit in the chain does, the key changes with it. */
const lineMemo = new Map<string, (number | undefined)[]>();
const LINE_MEMO_CAP = 2000; // one entry per FILE now, not per edit

function locateCached(textKey: string, recs: EditRecord[], readText: (sha: string | null) => string, text: string): (number | undefined)[] {
  // The chain is HASHED, not concatenated: at 82 chars per edit the raw key was 91% of the entry, so a
  // full memo of 2,000 files at 500 edits each retained 86 MB (7.7 MB hashed) in a long-lived host.
  const chain = crypto
    .createHash('sha1')
    .update(recs.map((r) => `${r.beforeBlob ?? ''}:${r.afterBlob ?? ''}`).join(','))
    .digest('hex')
    .slice(0, 16);
  const key = `${textKey} ${recs.length}:${chain}`;
  const hit = lineMemo.get(key);
  if (hit) return hit;
  // Blob reads only on a miss, and PULLED one at a time — materialising every snapshot up front held
  // the file's whole history resident.
  const lines = locateEditsInCurrent(
    recs.length,
    (i) => ({ before: readText(recs[i].beforeBlob), after: readText(recs[i].afterBlob) }),
    text
  ).map((p) => p.lines[0]);
  if (lineMemo.size >= LINE_MEMO_CAP) lineMemo.clear();
  lineMemo.set(key, lines);
  return lines;
}


export function buildEditTree(session: string, opts: { root?: string; filter?: string } = {}): EditTree {
  const log = readLog(session);
  const filter = opts.filter || '';
  const relOf = (file: string): string => {
    const r = opts.root ? path.relative(opts.root, file) : file;
    return r.split(path.sep).join('/');
  };
  // Collapse same-code pending edits into one review unit (shared with the CLI `list`).
  const display = reviewEdits(session);
  const grouped = new Map<string, { file: string; edits: EditRecord[] }>();
  for (const rec of display) {
    const rel = relOf(rec.file);
    if (filter && !matchesQuery(rel, filter)) continue;
    if (!grouped.has(rel)) grouped.set(rel, { file: rec.file, edits: [] });
    grouped.get(rel)!.edits.push(rec);
  }
  const byRel = new Map<string, TreeFile>();
  for (const [rel, g] of grouped) byRel.set(rel, buildFile(session, rel, g.file, g.edits));
  return subtree([...grouped.keys()], '', byRel);
}
