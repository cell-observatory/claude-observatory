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
import { CODICON_STYLE } from './codicon';

const SCHEME = 'claude-edit'; // in-memory before/after blobs for vscode.diff

// Claude's signature marker color for the overview ruler — a distinct coral so Claude's edits are
// recognizable at a glance and don't blend into VCS (green/blue/red) gutter markers.
const CLAUDE_MARK_COLOR = 'rgba(204, 120, 92, 0.85)';
// Whole-line tints for the inline overlay — strong enough to spot Claude's edits at a glance (green
// added, red removed), each backed by a bold matching change-bar so added vs removed read distinctly.
const ADDED_LINE_BG = 'rgba(88, 166, 100, 0.30)';
const REMOVED_LINE_BG = 'rgba(229, 83, 75, 0.30)';
// The left change-bar colors — near-opaque green/red so the edited region's edge is unmistakable.
const ADDED_BAR = 'rgba(88, 166, 100, 0.9)';
const REMOVED_BAR = 'rgba(229, 83, 75, 0.9)';

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
    // Nav-bar counters in the bubble header: position among this file's pending edits (Diff axis) and
    // among all files with pending edits (File axis) — the same two axes the status-bar bar shows.
    const filePending = cachedLog(session).filter((r) => r.file === rec.file && r.status === 'pending').sort((a, b) => a.id - b.id);
    const diffIdx = filePending.findIndex((r) => r.id === id);
    const files = pendingFilesOf(session);
    const fileIdx = files.indexOf(rec.file);
    const diffPos = diffIdx >= 0 ? `Diff ${diffIdx + 1}/${filePending.length}` : '';
    const filePos = fileIdx >= 0 ? `File ${fileIdx + 1}/${files.length}` : '';
    const md = new vscode.MarkdownString();
    md.supportHtml = true; // the colored <span>s below survive the sanitizer only with this on
    md.isTrusted = true;
    md.appendMarkdown(
      `**✨ Claude edit #${id}**  ·  \`+${d.added} −${d.removed}\`  ·  ${rec.tool}` +
        (diffPos ? `  ·  ${diffPos}` : '') +
        (filePos ? `  ·  ${filePos}` : '') +
        `\n\n`
    );
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
    // Show BOTH axes in the title (Diff n/m · File i/k), like the status-bar nav bar — File only when
    // more than one file has pending edits.
    thread.label =
      `Claude edit #${id}  ·  +${d.added} −${d.removed}` +
      (diffPos ? `  ·  ${diffPos}` : '') +
      (filePos && files.length > 1 ? `  ·  ${filePos}` : '');
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

  /** Step to the prev (-1) / next (+1) pending edit in the same file, wrapping at the ends (Diff axis). */
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

  /** Step to the prev (-1) / next (+1) file with pending edits, opening its first pending edit (File axis). */
  stepFile(dir: 1 | -1): Promise<void> {
    const s = currentSession();
    if (!this.edit || !s) return Promise.resolve();
    const files = pendingFilesOf(s);
    if (files.length === 0) return Promise.resolve();
    const idx = files.indexOf(this.edit.file);
    const target = files[((idx < 0 ? 0 : idx) + dir + files.length) % files.length];
    const first = pendingEditsInFile(s, target)[0];
    return first ? this.show(first.id) : Promise.resolve();
  }

  /** Accept every pending edit in the bubble's file, then close it (Accept File). */
  acceptFile(): void {
    const s = currentSession();
    if (this.edit && s) {
      keepEditsInFile(s, this.edit.file, []);
      this.closeThread();
    }
  }

  /** Revert every pending edit in the bubble's file (dirty-guard + confirm inside), then close it. */
  async rejectFile(): Promise<void> {
    const s = currentSession();
    if (this.edit && s) {
      await undoEditsInFile(s, this.edit.file, []);
      this.closeThread();
    }
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

/** Coerce a chatAction argument into a ChatContextRef. Accepts a bare ref (from the webview messages),
 *  an Actions action row (→ toolUseId, else its store editId), or a subagent row (→ its agentId). */
function refFromArg(arg: unknown): core.ChatContextRef | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const a = arg as {
    kind?: string;
    action?: core.ActionRecord;
    sub?: core.SubagentInfo;
    toolUseId?: string;
    editId?: number;
    agentId?: string;
    taskId?: string;
  };
  if (a.kind === 'action' && a.action)
    return a.action.toolUseId ? { toolUseId: a.action.toolUseId } : a.action.editId != null ? { editId: a.action.editId } : undefined;
  if (a.kind === 'subagent' && a.sub) return { agentId: a.sub.agentId };
  const ref: core.ChatContextRef = {};
  if (a.toolUseId) ref.toolUseId = a.toolUseId;
  if (typeof a.editId === 'number') ref.editId = a.editId;
  if (a.agentId) ref.agentId = a.agentId;
  if (a.taskId) ref.taskId = a.taskId;
  return ref.toolUseId || ref.editId != null || ref.agentId || ref.taskId ? ref : undefined;
}

/** Zero-token chat handoff for ANY action / edit / subagent / task (0.8.0): assemble the ready-to-paste
 *  prompt in-process via core's `assembleChatContext` (the SAME single-backend function the CLI's
 *  `chat-context --json` wraps — VS Code calls it directly, JetBrains shells to the CLI), copy it to the
 *  clipboard, then open the user's Claude sidebar. NEVER calls a model. */
async function chatAction(ref: core.ChatContextRef): Promise<void> {
  const session = currentSession();
  const cwd = workspaceRoot();
  if (!session || !cwd) return;
  let prompt = '';
  try {
    prompt = core.assembleChatContext(cwd, session, ref);
  } catch {
    prompt = '';
  }
  if (!prompt.trim()) {
    vscode.window.showWarningMessage('Claude Observatory: no chat context for that item.');
    return;
  }
  await vscode.env.clipboard.writeText(prompt);
  for (const cmd of ['claude-vscode.sidebar.open', 'claude-vscode.focus']) {
    try {
      await vscode.commands.executeCommand(cmd);
    } catch {
      /* Claude Code extension not present — the prompt is still on the clipboard */
    }
  }
  vscode.window.showInformationMessage('Prompt copied — paste (⌘V) into Claude to discuss it.');
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

// --- Chapter review actions (0.8.0) — the Overview ribbon's per-chip Accept / Reject / Clear.
// Each resolves the chapter's DISPLAYED edit set (core.reviewEditIds via keepTask/undoTask) — WYSIWYG:
// the buttons act on exactly the edits the chapter row shows (incl. gap-filled members and the
// synthetic session chapter), so a partial accept never strands leftovers the buttons can't reach.

/** Accept — keep every PENDING edit displayed under a chapter (task-keep). */
function keepChapter(session: string, taskId: string): void {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const res = core.keepTask(cwd, session, taskId);
  vscode.window.showInformationMessage(
    res.kept ? `Accepted ${res.kept} edit(s) in this chapter.` : 'No pending edits to accept in this chapter.'
  );
}

/** Reject — revert every PENDING edit displayed under a chapter, after a confirm + dirty-buffer
 *  guard (task-undo). Accepted edits are left on disk — revert individually. */
async function undoChapter(session: string, taskId: string): Promise<void> {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const ids = new Set(core.reviewEditIds(cwd, session, taskId));
  const targets = core.readLog(session).filter((r) => ids.has(r.id) && r.status === 'pending');
  if (targets.length === 0) {
    vscode.window.showInformationMessage('Nothing to reject in this chapter.');
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
    `Reject ${targets.length} edit(s) in this chapter? Overlapping edits may conflict.`,
    { modal: true },
    'Reject all'
  );
  if (choice !== 'Reject all') return;
  const res = core.undoTask(cwd, session, taskId);
  vscode.window.showInformationMessage(
    `Reverted ${res.undone} edit(s) in this chapter` +
      (res.conflicts ? ` · ${res.conflicts} conflict(s) left (revert individually to force)` : '') +
      '.'
  );
}

/** Clear — drop the RESOLVED (kept/undone) edits displayed under a chapter (task-clear). */
function clearChapter(session: string, taskId: string): void {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const res = core.clearResolvedIds(session, core.reviewEditIds(cwd, session, taskId));
  vscode.window.showInformationMessage(
    res.cleared ? `Cleared ${res.cleared} resolved edit(s) in this chapter.` : 'No resolved edits to clear in this chapter.'
  );
}

/** Clear the resolved edits of EVERY settled chapter (all kept — none pending, none undone), the
 *  ribbon's "Clear completed chapters" affordance (task-clear --completed). */
function clearCompletedChapters(session: string): void {
  const cwd = workspaceRoot();
  if (!cwd) return;
  const map = core.buildChangeMap(cwd, session, { root: cwd });
  // Chapters are total — iterating them (not the strict rollup) covers gap-filled members and the
  // synthetic session chapter once every displayed edit is kept.
  const settled = map.chapters.filter((ch) => ch.edits > 0 && ch.pending === 0 && ch.undone === 0);
  if (settled.length === 0) {
    vscode.window.showInformationMessage('No completed chapters to clear.');
    return;
  }
  let cleared = 0;
  for (const ch of settled) cleared += core.clearResolvedIds(session, core.reviewEditIds(cwd, session, ch.id)).cleared;
  vscode.window.showInformationMessage(
    cleared
      ? `Cleared ${cleared} resolved edit(s) across ${settled.length} completed chapter(s).`
      : 'No resolved edits to clear.'
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

/** Files with at least one pending edit, sorted by path — the nav bar's File axis (matches the Edits tree). */
function pendingFilesOf(session: string): string[] {
  const files = new Set<string>();
  for (const r of cachedLog(session)) if (r.status === 'pending') files.add(r.file);
  return [...files].sort();
}

/** One file's pending edits, oldest→newest — the nav bar's Diff axis. */
function pendingEditsInFile(session: string, file: string): core.EditRecord[] {
  return cachedLog(session)
    .filter((r) => r.file === file && r.status === 'pending')
    .sort((a, b) => a.id - b.id);
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
    // Position counters — the same Diff-axis / File-axis numbers the status-bar nav bar shows, but
    // folded into the lens next to the edit (the editor title bar can't render live text). "edit n/m
    // in file" mirrors the Diff axis; "file i/k" mirrors the File axis (shown only when >1 file pending).
    const filePending = pendingEditsInFile(session, doc.uri.fsPath);
    const files = pendingFilesOf(session);
    const fileIdx = files.indexOf(doc.uri.fsPath);
    const filePos = fileIdx >= 0 && files.length > 1 ? `  ·  file ${fileIdx + 1}/${files.length}` : '';
    const lenses: vscode.CodeLens[] = [];
    for (const [line, g] of byLine) {
      const range = new vscode.Range(line, 0, line, 0);
      const id = g.rec.id;
      const editIdx = filePending.findIndex((r) => r.id === id);
      const editPos = editIdx >= 0 ? `  ·  edit ${editIdx + 1}/${filePending.length} in file` : '';
      // "view changes" opens the review bubble (reasoning rides there); per-edit keep/undo is also on
      // ⌥⌘Y / ⌥⌘U and the Edits tree.
      lenses.push(new vscode.CodeLens(range, { title: `✨ #${id}  +${g.added} −${g.removed}${editPos}${filePos}  view changes`, command: 'claudeObservatory.viewChanges', arguments: [id] }));
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
// Observations (0.8.0, Timeline folded in) is timeline-STYLE: a recap on top, then the edit feed with
// adjacent same-file edits coalesced into ×N runs (reusing the Timeline's EditNode/TlRunNode so every
// shared Keep/Undo/Open command Just Works), then the Next-steps group at the end.
type ObsNode =
  | { kind: 'recap' }
  | { kind: 'steps' }
  | { kind: 'suggestion'; text: string }
  | EditNode
  | TlRunNode;

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
    if (!session) return [];
    // A run expands to its per-edit rows (each with Keep/Undo + reasoning), like the Timeline did.
    if (node) {
      if (node.kind === 'tlrun') return node.edits.map((rec): EditNode => ({ kind: 'edit', rec }));
      return [];
    }
    this.memo.clear(); // one memory computation per file per render cycle
    // Timeline-STYLE Observations (0.8.0): a one-line recap on top, then the edit feed newest-first with
    // adjacent same-file edits coalesced into ×N runs (each edit carrying Claude's reasoning inline),
    // then the still-open "Next steps" at the end — parity with `observations --json` and the JetBrains
    // Observations panel. The coalescing mirrors the (now folded-in) Timeline view exactly.
    const cwd = workspaceRoot();
    const log = cachedLog(session).slice().sort((a, b) => b.ts - a.ts); // newest first
    const feed: ObsNode[] = [{ kind: 'recap' }];
    for (let i = 0; i < log.length; ) {
      let j = i + 1;
      while (j < log.length && log[j].file === log[i].file) j++; // maximal same-file run
      const run = log.slice(i, j);
      feed.push(run.length === 1 ? { kind: 'edit', rec: run[0], feed: true } : { kind: 'tlrun', file: run[0].file, edits: run });
      i = j;
    }
    const suggestions = [
      ...new Set([...(cwd ? core.transcriptSuggestions(cwd, session) : []), ...core.heuristicSuggestions(session)]),
    ];
    if (suggestions.length) {
      feed.push({ kind: 'steps' });
      for (const text of suggestions) feed.push({ kind: 'suggestion', text });
    }
    return feed;
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
    // Coalesced ×N run: adjacent same-file edits as one row (combined delta + the newest edit's reasoning).
    // Reuses the `file` context value so the run gets Keep-all / Undo-all / Clear / Open-file, like a file.
    if (node.kind === 'tlrun') {
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
      const item = new vscode.TreeItem(`${hhmm}  ${path.basename(node.file)}  ×${node.edits.length}`, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `+${added} −${removed}${summary ? ` · ${summary}` : ''}`;
      item.tooltip = `${node.file}\n${node.edits.length} edits · +${added} −${removed}${reasoning ? `\n\n${reasoning}` : ''}`;
      item.iconPath = aggregateIcon(node.edits);
      item.contextValue = 'file';
      item.resourceUri = vscode.Uri.file(node.file);
      return item;
    }
    // One observation row per edit — Claude's reasoning inline, cross-session file memory + flags on
    // hover. Click opens the single combined report (summary + reasoning + flags + analysis).
    const rec = node.rec;
    const { added, removed } = session ? cachedDelta(session, rec) : { added: 0, removed: 0 };
    const d = new Date(rec.ts);
    const hhmm = [d.getHours(), d.getMinutes()].map((n) => String(n).padStart(2, '0')).join(':');
    const flags = session ? core.flagsFor(session, rec, cachedLog(session)) : [];
    const reasoning = cwd && session ? cachedTranscript(cwd, session).reasoning.get(rec.id) : undefined;
    const summary = reasoning ? firstLine(reasoning) : session ? core.summarize(session, rec) : '';
    // Cross-session memory: this file's review track record sharpens the observation over time.
    const mem = this.mem(rec.file);
    const risky = core.isRiskyFile(mem);
    const history = core.memorySummary(mem);
    const warn = risky || flags.some((f) => f.level === 'warn');
    // Top-level (single-edit run) rows lead with `HH:MM file`; run children lead with `#id` (time in desc).
    const isFeed = node.feed === true;
    let label = isFeed ? `${hhmm}  ${path.basename(rec.file)}` : `#${rec.id}`;
    if (rec.status === 'undone') label = strike(label);
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    const timePart = isFeed ? '' : `${hhmm} · `;
    item.description = `${timePart}+${added} −${removed}${summary ? ` · ${summary}` : ''}`;
    item.iconPath = warn ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')) : statusIcon(rec.status);
    item.tooltip = [
      reasoning ? `💭 ${reasoning}` : '',
      ...flags.map((f) => `${f.level === 'warn' ? '⚠' : 'ℹ'} ${f.message}`),
      risky ? `⚠ history: edits to this file get reverted often (${mem.undone} of ${mem.kept + mem.undone} verdicts) — review carefully` : '',
      history ? `🧠 ${history}` : '',
      `${rec.tool} · ${rec.status} · ${d.toLocaleTimeString()}`,
      'Click to open the full report.',
    ]
      .filter(Boolean)
      .join('\n');
    item.command = { command: 'claudeObservatory.showObservation', title: 'Observation', arguments: [rec.id] };
    // Reuse the shared edit/editUndone context menus (Keep / Undo / Redo / Chat / Open file).
    item.contextValue = rec.status === 'undone' ? 'editUndone' : 'edit';
    item.resourceUri = editItemUri(rec); // grey kept/undone observations, matching the other views
    return item;
  }
}

// --- Actions timeline (0.8.0 round 3) — the session's tool-call feed, MOVED out of Multitasking into
// the Observations panel as its second tab. Timeline-STYLE like Observations: collapsible category
// subsections (Edits · Commands · Reads · Searches · Egress · To-dos), each action TIMESTAMPED; an
// edit-action drills into its review. Backed by the SAME core aggregation the CLI's multitask uses
// (buildActionGroups minus the Subagents category — those are the Overview fleet's rows — + egress).
type ActNode =
  | { kind: 'agroup'; label: string; count: number; errors: number; icon: string; actions: core.ActionRecord[] }
  | { kind: 'egroup'; channels: core.EgressChannel[] }
  | { kind: 'arow'; rec: core.ActionRecord }
  | { kind: 'erow'; ch: core.EgressChannel };

/** Category → codicon for the timeline's collapsible subsection headers + rows. */
const ACTION_ICON: Record<string, string> = {
  edit: 'edit', exec: 'terminal', read: 'file', search: 'search', web: 'globe',
  agent: 'organization', todo: 'checklist', mcp: 'plug', meta: 'gear', other: 'circle-small',
};

class ActionsProvider implements vscode.TreeDataProvider<ActNode> {
  private readonly _c = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._c.event;
  view?: vscode.TreeView<ActNode>;
  refresh(): void {
    this._c.fire();
    if (this.view) {
      const session = currentSession();
      this.view.description = session ? `session ${shortId(session)}` : undefined;
    }
  }
  /** Curated groups (Subagents dropped — they're the Overview fleet) + the egress sub-report, from core. */
  private groups(): { groups: core.ActionGroup[]; egress: core.EgressChannel[] } {
    const session = currentSession();
    const cwd = workspaceRoot();
    if (!session || !cwd) return { groups: [], egress: [] };
    const actions = core.parseActions(cwd, session);
    return {
      groups: core.buildActionGroups(actions).filter((g) => g.category !== 'agent'),
      egress: core.buildEgressReport(actions),
    };
  }
  getChildren(node?: ActNode): ActNode[] {
    if (!node) {
      const { groups, egress } = this.groups();
      const feed: ActNode[] = groups.map((g): ActNode => ({
        kind: 'agroup', label: g.label, count: g.count, errors: g.errors,
        icon: ACTION_ICON[g.category] ?? 'circle-small', actions: g.actions,
      }));
      if (egress.length) feed.push({ kind: 'egroup', channels: egress });
      return feed;
    }
    if (node.kind === 'agroup') return node.actions.slice().reverse().map((rec): ActNode => ({ kind: 'arow', rec })); // newest-first
    if (node.kind === 'egroup') return node.channels.map((ch): ActNode => ({ kind: 'erow', ch }));
    return [];
  }
  getTreeItem(node: ActNode): vscode.TreeItem {
    if (node.kind === 'agroup') {
      // Collapsed by default — the panel opens as a compact list of category headers; expand on demand.
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
      const shown = node.actions.length < node.count ? `${node.actions.length} of ${node.count}` : `${node.count}`;
      item.description = `${shown}${node.errors ? ` · ${node.errors} err` : ''}`;
      item.iconPath = new vscode.ThemeIcon(node.icon);
      item.contextValue = 'actionGroup';
      return item;
    }
    if (node.kind === 'egroup') {
      const item = new vscode.TreeItem('Egress', vscode.TreeItemCollapsibleState.Collapsed);
      item.description = `${node.channels.length}`;
      item.iconPath = new vscode.ThemeIcon('radio-tower');
      item.contextValue = 'actionGroup';
      return item;
    }
    if (node.kind === 'erow') {
      const ch = node.ch;
      const item = new vscode.TreeItem(ch.target, vscode.TreeItemCollapsibleState.None);
      item.description = `${ch.kind} · ${ch.scope}${ch.count > 1 ? ` ×${ch.count}` : ''}`;
      item.iconPath = new vscode.ThemeIcon(
        ch.scope === 'remote' ? 'radio-tower' : 'plug',
        ch.scope === 'remote' ? new vscode.ThemeColor('charts.red') : undefined
      );
      item.tooltip = `${ch.kind} egress → ${ch.target} (${ch.scope})`;
      return item;
    }
    // One action row — timestamped, timeline-style; an edit-action drills into its review (viewChanges).
    const rec = node.rec;
    const d = new Date(rec.ts);
    const hhmm = rec.ts ? [d.getHours(), d.getMinutes()].map((x) => String(x).padStart(2, '0')).join(':') : '--:--';
    const edit = rec.editId != null;
    const item = new vscode.TreeItem(`${hhmm}  ${rec.tool}`, vscode.TreeItemCollapsibleState.None);
    const risk = rec.risk ? (rec.risk.level === 'high' ? ' · ⚠ HIGH' : ' · ⚠ med') : '';
    item.description = `${rec.target}${rec.isError ? ' · error' : ''}${risk}`;
    item.tooltip = [
      `${rec.tool}${rec.detail ? ` · ${rec.detail}` : ''}`,
      rec.target,
      rec.reasoning ? `💭 ${rec.reasoning}` : '',
      rec.isError ? '⚠ errored' : '',
      edit ? 'Click to review this edit.' : '',
      rec.ts ? d.toLocaleTimeString() : '',
    ]
      .filter(Boolean)
      .join('\n');
    item.iconPath = rec.isError
      ? new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
      : new vscode.ThemeIcon(edit ? 'edit' : ACTION_ICON[rec.category] ?? 'circle-small');
    if (edit) {
      item.command = { command: 'claudeObservatory.viewChanges', title: 'Review edit', arguments: [rec.editId] };
      item.contextValue = 'actionEdit';
    }
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
  .navbar { display:flex; align-items:center; gap:8px; padding:5px 0 9px; margin-bottom:9px; border-bottom:1px solid var(--vscode-widget-border, rgba(127,127,127,0.25)); }
  .nb-session { display:inline-flex; align-items:center; gap:4px; font-family: var(--vscode-editor-font-family, monospace); font-size:9.5px; color: var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .nb-session::before { content:"🔬"; font-size:10px; }
  .rvc-click { cursor:pointer; }
  .rvc-click:hover { border-color: var(--c-pending); background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
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
      else if(m.type==='counts'){ renderCounts(m.c);
        var se=document.getElementById('nb-session'); if(se && m.session!==undefined){ se.textContent = m.session || '—'; se.title = m.session ? ('Active session: '+m.session) : 'No active Claude Code session'; }
      }
      else if(m.type==='stats'){ STATS=m.data; drawStats(); }
      else if(m.type==='statsError' && !STATS){ var g=document.getElementById('gathering'); if(g) g.innerHTML='⚠ stats need the <b>claude-observatory</b> CLI, which was not found.<br><span class="dim">install it with <b>./install.sh</b> (or <b>npm i -g ./packages/cli</b> from the repo), then reload.</span>'; }
    });
    (function(){ var segs=document.querySelectorAll('.seg'); for(var i=0;i<segs.length;i++){ segs[i].addEventListener('click',function(){ range=this.getAttribute('data-r'); vscode.setState({range:range}); drawStats(); }); }
      var pc=document.getElementById('rv-pending-cell'); if(pc){ pc.addEventListener('click',function(){ vscode.postMessage({type:'reviewFirst'}); }); }
      drawStats(); vscode.postMessage({type:'ready'}); })();
  `;
  // Live review scoreboard (independent of the time range): current pending/accepted/reverted counts
  // and a progress bar that fills as edits get reviewed — updated on every store change via postMessage.
  const reviewHtml =
    `<div class="review">` +
    `<div class="rvcounts">` +
    `<div class="rvc rvc-click" id="rv-pending-cell" title="Jump to the first edit to review"><span class="rvn" id="rv-pending" style="color:var(--c-pending)">0</span><span class="rvl">pending</span></div>` +
    `<div class="rvc"><span class="rvn" id="rv-kept" style="color:var(--c-kept)">0</span><span class="rvl">accepted</span></div>` +
    `<div class="rvc"><span class="rvn" id="rv-undone" style="color:var(--c-reverted)">0</span><span class="rvl">reverted</span></div>` +
    `</div>` +
    `<div class="rvbar"><span class="rvfill" id="rv-fill"></span></div>` +
    `<div class="rvmeta"><span id="rv-progress">no edits yet</span><span id="rv-rate"></span></div>` +
    `</div>`;
  const navbarHtml =
    `<div class="navbar">` +
    `<span class="nb-session" id="nb-session" title="Active Claude Code session">—</span>` +
    `</div>`;
  const body =
    navbarHtml +
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

// --- Change Map webview (0.7.5): the session as one compact, ranked read -------------------------
// Chapters (Claude's own to-dos) across the top, a one-row proportion strip for "where did the work
// land", then every touched file ranked by churn with a bar each. Deliberately NOT a treemap: 2-D
// tiles degenerate the moment one file dwarfs the rest (a +921 write next to a +1 tweak), and their
// geometry fights a short panel column — clipped labels, stretched aspect. A sorted bar list reads at
// any width and never clips. Every row drills to the real edit review via viewChanges. Data comes from
// the CLI `changemap --json` (the single backend, so JetBrains renders the identical model), pushed in
// via postMessage; the shell HTML is set once.

// The webview client. Plain ES5 concatenation on purpose (no template literals / no ${…}) so this can
// live inside a TS template literal without escaping — the only interpolation is the script nonce.

/** The combined Overview webview (0.8.0 round 3): MASTER–DETAIL. LEFT NAV = two sub-tabs, Fleet
 *  (running agents + nested subagents) · Workflows (runs), rendered from the `multitask --json` payload
 *  (live phase, sparkline, ±lines, tokens, time, risk, collisions) with an Active-only toggle +
 *  Clear-completed. RIGHT DETAIL = the change-map (named-chapter ribbon · module strip · churn ledger)
 *  for the SELECTED nav item, from `changemap --json` — CM.agents[] joined by session, CM.workflows[] by
 *  id. Rendered ONCE; both payloads arrive via postMessage (no reload flash). */
function changeMapShell(): string {
  const nonce = getNonce();
  // font-src data: — the review nav bar renders VS Code codicons via a base64 data-URI @font-face (CODICON_STYLE),
  // matching the status-bar nav bar's glyphs. Self-contained; no localResourceRoots needed.
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; script-src 'nonce-${nonce}';`;
  const style = `<style>${CODICON_STYLE}
  :root {
    --cm-pending: var(--vscode-charts-yellow, #d9a441);
    --cm-kept: var(--vscode-charts-green, #3fb950);
    --cm-reverted: var(--vscode-descriptionForeground, #9aa0aa);
    --cm-risk: var(--vscode-charts-red, #e5534b);
    --cm-agent: var(--vscode-charts-purple, #9a6ac2);
    --cm-accent: var(--vscode-charts-blue, #4c8bf5);
    --cm-border: var(--vscode-widget-border, rgba(127,127,127,0.28));
    --cm-mono: var(--vscode-editor-font-family, monospace);
    --mt-working: var(--vscode-charts-blue, #4c8bf5);
    --mt-attn: var(--vscode-charts-orange, #d9822b);
    --mt-warn: var(--vscode-charts-red, #e5534b);
    --mt-idle: var(--vscode-descriptionForeground, #9aa0aa);
    --mt-done: var(--vscode-charts-green, #3fb950);
    --mt-agent: var(--vscode-charts-purple, #9a6ac2);
    --mt-spark: var(--vscode-charts-blue, #4c8bf5);
  }
  * { box-sizing: border-box; }
  body { margin:0; padding:0; font-family: var(--vscode-font-family); font-size:11px; color: var(--vscode-foreground); height:100vh; display:flex; flex-direction:column; }
  /* top navbar — session selector + session-wide review actions (mirrors the Observations toolbar) */
  .ov-toolbar { flex:none; display:flex; align-items:center; gap:6px; padding:5px 8px; border-bottom:1px solid var(--cm-border); flex-wrap:wrap; }
  .ov-tb { display:inline-flex; align-items:center; gap:5px; background:transparent; border:1px solid var(--cm-border); border-radius:5px; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; padding:3px 9px; cursor:pointer; white-space:nowrap; }
  .ov-tb:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); color: var(--vscode-foreground); }
  .ov-tb.sess { font-family: var(--cm-mono); color: var(--vscode-foreground); }
  /* Active-only toggle: dim + hollow when off, accent-outlined with a green check when on. */
  .ov-toggle .codicon { opacity:0.3; }
  .ov-toggle.on { color: var(--vscode-foreground); border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  .ov-toggle.on .codicon { opacity:1; color: var(--cm-kept); }
  .ov-tb .cm-caret { font-size:9px; opacity:0.8; }
  /* compact step-through review nav bar (mirrors the status-bar nav bar) — File/Diff axes + per-edit/file actions */
  /* codicons (status-bar-matched glyphs) in the toolbar buttons — sized down to sit with the 11px labels */
  .ov-toolbar .codicon { font-size:14px; line-height:1; }
  .ov-navgrp { display:inline-flex; align-items:center; gap:5px; flex-wrap:wrap; }
  .ov-nb { display:inline-flex; align-items:center; justify-content:center; gap:4px; background:transparent; border:1px solid var(--cm-border); border-radius:4px; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; line-height:1; padding:3px 9px; cursor:pointer; white-space:nowrap; }
  .ov-nb:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); color: var(--vscode-foreground); }
  .ov-nc { font-family: var(--cm-mono); font-size:10px; color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; white-space:nowrap; padding:0 3px; }
  .ov-nbsep { width:1px; align-self:stretch; background: var(--cm-border); margin:1px 5px; }
  /* master–detail: left NAV (Fleet · Workflows) | right change-map DETAIL for the selected nav item */
  .ov { display:flex; flex:1; min-height:0; align-items:stretch; }
  .ov-nav { flex:0 0 25%; min-width:180px; max-width:40%; display:flex; flex-direction:column; border-right:1px solid var(--cm-border); padding:6px 8px 7px; overflow:hidden; }
  .ov-detail { flex:1; min-width:0; display:flex; flex-direction:column; padding:6px 8px 7px; overflow:hidden; }
  /* left-nav sub-tabs (Fleet · Workflows) */
  .ov-navtabs { display:flex; flex:none; gap:4px; margin-bottom:6px; }
  .ov-tab { flex:none; display:flex; align-items:center; gap:6px; background:transparent; border:1px solid var(--cm-border); border-radius:5px 5px 0 0; border-bottom:2px solid transparent; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; padding:4px 12px; cursor:pointer; white-space:nowrap; }
  .ov-tab:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .ov-tab.on { color: var(--vscode-foreground); border-bottom-color: var(--mt-working); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.18)); }
  .ov-tn { font-family: var(--cm-mono); font-size:9px; opacity:0.72; font-variant-numeric:tabular-nums; }
  .ov-ctl { display:flex; align-items:center; gap:8px; margin-bottom:5px; flex:none; flex-wrap:wrap; }
  .ov-pane { flex:1; min-height:0; display:flex; flex-direction:column; }
  .ov-list { flex:1; overflow-y:auto; min-height:0; }
  .ov-empty { padding:12px 2px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  .ov-empty b { color: var(--vscode-foreground); }
  /* display-filter controls (shared by Fleet + Workflows): Active-only toggle + Clear-completed */
  .mt-toggle { display:flex; align-items:center; gap:4px; font-size:10px; color: var(--vscode-descriptionForeground); cursor:pointer; white-space:nowrap; }
  .mt-toggle input { margin:0; cursor:pointer; }
  .mt-clear { background:transparent; border:1px solid var(--cm-border); border-radius:4px; color: var(--vscode-descriptionForeground); font:inherit; font-size:10px; padding:2px 8px; cursor:pointer; white-space:nowrap; }
  .mt-clear:hover:not(:disabled) { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); color: var(--vscode-foreground); }
  .mt-clear:disabled { opacity:0.45; cursor:default; }
  .mt-fbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 5px; font-family: var(--cm-mono); font-size:9.5px; color: var(--vscode-descriptionForeground); }
  .mt-fon { color: var(--mt-working); font-variant-numeric:tabular-nums; }
  .mt-fhide { cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
  .mt-fhide:hover { color: var(--vscode-foreground); }
  /* Fleet: one row per running agent (worktree-sibling) + nested subagents; selected row is outlined */
  .mt-agent { border:1px solid var(--cm-border); border-radius:5px; margin-bottom:5px; padding:5px 7px; cursor:pointer; }
  .mt-agent:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .mt-agent.sel { border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  .mt-arow { display:flex; align-items:center; gap:7px; }
  .mt-badge { color:#fff; font-size:9px; font-weight:600; padding:1px 6px; border-radius:99px; white-space:nowrap; flex:none; }
  .mt-badge.sm { font-size:8px; padding:0 5px; }
  .mt-badge.xs { padding:0; width:8px; height:8px; border-radius:99px; }
  .mt-wt { font-family: var(--cm-mono); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; min-width:40px; }
  .mt-self { font-size:8px; color: var(--vscode-editor-background,#1e1e1e); background: var(--mt-idle); border-radius:3px; padding:0 3px; margin-left:5px; }
  .mt-br { font-size:9px; color: var(--vscode-descriptionForeground); margin-left:5px; }
  .mt-spark { width:60px; height:16px; flex:none; margin-left:auto; }
  .mt-spark rect { fill: var(--mt-spark); }
  .mt-diff { font-family: var(--cm-mono); font-size:9.5px; flex:none; font-variant-numeric:tabular-nums; }
  .mt-diff.sm { font-size:9px; }
  .mt-add { color: var(--mt-done); }
  .mt-rem { color: var(--mt-warn); }
  .mt-meta { font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); flex:none; white-space:nowrap; }
  .mt-risk { font-size:9px; color: var(--mt-attn); flex:none; }
  .mt-risk[data-high] { color: var(--mt-warn); font-weight:600; }
  .mt-col { font-size:9px; color: var(--mt-warn); flex:none; }
  .mt-sub { display:flex; align-items:center; gap:6px; padding:3px 0 0 10px; margin-top:3px; border-top:1px dashed var(--cm-border); }
  .mt-st { font-size:10px; color: var(--mt-agent); white-space:nowrap; flex:none; }
  .mt-sd { color: var(--vscode-descriptionForeground); margin-left:5px; font-style:italic; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .mt-cur { font-size:9px; color: var(--vscode-foreground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; min-width:30px; }
  .mt-todo { font-size:9px; color: var(--vscode-descriptionForeground); flex:none; }
  .mt-chat { margin-left:auto; background:transparent; border:0; cursor:pointer; font-size:11px; padding:0 2px; flex:none; opacity:0.75; }
  .mt-chat:hover { opacity:1; }
  .mt-collisions { flex:none; margin-top:6px; border-top:1px solid var(--cm-border); padding-top:5px; max-height:32%; overflow-y:auto; }
  .mt-chead { font-family: var(--cm-mono); text-transform:uppercase; letter-spacing:0.08em; font-size:9px; color: var(--vscode-descriptionForeground); margin-bottom:4px; }
  .mt-crow { display:flex; align-items:center; gap:8px; font-size:10px; padding:1px 2px; cursor:pointer; border-radius:3px; }
  .mt-crow:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.18)); }
  .mt-cf { font-family: var(--cm-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; }
  .mt-ca { color: var(--vscode-descriptionForeground); flex:none; }
  .mt-cp { color: var(--mt-attn); flex:none; margin-left:auto; }
  .mt-none { padding:10px 2px; color: var(--vscode-descriptionForeground); font-size:11px; }
  /* Workflows: one row per run — informative name, per-phase progress, tokens/time/edits; selected outlined */
  .mt-wf { border:1px solid var(--cm-border); border-radius:5px; margin-bottom:5px; padding:5px 7px; cursor:pointer; }
  .mt-wf:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.08)); }
  .mt-wf.sel { border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.14)); }
  /* A NEWLY-started run pulses twice as the nav auto-focuses it (class dropped after ~3s). */
  .mt-wf.flash { animation: ovwfpulse 1.3s ease-in-out 2; }
  @keyframes ovwfpulse { 50% { box-shadow: 0 0 0 2px var(--cm-accent) inset; } }
  .mt-wrow { display:flex; align-items:flex-start; gap:7px; padding:0; cursor:pointer; }
  .mt-wcar { background:transparent; border:0; color: var(--vscode-descriptionForeground); font:inherit; font-size:13px; line-height:1.25; width:18px; flex:none; cursor:pointer; padding:0; }
  /* The workflow name/description WRAPS to its full text (never clipped) — it's the run's identity and can be
     long; the metrics ride the .mt-wmet line below so nothing competes with it for width. */
  .mt-wname { font-weight:600; color: var(--vscode-foreground); white-space:normal; overflow-wrap:anywhere; flex:1 1 auto; min-width:0; line-height:1.3; }
  /* metrics line under the name: sparkline · ±diff · N ag · tokens · time · edits (indented past the caret) */
  .mt-wmet { display:flex; align-items:center; gap:7px; flex-wrap:wrap; padding:3px 3px 1px 22px; }
  .mt-wmet .mt-spark { margin-left:0; }
  .mt-wmeta { font-family: var(--cm-mono); font-size:10px; color: var(--vscode-descriptionForeground); white-space:nowrap; flex:none; }
  .mt-wsub { padding:0 3px 1px 21px; font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); opacity:0.8; }
  .mt-wphs { padding:1px 3px 2px 21px; font-size:9.5px; color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; }
  .mt-wphg { padding:3px 3px 1px 20px; font-size:9px; text-transform:uppercase; letter-spacing:0.05em; color: var(--vscode-foreground); }
  .mt-wpn { font-family: var(--cm-mono); opacity:0.75; text-transform:none; letter-spacing:0; }
  .mt-wag { display:flex; align-items:center; gap:6px; padding:1px 3px 1px 28px; font-size:11px; }
  .mt-wat { color: var(--vscode-foreground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; min-width:64px; }

  /* right DETAIL — the change-map for the selected nav item */
  /* named-chapter ribbon — a VERTICAL stacked LIST (one chapter per row: status dot · name · ±counts ·
     Accept/Reject/Clear). Completed chapters collapse behind the "N done" toggle. */
  .cm-ribbon { flex:none; margin-bottom:6px; max-height:34%; overflow-y:auto; }
  .cm-rwrap { display:flex; flex-direction:column; gap:2px; }
  .cm-done-list { margin-top:2px; }
  .cm-done-row { display:flex; gap:6px; margin-top:3px; }
  .cm-task { display:flex; align-items:center; gap:8px; width:100%; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.10)); border:1px solid var(--cm-border); border-radius:5px; color:inherit; font:inherit; padding:3px 9px; cursor:default; text-align:left; }
  .cm-task:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.18)); }
  .cm-task:hover .cm-ct { color: var(--vscode-foreground); }
  .cm-task[data-sel] { cursor:pointer; }
  /* the chapter selected in the ribbon — scopes the top-navbar bulk actions to it */
  .cm-task.sel { border-color: var(--cm-accent); background: var(--vscode-list-activeSelectionBackground, rgba(80,120,200,0.18)); }
  .cm-task.sel .cm-ct { color: var(--vscode-foreground); }
  .cm-task.syn { opacity:0.85; } /* the synthetic session chapter — dimmed, display-only */
  .cm-task.syn .cm-cg { opacity:0.6; }
  .cm-cg { width:9px; height:9px; border-radius:99px; flex:none; border:1.5px solid var(--vscode-descriptionForeground); }
  .cm-cg.kept { background: var(--cm-kept); border-color: var(--cm-kept); }
  .cm-cg.pending { border-color: var(--cm-pending); box-shadow: inset 0 -4px 0 var(--cm-pending); }
  .cm-cg.undone { background: var(--cm-reverted); border-color: var(--cm-reverted); }
  .cm-cg.todo { border-style:dashed; }
  .cm-ct { flex:1; min-width:0; font-size:12px; line-height:1.4; color: var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; cursor:pointer; }
  .cm-ce { font-family: var(--cm-mono); font-size:10px; color: var(--vscode-descriptionForeground); flex:none; }
  .cm-tbtns { display:flex; align-items:center; gap:1px; flex:none; margin-left:1px; opacity:0.55; }
  .cm-task:hover .cm-tbtns { opacity:1; }
  .cm-tb { background:transparent; border:0; color:inherit; font:inherit; font-size:14px; line-height:1; padding:2px 5px; cursor:pointer; opacity:0.85; }
  .cm-tb:hover { opacity:1; }
  .cm-tb.ok:hover { color: var(--cm-kept); }
  .cm-tb.rj:hover { color: var(--cm-risk); }
  .cm-tb.ch:hover { color: var(--cm-accent); }
  .cm-done-tog { display:inline-flex; align-items:center; gap:6px; background:transparent; border:1px dashed var(--cm-border); border-radius:99px; color: var(--vscode-descriptionForeground); font:inherit; font-size:12px; padding:3px 9px; cursor:pointer; }
  .cm-done-tog:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.14)); color: var(--vscode-foreground); }
  .cm-clear-done { display:inline-flex; align-items:center; background:transparent; border:1px dashed var(--cm-border); border-radius:99px; color: var(--vscode-descriptionForeground); font:inherit; font-size:11px; padding:3px 9px; cursor:pointer; }
  .cm-clear-done:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.14)); color: var(--vscode-foreground); }
  .cm-caret { font-size:9px; opacity:0.8; }
  /* one-row proportion strip — where the work landed */
  .cm-strip { display:flex; height:17px; border-radius:3px; overflow:hidden; flex:none; margin-bottom:6px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.15)); }
  .cm-sg { border:0; padding:0 4px; cursor:pointer; height:100%; display:flex; align-items:center; justify-content:center; overflow:hidden; min-width:0; }
  .cm-sg + .cm-sg { box-shadow: inset 1px 0 0 var(--vscode-editor-background, #1e1e1e); }
  .cm-sg.sel { outline:1px solid var(--vscode-foreground); outline-offset:-1px; }
  .cm-sl { font-size:9px; color:rgba(0,0,0,.78); font-family: var(--cm-mono); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
  /* ranked ledger */
  .cm-ledger { flex:1; overflow-y:auto; min-height:0; }
  .cm-row { display:flex; align-items:center; gap:6px; width:100%; background:transparent; border:0; color:inherit; font:inherit; padding:2px 3px; cursor:pointer; text-align:left; border-radius:3px; }
  .cm-row:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,0.12)); }
  .cm-dot { width:6px; height:6px; border-radius:2px; flex:none; }
  .cm-fn { font-family: var(--cm-mono); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; min-width:54px; max-width:42%; }
  .cm-ag { color: var(--cm-agent); font-size:7px; margin-left:3px; }
  .cm-rk { color: var(--cm-risk); font-size:9px; margin-left:3px; }
  .cm-md { font-size:8.5px; color: var(--vscode-descriptionForeground); white-space:nowrap; flex:none; }
  .cm-bar { flex:1; height:5px; border-radius:2px; background: var(--vscode-editorWidget-background, rgba(127,127,127,0.18)); overflow:hidden; min-width:20px; }
  .cm-fill { display:block; height:100%; border-radius:2px; }
  .cm-n { font-family: var(--cm-mono); font-size:9px; width:44px; text-align:right; flex:none; font-variant-numeric:tabular-nums; color: var(--vscode-descriptionForeground); }
  .cm-pd { font-family: var(--cm-mono); font-size:9px; width:28px; text-align:right; flex:none; }
  .cm-none { padding:10px 4px; color: var(--vscode-descriptionForeground); }
  .cm-empty { padding:14px 4px; color: var(--vscode-descriptionForeground); line-height:1.5; }
  .cm-empty b { color: var(--vscode-foreground); }
  .cm-readout { font-family: var(--cm-mono); font-size:12px; color: var(--vscode-foreground); margin-top:6px; min-height:16px; flex:none; }
  .cm-readout b { color: var(--vscode-foreground); }
  .cm-tip { position:fixed; pointer-events:none; opacity:0; z-index:9; max-width:300px; background: var(--vscode-editorHoverWidget-background, #252526); color: var(--vscode-editorHoverWidget-foreground, #ccc); border:1px solid var(--vscode-editorHoverWidget-border, rgba(127,127,127,0.3)); border-radius:5px; padding:7px 9px; font-size:10px; box-shadow:0 6px 20px -8px rgba(0,0,0,.6); }
  .cm-tip .tf { font-family: var(--cm-mono); font-weight:600; margin-bottom:2px; }
  .cm-tip .tf .ag { color: var(--cm-agent); }
  .cm-tip .tf .rk { color: var(--cm-risk); }
  .cm-tip .tm { font-family: var(--cm-mono); font-size:9px; color: var(--vscode-descriptionForeground); font-variant-numeric:tabular-nums; word-break:break-all; }
  .cm-tip .tc { font-size:9.5px; color: var(--vscode-descriptionForeground); margin:3px 0 4px; }
  .cm-tip .tw { font-style:italic; border-top:1px solid var(--cm-border); padding-top:4px; }
  .cm-tip .trk { color: var(--cm-risk); margin-top:3px; }
  .cm-tip .ta { color: var(--cm-accent); font-family: var(--cm-mono); font-size:8.5px; margin-top:5px; }
</style>`;
  const body =
    `<div class="ov-toolbar">` +
    // Search leads every nav bar (user rule 2026-07-16 — same position on every surface).
    `<button class="ov-nb" id="ov-search" title="Search edits"><i class="codicon codicon-search"></i> Search</button>` +
    `<button class="ov-tb sess" id="ov-sess" title="Switch session — choose which capture session the Overview shows">🔬 <span id="ov-sess-label">session —</span> <span class="cm-caret">▾</span></button>` +
    // Active-only toggle — mirrors the left-nav checkbox: scopes the fleet/workflow nav AND the change-map
    // detail to work still awaiting review (pending edits / active agents / running workflows).
    `<button class="ov-tb ov-toggle" id="ov-activeonly" aria-pressed="false" title="Show only what's still active — agents/workflows running and edits awaiting review"><i class="codicon codicon-check"></i> Active only</button>` +
    // The step-through review nav bar — File/Diff axes with live n/m position counters + per-edit / per-file
    // actions, the same controls the status-bar nav bar shows. Posts to the existing nav commands.
    `<span class="ov-navgrp">` +
    `<button class="ov-nb" id="ov-fileprev" title="Previous changed file"><i class="codicon codicon-chevron-left"></i></button>` +
    `<span class="ov-nc" id="ov-filecount">File –/–</span>` +
    `<button class="ov-nb" id="ov-filenext" title="Next changed file"><i class="codicon codicon-chevron-right"></i></button>` +
    `<span class="ov-nbsep"></span>` +
    `<button class="ov-nb" id="ov-diffprev" title="Previous edit in this file"><i class="codicon codicon-chevron-up"></i></button>` +
    `<span class="ov-nc" id="ov-diffcount">Diff –/–</span>` +
    `<button class="ov-nb" id="ov-diffnext" title="Next edit in this file"><i class="codicon codicon-chevron-down"></i></button>` +
    `<span class="ov-nbsep"></span>` +
    `<button class="ov-nb" id="ov-navkeep" title="Keep this edit"><i class="codicon codicon-check"></i> Keep</button>` +
    `<button class="ov-nb" id="ov-navundo" title="Undo this edit"><i class="codicon codicon-discard"></i> Undo</button>` +
    `<button class="ov-nb" id="ov-acceptfile" title="Accept every pending edit in this file"><i class="codicon codicon-check-all"></i> Accept File</button>` +
    `<button class="ov-nb" id="ov-rejectfile" title="Reject (revert) every pending edit in this file"><i class="codicon codicon-close-all"></i> Reject File</button>` +
    `<button class="ov-nb" id="ov-clearfile" title="Clear resolved (kept / reverted) edits in this file"><i class="codicon codicon-clear-all"></i> Clear File</button>` +
    `<span class="ov-nbsep"></span>` +
    `<button class="ov-nb" id="ov-spotlight" title="Toggle spotlight — dim unedited lines to highlight Claude’s changes"><i class="codicon codicon-lightbulb"></i> Spotlight</button>` +
    `</span>` +
    `<span class="ov-nbsep"></span>` +
    `<button class="ov-tb" id="ov-keepall" title="Accept all edits in this session"><i class="codicon codicon-check-all"></i> Accept All</button>` +
    `<button class="ov-tb" id="ov-undoall" title="Revert all edits in this session"><i class="codicon codicon-discard"></i> Revert All</button>` +
    `<button class="ov-tb" id="ov-clearres" title="Clear resolved (kept / reverted) edits"><i class="codicon codicon-clear-all"></i> Clear Resolved</button>` +
    `<button class="ov-tb" id="ov-refresh" title="Refresh the Overview"><i class="codicon codicon-refresh"></i> Refresh</button>` +
    `</div>` +
    `<div class="ov">` +
    `<div class="ov-nav">` +
    `<div class="ov-navtabs" id="ov-navtabs"></div>` +
    `<div class="ov-ctl">` +
    `<label class="mt-toggle" title="Show only active agents / running workflows"><input type="checkbox" id="mt-active"> Active only</label>` +
    `<button class="mt-clear" id="mt-clear" title="Hide completed agents &amp; finished workflows (observe-only — never deletes anything)">Clear completed</button>` +
    `</div>` +
    `<div class="ov-empty" id="ov-empty" style="display:none"></div>` +
    `<div class="ov-pane" id="ov-pane-fleet">` +
    `<div class="ov-list" id="ov-fleet"></div>` +
    `<div class="mt-collisions" id="ov-collisions"></div>` +
    `</div>` +
    `<div class="ov-pane" id="ov-pane-workflows" style="display:none"><div class="ov-list" id="ov-workflows"></div></div>` +
    `</div>` +
    `<div class="ov-detail">` +
    `<div class="cm-ribbon" id="cm-ribbon" style="display:none"></div>` +
    `<div class="cm-strip" id="cm-strip"></div>` +
    `<div class="cm-empty" id="cm-detail-empty" style="display:none"></div>` +
    `<div class="cm-ledger" id="cm-ledger"></div>` +
    `<div class="cm-readout" id="cm-readout"></div>` +
    `</div>` +
    `</div>` +
    `<div class="cm-tip" id="cm-tip"></div>` +
    `<script nonce="${nonce}">${OVERVIEW_SCRIPT}</script>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${style}</head><body>${body}</body></html>`;
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
      if (!m) return;
      if (m.type === 'ready') this.refresh();
      else if (m.type === 'reviewFirst') void vscode.commands.executeCommand('claudeObservatory.reviewFirst');
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
    this.view.webview.postMessage({ type: 'counts', c, session: session ?? '' });
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

/** The combined Overview panel (0.8.0 round 3): shells out to BOTH `multitask --json` (the left-nav
 *  Fleet/Workflows payload) AND `changemap --json` (the right-detail change-map) — throttled,
 *  visible-only — and posts both to the master–detail webview, which joins them by session/workflowId.
 *  Clicks come back as {openEdit,id} → the existing edit-review command, {chatAction,ref} → the
 *  zero-token handoff, and {taskKeep|taskUndo|taskClear|clearCompletedChapters} → the chapter ops. */
interface NavPos {
  diff: { i: number; n: number } | null;
  file: { i: number; n: number } | null;
}
class ChangeMapViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private run = 0;
  private running = false;
  private everLoaded = false;
  // The live Diff/File step-through position, mirrored into the title-bar nav-bar counters. Set by the
  // status bar's updateStatusItem (single source of truth); rides the next overview message + a live push.
  private navPos: NavPos | null = null;
  /** Push the Diff/File step-through position into the title-bar nav counters (live, visible-only). */
  setNavPos(pos: NavPos): void {
    this.navPos = pos;
    if (this.view?.visible) this.view.webview.postMessage({ type: 'navpos', pos });
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = changeMapShell(); // set once; data arrives via postMessage (no reload flash)
    view.webview.onDidReceiveMessage((m: { type?: string; id?: number; taskId?: string; ref?: core.ChatContextRef; path?: string }) => {
      if (!m) return;
      if (m.type === 'ready') this.refresh(true);
      else if (m.type === 'openEdit' && typeof m.id === 'number')
        void vscode.commands.executeCommand('claudeObservatory.viewChanges', m.id);
      else if (m.type === 'openPath' && typeof m.path === 'string' && m.path)
        // A live-conflict row — open the contested file itself.
        void vscode.window.showTextDocument(vscode.Uri.file(m.path), { preview: true });
      else if (m.type === 'showReason' && typeof m.id === 'number')
        void vscode.commands.executeCommand('claudeObservatory.showObservation', m.id);
      else if (m.type === 'chatAction' && m.ref)
        void vscode.commands.executeCommand('claudeObservatory.chatAction', m.ref);
      // Chapter (task) review actions from the task-ribbon chips.
      else if (m.type === 'taskKeep' && typeof m.taskId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.taskKeep', m.taskId);
      else if (m.type === 'taskUndo' && typeof m.taskId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.taskUndo', m.taskId);
      else if (m.type === 'taskClear' && typeof m.taskId === 'string')
        void vscode.commands.executeCommand('claudeObservatory.taskClear', m.taskId);
      else if (m.type === 'clearCompletedChapters')
        void vscode.commands.executeCommand('claudeObservatory.clearCompletedChapters');
      // Top-navbar review actions — the session selector + the same bulk actions the Observations toolbar has.
      else if (m.type === 'switchSession')
        void vscode.commands.executeCommand('claudeObservatory.switchSession');
      else if (m.type === 'keepAll')
        void vscode.commands.executeCommand('claudeObservatory.keepAll');
      else if (m.type === 'undoAll')
        void vscode.commands.executeCommand('claudeObservatory.undoAll');
      else if (m.type === 'clearResolved')
        void vscode.commands.executeCommand('claudeObservatory.clearResolved');
      else if (m.type === 'refresh')
        void vscode.commands.executeCommand('claudeObservatory.refresh');
      // Step-through review nav bar (mirrors the status-bar nav bar) — passthrough to the existing commands.
      else if (m.type === 'navFilePrev') void vscode.commands.executeCommand('claudeObservatory.navFilePrev');
      else if (m.type === 'navFileNext') void vscode.commands.executeCommand('claudeObservatory.navFileNext');
      else if (m.type === 'navDiffPrev') void vscode.commands.executeCommand('claudeObservatory.navDiffPrev');
      else if (m.type === 'navDiffNext') void vscode.commands.executeCommand('claudeObservatory.navDiffNext');
      else if (m.type === 'navKeep') void vscode.commands.executeCommand('claudeObservatory.navKeep');
      else if (m.type === 'navUndo') void vscode.commands.executeCommand('claudeObservatory.navUndo');
      else if (m.type === 'keepOpenFile') void vscode.commands.executeCommand('claudeObservatory.keepOpenFile');
      else if (m.type === 'undoOpenFile') void vscode.commands.executeCommand('claudeObservatory.undoOpenFile');
      else if (m.type === 'clearOpenFile') void vscode.commands.executeCommand('claudeObservatory.clearOpenFile');
      else if (m.type === 'toggleHeatmap') void vscode.commands.executeCommand('claudeObservatory.toggleHeatmap');
      else if (m.type === 'searchEdits') void vscode.commands.executeCommand('claudeObservatory.searchEdits');
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) this.refresh(true);
    });
  }
  /** Spawn one CLI subcommand, parse its stdout as JSON, and hand the result (or null on any failure)
   *  to `cb` exactly once. Windows: the .cmd shim needs a shell. */
  private spawnJson(args: string[], cwd: string, cb: (data: unknown | null) => void): void {
    let child: cp.ChildProcess;
    let fired = false;
    const once = (data: unknown | null) => {
      if (fired) return;
      fired = true;
      cb(data);
    };
    try {
      const bin = resolveObservatoryBin();
      const winShell = process.platform === 'win32';
      child = cp.spawn(winShell ? `"${bin}"` : bin, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], shell: winShell });
    } catch {
      once(null);
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => (out += d));
    child.on('error', () => once(null));
    child.on('close', () => {
      try {
        once(JSON.parse(out));
      } catch {
        once(null);
      }
    });
  }
  /** `force` bypasses the coalescing throttle (used on first-open / became-visible). */
  refresh(force = false): void {
    if (!this.view?.visible) return;
    const now = Date.now();
    if (this.running || (!force && now - this.run < 3000)) return;
    const session = currentSession();
    const cwd = workspaceRoot();
    if (!session || !cwd) return;
    this.running = true;
    this.run = now;
    let cm: unknown = undefined;
    let mt: unknown = undefined;
    const done = () => {
      if (cm === undefined || mt === undefined) return; // wait for both spawns
      this.running = false;
      if (cm === null && mt === null) {
        this.postError();
        return;
      }
      this.everLoaded = true;
      // The per-agent tab model (host-derived so the webview stays a pure renderer). Both payloads ride
      // along; the webview joins CM.agents[]/CM.workflows[] to the MT nav by session/workflowId. The
      // active session rides along too so the top navbar's session selector shows what it's viewing.
      // The Search-edits filter reaches the detail ledger too — not only the sidebar trees.
      this.view?.webview.postMessage({ type: 'overview', cm, mt, session, navPos: this.navPos, filter: editFilter });
    };
    // changemap --json: the right-detail change-map (+ per-agent / per-workflow slices).
    this.spawnJson(['changemap', '--json', '--root', cwd, '--session', session], cwd, (data) => {
      const d = data as (core.ChangeMap & { agents?: unknown[] }) | null;
      cm = d && d.summary && Array.isArray(d.edits) && Array.isArray(d.files) && Array.isArray(d.modules) && Array.isArray(d.agents) ? d : null;
      done();
    });
    // multitask --json: the left-nav Fleet/Workflows payload (live phase, sparkline, tokens/time, risk).
    this.spawnJson(['multitask', '--json', '--root', cwd, '--session', session], cwd, (data) => {
      const d = data as { agents?: unknown[]; collisions?: unknown[] } | null;
      mt = d && Array.isArray(d.agents) && Array.isArray(d.collisions) ? d : null;
      done();
    });
  }
  private postError(): void {
    if (!this.everLoaded) this.view?.webview.postMessage({ type: 'error' });
  }
}

// --- Overview left-nav filter (0.8.0 round 3): real-time multi-agent observability --------------
// The combined Overview panel's LEFT NAV renders `multitask --json` (the single backend): one row per
// running agent across every worktree of this repo (live phase incl. awaiting-permission, worktree+
// branch, a 20-bin activity sparkline, ±diff, tokens/time, risk count, a collision warning), each with
// its nested subagents, plus the Workflows runs — a THIN renderer (no client aggregation) that rides the
// transcript watcher's refreshAll. Subagent rows hand off a zero-token chat via claudeObservatory.chatAction.

/** The Overview nav's two DISPLAY filters — Active-only + Clear-completed — as ONE pure function over
 *  the raw `multitask --json` payload. Single source of truth for BOTH the smoke test (which drives it
 *  off fabricated payloads) AND the webview: the client keeps the transient toggle / dismissed-set
 *  state and calls THIS SAME function (embedded verbatim via .toString() into OVERVIEW_SCRIPT), so the
 *  filter the test verifies is byte-for-byte the one the UI runs — no drift. Zero-token, no core/CLI
 *  change (a thin renderer on top of agent.phase / subagent.phase / workflow.running).
 *
 *  Classification is PURE from the payload: an agent is "active" when its own phase is
 *  working/awaiting-input/awaiting-permission OR any of its subagents is; a workflow is active when
 *  `running`. `activeOnly` hides the inactive; `dismissed*` hides completed items the user cleared — but
 *  a dismissed item REAPPEARS the moment it goes active again (dismissal only bites while inactive). */
export interface MultitaskFilterState {
  activeOnly?: boolean;
  dismissedAgents?: Record<string, unknown>;
  dismissedWorkflows?: Record<string, unknown>;
}
export const multitaskFilter = (
  data:
    | {
        agents?: Array<{ session?: string; phase?: string | null; subagents?: Array<{ phase?: string | null }> }>;
        workflows?: Array<{ id?: string; running?: boolean }>;
      }
    | null
    | undefined,
  state: MultitaskFilterState | null | undefined
) => {
  const st = state || {};
  const activeOnly = !!st.activeOnly;
  const dAg = st.dismissedAgents || {};
  const dWf = st.dismissedWorkflows || {};
  const isActive = (p: string | null | undefined) =>
    p === "working" || p === "awaiting-input" || p === "awaiting-permission";
  const agentActive = (a: { phase?: string | null; subagents?: Array<{ phase?: string | null }> }) => {
    if (isActive(a && a.phase)) return true;
    const subs = (a && a.subagents) || [];
    for (let i = 0; i < subs.length; i++) if (isActive(subs[i] && subs[i].phase)) return true;
    return false;
  };
  const allAg = (data && data.agents) || [];
  const agents: typeof allAg = [];
  const completedAgents: string[] = [];
  let activeAgents = 0;
  let hiddenAgents = 0;
  for (let i = 0; i < allAg.length; i++) {
    const a = allAg[i];
    const act = agentActive(a);
    if (act) activeAgents++;
    else completedAgents.push(String(a && a.session));
    if (activeOnly && !act) continue; // active-only hides the inactive outright
    if (!act && dAg[String(a && a.session)]) {
      hiddenAgents++;
      continue;
    } // dismissed — but only while still inactive (reappears when it goes active)
    agents.push(a);
  }
  const allWf = (data && data.workflows) || [];
  const workflows: typeof allWf = [];
  const completedWorkflows: string[] = [];
  let activeWorkflows = 0;
  let hiddenWorkflows = 0;
  for (let j = 0; j < allWf.length; j++) {
    const w = allWf[j];
    const run = !!(w && w.running);
    if (run) activeWorkflows++;
    else completedWorkflows.push(String(w && w.id));
    if (activeOnly && !run) continue;
    if (!run && dWf[String(w && w.id)]) {
      hiddenWorkflows++;
      continue;
    }
    workflows.push(w);
  }
  return {
    agents,
    workflows,
    completedAgents,
    completedWorkflows,
    totalAgents: allAg.length,
    activeAgents,
    hiddenAgents,
    totalWorkflows: allWf.length,
    activeWorkflows,
    hiddenWorkflows,
  };
};

// Plain ES5 concatenation (no template literals / no ${…}) so this lives inside a TS template literal
// without escaping — the only interpolation is the embedded multitaskFilter source (see below).
const OVERVIEW_SCRIPT = `
(function(){
  "use strict";
  var vscode=acquireVsCodeApi();
  // Combined Overview (0.8.0 round 3) — MASTER–DETAIL. LEFT NAV: Fleet (running agents + subagents) ·
  // Workflows (runs), rendered from the multitask --json payload (MT). RIGHT DETAIL: the change-map
  // (named-chapter ribbon · module strip · churn ledger) for the SELECTED nav item, from changemap
  // --json (CM) — CM.agents[] joined by session, CM.workflows[] by id. Default select = the orchestrator.
  var CM=null, MT=null, SEL=null, NAV='fleet', PAL={}, WF_OPEN={}, MOD=null, ROWS=[], RIB_OPEN=false, SELF_KEY=null, SEEN_WF=null, FLASH_WF=null;
  // SEL_CH = the chapter selected in the ribbon ({id,label}) — scopes the top-navbar bulk actions to it;
  // null → session-wide. NAVPOS = the live Diff/File step-through position for the nav-bar counters.
  var SEL_CH=null, NAVPOS=null;
  var ACTIVE_ONLY=false, DISMISS_AG={}, DISMISS_WF={};
  var tip=document.getElementById('cm-tip');
  // The one DISPLAY filter (Active-only / Clear-completed), embedded VERBATIM from the host's exported
  // multitaskFilter so the UI runs the exact code the smoke test verifies. Pure over the MT payload.
  var MTFILTER = ${multitaskFilter.toString()};
  function fstate(){ return { activeOnly:ACTIVE_ONLY, dismissedAgents:DISMISS_AG, dismissedWorkflows:DISMISS_WF }; }
  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function base(p){ if(!p) return ''; var s=String(p); var i=s.lastIndexOf('/'); return i>=0? s.slice(i+1): s; }
  function readPal(){ var cs=getComputedStyle(document.documentElement); function v(n,d){ return (cs.getPropertyValue(n)||'').trim()||d; }
    PAL={ pending:v('--cm-pending','#d9a441'), kept:v('--cm-kept','#3fb950'), reverted:v('--cm-reverted','#9aa0aa'), risk:v('--cm-risk','#e5534b'), agent:v('--cm-agent','#9a6ac2'), accent:v('--cm-accent','#4c8bf5'),
      working:v('--mt-working','#4c8bf5'), attn:v('--mt-attn','#d9822b'), warn:v('--mt-warn','#e5534b'), idle:v('--mt-idle','#9aa0aa'), done:v('--mt-done','#3fb950') }; }
  var PHASE={ 'working':'working', 'awaiting-input':'awaiting input', 'awaiting-permission':'awaiting permission', 'idle':'idle', 'errored':'errored', 'done':'done' };
  function phaseColor(p){ if(p==='working') return PAL.working; if(p==='awaiting-input'||p==='awaiting-permission') return PAL.attn; if(p==='errored') return PAL.warn; if(p==='done') return PAL.done; return PAL.idle; }
  function phaseLabel(p){ return PHASE[p] || (p||'—'); }
  function fmtTok(n){ n=n||0; if(n>=1e6) return (n/1e6).toFixed(1)+'M'; if(n>=1e3) return Math.round(n/1e3)+'k'; return ''+n; }
  function fmtDur(ms){ ms=ms||0; var s=Math.round(ms/1000); if(s<60) return s+'s'; var m=Math.round(s/60); if(m<60) return m+'m'; return (m/60).toFixed(1)+'h'; }
  function spark(arr){ arr=arr||[]; var n=arr.length||1, max=1; for(var i=0;i<arr.length;i++) if(arr[i]>max) max=arr[i];
    var w=100,h=16,bw=w/n,g=''; for(var j=0;j<arr.length;j++){ var bh=arr[j]>0? Math.max(1.2, arr[j]/max*h):0; g+='<rect x="'+(j*bw).toFixed(2)+'" y="'+(h-bh).toFixed(2)+'" width="'+(bw*0.72).toFixed(2)+'" height="'+bh.toFixed(2)+'"/>'; }
    return '<svg class="mt-spark" viewBox="0 0 '+w+' '+h+'" preserveAspectRatio="none">'+g+'</svg>'; }
  function riskCount(r){ if(r==null) return 0; if(typeof r==='number') return r; return r.total||0; }
  function riskHigh(r){ return (r&&typeof r==='object')? (r.high||0):0; }
  function agentCollisions(a){ var c=(MT&&MT.collisions)||[]; var hit=0; for(var i=0;i<c.length;i++){ var ags=c[i].agents||[]; if(ags.indexOf(a.session)>=0) hit++; } return hit; }

  // --- selection + detail slice (join the MT nav to the CM detail by session / workflowId) -----------
  function selfSession(){ var ag=(MT&&MT.agents)||[]; for(var i=0;i<ag.length;i++){ if(ag[i].self) return ag[i].session; } return ag.length?ag[0].session:''; }
  function cmAgent(s){ var ag=(CM&&CM.agents)||[]; for(var i=0;i<ag.length;i++) if(ag[i].session===s) return ag[i]; return null; }
  function wfById(id){ var ws=(CM&&CM.workflows)||[]; for(var i=0;i<ws.length;i++) if(ws[i].id===id) return ws[i]; return null; }
  function selAgentSess(){ return SEL&&SEL.kind==='agent'?SEL.session:null; }
  function selWf(){ return SEL&&SEL.kind==='workflow'?SEL.id:null; }
  // Default DETAIL = the orchestrator (the self agent), else the first agent, else the first workflow.
  function ensureSel(){
    if(SEL){ if(SEL.kind==='agent' && cmAgent(SEL.session)) return; if(SEL.kind==='workflow' && wfById(SEL.id)) return; }
    var s=selfSession(); if(s && cmAgent(s)){ SEL={kind:'agent', session:s}; return; }
    var ag=(CM&&CM.agents)||[]; if(ag.length){ SEL={kind:'agent', session:ag[0].session}; return; }
    var wf=(CM&&CM.workflows)||[]; if(wf.length){ SEL={kind:'workflow', id:wf[0].id}; return; }
    SEL = s ? {kind:'agent', session:s} : null;
  }
  // A synthetic per-workflow detail slice: its rollup → chips, files → strip/ledger, and its OWN chapter
  // ribbon (w.chapters — the run's edits regrouped by session chapter, aggregated in core). Total chapters
  // partition the run exactly, so the old "run total minus chaptered" residual math is gone.
  function workflowSlice(id){ var w=wfById(id); if(!w) return CM;
    var r=w.rollup||{edits:0,added:0,removed:0,pending:0,kept:0,undone:0};
    return { summary:{ session:w.name, units:r.edits, pending:r.pending, kept:r.kept, undone:r.undone, added:r.added, removed:r.removed, subagents:0, errors:0 }, files:w.files||[], modules:[], chapters:w.chapters||[], rollupByTask:[] }; }
  // A not-found agent yields an EMPTY slice (not the whole self change-map) so a stale/lagging selection shows
  // "no edits yet" rather than silently falling back to the orchestrator's chapters.
  function detailSlice(){ if(!SEL) return CM; if(SEL.kind==='workflow') return workflowSlice(SEL.id); return cmAgent(SEL.session)||{ summary:null, files:[], modules:[], chapters:[], rollupByTask:[] }; }

  // --- right DETAIL rendering (change-map for the selected nav item) ---------------------------------
  function colorOf(st){ return st==='pending'?PAL.pending:(st==='undone'?PAL.reverted:PAL.kept); }
  function weight(o){ return Math.max(1,o.churn); }
  function modLabel(m){ var ms=(detailSlice()||{}).modules||[]; for(var i=0;i<ms.length;i++) if(ms[i].module===m) return ms[i].label; return m; }
  function rankedFiles(){ return ((detailSlice()||{}).files||[]).slice(); }
  function rankedModules(){ return ((detailSlice()||{}).modules||[]).slice(); }
  // Active-only (shared with the fleet/workflow nav toggle) also scopes the change-map DETAIL to work still
  // awaiting review — a file/chapter with no pending edits drops out, so a fully-reviewed slice reads empty.
  var FILTER='';
  function visible(f){ if(MOD!==null && f.moduleLabel!==MOD) return false; if(ACTIVE_ONLY && !(f.pending>0)) return false;
    if(FILTER && String(f.rel||f.file||'').toLowerCase().indexOf(FILTER.toLowerCase())<0) return false; return true; }
  function taskChip(it){
    // ✓/↩/🧹 act WYSIWYG on the chapter's DISPLAYED edits, keyed by chapter id (the synthetic session
    // chapter included) — core.reviewEditIds resolves the exact set. 💬 needs the strict taskId (task
    // framing for chat-context), so it hides on the synthetic chapter and duplicate occurrences.
    var canAct = it.id!=null && it.r.edits>0;
    var selectable = canAct; // any chapter with edits can scope the bulk actions
    var cid = esc(it.id==null?'':it.id);
    var tid = esc(it.taskId==null?'':it.taskId);
    var isSel = selectable && SEL_CH && SEL_CH.id===String(it.id);
    var btns = (canAct || it.taskId!=null) ? ('<span class="cm-tbtns">'+
        (it.taskId!=null?'<button class="cm-tb ch" data-chat="'+tid+'" title="Chat about this chapter — copies context, opens your Claude">💬</button>':'')+
        (canAct?('<button class="cm-tb ok" data-keep="'+cid+'" title="Accept — keep all pending edits shown in this chapter">✓</button>'+
          '<button class="cm-tb rj" data-undo="'+cid+'" title="Reject — undo all pending edits shown in this chapter">↩</button>'+
          '<button class="cm-tb cl" data-clear="'+cid+'" title="Clear — drop resolved (kept/undone) edits in this chapter">🧹</button>'):'')+
        '</span>') : '';
    return '<span class="cm-task'+(it.syn?' syn':'')+(isSel?' sel':'')+'"'+(selectable?' data-sel="'+cid+'"':'')+' title="'+esc(it.label)+' — '+it.r.edits+' edit(s) · '+it.st+(it.syn?' · work outside any to-do, attributed to the session':'')+(selectable?' · click to scope the bulk actions to this chapter':'')+'">'+
      '<span class="cm-cg '+it.st+'"></span>'+
      '<span class="cm-ct" data-task="'+cid+'">'+esc(it.label)+'</span>'+
      (it.r.edits?'<span class="cm-ce">+'+it.r.added+' −'+it.r.removed+'</span>':'')+
      btns+
      '</span>';
  }
  // Truncate a chapter name for the scoped bulk-button labels.
  function clipCh(s){ s=String(s==null?'':s); return s.length>16? s.slice(0,15)+'…' : s; }
  // Relabel the top-navbar bulk buttons to reflect the current scope: a selected chapter → "…in <chapter>",
  // else session-wide. textContent is injection-safe (no HTML), so the raw chapter name is fine here.
  function relabelBulk(){ var nm=SEL_CH? clipCh(SEL_CH.label):'';
    // innerHTML (not textContent) so the codicon <i> survives; esc() the label since it's user content.
    function set(id, icon, base, scoped, tip, tipScoped){ var b=document.getElementById(id); if(!b) return; b.innerHTML='<i class="codicon codicon-'+icon+'"></i> '+esc(SEL_CH?scoped:base); b.title=SEL_CH?tipScoped:tip; }
    set('ov-keepall','check-all','Accept All','Accept All in '+nm,'Accept all edits in this session','Accept all pending edits in the “'+nm+'” chapter');
    set('ov-undoall','discard','Revert All','Revert All in '+nm,'Revert all edits in this session','Revert all pending edits in the “'+nm+'” chapter');
    set('ov-clearres','clear-all','Clear Resolved','Clear in '+nm,'Clear resolved (kept / reverted) edits','Clear resolved edits in the “'+nm+'” chapter');
  }
  // Toggle a ribbon chip's selection: pick it (scoping the bulk actions), or deselect if already picked.
  function toggleChapter(id, el){ if(!id) return;
    if(SEL_CH && SEL_CH.id===id){ SEL_CH=null; }
    else { var ct=el.querySelector('.cm-ct'); SEL_CH={ id:id, label: ct? ct.textContent : id }; }
    renderRibbon(); // re-renders the ribbon (selected state) and relabels the bulk buttons
  }
  // 0.8.0: the ribbon renders the slice's NAMED CHAPTERS (chapters[]), which are TOTAL — core appends a
  // synthetic session chapter for work outside any to-do, so every edit is under a named goal and no
  // "unassigned" row can exist. ✓/↩/🧹 resolve WYSIWYG via chapter.id (core.reviewEditIds — exactly the
  // edits the row shows, synthetic included); 💬 chat stays gated on the strict taskId (task framing).
  function renderRibbon(){ var host=document.getElementById('cm-ribbon'); var a=detailSlice()||{};
    var chs=a.chapters||[]; var items=[];
    // Active-only: keep only chapters with pending (unreviewed) edits — drops resolved AND wip-but-idle
    // chapters (e.g. a still-open to-do whose edits were all cleared), so clearing everything empties the ribbon.
    for(var c=0;c<chs.length;c++){ var ch=chs[c];
      if(ACTIVE_ONLY ? !(ch.pending>0) : !(ch.edits>0 || ch.status==='wip')) continue;
      items.push({ id:ch.id, taskId:(ch.taskId!=null?ch.taskId:null), label:ch.title, syn:!!ch.synthetic, r:{edits:ch.edits,added:ch.added,removed:ch.removed,pending:ch.pending,kept:ch.kept,undone:ch.undone}, wip:ch.status==='wip' }); }
    // Keep the chapter selection valid against the current slice (refresh its label; drop it if it vanished).
    if(SEL_CH){ var f=null; for(var v=0;v<items.length;v++){ if(items[v].id!=null && String(items[v].id)===SEL_CH.id){ f=items[v]; break; } } if(f) SEL_CH.label=f.label; else SEL_CH=null; }
    if(!items.length){ host.style.display='none'; host.innerHTML=''; relabelBulk(); return; }
    var active=[], done=[];
    for(var k=0;k<items.length;k++){ var it=items[k];
      it.st = it.r.pending>0?'pending':(it.r.undone>0?'undone':(it.r.edits>0?'kept':'todo'));
      (it.wip || it.r.pending>0 || it.r.undone>0 ? active : done).push(it);
    }
    host.style.display='block'; var h='<div class="cm-rwrap">';
    for(var i=0;i<active.length;i++) h+=taskChip(active[i]);
    if(done.length){ h+='<div class="cm-done-row">'+
      '<button class="cm-done-tog" title="'+done.length+' completed chapter(s)"><span class="cm-cg kept"></span>'+done.length+' done <span class="cm-caret">'+(RIB_OPEN?'▾':'▸')+'</span></button>'+
      '<button class="cm-clear-done" title="Clear resolved (kept/undone) edits of every completed chapter">🧹 clear completed</button></div>'; }
    h+='</div>';
    if(done.length && RIB_OPEN){ h+='<div class="cm-rwrap cm-done-list">'; for(var d=0;d<done.length;d++) h+=taskChip(done[d]); h+='</div>'; }
    host.innerHTML=h;
    var tog=host.querySelector('.cm-done-tog');
    if(tog) tog.addEventListener('click', function(){ RIB_OPEN=!RIB_OPEN; renderRibbon(); });
    var cd=host.querySelector('.cm-clear-done');
    if(cd) cd.addEventListener('click', function(){ vscode.postMessage({type:'clearCompletedChapters'}); });
    // click a chapter chip → toggle its selection (scopes the top-navbar bulk actions to it)
    var sc=host.querySelectorAll('.cm-task[data-sel]');
    for(var s2=0;s2<sc.length;s2++) sc[s2].addEventListener('click', function(){ toggleChapter(this.getAttribute('data-sel'), this); });
    // the chip's 💬 hands off a zero-token chat about that chapter (kept from the old title click)
    var chb=host.querySelectorAll('.cm-tb.ch');
    for(var w2=0;w2<chb.length;w2++) chb[w2].addEventListener('click', function(ev){ ev.stopPropagation(); var id=this.getAttribute('data-chat'); if(id) vscode.postMessage({type:'chatAction', ref:{taskId:id}}); });
    var ok=host.querySelectorAll('.cm-tb.ok');
    for(var o=0;o<ok.length;o++) ok[o].addEventListener('click', function(ev){ ev.stopPropagation(); var id=this.getAttribute('data-keep'); if(id) vscode.postMessage({type:'taskKeep', taskId:id}); });
    var rj=host.querySelectorAll('.cm-tb.rj');
    for(var r=0;r<rj.length;r++) rj[r].addEventListener('click', function(ev){ ev.stopPropagation(); var id=this.getAttribute('data-undo'); if(id) vscode.postMessage({type:'taskUndo', taskId:id}); });
    var cl=host.querySelectorAll('.cm-tb.cl');
    for(var q=0;q<cl.length;q++) cl[q].addEventListener('click', function(ev){ ev.stopPropagation(); var id=this.getAttribute('data-clear'); if(id) vscode.postMessage({type:'taskClear', taskId:id}); });
    relabelBulk();
  }
  function renderStrip(){ var mods=rankedModules();
    // Cap the strip: a busy session can span dozens of modules, which squeezes every segment (and its
    // label) into unreadable slivers — keep the top movers, merge the tail into one "+K more" segment.
    var MAXSEG=11, extra=null;
    if(mods.length>MAXSEG){ var tail=mods.slice(MAXSEG); mods=mods.slice(0,MAXSEG);
      var tw=0, tf=0; for(var t=0;t<tail.length;t++){ tw+=weight(tail[t]); tf+=tail[t].files; }
      extra={n:tail.length,lines:tw,files:tf}; }
    var pct = (mods.length+(extra?1:0)) ? 100/(mods.length+(extra?1:0)) : 100;
    var h='';
    for(var j=0;j<mods.length;j++){ var m=mods[j];
      var sel=(MOD===m.module), op=(MOD!==null&&!sel)?0.35:0.9;
      h+='<button class="cm-sg'+(sel?' sel':'')+'" data-mod="'+esc(m.module)+'" style="width:'+pct+'%;background:'+colorOf(m.status)+';opacity:'+op+'" title="'+esc(m.label)+' · '+weight(m)+' lines · '+m.files+' file(s)">'+
        '<span class="cm-sl">'+esc(m.label)+'</span></button>';
    }
    if(extra) h+='<span class="cm-sg" style="width:'+pct+'%;background:rgba(127,127,127,0.45);opacity:0.9" title="'+extra.n+' more module(s) · '+extra.lines+' lines · '+extra.files+' file(s) — ranked in the ledger below">'+
      '<span class="cm-sl">+'+extra.n+' more</span></span>';
    var host=document.getElementById('cm-strip'); host.innerHTML=h;
    var bs=host.querySelectorAll('.cm-sg');
    for(var b=0;b<bs.length;b++) bs[b].addEventListener('click', function(){ var m=this.getAttribute('data-mod'); MOD=(MOD===m)?null:m; paintDetail(); });
  }
  function renderLedger(){
    var files=rankedFiles(), shown=[];
    for(var i=0;i<files.length;i++) if(visible(files[i])) shown.push(files[i]);
    ROWS=shown;
    var max=0; for(var j=0;j<shown.length;j++){ var wj=weight(shown[j]); if(wj>max) max=wj; } if(!max) max=1;
    var h='';
    for(var k=0;k<shown.length;k++){ var f=shown[k], w=Math.max(2, weight(f)/max*100);
      h+='<button class="cm-row" data-idx="'+k+'">'+
        '<span class="cm-dot" style="background:'+colorOf(f.status)+'"></span>'+
        '<span class="cm-fn">'+esc(f.file)+(f.agent?'<span class="cm-ag">●</span>':'')+(f.risk?'<span class="cm-rk">⌐</span>':'')+'</span>'+
        '<span class="cm-md">'+esc(f.moduleLabel)+'</span>'+
        '<span class="cm-bar"><span class="cm-fill" style="width:'+w+'%;background:'+colorOf(f.status)+'"></span></span>'+
        '<span class="cm-n">+'+f.churn+'</span>'+
        '<span class="cm-pd">'+(f.pending?('<span style="color:'+PAL.pending+'">'+f.pending+'⏳</span>'):('<span style="color:'+PAL.kept+'">✓</span>'))+'</span>'+
        '</button>';
    }
    var host=document.getElementById('cm-ledger');
    host.innerHTML=h||'<div class="cm-none">nothing matches this filter</div>';
    // An active Search filter narrows this ledger too — say so, or an emptied list reads as a bug.
    if(FILTER) document.getElementById('cm-readout').innerHTML='🔍 search “'+esc(FILTER)+'” · '+shown.length+' file(s) — Search again (empty) to clear';
    var rs=host.querySelectorAll('.cm-row');
    for(var r=0;r<rs.length;r++){
      rs[r].addEventListener('click', function(){ var f=ROWS[+this.getAttribute('data-idx')]; if(f&&f.maxId>=0){ vscode.postMessage({type:'openEdit', id:f.maxId}); document.getElementById('cm-readout').innerHTML='→ <b>open diff</b> · '+esc(f.file)+' (edit #'+f.maxId+')'; } });
      rs[r].addEventListener('mousemove', function(ev){ showTip(ev, ROWS[+this.getAttribute('data-idx')]); });
      rs[r].addEventListener('mouseleave', hideTip);
    }
  }
  function tipHtml(f){ var cls=f.classes||[];
    var clsline=cls.length? cls.slice(0,4).join(', ')+(cls.length>4?' +'+(cls.length-4):'') : 'file scope';
    return '<div class="tf">'+(f.agent?'<span class="ag">●</span> ':'')+esc(f.file)+(f.risk?' <span class="rk">⌐risk</span>':'')+'</div>'+
      '<div class="tm">'+esc(f.rel)+'</div>'+
      '<div class="tm">+'+f.churn+' · '+f.cnt+' unit'+(f.cnt===1?'':'s')+' · '+f.kept+'✓ '+f.pending+'⏳ '+f.undone+'↩</div>'+
      '<div class="tc">'+esc(clsline)+'</div>'+
      (f.reason?'<div class="tw">“'+esc(f.reason)+'”</div>':'')+
      (f.risk?'<div class="trk">⚠ '+esc(f.risk)+'</div>':'')+
      '<div class="ta">click → open the real diff</div>';
  }
  function showTip(ev,f){ if(!f) return; tip.innerHTML=tipHtml(f); tip.style.opacity='1';
    var pad=12, tw=tip.offsetWidth, th=tip.offsetHeight, x=ev.clientX+pad, y=ev.clientY+pad;
    if(x+tw>window.innerWidth) x=ev.clientX-tw-pad; if(y+th>window.innerHeight) y=ev.clientY-th-pad;
    tip.style.left=x+'px'; tip.style.top=y+'px'; }
  function hideTip(){ tip.style.opacity='0'; }
  function updateReadout(){ var ro=document.getElementById('cm-readout'), bits=[];
    if(MOD!==null) bits.push('module <b>'+esc(modLabel(MOD))+'</b>');
    ro.innerHTML = bits.length? ('filtered by '+bits.join(' + ')+' — click again to clear') : '';
  }
  function paintDetail(){ var a=detailSlice(); var empty=document.getElementById('cm-detail-empty');
    // Renderable if the slice has files OR any chapter with edits/wip OR an unassigned bucket — not files alone
    // (an agent/workflow can have chapters or an unassigned rollup with no file ledger yet).
    var hasFiles=!!(a && a.files && a.files.length);
    var hasChapters=!!(a && a.chapters && a.chapters.some(function(ch){ return ch.edits>0 || ch.status==='wip'; }));
    var hasUn=!!(a && a.rollupByTask && a.rollupByTask.some(function(t){ return t.taskId===null && t.edits>0; }));
    if(!hasFiles && !hasChapters && !hasUn){ empty.style.display='block';
      empty.innerHTML=(SEL&&SEL.kind==='workflow')? 'No attributed edits for this workflow yet.' : 'No edits for this agent yet. <span style="opacity:.75">This fills in as Claude edits files.</span>';
      document.getElementById('cm-ribbon').style.display='none'; document.getElementById('cm-strip').innerHTML=''; document.getElementById('cm-ledger').innerHTML=''; document.getElementById('cm-readout').innerHTML='';
      SEL_CH=null; relabelBulk(); return; }
    empty.style.display='none';
    renderRibbon(); renderStrip(); renderLedger(); updateReadout();
  }

  // --- left NAV: display filter (shared by Fleet + Workflows) ----------------------------------------
  function filterBar(kind, F){
    var wf=kind==='workflows';
    var act=wf?F.activeWorkflows:F.activeAgents, tot=wf?F.totalWorkflows:F.totalAgents, hid=wf?F.hiddenWorkflows:F.hiddenAgents;
    var h='';
    if(ACTIVE_ONLY) h+='<span class="mt-fon" title="Active-only filter is on">'+(wf?'running':'active')+' only · '+act+'/'+tot+'</span>';
    if(hid>0) h+='<span class="mt-fhide" data-tab="'+kind+'" title="Un-hide the completed items you cleared">'+hid+' hidden · show all</span>';
    return h?('<div class="mt-fbar">'+h+'</div>'):'';
  }
  function wireFilterBar(host){ var hb=host.querySelectorAll('.mt-fhide');
    for(var i=0;i<hb.length;i++) hb[i].addEventListener('click', function(){ if(this.getAttribute('data-tab')==='workflows') DISMISS_WF={}; else DISMISS_AG={}; paint(); }); }
  function syncControls(F){
    var cb=document.getElementById('mt-active'); if(cb) cb.checked=ACTIVE_ONLY;
    var tg=document.getElementById('ov-activeonly'); if(tg){ tg.classList.toggle('on', ACTIVE_ONLY); tg.setAttribute('aria-pressed', ACTIVE_ONLY?'true':'false'); }
    var btn=document.getElementById('mt-clear');
    if(btn) btn.disabled = F.completedAgents.every(function(s){return DISMISS_AG[s];}) && F.completedWorkflows.every(function(i){return DISMISS_WF[i];});
  }
  function clearCompleted(){
    var F=MTFILTER(MT, fstate());
    for(var i=0;i<F.completedAgents.length;i++) DISMISS_AG[F.completedAgents[i]]=1;
    for(var j=0;j<F.completedWorkflows.length;j++) DISMISS_WF[F.completedWorkflows[j]]=1;
    paint();
  }

  // --- Fleet: running agents (worktree-siblings) + nested subagents; click selects the DETAIL ---------
  function renderFleet(){ var host=document.getElementById('ov-fleet');
    var F=MTFILTER(MT, fstate()); var vis=F.agents; syncControls(F);
    var h=filterBar('fleet', F);
    for(var i=0;i<vis.length;i++){ var a=vis[i]; var col=agentCollisions(a); var sel=(a.session===selAgentSess());
      h+='<div class="mt-agent'+(sel?' sel':'')+'" data-sess="'+esc(a.session)+'">';
      h+='<div class="mt-arow">';
      h+='<span class="mt-badge" style="background:'+phaseColor(a.phase)+'"'+(a.phaseConfidence==='heuristic'?' title="inferred from inactivity — no structural marker for this state">~':'>')+esc(phaseLabel(a.phase))+'</span>';
      h+='<span class="mt-wt">'+esc(base(a.worktree))+(a.self?'<span class="mt-self">self</span>':'')+(a.gitBranch?'<span class="mt-br">⑂'+esc(a.gitBranch)+'</span>':'')+'</span>';
      h+=spark(a.sparkline);
      h+='<span class="mt-diff"><span class="mt-add">+'+((a.diff&&a.diff.added)||0)+'</span> <span class="mt-rem">−'+((a.diff&&a.diff.removed)||0)+'</span></span>';
      h+='<span class="mt-meta">'+fmtTok(a.tokens)+' tok · '+fmtDur(a.durationMs)+'</span>';
      var rc=riskCount(a.risk); if(rc) h+='<span class="mt-risk"'+(riskHigh(a.risk)?' data-high="1"':'')+' title="'+rc+' risk flag(s)">⚠ '+rc+'</span>';
      if(col) h+='<span class="mt-col" title="'+col+' file(s) also touched by another agent">⇄ '+col+'</span>';
      h+='</div>';
      var subs=a.subagents||[];
      for(var k=0;k<subs.length;k++){ var su=subs[k];
        h+='<div class="mt-sub">';
        h+='<span class="mt-badge sm" style="background:'+phaseColor(su.phase)+'"'+(su.phaseConfidence==='heuristic'?' title="inferred from inactivity — no structural marker for this state">~':'>')+esc(phaseLabel(su.phase))+'</span>';
        h+='<span class="mt-st">'+esc(su.agentType||'subagent')+(su.description?'<span class="mt-sd">'+esc(su.description)+'</span>':'')+'</span>';
        if(su.currentTask) h+='<span class="mt-cur" title="'+esc(su.currentTask)+'">▶ '+esc(su.currentTask)+'</span>';
        var td=su.todos||[]; if(td.length) h+='<span class="mt-todo">'+td.length+' todo'+(td.length===1?'':'s')+'</span>';
        h+='<span class="mt-diff sm"><span class="mt-add">+'+(su.added||0)+'</span> <span class="mt-rem">−'+(su.removed||0)+'</span></span>';
        h+='<button class="mt-chat" data-agent="'+esc(su.agentId)+'" title="Chat about this subagent — copies context, opens your Claude">💬</button>';
        h+='</div>';
      }
      h+='</div>';
    }
    if(!vis.length) h+='<div class="mt-none">'+(ACTIVE_ONLY?'No active agents.':'No agents to show.')+'</div>';
    host.innerHTML=h; wireFilterBar(host);
    var c=(MT&&MT.collisions)||[], ch='';
    for(var m=0;m<c.length;m++){ var cc=c[m];
      ch+='<div class="mt-crow" data-path="'+esc(cc.file)+'" title="'+esc(cc.file)+' — click to open"><span class="mt-cf">'+esc(base(cc.file))+'</span><span class="mt-ca">'+((cc.agents&&cc.agents.length)||0)+' agents</span>'+(cc.anyPending?'<span class="mt-cp">pending</span>':'')+'</div>';
    }
    document.getElementById('ov-collisions').innerHTML = c.length? ('<div class="mt-chead">Live conflicts ('+c.length+')</div>'+ch) : '';
    var crows=document.querySelectorAll('#ov-collisions .mt-crow');
    for(var cr=0;cr<crows.length;cr++) crows[cr].addEventListener('click', function(){ vscode.postMessage({type:'openPath', path:this.getAttribute('data-path')}); });
    var rows=host.querySelectorAll('.mt-agent');
    for(var r=0;r<rows.length;r++) rows[r].addEventListener('click', function(ev){ if(ev.target && String(ev.target.className||'').indexOf('mt-chat')>=0) return; var s=this.getAttribute('data-sess'); SEL={kind:'agent', session:s}; paint(); });
    var bs=host.querySelectorAll('.mt-chat');
    for(var b=0;b<bs.length;b++) bs[b].addEventListener('click', function(ev){ ev.stopPropagation(); var id=this.getAttribute('data-agent'); vscode.postMessage({type:'chatAction', ref:{agentId:id}}); });
  }

  // --- Workflows: the runs — informative name, per-phase progress, tokens/time/edits; click selects ---
  function phaseSummary(w){ var pg=(w&&w.phaseGroups)||[]; if(!pg.length) return '';
    var parts=[]; for(var i=0;i<pg.length;i++) parts.push(esc(pg[i].title)+' '+pg[i].done+'/'+pg[i].total);
    return parts.join(' · '); }
  function wagRow(a){ var sid=String(a.agentId||'').replace(/^v\d+:/,'').slice(0,6);
    // A running workflow's label is DERIVED from the agent's prompt (labelDerived — shown with '~', the
    // heuristic marker); the runner's real labels replace it once the state file lands at completion.
    var lbl=a.label?(a.label+(a.labelDerived?'~':'')):((a.agentType||'agent')+(sid?' '+sid:''));
    // Each agent row carries the same "extras" as the run header: activity sparkline · ±diff · model · tokens · time · edits.
    return '<div class="mt-wag"><span class="mt-badge xs" style="background:'+(a.done?PAL.done:PAL.working)+'"></span>'+
      '<span class="mt-wat">'+esc(lbl)+'</span>'+
      spark(a.sparkline)+
      '<span class="mt-diff sm"><span class="mt-add">+'+(a.added||0)+'</span> <span class="mt-rem">−'+(a.removed||0)+'</span></span>'+
      '<span class="mt-wmeta">'+(a.model?esc(a.model)+' · ':'')+fmtTok(a.tokens)+' tok · '+fmtDur(a.durationMs)+' · '+(a.edits||0)+' edit'+(a.edits===1?'':'s')+'</span></div>'; }
  function renderWorkflows(){ var host=document.getElementById('ov-workflows');
    var all=(MT&&MT.workflows)||[];
    if(!all.length){ host.innerHTML='<div class="mt-none">No workflow runs in this session yet.</div>'; return; }
    var F=MTFILTER(MT, fstate()), wf=F.workflows;
    var h=filterBar('workflows', F);
    if(!wf.length){ host.innerHTML=h+'<div class="mt-none">'+(ACTIVE_ONLY?'No running workflows.':'No workflow runs to show.')+'</div>'; wireFilterBar(host); return; }
    for(var i=0;i<wf.length;i++){ var w=wf[i]; var open=(WF_OPEN[w.id]!==false); var ps=phaseSummary(w); var sel=(w.id===selWf());
      h+='<div class="mt-wf'+(sel?' sel':'')+(w.id===FLASH_WF?' flash':'')+'">';
      // Header line: caret · badge · FULL name (wraps, never clipped). Metrics ride their own line below so
      // the long workflow description stays fully readable in the narrow nav.
      h+='<div class="mt-wrow" data-wf="'+esc(w.id)+'" title="Show this workflow’s change-map">';
      h+='<button class="mt-wcar" data-car="'+esc(w.id)+'" title="'+(open?'collapse':'expand')+' agents">'+(open?'▾':'▸')+'</button>';
      h+='<span class="mt-badge sm" style="background:'+(w.running?PAL.working:PAL.done)+'">'+(w.running?'running':'done')+'</span>';
      h+='<span class="mt-wname">'+esc(w.description||w.name)+'</span>';
      h+='</div>';
      h+='<div class="mt-wmet">'+spark(w.sparkline)+
        '<span class="mt-diff sm"><span class="mt-add">+'+(w.added||0)+'</span> <span class="mt-rem">−'+(w.removed||0)+'</span></span>'+
        '<span class="mt-meta">'+(w.agentCount||(w.agents||[]).length)+' ag · '+fmtTok(w.tokens)+' tok · '+fmtDur(w.durationMs)+' · '+(w.edits||0)+' edit'+(w.edits===1?'':'s')+'</span></div>';
      if(w.description&&w.name&&w.description!==w.name) h+='<div class="mt-wsub">'+esc(w.name)+'</div>';
      if(ps) h+='<div class="mt-wphs">'+ps+'</div>';
      if(open){ var ags=w.agents||[], pg=(w.phaseGroups||[]), placed={};
        for(var g=0;g<pg.length;g++){ var title=pg[g].title;
          h+='<div class="mt-wphg">'+esc(title)+' <span class="mt-wpn">'+pg[g].done+'/'+pg[g].total+'</span></div>';
          for(var kk=0;kk<ags.length;kk++){ if(ags[kk].phase===title){ placed[kk]=1; h+=wagRow(ags[kk]); } }
        }
        var rest=''; for(var k2=0;k2<ags.length;k2++){ if(!placed[k2]) rest+=wagRow(ags[k2]); }
        if(rest){ if(pg.length) h+='<div class="mt-wphg">other</div>'; h+=rest; }
      }
      h+='</div>';
    }
    host.innerHTML=h; wireFilterBar(host);
    var cars=host.querySelectorAll('.mt-wcar');
    for(var r=0;r<cars.length;r++) cars[r].addEventListener('click', function(ev){ ev.stopPropagation(); var id=this.getAttribute('data-car'); WF_OPEN[id]=(WF_OPEN[id]===false); renderWorkflows(); });
    var wrows=host.querySelectorAll('.mt-wrow');
    // Clicking the workflow selects it (→ change-map on the right) AND expands its per-agent list (→ left),
    // so the agents are discoverable without hunting for the ▸ caret. The caret still toggles collapse.
    for(var q=0;q<wrows.length;q++) wrows[q].addEventListener('click', function(){ var id=this.getAttribute('data-wf'); if(id){ SEL={kind:'workflow', id:id}; WF_OPEN[id]=true; paint(); } });
  }

  // --- nav sub-tabs (Fleet · Workflows) --------------------------------------------------------------
  function navCounts(){ return { fleet:((MT&&MT.agents)||[]).length, workflows:((MT&&MT.workflows)||[]).length }; }
  function applyPanes(){ document.getElementById('ov-pane-fleet').style.display=(NAV==='fleet')?'flex':'none'; document.getElementById('ov-pane-workflows').style.display=(NAV==='workflows')?'flex':'none'; }
  function renderNavTabs(){ var c=navCounts(); var defs=[['fleet','Fleet',c.fleet],['workflows','Workflows',c.workflows]];
    var h=''; for(var i=0;i<defs.length;i++){ var d=defs[i]; h+='<button class="ov-tab'+(d[0]===NAV?' on':'')+'" data-nav="'+d[0]+'">'+d[1]+'<span class="ov-tn">'+d[2]+'</span></button>'; }
    var host=document.getElementById('ov-navtabs'); host.innerHTML=h;
    var bs=host.querySelectorAll('.ov-tab'); for(var b=0;b<bs.length;b++) bs[b].addEventListener('click', function(){ NAV=this.getAttribute('data-nav'); renderNavTabs(); applyPanes(); }); }

  function paint(){
    var empty=document.getElementById('ov-empty');
    if(MT && MT.agents){ empty.style.display='none'; renderNavTabs(); applyPanes(); renderFleet(); renderWorkflows(); }
    else {
      renderNavTabs(); applyPanes();
      if(!CM){ empty.style.display='block'; empty.innerHTML='No agents yet. <span style="opacity:.75">This fills in as Claude works across your worktrees.</span>';
        document.getElementById('ov-fleet').innerHTML=''; document.getElementById('ov-workflows').innerHTML=''; document.getElementById('ov-collisions').innerHTML=''; }
      else empty.style.display='none';
    }
    ensureSel();
    paintDetail();
  }

  function setSessLabel(s){ var el=document.getElementById('ov-sess-label'); if(el) el.textContent='session '+(s?String(s).slice(0,8):'—'); }
  // Paint the nav-bar Diff/File position counters from the host-pushed NAVPOS (live step-through position).
  function renderNavPos(){ var p=NAVPOS||{};
    var d=document.getElementById('ov-diffcount'); if(d) d.textContent='Diff '+(p.diff? (p.diff.i+'/'+p.diff.n) : '–/–');
    var f=document.getElementById('ov-filecount'); if(f) f.textContent='File '+(p.file? ((p.file.i||'–')+'/'+p.file.n) : '–/–'); }

  window.addEventListener('message', function(ev){ var m=ev.data||{};
    if(m.type==='overview'){ CM=m.cm||null; MT=m.mt||null; NAVPOS=m.navPos||null; FILTER=m.filter||''; setSessLabel(m.session);
      // Reset dismissals only when the actual session changes — key on the stable host-provided session id,
      // NOT selfSession() (which falls back to agents[0].session and flips whenever the fleet re-sorts,
      // wiping the user's "clear completed" on every refresh).
      var k=m.session||SELF_KEY; if(k!==SELF_KEY){ SELF_KEY=k; DISMISS_AG={}; DISMISS_WF={}; SEEN_WF=null; }
      // Auto-focus a NEW workflow run: the first payload only SEEDS the seen-set (opening the panel never
      // steals focus); after that, a newly-appeared RUNNING run switches the nav to Workflows, selects it,
      // and pulses its row — the detail then tracks the run's agents/phases/edits live via the watchers.
      var wfs=(MT&&MT.workflows)||[];
      if(SEEN_WF===null){ SEEN_WF={}; for(var sw=0;sw<wfs.length;sw++) SEEN_WF[wfs[sw].id]=1; }
      else { var freshWf=null;
        for(var nw=0;nw<wfs.length;nw++){ if(!SEEN_WF[wfs[nw].id]){ SEEN_WF[wfs[nw].id]=1; if(wfs[nw].running) freshWf=wfs[nw].id; } }
        if(freshWf){ NAV='workflows'; SEL={kind:'workflow', id:freshWf}; WF_OPEN[freshWf]=true; FLASH_WF=freshWf;
          setTimeout(function(){ FLASH_WF=null; }, 3200); } }
      ensureSel(); readPal(); paint(); renderNavPos(); }
    else if(m.type==='navpos'){ NAVPOS=m.pos||null; renderNavPos(); }
    else if(m.type==='error'){ CM=null; MT=null; var em=document.getElementById('ov-empty'); em.style.display='block';
      em.innerHTML='Needs the <b>claude-observatory</b> CLI, which was not found. <span style="opacity:.75">Install it (./install.sh), then reload.</span>';
      document.getElementById('ov-fleet').innerHTML=''; document.getElementById('ov-workflows').innerHTML=''; document.getElementById('ov-collisions').innerHTML='';
      document.getElementById('cm-ribbon').style.display='none'; document.getElementById('cm-strip').innerHTML=''; document.getElementById('cm-ledger').innerHTML=''; document.getElementById('cm-detail-empty').style.display='none'; document.getElementById('cm-readout').innerHTML=''; }
  });

  (function wireControls(){
    var cb=document.getElementById('mt-active'); if(cb) cb.addEventListener('change', function(){ ACTIVE_ONLY=!!cb.checked; paint(); });
    var aotg=document.getElementById('ov-activeonly'); if(aotg) aotg.addEventListener('click', function(){ ACTIVE_ONLY=!ACTIVE_ONLY; paint(); });
    var btn=document.getElementById('mt-clear'); if(btn) btn.addEventListener('click', function(){ clearCompleted(); });
    // top-navbar review actions — each posts to the host, which runs the matching command (zero-token).
    function tbtn(id, type){ var b=document.getElementById(id); if(b) b.addEventListener('click', function(){ vscode.postMessage({type:type}); }); }
    // Bulk actions scope to the SELECTED chapter when one is picked in the ribbon, else act session-wide —
    // the chapter path reuses the existing strict-span task ops (destructive-safe).
    function bulk(id, sess, chap){ var b=document.getElementById(id); if(b) b.addEventListener('click', function(){ if(SEL_CH) vscode.postMessage({type:chap, taskId:SEL_CH.id}); else vscode.postMessage({type:sess}); }); }
    tbtn('ov-sess','switchSession'); tbtn('ov-refresh','refresh');
    bulk('ov-keepall','keepAll','taskKeep'); bulk('ov-undoall','undoAll','taskUndo'); bulk('ov-clearres','clearResolved','taskClear');
    // the step-through review nav bar — posts to the existing nav commands the status-bar nav bar drives.
    tbtn('ov-fileprev','navFilePrev'); tbtn('ov-filenext','navFileNext');
    tbtn('ov-diffprev','navDiffPrev'); tbtn('ov-diffnext','navDiffNext');
    tbtn('ov-navkeep','navKeep'); tbtn('ov-navundo','navUndo');
    tbtn('ov-acceptfile','keepOpenFile'); tbtn('ov-rejectfile','undoOpenFile'); tbtn('ov-clearfile','clearOpenFile');
    tbtn('ov-spotlight','toggleHeatmap'); tbtn('ov-search','searchEdits');
    // clicking empty ribbon space clears the chapter scope (back to session-wide). Wired once (not per-render).
    var rib=document.getElementById('cm-ribbon');
    if(rib) rib.addEventListener('click', function(ev){ var t=ev.target; var onEmpty=(t===rib)||(t.className&&String(t.className).indexOf('cm-rwrap')>=0); if(onEmpty && SEL_CH){ SEL_CH=null; renderRibbon(); } });
    relabelBulk(); renderNavPos();
  })();
  readPal();
  vscode.postMessage({type:'ready'});
})();
`;

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
  const editsView = vscode.window.createTreeView('claudeObservatory.edits', { treeDataProvider: editsProvider });
  const diffsView = vscode.window.createTreeView('claudeObservatory.diffs', { treeDataProvider: diffsProvider });
  // 0.8.0: Timeline folded into Observations (timeline-style runs). Round 3: the Observations panel is
  // two tabs — Observations (reasoning feed) + Actions (the tool-call timeline, moved out of Multitasking).
  const insightsProvider = new ObservationsProvider();
  const insightsView = vscode.window.createTreeView('claudeObservatory.observations', { treeDataProvider: insightsProvider });
  const actionsProvider = new ActionsProvider();
  const actionsView = vscode.window.createTreeView('claudeObservatory.actions', { treeDataProvider: actionsProvider });
  actionsProvider.view = actionsView;
  const fileHistoryProvider = new FileHistoryProvider();
  const fileHistoryView = vscode.window.createTreeView('claudeObservatory.fileHistory', { treeDataProvider: fileHistoryProvider });
  fileHistoryProvider.view = fileHistoryView;
  const statsProvider = new StatsUsageViewProvider();
  const changeMapProvider = new ChangeMapViewProvider();
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
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: ADDED_BAR,
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
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: REMOVED_BAR,
  });
  // File heatmap: fade unmodified lines to ~40% so Claude's edited lines read at full contrast.
  heatmapDecoration = vscode.window.createTextEditorDecorationType({ opacity: '0.4' });
  inlineLens = new InlineLensProvider();
  const editPeek = new EditPeek();

  // Realtime observatory readout: a status-bar microscope with the pending count — always visible,
  // amber while edits await review. Click = jump to the next pending edit.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusItem.command = 'claudeObservatory.reviewNext';
  // The nav bar: a compact review toolbar beside the microscope, shown only while edits await review so
  // the bottom bar stays quiet when you're caught up. Two tiers (adopted from Void's editor review bar):
  //   • session tier  — File axis (← n/m →), Clear resolved, Spotlight, Search — whenever ANY edit is pending
  //   • active-file tier — Diff axis (↑ n/m ↓), Keep/Undo this edit, Accept/Reject File — when the OPEN file
  //     has pending edits (mirrors the per-file bar Void pins at the bottom of the editor).
  // navEditId is the pending edit the Diff axis is parked on within the open file.
  let navEditId: number | undefined;
  const mkStatusBtn = (text: string, tooltip: string, command: string, priority: number) => {
    const b = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
    b.text = text;
    b.tooltip = tooltip;
    b.command = command;
    return b;
  };
  // Search leads every nav bar (user rule 2026-07-16 — same position on every surface).
  const searchBtn = mkStatusBtn('$(search)', 'Claude Observatory: search edits', 'claudeObservatory.searchEdits', 90);
  // Diff axis — steps the OPEN file's pending edits; the counter opens the current edit's diff.
  const diffPrevBtn = mkStatusBtn('$(chevron-up)', 'Claude Observatory: previous edit in this file', 'claudeObservatory.navDiffPrev', 89);
  const diffCountBtn = mkStatusBtn('', 'Claude Observatory: this file’s pending edits — click to open the floating review bubble', 'claudeObservatory.navViewDiff', 88);
  const diffNextBtn = mkStatusBtn('$(chevron-down)', 'Claude Observatory: next edit in this file', 'claudeObservatory.navDiffNext', 87);
  // File axis — steps across every file with pending edits; the counter opens the Edits view.
  const filePrevBtn = mkStatusBtn('$(chevron-left)', 'Claude Observatory: previous changed file', 'claudeObservatory.navFilePrev', 86);
  const fileCountBtn = mkStatusBtn('', 'Claude Observatory: files with pending edits — click to open the Edits view', 'claudeObservatory.edits.focus', 85);
  const fileNextBtn = mkStatusBtn('$(chevron-right)', 'Claude Observatory: next changed file', 'claudeObservatory.navFileNext', 84);
  // Per-edit + per-file actions on the OPEN file.
  const keepEditBtn = mkStatusBtn('$(check)', 'Claude Observatory: keep this edit', 'claudeObservatory.navKeep', 83);
  const undoEditBtn = mkStatusBtn('$(discard)', 'Claude Observatory: undo this edit', 'claudeObservatory.navUndo', 82);
  const acceptFileBtn = mkStatusBtn('$(check-all)', 'Claude Observatory: accept every pending edit in this file', 'claudeObservatory.keepOpenFile', 81);
  const rejectFileBtn = mkStatusBtn('$(close-all)', 'Claude Observatory: reject (revert) every pending edit in this file', 'claudeObservatory.undoOpenFile', 80);
  // Session-wide utilities.
  const clearBtn = mkStatusBtn('$(clear-all)', 'Claude Observatory: clear resolved (kept/reverted) edits', 'claudeObservatory.clearResolved', 79);
  const spotlightBtn = mkStatusBtn('$(lightbulb)', 'Claude Observatory: toggle spotlight — dim unedited lines to highlight Claude’s changes', 'claudeObservatory.toggleHeatmap', 78);
  const activeFileBtns = [diffPrevBtn, diffCountBtn, diffNextBtn, keepEditBtn, undoEditBtn, acceptFileBtn, rejectFileBtn];
  const sessionBtns = [searchBtn, filePrevBtn, fileCountBtn, fileNextBtn, clearBtn, spotlightBtn];
  const navCluster = [...activeFileBtns, ...sessionBtns];

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

    // Nav-bar counters: the File axis spans every pending file; the Diff axis spans the OPEN file's edits.
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
    const files = session ? pendingFilesOf(session) : [];
    const inFile = session && activeFile ? pendingEditsInFile(session, activeFile) : [];
    const activeHasPending = inFile.length > 0;
    // Anchor navEditId to a still-pending edit in the OPEN file (default: the edit under the cursor, else
    // the file's first pending edit); cleared when the open file has nothing to review.
    if (activeHasPending) {
      if (navEditId === undefined || !inFile.some((r) => r.id === navEditId)) {
        const atCursor = session ? pendingAtCursor(session)?.id : undefined;
        navEditId = atCursor !== undefined && inFile.some((r) => r.id === atCursor) ? atCursor : inFile[0].id;
      }
    } else {
      navEditId = undefined;
    }
    const diffIdx = activeHasPending ? inFile.findIndex((r) => r.id === navEditId) : -1;
    diffCountBtn.text = activeHasPending ? `Diff ${diffIdx + 1}/${inFile.length}` : '';
    const fileIdx = activeFile ? files.indexOf(activeFile) : -1;
    fileCountBtn.text = files.length ? `File ${fileIdx >= 0 ? fileIdx + 1 : '–'}/${files.length}` : '';
    // Mirror the same Diff/File position into the Overview title-bar nav-bar counters (live).
    changeMapProvider.setNavPos({
      diff: activeHasPending ? { i: diffIdx + 1, n: inFile.length } : null,
      file: files.length ? { i: fileIdx >= 0 ? fileIdx + 1 : 0, n: files.length } : null,
    });

    // Session-tier buttons show whenever anything is pending; active-file-tier only inside a changed file.
    for (const b of sessionBtns) pending ? b.show() : b.hide();
    for (const b of activeFileBtns) activeHasPending ? b.show() : b.hide();
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
  context.subscriptions.push(...navCluster);

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
    // Demo sessions leave no residue (0.8.0): once every demo edit is reviewed (e.g. Accept All), the
    // resolved records are dropped so the panels empty out. No-op for real sessions; the resulting
    // store change re-enters here once and then no-ops (the log is empty).
    const s = currentSession();
    if (s) core.autoClearDemo(s);
    editsProvider.refresh();
    diffsProvider.refresh();
    insightsProvider.refresh();
    actionsProvider.refresh();
    fileHistoryProvider.refresh();
    statsProvider.refresh();
    changeMapProvider.refresh();
    statusDecorations.refresh();
    updateStatusItem();
    refreshInline();
  };

  // --- nav bar handlers (drive the status-bar review toolbar built above) ---
  // The pending edit the Diff axis is parked on, resolved to a live (still-pending) record.
  const navCurrentRec = (): { s: string; rec: core.EditRecord } | undefined => {
    const s = currentSession();
    if (!s || navEditId === undefined) return undefined;
    const rec = core.findRecord(s, navEditId);
    return rec && rec.status === 'pending' ? { s, rec } : undefined;
  };
  // Diff axis: step the OPEN file's pending edits (wrapping) and reveal the target in the editor.
  const navDiff = async (dir: 1 | -1) => {
    const s = currentSession();
    const file = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (!s || !file) return;
    const list = pendingEditsInFile(s, file);
    if (!list.length) return;
    const idx = navEditId !== undefined ? list.findIndex((r) => r.id === navEditId) : -1;
    const target = list[((idx < 0 ? 0 : idx) + dir + list.length) % list.length];
    navEditId = target.id;
    await openFileAtEdit({ kind: 'edit', rec: target });
    updateStatusItem();
  };
  // File axis: step across files with pending edits (wrapping), opening the target's first pending edit.
  const navFile = async (dir: 1 | -1) => {
    const s = currentSession();
    if (!s) return;
    const files = pendingFilesOf(s);
    if (!files.length) return;
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const idx = active ? files.indexOf(active) : -1;
    const target = files[((idx < 0 ? 0 : idx) + dir + files.length) % files.length];
    const first = pendingEditsInFile(s, target)[0];
    if (!first) return;
    navEditId = first.id;
    await openFileAtEdit({ kind: 'edit', rec: first });
    updateStatusItem();
  };

  context.subscriptions.push(
    editsView,
    diffsView,
    insightsView,
    actionsView,
    fileHistoryView,
    statusItem,
    inlineDecoration,
    deletionGhostDecoration,
    annotationDecoration,
    heatmapDecoration,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inlineLens),
    vscode.window.registerWebviewViewProvider('claudeObservatory.stats', statsProvider),
    vscode.window.registerWebviewViewProvider('claudeObservatory.changemap', changeMapProvider),
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
  for (const v of [editsView, diffsView, insightsView, actionsView, fileHistoryView]) {
    v.onDidChangeVisibility((e) => e.visible && refreshAll());
  }
  let debounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => s.focused && refreshAll()),
    vscode.window.onDidChangeActiveTextEditor(() => {
      refreshInline();
      updateStatusItem(); // recompute nav-bar counters + active-file context for the newly-active file
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
    // Stats navbar: jump to the FIRST (oldest) pending edit, and filter edits from the Stats search box.
    vscode.commands.registerCommand('claudeObservatory.reviewFirst', async () => {
      const s = currentSession();
      const pending = s ? cachedLog(s).filter((r) => r.status === 'pending').sort((a, b) => a.id - b.id) : [];
      if (!pending.length) {
        vscode.window.setStatusBarMessage('Claude Observatory: no pending edits to review 🎉', 3000);
        return;
      }
      reviewCursorId = pending[0].id; // so a subsequent review-next continues from here
      await openFileAtEdit({ kind: 'edit', rec: pending[0] });
    }),
    // Nav bar: Diff axis (within the open file), File axis (across pending files), and per-edit actions.
    vscode.commands.registerCommand('claudeObservatory.navDiffPrev', () => navDiff(-1)),
    vscode.commands.registerCommand('claudeObservatory.navDiffNext', () => navDiff(1)),
    vscode.commands.registerCommand('claudeObservatory.navFilePrev', () => navFile(-1)),
    vscode.commands.registerCommand('claudeObservatory.navFileNext', () => navFile(1)),
    vscode.commands.registerCommand('claudeObservatory.navViewDiff', () => {
      const cur = navCurrentRec();
      if (cur) void editPeek.show(cur.rec.id); // open the floating review bubble at the current edit
    }),
    vscode.commands.registerCommand('claudeObservatory.navKeep', () => {
      const cur = navCurrentRec();
      if (!cur) return;
      core.keepGroup(cur.s, cur.rec.id);
      refreshAll();
    }),
    vscode.commands.registerCommand('claudeObservatory.navUndo', async () => {
      const cur = navCurrentRec();
      if (!cur) return;
      await undoOne(cur.s, cur.rec.id);
      refreshAll();
    }),
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
    // Chapter (task) review actions — the Overview ribbon's per-chip Accept / Reject / Clear + a
    // "clear every completed chapter" affordance. The webview posts {taskKeep|taskUndo|taskClear,taskId}.
    vscode.commands.registerCommand('claudeObservatory.taskKeep', (taskId: string) => withSession((s) => keepChapter(s, taskId))()),
    vscode.commands.registerCommand('claudeObservatory.taskUndo', (taskId: string) => withSession((s) => undoChapter(s, taskId))()),
    vscode.commands.registerCommand('claudeObservatory.taskClear', (taskId: string) => withSession((s) => clearChapter(s, taskId))()),
    vscode.commands.registerCommand('claudeObservatory.clearCompletedChapters', () => withSession((s) => clearCompletedChapters(s))()),
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
    // Zero-token chat about ANY action / edit / subagent / task (0.8.0). Accepts a bare ChatContextRef
    // (from the Multitasking + Overview webviews) or an Actions tree node (action / subagent row).
    vscode.commands.registerCommand('claudeObservatory.chatAction', (arg: unknown) => {
      const ref = refFromArg(arg);
      if (!ref) return undefined;
      return chatAction(ref);
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
    // Floating bubble = the full nav bar: File axis + per-file Accept/Reject alongside the Diff axis above.
    vscode.commands.registerCommand('claudeObservatory.peekPrevFile', () => void editPeek.stepFile(-1)),
    vscode.commands.registerCommand('claudeObservatory.peekNextFile', () => void editPeek.stepFile(1)),
    vscode.commands.registerCommand('claudeObservatory.peekAcceptFile', () => editPeek.acceptFile()),
    vscode.commands.registerCommand('claudeObservatory.peekRejectFile', () => void editPeek.rejectFile()),
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
    // Spotlight: dim every unmodified line so only Claude's edits read at full contrast.
    vscode.commands.registerCommand('claudeObservatory.toggleHeatmap', () => {
      heatmapOn = !heatmapOn;
      refreshInline();
      vscode.window.setStatusBarMessage(`Claude Observatory: spotlight ${heatmapOn ? 'on 💡' : 'off'}`, 2500);
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
    ),
    vscode.commands.registerCommand('claudeObservatory.clearOpenFile', () =>
      withSession((s) => {
        const file = vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) return void vscode.window.showInformationMessage('Claude Observatory: no active file.');
        clearResolvedUnder(s, file, path.basename(file));
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

  // The store only changes on EDITS, but Actions / Observations / Timeline / Overview are mined from
  // the session TRANSCRIPT, which grows on every read / command / subagent / to-do. Watch it too so
  // those views update in real time as Claude works — not just when it happens to edit a file. A
  // gentler debounce (the transcript is rewritten far more often than the store) coalesces the churn.
  const transcriptWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(base, 'projects/**/*.jsonl')
  );
  let txDebounce: ReturnType<typeof setTimeout> | undefined;
  const scheduleTxRefresh = () => {
    if (txDebounce) clearTimeout(txDebounce);
    txDebounce = setTimeout(refreshAll, 700);
  };
  transcriptWatcher.onDidChange(scheduleTxRefresh);
  transcriptWatcher.onDidCreate(scheduleTxRefresh);
  context.subscriptions.push(transcriptWatcher);

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
