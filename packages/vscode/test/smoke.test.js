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
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Reviewing app.txt edits' }),
    JSON.stringify({ message: { role: 'assistant', content: [
      { type: 'text', text: 'Operation 1 — introduce the greeting' },
      { type: 'tool_use', name: 'Edit', input: { file_path: F } },
    ] } }),
    JSON.stringify({ message: { role: 'assistant', content: [
      { type: 'text', text: 'Operation 2 — add a farewell() method' },
      { type: 'tool_use', name: 'Edit', input: { file_path: F } },
    ] } }),
  ].join('\n'));
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
    const timelineTree = trees['claudeObservatory.timeline'];
    assert.ok(editsTree && diffsTree && timelineTree, 'Edits, Diffs, and Timeline views registered');
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
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.viewChanges' && /✨ #\d\s+\+\d+\s+.\d+\s+view changes/.test(l.command.title)), 'the "✨ #N +A −R view changes" lens opens the inline review bubble');
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

    // Timeline: a newest-first change feed; the two same-file edits coalesce into one collapsible run.
    const feed = timelineTree.getChildren();
    assert.equal(feed.length, 1, 'two same-file edits coalesce into one run row');
    assert.equal(feed[0].kind, 'tlrun', 'multi-edit run node');
    const runItem = timelineTree.getTreeItem(feed[0]);
    assert.match(runItem.label, /app\.txt\s+×2/, 'run row shows the file + ×2');
    assert.match(runItem.description, /^\+\d+ −\d+/, 'run row shows the combined delta');
    const runEdits = timelineTree.getChildren(feed[0]);
    assert.equal(runEdits.length, 2, 'run expands to its edits');
    const childItem = timelineTree.getTreeItem(runEdits[0]);
    assert.match(childItem.label, /#\d/, 'run child leads with #id');
    assert.match(childItem.description, /^\d{2}:\d{2} · /, 'run child: time + delta');
    assert.equal(childItem.command.command, 'claudeObservatory.openFileAtEdit', 'child click reveals the edit');

    // Observations view: a one-line recap on top, then one row per edit (no groups, no Next steps).
    const obsTree = trees['claudeObservatory.observations'];
    assert.ok(obsTree, 'Observations view registered');
    const obsChildren = obsTree.getChildren();
    assert.equal(obsChildren[0].kind, 'recap', 'first node is the recap line');
    const recapItem = obsTree.getTreeItem(obsChildren[0]);
    assert.equal(recapItem.label, 'Reviewing app.txt edits', 'recap shows the session title (aiTitle)');
    assert.ok(!recapItem.command, 'recap has no click command — refresh is a button');
    assert.equal(recapItem.contextValue, 'recap');
    assert.ok(!obsChildren.some((n) => n.kind === 'sug' || n.kind === 'group' || n.kind === 'sugGen'), 'Next-steps group is gone');
    const obsNodes = obsChildren.filter((n) => n.kind === 'obs');
    assert.equal(obsNodes.length, 2, 'one observation per edit');
    const obsItem = obsTree.getTreeItem(obsNodes[0]);
    assert.match(obsItem.label, /#\d/, 'observation labelled by edit');
    assert.equal(obsItem.command.command, 'claudeObservatory.showObservation', 'observation click opens the report');
    assert.equal(obsTree.getChildren(obsNodes[0]).length, 0, 'observation rows are leaves');
    const obsMd = contentProviders['claude-observation'].provideTextDocumentContent({ authority: 'obs', path: '/edit-1.md', query: 's=' + S });
    assert.match(obsMd, /\*\*Summary:\*\*/, 'observation markdown has a summary');

    // Actions view (0.6.0): the session's tool calls grouped by category. This transcript has two Edit
    // tool_uses on app.txt → one "Edits" group with 2 rows, each linked to its store edit (curated default).
    const actionsTree = trees['claudeObservatory.actions'];
    assert.ok(actionsTree, 'Actions view registered');
    const actGroups = actionsTree.getChildren();
    assert.ok(actGroups.length >= 1 && actGroups[0].kind === 'group', 'actions are grouped by category');
    const editGroup = actGroups.find((g) => g.group.category === 'edit');
    assert.ok(editGroup, 'the Edits group is present (curated default shows edits)');
    const gItem = actionsTree.getTreeItem(editGroup);
    assert.equal(gItem.label, 'Edits');
    assert.match(String(gItem.description), /2/, 'Edits group shows its count');
    const actRows = actionsTree.getChildren(editGroup);
    assert.equal(actRows.length, 2, 'two Edit actions in the Edits group');
    const aItem = actionsTree.getTreeItem(actRows[0]);
    assert.match(aItem.label, /Edit/, 'action row leads with the tool name');
    assert.equal(aItem.command.command, 'claudeObservatory.viewChanges', 'an edit action links to the review bubble');
    assert.ok(typeof commands['claudeObservatory.actionsShowAll'] === 'function' && typeof commands['claudeObservatory.actionsShowCurated'] === 'function', 'actions show-all/curated toggles registered');

    // Combined Stats + Usage webview: one view — plots on top, usage bars below; both fed via postMessage.
    const stProvider = webviewProviders['claudeObservatory.stats'];
    assert.ok(stProvider && !webviewProviders['claudeObservatory.statusline'], 'single combined Stats view (Usage merged in)');
    const stView = {
      webview: { options: {}, html: '', postMessage: () => {}, onDidReceiveMessage: () => ({ dispose() {} }) },
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

    // review memory: after the keep + undo above, the observation row carries the file's history
    const obsAfter = obsTree.getChildren().filter((n) => n.kind === 'obs');
    const memTip = obsTree.getTreeItem(obsAfter.find((n) => n.rec.id === 1)).tooltip;
    assert.match(memTip, /🧠 2 edits across sessions · 50% accepted/, 'observation tooltip carries cross-session file memory');
    const memMd = contentProviders['claude-observation'].provideTextDocumentContent({ authority: 'obs', path: '/edit-1.md', query: 's=' + S });
    assert.match(memMd, /## File history \(all sessions\)/, 'combined report has a File history section');

    // file-scoped accept: keepOpenFile (active editor = app.txt) touches ONLY that file's pending edits.
    const G = path.join(ws, 'other.txt');
    const fb = core.writeBlob(S, Buffer.from('p\n')), fa = core.writeBlob(S, Buffer.from('p\nq\n'));
    core.appendLog(S, { id: 98, ts: 9800, tool: 'Edit', file: F, beforeBlob: fb, afterBlob: fa, status: 'pending' });
    const gb = core.writeBlob(S, Buffer.from('x\n')), ga = core.writeBlob(S, Buffer.from('x\ny\n'));
    core.appendLog(S, { id: 99, ts: 9900, tool: 'Edit', file: G, beforeBlob: gb, afterBlob: ga, status: 'pending' });
    assert.ok(typeof commands['claudeObservatory.keepOpenFile'] === 'function', 'keepOpenFile registered');
    await commands['claudeObservatory.keepOpenFile'](); // active editor's file is app.txt (F)
    const flog = core.readLog(S);
    assert.equal(flog.find((r) => r.id === 98).status, 'kept', 'keepOpenFile accepted the active file (app.txt)');
    assert.equal(flog.find((r) => r.id === 99).status, 'pending', 'keepOpenFile left the other file (other.txt) untouched');
  } finally {
    Module._load = origLoad;
  }
});
