/**
 * Claude Observatory — VS Code front-end.
 *
 * A sidebar over the SAME git-free store the CLI uses (~/.claude/claude-observatory/<session>/), so
 * undo/keep in either surface show up in the other. Reads the store + drives the shared surgical
 * undo engine from @claude-observatory/core. Capture itself is done by the hooks — this is review UI.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as https from 'https';
import * as os from 'os';
import * as core from '@claude-observatory/core';

const SCHEME = 'claude-edit'; // in-memory before/after blobs for vscode.diff

// Claude's signature marker color for the overview ruler — a distinct coral so Claude's edits are
// recognizable at a glance and don't blend into VCS (green/blue/red) gutter markers.
const CLAUDE_MARK_COLOR = 'rgba(204, 120, 92, 0.85)';
// Toned-down whole-line tints for the inline overlay — low alpha so a file Claude edited heavily
// doesn't drown in color, but the changed lines are still visible (green added, red removed).
const ADDED_LINE_BG = 'rgba(88, 166, 100, 0.10)';
const REMOVED_LINE_BG = 'rgba(229, 83, 75, 0.10)';

// --- inline (in-editor) overlay state ---
let inlineDecoration: vscode.TextEditorDecorationType | undefined; // gutter change-bar on changed lines
let deletionGhostDecoration: vscode.TextEditorDecorationType | undefined; // red "ghost" text showing removed lines
let annotationDecoration: vscode.TextEditorDecorationType | undefined; // right-side per-edit annotation
let heatmapDecoration: vscode.TextEditorDecorationType | undefined; // dims unmodified lines (spotlight edits)
let heatmapOn = false; // "file heatmap" toggle: dim everything except Claude's edited lines
let inlineLens: InlineLensProvider | undefined; // clickable Keep/Undo/Diff above each pending edit
const MAX_INLINE_LINES = 20000; // skip the overlay on very large files (perf)

type FolderNode = { kind: 'folder'; label: string; path: string; folders: core.TreeFolder[]; files: core.TreeFile[] };
type FileNode = { kind: 'file'; file: string; edits: core.TreeEdit[]; classes: core.TreeClass[]; loose: core.TreeEdit[] };
type ClassNode = { kind: 'class'; file: string; name: string; edits: core.TreeEdit[] };
type EditNode = { kind: 'edit'; rec: core.EditRecord; feed?: boolean }; // feed = top-level Timeline row (show file + time)
type TlRunNode = { kind: 'tlrun'; file: string; edits: core.EditRecord[] }; // Timeline run: adjacent same-file edits
type Node = FolderNode | FileNode | ClassNode | EditNode | TlRunNode;

// Active "Search edits" filter — matches on workspace-relative path; empty = show everything.
// Module-level so the Edits and Diffs trees filter together (parity with the JetBrains service filter).
let editFilter = '';

// Map the shared core view-model nodes to VS Code tree nodes. The tree STRUCTURE (folder compaction,
// class grouping, deltas, Search filtering) is computed once in core.buildEditTree — these just wrap it.
function toFolderNode(f: core.TreeFolder): FolderNode {
  return { kind: 'folder', label: f.label, path: f.path, folders: f.folders, files: f.files };
}
function toFileNode(f: core.TreeFile): FileNode {
  return { kind: 'file', file: f.file, edits: [...f.classes.flatMap((c) => c.edits), ...f.loose], classes: f.classes, loose: f.loose };
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The session the observatory shows: a pinned `claudeObservatory.session` override if set, else the
 *  newest Claude Code session for this workspace (mangled-path resolution lives in core). */
function currentSession(): string | undefined {
  const pinned = vscode.workspace.getConfiguration('claudeObservatory').get<string>('session', '').trim();
  if (pinned) return pinned;
  const root = workspaceRoot();
  return root ? core.resolveSessionId(root) ?? undefined : undefined;
}

// --- session-scoped, SELF-VALIDATING caches ------------------------------------------------------
// Tree renders used to re-read log.jsonl at ~9 call sites and re-parse the session transcript (15MB
// ≈ 38ms) per NODE. These caches key every result on the source file's (mtimeMs, size), so a cache
// hit costs one stat() instead of a parse, and staleness is impossible by construction.

function fileKey(p: string): string {
  try {
    const st = fs.statSync(p);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}
function logPath(session: string): string {
  return path.join(core.storeDir(session), 'log.jsonl');
}

const logCache = new Map<string, { key: string; log: core.EditRecord[] }>();
/** readLog, memoized on log.jsonl's mtime+size. */
function cachedLog(session: string): core.EditRecord[] {
  const key = fileKey(logPath(session));
  const hit = logCache.get(session);
  if (hit && hit.key === key) return hit.log;
  const log = core.readLog(session);
  logCache.set(session, { key, log });
  return log;
}

interface TranscriptCacheEntry {
  key: string;
  reasoning: Map<number, string>;
  insights: core.TranscriptInsights;
}
const transcriptCache = new Map<string, TranscriptCacheEntry>();
/** reasoningByEdit + transcriptInsights, memoized on the transcript AND log files (correlation uses both). */
function cachedTranscript(cwd: string, session: string): TranscriptCacheEntry {
  const t = core.findTranscript(cwd, session);
  const key = `${t ? fileKey(t) : 'none'}|${fileKey(logPath(session))}`;
  const hit = transcriptCache.get(session);
  if (hit && hit.key === key) return hit;
  const entry: TranscriptCacheEntry = {
    key,
    reasoning: core.reasoningByEdit(cwd, session),
    insights: core.transcriptInsights(cwd, session),
  };
  transcriptCache.set(session, entry);
  return entry;
}

const deltaCache = new Map<string, { added: number; removed: number }>(); // an edit's delta never changes
function cachedDelta(session: string, rec: core.EditRecord): { added: number; removed: number } {
  const k = `${session}:${rec.id}`;
  let v = deltaCache.get(k);
  if (!v) {
    v = core.lineDelta(session, rec);
    if (deltaCache.size >= 2000) deltaCache.delete(deltaCache.keys().next().value!);
    deltaCache.set(k, v);
  }
  return v;
}

const blobCache = new Map<string, string>(); // content-addressed → immutable; bounded FIFO
function cachedBlob(session: string, sha: string | null): string {
  if (!sha) return '';
  const k = `${session}:${sha}`;
  let v = blobCache.get(k);
  if (v === undefined) {
    try {
      v = core.readBlob(session, sha).toString('utf8');
    } catch {
      v = '';
    }
    if (blobCache.size >= 500) blobCache.delete(blobCache.keys().next().value!);
    blobCache.set(k, v);
  }
  return v;
}

function statusIcon(status: string): vscode.ThemeIcon {
  if (status === 'kept') return new vscode.ThemeIcon('check', new vscode.ThemeColor('charts.green'));
  // 'circle-slash' (⊘) reads clearly as "reverted"; 'discard' (↩) looked like an undo *action*.
  if (status === 'undone')
    return new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('descriptionForeground'));
  return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
}

/** Aggregate status icon for a file row: pending if any await review, else kept, else reverted. */
function aggregateIcon(edits: core.EditRecord[]): vscode.ThemeIcon {
  if (edits.some((e) => e.status === 'pending')) return statusIcon('pending');
  if (edits.some((e) => e.status === 'kept')) return statusIcon('kept');
  return statusIcon('undone');
}

function shortId(session: string): string {
  return session.length > 8 ? session.slice(0, 8) : session;
}

/** Strike through text for reverted edits (combining long-stroke overlay — TreeItem has no strikethrough). */
function strike(s: string): string {
  return Array.from(s).map((c) => c + '̶').join('');
}

/** Synthetic per-edit URI so the FileDecorationProvider can grey kept/undone rows in every view. */
function editItemUri(rec: core.EditRecord): vscode.Uri {
  return vscode.Uri.from({ scheme: 'claude-change', path: `/${rec.id}`, query: `status=${rec.status}` });
}

/** Greys out kept + reverted edit rows across all three views (pending rows stay normal). */
class StatusDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _e = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this._e.event;
  refresh(): void {
    this._e.fire(undefined);
  }
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'claude-change') return undefined;
    const status = new URLSearchParams(uri.query).get('status');
    if (status === 'kept') return { color: new vscode.ThemeColor('disabledForeground'), tooltip: 'kept' };
    if (status === 'undone') return { color: new vscode.ThemeColor('disabledForeground'), tooltip: 'reverted' };
    return undefined; // pending -> normal
  }
}
const statusDecorations = new StatusDecorationProvider();

class EditsProvider implements vscode.TreeDataProvider<Node> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  view?: vscode.TreeView<Node>;

  // 'edits' → click opens the file at that edit; 'diffs' → before↔after diff; 'timeline' → flat, newest-first.
  constructor(private readonly mode: 'edits' | 'diffs' | 'timeline') {}

  refresh(): void {
    this._changed.fire();
    this.updateBadge();
  }

  /** Reflect pending count as an activity-bar badge and the session id in the view description. */
  updateBadge(): void {
    if (!this.view) return;
    const session = currentSession();
    const pending = session
      ? cachedLog(session).filter((r) => r.status === 'pending').length
      : 0;
    this.view.badge = pending
      ? { value: pending, tooltip: `${pending} pending Claude edit${pending === 1 ? '' : 's'} to review` }
      : undefined;
    const base = session ? `session ${shortId(session)}` : undefined;
    // Timeline isn't filtered by Search, so only the Edits/Diffs views advertise the active filter.
    const showFilter = editFilter && this.mode !== 'timeline';
    this.view.description = showFilter ? `🔍 ${editFilter}${base ? ` · ${base}` : ''}` : base;
  }

  getChildren(node?: Node): Node[] {
    const session = currentSession();
    if (!session) return [];
    // Timeline: a newest-first change feed. Adjacent edits to the SAME file coalesce into one run
    // (collapsible ×N); lone edits are shown directly. Chronological, grouped, summarized.
    if (this.mode === 'timeline') {
      if (!node) {
        const log = cachedLog(session).slice().sort((a, b) => b.ts - a.ts); // newest first
        const feed: Node[] = [];
        for (let i = 0; i < log.length; ) {
          let j = i + 1;
          while (j < log.length && log[j].file === log[i].file) j++; // maximal same-file run
          const run = log.slice(i, j);
          feed.push(run.length === 1 ? { kind: 'edit', rec: run[0], feed: true } : { kind: 'tlrun', file: run[0].file, edits: run });
          i = j;
        }
        return feed;
      }
      if (node.kind === 'tlrun') return node.edits.map((rec) => ({ kind: 'edit', rec }));
      return [];
    }
    // edits/diffs: folder → file → (class → edits) + loose edits, from the shared core view-model.
    if (!node) {
      const tree = core.buildEditTree(session, { root: workspaceRoot(), filter: editFilter });
      return [...tree.folders.map(toFolderNode), ...tree.files.map(toFileNode)];
    }
    if (node.kind === 'folder') return [...node.folders.map(toFolderNode), ...node.files.map(toFileNode)];
    if (node.kind === 'file')
      return [
        ...node.classes.map((c): ClassNode => ({ kind: 'class', file: node.file, name: c.name, edits: c.edits })),
        ...node.loose.map((rec): EditNode => ({ kind: 'edit', rec })),
      ];
    if (node.kind === 'class') return node.edits.map((rec): EditNode => ({ kind: 'edit', rec }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = vscode.ThemeIcon.Folder;
      item.contextValue = 'folder';
      return item;
    }
    if (node.kind === 'class') {
      const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon('symbol-class');
      const pending = node.edits.filter((e) => e.status === 'pending').length;
      item.description = `${node.edits.length} edit${node.edits.length === 1 ? '' : 's'}${pending ? ` · ${pending} pending` : ''}`;
      item.tooltip = `class ${node.name} · ${path.basename(node.file)}`;
      item.contextValue = 'class';
      return item;
    }
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(path.basename(node.file), vscode.TreeItemCollapsibleState.Expanded);
      const n = node.edits.length;
      const pending = node.edits.filter((e) => e.status === 'pending').length;
      item.description = `${n} edit${n === 1 ? '' : 's'}${pending ? ` · ${pending} pending` : ''}`;
      item.iconPath = vscode.ThemeIcon.File;
      item.tooltip = node.file;
      item.contextValue = 'file';
      item.resourceUri = vscode.Uri.file(node.file);
      item.command = { command: 'claudeObservatory.openFile', title: 'Open File', arguments: [node] };
      return item;
    }
    // Timeline run: adjacent same-file edits collapsed into one row (×N + combined delta + summary).
    if (node.kind === 'tlrun') {
      const session = currentSession();
      const cwd = workspaceRoot();
      const newest = node.edits[0];
      const d = new Date(newest.ts);
      const hhmm = [d.getHours(), d.getMinutes()].map((x) => String(x).padStart(2, '0')).join(':');
      let added = 0;
      let removed = 0;
      if (session)
        for (const e of node.edits) {
          const dd = cachedDelta(session, e);
          added += dd.added;
          removed += dd.removed;
        }
      const reasoning = cwd && session ? cachedTranscript(cwd, session).reasoning.get(newest.id) : undefined;
      const summary = reasoning ? firstLine(reasoning) : session ? core.summarize(session, newest) : '';
      const item = new vscode.TreeItem(
        `${hhmm}  ${path.basename(node.file)}  ×${node.edits.length}`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.description = `+${added} −${removed}${summary ? ` · ${summary}` : ''}`;
      item.tooltip = `${node.file}\n${node.edits.length} edits · +${added} −${removed}${reasoning ? `\n\n${reasoning}` : ''}`;
      item.iconPath = aggregateIcon(node.edits);
      item.contextValue = 'file'; // reuse the file-scoped Keep-all / Undo-all / Open-file actions
      item.resourceUri = vscode.Uri.file(node.file);
      return item;
    }
    const rec = node.rec;
    const session = currentSession();
    const { added, removed } = session
      ? cachedDelta(session, rec)
      : { added: 0, removed: 0 };

    // Timeline change-feed row. Top-level (feed) rows lead with `HH:MM file`; run children lead with
    // `#id` and carry the time in the description. Both show `+a −b · <summary>`.
    if (this.mode === 'timeline') {
      const d = new Date(rec.ts);
      const hhmm = [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
      const cwd = workspaceRoot();
      const reasoning = cwd && session ? cachedTranscript(cwd, session).reasoning.get(rec.id) : undefined;
      const summary = reasoning ? firstLine(reasoning) : session ? core.summarize(session, rec) : '';
      const isFeed = node.feed === true;
      let label = isFeed ? `${hhmm}  ${path.basename(rec.file)}` : `#${rec.id}`;
      if (rec.status === 'undone') label = strike(label);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      const timePart = isFeed ? '' : `${hhmm} · `; // run children lead with #id, so put their time here
      item.description = `${timePart}+${added} −${removed}${summary ? ` · ${summary}` : ''}`;
      item.tooltip = `${rec.file}\n${rec.tool} · ${rec.status} · +${added} −${removed} · ${d.toLocaleTimeString()}${reasoning ? `\n\n${reasoning}` : ''}`;
      item.contextValue = rec.status === 'undone' ? 'editUndone' : 'edit';
      item.iconPath = statusIcon(rec.status);
      item.resourceUri = editItemUri(rec); // greys kept/undone via StatusDecorationProvider
      item.command = { command: 'claudeObservatory.openFileAtEdit', title: 'Open File at Edit', arguments: [node] };
      return item;
    }

    // Edits / Diffs: lead with the edit id + line delta (no timestamp — that lives in Timeline).
    let label = `#${rec.id}  +${added} −${removed}`;
    if (rec.status === 'undone') label = strike(label); // cross out reverted edits
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `${rec.status} · ${rec.tool}`;
    item.tooltip = `${rec.file}\n${rec.tool} · ${rec.status}`;
    // Undone edits offer Redo; live (pending/kept) edits offer Keep/Undo.
    item.contextValue = rec.status === 'undone' ? 'editUndone' : 'edit';
    item.iconPath = statusIcon(rec.status);
    item.resourceUri = editItemUri(rec); // greys kept/undone via StatusDecorationProvider
    item.command =
      this.mode === 'diffs'
        ? { command: 'claudeObservatory.openDiff', title: 'Open Diff', arguments: [node] }
        : { command: 'claudeObservatory.openFileAtEdit', title: 'Open File at Edit', arguments: [node] };
    return item;
  }
}

class BlobContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = new URLSearchParams(uri.query);
    const session = q.get('s') || '';
    const blob = q.get('b') || 'empty';
    if (blob === 'empty') return '';
    try {
      return core.readBlob(session, blob).toString('utf8');
    } catch {
      return '';
    }
  }
}

// Git's own theme variables, exactly as the diff editor uses them. VS Code's markdown sanitizer allows
// style ONLY on <span>, ONLY `color;background-color;border-radius` in that order, hex or var(--vscode-*),
// and NO space after the colons — anything else silently strips the whole attribute (verified against the
// shipped workbench source; GitLens colors its +/− stats with these same vars).
const DIFF_SPAN: Record<string, string> = {
  '+': 'color:var(--vscode-gitDecoration-addedResourceForeground);background-color:var(--vscode-diffEditor-insertedTextBackground);',
  '-': 'color:var(--vscode-gitDecoration-deletedResourceForeground);background-color:var(--vscode-diffEditor-removedTextBackground);',
  '@': 'color:var(--vscode-descriptionForeground);',
};

/** A unified patch as sanitizer-safe HTML with git's diff colors: green/red text on the diff editor's
 *  translucent line fills. Lines are nbsp-padded to a common width so the fills read as full rows. */
function diffHtml(patch: string): string {
  const all = patch.split('\n');
  const start = all.findIndex((l) => l.startsWith('@@'));
  const lines = (start >= 0 ? all.slice(start) : all).join('\n').trimEnd().split('\n');
  const width = Math.min(100, Math.max(...lines.map((l) => l.length), 0) + 2);
  const html = lines.map((line) => {
    const text = (line.length < width ? line + ' '.repeat(width - line.length) : line)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/ /g, ' '); // HTML collapses runs of plain spaces — keep indentation + row padding
    const style = DIFF_SPAN[line[0] ?? ''];
    return style ? `<span style="${style}">${text}</span>` : text;
  });
  return `<code>${html.join('<br>')}</code>`;
}

/** An inline review bubble at an edit, built on the Comment API (the built-in dirty-diff peek is a closed
 *  widget: no custom buttons, broken nav). The body carries the edit header + reasoning + the diff in
 *  git's colors (see diffHtml); Accept / Revert / Chat / Prev / Next are real toolbar buttons via the
 *  comments/commentThread/title menu. Prev/Next steps through the same file's pending edits. */
class EditPeek implements vscode.Disposable {
  private readonly controller = vscode.comments.createCommentController('claudeObservatory', 'Claude Observatory');
  private thread: vscode.CommentThread | undefined;
  private edit: { id: number; file: string } | undefined;

  constructor() {
    // No user "add comment" affordance — we only place review threads programmatically.
    this.controller.commentingRangeProvider = { provideCommentingRanges: () => [] };
  }

  /** Open (or move) the bubble to edit `id`. */
  async show(id: number): Promise<void> {
    const session = currentSession();
    const rec = session ? core.findRecord(session, id) : null;
    if (!session || !rec) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rec.file));
    const editor = await vscode.window.showTextDocument(doc);
    const p = cachedPlacements(session, doc).find((pl) => pl.rec.id === id);
    const line = p ? Math.min(anchorLines(p)[0] ?? 0, Math.max(0, doc.lineCount - 1)) : 0;
    const range = new vscode.Range(line, 0, line, 0);
    this.closeThread();

    const cwd = workspaceRoot();
    const why = cwd ? cachedTranscript(cwd, session).reasoning.get(id)?.trim() : undefined;
    const d = cachedDelta(session, rec);
    const md = new vscode.MarkdownString();
    md.supportHtml = true; // the colored <span>s below survive the sanitizer only with this on
    md.isTrusted = true;
    md.appendMarkdown(`**✨ Claude edit #${id}**  ·  \`+${d.added} −${d.removed}\`  ·  ${rec.tool}\n\n`);
    if (why) md.appendMarkdown(`💭 ${firstLine(why)}\n\n`);
    let patch = '';
    try {
      patch = core.coloredDiff(session, rec, false);
    } catch {
      patch = '';
    }
    md.appendMarkdown(diffHtml(patch));

    const comment: vscode.Comment = { body: md, mode: vscode.CommentMode.Preview, author: { name: 'Claude Observatory' } };
    const thread = this.controller.createCommentThread(doc.uri, range, [comment]);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = false;
    thread.contextValue = 'claudeEdit';
    thread.label = `Claude edit #${id}  ·  +${d.added} −${d.removed}`;
    this.thread = thread;
    this.edit = { id, file: rec.file };
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }

  keep(): void {
    const s = currentSession();
    if (this.edit && s) {
      core.keepGroup(s, this.edit.id); // keep the whole same-code review unit
      this.closeThread();
    }
  }

  async undo(): Promise<void> {
    const s = currentSession();
    if (this.edit && s) {
      await undoOne(s, this.edit.id);
      this.closeThread();
    }
  }

  chat(): void {
    if (this.edit) void vscode.commands.executeCommand('claudeObservatory.chatEdit', this.edit.id);
  }

  /** Step to the prev (-1) / next (+1) pending edit in the same file, wrapping at the ends. */
  step(dir: 1 | -1): Promise<void> {
    const s = currentSession();
    if (!this.edit || !s) return Promise.resolve();
    const file = this.edit.file;
    const list = cachedLog(s).filter((r) => r.file === file && r.status === 'pending').sort((a, b) => a.id - b.id);
    if (list.length === 0) return Promise.resolve();
    const idx = list.findIndex((r) => r.id === this.edit!.id);
    const target = list[((idx < 0 ? 0 : idx) + dir + list.length) % list.length];
    return this.show(target.id);
  }

  private closeThread(): void {
    this.thread?.dispose();
    this.thread = undefined;
    this.edit = undefined;
  }

  dispose(): void {
    this.closeThread();
    this.controller.dispose();
  }
}

/** URI for one side of a diff. Path carries the real basename so VS Code picks the language mode;
 *  the optional editId rides in the query so the diff's title-bar actions can resolve their edit. */
function blobUri(session: string, sha: string | null, file: string, side: string, editId?: number): vscode.Uri {
  const q = `s=${encodeURIComponent(session)}&b=${encodeURIComponent(sha ?? 'empty')}` + (editId != null ? `&e=${editId}` : '');
  return vscode.Uri.from({ scheme: SCHEME, path: `/${side}/${path.basename(file)}`, query: q });
}

/** The edit id encoded in a claude-edit diff URI (the diff title-bar Keep/Undo/Chat commands get this URI). */
function editIdFromUri(uri: vscode.Uri | undefined): number | undefined {
  if (!uri || uri.scheme !== SCHEME) return undefined;
  const e = new URLSearchParams(uri.query).get('e');
  return e ? Number(e) : undefined;
}

async function openDiff(node: EditNode): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const rec = node.rec;
  // Edit id on BOTH sides so the diff's title-bar commands resolve it whichever side VS Code hands them.
  const left = blobUri(session, rec.beforeBlob, rec.file, 'before', rec.id);
  const right = blobUri(session, rec.afterBlob, rec.file, 'after', rec.id);
  // Claude's reasoning rides in the diff title (VS Code truncates long titles, but shows what fits).
  const cwd = workspaceRoot();
  const why = cwd ? cachedTranscript(cwd, session).reasoning.get(rec.id)?.trim() : undefined;
  const head = why ? firstLine(why) : '';
  const short = head.length > 80 ? head.slice(0, 79) + '…' : head;
  const title = short ? `#${rec.id} · ${short}` : `${path.basename(rec.file)} · edit #${rec.id}`;
  // preview:false → the diff always gets its OWN tab instead of taking over the file's preview tab.
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false });
  await applyInlineDiff();
}

/** GitLens-style unified inline diff: when enabled and the user's diff editor defaults to side-by-side,
 *  flip THIS freshly opened diff to the inline (red/green single-column) view. Uses VS Code's built-in
 *  per-editor toggle — internal + best-effort, so a missing command degrades to the global setting. */
async function applyInlineDiff(): Promise<void> {
  const on = vscode.workspace.getConfiguration('claudeObservatory').get<boolean>('inlineDiffView', true);
  if (!on) return;
  const sideBySide = vscode.workspace.getConfiguration('diffEditor').get<boolean>('renderSideBySide', true);
  if (!sideBySide) return; // already inline globally — nothing to flip
  try {
    await vscode.commands.executeCommand('toggle.diff.editorMode');
  } catch {
    /* internal command, absent on some builds — fall back to the user's global diff setting */
  }
}

/** Diff title-bar Prev/Next: from the edit id in the active diff's URI, step to the prev (-1) / next (+1)
 *  pending edit in the same file (wrapping at the ends). Cycles IN PLACE: opens the target's diff, then
 *  closes the diff tab the click came from — one diff tab no matter how far you step. */
async function stepDiffEdit(uri: vscode.Uri | undefined, dir: 1 | -1): Promise<void> {
  const s = currentSession();
  const id = editIdFromUri(uri);
  const rec = s && id != null ? core.findRecord(s, id) : null;
  if (!s || !rec) return;
  const list = cachedLog(s).filter((r) => r.file === rec.file && r.status === 'pending').sort((a, b) => a.id - b.id);
  if (!list.length) return;
  const idx = list.findIndex((r) => r.id === id);
  const prev = vscode.window.tabGroups?.activeTabGroup?.activeTab;
  await openDiff({ kind: 'edit', rec: list[((idx < 0 ? 0 : idx) + dir + list.length) % list.length] });
  const input = prev?.input as { modified?: vscode.Uri } | undefined;
  if (prev && input?.modified?.scheme === SCHEME) void vscode.window.tabGroups.close(prev);
}

// --- revision navigation: step a file's edit history in a current-vs-revision diff ---
const revisionCursor = new Map<string, number>(); // file fsPath -> edit id the current-vs-revision diff is parked on
let revisionFile: string | undefined; // file being stepped (survives focus landing on the diff's left pane)

/** LEFT = the full-file state EDIT produced (its afterBlob, served by BlobContentProvider); RIGHT = the
 *  live editable current file. `preview:true` reuses one diff tab across steps. */
async function openRevisionDiff(session: string, edit: core.EditRecord): Promise<void> {
  const left = blobUri(session, edit.afterBlob, edit.file, `rev-${edit.id}`);
  const right = vscode.Uri.file(edit.file);
  await vscode.commands.executeCommand('vscode.diff', left, right, `edit #${edit.id} ⟶ (this file)`, { preview: true });
}

/** Step the active file's edit revisions (dir +1 newer / -1 older), parking a per-file cursor and
 *  opening a current-vs-revision diff. Clamps at both ends — history is finite (no wrap). */
const diffRevisionStep = async (dir: 1 | -1): Promise<void> => {
  const s = currentSession();
  if (!s) return;
  const active = vscode.window.activeTextEditor?.document.uri;
  const file = active?.scheme === 'file' ? active.fsPath : revisionFile; // keep target while the diff pane is focused
  if (!file) {
    vscode.window.setStatusBarMessage('Claude Observatory: open a file Claude edited to step its revisions', 3000);
    return;
  }
  revisionFile = file;
  const edits = cachedLog(s).filter((r) => r.file === file).sort((a, b) => a.id - b.id);
  if (edits.length === 0) {
    vscode.window.setStatusBarMessage('Claude Observatory: no Claude edits recorded for this file', 3000);
    return;
  }
  const cur = revisionCursor.get(file);
  const base = cur === undefined ? edits.length : edits.findIndex((e) => e.id === cur); // undefined = parked "at current"
  const idx = Math.min(Math.max(base + dir, 0), edits.length - 1);
  const target = edits[idx];
  if (cur !== undefined && target.id === cur) {
    vscode.window.setStatusBarMessage(
      dir === 1 ? 'Claude Observatory: already at the latest revision' : 'Claude Observatory: already at the first revision',
      2500
    );
  }
  revisionCursor.set(file, target.id);
  await openRevisionDiff(s, target);
};

/** Open the file and scroll to where this edit currently sits, so the inline overlay is what you see. */
async function openFileAtEdit(node: EditNode): Promise<void> {
  const rec = node.rec;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rec.file));
  const editor = await vscode.window.showTextDocument(doc);
  const session = currentSession();
  if (!session) return;
  const before = rec.beforeBlob ? core.readBlob(session, rec.beforeBlob).toString('utf8') : '';
  const after = rec.afterBlob ? core.readBlob(session, rec.afterBlob).toString('utf8') : '';
  // Prefer the added/changed lines; for a pure deletion (none) fall back to its deletion anchor so the
  // cursor still lands on the ghost text (mirrors anchorLines used by the decorations/CodeLens/hover).
  const lines = core.locateEditInCurrent(before, after, doc.getText());
  const targets = lines.length
    ? lines
    : core.locateDeletionsInCurrent(before, after, doc.getText()).map((d) => d.anchor);
  if (targets.length) {
    const pos = new vscode.Position(Math.min(targets[0], Math.max(0, doc.lineCount - 1)), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

/** True (and warns) if the file is open with unsaved edits — undoing writes to disk and would
 * either compute against stale content or be clobbered when the user next saves the buffer. */
async function blockedByDirtyBuffer(file: string): Promise<boolean> {
  const dirty = vscode.workspace.textDocuments.some((d) => d.uri.fsPath === file && d.isDirty);
  if (dirty) {
    await vscode.window.showWarningMessage(
      `${path.basename(file)} has unsaved changes — save or revert it first. Claude Observatory undoes by writing to disk.`,
      { modal: true }
    );
  }
  return dirty;
}

async function undoOne(session: string, id: number): Promise<void> {
  const rec = core.findRecord(session, id);
  if (rec && (await blockedByDirtyBuffer(rec.file))) return;
  const res = core.undoGroup(session, id); // reverts the whole same-code review unit (collapsed group)
  if (res.status === 'conflict') {
    const pick = await vscode.window.showWarningMessage(res.message, { modal: true }, 'Force-restore file');
    if (pick === 'Force-restore file') {
      const r2 = core.restoreFile(session, id);
      vscode.window.showInformationMessage(r2.message);
    }
    return;
  }
  vscode.window.showInformationMessage(res.message);
}

async function redoOne(session: string, id: number): Promise<void> {
  const rec = core.findRecord(session, id);
  if (rec && (await blockedByDirtyBuffer(rec.file))) return;
  const res = core.redoGroup(session, id); // re-applies the whole review unit (collapsed group)
  if (res.status === 'conflict') {
    const pick = await vscode.window.showWarningMessage(res.message, { modal: true }, 'Force re-apply');
    if (pick === 'Force re-apply') {
      const r2 = core.reapplyFile(session, id);
      vscode.window.showInformationMessage(r2.message);
    }
    return;
  }
  vscode.window.showInformationMessage(res.message);
}

/** Build a prompt about one edit, copy it to the clipboard, and open the Claude sidebar chat. */
async function chatAboutEdit(session: string, id: number): Promise<void> {
  const rec = core.findRecord(session, id);
  if (!rec) return;
  const before = rec.beforeBlob ? core.readBlob(session, rec.beforeBlob).toString('utf8') : '(new file)';
  const after = rec.afterBlob ? core.readBlob(session, rec.afterBlob).toString('utf8') : '(deleted)';
  const rel = vscode.workspace.asRelativePath(rec.file);
  const prompt =
    `I'm reviewing a change Claude Code made to \`${rel}\` (edit #${rec.id}, ${rec.tool}).\n\n` +
    `--- before ---\n${before}\n--- after ---\n${after}\n\n` +
    `Please explain what this change does and whether it looks correct.`;
  await vscode.env.clipboard.writeText(prompt);
  for (const cmd of ['claude-vscode.sidebar.open', 'claude-vscode.focus']) {
    try {
      await vscode.commands.executeCommand(cmd);
    } catch {
      /* Claude Code extension not present — the prompt is still on the clipboard */
    }
  }
  vscode.window.showInformationMessage(
    `Prompt about edit #${rec.id} copied — paste (⌘V) into Claude to discuss it.`
  );
}

/** Keep every pending edit in one file (shared by keepFile and keepOpenFile). Reads the RAW log so it
 *  covers every member of a collapsed review group, not just the reps the tree renders. */
function keepEditsInFile(session: string, file: string, _edits: core.EditRecord[]): void {
  let kept = 0;
  for (const e of core.readLog(session)) {
    if (e.file === file && e.status === 'pending') {
      core.setStatus(session, e.id, 'kept');
      kept++;
    }
  }
  vscode.window.showInformationMessage(
    kept ? `Kept ${kept} edit(s) in ${path.basename(file)}.` : 'No pending edits to keep in this file.'
  );
}

/** Surgically undo every PENDING edit in one file, newest-first, after a confirm + dirty-buffer
 *  guard (shared by undoFile and undoOpenFile). Accepted edits are left on disk — revert individually. */
async function undoEditsInFile(session: string, file: string, _edits: core.EditRecord[]): Promise<void> {
  // Raw log (not the collapsed reps) so we undo every member of a review group in the file, newest-first.
  const targets = core.readLog(session).filter((e) => e.file === file && e.status === 'pending').sort((a, b) => b.id - a.id);
  const base = path.basename(file);
  if (targets.length === 0) {
    vscode.window.showInformationMessage(`Nothing to undo in ${base}.`);
    return;
  }
  if (await blockedByDirtyBuffer(file)) return;
  const choice = await vscode.window.showWarningMessage(
    `Undo ${targets.length} edit(s) in ${base}? Later-overlapping edits may conflict.`,
    { modal: true },
    'Undo all'
  );
  if (choice !== 'Undo all') return;
  const res = core.undoScope(session, { under: file });
  vscode.window.showInformationMessage(
    `Undid ${res.undone} edit(s) in ${base}` +
      (res.conflicts ? ` · ${res.conflicts} conflict(s) left — undo individually to force-restore` : '') +
      '.'
  );
}

/** Accept (keep) every pending edit at-or-beneath a file/folder path — the scoped Accept action. */
function keepEditsUnder(session: string, scope: string, label: string): void {
  const targets = core.readLog(session).filter((r) => r.status === 'pending' && core.isUnderPath(r.file, scope));
  for (const r of targets) core.setStatus(session, r.id, 'kept');
  vscode.window.showInformationMessage(
    targets.length ? `Accepted ${targets.length} edit(s) in ${label}.` : `No pending edits to accept in ${label}.`
  );
}

/** Revert every PENDING edit at-or-beneath a path, newest-first, after a confirm + dirty-buffer
 *  guard (raw log, so every member of a review group in scope is undone). Accepted edits are left on
 *  disk — revert individually. */
async function undoEditsUnder(session: string, scope: string, label: string): Promise<void> {
  const targets = core
    .readLog(session)
    .filter((r) => r.status === 'pending' && core.isUnderPath(r.file, scope))
    .sort((a, b) => b.id - a.id);
  if (targets.length === 0) {
    vscode.window.showInformationMessage(`Nothing to revert in ${label}.`);
    return;
  }
  const dirty = [...new Set(targets.map((t) => t.file))].filter((f) =>
    vscode.workspace.textDocuments.some((d) => d.uri.fsPath === f && d.isDirty)
  );
  if (dirty.length) {
    await vscode.window.showWarningMessage(
      `Save or revert unsaved changes first: ${dirty.map((f) => path.basename(f)).join(', ')}.`,
      { modal: true }
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Revert ${targets.length} edit(s) in ${label}? Overlapping edits may conflict.`,
    { modal: true },
    'Revert all'
  );
  if (choice !== 'Revert all') return;
  const res = core.undoScope(session, { under: scope });
  vscode.window.showInformationMessage(
    `Reverted ${res.undone} edit(s) in ${label}` +
      (res.conflicts ? ` · ${res.conflicts} conflict(s) left (revert individually to force)` : '') +
      '.'
  );
}

/** Clear resolved (kept/undone) edits at-or-beneath a path — the scoped Clear action. */
function clearResolvedUnder(session: string, scope: string, label: string): void {
  const n = core.clearResolved(session, scope);
  vscode.window.showInformationMessage(
    n ? `Cleared ${n} resolved edit(s) in ${label}.` : `No resolved edits to clear in ${label}.`
  );
}

function keepAllSession(session: string): void {
  let n = 0;
  for (const r of core.readLog(session)) if (r.status === 'pending') { core.setStatus(session, r.id, 'kept'); n++; }
  vscode.window.showInformationMessage(n ? `Accepted ${n} edit(s).` : 'No pending edits to accept.');
}

async function undoAllSession(session: string): Promise<void> {
  const targets = core.readLog(session).filter((r) => r.status === 'pending').sort((a, b) => b.id - a.id);
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Nothing to revert.');
    return;
  }
  const dirty = [...new Set(targets.map((t) => t.file))].filter((f) =>
    vscode.workspace.textDocuments.some((d) => d.uri.fsPath === f && d.isDirty)
  );
  if (dirty.length) {
    await vscode.window.showWarningMessage(
      `Save or revert unsaved changes first: ${dirty.map((f) => path.basename(f)).join(', ')}.`,
      { modal: true }
    );
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `Revert all ${targets.length} edit(s) in this session? Overlapping edits may conflict.`,
    { modal: true },
    'Revert all'
  );
  if (choice !== 'Revert all') return;
  const res = core.undoScope(session);
  vscode.window.showInformationMessage(
    `Reverted ${res.undone} edit(s)` +
      (res.conflicts ? ` · ${res.conflicts} conflict(s) left (revert individually to force)` : '') +
      '.'
  );
}

/** Install the capture hooks into ~/.claude/settings.json (portable command), then offer a reload. */
function installHooksFromExtension(): void {
  try {
    const res = core.installHooks(`claude-observatory capture #${core.HOOK_MARKER}`);
    if (!res.changed) {
      vscode.window.showInformationMessage('Claude Observatory: capture hooks are already installed.');
      return;
    }
    vscode.window
      .showInformationMessage(
        'Claude Observatory: capture hooks installed. Reload the window so Claude Code picks them up.',
        'Reload Window'
      )
      .then((s) => {
        if (s === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
  } catch (e) {
    vscode.window.showErrorMessage(
      `Could not install hooks: ${String((e as Error)?.message || e)}. Run \`claude-observatory init\` in a terminal instead.`
    );
  }
}

function showSetup(): void {
  vscode.window
    .showInformationMessage(
      "Claude Observatory: capture hooks are not installed, so Claude's edits aren't being tracked. Install them (then reload).",
      'Install hooks',
      'Copy command'
    )
    .then((sel) => {
      if (sel === 'Install hooks') installHooksFromExtension();
      else if (sel === 'Copy command') vscode.env.clipboard.writeText('claude-observatory init');
    });
}

// --- inline overlay: gutter change-bars + right-side per-edit annotations with hover actions ---

function inlineEnabled(): boolean {
  return vscode.workspace.getConfiguration('claudeObservatory').get<boolean>('inlineReview', true);
}

interface Placement {
  rec: core.EditRecord;
  lines: number[]; // current line indices this edit occupies (empty if later fully rewritten)
  removed: core.Deletion[]; // removed hunks shown as red ghost text on their anchor line
}

/** The line to hang this edit's ✨ annotation / Keep·Undo actions on: its first changed line, or —
 *  for a pure deletion that occupies no line — the line beside its deletion ghost text. */
function anchorLines(p: Placement): number[] {
  return p.lines.length ? p.lines : p.removed.map((r) => r.anchor);
}

/** Every still-PENDING edit for `file`, with the current line indices it occupies. */
function placementsFor(session: string, file: string, text: string): Placement[] {
  const out: Placement[] = [];
  for (const rec of cachedLog(session)) {
    if (rec.file !== file || rec.status !== 'pending') continue;
    const before = cachedBlob(session, rec.beforeBlob);
    const after = cachedBlob(session, rec.afterBlob);
    out.push({
      rec,
      lines: core.locateEditInCurrent(before, after, text),
      removed: core.locateDeletionsInCurrent(before, after, text),
    });
  }
  return out;
}

/** placementsFor memoized per document version + log state — decorations, CodeLens, and hovers all
 *  ask for the same placements in the same tick; the diff work runs once instead of three times. */
const placementsCache = new Map<string, { key: string; p: Placement[] }>();
function cachedPlacements(session: string, doc: vscode.TextDocument): Placement[] {
  const file = doc.uri.fsPath;
  const key = `${doc.version}:${fileKey(logPath(session))}`;
  const hit = placementsCache.get(file);
  if (hit && hit.key === key) return hit.p;
  const p = placementsFor(session, file, doc.getText());
  if (placementsCache.size >= 50) placementsCache.delete(placementsCache.keys().next().value!);
  placementsCache.set(file, { key, p });
  return p;
}

/** The pending edit whose lines contain the active editor's cursor (for the keyboard review loop). */
function pendingAtCursor(session: string): core.EditRecord | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return undefined;
  const line = editor.selection.active.line;
  return cachedPlacements(session, editor.document).find((p) => anchorLines(p).includes(line))?.rec;
}

/** A one-line red-ghost preview of removed lines: first non-blank line (trimmed, truncated), with a
 *  "…(+N)" tail when the hunk removed more than one line — VS Code can't render multi-line ghost text. */
function ghostText(lines: string[]): string {
  const head = (lines.find((l) => l.trim()) ?? '').trim();
  const shown = head.length > 60 ? head.slice(0, 59) + '…' : head;
  const more = lines.length - 1;
  return more > 0 ? `− ${shown} …(+${more})` : `− ${shown}`;
}

function decorateEditor(editor: vscode.TextEditor): void {
  if (!inlineDecoration || !annotationDecoration || !deletionGhostDecoration) return;
  const doc = editor.document;
  const session = currentSession();
  if (!inlineEnabled() || !session || doc.lineCount > MAX_INLINE_LINES) {
    editor.setDecorations(inlineDecoration, []);
    editor.setDecorations(deletionGhostDecoration, []);
    editor.setDecorations(annotationDecoration, []);
    if (heatmapDecoration) editor.setDecorations(heatmapDecoration, []);
    return;
  }
  const placements = cachedPlacements(session, doc);

  // green change-bar on every pending added/changed line
  const gutter: vscode.Range[] = [];
  const seen = new Set<number>();
  for (const p of placements) {
    for (const ln of p.lines) {
      if (ln < doc.lineCount && !seen.has(ln)) {
        seen.add(ln);
        gutter.push(doc.lineAt(ln).range);
      }
    }
  }
  editor.setDecorations(inlineDecoration, gutter);

  // removed lines shown as red "ghost" text after the surviving line they now sit on; hunks that
  // resolve to the same line merge onto one label.
  const lastLine = Math.max(0, doc.lineCount - 1);
  const ghostByLine = new Map<number, string[]>();
  for (const p of placements) {
    for (const del of p.removed) {
      const line = Math.min(del.anchor, lastLine);
      const acc = ghostByLine.get(line);
      if (acc) acc.push(ghostText(del.lines));
      else ghostByLine.set(line, [ghostText(del.lines)]);
    }
  }
  const ghosts: vscode.DecorationOptions[] = [];
  for (const [line, labels] of ghostByLine) {
    const eol = doc.lineAt(line).range.end;
    ghosts.push({
      range: new vscode.Range(eol, eol),
      renderOptions: {
        after: {
          contentText: labels.join('   '),
          color: new vscode.ThemeColor('gitDecoration.deletedResourceForeground'),
          fontStyle: 'italic',
          margin: '0 0 0 2ch',
        },
      },
    });
  }
  editor.setDecorations(deletionGhostDecoration, ghosts);

  // ✨ gutter icon at the START (first line) of each edit — the "Claude edited here" marker.
  const maxLine = Math.max(0, doc.lineCount - 1);
  const starLines: vscode.Range[] = [];
  const seenStar = new Set<number>();
  for (const p of placements) {
    const anchors = anchorLines(p);
    if (!anchors.length) continue;
    const first = Math.min(anchors[0], maxLine);
    if (!seenStar.has(first)) {
      seenStar.add(first);
      starLines.push(new vscode.Range(first, 0, first, 0));
    }
  }
  editor.setDecorations(annotationDecoration, starLines);

  // Heatmap / spotlight: dim every unmodified line so Claude's edited lines stand out. The "changed"
  // set is the added/changed lines (seen) plus the deletion-anchor lines.
  if (heatmapDecoration) {
    if (heatmapOn && (seen.size > 0 || ghostByLine.size > 0)) {
      const changed = new Set<number>(seen);
      for (const ln of ghostByLine.keys()) changed.add(ln);
      const dim: vscode.Range[] = [];
      let runStart = -1;
      for (let ln = 0; ln < doc.lineCount; ln++) {
        if (!changed.has(ln)) {
          if (runStart === -1) runStart = ln;
        } else if (runStart !== -1) {
          dim.push(new vscode.Range(runStart, 0, ln - 1, doc.lineAt(ln - 1).range.end.character));
          runStart = -1;
        }
      }
      if (runStart !== -1) {
        dim.push(new vscode.Range(runStart, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).range.end.character));
      }
      editor.setDecorations(heatmapDecoration, dim);
    } else {
      editor.setDecorations(heatmapDecoration, []);
    }
  }
}

/** The inline menu above each pending edit: "✨ #N +A −R view changes" (opens the inline review bubble) ·
 *  ✓ Keep · ↩ Undo · 💬 Chat · ⧉ View diff (the same edit as a full diff tab). The CodeLens is the
 *  always-visible quick surface; the bubble (EditPeek) is the on-demand review widget (git-colored diff +
 *  reasoning, Accept/Revert/Chat/Prev/Next toolbar). */
class InlineLensProvider implements vscode.CodeLensProvider {
  private readonly _c = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._c.event;
  refresh(): void {
    this._c.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!inlineEnabled()) return [];
    const session = currentSession();
    if (!session || doc.lineCount > MAX_INLINE_LINES) return [];
    // Only the LATEST edit per anchor line gets an inline lens: several edits often land on one line
    // (a hunk edited twice), and stacking a menu per edit is noisy + ambiguous. Undoing the latest
    // surgically reveals the previous state (its lens then takes over); the full per-edit sequence for
    // a line lives in the Timeline. Keeps the inline surface to one clear action-row per line.
    const byLine = new Map<number, { rec: core.EditRecord; added: number; removed: number }>();
    for (const p of cachedPlacements(session, doc)) {
      const anchors = anchorLines(p);
      if (anchors.length === 0) continue; // later fully rewritten - no anchor line
      const line = Math.min(anchors[0], Math.max(0, doc.lineCount - 1));
      const cur = byLine.get(line);
      if (!cur || p.rec.id > cur.rec.id) {
        const d = cachedDelta(session, p.rec);
        byLine.set(line, { rec: p.rec, added: d.added, removed: d.removed });
      }
    }
    const lenses: vscode.CodeLens[] = [];
    for (const [line, g] of byLine) {
      const range = new vscode.Range(line, 0, line, 0);
      const id = g.rec.id;
      // "view changes" opens the review bubble (reasoning rides there); per-edit keep/undo is also on
      // ⌥⌘Y / ⌥⌘U and the Edits tree.
      lenses.push(new vscode.CodeLens(range, { title: `✨ #${id}  +${g.added} −${g.removed}  view changes`, command: 'claudeObservatory.viewChanges', arguments: [id] }));
      lenses.push(new vscode.CodeLens(range, { title: `✓ Keep`, command: 'claudeObservatory.inlineKeep', arguments: [id] }));
      lenses.push(new vscode.CodeLens(range, { title: `↩ Undo`, command: 'claudeObservatory.inlineUndo', arguments: [id] }));
      lenses.push(new vscode.CodeLens(range, { title: `💬 Chat`, command: 'claudeObservatory.chatEdit', arguments: [id] }));
      lenses.push(new vscode.CodeLens(range, { title: `⧉ View diff`, command: 'claudeObservatory.openDiff', arguments: [{ kind: 'edit', rec: g.rec }] }));
    }
    return lenses;
  }
}

function refreshInline(): void {
  for (const ed of vscode.window.visibleTextEditors) decorateEditor(ed);
  inlineLens?.refresh();
}

// --- Observations + Suggestions tabs (reasoning from transcript + heuristics; opt-in claude -p) ---

const MD_SCHEME = 'claude-observation'; // virtual markdown docs

// One "Insights" view (was two): a "Next steps" group (heuristic suggestions + opt-in Claude) and an
// "Observations" group (one row per edit — reasoning surfaced inline, click opens the combined report).
type ObsNode =
  | { kind: 'recap' }
  | { kind: 'obs'; rec: core.EditRecord }
  | { kind: 'steps' }
  | { kind: 'suggestion'; text: string };

function firstLine(s: string): string {
  const l = s.split('\n').find((x) => x.trim()) ?? '';
  return l.length > 100 ? l.slice(0, 99) + '…' : l;
}

class ObservationsProvider implements vscode.TreeDataProvider<ObsNode> {
  private readonly _c = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._c.event;
  refresh(): void {
    this._c.fire();
  }
  // Per-file review memory (cross-session), recomputed lazily each refresh cycle.
  private memo = new Map<string, core.FileMemory>();
  private mem(file: string): core.FileMemory {
    let m = this.memo.get(file);
    if (!m) {
      m = core.fileMemory(file);
      this.memo.set(file, m);
    }
    return m;
  }
  getChildren(node?: ObsNode): ObsNode[] {
    const session = currentSession();
    if (!session || node) return [];
    this.memo.clear(); // one memory computation per file per render cycle
    // A one-line "what were you doing" recap on top, then one observation row per edit (newest first),
    // then a "Next steps" group (Claude's open to-dos + heuristics) — parity with the CLI `insights`
    // view and the JetBrains Observations panel.
    const cwd = workspaceRoot();
    const suggestions = [
      ...new Set([...(cwd ? core.transcriptSuggestions(cwd, session) : []), ...core.heuristicSuggestions(session)]),
    ];
    return [
      { kind: 'recap' },
      ...cachedLog(session).slice().sort((a, b) => b.ts - a.ts).map((rec) => ({ kind: 'obs' as const, rec })),
      ...(suggestions.length
        ? [{ kind: 'steps' as const }, ...suggestions.map((text) => ({ kind: 'suggestion' as const, text }))]
        : []),
    ];
  }
  /** Zero-token: Claude Code's own session title, or a Claude-refined recap once generated. */
  private recapText(): string {
    const session = currentSession();
    const cwd = workspaceRoot();
    const generated = session ? core.cachedAnalysis(session, 'recap')?.text : undefined;
    const title = cwd && session ? cachedTranscript(cwd, session).insights.title : null;
    return (generated || title || 'No recap yet — hit ✨ to generate one.').trim();
  }
  getTreeItem(node: ObsNode): vscode.TreeItem {
    const session = currentSession();
    const cwd = workspaceRoot();
    if (node.kind === 'recap') {
      // One clean line (the panel is wide; VS Code ellipsizes gracefully) with the full text on hover.
      const text = this.recapText().replace(/\s+/g, ' ');
      const item = new vscode.TreeItem(text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('compass', new vscode.ThemeColor('charts.blue'));
      item.description = 'session recap';
      const tip = new vscode.MarkdownString(
        `**Session recap**\n\n${this.recapText()}\n\n---\n\n_✨ refreshes this with a Claude-generated "what you did + where you left off" one-liner._`
      );
      item.tooltip = tip;
      item.contextValue = 'recap';
      return item; // refresh is the ✨ button (inline + view title), not a click
    }
    if (node.kind === 'steps') {
      const item = new vscode.TreeItem('Next steps', vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('lightbulb');
      item.description = "Claude's to-dos + heuristics";
      item.contextValue = 'steps';
      item.command = { command: 'claudeObservatory.showSuggestions', title: 'Suggestions' };
      return item;
    }
    if (node.kind === 'suggestion') {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('arrow-small-right');
      item.tooltip = node.text;
      item.command = { command: 'claudeObservatory.showSuggestions', title: 'Suggestions' };
      return item;
    }
    // One row per edit; click opens the single combined report (summary + reasoning + flags + analysis).
    const rec = node.rec;
    const flags = session ? core.flagsFor(session, rec, cachedLog(session)) : [];
    const reasoning = cwd && session ? cachedTranscript(cwd, session).reasoning.get(rec.id) : undefined;
    // Cross-session memory: this file's review track record sharpens the observation over time.
    const mem = this.mem(rec.file);
    const risky = core.isRiskyFile(mem);
    const history = core.memorySummary(mem);
    const warn = risky || flags.some((f) => f.level === 'warn');
    const item = new vscode.TreeItem(`#${rec.id}  ${session ? core.summarize(session, rec) : ''}`, vscode.TreeItemCollapsibleState.None);
    item.description = reasoning ? firstLine(reasoning) : flags.length ? `${flags.length} flag${flags.length === 1 ? '' : 's'}` : '';
    item.iconPath = new vscode.ThemeIcon(warn ? 'warning' : 'eye', warn ? new vscode.ThemeColor('charts.yellow') : undefined);
    item.tooltip = [
      reasoning ? `💭 ${reasoning}` : '',
      ...flags.map((f) => `${f.level === 'warn' ? '⚠' : 'ℹ'} ${f.message}`),
      risky ? `⚠ history: edits to this file get reverted often (${mem.undone} of ${mem.kept + mem.undone} verdicts) — review carefully` : '',
      history ? `🧠 ${history}` : '',
      'Click to open the full report.',
    ]
      .filter(Boolean)
      .join('\n');
    item.command = { command: 'claudeObservatory.showObservation', title: 'Observation', arguments: [rec.id] };
    item.contextValue = 'observation';
    item.resourceUri = editItemUri(rec); // grey kept/undone observations, matching the other views
    return item;
  }
}

/** Serves the readonly markdown docs for observations + suggestions from the store. */
class ObservationMarkdownProvider implements vscode.TextDocumentContentProvider {
  private readonly _c = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._c.event;
  bump(uri: vscode.Uri): void {
    this._c.fire(uri);
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    const q = new URLSearchParams(uri.query);
    const session = q.get('s') || '';
    const cwd = q.get('cwd') || '';
    if (uri.authority === 'sug') {
      const todos = cwd ? core.transcriptSuggestions(cwd, session) : [];
      let md = `# Suggestions\n\n`;
      if (todos.length) md += `## From Claude's notes (this session)\n\n` + todos.map((s) => `- ${s}`).join('\n') + `\n\n`;
      md += `## Heuristic next steps\n\n` + core.heuristicSuggestions(session).map((s) => `- ${s}`).join('\n');
      const a = core.cachedAnalysis(session, 'suggestions');
      md += a ? `\n\n## Generated by Claude\n\n${a.text}\n` : `\n\n_Ask Claude for a deeper, grounded list — it reuses this session's cached context._\n`;
      return md;
    }
    const id = parseInt((uri.path.match(/edit-(\d+)/) || [])[1] || '0', 10);
    const rec = core.findRecord(session, id);
    if (!rec) return '(edit not found)';
    let md = `# Edit #${id} — ${path.basename(rec.file)}\n\n**Summary:** ${core.summarize(session, rec)}\n`;
    const reasoning = cwd ? core.reasoningByEdit(cwd, session).get(id) : undefined;
    if (reasoning) md += `\n## Claude's reasoning\n\n${reasoning}\n`;
    const flags = core.flagsFor(session, rec);
    if (flags.length) md += `\n## Flags\n\n` + flags.map((f) => `- ${f.level === 'warn' ? '⚠️' : 'ℹ️'} ${f.message}`).join('\n') + '\n';
    // What the observatory remembers about this file from every past session (zero-token).
    const mem = core.fileMemory(rec.file);
    const history = core.memorySummary(mem);
    if (history) {
      md += `\n## File history (all sessions)\n\n- ${history}\n`;
      if (core.isRiskyFile(mem)) md += `- ⚠️ edits to this file get reverted often (${mem.undone} of ${mem.kept + mem.undone} verdicts) — review carefully\n`;
      if (mem.notes.length) md += mem.notes.map((n) => `- 🧠 prior analysis: ${n.text}`).join('\n') + '\n';
    }
    const a = core.cachedAnalysis(session, `edit-${id}`);
    md += a ? `\n## Deep analysis (Claude)\n\n${a.text}\n` : `\n_Run “Analyze with Claude” for a deeper look._\n`;
    return md;
  }
}
const obsMd = new ObservationMarkdownProvider();

function obsUri(kind: 'obs' | 'sug', file: string, session: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: MD_SCHEME,
    authority: kind,
    path: `/${file}`,
    query: `s=${encodeURIComponent(session)}&cwd=${encodeURIComponent(workspaceRoot() || '')}`,
  });
}
async function showObservationDoc(id: number): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const uri = obsUri('obs', `edit-${id}.md`, session);
  obsMd.bump(uri);
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}
async function showSuggestionsDoc(): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const uri = obsUri('sug', 'suggestions.md', session);
  obsMd.bump(uri);
  await vscode.commands.executeCommand('markdown.showPreview', uri);
}

// --- Combined Stats + Usage tab: multi-series edits/tokens plots on top, usage bars at the bottom ---
// Scanning ~GBs of transcripts would block the UI, so the scan runs in a subprocess (the CLI `stats`
// command, which maintains an incremental mtime cache) and this view just renders the JSON it returns.

/** The globally-installed `claude-observatory` bin, resolved via core's shared candidate list. */
function resolveObservatoryBin(): string {
  return core.resolveBin('claude-observatory', { env: 'CLAUDE_OBSERVATORY_BIN' });
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** The combined Stats + Usage webview. Rendered ONCE; the provider pushes the review counts, the stats
 *  series, and the usage snapshot via postMessage (no reload → no flash, toggle state preserved). Layout:
 *  live review scoreboard (pending/accepted/reverted + progress bar) on top, then the range toggle + Tokens
 *  step-line plot, then a "Usage" section (ctx / 5h / week) below. */
function combinedShell(): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const PLOTS = [
    { id: 'tokens', name: 'Tokens', scale: 'log', series: [['tokensTotal', 'total', 'var(--c-total)'], ['tokensInput', 'input', 'var(--c-input)'], ['tokensOutput', 'output', 'var(--c-output)']] },
  ];
  const style = `<style>
  :root { --acc: var(--vscode-charts-blue, #4c8bf5); --c-pending: var(--vscode-charts-yellow, #d9a441); --c-kept: var(--vscode-charts-green, #3fb950); --c-reverted: var(--vscode-descriptionForeground, #9aa0aa); --c-total: var(--vscode-charts-blue, #4c8bf5); --c-input: var(--vscode-charts-purple, #9a6ac2); --c-output: var(--vscode-charts-orange, #c9713f); }
  body { margin:0; padding:8px 12px 12px; font-family: var(--vscode-font-family); font-size:11px; color: var(--vscode-foreground); position:relative; }
  .dim { opacity:.75; }
  .empty { padding:12px 2px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  .review { margin-bottom:14px; }
  .rvcounts { display:flex; gap:6px; margin-bottom:9px; }
  .rvc { flex:1; text-align:center; padding:7px 3px; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:6px; }
  .rvn { display:block; font-size:19px; font-weight:600; font-variant-numeric:tabular-nums; line-height:1.05; }
  .rvl { display:block; font-size:9px; text-transform:uppercase; letter-spacing:0.07em; color: var(--vscode-descriptionForeground); margin-top:3px; }
  .rvbar { height:6px; border-radius:3px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.2)); overflow:hidden; }
  .rvfill { display:block; height:100%; width:0; border-radius:3px; background: var(--acc); transition: width .3s ease; }
  .rvmeta { display:flex; justify-content:space-between; font-size:9.5px; color: var(--vscode-descriptionForeground); margin-top:5px; font-variant-numeric:tabular-nums; }
  .ranges { display:flex; margin-bottom:12px; border:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); border-radius:6px; overflow:hidden; }
  .seg { flex:1; background:transparent; color: var(--vscode-descriptionForeground); border:0; border-right:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); padding:4px 0; font-size:10px; font-family:inherit; cursor:pointer; letter-spacing:0.03em; }
  .seg:last-child { border-right:0; }
  .seg.on { background: var(--acc); color: var(--vscode-editor-background, #1e1e1e); font-weight:600; }
  .plot { margin-bottom:18px; }
  .phead { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px; }
  .pname { font-family: var(--vscode-editor-font-family, monospace); text-transform:uppercase; letter-spacing:0.1em; font-size:10px; color: var(--vscode-descriptionForeground); }
  .legend { display:flex; gap:9px; flex-wrap:wrap; }
  .lg { display:inline-flex; align-items:center; gap:4px; font-size:9.5px; color: var(--vscode-descriptionForeground); }
  .lg .sw { width:9px; height:2.5px; border-radius:1px; }
  .pbody { position:relative; padding-left:34px; }
  .chart { width:100%; height:46px; display:block; overflow:visible; }
  .chart .ln { fill:none; stroke-width:1.6; vector-effect:non-scaling-stroke; stroke-linejoin:round; }
  .chart .base { stroke: var(--vscode-widget-border, rgba(127,127,127,0.35)); stroke-width:1; vector-effect:non-scaling-stroke; }
  .chart .cross { stroke: var(--vscode-foreground); stroke-width:1; vector-effect:non-scaling-stroke; }
  .yt { position:absolute; left:0; width:30px; text-align:right; font-size:8.5px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; transform:translateY(-50%); line-height:1; white-space:nowrap; }
  .pax { display:flex; justify-content:space-between; font-size:9px; color: var(--vscode-descriptionForeground); margin:3px 0 0 34px; font-variant-numeric: tabular-nums; }
  .divider { border-top:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); margin:2px 0 10px; }
  .uhead { font-family: var(--vscode-editor-font-family, monospace); text-transform:uppercase; letter-spacing:0.1em; font-size:10px; color: var(--vscode-descriptionForeground); margin-bottom:6px; }
  .row { display:flex; align-items:center; gap:8px; height:20px; font-family: var(--vscode-editor-font-family, monospace); }
  .lbl { width:22px; color: var(--vscode-descriptionForeground); }
  .track { flex:1; height:5px; border-radius:3px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.2)); overflow:hidden; }
  .fill { display:block; height:100%; border-radius:3px; width:0; }
  .pct { width:34px; text-align:right; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  .sub { min-width:58px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .tip { position:absolute; pointer-events:none; opacity:0; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, #ccc); border:1px solid var(--vscode-editorHoverWidget-border, rgba(127,127,127,0.3)); border-radius:4px; padding:2px 7px; font-size:10px; font-variant-numeric: tabular-nums; white-space:nowrap; transform:translateY(-100%); z-index:5; }
</style>`;
  const plotsHtml = PLOTS.map(
    (p) =>
      `<div class="plot"><div class="phead"><span class="pname">${p.name}</span><div class="legend">` +
      p.series.map((sr) => `<span class="lg"><span class="sw" style="background:${sr[2]}"></span>${sr[1]}</span>`).join('') +
      `</div></div><div class="pbody" id="b-${p.id}"></div><div class="pax" id="x-${p.id}"></div></div>`
  ).join('');
  const usageHtml =
    `<div class="uhead">Usage</div>` +
    ['ctx', '5h', 'wk']
      .map((l) => `<div class="row"><span class="lbl">${l}</span><span class="track"><span class="fill" id="uf-${l}"></span></span><span class="pct" id="up-${l}">—</span><span class="sub" id="us-${l}"></span></div>`)
      .join('') +
    `<div id="uhint" class="empty" style="display:none">5h / week plan usage needs <b>claude-statusline</b> writing on this host.<br><span class="dim">run <b>claude-observatory statusline</b> (bundled — no download), then start a Claude session.</span></div>` +
    `<div id="ustale" class="empty" style="display:none">5h / week last refreshed <b><span id="ustale-age"></span> ago</b> — keep an idle <b>claude</b> terminal open (it refreshes every ~60s).<br><span class="dim">Plan usage comes only from Claude's own status line — account-wide limits the panel can't fetch itself. ctx stays live from the transcript.</span></div>`;
  const script = `
    const vscode = acquireVsCodeApi();
    const PLOTS = ${JSON.stringify(PLOTS)};
    var STATS = null;
    let range = ((vscode.getState()||{}).range) || 'week';
    function human(n){ if(n<1000)return String(n); var v,suf; if(n<1e6){v=n/1e3;suf='k';}else if(n<1e9){v=n/1e6;suf='M';}else{v=n/1e9;suf='B';} var s=v.toFixed(v<10?1:0); if(s.slice(-2)==='.0')s=s.slice(0,-2); return s+suf; }
    function ymap(v,max,scale,H){ if(scale==='log'){ var lm=Math.log(Math.max(2,max)); return v<1 ? H : H - Math.log(v)/lm*(H-3); } return H - (max>0? v/max : 0)*(H-3); }
    function yticks(max,scale){ if(scale==='log'){ var top=Math.floor(Math.log(Math.max(1,max))/Math.LN10); var stride=Math.max(1,Math.ceil((top+1)/4)); var ts=[]; for(var e=top; e>=0; e-=stride) ts.push(Math.pow(10,e)); return ts; } var t=[]; if(max>0){ t.push(max); if(max>=4){ var h=Math.round(max/2); if(h>0&&h<max) t.push(h); } } return t; }
    function renderPlot(p){
      var series=(STATS&&STATS[range])||[], labels=series.map(function(d){return d.label;}), n=series.length;
      var W=100,H=46,max=1;
      p.series.forEach(function(sr){ series.forEach(function(d){ if(d[sr[0]]>max) max=d[sr[0]]; }); });
      var paths=''; p.series.forEach(function(sr){ var d=''; for(var i=0;i<n;i++){ var y=ymap(series[i][sr[0]],max,p.scale,H).toFixed(2); var x0=(i*W/n).toFixed(2),x1=((i+1)*W/n).toFixed(2); d+=(i===0?('M'+x0+','+y):('L'+x0+','+y))+'L'+x1+','+y; } paths+='<path d="'+d+'" class="ln" style="stroke:'+sr[2]+'"/>'; });
      var svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" class="chart"><line class="base" x1="0" y1="'+H+'" x2="'+W+'" y2="'+H+'"/>'+paths+'<line class="cross" x1="0" y1="0" x2="0" y2="'+H+'" opacity="0"/><rect x="0" y="0" width="'+W+'" height="'+H+'" fill="transparent"/></svg>';
      var yl='', lastY=-99; yticks(max,p.scale).forEach(function(t){ var yy=ymap(t,max,p.scale,H); if(Math.abs(yy-lastY)<9) return; lastY=yy; yl+='<span class="yt" style="top:'+yy.toFixed(1)+'px">'+human(t)+'</span>'; });
      var body=document.getElementById('b-'+p.id); body.innerHTML=svg+yl;
      var m=Math.min(6,n), xs=''; for(var k=0;k<m;k++){ var idx=Math.round(k*(n-1)/Math.max(1,m-1)); xs+='<span>'+(labels[idx]||'')+'</span>'; }
      document.getElementById('x-'+p.id).innerHTML = n?xs:'';
      var svgEl=body.querySelector('svg'), cross=body.querySelector('.cross'), hit=body.querySelector('rect'), tip=document.getElementById('tip');
      hit.addEventListener('mousemove',function(e){ var r=svgEl.getBoundingClientRect(); var i=Math.floor((e.clientX-r.left)/r.width*n); i=Math.max(0,Math.min(n-1,i)); var cx=(i+0.5)/n*W; cross.setAttribute('x1',cx); cross.setAttribute('x2',cx); cross.setAttribute('opacity','0.5'); var parts=[labels[i]]; p.series.forEach(function(sr){ parts.push(sr[1]+' '+human(series[i][sr[0]])); }); var br=document.body.getBoundingClientRect(); tip.textContent=parts.join(' · '); tip.style.opacity='1'; tip.style.left=(e.clientX-br.left)+'px'; tip.style.top=(e.clientY-br.top-6)+'px'; });
      hit.addEventListener('mouseleave',function(){ cross.setAttribute('opacity','0'); document.getElementById('tip').style.opacity='0'; });
    }
    function drawStats(){ var segs=document.querySelectorAll('.seg'); for(var i=0;i<segs.length;i++) segs[i].classList.toggle('on', segs[i].getAttribute('data-r')===range); var g=document.getElementById('gathering'); if(g) g.style.display = STATS ? 'none' : 'block'; PLOTS.forEach(renderPlot); }
    function ucolor(p){ if(p>=80)return 'var(--vscode-charts-red,#e5534b)'; if(p>=50)return 'var(--vscode-charts-yellow,#d9a441)'; return 'var(--vscode-charts-green,#3fb950)'; }
    function until(ms){ if(ms==null)return ''; var d=ms-Date.now(); if(!isFinite(d)||d<=0)return ''; var mins=Math.round(d/60000),h=Math.floor(mins/60); if(h>=24)return Math.floor(h/24)+'d'+(h%24)+'h'; return h>0? h+'h'+(mins%60)+'m' : (mins%60)+'m'; }
    function setRow(l,pct,sub){ var f=document.getElementById('uf-'+l),p=document.getElementById('up-'+l),s=document.getElementById('us-'+l); if(pct==null){ f.style.width='0'; p.textContent='—'; p.style.color=''; s.textContent=''; return; } var c=ucolor(pct); f.style.width=Math.max(2,Math.min(100,pct))+'%'; f.style.background=c; p.textContent=Math.round(pct)+'%'; p.style.color=c; s.textContent=sub||''; }
    var STALE_MS = ${core.USAGE_STALE_MS};
    var LASTU = null;
    function ago(ms){ var m=Math.round(ms/60000); if(m<60)return m+'m'; var h=Math.floor(m/60); if(h<24)return h+'h'+(m%60? (m%60)+'m':''); return Math.floor(h/24)+'d'; }
    function renderUsage(u){ LASTU=u; var hint=document.getElementById('uhint'), stale=document.getElementById('ustale');
      if(!u){ setRow('ctx',null); setRow('5h',null); setRow('wk',null); if(hint) hint.style.display='none'; if(stale) stale.style.display='none'; return; }
      // Only the terminal TUI runs the statusLine, so panel-only sessions leave the 5h/wk cache
      // stale: keep the last-known values but stamp their age instead of pretending they're live.
      var age = (u.statuslineCache && u.cachedAtMs!=null) ? Date.now()-u.cachedAtMs : null;
      var isStale = age!=null && age > STALE_MS;
      var mark = isStale ? ago(age)+' ago' : '';
      setRow('ctx', u.ctx? u.ctx.pct : null, u.ctx? (human(u.ctx.tokens)+'/'+human(u.ctx.size)) : '');
      setRow('5h', u.fiveHourPct, [until(u.fiveReset), u.fiveTokens? '~'+human(u.fiveTokens):'', mark].filter(Boolean).join(' · '));
      setRow('wk', u.weekPct, [until(u.weekReset), u.weekTokens? '~'+human(u.weekTokens):'', mark].filter(Boolean).join(' · '));
      // Only nudge when the statusline cache is truly absent — not on a fresh session whose rate_limits
      // haven't arrived yet (cache present, 5h/wk momentarily null), nor on non-subscription plans.
      if(hint) hint.style.display = u.statuslineCache ? 'none' : 'block';
      if(stale){ stale.style.display = isStale ? 'block' : 'none'; if(isStale) document.getElementById('ustale-age').textContent = ago(age); }
    }
    setInterval(function(){ if(LASTU) renderUsage(LASTU); }, 60000); // the "Xm ago" stamp ticks between posts
    function renderCounts(c){ if(!c) return;
      document.getElementById('rv-pending').textContent=c.pending;
      document.getElementById('rv-kept').textContent=c.kept;
      document.getElementById('rv-undone').textContent=c.undone;
      var reviewed=c.kept+c.undone, total=c.pending+reviewed, pct= total? Math.round(reviewed/total*100):0;
      var fill=document.getElementById('rv-fill'); fill.style.width=pct+'%';
      fill.style.background = pct>=100 ? 'var(--c-kept)' : 'var(--acc)';
      document.getElementById('rv-progress').textContent = total ? (reviewed+' of '+total+' reviewed ('+pct+'%)') : 'no edits yet';
      document.getElementById('rv-rate').textContent = reviewed ? (Math.round(c.kept/reviewed*100)+'% accepted') : '';
    }
    window.addEventListener('message', function(e){ var m=e.data||{};
      if(m.type==='usage'){ renderUsage(m.u); }
      else if(m.type==='counts'){ renderCounts(m.c); }
      else if(m.type==='stats'){ STATS=m.data; drawStats(); }
      else if(m.type==='statsError' && !STATS){ var g=document.getElementById('gathering'); if(g) g.innerHTML='⚠ stats need the <b>claude-observatory</b> CLI, which was not found.<br><span class="dim">install it with <b>./install.sh</b> (or <b>npm i -g ./packages/cli</b> from the repo), then reload.</span>'; }
    });
    (function(){ var segs=document.querySelectorAll('.seg'); for(var i=0;i<segs.length;i++){ segs[i].addEventListener('click',function(){ range=this.getAttribute('data-r'); vscode.setState({range:range}); drawStats(); }); } drawStats(); vscode.postMessage({type:'ready'}); })();
  `;
  // Live review scoreboard (independent of the time range): current pending/accepted/reverted counts
  // and a progress bar that fills as edits get reviewed — updated on every store change via postMessage.
  const reviewHtml =
    `<div class="review">` +
    `<div class="rvcounts">` +
    `<div class="rvc"><span class="rvn" id="rv-pending" style="color:var(--c-pending)">0</span><span class="rvl">pending</span></div>` +
    `<div class="rvc"><span class="rvn" id="rv-kept" style="color:var(--c-kept)">0</span><span class="rvl">accepted</span></div>` +
    `<div class="rvc"><span class="rvn" id="rv-undone" style="color:var(--c-reverted)">0</span><span class="rvl">reverted</span></div>` +
    `</div>` +
    `<div class="rvbar"><span class="rvfill" id="rv-fill"></span></div>` +
    `<div class="rvmeta"><span id="rv-progress">no edits yet</span><span id="rv-rate"></span></div>` +
    `</div>`;
  const body =
    reviewHtml +
    `<div class="divider"></div>` +
    `<div class="ranges"><button class="seg" data-r="today">Today</button><button class="seg" data-r="week">7 days</button><button class="seg" data-r="month">30 days</button></div>` +
    `<div id="gathering" class="empty">Gathering stats… <span class="dim">(first scan of your transcripts; cached after)</span></div>` +
    plotsHtml +
    `<div class="divider"></div>` +
    usageHtml +
    `<div class="tip" id="tip"></div>` +
    `<script nonce="${nonce}">${script}</script>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${style}</head><body>${body}</body></html>`;
}

/** Build the {today, week, month} series the webview plots from a StatsResult. */
function statsData(s: core.StatsResult): unknown {
  const dt = (d: string) => {
    const p = d.split('-');
    return `${+p[1]}/${+p[2]}`;
  };
  const bucket = (label: string, b: core.BucketStat) => ({
    label,
    editsPending: b.editsPending,
    editsKept: b.editsKept,
    editsUndone: b.editsUndone,
    tokensTotal: b.tokensInput + b.tokensOutput,
    tokensInput: b.tokensInput,
    tokensOutput: b.tokensOutput,
  });
  return {
    today: s.hourly.map((h) => bucket(`${h.hour}:00`, h)),
    week: s.daily.slice(-7).map((d) => bucket(dt(d.day), d)),
    month: s.daily.map((d) => bucket(dt(d.day), d)),
  };
}

/** File History: the ACTIVE editor's Claude edits, oldest→newest (id · time · status · reasoning).
 *  A flat chronological list — a different data model from the folder/class Edits tree — that follows
 *  the active editor. Reuses EditNode so every existing edit command works on its rows unchanged. */
class FileHistoryProvider implements vscode.TreeDataProvider<EditNode> {
  private readonly _changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._changed.event;
  view?: vscode.TreeView<EditNode>;

  refresh(): void {
    this._changed.fire();
    if (this.view) {
      const f = vscode.window.activeTextEditor?.document.uri.fsPath;
      this.view.description = f ? path.basename(f) : undefined; // name the file being followed
    }
  }

  getChildren(node?: EditNode): EditNode[] {
    if (node) return []; // flat list
    const session = currentSession();
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!session || !file) return [];
    // The store read-primitive: a file's edits = readLog filtered by absolute-path equality.
    return cachedLog(session)
      .filter((r) => r.file === file)
      .sort((a, b) => a.ts - b.ts || a.id - b.id) // chronological
      .map((rec): EditNode => ({ kind: 'edit', rec }));
  }

  getTreeItem(node: EditNode): vscode.TreeItem {
    const rec = node.rec;
    const session = currentSession();
    const cwd = workspaceRoot();
    const d = new Date(rec.ts);
    const hhmm = [d.getHours(), d.getMinutes()].map((x) => String(x).padStart(2, '0')).join(':');
    const reasoning = cwd && session ? cachedTranscript(cwd, session).reasoning.get(rec.id) : undefined;
    const summary = reasoning ? firstLine(reasoning) : session ? core.summarize(session, rec) : '';
    let label = `#${rec.id}  ${hhmm}`;
    if (rec.status === 'undone') label = strike(label);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = `${rec.status}${summary ? ` · ${summary}` : ''}`;
    item.tooltip = new vscode.MarkdownString(
      `**Edit #${rec.id}** · ${rec.tool} · ${rec.status} · ${d.toLocaleTimeString()}` +
        (reasoning ? `\n\n💭 ${reasoning}` : '')
    );
    item.iconPath = statusIcon(rec.status);
    item.contextValue = rec.status === 'undone' ? 'editUndone' : 'edit'; // reuse edit/editUndone menus
    item.resourceUri = editItemUri(rec); // greys kept/undone via StatusDecorationProvider
    item.command = { command: 'claudeObservatory.openFileAtEdit', title: 'Open File at Edit', arguments: [node] };
    return item;
  }
}

class StatsUsageViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private statsRun = 0;
  private statsRunning = false;
  private statsEverLoaded = false; // gates the "CLI missing" hint: only before the first good payload
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = combinedShell(); // set once; both sections update via postMessage (no flash)
    view.webview.onDidReceiveMessage((m: { type?: string }) => {
      if (m && m.type === 'ready') this.refresh();
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh();
    });
  }
  refresh(): void {
    this.postCounts();
    this.postUsage();
    this.refreshStats();
  }
  /** Cheap + sync: post the live review scoreboard (pending/accepted/reverted) for the counts + progress
   *  bar. Runs on every store change so the bar fills live as the user keeps/undoes edits. */
  private postCounts(): void {
    if (!this.view) return;
    const session = currentSession();
    const log = session ? cachedLog(session) : [];
    const c = {
      pending: log.filter((r) => r.status === 'pending').length,
      kept: log.filter((r) => r.status === 'kept').length,
      undone: log.filter((r) => r.status === 'undone').length,
    };
    this.view.webview.postMessage({ type: 'counts', c });
  }
  /** Cheap + sync: post the current usage snapshot for the bars. */
  private postUsage(): void {
    if (!this.view) return;
    const session = currentSession();
    const cwd = workspaceRoot();
    const u = session && cwd ? core.usageLine(cwd, session) : null;
    this.view.webview.postMessage({ type: 'usage', u });
  }
  /** Throttled subprocess scan (visible-only); posts the stats series when it returns. */
  private refreshStats(): void {
    if (!this.view?.visible) return;
    const now = Date.now();
    if (this.statsRunning || now - this.statsRun < 20000) return;
    this.statsRunning = true;
    this.statsRun = now;
    const args = ['stats', '--json'];
    const session = currentSession();
    if (session) args.push('--session', session);
    let child: cp.ChildProcess;
    try {
      // Windows: npm installs the CLI as a .cmd shim, which spawn() can't exec without a shell.
      const bin = resolveObservatoryBin();
      const winShell = process.platform === 'win32';
      child = cp.spawn(winShell ? `"${bin}"` : bin, args, {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: winShell,
      });
    } catch {
      this.statsRunning = false;
      this.postStatsError();
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => {
      this.statsRunning = false;
      this.postStatsError();
    });
    child.on('close', () => {
      this.statsRunning = false;
      let data: unknown;
      try {
        const s = JSON.parse(out) as core.StatsResult;
        // Guard against a foreign process answering to `claude-observatory` on PATH: any
        // valid-but-wrong JSON on stdout (e.g. a launch.json) would otherwise sail past the
        // parse and throw inside statsData() — an *unhandled* exception in this callback that
        // crashes the extension host and surfaces the raw payload. Require the StatsResult shape,
        // and build the series inside the try so any throw routes to the clean error hint.
        if (!s || !Array.isArray(s.daily) || !Array.isArray(s.hourly)) throw new Error('not a StatsResult');
        data = statsData(s);
      } catch {
        this.postStatsError();
        return;
      }
      this.statsEverLoaded = true;
      this.view?.webview.postMessage({ type: 'stats', data });
    });
  }
  /** The #1 teammate-onboarding trap: .vsix installed but the global CLI missing → the panel used to
   *  say "Gathering stats…" forever. Surface an actionable hint instead (only before first data). */
  private postStatsError(): void {
    if (!this.statsEverLoaded) this.view?.webview.postMessage({ type: 'statsError' });
  }
}

// --- marketplace-free update nudge -------------------------------------------------------------
// VS Code has no custom-repository / self-hosted auto-update mechanism (JetBrains does — this plugin
// ships an updatePlugins.xml repo). The closest equivalent is a throttled background check of GitHub
// Releases that points the user at the new .vsix. It never silent-installs and never nags on error.
const RELEASE_REPO = 'cell-observatory/claude-observatory';
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // at most once a day in the background

/** GET the latest-release JSON from GitHub. Rejects on any network/HTTP/parse error (no deps — the
 *  extension host is Node). GitHub requires a User-Agent. */
function fetchLatestRelease(): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
      { headers: { 'User-Agent': 'claude-observatory-vscode', Accept: 'application/vnd.github+json' } },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`github api ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

/** Download `url` (following redirects) to `dest`. Rejects on any non-200 / network error. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = (u: string, redirs: number): void => {
      https
        .get(u, { headers: { 'User-Agent': 'claude-observatory-vscode' } }, (res) => {
          const code = res.statusCode || 0;
          if (code >= 300 && code < 400 && res.headers.location && redirs > 0) {
            res.resume();
            return get(res.headers.location, redirs - 1);
          }
          if (code !== 200) {
            res.resume();
            return reject(new Error(`http ${code}`));
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    get(url, 5);
  });
}

/** Download the .vsix and install it via VS Code's own extension service (no `code` CLI needed — works
 *  regardless of PATH), then offer a window reload. Falls back to opening the download in a browser if
 *  anything fails. */
async function installVsixUpdate(url: string, latest: string): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Installing Claude Observatory ${latest}…` },
      async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-observatory-'));
        const dest = path.join(dir, `claude-observatory-${latest}.vsix`);
        await downloadFile(url, dest);
        // VS Code's built-in installer accepts a .vsix file Uri — no dependency on the `code` CLI.
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(dest));
      }
    );
    const reload = await vscode.window.showInformationMessage(
      `Claude Observatory ${latest} installed. Reload the window to activate it.`,
      'Reload Window'
    );
    if (reload === 'Reload Window') void vscode.commands.executeCommand('workbench.action.reloadWindow');
  } catch (e) {
    const pick = await vscode.window.showWarningMessage(
      `Couldn't auto-install the update (${String((e as Error)?.message || e)}). Download the .vsix instead?`,
      'Download .vsix'
    );
    if (pick === 'Download .vsix') void vscode.env.openExternal(vscode.Uri.parse(url));
  }
}

/** Compare the running extension version against the newest GitHub Release; if newer, offer to install
 *  the .vsix. `manual` = triggered from the command palette (report up-to-date / errors; ignore throttle
 *  + "skip this version"). */
async function checkForUpdate(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
  // `context.extension` is only present in a real extension host (absent under the smoke-test mock) —
  // bail before any network call if we can't read our own version.
  const current = context.extension?.packageJSON?.version ? String(context.extension.packageJSON.version) : undefined;
  if (!current) {
    if (manual) vscode.window.showWarningMessage('Claude Observatory: cannot determine the installed version.');
    return;
  }
  if (!manual) {
    const last = context.globalState.get<number>('updateCheck.lastMs') || 0;
    if (Date.now() - last < UPDATE_CHECK_INTERVAL_MS) return;
  }
  let release: any;
  try {
    release = await fetchLatestRelease();
  } catch (e) {
    if (manual)
      vscode.window.showWarningMessage(
        `Claude Observatory: couldn't check for updates (${String((e as Error)?.message || e)}).`
      );
    return;
  }
  context.globalState.update('updateCheck.lastMs', Date.now());
  const latest = String(release?.tag_name || '').replace(/^v/i, '');
  if (!latest || !core.isNewer(latest, current)) {
    if (manual) vscode.window.showInformationMessage(`Claude Observatory is up to date (${current}).`);
    return;
  }
  if (!manual && context.globalState.get<string>('updateCheck.skip') === latest) return; // dismissed
  const vsix = (release.assets || []).find((a: any) => /\.vsix$/i.test(a.name));
  const downloadUrl = vsix?.browser_download_url || release.html_url;
  // Prefer a real one-click install when we can drive the `code` CLI; otherwise fall back to opening
  // the .vsix in a browser + manual "Install from VSIX…".
  const canInstall = Boolean(vsix); // installed via VS Code's own service — no `code` CLI needed
  const primary = canInstall ? 'Update now' : 'Download .vsix';
  const choice = await vscode.window.showInformationMessage(
    `Claude Observatory ${latest} is available (you have ${current}).`,
    primary,
    'Release notes',
    'Skip this version'
  );
  if (choice === 'Update now') {
    await installVsixUpdate(vsix.browser_download_url, latest);
  } else if (choice === 'Download .vsix') {
    vscode.env.openExternal(vscode.Uri.parse(downloadUrl));
    vscode.window.showInformationMessage(
      'After it downloads: Extensions view → ⋯ → “Install from VSIX…”, then pick the file (reload when prompted).'
    );
  } else if (choice === 'Release notes') {
    vscode.env.openExternal(vscode.Uri.parse(release.html_url));
  } else if (choice === 'Skip this version') {
    context.globalState.update('updateCheck.skip', latest);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const editsProvider = new EditsProvider('edits');
  const diffsProvider = new EditsProvider('diffs');
  const timelineProvider = new EditsProvider('timeline');
  const editsView = vscode.window.createTreeView('claudeObservatory.edits', { treeDataProvider: editsProvider });
  const diffsView = vscode.window.createTreeView('claudeObservatory.diffs', { treeDataProvider: diffsProvider });
  const timelineView = vscode.window.createTreeView('claudeObservatory.timeline', { treeDataProvider: timelineProvider });
  const insightsProvider = new ObservationsProvider();
  const insightsView = vscode.window.createTreeView('claudeObservatory.observations', { treeDataProvider: insightsProvider });
  const fileHistoryProvider = new FileHistoryProvider();
  const fileHistoryView = vscode.window.createTreeView('claudeObservatory.fileHistory', { treeDataProvider: fileHistoryProvider });
  fileHistoryProvider.view = fileHistoryView;
  const statsProvider = new StatsUsageViewProvider();
  editsProvider.view = editsView; // badge lives on the primary view
  editsProvider.updateBadge();


  // A SUBTLE whole-line green tint + coral change-bar on Claude's added/changed lines — deliberately
  // low-alpha (not the default diff green) so a file where Claude edited many lines doesn't drown in
  // color, while still showing at a glance what changed.
  inlineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: ADDED_LINE_BG,
    overviewRulerColor: CLAUDE_MARK_COLOR,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: CLAUDE_MARK_COLOR,
  });
  // ✨ gutter icon at the START of each edit — the "Claude edited here" marker; click the CodeLens
  // above (or, in JetBrains, the gutter icon itself) to open the inline diff.
  annotationDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: vscode.Uri.joinPath(context.extensionUri, 'media', 'star.svg'),
    gutterIconSize: 'contain',
  });
  // Deleted lines don't exist in the buffer, so show the removed text as red ghost text on the surviving
  // anchor line, over a subtle red tint + red gutter bar (the toned-down mirror of the added-line fill).
  deletionGhostDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: REMOVED_LINE_BG,
    overviewRulerColor: CLAUDE_MARK_COLOR,
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
  });
  // File heatmap: fade unmodified lines to ~40% so Claude's edited lines read at full contrast.
  heatmapDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.4' });
  inlineLens = new InlineLensProvider();
  const editPeek = new EditPeek();

  // Realtime observatory readout: a status-bar microscope with the pending count — always visible,
  // amber while edits await review. Click = jump to the next pending edit.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusItem.command = 'claudeObservatory.reviewNext';
  // A compact action cluster beside the microscope — shown only while edits await review so the bottom
  // bar stays quiet when you're caught up. Same actions are mirrored in the editor's top-right toolbar.
  const mkStatusBtn = (text: string, tooltip: string, command: string, priority: number) => {
    const b = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    b.text = text;
    b.tooltip = tooltip;
    b.command = command;
    return b;
  };
  const statusCluster = [
    mkStatusBtn('$(debug-step-back)', 'Claude Observatory: review previous pending edit', 'claudeObservatory.reviewPrev', 89),
    mkStatusBtn('$(debug-step-over)', 'Claude Observatory: review next pending edit', 'claudeObservatory.reviewNext', 88),
    mkStatusBtn('$(check-all)', 'Claude Observatory: accept all edits', 'claudeObservatory.keepAll', 87),
    mkStatusBtn('$(discard)', 'Claude Observatory: revert all pending edits (accepted edits are kept)', 'claudeObservatory.undoAll', 86),
    mkStatusBtn('$(search)', 'Claude Observatory: search edits', 'claudeObservatory.searchEdits', 85),
  ];
  const updateStatusItem = () => {
    const session = currentSession();
    const log = session ? cachedLog(session) : [];
    const pendingRecs = log.filter((r) => r.status === 'pending');
    const pending = pendingRecs.length;
    const kept = log.filter((r) => r.status === 'kept').length;
    const undone = log.filter((r) => r.status === 'undone').length;
    statusItem.text = pending ? `🔬 ${pending}` : '🔬';
    // The review scoreboard lives here (not in the Stats webview): always one glance away.
    const reviewed = kept + undone;
    const rate = reviewed ? ` · ${Math.round((kept / reviewed) * 100)}% accepted` : '';
    const oldest = pending ? Math.min(...pendingRecs.map((r) => r.ts)) : null;
    const age = oldest ? ` · oldest ${core.relTime(oldest)}` : '';
    const tip = new vscode.MarkdownString(
      `**Claude Observatory — review scoreboard**\n\n` +
        `${pending} pending · ${kept} accepted · ${undone} reverted${rate}${age}\n\n` +
        (pending ? `_Click to review the next pending edit_` : `_All caught up_`)
    );
    statusItem.tooltip = tip;
    statusItem.backgroundColor = pending ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    statusItem.show();
    // The action cluster + the editor-toolbar buttons only appear while there's something to review.
    for (const b of statusCluster) pending ? b.show() : b.hide();
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.hasPending', pending > 0);
    syncActiveFileContext();
  };
  // The per-file surfaces (editor tab-bar / editor banner) light up only when the ACTIVE file has a
  // pending edit — its own context key, refreshed on store changes and on tab switches.
  const syncActiveFileContext = () => {
    const s = currentSession();
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    const has = Boolean(s && file && cachedLog(s).some((r) => r.status === 'pending' && r.file === file));
    void vscode.commands.executeCommand('setContext', 'claudeObservatory.activeFileHasPending', has);
  };
  updateStatusItem(); // visible from activation, not just after the first store event
  context.subscriptions.push(...statusCluster);

  // Review-loop cursor: id of the pending edit last opened, so ←/→ step backward/forward through every
  // pending edit (wrapping at the ends) instead of always reopening the oldest.
  let reviewCursorId: number | undefined;

  // Step to the previous (dir -1) or next (dir +1) pending edit and open it, advancing the cursor.
  const reviewStep = async (dir: 1 | -1) => {
    const s = currentSession();
    const pending = s ? cachedLog(s).filter((r) => r.status === 'pending').sort((a, b) => a.id - b.id) : [];
    if (pending.length === 0) {
      reviewCursorId = undefined;
      vscode.window.setStatusBarMessage('Claude Observatory: no pending edits to review 🎉', 3000);
      return;
    }
    const cursor = reviewCursorId;
    const idx = cursor === undefined ? -1 : pending.findIndex((r) => r.id === cursor);
    let next: core.EditRecord;
    if (idx >= 0) {
      next = pending[(idx + dir + pending.length) % pending.length]; // step ±1, wrapping at the ends
    } else if (cursor === undefined) {
      next = dir === 1 ? pending[0] : pending[pending.length - 1]; // first review: oldest (→) / newest (←)
    } else {
      // cursor's edit was resolved — resume just past it in the step direction
      next =
        dir === 1
          ? pending.find((r) => r.id > cursor) ?? pending[0]
          : [...pending].reverse().find((r) => r.id < cursor) ?? pending[pending.length - 1];
    }
    reviewCursorId = next.id;
    await openFileAtEdit({ kind: 'edit', rec: next });
  };

  const refreshAll = () => {
    editsProvider.refresh();
    editsProvider.refresh();
    diffsProvider.refresh();
    timelineProvider.refresh();
    insightsProvider.refresh();
    fileHistoryProvider.refresh();
    statsProvider.refresh();
    statusDecorations.refresh();
    updateStatusItem();
    refreshInline();
  };

  context.subscriptions.push(
    editsView,
    diffsView,
    timelineView,
    insightsView,
    fileHistoryView,
    statusItem,
    inlineDecoration,
    deletionGhostDecoration,
    annotationDecoration,
    heatmapDecoration,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inlineLens),
    vscode.window.registerWebviewViewProvider('claudeObservatory.stats', statsProvider),
    vscode.window.registerFileDecorationProvider(statusDecorations),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new BlobContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider(MD_SCHEME, obsMd),
    editPeek
  );

  // The context bar drifts as the session grows; refresh it on a slow tick (unref'd so it never
  // holds the process open in tests). Tree/inline refresh is event-driven via the log watcher below.
  const statusTimer = setInterval(() => {
    statsProvider.refresh();
  }, 45000);
  statusTimer.unref?.();
  context.subscriptions.push({ dispose: () => clearInterval(statusTimer) });

  // Refresh on panel-visible / window-focus (covers new sessions the watcher may miss), on active
  // editor change, and on buffer edits (debounced) so decorations track the live buffer.
  for (const v of [editsView, diffsView, timelineView, insightsView, fileHistoryView]) {
    v.onDidChangeVisibility((e) => e.visible && refreshAll());
  }
  let debounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => s.focused && refreshAll()),
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshInline();
      syncActiveFileContext();
      fileHistoryProvider.refresh(); // re-query for the newly-active file
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(refreshInline, 250);
    })
  );

  const withSession = (fn: (session: string) => void | Promise<void>) => async () => {
    const s = currentSession();
    if (!s) {
      vscode.window.showWarningMessage('Claude Observatory: no active Claude Code session for this workspace.');
      return;
    }
    await fn(s);
    refreshAll();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeObservatory.refresh', () => refreshAll()),
    // Step backward / forward through pending edits (⏮ prev · ⏭ next), keyboard-friendly.
    vscode.commands.registerCommand('claudeObservatory.reviewNext', () => reviewStep(1)),
    vscode.commands.registerCommand('claudeObservatory.reviewPrev', () => reviewStep(-1)),
    // Revision navigation: step the active file's edit history in a current-vs-revision diff.
    vscode.commands.registerCommand('claudeObservatory.diffPrevRevision', () => diffRevisionStep(-1)),
    vscode.commands.registerCommand('claudeObservatory.diffNextRevision', () => diffRevisionStep(1)),
    // Export a shareable review summary (kept/reverted per file) as markdown in a new editor tab.
    vscode.commands.registerCommand('claudeObservatory.exportSummary', async () => {
      const s = currentSession();
      if (!s) {
        vscode.window.showWarningMessage('Claude Observatory: no active Claude Code session to summarize.');
        return;
      }
      const md = core.reviewSummaryMarkdown(core.reviewSummary(s));
      const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
      await vscode.window.showTextDocument(doc);
    }),
    // Setup check: run `doctor` and open the diagnostics (hooks, PATH, config, session, status line) in a tab.
    vscode.commands.registerCommand('claudeObservatory.doctor', async () => {
      // spawnSync (not execFileSync) so we still capture stdout when doctor exits non-zero on failures.
      const res = cp.spawnSync(resolveObservatoryBin(), ['doctor', '--markdown'], { encoding: 'utf8', cwd: workspaceRoot() });
      if (res.error || typeof res.stdout !== 'string' || !res.stdout.trim()) {
        vscode.window.showErrorMessage('Claude Observatory: could not run doctor — is the claude-observatory CLI installed?');
        return;
      }
      const doc = await vscode.workspace.openTextDocument({ content: res.stdout, language: 'markdown' });
      await vscode.window.showTextDocument(doc);
    }),
    // Search: filter the Edits/Diffs trees by file path. Empty input clears the filter.
    vscode.commands.registerCommand('claudeObservatory.searchEdits', async () => {
      const q = await vscode.window.showInputBox({
        title: 'Search edits',
        prompt: 'Filter edits by file path — leave empty to clear',
        value: editFilter,
        placeHolder: 'e.g. src/api or User.ts',
      });
      if (q === undefined) return; // cancelled — leave the filter unchanged
      editFilter = q.trim();
      refreshAll();
    }),
    // Pin which session the observatory shows (e.g. the demo-showcase fixture) instead of the
    // auto-resolved newest one — a QuickPick over every session in the store.
    vscode.commands.registerCommand('claudeObservatory.switchSession', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeObservatory');
      const pinned = cfg.get<string>('session', '').trim();
      const root = workspaceRoot();
      const auto = root ? core.resolveSessionId(root) ?? undefined : undefined;
      type Item = vscode.QuickPickItem & { id: string };
      const items: Item[] = [
        { label: '$(sync) Auto — newest for this workspace', description: auto ?? 'none', id: '' },
        ...core.listSessions().map((s) => ({
          label: s.id,
          description: `${s.pending} pending · ${core.relTime(s.lastMs)}` + (s.id === auto ? ' · auto' : ''),
          picked: s.id === pinned,
          id: s.id,
        })),
      ];
      const pick = await vscode.window.showQuickPick(items, {
        title: 'Claude Observatory — review which session?',
        placeHolder: pinned ? `pinned: ${pinned}` : `auto: ${auto ?? 'none'}`,
      });
      if (!pick) return;
      await cfg.update('session', pick.id, vscode.ConfigurationTarget.Workspace);
      refreshAll();
      vscode.window.setStatusBarMessage(
        pick.id ? `Claude Observatory: showing session ${pick.id}` : 'Claude Observatory: session set to auto',
        3000
      );
    }),
    // A hand-edited `claudeObservatory.session` in settings.json should re-render immediately.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeObservatory.session')) refreshAll();
    }),
    // Keep / undo the pending edit under the cursor — the review loop never has to leave the keyboard.
    vscode.commands.registerCommand('claudeObservatory.keepAtCursor', () =>
      withSession((s) => {
        const rec = pendingAtCursor(s);
        if (!rec) {
          vscode.window.setStatusBarMessage('Claude Observatory: no pending edit under the cursor', 3000);
          return;
        }
        core.keepGroup(s, rec.id);
        vscode.window.setStatusBarMessage(`Claude Observatory: kept edit #${rec.id}`, 3000);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.undoAtCursor', () =>
      withSession(async (s) => {
        const rec = pendingAtCursor(s);
        if (!rec) {
          vscode.window.setStatusBarMessage('Claude Observatory: no pending edit under the cursor', 3000);
          return;
        }
        await undoOne(s, rec.id);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.setup', showSetup),
    vscode.commands.registerCommand('claudeObservatory.installHooks', installHooksFromExtension),
    vscode.commands.registerCommand('claudeObservatory.openDiff', (n: EditNode) => openDiff(n)),
    vscode.commands.registerCommand('claudeObservatory.openFileAtEdit', (n: EditNode) => openFileAtEdit(n)),
    vscode.commands.registerCommand('claudeObservatory.openFile', (n: Node) => {
      const file =
        n.kind === 'edit'
          ? n.rec.file
          : n.kind === 'file' || n.kind === 'class' || n.kind === 'tlrun'
            ? n.file
            : undefined;
      if (file) vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file));
    }),
    // Session-wide bulk actions (view-title buttons).
    vscode.commands.registerCommand('claudeObservatory.keepAll', () => withSession((s) => keepAllSession(s))()),
    vscode.commands.registerCommand('claudeObservatory.undoAll', () => withSession((s) => undoAllSession(s))()),
    vscode.commands.registerCommand('claudeObservatory.clearResolved', () =>
      withSession(async (s) => {
        const resolved = core.readLog(s).filter((r) => r.status !== 'pending').length;
        if (resolved === 0) {
          vscode.window.showInformationMessage('No resolved (kept/reverted) edits to clear.');
          return;
        }
        const choice = await vscode.window.showWarningMessage(
          `Clear ${resolved} resolved (kept/reverted) edit(s)? Pending edits are kept.`,
          { modal: true },
          'Clear'
        );
        if (choice !== 'Clear') return;
        const n = core.clearResolved(s);
        vscode.window.showInformationMessage(`Cleared ${n} resolved edit(s).`);
      })()
    ),
    // Store maintenance (parity with the CLI `clean`): reclaim disk (GC orphaned blobs) or drop the
    // whole session. Previously editor-only users had to drop to a terminal for these.
    vscode.commands.registerCommand('claudeObservatory.cleanStore', () =>
      withSession(async (s) => {
        const pick = await vscode.window.showQuickPick(
          [
            { label: '$(trash) Reclaim disk', description: 'garbage-collect orphaned blobs in this session', act: 'gc' as const },
            { label: '$(close) Drop this session…', description: "delete this session's captured edits + blobs (files on disk are NOT changed)", act: 'drop' as const },
          ],
          { placeHolder: 'Clean the Claude Observatory store' }
        );
        if (!pick) return;
        if (pick.act === 'gc') {
          const r = core.gcSession(s);
          vscode.window.showInformationMessage(`Reclaimed ${r.removed} orphaned blob(s) (${(r.bytes / 1024).toFixed(1)} KB).`);
        } else {
          const ok = await vscode.window.showWarningMessage(
            `Drop session ${s}? This deletes its captured edits + blobs. Files on disk are NOT changed.`,
            { modal: true },
            'Drop session'
          );
          if (ok !== 'Drop session') return;
          core.removeSession(s);
          vscode.window.showInformationMessage(`Dropped session ${s}.`);
        }
      })()
    ),
    // Chat about a specific edit (from a tree node or an edit id).
    vscode.commands.registerCommand('claudeObservatory.chatEdit', (arg: EditNode | number) => {
      const s = currentSession();
      if (!s) return undefined;
      return chatAboutEdit(s, typeof arg === 'number' ? arg : arg.rec.id);
    }),
    // Insights (observations + suggestions)
    vscode.commands.registerCommand('claudeObservatory.showObservation', (id: number) => showObservationDoc(id)),
    vscode.commands.registerCommand('claudeObservatory.showSuggestions', () => showSuggestionsDoc()),
    vscode.commands.registerCommand('claudeObservatory.analyzeEdit', (arg: ObsNode | number) => {
      const s = currentSession();
      if (!s) return undefined;
      const id = typeof arg === 'number' ? arg : (arg as { id?: number; rec?: core.EditRecord }).id ?? (arg as { rec?: core.EditRecord }).rec?.id;
      if (typeof id !== 'number') return undefined;
      if (core.cachedAnalysis(s, `edit-${id}`)) return showObservationDoc(id); // already analyzed -> just view
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Analyzing edit #${id} with Claude…` },
        async () => {
          try {
            const bin = core.resolveClaudeBin(vscode.workspace.getConfiguration('claudeObservatory').get<string>('claudeBin'));
            const cwd = workspaceRoot();
            const reasoning = cwd ? core.reasoningByEdit(cwd, s).get(id) : undefined;
            await core.analyzeEdit(s, id, { claudeBin: bin, reasoning });
          } catch (e) {
            vscode.window.showErrorMessage(`Analyze failed: ${String((e as Error)?.message || e)}`);
            return;
          }
          insightsProvider.refresh();
          await showObservationDoc(id);
        }
      );
    }),
    vscode.commands.registerCommand('claudeObservatory.refreshRecap', () => {
      const s = currentSession();
      if (!s) return undefined;
      return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Refreshing the session recap with Claude…' },
        async () => {
          try {
            const bin = core.resolveClaudeBin(vscode.workspace.getConfiguration('claudeObservatory').get<string>('claudeBin'));
            await core.analyzeRecap(s, { claudeBin: bin });
          } catch (e) {
            vscode.window.showErrorMessage(`Recap failed: ${String((e as Error)?.message || e)}`);
            return;
          }
          insightsProvider.refresh();
        }
      );
    }),
    vscode.commands.registerCommand('claudeObservatory.keep', (n: EditNode) =>
      withSession((s) => {
        core.keepGroup(s, n.rec.id);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.undo', (n: EditNode) =>
      withSession((s) => undoOne(s, n.rec.id))()
    ),
    vscode.commands.registerCommand('claudeObservatory.redo', (n: EditNode) =>
      withSession((s) => redoOne(s, n.rec.id))()
    ),
    // Inline overlay hover actions — take an edit id instead of a tree node.
    vscode.commands.registerCommand('claudeObservatory.inlineDiff', (id: number) => {
      const s = currentSession();
      const rec = s ? core.findRecord(s, id) : null;
      if (rec) openDiff({ kind: 'edit', rec });
    }),
    // "View changes" → the inline review bubble at the edit: the diff in git's colors + reasoning +
    // line counts, with Accept/Revert/Chat/Prev/Next as toolbar buttons (comments/commentThread/title).
    vscode.commands.registerCommand('claudeObservatory.viewChanges', (id: number) => editPeek.show(id)),
    vscode.commands.registerCommand('claudeObservatory.peekKeep', () => editPeek.keep()),
    vscode.commands.registerCommand('claudeObservatory.peekUndo', () => void editPeek.undo()),
    vscode.commands.registerCommand('claudeObservatory.peekChat', () => editPeek.chat()),
    vscode.commands.registerCommand('claudeObservatory.peekPrev', () => editPeek.step(-1)),
    vscode.commands.registerCommand('claudeObservatory.peekNext', () => editPeek.step(1)),
    // Prev/Next on the diff title bar (diff tabs from the Diffs tree / revision nav): step the file's
    // pending edits (wrapping). The command gets the diff's resource URI, which carries the edit id.
    vscode.commands.registerCommand('claudeObservatory.diffPrevEdit', (uri?: vscode.Uri) => stepDiffEdit(uri, -1)),
    vscode.commands.registerCommand('claudeObservatory.diffNextEdit', (uri?: vscode.Uri) => stepDiffEdit(uri, 1)),
    vscode.commands.registerCommand('claudeObservatory.inlineKeep', (id: number) =>
      withSession((s) => {
        core.keepGroup(s, id);
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.inlineUndo', (id: number) =>
      withSession((s) => undoOne(s, id))()
    ),
    // Diff title-bar actions: the editor/title command receives the diff's resource URI, which carries
    // the edit id in its query — resolve it, then reuse the id-based keep/undo/chat commands.
    vscode.commands.registerCommand('claudeObservatory.diffKeep', (uri?: vscode.Uri) => {
      const id = editIdFromUri(uri);
      if (id != null) void vscode.commands.executeCommand('claudeObservatory.inlineKeep', id);
    }),
    vscode.commands.registerCommand('claudeObservatory.diffUndo', (uri?: vscode.Uri) => {
      const id = editIdFromUri(uri);
      if (id != null) void vscode.commands.executeCommand('claudeObservatory.inlineUndo', id);
    }),
    vscode.commands.registerCommand('claudeObservatory.diffChat', (uri?: vscode.Uri) => {
      const id = editIdFromUri(uri);
      if (id != null) void vscode.commands.executeCommand('claudeObservatory.chatEdit', id);
    }),
    vscode.commands.registerCommand('claudeObservatory.toggleInline', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeObservatory');
      const next = !cfg.get<boolean>('inlineReview', true);
      await cfg.update('inlineReview', next, vscode.ConfigurationTarget.Global);
      refreshInline();
      vscode.window.showInformationMessage(`Claude Observatory: inline review ${next ? 'on' : 'off'}.`);
    }),
    // File heatmap: dim every unmodified line so only Claude's edits read at full contrast.
    vscode.commands.registerCommand('claudeObservatory.toggleHeatmap', () => {
      heatmapOn = !heatmapOn;
      refreshInline();
      vscode.window.setStatusBarMessage(`Claude Observatory: file heatmap ${heatmapOn ? 'on 📄' : 'off'}`, 2500);
    }),
    vscode.commands.registerCommand('claudeObservatory.keepFile', (n: FileNode) =>
      withSession((s) => keepEditsInFile(s, n.file, n.edits))()
    ),
    vscode.commands.registerCommand('claudeObservatory.undoFile', (n: FileNode) =>
      withSession((s) => undoEditsInFile(s, n.file, n.edits))()
    ),
    // Clear the resolved (kept/reverted) edits for one file — the file-row inline broom.
    vscode.commands.registerCommand('claudeObservatory.clearFile', (n: FileNode) =>
      withSession((s) => clearResolvedUnder(s, n.file, path.basename(n.file)))()
    ),
    // Folder-row inline actions: accept / revert / clear every edit at-or-beneath the folder.
    vscode.commands.registerCommand('claudeObservatory.keepFolder', (n: FolderNode) =>
      withSession((s) => keepEditsUnder(s, n.path, n.label))()
    ),
    vscode.commands.registerCommand('claudeObservatory.undoFolder', (n: FolderNode) =>
      withSession((s) => undoEditsUnder(s, n.path, n.label))()
    ),
    vscode.commands.registerCommand('claudeObservatory.clearFolder', (n: FolderNode) =>
      withSession((s) => clearResolvedUnder(s, n.path, n.label))()
    ),
    // Accept / revert every pending edit in the ACTIVE editor's file — what the per-file surfaces use.
    vscode.commands.registerCommand('claudeObservatory.keepOpenFile', () =>
      withSession((s) => {
        const file = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) return void vscode.window.showInformationMessage('Claude Observatory: no active file.');
        keepEditsInFile(s, file, cachedLog(s).filter((r) => r.file === file));
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.undoOpenFile', () =>
      withSession(async (s) => {
        const file = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) return void vscode.window.showInformationMessage('Claude Observatory: no active file.');
        await undoEditsInFile(s, file, cachedLog(s).filter((r) => r.file === file));
      })()
    )
  );

  // Live updates: watch the store's log files (base ~/.claude exists even before first capture).
  const base = vscode.Uri.file(path.dirname(core.rootDir()));
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(base, 'claude-observatory/*/log.jsonl')
  );
  // Capture writes land in bursts (PreToolUse + PostToolUse per edit) — debounce so one refresh
  // covers the burst instead of re-rendering every view per file event.
  let watchDebounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(refreshAll, 150);
  };
  watcher.onDidChange(scheduleRefresh);
  watcher.onDidCreate(scheduleRefresh);
  watcher.onDidDelete(scheduleRefresh);
  context.subscriptions.push(watcher);

  refreshInline(); // paint the currently-open editor on activation

  // Nudge at most once, and only when nothing's set up: no hooks AND no tracked edits for this
  // workspace (so browsing the demo / an already-captured session never nags).
  const nudgeSession = currentSession();
  const hasEdits = nudgeSession ? core.readLog(nudgeSession).length > 0 : false;
  if (!core.hooksInstalled() && !hasEdits && !context.globalState.get('setupNudged')) {
    context.globalState.update('setupNudged', true);
    showSetup();
  }

  // Marketplace-free update nudge: a manual command + a throttled background check on activation.
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeObservatory.checkForUpdates', () => checkForUpdate(context, true))
  );
  void checkForUpdate(context, false);
}

export function deactivate(): void {
  /* disposables handled via context.subscriptions */
}
