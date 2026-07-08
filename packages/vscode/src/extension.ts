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
import * as os from 'os';
import * as cp from 'child_process';
import * as core from '@claude-observatory/core';

const SCHEME = 'claude-edit'; // in-memory before/after blobs for vscode.diff

// --- inline (in-editor) overlay state ---
let inlineDecoration: vscode.TextEditorDecorationType | undefined; // gutter change-bar on changed lines
let annotationDecoration: vscode.TextEditorDecorationType | undefined; // right-side per-edit annotation
let inlineLens: InlineLensProvider | undefined; // clickable Keep/Undo/Diff above each pending edit
const MAX_INLINE_LINES = 20000; // skip the overlay on very large files (perf)

type FolderNode = { kind: 'folder'; prefix: string; label: string }; // prefix is a relative path ending in '/'
type FileNode = { kind: 'file'; file: string; edits: core.EditRecord[] };
type ClassNode = { kind: 'class'; file: string; name: string; edits: core.EditRecord[] };
type EditNode = { kind: 'edit'; rec: core.EditRecord; feed?: boolean }; // feed = top-level Timeline row (show file + time)
type TlRunNode = { kind: 'tlrun'; file: string; edits: core.EditRecord[] }; // Timeline run: adjacent same-file edits
type Node = FolderNode | FileNode | ClassNode | EditNode | TlRunNode;

/** Group a session's edits by workspace-relative file path (posix-normalized). */
function editsByRelFile(session: string): Map<string, { file: string; edits: core.EditRecord[] }> {
  const byFile = new Map<string, { file: string; edits: core.EditRecord[] }>();
  for (const rec of cachedLog(session)) {
    const rel = vscode.workspace.asRelativePath(rec.file, false).split(path.sep).join('/');
    if (!byFile.has(rel)) byFile.set(rel, { file: rec.file, edits: [] });
    byFile.get(rel)!.edits.push(rec);
  }
  return byFile;
}

/** Immediate folder segments + files directly under `prefix` (no compaction). */
function immediateSegs(rels: string[], prefix: string): { folderSegs: Set<string>; files: string[] } {
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

/** Immediate folders + files under `prefix`, with single-child folder chains compacted (src/utils). */
function childrenUnder(rels: string[], prefix: string): { folders: FolderNode[]; files: string[] } {
  const { folderSegs, files } = immediateSegs(rels, prefix);
  const folders: FolderNode[] = [...folderSegs].sort().map((seg) => {
    let p = prefix + seg + '/';
    let label = seg;
    for (;;) {
      const sub = immediateSegs(rels, p);
      if (sub.files.length === 0 && sub.folderSegs.size === 1) {
        const only = [...sub.folderSegs][0];
        p = p + only + '/';
        label = label + '/' + only;
      } else break;
    }
    return { kind: 'folder', prefix: p, label };
  });
  return { folders, files: files.sort() };
}

/** A file's children: class groups (edits whose current line falls in a class) + loose edits. */
function fileClassChildren(session: string, fileNode: FileNode): Node[] {
  let text = '';
  try {
    text = fs.readFileSync(fileNode.file, 'utf8');
  } catch {
    /* file gone / unreadable */
  }
  const spans = text ? core.detectClasses(text) : [];
  if (spans.length === 0) return fileNode.edits.map((rec) => ({ kind: 'edit', rec }));
  const byClass = new Map<string, ClassNode>();
  const loose: EditNode[] = [];
  for (const rec of fileNode.edits) {
    const before = cachedBlob(session, rec.beforeBlob);
    const after = cachedBlob(session, rec.afterBlob);
    const line = core.locateEditInCurrent(before, after, text)[0];
    const cls = line !== undefined ? core.classAt(spans, line) : null;
    if (cls) {
      const key = `${cls.name}@${cls.start}`;
      if (!byClass.has(key)) byClass.set(key, { kind: 'class', file: fileNode.file, name: cls.name, edits: [] });
      byClass.get(key)!.edits.push(rec);
    } else {
      loose.push({ kind: 'edit', rec });
    }
  }
  return [...byClass.values(), ...loose];
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Newest Claude Code session for this workspace (mangled-path resolution lives in core). */
function currentSession(): string | undefined {
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
    this.view.description = session ? `session ${shortId(session)}` : undefined;
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
    // edits/diffs: folder → file → (class → edits) + loose edits.
    if (!node || node.kind === 'folder') {
      const byRel = editsByRelFile(session);
      const { folders, files } = childrenUnder([...byRel.keys()], node ? node.prefix : '');
      const fileNodes: FileNode[] = files.map((rel) => ({ kind: 'file', ...byRel.get(rel)! }));
      return [...folders, ...fileNodes];
    }
    if (node.kind === 'file') return fileClassChildren(session, node);
    if (node.kind === 'class') return node.edits.map((rec) => ({ kind: 'edit', rec }));
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

/** URI for one side of a diff. Path carries the real basename so VS Code picks the language mode. */
function blobUri(session: string, sha: string | null, file: string, side: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SCHEME,
    path: `/${side}/${path.basename(file)}`,
    query: `s=${encodeURIComponent(session)}&b=${encodeURIComponent(sha ?? 'empty')}`,
  });
}

async function openDiff(node: EditNode): Promise<void> {
  const session = currentSession();
  if (!session) return;
  const rec = node.rec;
  const left = blobUri(session, rec.beforeBlob, rec.file, 'before');
  const right = blobUri(session, rec.afterBlob, rec.file, 'after');
  const title = `${path.basename(rec.file)} — edit #${rec.id} (before ⟷ after)`;
  await vscode.commands.executeCommand('vscode.diff', left, right, title);
}

/** Open the file and scroll to where this edit currently sits, so the inline overlay is what you see. */
async function openFileAtEdit(node: EditNode): Promise<void> {
  const rec = node.rec;
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(rec.file));
  const editor = await vscode.window.showTextDocument(doc);
  const session = currentSession();
  if (!session) return;
  const before = rec.beforeBlob ? core.readBlob(session, rec.beforeBlob).toString('utf8') : '';
  const after = rec.afterBlob ? core.readBlob(session, rec.afterBlob).toString('utf8') : '';
  const lines = core.locateEditInCurrent(before, after, doc.getText());
  if (lines.length) {
    const pos = new vscode.Position(Math.min(lines[0], Math.max(0, doc.lineCount - 1)), 0);
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
  const res = core.undoEdit(session, id);
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
  const res = core.redoEdit(session, id);
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

function keepAllSession(session: string): void {
  let n = 0;
  for (const r of core.readLog(session)) if (r.status === 'pending') { core.setStatus(session, r.id, 'kept'); n++; }
  vscode.window.showInformationMessage(n ? `Accepted ${n} edit(s).` : 'No pending edits to accept.');
}

async function undoAllSession(session: string): Promise<void> {
  const targets = core.readLog(session).filter((r) => r.status !== 'undone').sort((a, b) => b.id - a.id);
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
  let undone = 0;
  let conflicts = 0;
  for (const t of targets) {
    const r = core.undoEdit(session, t.id);
    if (r.status === 'conflict') conflicts++;
    else if (r.ok) undone++;
  }
  vscode.window.showInformationMessage(
    `Reverted ${undone} edit(s)` +
      (conflicts ? ` · ${conflicts} conflict(s) left (revert individually to force)` : '') +
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
}

/** Every still-PENDING edit for `file`, with the current line indices it occupies. */
function placementsFor(session: string, file: string, text: string): Placement[] {
  const out: Placement[] = [];
  for (const rec of cachedLog(session)) {
    if (rec.file !== file || rec.status !== 'pending') continue;
    const before = cachedBlob(session, rec.beforeBlob);
    const after = cachedBlob(session, rec.afterBlob);
    out.push({ rec, lines: core.locateEditInCurrent(before, after, text) });
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
  return cachedPlacements(session, editor.document).find((p) => p.lines.includes(line))?.rec;
}

/** Trusted-markdown hover: Claude's reasoning for the edit + clickable Keep/Undo/Diff/Chat links. */
function buildHover(session: string, recs: core.EditRecord[]): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = true;
  md.supportThemeIcons = true;
  const link = (cmd: string, id: number) => `command:${cmd}?${encodeURIComponent(JSON.stringify([id]))}`;
  const cwd = workspaceRoot();
  const reasoning = cwd ? cachedTranscript(cwd, session).reasoning : new Map<number, string>();
  for (const rec of recs) {
    md.appendMarkdown(`**Claude edit #${rec.id}** · ${rec.tool}\n\n`);
    const why = reasoning.get(rec.id)?.trim();
    if (why) md.appendMarkdown(`💭 ${why.replace(/\n/g, '  \n')}\n\n`); // full reasoning, soft line breaks
    md.appendMarkdown(
      `[$(check) Keep](${link('claudeObservatory.inlineKeep', rec.id)}) &nbsp; ` +
        `[$(discard) Undo](${link('claudeObservatory.inlineUndo', rec.id)}) &nbsp; ` +
        `[$(diff) Diff](${link('claudeObservatory.inlineDiff', rec.id)}) &nbsp; ` +
        `[$(comment-discussion) Chat](${link('claudeObservatory.chatEdit', rec.id)})\n\n`
    );
  }
  return md;
}

function decorateEditor(editor: vscode.TextEditor): void {
  if (!inlineDecoration || !annotationDecoration) return;
  const doc = editor.document;
  const session = currentSession();
  if (!inlineEnabled() || !session || doc.lineCount > MAX_INLINE_LINES) {
    editor.setDecorations(inlineDecoration, []);
    editor.setDecorations(annotationDecoration, []);
    return;
  }
  const placements = cachedPlacements(session, doc);

  // gutter change-bar on every pending changed line
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

  // right-side ✨ markers at BOTH the first and last line of each edit (so the hover menu is reachable
  // from either end of a multi-line change); edits that share a line merge onto one marker.
  const byLine = new Map<number, core.EditRecord[]>();
  const maxLine = Math.max(0, doc.lineCount - 1);
  for (const p of placements) {
    if (!p.lines.length) continue;
    const first = Math.min(p.lines[0], maxLine);
    const last = Math.min(p.lines[p.lines.length - 1], maxLine);
    for (const anchor of new Set([first, last])) {
      if (!byLine.has(anchor)) byLine.set(anchor, []);
      byLine.get(anchor)!.push(p.rec);
    }
  }
  const annotations: vscode.DecorationOptions[] = [];
  for (const [line, recs] of byLine) {
    const eol = doc.lineAt(line).range.end;
    annotations.push({
      range: new vscode.Range(eol, eol),
      renderOptions: {
        after: {
          contentText: ` ✨ ${recs.map((r) => '#' + r.id).join(' ')}`,
          color: new vscode.ThemeColor('descriptionForeground'),
          fontStyle: 'italic',
          margin: '0 0 0 3ch',
        },
      },
      hoverMessage: buildHover(session, recs),
    });
  }
  editor.setDecorations(annotationDecoration, annotations);
}

/** Clickable **Keep / Undo / Diff** actions rendered above the first line of each pending edit.
 *  Brought back as CodeLens so the actions are visible without hunting for the hover target. */
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
    const lenses: vscode.CodeLens[] = [];
    for (const p of cachedPlacements(session, doc)) {
      if (p.lines.length === 0) continue; // later fully rewritten — no anchor line
      const line = Math.min(p.lines[0], Math.max(0, doc.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      const id = p.rec.id;
      lenses.push(new vscode.CodeLens(range, { title: `$(check) Keep #${id}`, command: 'claudeObservatory.inlineKeep', arguments: [id] }));
      lenses.push(new vscode.CodeLens(range, { title: `$(discard) Undo`, command: 'claudeObservatory.inlineUndo', arguments: [id] }));
      lenses.push(new vscode.CodeLens(range, { title: `$(diff) Diff`, command: 'claudeObservatory.inlineDiff', arguments: [id] }));
    }
    return lenses;
  }
}

/** Redraw the inline overlay (gutter bars + CodeLens actions + right-side label) on visible editors. */
function refreshInline(): void {
  for (const ed of vscode.window.visibleTextEditors) decorateEditor(ed);
  inlineLens?.refresh();
}

// --- Observations + Suggestions tabs (reasoning from transcript + heuristics; opt-in claude -p) ---

const MD_SCHEME = 'claude-observation'; // virtual markdown docs

// One "Insights" view (was two): a "Next steps" group (heuristic suggestions + opt-in Claude) and an
// "Observations" group (one row per edit — reasoning surfaced inline, click opens the combined report).
type ObsNode = { kind: 'recap' } | { kind: 'obs'; rec: core.EditRecord };

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
    // A one-line "what were you doing" recap on top, then one observation row per edit (newest first).
    return [
      { kind: 'recap' },
      ...cachedLog(session).slice().sort((a, b) => b.ts - a.ts).map((rec) => ({ kind: 'obs' as const, rec })),
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

/** nvm has no stable bin dir — globals land under ~/.nvm/versions/node/<ver>/bin. */
function nvmBins(name: string): string[] {
  try {
    const root = path.join(os.homedir(), '.nvm', 'versions', 'node');
    return fs.readdirSync(root).sort().reverse().map((v) => path.join(root, v, 'bin', name));
  } catch {
    return [];
  }
}

/** Locate the globally-installed `claude-observatory` bin (GUI apps and SSH-launched remote hosts
 *  often miss ~/.local/bin on PATH). */
function resolveObservatoryBin(): string {
  const cands = [
    process.env.CLAUDE_OBSERVATORY_BIN,
    path.join(os.homedir(), '.local', 'bin', 'claude-observatory'),
    '/opt/homebrew/bin/claude-observatory',
    '/usr/local/bin/claude-observatory',
    path.join(os.homedir(), '.npm-global', 'bin', 'claude-observatory'),
    path.join(os.homedir(), '.volta', 'bin', 'claude-observatory'),
    ...nvmBins('claude-observatory'),
  ].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return 'claude-observatory'; // fall back to PATH
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 24; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/** The combined Stats + Usage webview. Rendered ONCE; the provider pushes the stats series and the usage
 *  snapshot via postMessage (no reload → no flash, toggle state preserved). Layout: range toggle + the
 *  Edits & Tokens multi-series step-line plots on top, then a "Usage" section (ctx / 5h / week) below. */
function combinedShell(): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
  const PLOTS = [
    { id: 'edits', name: 'Edits', scale: 'linear', series: [['editsPending', 'pending', 'var(--c-pending)'], ['editsKept', 'accepted', 'var(--c-kept)'], ['editsUndone', 'reverted', 'var(--c-reverted)']] },
    { id: 'tokens', name: 'Tokens', scale: 'log', series: [['tokensTotal', 'total', 'var(--c-total)'], ['tokensInput', 'input', 'var(--c-input)'], ['tokensOutput', 'output', 'var(--c-output)']] },
  ];
  const style = `<style>
  :root { --acc: var(--vscode-charts-blue, #4c8bf5); --c-pending: var(--vscode-charts-yellow, #d9a441); --c-kept: var(--vscode-charts-green, #3fb950); --c-reverted: var(--vscode-descriptionForeground, #9aa0aa); --c-total: var(--vscode-charts-blue, #4c8bf5); --c-input: var(--vscode-charts-purple, #9a6ac2); --c-output: var(--vscode-charts-orange, #c9713f); }
  body { margin:0; padding:8px 12px 12px; font-family: var(--vscode-font-family); font-size:11px; color: var(--vscode-foreground); position:relative; }
  .dim { opacity:.75; }
  .empty { padding:12px 2px; color: var(--vscode-descriptionForeground); line-height:1.5; }
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
    `<div id="ustale" class="empty" style="display:none">5h / week last refreshed <b><span id="ustale-age"></span> ago</b> — the VS Code panel doesn't run Claude's status line.<br><span class="dim">open a terminal <b>claude</b> session to refresh plan usage; ctx stays live from the transcript.</span></div>`;
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
    window.addEventListener('message', function(e){ var m=e.data||{};
      if(m.type==='usage'){ renderUsage(m.u); }
      else if(m.type==='stats'){ STATS=m.data; drawStats(); }
      else if(m.type==='statsError' && !STATS){ var g=document.getElementById('gathering'); if(g) g.innerHTML='⚠ stats need the <b>claude-observatory</b> CLI, which was not found.<br><span class="dim">install it with <b>./install.sh</b> (or <b>npm i -g ./packages/cli</b> from the repo), then reload.</span>'; }
    });
    (function(){ var segs=document.querySelectorAll('.seg'); for(var i=0;i<segs.length;i++){ segs[i].addEventListener('click',function(){ range=this.getAttribute('data-r'); vscode.setState({range:range}); drawStats(); }); } drawStats(); vscode.postMessage({type:'ready'}); })();
  `;
  const body =
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
      if (m && m.type === 'ready') {
        this.postUsage();
        this.refreshStats();
      }
    });
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.postUsage();
        this.refreshStats();
      }
    });
  }
  refresh(): void {
    this.postUsage();
    this.refreshStats();
  }
  /** Cheap + sync: post the current usage snapshot for the bars. (The review scoreboard lives in the
   *  status-bar microscope's tooltip, not here.) */
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
      child = cp.spawn(resolveObservatoryBin(), args, { stdio: ['ignore', 'pipe', 'ignore'] });
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

export function activate(context: vscode.ExtensionContext): void {
  const editsProvider = new EditsProvider('edits');
  const diffsProvider = new EditsProvider('diffs');
  const timelineProvider = new EditsProvider('timeline');
  const editsView = vscode.window.createTreeView('claudeObservatory.edits', { treeDataProvider: editsProvider });
  const diffsView = vscode.window.createTreeView('claudeObservatory.diffs', { treeDataProvider: diffsProvider });
  const timelineView = vscode.window.createTreeView('claudeObservatory.timeline', { treeDataProvider: timelineProvider });
  const insightsProvider = new ObservationsProvider();
  const insightsView = vscode.window.createTreeView('claudeObservatory.observations', { treeDataProvider: insightsProvider });
  const statsProvider = new StatsUsageViewProvider();
  editsProvider.view = editsView; // badge lives on the primary view
  editsProvider.updateBadge();

  inlineDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.modifiedForeground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    borderWidth: '0 0 0 2px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('editorGutter.modifiedBackground'),
  });
  annotationDecoration = vscode.window.createTextEditorDecorationType({});
  inlineLens = new InlineLensProvider();

  // Realtime observatory readout: a status-bar microscope with the pending count — always visible,
  // amber while edits await review. Click = jump to the next pending edit.
  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusItem.command = 'claudeObservatory.reviewNext';
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
  };
  updateStatusItem(); // visible from activation, not just after the first store event

  const refreshAll = () => {
    editsProvider.refresh();
    diffsProvider.refresh();
    timelineProvider.refresh();
    insightsProvider.refresh();
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
    statusItem,
    inlineDecoration,
    annotationDecoration,
    vscode.languages.registerCodeLensProvider({ scheme: 'file' }, inlineLens),
    // Hovering anywhere on a highlighted (changed) line pops the same Keep/Undo/Diff/Chat menu.
    vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover(doc, pos) {
          const session = currentSession();
          if (!inlineEnabled() || !session || doc.lineCount > MAX_INLINE_LINES) return undefined;
          const recs = cachedPlacements(session, doc)
            .filter((p) => p.lines.includes(pos.line))
            .map((p) => p.rec);
          return recs.length ? new vscode.Hover(buildHover(session, recs), doc.lineAt(pos.line).range) : undefined;
        },
      }
    ),
    vscode.window.registerWebviewViewProvider('claudeObservatory.stats', statsProvider),
    vscode.window.registerFileDecorationProvider(statusDecorations),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new BlobContentProvider()),
    vscode.workspace.registerTextDocumentContentProvider(MD_SCHEME, obsMd)
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
  for (const v of [editsView, diffsView, timelineView, insightsView]) {
    v.onDidChangeVisibility((e) => e.visible && refreshAll());
  }
  let debounce: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((s) => s.focused && refreshAll()),
    vscode.window.onDidChangeActiveTextEditor(() => refreshInline()),
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
    // The surgical-review loop: jump to the OLDEST pending edit, review it, repeat. Keyboard-friendly.
    vscode.commands.registerCommand('claudeObservatory.reviewNext', async () => {
      const s = currentSession();
      const next = s ? cachedLog(s).filter((r) => r.status === 'pending').sort((a, b) => a.ts - b.ts)[0] : undefined;
      if (!next) {
        vscode.window.setStatusBarMessage('Claude Observatory: no pending edits to review 🎉', 3000);
        return;
      }
      await openFileAtEdit({ kind: 'edit', rec: next });
    }),
    // Keep / undo the pending edit under the cursor — the review loop never has to leave the keyboard.
    vscode.commands.registerCommand('claudeObservatory.keepAtCursor', () =>
      withSession((s) => {
        const rec = pendingAtCursor(s);
        if (!rec) {
          vscode.window.setStatusBarMessage('Claude Observatory: no pending edit under the cursor', 3000);
          return;
        }
        core.setStatus(s, rec.id, 'kept');
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
    // Chat about a specific edit (from a tree node or an edit id).
    vscode.commands.registerCommand('claudeObservatory.chatEdit', (arg: EditNode | number) => {
      const s = currentSession();
      if (!s) return undefined;
      return chatAboutEdit(s, typeof arg === 'number' ? arg : arg.rec.id);
    }),
    // Insights (observations + suggestions)
    vscode.commands.registerCommand('claudeObservatory.showObservation', (id: number) => showObservationDoc(id)),
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
        core.setStatus(s, n.rec.id, 'kept');
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
    vscode.commands.registerCommand('claudeObservatory.inlineKeep', (id: number) =>
      withSession((s) => {
        core.setStatus(s, id, 'kept');
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.inlineUndo', (id: number) =>
      withSession((s) => undoOne(s, id))()
    ),
    vscode.commands.registerCommand('claudeObservatory.toggleInline', async () => {
      const cfg = vscode.workspace.getConfiguration('claudeObservatory');
      const next = !cfg.get<boolean>('inlineReview', true);
      await cfg.update('inlineReview', next, vscode.ConfigurationTarget.Global);
      refreshInline();
      vscode.window.showInformationMessage(`Claude Observatory: inline review ${next ? 'on' : 'off'}.`);
    }),
    vscode.commands.registerCommand('claudeObservatory.keepFile', (n: FileNode) =>
      withSession((s) => {
        let kept = 0;
        for (const e of n.edits) if (e.status === 'pending') { core.setStatus(s, e.id, 'kept'); kept++; }
        vscode.window.showInformationMessage(
          kept ? `Kept ${kept} edit(s) in ${path.basename(n.file)}.` : 'No pending edits to keep in this file.'
        );
      })()
    ),
    vscode.commands.registerCommand('claudeObservatory.undoFile', (n: FileNode) =>
      withSession(async (s) => {
        // newest-first minimizes surgical-undo conflicts
        const targets = [...n.edits].filter((e) => e.status !== 'undone').sort((a, b) => b.id - a.id);
        const base = path.basename(n.file);
        if (targets.length === 0) {
          vscode.window.showInformationMessage(`Nothing to undo in ${base}.`);
          return;
        }
        if (await blockedByDirtyBuffer(n.file)) return;
        const choice = await vscode.window.showWarningMessage(
          `Undo ${targets.length} edit(s) in ${base}? Later-overlapping edits may conflict.`,
          { modal: true },
          'Undo all'
        );
        if (choice !== 'Undo all') return;
        let undone = 0;
        let conflicts = 0;
        for (const e of targets) {
          const r = core.undoEdit(s, e.id);
          if (r.status === 'conflict') conflicts++;
          else if (r.ok) undone++;
        }
        vscode.window.showInformationMessage(
          `Undid ${undone} edit(s) in ${base}` +
            (conflicts ? ` · ${conflicts} conflict(s) left — undo individually to force-restore` : '') +
            '.'
        );
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
}

export function deactivate(): void {
  /* disposables handled via context.subscriptions */
}
