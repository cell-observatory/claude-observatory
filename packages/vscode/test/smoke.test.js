/* Extension smoke test — loads the built bundle against a minimal `vscode` mock and drives its
   commands over an isolated store. Run with `node --test` (npm test builds the bundle first). */
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../../core/dist/index.js');
const BUNDLE = path.resolve(__dirname, '../dist/extension.js');

test('extension: three views, click commands, inline annotations, chat, status styling, undo', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ext-ws-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home; // os.homedir() reads USERPROFILE on Windows, HOME elsewhere
  const S = 'extSess';

  // seed: projects dir so resolveSessionId(ws) === S, and a store with 2 edits on one file
  const proj = path.join(home, '.claude', 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  const F = path.join(ws, 'app.txt');
  // transcript: the ai-title recap + two assistant messages whose Edit tool_uses on F carry Claude's
  // reasoning (correlated per-file to store edits #1/#2) — feeds the inline reasoning lens + blame.
  const AG = 'sa0000000001';
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Reviewing app.txt edits' }),
    JSON.stringify({ message: { role: 'assistant', content: [
      { type: 'text', text: 'Operation 1 — introduce feature scaling' },
      { type: 'tool_use', name: 'Edit', input: { file_path: F } },
    ] } }),
    JSON.stringify({ message: { role: 'assistant', content: [
      { type: 'text', text: 'Operation 2 — add a validate() method' },
      { type: 'tool_use', name: 'Edit', input: { file_path: F } },
    ] } }),
    // Subagents (0.7.0): an Agent spawn + its result carrying the subagent's id + metrics.
    JSON.stringify({ timestamp: '2026-07-13T10:00:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'tuAg', name: 'Agent', input: { description: 'review the diff', subagent_type: 'code-reviewer' } },
    ] } }),
    JSON.stringify({ timestamp: '2026-07-13T10:05:00.000Z',
      toolUseResult: { status: 'completed', agentId: AG, agentType: 'code-reviewer', totalDurationMs: 120000, totalTokens: 30000, totalToolUseCount: 4 },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tuAg', is_error: false }] } }),
  ].join('\n'));
  // the subagent's own transcript — its tool calls (0.7.0 nests these under the Subagents node)
  const subDir = path.join(proj, S, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, `agent-${AG}.jsonl`), [
    JSON.stringify({ isSidechain: true, agentId: AG, sessionId: S, timestamp: '2026-07-13T10:01:00.000Z', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'sa1', name: 'Read', input: { file_path: F } },
      { type: 'tool_use', id: 'sa2', name: 'Grep', input: { pattern: 'scale' } },
    ] } }),
  ].join('\n'));
  // a sibling session in the SAME project (0.7.0 fleet), backdated so resolveSessionId still returns S.
  const SIB = 'sibSess0002';
  fs.writeFileSync(path.join(proj, SIB + '.jsonl'), JSON.stringify({ message: { role: 'assistant', content: [] } }));
  const old = Math.floor(Date.now() / 1000) - 3600;
  fs.utimesSync(path.join(proj, SIB + '.jsonl'), old, old);
  core.ensureStore(S);
  const b0 = core.writeBlob(S, Buffer.from('a\nb\nc\nd\n'));
  const a1 = core.writeBlob(S, Buffer.from('AAA\nb\nc\nd\n'));
  core.appendLog(S, { id: 1, ts: 1000, tool: 'Edit', file: F, beforeBlob: b0, afterBlob: a1, status: 'pending' });
  const a2 = core.writeBlob(S, Buffer.from('AAA\nb\nc\nZZZ\n'));
  core.appendLog(S, { id: 2, ts: 2000, tool: 'Edit', file: F, beforeBlob: a1, afterBlob: a2, status: 'pending' });
  fs.writeFileSync(F, 'AAA\nb\nc\nZZZ\n');

  // minimal vscode mock
  const commands = {};
  const diffCalls = [];
  const decoCalls = []; // { typeId, opts }
  const trees = {};
  const contentProviders = {};
  const webviewProviders = {};
  let lensProvider = null;
  let hoverProvider = null;
  let decoProvider = null;
  let commentController = null;
  const commentThreads = [];
  const statusBarItems = []; // every createStatusBarItem() returns a distinct item (the nav bar has many)
  let clipboardText = '';
  let decoCounter = 0;
  let opened = null;
  let lastShown = null;
  let inputBoxValue; // drives the Search edits input box
  class EventEmitter {
    constructor() { this._s = []; }
    get event() { return (cb) => { this._s.push(cb); return { dispose() {} }; }; }
    fire(v) { this._s.forEach((f) => f(v)); }
  }
  class TreeItem { constructor(label, s) { this.label = label; this.collapsibleState = s; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  ThemeIcon.File = new ThemeIcon('file');
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === 'object') { this.start = a; this.end = b; }
      else { this.start = new Position(a, b); this.end = new Position(c, d); }
    }
  }
  class Selection { constructor(anchor, active) { this.anchor = anchor; this.active = active; } }
  class CodeLens { constructor(range, command) { this.range = range; this.command = command; } }
  class Hover { constructor(contents, range) { this.contents = contents; this.range = range; } }
  class MarkdownString {
    constructor(v) { this.value = v || ''; this.isTrusted = false; this.supportThemeIcons = false; }
    appendMarkdown(s) { this.value += s; return this; }
  }
  const Uri = {
    file: (p) => ({ scheme: 'file', path: p, fsPath: p }),
    from: (o) => ({ scheme: o.scheme, path: o.path, query: o.query || '' }),
    joinPath: (base, ...parts) => ({ scheme: 'file', path: [base && base.path, ...parts].filter(Boolean).join('/'), fsPath: [base && base.fsPath, ...parts].filter(Boolean).join('/') }),
  };
  const doc = {
    uri: Uri.file(F),
    lineCount: 5,
    getText: () => 'AAA\nb\nc\nZZZ\n',
    lineAt: (n) => ({ range: new Range(n, 0, n, 3) }),
  };
  const mockEditor = { document: doc, selection: { active: { line: 0 } }, setDecorations: (t, opts) => decoCalls.push({ typeId: t.id, opts }), revealRange() {} };
  const vscode = {
    EventEmitter, TreeItem, ThemeIcon, Position, Range, Selection, MarkdownString, CodeLens, Hover,
    ThemeColor: class { constructor(id) { this.id = id; } },
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    Uri,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    TextEditorRevealType: { InCenter: 2 },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    workspace: {
      workspaceFolders: [{ uri: Uri.file(ws) }],
      textDocuments: [],
      asRelativePath: (f) => path.relative(ws, typeof f === 'string' ? f : f.fsPath),
      registerTextDocumentContentProvider: (s, p) => { contentProviders[s] = p; return { dispose() {} }; },
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (_k, def) => def, update: () => Promise.resolve() }),
      openTextDocument: (uri) => Promise.resolve({ uri, lineCount: 5, getText: () => 'AAA\nb\nc\nZZZ\n', lineAt: (n) => ({ range: new Range(n, 0, n, 3) }) }),
    },
    window: {
      createTreeView: (id, opts) => {
        trees[id] = opts.treeDataProvider;
        return { badge: undefined, description: undefined, onDidChangeVisibility: () => ({ dispose() {} }), dispose() {} };
      },
      createStatusBarItem: () => { const it = { text: '', tooltip: '', command: undefined, backgroundColor: undefined, show() {}, hide() {}, dispose() {} }; statusBarItems.push(it); return it; },
      setStatusBarMessage: () => ({ dispose() {} }),
      createTextEditorDecorationType: () => ({ id: ++decoCounter, dispose() {} }),
      registerFileDecorationProvider: (p) => { decoProvider = p; return { dispose() {} }; },
      registerWebviewViewProvider: (id, p) => { webviewProviders[id] = p; return { dispose() {} }; },
      withProgress: (_o, task) => task({ report() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      onDidChangeTextEditorSelection: () => ({ dispose() {} }),
      activeTextEditor: mockEditor,
      visibleTextEditors: [mockEditor],
      showTextDocument: (d) => { opened = d; lastShown = { document: d, selection: null, revealRange() {} }; return Promise.resolve(lastShown); },
      showInformationMessage: () => Promise.resolve(undefined),
      showInputBox: () => Promise.resolve(inputBoxValue),
      showWarningMessage: (_m, _o, ...items) => Promise.resolve(items[0]),
    },
    commands: {
      registerCommand: (id, cb) => { commands[id] = cb; return { dispose() {} }; },
      executeCommand: (cmd, ...args) => {
        if (cmd === 'vscode.diff') { diffCalls.push(args); return Promise.resolve(); }
        return Promise.resolve(commands[cmd] && commands[cmd](...args));
      },
    },
    comments: {
      createCommentController: (id, label) => {
        commentController = {
          id, label, commentingRangeProvider: undefined,
          createCommentThread: (uri, range, comments) => {
            const thread = { uri, range, comments, collapsibleState: undefined, canReply: undefined, contextValue: undefined, label: undefined, disposed: false, dispose() { thread.disposed = true; } };
            commentThreads.push(thread);
            return thread;
          },
          dispose() {},
        };
        return commentController;
      },
    },
    languages: {
      registerCodeLensProvider: (_sel, p) => { lensProvider = p; return { dispose() {} }; },
      registerHoverProvider: (_sel, p) => { hoverProvider = p; return { dispose() {} }; },
    },
    env: { clipboard: { writeText: (t) => { clipboardText = t; return Promise.resolve(); } } },
  };
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'vscode' ? vscode : origLoad.call(this, req, ...rest);
  };
  try {
    const ext = require(BUNDLE);
    ext.activate({ subscriptions: [], extensionUri: Uri.file(ws) });

    const editsTree = trees['claudeObservatory.edits'];
    const diffsTree = trees['claudeObservatory.diffs'];
    assert.ok(editsTree && diffsTree, 'Edits and Diffs views registered');
    // 0.8.0 panel consolidation: Timeline folded into Observations. Round 3: the standalone Multitasking
    // view is folded INTO the Overview (master–detail). Actions is now a SIDEBAR view (moved out of the
    // bottom-panel Observations dock into the Claude Edits activity-bar window, at the bottom).
    assert.ok(!trees['claudeObservatory.timeline'], 'the standalone Timeline view is gone (folded into Observations)');
    assert.ok(!webviewProviders['claudeObservatory.multitask'] && !trees['claudeObservatory.multitask'], 'the standalone Multitasking view is gone (folded into the Overview)');
    assert.ok(trees['claudeObservatory.actions'], 'Actions is registered as a timeline-style tree (now in the sidebar window)');

    // The Actions view now lives in the "Claude Edits" SIDEBAR container (activity-bar), at the BOTTOM
    // after File History — NOT in the bottom-panel dock (which is now Observations · Overview · Stats).
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    const sidebar = pkg.contributes.views.claudeObservatory;
    const dock = pkg.contributes.views.claudeObservatoryDock;
    const sidebarIds = sidebar.map((v) => v.id);
    assert.ok(sidebarIds.includes('claudeObservatory.actions'), 'Actions view is in the Claude Edits sidebar container');
    assert.equal(sidebarIds[sidebarIds.length - 1], 'claudeObservatory.actions', 'Actions is the LAST sidebar view (bottom, after File History)');
    assert.equal(sidebarIds[sidebarIds.indexOf('claudeObservatory.actions') - 1], 'claudeObservatory.fileHistory', 'Actions sits directly after File History');
    assert.ok(!dock.some((v) => v.id === 'claudeObservatory.actions'), 'Actions is no longer in the bottom-panel dock');
    assert.deepEqual(dock.map((v) => v.id), ['claudeObservatory.observations', 'claudeObservatory.changemap', 'claudeObservatory.stats'], 'the dock is now Observations · Overview · Stats');
    assert.ok(contentProviders['claude-edit'] && contentProviders['claude-observation'], 'blob + markdown content providers registered');
    assert.ok(decoProvider, 'status FileDecorationProvider registered');

    const files = editsTree.getChildren();
    assert.equal(files.length, 1);
    assert.equal(editsTree.getTreeItem(files[0]).label, 'app.txt');
    assert.equal(editsTree.getTreeItem(files[0]).command.command, 'claudeObservatory.openFile', 'file click opens file');
    const edits = editsTree.getChildren(files[0]);
    assert.equal(edits.length, 2);

    // click behavior differs per view
    assert.equal(editsTree.getTreeItem(edits[0]).command.command, 'claudeObservatory.openFileAtEdit', 'Edits view: edit click opens file at edit');
    assert.equal(diffsTree.getTreeItem(edits[0]).command.command, 'claudeObservatory.openDiff', 'Diffs view: edit click opens diff');

    // File History: a flat, chronological list of just the ACTIVE file's edits (follows the editor).
    const fileHistoryTree = trees['claudeObservatory.fileHistory'];
    assert.ok(fileHistoryTree, 'File History view registered');
    const fhRows = fileHistoryTree.getChildren();
    assert.equal(fhRows.length, 2, "file history lists the active file's edits");
    assert.equal(fhRows[0].rec.id, 1, 'file history is chronological (oldest first)');
    const fhItem = fileHistoryTree.getTreeItem(fhRows[0]);
    assert.match(fhItem.label, /#1/, 'file history row leads with the edit id');
    assert.equal(fhItem.command.command, 'claudeObservatory.openFileAtEdit', 'file history row click opens file at edit');
    assert.equal(fhItem.contextValue, 'edit', 'pending file-history row reuses the edit context menu');

    // ✨ gutter-star decorations: one at the START (first line) of each edit — #1 -> line 0, #2 -> line 3.
    // (These ranges get the star.svg gutterIconPath; no whole-line green fill anymore.)
    const starCall = decoCalls.filter((c) => c.typeId === 2).pop();
    assert.ok(starCall, 'gutter star decorations applied');
    assert.equal(starCall.opts.length, 2, 'one gutter star per edit');
    const starLines = new Set(starCall.opts.map((o) => o.start.line));
    assert.ok(starLines.has(0), 'edit #1 gets a gutter star at its first line (0)');
    assert.ok(starLines.has(3), 'edit #2 gets a gutter star at its first line (3)');

    // deletions render as red ghost text (decoration type 3); these edits only replace lines (even
    // swaps), so it must stay empty — a modification must never surface removed-line ghost text.
    const ghost = decoCalls.filter((c) => c.typeId === 3).pop();
    assert.ok(ghost, 'deletion ghost decoration applied');
    assert.equal(ghost.opts.length, 0, 'no ghost text for a pure modification');

    // inline CodeLens = the inline menu per edit: "✨ #N +A −R view changes" (opens the review bubble)
    // + ✓ Keep · ↩ Undo · 💬 Chat · ⧉ View diff (full diff tab). Reasoning is NOT on the CodeLens —
    // it rides in the bubble instead.
    assert.ok(lensProvider, 'CodeLens provider registered');
    const lenses = lensProvider.provideCodeLenses(doc);
    assert.ok(lenses.length >= 10, 'enriched CodeLens rows (view-changes + Keep/Undo/Chat/View-diff per edit)');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.viewChanges' && /✦ #\d\s+\+\d+\s+.\d+.*view changes/.test(l.command.title)), 'the "✦ #N +A −R … view changes" lens opens the inline review bubble');
    // the Diff-axis position now rides on the lens (the editor tab bar can't render live text)
    assert.ok(lenses.some((l) => /edit \d+\/\d+ in file/.test(l.command.title || '')), 'the lens shows the Diff-axis position (edit n/m in file)');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.inlineKeep'), 'a Keep lens');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.inlineUndo'), 'an Undo lens');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.chatEdit'), 'a Chat lens');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.openDiff' && /View diff/.test(l.command.title) && l.command.arguments[0].rec), 'a View-diff lens opens the full diff tab');
    assert.ok(!lenses.some((l) => l.command.command === 'claudeObservatory.showObservation'), 'no reasoning lens on the CodeLens (reasoning lives in the bubble)');
    // no editor hover provider (the hover card was removed earlier)
    assert.equal(hoverProvider, null, 'no editor hover provider');

    // "view changes" opens the inline review BUBBLE (Comment API) at the edit, its diff rendered in
    // git's own theme colors via sanitizer-safe <span style> (the technique GitLens uses). Toolbar
    // buttons (peekKeep/Undo/Chat/Prev/Next) act on the bubble; no clickable command links in the body.
    assert.ok(commentController && commentController.id === 'claudeObservatory', 'comment controller registered');
    for (const c of ['claudeObservatory.viewChanges', 'claudeObservatory.peekKeep', 'claudeObservatory.peekUndo',
      'claudeObservatory.peekChat', 'claudeObservatory.peekPrev', 'claudeObservatory.peekNext',
      'claudeObservatory.peekPrevFile', 'claudeObservatory.peekNextFile', 'claudeObservatory.peekAcceptFile',
      'claudeObservatory.peekRejectFile', 'claudeObservatory.diffPrevEdit', 'claudeObservatory.diffNextEdit']) {
      assert.ok(typeof commands[c] === 'function', `${c} registered`);
    }
    await commands['claudeObservatory.viewChanges'](1);
    const peek1 = commentThreads[commentThreads.length - 1];
    assert.ok(peek1, 'viewChanges opens a comment thread (the inline review bubble)');
    assert.equal(peek1.contextValue, 'claudeEdit', 'thread tagged for the bubble toolbar when-clause');
    assert.equal(peek1.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded, 'bubble opens expanded');
    assert.equal(peek1.canReply, false, 'bubble has no reply box');
    const body1 = peek1.comments[0].body;
    assert.equal(body1.supportHtml, true, 'body enables supportHtml (colored spans need it)');
    assert.match(body1.value, /#1\b/, 'bubble shows the edit number');
    assert.match(body1.value, /\+\d+ −\d+/, 'bubble shows the +A −B line counts');
    // the floating bubble is the full nav bar: its header carries the Diff-axis + File-axis counters
    assert.match(body1.value, /Diff 1\/2/, 'bubble header shows the Diff-axis counter (edit 1 of 2 in the file)');
    assert.match(body1.value, /File 1\/1/, 'bubble header shows the File-axis counter (file 1 of 1 pending)');
    assert.ok(body1.value.includes('<span style="color:var(--vscode-gitDecoration-addedResourceForeground);background-color:var(--vscode-diffEditor-insertedTextBackground);">'),
      "added lines use git's green text + translucent green line fill");
    assert.ok(body1.value.includes('<span style="color:var(--vscode-gitDecoration-deletedResourceForeground);background-color:var(--vscode-diffEditor-removedTextBackground);">'),
      "deleted lines use git's red text + translucent red line fill");
    assert.ok(!body1.value.includes('command:'), 'no clickable command links in the body (toolbar carries the actions)');
    // Prev/Next is our OWN nav: peekNext steps the bubble to edit #2.
    await commands['claudeObservatory.peekNext']();
    const peek2 = commentThreads[commentThreads.length - 1];
    assert.ok(peek2 !== peek1 && peek1.disposed, 'peekNext disposes the old thread and opens the next edit');
    assert.match(peek2.comments[0].body.value, /#2\b/, 'peekNext advanced the bubble to edit #2');
    // peekKeep marks the bubble's edit kept and closes it; restore pending for later assertions.
    await commands['claudeObservatory.peekKeep']();
    assert.equal(core.findRecord(S, 2).status, 'kept', 'peekKeep marks the peeked edit kept');
    assert.ok(peek2.disposed, 'peekKeep disposes the thread');
    core.setStatus(S, 2, 'pending'); // undo the mutation so the store stays at "2 pending" downstream
    // Prev/Next also live on diff TABS (Diffs tree / revision nav): from #1's diff URI, Next → #2's diff.
    await commands['claudeObservatory.openDiff'](edits[0]);
    const dUri = diffCalls[diffCalls.length - 1][1];
    await commands['claudeObservatory.diffNextEdit'](dUri);
    assert.match(diffCalls[diffCalls.length - 1][2], /#2/, 'diffNextEdit opens the next pending edit in the file');
    diffCalls.length = 0; // reset so the later openDiff test still sees exactly one diff call

    // Observations view (0.8.0, Timeline folded in): timeline-STYLE — a recap on top, then the edit feed
    // with adjacent same-file edits coalesced into ×N runs (each carrying Claude's reasoning inline),
    // then a Next-steps group at the end. The two app.txt edits coalesce into one ×2 run.
    const obsTree = trees['claudeObservatory.observations'];
    assert.ok(obsTree, 'Observations view registered');
    const obsChildren = obsTree.getChildren();
    assert.equal(obsChildren[0].kind, 'recap', 'first node is the recap line');
    const recapItem = obsTree.getTreeItem(obsChildren[0]);
    assert.equal(recapItem.label, 'Reviewing app.txt edits', 'recap shows the session title (aiTitle)');
    assert.ok(!recapItem.command, 'recap has no click command — refresh is a button');
    assert.equal(recapItem.contextValue, 'recap');
    // timeline-style coalescing: the two same-file edits become one ×2 run (combined delta).
    const obsRun = obsChildren.find((n) => n.kind === 'tlrun');
    assert.ok(obsRun, 'the two same-file edits coalesce into one ×N run');
    const runItem = obsTree.getTreeItem(obsRun);
    assert.match(runItem.label, /app\.txt\s+×2/, 'run row shows the file + ×2');
    assert.match(runItem.description, /^\+\d+ −\d+/, 'run row shows the combined delta');
    assert.equal(runItem.contextValue, 'file', 'run reuses the file Keep-all/Undo-all/Clear menus');
    // expand the run → per-edit rows, each showing Claude's reasoning inline, with Keep/Undo.
    const runEdits = obsTree.getChildren(obsRun);
    assert.equal(runEdits.length, 2, 'run expands to its per-edit rows');
    const eItem = obsTree.getTreeItem(runEdits[0]);
    assert.match(eItem.label, /#\d/, 'edit row leads with #id');
    assert.match(String(eItem.description), /Operation/, "edit row shows Claude's reasoning inline");
    assert.equal(eItem.contextValue, 'edit', 'per-edit rows reuse the edit context menu (Keep/Undo/Chat)');
    assert.equal(eItem.command.command, 'claudeObservatory.showObservation', 'edit row opens the combined report');
    // Next steps: the still-open to-dos + heuristic follow-ups, grouped at the end.
    assert.ok(obsChildren.some((n) => n.kind === 'steps'), 'the Next-steps group is present');
    assert.ok(obsChildren.some((n) => n.kind === 'suggestion'), 'next-steps suggestions are listed');
    const obsMd = contentProviders['claude-observation'].provideTextDocumentContent({ authority: 'obs', path: '/edit-1.md', query: 's=' + S });
    assert.match(obsMd, /\*\*Summary:\*\*/, 'observation markdown has a summary');

    // Actions tab (0.8.0 round 3, moved out of Multitasking) — the session's tool-call timeline as the
    // second tab of the Observations panel: collapsible category subsections (from buildActionGroups),
    // each action TIMESTAMPED; an edit-action drills into its review. The Subagents (agent) category is
    // dropped (those are the Overview fleet). The two seeded Edits form the "Edits" subsection.
    const actTree = trees['claudeObservatory.actions'];
    assert.ok(actTree, 'Actions view registered as a tree');
    const actGroups = actTree.getChildren();
    const editGroup = actGroups.find((n) => n.kind === 'agroup' && n.label === 'Edits');
    assert.ok(editGroup, 'the Actions timeline has a collapsible "Edits" category subsection');
    assert.equal(actTree.getTreeItem(editGroup).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'category subsections are collapsed by default (user expands on demand)');
    assert.match(String(actTree.getTreeItem(editGroup).description), /2/, 'the Edits subsection counts the two seeded edits');
    assert.ok(!actGroups.some((n) => n.kind === 'agroup' && n.label === 'Subagents'), 'the Subagents category is dropped (those are the Overview fleet)');
    const actRows = actTree.getChildren(editGroup);
    assert.equal(actRows.length, 2, 'the Edits subsection expands to its two action rows');
    const aItem = actTree.getTreeItem(actRows[0]);
    assert.match(aItem.label, /Edit/, 'an action row shows the tool');
    assert.ok(/\d\d:\d\d|--:--/.test(aItem.label), 'an action row leads with a TIMESTAMP column');
    assert.equal(aItem.command.command, 'claudeObservatory.viewChanges', 'an edit-action links to its review (viewChanges)');
    assert.ok(typeof aItem.command.arguments[0] === 'number', 'the edit-action carries the store edit id to review');

    // Combined Stats + Usage webview: one view — plots on top, usage bars below; both fed via postMessage.
    const stProvider = webviewProviders['claudeObservatory.stats'];
    assert.ok(stProvider && !webviewProviders['claudeObservatory.statusline'], 'single combined Stats view (Usage merged in)');
    let stMsgHandler = null;
    const stView = {
      webview: { options: {}, html: '', postMessage: () => {}, onDidReceiveMessage: (cb) => { stMsgHandler = cb; return { dispose() {} }; } },
      onDidChangeVisibility: () => ({ dispose() {} }),
      visible: false, // no subprocess spawn while hidden
    };
    stProvider.resolveWebviewView(stView);
    assert.match(stView.webview.html, /ctx/, 'usage bars present (ctx row)');
    assert.match(stView.webview.html, /5h/, 'usage bars present (5h row)');
    assert.match(stView.webview.html, />Today</, 'the Today/7d/30d range toggle is present');
    // live review scoreboard replaced the old Edits chart: counts + a progress bar, fed via postMessage.
    assert.match(stView.webview.html, /id="rv-pending"/, 'review scoreboard: pending count cell present');
    assert.match(stView.webview.html, /id="rv-fill"/, 'review scoreboard: progress bar present');
    const scMsgs = [];
    stView.webview.postMessage = (m) => scMsgs.push(m);
    stProvider.refresh();
    assert.ok(scMsgs.some((m) => m.type === 'counts' && m.c.pending === 2 && m.c.kept === 0 && m.c.undone === 0),
      'stats posts the live review counts (2 pending, 0 accepted, 0 reverted)');
    assert.match(stView.webview.html, /Gathering stats/i, 'stats placeholder present until the scan returns');
    assert.match(stView.webview.html, /id="ustale"/, 'stale-cache hint present (panel-only sessions)');
    // CLI-missing hint: a failed scan (before any data) posts statsError so the webview shows install help
    const stMsgs = [];
    stView.webview.postMessage = (m) => stMsgs.push(m);
    stProvider.postStatsError();
    assert.ok(stMsgs.some((m) => m.type === 'statsError'), 'failed stats scan posts the CLI-missing hint');

    // Overview webview (0.8.0 round 3 — MASTER–DETAIL): the standalone Multitasking view is folded IN.
    // LEFT NAV = two sub-tabs Fleet · Workflows (rendered from multitask --json). RIGHT DETAIL = the
    // change-map (named-chapter ribbon · module strip · churn ledger) for the SELECTED nav item (from
    // changemap --json). The count/size toggle is GONE (always sizes by ± lines).
    const cmProvider = webviewProviders['claudeObservatory.changemap'];
    assert.ok(cmProvider, 'Overview view registered in the panel');
    let cmMsgHandler = null;
    const cmView = {
      webview: { options: {}, html: '', postMessage: () => {}, onDidReceiveMessage: (cb) => { cmMsgHandler = cb; return { dispose() {} }; } },
      onDidChangeVisibility: () => ({ dispose() {} }),
      visible: false, // no subprocess spawn while hidden
    };
    cmProvider.resolveWebviewView(cmView);
    // TOP NAVBAR (like Observations): a session selector (Switch Session) + the same session-wide review
    // actions — Accept All · Revert All · Clear Resolved · Refresh — each posting to the host command.
    assert.match(cmView.webview.html, /id="ov-toolbar"|class="ov-toolbar"/, 'Overview: a top navbar is present');
    assert.match(cmView.webview.html, /id="ov-sess"/, 'Overview: the top navbar has a session-selector control');
    assert.match(cmView.webview.html, /id="ov-sess-label"/, 'the session selector shows the active session (updated via postMessage)');
    assert.ok(/id="ov-keepall"/.test(cmView.webview.html) && /id="ov-undoall"/.test(cmView.webview.html) && /id="ov-clearres"/.test(cmView.webview.html) && /id="ov-refresh"/.test(cmView.webview.html),
      'the navbar carries Accept All · Revert All · Clear Resolved · Refresh');
    assert.ok(/Switch session/i.test(cmView.webview.html) && /Accept All/.test(cmView.webview.html) && /Revert All/.test(cmView.webview.html) && /Clear Resolved/.test(cmView.webview.html),
      'the navbar buttons are labelled to match the Observations toolbar');
    // LEFT NAV = 25% of the panel width (change-map detail gets the remaining 75%).
    assert.ok(/\.ov-nav \{[^}]*flex:0 0 25%/.test(cmView.webview.html), 'Overview: the left nav column is a fixed 25% (flex:0 0 25%)');
    // LEFT NAV: the Fleet · Workflows sub-tabs + item list.
    assert.match(cmView.webview.html, /id="ov-navtabs"/, 'Overview: left-nav sub-tab bar present (Fleet · Workflows)');
    assert.ok(/'Fleet'/.test(cmView.webview.html) && /'Workflows'/.test(cmView.webview.html), 'the left nav labels Fleet/Workflows');
    assert.ok(/renderNavTabs/.test(cmView.webview.html) && /function applyPanes/.test(cmView.webview.html), 'switching a nav tab toggles panes (renderNavTabs/applyPanes)');
    assert.match(cmView.webview.html, /id="ov-fleet"/, 'Overview: the Fleet list container is present');
    assert.match(cmView.webview.html, /id="ov-workflows"/, 'Overview: the Workflows list container is present');
    // Live conflicts MOVED to the Actions panel (0.8.3) — the Overview must no longer render them.
    assert.ok(!/ov-collisions/.test(cmView.webview.html), 'Overview: the live-collisions strip is gone (it lives in the Actions panel now)');
    // The Tasks tab (0.8.3): third nav pane, chapter-joined rows, done-collapse toggle.
    assert.match(cmView.webview.html, /id="ov-tasks"/, 'Overview: the Tasks pane container is present');
    assert.ok(/'Tasks'/.test(cmView.webview.html) && /renderTasks/.test(cmView.webview.html), 'the left nav labels Tasks and renders it');
    assert.ok(/chapterId/.test(cmView.webview.html) && /mt-ttog/.test(cmView.webview.html), 'task rows join their chapters + completed tasks collapse behind a toggle');
    assert.ok(/awaiting permission/.test(cmView.webview.html), 'the awaiting-permission needs-attention phase is surfaced');
    assert.ok(/mt-spark/.test(cmView.webview.html) && /renderFleet/.test(cmView.webview.html), 'Fleet rows carry a per-agent activity sparkline (+ ±lines/tokens/time/risk)');
    assert.ok(/fmtTok/.test(cmView.webview.html) && /fmtDur/.test(cmView.webview.html), 'Fleet + Workflows show tokens/time (fmtTok/fmtDur)');
    assert.ok(/phaseSummary/.test(cmView.webview.html) && /phaseGroups/.test(cmView.webview.html) && /w\.description/.test(cmView.webview.html) && /a\.label/.test(cmView.webview.html), 'Workflows show the informative name + per-phase progress + per-agent label');
    // DISPLAY filters (Active-only + Clear-completed) over the SAME pure multitaskFilter, on the nav.
    assert.match(cmView.webview.html, /id="mt-active"/, 'Overview: the Active-only toggle is present');
    assert.ok(/Active only/.test(cmView.webview.html), 'the toggle is labelled "Active only"');
    assert.match(cmView.webview.html, /id="mt-clear"/, 'Overview: the Clear-completed control is present');
    assert.ok(/Clear completed/.test(cmView.webview.html), 'the control is labelled "Clear completed"');
    assert.ok(/ACTIVE_ONLY/.test(cmView.webview.html) && /MTFILTER/.test(cmView.webview.html), 'the toggle drives a client-side ACTIVE_ONLY filter over the payload');
    assert.ok(/DISMISS_AG/.test(cmView.webview.html) && /DISMISS_WF/.test(cmView.webview.html), 'Clear-completed keeps a client-side dismissed set (agents + workflows)');
    assert.ok(/show all/.test(cmView.webview.html), 'an "N hidden · show all" un-dismiss affordance is present');
    assert.ok(/agentActive/.test(cmView.webview.html), 'the pure multitaskFilter body is embedded verbatim into the webview (one source of truth for test + UI)');
    // RIGHT DETAIL: the change-map for the selected nav item.
    assert.match(cmView.webview.html, /id="cm-ribbon"/, 'Overview: named-chapter ribbon present (right detail)');
    assert.match(cmView.webview.html, /id="cm-strip"/, 'Overview: module proportion strip present');
    assert.match(cmView.webview.html, /id="cm-ledger"/, 'Overview: ranked file ledger present');
    assert.match(cmView.webview.html, /id="cm-readout"/, 'Overview: footer readout present');
    assert.ok(!/id="cm-area"|data-area=/.test(cmView.webview.html), 'the count/size toggle is gone (always ± lines)');
    assert.ok(!/buildFiles|buildModules|buildChangeMap|listRepoSiblings|fleetConflicts|buildActionGroups/.test(cmView.webview.html), 'the client must not re-aggregate — core/CLI ship both payloads (changemap + multitask)');
    // the ribbon is a VERTICAL stacked list (one chapter per row), not wrapping pills.
    assert.ok(/\.cm-rwrap \{[^}]*flex-direction:column/.test(cmView.webview.html), 'Overview: the chapter ribbon is a vertical stacked list (cm-rwrap is a column)');
    // the ribbon renders the NAMED CHAPTERS (chapters[]) for the slice, not the strict tasks[].
    assert.ok(/a\.chapters/.test(cmView.webview.html) && /ch\.status==='wip'/.test(cmView.webview.html), 'Overview: the ribbon renders the slice’s named chapters[] (current work shows under its chapter, not unassigned)');
    // a WORKFLOW nav item renders a synthetic per-workflow detail slice (rollup → chips, files → ledger,
    // taskIds → the named-chapter ribbon), joined to CM by workflow id.
    assert.ok(/function workflowSlice/.test(cmView.webview.html) && /kind==='workflow'/.test(cmView.webview.html), 'Overview: a selected workflow renders a per-workflow detail slice (workflowSlice)');
    assert.ok(/function detailSlice/.test(cmView.webview.html) && /cmAgent/.test(cmView.webview.html), 'Overview: the detail joins the nav selection to the changemap slice by session/workflowId');
    // A hidden view must not shell out; and a failed scan (before any data) posts the CLI-missing hint.
    const cmMsgs = [];
    cmView.webview.postMessage = (m) => cmMsgs.push(m);
    cmProvider.refresh();
    assert.equal(cmMsgs.length, 0, 'a hidden Overview does not spawn the CLI or post');
    cmProvider.postError();
    assert.ok(cmMsgs.some((m) => m.type === 'error'), 'a failed Overview scan posts the CLI-missing hint');
    assert.ok(typeof cmMsgHandler === 'function', 'the Overview registered a message handler');
    // a subagent chat button (in the Fleet nav) hands off a zero-token chat by agentId.
    const cmSubChat = [];
    const realSubChat = commands['claudeObservatory.chatAction'];
    commands['claudeObservatory.chatAction'] = (ref) => { cmSubChat.push(ref); };
    cmMsgHandler({ type: 'chatAction', ref: { agentId: 'sa1' } });
    commands['claudeObservatory.chatAction'] = realSubChat;
    assert.deepEqual(cmSubChat, [{ agentId: 'sa1' }], 'a Fleet subagent chat button hands off a zero-token chat by agentId');
    // clicking a ledger row drills to the real edit review via the existing command (spy on the
    // registered callback — executeCommand resolves commands[id] at call time)
    const cmOpened = [];
    const realViewChanges = commands['claudeObservatory.viewChanges'];
    commands['claudeObservatory.viewChanges'] = (id) => { cmOpened.push(id); };
    cmMsgHandler({ type: 'openEdit', id: 1 });
    commands['claudeObservatory.viewChanges'] = realViewChanges;
    assert.deepEqual(cmOpened, [1], 'a ledger row click opens that edit for review');
    // a task-ribbon click hands off a zero-token chat about that task (chatAction with a taskId ref)
    const cmChat = [];
    const realChatAction = commands['claudeObservatory.chatAction'];
    commands['claudeObservatory.chatAction'] = (ref) => { cmChat.push(ref); };
    cmMsgHandler({ type: 'chatAction', ref: { taskId: 'abc123' } });
    commands['claudeObservatory.chatAction'] = realChatAction;
    assert.deepEqual(cmChat, [{ taskId: 'abc123' }], 'a task-ribbon click hands off a zero-token chat by taskId');

    // Chapter review actions (0.8.0): each task chip's ✓/↩/🧹 mini-buttons post taskKeep/taskUndo/taskClear,
    // which the provider routes to the strict-span task-keep/undo/clear commands. Plus a "Clear completed
    // chapters" affordance. The commands are registered; verify the message handler routes each correctly.
    for (const [msg, cmd] of [
      ['taskKeep', 'claudeObservatory.taskKeep'],
      ['taskUndo', 'claudeObservatory.taskUndo'],
      ['taskClear', 'claudeObservatory.taskClear'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      const seen = [];
      const real = commands[cmd];
      commands[cmd] = (id) => { seen.push(id); };
      cmMsgHandler({ type: msg, taskId: 'chap1' });
      commands[cmd] = real;
      assert.deepEqual(seen, ['chap1'], `a chip ${msg} routes to ${cmd} with the taskId`);
    }
    assert.ok(typeof commands['claudeObservatory.clearCompletedChapters'] === 'function', 'clearCompletedChapters registered');
    const ccSeen = [];
    const realCC = commands['claudeObservatory.clearCompletedChapters'];
    commands['claudeObservatory.clearCompletedChapters'] = () => { ccSeen.push(1); };
    cmMsgHandler({ type: 'clearCompletedChapters' });
    commands['claudeObservatory.clearCompletedChapters'] = realCC;
    assert.equal(ccSeen.length, 1, 'the "clear completed chapters" control routes to its command');

    // Top-navbar review actions route to the existing session-wide commands (the same the Observations
    // toolbar drives): the session selector + Accept All / Revert All / Clear Resolved / Refresh.
    for (const [msg, cmd] of [
      ['switchSession', 'claudeObservatory.switchSession'],
      ['keepAll', 'claudeObservatory.keepAll'],
      ['undoAll', 'claudeObservatory.undoAll'],
      ['clearResolved', 'claudeObservatory.clearResolved'],
      ['refresh', 'claudeObservatory.refresh'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      let seen = 0;
      const real = commands[cmd];
      commands[cmd] = () => { seen++; };
      cmMsgHandler({ type: msg });
      commands[cmd] = real;
      assert.equal(seen, 1, `the Overview navbar "${msg}" control routes to ${cmd}`);
    }

    // (1) CHAPTER-SCOPED BULK ACTIONS: selecting a chapter chip in the ribbon scopes the title-bar
    // Accept All / Revert All / Clear Resolved buttons to that chapter (reusing the strict-span task ops)
    // and relabels them "…in <chapter>". Deselecting returns them to session-wide. Verified from the
    // embedded webview source (the smoke harness renders the shell but doesn't execute its script).
    assert.ok(/SEL_CH/.test(cmView.webview.html), 'Overview: a selected-chapter var (SEL_CH) scopes the bulk actions');
    assert.match(cmView.webview.html, /data-sel=/, 'ribbon chips carry a selectable handle (data-sel)');
    assert.match(cmView.webview.html, /\.cm-task\.sel/, 'a selected chapter chip gets a highlighted state (.cm-task.sel)');
    assert.ok(/function toggleChapter/.test(cmView.webview.html), 'clicking a chip toggles the chapter selection (toggleChapter)');
    assert.ok(/function relabelBulk/.test(cmView.webview.html), 'the bulk buttons relabel to the selected scope (relabelBulk)');
    assert.ok(/Accept All in /.test(cmView.webview.html) && /Revert All in /.test(cmView.webview.html) && /Clear in /.test(cmView.webview.html),
      'the scoped bulk buttons read "… in <chapter>"');
    // the bulk wiring posts the strict-span task ops when a chapter is selected, else the session-wide op.
    assert.ok(/bulk\('ov-keepall','keepAll','taskKeep'\)/.test(cmView.webview.html)
      && /bulk\('ov-undoall','undoAll','taskUndo'\)/.test(cmView.webview.html)
      && /bulk\('ov-clearres','clearResolved','taskClear'\)/.test(cmView.webview.html),
      'a selected chapter reroutes Accept All / Revert All / Clear to the strict-span task ops');
    // the folded-in per-chip chat still hands off a zero-token chat by taskId (unchanged routing).
    assert.match(cmView.webview.html, /data-chat=/, 'each chapter chip keeps a zero-token chat handoff (💬)');

    // (2) STATUS-BAR REVIEW NAV BAR IN THE TITLE BAR: File ◄►, Diff ◄► with live n/m · i/k counters, plus
    // Keep, Undo, Accept File, Reject File, Spotlight, Search — the compact step-through controls, next to
    // the session selector, each posting to the existing nav commands.
    for (const id of ['ov-fileprev', 'ov-filecount', 'ov-filenext', 'ov-diffprev', 'ov-diffcount', 'ov-diffnext',
      'ov-navkeep', 'ov-navundo', 'ov-acceptfile', 'ov-rejectfile', 'ov-spotlight', 'ov-search']) {
      assert.ok(cmView.webview.html.includes(`id="${id}"`), `Overview title bar carries the nav-bar control ${id}`);
    }
    assert.ok(/renderNavPos/.test(cmView.webview.html), 'the Diff n/m · File i/k position counters render from the pushed NAVPOS');
    // the nav-bar buttons route to the existing status-bar nav commands (same controls, same backend).
    for (const [msg, cmd] of [
      ['navFilePrev', 'claudeObservatory.navFilePrev'],
      ['navFileNext', 'claudeObservatory.navFileNext'],
      ['navDiffPrev', 'claudeObservatory.navDiffPrev'],
      ['navDiffNext', 'claudeObservatory.navDiffNext'],
      ['navKeep', 'claudeObservatory.navKeep'],
      ['navUndo', 'claudeObservatory.navUndo'],
      ['keepOpenFile', 'claudeObservatory.keepOpenFile'],
      ['undoOpenFile', 'claudeObservatory.undoOpenFile'],
      ['toggleHeatmap', 'claudeObservatory.toggleHeatmap'],
      ['searchEdits', 'claudeObservatory.searchEdits'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      let seen = 0;
      const real = commands[cmd];
      commands[cmd] = () => { seen++; };
      cmMsgHandler({ type: msg });
      commands[cmd] = real;
      assert.equal(seen, 1, `the Overview nav-bar "${msg}" control routes to ${cmd}`);
    }
    // the live position push: setNavPos posts a {navpos} message to a VISIBLE Overview so the counters update.
    assert.ok(typeof cmProvider.setNavPos === 'function', 'the Overview exposes setNavPos (the host pushes the live Diff/File position)');
    cmView.visible = true;
    const navPosMsgs = [];
    cmView.webview.postMessage = (m) => navPosMsgs.push(m);
    cmProvider.setNavPos({ diff: { i: 1, n: 3 }, file: { i: 2, n: 4 } });
    cmView.visible = false;
    assert.ok(navPosMsgs.some((m) => m.type === 'navpos' && m.pos && m.pos.diff.n === 3 && m.pos.file.i === 2),
      'setNavPos pushes the Diff/File position to the visible Overview counters');

    // 0.8.0 stabilization: the literal-tabs prototype (overviewTabs/OverviewTab) was superseded by the
    // Fleet/Workflows master–detail nav and removed — the export must stay gone (dead code guard).
    assert.equal(ext.overviewTabs, undefined, 'overviewTabs prototype removed — per-agent views are the Fleet nav rows');

    // Chapter totality (0.8.0): the ribbon draws chapters[] as given — the residual "unassigned" math is
    // gone (core appends a synthetic session chapter instead), and destructive ops gate on the STRICT
    // chapter.taskId (null → the synthetic/duplicate rows render display-only).
    assert.ok(!/label:'unassigned'/.test(cmView.webview.html), 'no "unassigned" ribbon row can render — chapters are total');
    assert.ok(/data-keep="'\+cid/.test(cmView.webview.html), 'chapter ✓/↩/🧹 act WYSIWYG via the CHAPTER id (reviewEditIds — synthetic included)');
    assert.ok(/ch\.taskId/.test(cmView.webview.html), 'chapter chips still carry the strict taskId (the 💬 chat gate)');
    assert.ok(/ch\.synthetic/.test(cmView.webview.html), 'the synthetic session chapter is recognized and styled');
    assert.ok(/cm-task syn|cm-task'\+\(it\.syn/.test(cmView.webview.html), 'synthetic chapters get the dimmed style');
    assert.ok(/w\.chapters/.test(cmView.webview.html), 'a workflow slice renders its own core-built chapter ribbon (no residual math)');

    // Workflow auto-focus (0.8.0): a NEWLY-appeared running workflow switches the nav to Workflows,
    // selects it, and pulses its row; the FIRST payload only seeds the seen-set (no focus-steal on open).
    assert.ok(/SEEN_WF===null/.test(cmView.webview.html), 'first payload seeds the seen-set instead of stealing focus');
    assert.ok(/NAV='workflows'; SEL=\{kind:'workflow', id:freshWf\}/.test(cmView.webview.html), 'a new running workflow auto-focuses the Workflows nav + selects the run');
    assert.ok(/mt-wf\.flash/.test(cmView.webview.html), 'the new run pulses via the flash style');

    // multitaskFilter (unchanged, still exported): the ONE pure Active-only/Clear-completed filter the
    // Overview nav embeds verbatim. Driven off a fabricated payload — the webview runs this exact fn.
    assert.ok(typeof ext.multitaskFilter === 'function', 'multitaskFilter pure helper exported (unit-testable off the raw payload)');
    const mtPayload = {
      agents: [
        { session: 'aw', phase: 'working', subagents: [] }, // active (own phase)
        { session: 'ap', phase: 'awaiting-permission', subagents: [] }, // active (needs attention)
        { session: 'idleSub', phase: 'idle', subagents: [{ phase: 'working' }] }, // active via a live subagent
        { session: 'done1', phase: 'done', subagents: [] }, // completed
        { session: 'idle1', phase: 'idle', subagents: [{ phase: 'done' }] }, // completed
        { session: 'err1', phase: 'errored', subagents: [] }, // completed
      ],
      workflows: [{ id: 'wfRun', running: true }, { id: 'wfDone', running: false }],
    };
    const fAll = ext.multitaskFilter(mtPayload, {});
    assert.equal(fAll.agents.length, 6, 'no filter → every agent shows');
    assert.equal(fAll.workflows.length, 2, 'no filter → every workflow shows');
    assert.equal(fAll.activeAgents, 3, 'active = working + awaiting-permission + idle-with-a-live-subagent');
    assert.deepEqual(fAll.completedAgents.slice().sort(), ['done1', 'err1', 'idle1'], 'completed = idle/done/errored with no active subagent');
    assert.deepEqual(fAll.completedWorkflows, ['wfDone'], 'completed workflows = the non-running ones');
    const fActive = ext.multitaskFilter(mtPayload, { activeOnly: true });
    assert.deepEqual(fActive.agents.map((a) => a.session).slice().sort(), ['ap', 'aw', 'idleSub'], 'active-only keeps working/awaiting + agents with a live subagent, hides idle/done/errored');
    assert.deepEqual(fActive.workflows.map((w) => w.id), ['wfRun'], 'active-only keeps only running workflows');
    const dismissed = { dismissedAgents: { done1: 1, idle1: 1, err1: 1 }, dismissedWorkflows: { wfDone: 1 } };
    const fDismiss = ext.multitaskFilter(mtPayload, dismissed);
    assert.deepEqual(fDismiss.agents.map((a) => a.session).slice().sort(), ['ap', 'aw', 'idleSub'], 'Clear-completed hides the dismissed completed agents; actives remain');
    assert.equal(fDismiss.hiddenAgents, 3, 'the hidden-agent count feeds the "N hidden · show all" affordance');
    assert.deepEqual(fDismiss.workflows.map((w) => w.id), ['wfRun'], 'the dismissed finished workflow is hidden');
    assert.equal(fDismiss.hiddenWorkflows, 1, 'the hidden-workflow count is surfaced');
    // a dismissed item REAPPEARS the moment it goes active again (dismissal only bites while inactive).
    const revived = { agents: [{ session: 'done1', phase: 'working', subagents: [] }], workflows: [{ id: 'wfDone', running: true }] };
    const fRevive = ext.multitaskFilter(revived, dismissed);
    assert.equal(fRevive.agents.length, 1, 'a dismissed agent reappears once it is active again');
    assert.equal(fRevive.workflows.length, 1, 'a dismissed workflow reappears once it is running again');
    // The Workflows-tab cross-nav command is gone — selecting a workflow is now internal to the Overview.
    assert.ok(!commands['claudeObservatory.focusWorkflow'], 'focusWorkflow is gone (workflow selection is internal to the combined Overview)');

    // refreshAll refreshes the combined Overview + the Actions tab too — they ride the transcript watcher
    // for realtime updates (the Overview nav is live multi-agent state, mined from the transcript).
    let cmRefreshed = 0, actRefreshed = 0;
    const origCmRefresh = cmProvider.refresh.bind(cmProvider);
    const origActRefresh = actTree.refresh.bind(actTree);
    cmProvider.refresh = () => { cmRefreshed++; };
    actTree.refresh = () => { actRefreshed++; };
    await commands['claudeObservatory.refresh']();
    cmProvider.refresh = origCmRefresh;
    actTree.refresh = origActRefresh;
    assert.ok(cmRefreshed >= 1, 'refreshAll includes the combined Overview view');
    assert.ok(actRefreshed >= 1, 'refreshAll includes the Actions tab');

    // chatAction (0.8.0): the zero-token handoff for ANY action/edit/subagent/task. It assembles the
    // prompt IN-PROCESS via core.assembleChatContext (the same single-backend the CLI's chat-context
    // wraps — never a model call), copies it, and opens the user's Claude sidebar. Here: an edit ref.
    assert.ok(typeof commands['claudeObservatory.chatAction'] === 'function', 'chatAction command registered');
    let claudeOpened = 0;
    commands['claude-vscode.sidebar.open'] = () => { claudeOpened++; };
    clipboardText = '';
    await commands['claudeObservatory.chatAction']({ editId: 1 });
    assert.match(clipboardText, /app\.txt/, 'chatAction assembled a prompt about the edited file');
    assert.ok(/Please explain/.test(clipboardText), 'chatAction wrote the assembled chat-context prompt to the clipboard');
    assert.ok(clipboardText.includes('AAA') && clipboardText.includes('a\nb\nc'), 'chatAction prompt carries before/after (assembled in-process, not a model call)');
    assert.ok(claudeOpened >= 1, "chatAction opened the user's Claude (zero-token handoff)");
    delete commands['claude-vscode.sidebar.open'];

    // Stats top navbar: active session + clickable pending count → first edit. (The Search-edits box
    // was removed in 0.7.5 — the Edits/Diffs title-bar `searchEdits` action is the one search entry.)
    assert.ok(!/id="nb-search"/.test(stView.webview.html), 'no search box in the Stats navbar');
    assert.match(stView.webview.html, /id="nb-session"/, 'stats navbar shows the active session');
    assert.match(stView.webview.html, /id="rv-pending-cell"/, 'the pending count is a clickable cell');
    assert.ok(typeof commands['claudeObservatory.reviewFirst'] === 'function', 'reviewFirst command registered');
    assert.ok(!commands['claudeObservatory.searchWith'], 'searchWith is gone — it existed only to drive the removed search box');
    // the counts post carries the session the navbar renders
    const nbMsgs = [];
    stView.webview.postMessage = (m) => nbMsgs.push(m);
    stProvider.refresh();
    assert.ok(nbMsgs.some((m) => m.type === 'counts' && m.session === S), 'counts post carries the active session');
    // The webview registers a handler for the one message it still sends (the pending cell → reviewFirst).
    // Deliberately not driven here: reviewFirst moves the review cursor, which later assertions depend on.
    assert.ok(typeof stMsgHandler === 'function', 'the stats webview registered a message handler');

    // realtime observatory: status-bar microscope shows the pending count + the review scoreboard tooltip
    const microscope = statusBarItems.find((i) => /🔬/.test(i.text));
    assert.ok(microscope, 'status bar microscope present');
    assert.match(microscope.text, /2/, 'status bar shows 2 pending');
    assert.match(microscope.tooltip.value, /2 pending · 0 accepted · 0 reverted/, 'scoreboard lives in the microscope tooltip');

    // --- nav bar: the two-tier review toolbar (Diff axis + File axis + per-edit / per-file actions) ---
    for (const c of ['claudeObservatory.navDiffPrev', 'claudeObservatory.navDiffNext',
      'claudeObservatory.navFilePrev', 'claudeObservatory.navFileNext',
      'claudeObservatory.navViewDiff', 'claudeObservatory.navKeep', 'claudeObservatory.navUndo']) {
      assert.ok(typeof commands[c] === 'function', `${c} registered`);
    }
    const diffCounter = statusBarItems.find((i) => /^Diff /.test(i.text));
    const fileCounter = statusBarItems.find((i) => /^File /.test(i.text));
    assert.equal(diffCounter && diffCounter.text, 'Diff 1/2', 'Diff axis: edit 1 of 2 in the active file');
    assert.equal(fileCounter && fileCounter.text, 'File 1/1', 'File axis: file 1 of 1 with pending edits');
    // Diff axis steps within the open file: #1 (line 0) → #2 (line 3) → back to #1.
    await commands['claudeObservatory.navDiffNext']();
    assert.equal(lastShown.selection.active.line, 3, 'navDiffNext reveals edit #2');
    assert.equal(diffCounter.text, 'Diff 2/2', 'Diff counter advanced to 2/2');
    await commands['claudeObservatory.navDiffPrev']();
    assert.equal(lastShown.selection.active.line, 0, 'navDiffPrev returns to edit #1');
    assert.equal(diffCounter.text, 'Diff 1/2', 'Diff counter back to 1/2');
    assert.ok(typeof commands['claudeObservatory.reviewNext'] === 'function', 'reviewNext registered');
    // reviewNext must step through EVERY pending edit, not always reopen the oldest: #1 (line 0) →
    // #2 (line 3) → wrap back to #1.
    await commands['claudeObservatory.reviewNext']();
    assert.ok(opened && opened.uri.fsPath === F, 'reviewNext opened the file with the oldest pending edit');
    assert.equal(lastShown.selection.active.line, 0, 'first reviewNext lands on edit #1');
    await commands['claudeObservatory.reviewNext']();
    assert.equal(lastShown.selection.active.line, 3, 'second reviewNext advances to edit #2');
    await commands['claudeObservatory.reviewNext']();
    assert.equal(lastShown.selection.active.line, 0, 'third reviewNext wraps back to edit #1');
    // reviewPrev walks the other way: from #1 it wraps to #2, then back to #1.
    assert.ok(typeof commands['claudeObservatory.reviewPrev'] === 'function', 'reviewPrev registered');
    await commands['claudeObservatory.reviewPrev']();
    assert.equal(lastShown.selection.active.line, 3, 'reviewPrev steps back to edit #2');
    await commands['claudeObservatory.reviewPrev']();
    assert.equal(lastShown.selection.active.line, 0, 'reviewPrev steps back to edit #1');
    // Stats "pending count" click → reviewFirst jumps to the OLDEST pending edit regardless of the cursor.
    await commands['claudeObservatory.reviewNext'](); // move off the first edit (→ #2, line 3)
    assert.equal(lastShown.selection.active.line, 3, 'moved to edit #2 before testing reviewFirst');
    await commands['claudeObservatory.reviewFirst']();
    assert.equal(lastShown.selection.active.line, 0, 'reviewFirst jumps back to the oldest pending edit (#1)');
    opened = null;

    // Search: filter the Edits tree by file path (parity: the JetBrains tree filters identically).
    assert.ok(typeof commands['claudeObservatory.searchEdits'] === 'function', 'searchEdits registered');
    inputBoxValue = 'zzz-nomatch';
    await commands['claudeObservatory.searchEdits']();
    assert.equal(editsTree.getChildren().length, 0, 'a non-matching search hides every edit');
    inputBoxValue = 'app';
    await commands['claudeObservatory.searchEdits']();
    assert.ok(editsTree.getChildren().length >= 1, 'a matching search shows the file again');
    inputBoxValue = ''; // clear so the later assertions still see all edits
    await commands['claudeObservatory.searchEdits']();
    assert.ok(editsTree.getChildren().length >= 1, 'clearing the search restores all edits');

    // new commands exist
    for (const c of ['claudeObservatory.keepAll', 'claudeObservatory.undoAll', 'claudeObservatory.chatEdit',
      'claudeObservatory.showObservation', 'claudeObservatory.analyzeEdit', 'claudeObservatory.refreshRecap',
      'claudeObservatory.switchSession', 'claudeObservatory.exportSummary', 'claudeObservatory.doctor',
      'claudeObservatory.diffPrevRevision', 'claudeObservatory.diffNextRevision',
      'claudeObservatory.diffKeep', 'claudeObservatory.diffUndo', 'claudeObservatory.diffChat']) {
      assert.ok(typeof commands[c] === 'function', `${c} registered`);
    }

    // chat: copies a prompt (with the diff) to the clipboard
    await commands['claudeObservatory.chatEdit'](1);
    assert.match(clipboardText, /edit #1/, 'chat prompt names the edit');
    assert.ok(clipboardText.includes('AAA') && clipboardText.includes('a\nb\nc'), 'chat prompt carries before/after');

    // openFileAtEdit opens the real file
    await commands['claudeObservatory.openFileAtEdit'](edits[0]);
    assert.ok(opened && opened.uri.fsPath === F, 'openFileAtEdit opened the file');

    // diff still works (Diffs view / inline)
    await commands['claudeObservatory.openDiff'](edits[0]);
    assert.equal(diffCalls.length, 1);
    const [left, right] = diffCalls[0];
    assert.equal(left.scheme, 'claude-edit');
    assert.equal(contentProviders['claude-edit'].provideTextDocumentContent(left), 'a\nb\nc\nd\n');
    assert.equal(contentProviders['claude-edit'].provideTextDocumentContent(right), 'AAA\nb\nc\nd\n');
    // the diff URIs carry the edit id so the diff's title-bar actions can resolve it
    assert.equal(new URLSearchParams(right.query).get('e'), '1', 'diff URI carries the edit id');
    clipboardText = '';
    await commands['claudeObservatory.diffChat'](right); // title-bar action gets the modified URI
    assert.match(clipboardText, /edit #1/, 'a diff title-bar action resolves the edit id from the diff URI');

    // revision navigation: step to the newest revision → a current-vs-revision diff (recorded blob ⟶ live file)
    await commands['claudeObservatory.diffNextRevision']();
    const revCall = diffCalls.find((c) => /⟶ \(this file\)/.test(c[2]));
    assert.ok(revCall, 'revision nav opens an "edit #N ⟶ (this file)" diff');
    assert.equal(revCall[0].scheme, 'claude-edit', 'revision diff LEFT is the recorded blob');
    assert.equal(revCall[1].scheme, 'file', 'revision diff RIGHT is the live current file');

    // keyboard review loop: keep the edit under the cursor (edit #2 lives on line 3, 'ZZZ')
    mockEditor.selection = new Selection(new Position(3, 0), new Position(3, 0));
    await commands['claudeObservatory.keepAtCursor']();
    assert.equal(core.findRecord(S, 2).status, 'kept', 'keepAtCursor kept the edit under the cursor');
    assert.ok(typeof commands['claudeObservatory.undoAtCursor'] === 'function', 'undoAtCursor registered');

    await commands['claudeObservatory.undo'](edits[0]);
    const after = fs.readFileSync(F, 'utf8');
    assert.ok(after.startsWith('a\n'), 'top reverted');
    assert.ok(after.includes('ZZZ'), 'later edit preserved');
    assert.equal(core.findRecord(S, 1).status, 'undone');

    // status styling: reverted #1 struck through; kept #2 + undone #1 greyed via the decoration provider
    const edits3 = editsTree.getChildren(editsTree.getChildren()[0]);
    const item1 = editsTree.getTreeItem(edits3.find((n) => n.rec.id === 1));
    const item2 = editsTree.getTreeItem(edits3.find((n) => n.rec.id === 2));
    assert.ok(item1.label.includes('̶'), 'reverted edit label is struck through');
    assert.match(item1.resourceUri.query, /status=undone/, 'reverted item carries status uri');
    assert.match(item2.resourceUri.query, /status=kept/, 'kept item carries status uri');
    assert.ok(decoProvider.provideFileDecoration(item1.resourceUri), 'reverted row greyed');
    assert.ok(decoProvider.provideFileDecoration(item2.resourceUri), 'kept row greyed');
    assert.equal(
      decoProvider.provideFileDecoration({ scheme: 'claude-change', query: 'status=pending' }),
      undefined,
      'pending row not greyed'
    );

    // review memory: after the keep + undo above, the per-edit observation row carries the file's history.
    // The two app.txt edits still coalesce into one ×2 run — expand it to reach edit #1's row.
    const obsRunAfter = obsTree.getChildren().find((n) => n.kind === 'tlrun');
    const editRows = obsRunAfter ? obsTree.getChildren(obsRunAfter) : obsTree.getChildren().filter((n) => n.kind === 'edit');
    const memTip = obsTree.getTreeItem(editRows.find((n) => n.rec.id === 1)).tooltip;
    assert.match(memTip, /🧠 2 edits across sessions · 50% accepted/, 'observation tooltip carries cross-session file memory');
    const memMd = contentProviders['claude-observation'].provideTextDocumentContent({ authority: 'obs', path: '/edit-1.md', query: 's=' + S });
    assert.match(memMd, /## File history \(all sessions\)/, 'combined report has a File history section');

    // file-scoped accept: keepOpenFile (active editor = app.txt) touches ONLY that file's pending edits.
    const G = path.join(ws, 'other.txt');
    const fb = core.writeBlob(S, Buffer.from('p\n')), fa = core.writeBlob(S, Buffer.from('p\nq\n'));
    // appendLog now OWNS id allocation (S1) — capture the id it assigns instead of hardcoding one.
    const rF = core.appendLog(S, { ts: 9800, tool: 'Edit', file: F, beforeBlob: fb, afterBlob: fa, status: 'pending' });
    const gb = core.writeBlob(S, Buffer.from('x\n')), ga = core.writeBlob(S, Buffer.from('x\ny\n'));
    const rG = core.appendLog(S, { ts: 9900, tool: 'Edit', file: G, beforeBlob: gb, afterBlob: ga, status: 'pending' });
    assert.ok(typeof commands['claudeObservatory.keepOpenFile'] === 'function', 'keepOpenFile registered');
    await commands['claudeObservatory.keepOpenFile'](); // active editor's file is app.txt (F)
    const flog = core.readLog(S);
    assert.equal(flog.find((r) => r.id === rF.id).status, 'kept', 'keepOpenFile accepted the active file (app.txt)');
    assert.equal(flog.find((r) => r.id === rG.id).status, 'pending', 'keepOpenFile left the other file (other.txt) untouched');
  } finally {
    Module._load = origLoad;
  }
});
