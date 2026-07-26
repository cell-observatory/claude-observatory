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
  const OUT = path.join(home, 'notes', 'outside.md'); // deliberately NOT under the workspace
  // transcript: the ai-title recap + two assistant messages whose Edit tool_uses on F carry Claude's
  // reasoning (correlated per-file to store edits #1/#2) — feeds the inline reasoning lens + blame.
  const AG = 'sa0000000001';
  fs.writeFileSync(path.join(proj, S + '.jsonl'), [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Reviewing app.txt edits' }),
    // top-level type:'assistant' so resolution passes via hasAssistantRecord, not the all-stub fallback
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Operation 1 — introduce feature scaling' },
      { type: 'tool_use', name: 'Edit', input: { file_path: F } },
    ] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'text', text: 'Operation 2 — add a validate() method' },
      { type: 'tool_use', name: 'Edit', input: { file_path: F } },
    ] } }),
    // 0.8.7: one read and one edit that land OUTSIDE the workspace — the two facts the folded footprint
    // left behind, which the Actions tree's Egress (reach) and Risk (damage) sections must state.
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', name: 'Read', input: { file_path: OUT } },
      { type: 'tool_use', name: 'Edit', input: { file_path: OUT } },
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
  // a NEWER command-only stub (an /effort run): must NOT hijack resolution away from S — the
  // whole extension smoke below only passes if the resolver demotes this assistant-less file.
  fs.writeFileSync(path.join(proj, 'stubEffort01.jsonl'), [
    JSON.stringify({ type: 'user', sessionId: 'stubEffort01', cwd: ws, message: { role: 'user', content: '<command-name>/effort</command-name>' } }),
    JSON.stringify({ type: 'user', sessionId: 'stubEffort01', cwd: ws, message: { role: 'user', content: '<local-command-stdout>Set effort level to xhigh</local-command-stdout>' } }),
  ].join('\n'));
  const fresh = Math.floor(Date.now() / 1000) + 60;
  fs.utimesSync(path.join(proj, 'stubEffort01.jsonl'), fresh, fresh);
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
  const treeViewOpts = {};
  const contentProviders = {};
  const webviewProviders = {};
  const configWrites = []; // [key, value] — demo mode must never write claudeObservatory.session
  let progressCancelled = false; // drives the demo replay's cancellation path without a 17s paced run
  const openTabs = []; // window.tabGroups contents — exitDemo must close the demo's editors
  const infoMessages = []; // every showInformationMessage — the first-run offer must not appear here
  const warnMessages = []; // every showWarningMessage — a refusal has to SAY why, not fail silently
  let infoPick; // what the mock reader clicks on the next showInformationMessage (undefined = dismiss)
  /**
   * The actions offered by a show*Message call, for BOTH of the API's overloads:
   * `(message, ...items)` and `(message, options, ...items)`. Assuming the second argument is always an
   * options object silently shifted every positional-items call by one — the extension has eleven of
   * them — so the mock returned the SECOND button while the code under test believed it had the first.
   * That is a mock that can only fail where the branch is rarely taken, which is the worst place for it.
   */
  const actionsOf = (rest) => {
    const [first] = rest;
    // An options object is an object WITHOUT a `title` — a MessageItem action has one. That is how the
    // real API tells the two overloads apart, so the mock must too; testing only `typeof === 'object'`
    // would swallow a MessageItem action the first time anyone used one.
    const isOptions = first !== null && typeof first === 'object' && !('title' in first);
    return isOptions ? rest.slice(1) : rest;
  };
  const webviewPanels = []; // createWebviewPanel calls — the tour is a detachable panel
  let quickPick = null; // what showQuickPick should return (the tour's track chooser)
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
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
    ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
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
      getConfiguration: () => ({ get: (_k, def) => def, update: (k, v) => { configWrites.push([k, v]); return Promise.resolve(); } }),
      openTextDocument: (uri) => Promise.resolve({ uri, lineCount: 5, getText: () => 'AAA\nb\nc\nZZZ\n', lineAt: (n) => ({ range: new Range(n, 0, n, 3) }) }),
    },
    window: {
      createTreeView: (id, opts) => {
        trees[id] = opts.treeDataProvider;
        treeViewOpts[id] = opts;
        return { badge: undefined, description: undefined, onDidChangeVisibility: () => ({ dispose() {} }), dispose() {} };
      },
      createStatusBarItem: () => { const it = { text: '', tooltip: '', command: undefined, backgroundColor: undefined, show() {}, hide() {}, dispose() {} }; statusBarItems.push(it); return it; },
      setStatusBarMessage: () => ({ dispose() {} }),
      createTextEditorDecorationType: () => ({ id: ++decoCounter, dispose() {} }),
      registerFileDecorationProvider: (p) => { decoProvider = p; return { dispose() {} }; },
      registerWebviewViewProvider: (id, p) => { webviewProviders[id] = p; return { dispose() {} }; },
      createWebviewPanel: (id, title) => {
        const panel = {
          id, title, disposed: false, revealed: 0,
          webview: { options: {}, html: '', posts: [], postMessage(m) { this.posts.push(m); return Promise.resolve(true); }, onDidReceiveMessage(cb) { panel.recv = cb; } },
          reveal() { panel.revealed++; },
          onDidDispose(cb) { panel.onDispose = cb; },
          dispose() { panel.disposed = true; panel.onDispose && panel.onDispose(); },
        };
        webviewPanels.push(panel);
        return panel;
      },
      // Real VS Code always hands a cancellation token to a `cancellable` task; the mock does too, so
      // the demo replay's stop path is exercised rather than mocked away.
      withProgress: (_o, task) => task({ report() {} }, { isCancellationRequested: progressCancelled, onCancellationRequested: () => ({ dispose() {} }) }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      activeColorTheme: { kind: 2 }, // Dark — exercises the dark clear-tint branch
      onDidChangeActiveColorTheme: () => ({ dispose() {} }),
      onDidChangeTextEditorSelection: () => ({ dispose() {} }),
      activeTextEditor: mockEditor,
      visibleTextEditors: [mockEditor],
      showTextDocument: (d) => { opened = d; lastShown = { document: d, selection: null, revealRange() {} }; return Promise.resolve(lastShown); },
      showInformationMessage: (m, ...rest) => {
        infoMessages.push(String(m));
        const items = actionsOf(rest);
        return Promise.resolve(items.includes(infoPick) ? infoPick : undefined);
      },
      showInputBox: () => Promise.resolve(inputBoxValue),
      showQuickPick: (items) => Promise.resolve(quickPick === null ? undefined : items[quickPick]),
      // The mock reader takes the FIRST action offered.
      showWarningMessage: (m, ...rest) => { warnMessages.push(String(m)); return Promise.resolve(actionsOf(rest)[0]); },
      // Real since VS Code 1.67 and the extension requires ^1.85, so the mock carries it: exitDemo
      // closes the demo's editors before deleting their folder, and that has to be testable.
      tabGroups: {
        all: [{ tabs: openTabs }],
        close: (tab) => { const i = openTabs.indexOf(tab); if (i >= 0) openTabs.splice(i, 1); return Promise.resolve(true); },
      },
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
    // globalState backs the tour's remembered float/dock preference.
    const globalState = new Map();
    ext.activate({
      subscriptions: [],
      extensionUri: Uri.file(ws),
      globalState: { get: (k, d) => (globalState.has(k) ? globalState.get(k) : d), update: (k, v) => { globalState.set(k, v); return Promise.resolve(); } },
    });

    const editsTree = trees['claudeObservatory.edits'];
    const diffsTree = trees['claudeObservatory.diffs'];
    assert.ok(editsTree && diffsTree, 'Edits and Diffs views registered');
    // 0.8.0 panel consolidation: Timeline folded into Observations. Round 3: the standalone Multitasking
    // view is folded INTO the Overview (master–detail). Actions is now a SIDEBAR view (moved out of the
    // bottom-panel Observations dock into the Claude Edits activity-bar window, at the bottom).
    assert.ok(!trees['claudeObservatory.timeline'], 'the standalone Timeline view is gone (folded into Observations)');
    assert.ok(!webviewProviders['claudeObservatory.multitask'] && !trees['claudeObservatory.multitask'], 'the standalone Multitasking view is gone (folded into the Overview)');
    assert.ok(trees['claudeObservatory.actions'], 'Actions is registered as a timeline-style tree (now in the sidebar window)');

    // The Actions view lives in the "Claude Edits" SIDEBAR container (activity-bar) — NOT in the
    // bottom-panel dock. 0.8.7: Observations joined it there (LAST, with the edits/diffs trees), which
    // freed the dock for Prompts · Overview · Stats — three windows side by side, so the list of asks
    // and the Overview it scopes are visible at the same time.
    const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8'));
    const sidebar = pkg.contributes.views.claudeObservatory;
    const dock = pkg.contributes.views.claudeObservatoryDock;
    const sidebarIds = sidebar.map((v) => v.id);
    assert.ok(sidebarIds.includes('claudeObservatory.actions'), 'Actions view is in the Claude Edits sidebar container');
    assert.equal(sidebarIds[sidebarIds.length - 1], 'claudeObservatory.observations', 'Observations is the LAST sidebar view (0.8.7)');
    assert.equal(sidebarIds[sidebarIds.indexOf('claudeObservatory.actions') - 1], 'claudeObservatory.fileHistory', 'Actions sits directly after File History');
    assert.ok(!dock.some((v) => v.id === 'claudeObservatory.actions'), 'Actions is no longer in the bottom-panel dock');
    assert.deepEqual(dock.map((v) => v.id), ['claudeObservatory.prompts', 'claudeObservatory.changemap', 'claudeObservatory.stats'], 'the dock is Prompts · Overview · Stats (0.8.8)');
    assert.ok(webviewProviders['claudeObservatory.prompts'], 'the Prompts window is registered as a webview view');
    // 0.8.7 QoL: the sidebar trees carry VS Code's native Collapse-All button (showCollapseAll) — the
    // file-Explorer affordance the user asked for, on Edits · Diffs · Actions (+ Observations).
    for (const id of ['claudeObservatory.edits', 'claudeObservatory.diffs', 'claudeObservatory.actions', 'claudeObservatory.observations'])
      assert.equal(treeViewOpts[id] && treeViewOpts[id].showCollapseAll, true, `${id} tree offers Collapse All`);
    // …and the palette command that reveals the Requests window after a VS Code layout-persistence hide.
    assert.ok(typeof commands['claudeObservatory.showPrompts'] === 'function', 'the Show Prompts command is registered');
    assert.ok(
      pkg.contributes.commands.some((c) => c.command === 'claudeObservatory.showPrompts'),
      'Show Prompts is contributed to the command palette'
    );
    // Demo mode (0.8.9): the tour view leads the sidebar and only exists while a tour runs, the five
    // commands are contributed, and — the one that decides whether anybody ever finds it — the empty
    // state offers the demo. That last one is the first-run path: the replay drives the capture pipeline
    // in-process, so it genuinely works before `claude-observatory init`.
    // The tour is NOT a sidebar view: a slot there sits in the very container whose other views the
    // tour keeps asking you to look at. It is a detachable webview panel, floating by default.
    assert.ok(!sidebarIds.includes('claudeObservatory.tour'), 'the tour takes no sidebar slot');
    assert.equal(sidebarIds[0], 'claudeObservatory.edits', 'so Edits still leads the container');
    for (const c of ['tourDock', 'tourFloat'])
      assert.ok(pkg.contributes.commands.some((x) => x.command === `claudeObservatory.${c}`), `${c} is contributed`);
    for (const c of ['startDemo', 'restartDemo', 'startTour', 'tourNext', 'tourBack', 'exitDemo'])
      assert.ok(pkg.contributes.commands.some((x) => x.command === `claudeObservatory.${c}`), `${c} is contributed`);
    // Cancel / reset / redo have to be reachable FROM the panel, not only the palette: Start before a
    // demo exists, Restart and Exit once one does.
    const titles = pkg.contributes.menus['view/title'].filter((m) => /claudeObservatory\.(start|restart|exit)Demo$/.test(m.command));
    assert.equal(titles.length, 3, 'Start, Restart and Exit each have a title-bar button');
    assert.match(titles.find((m) => m.command === 'claudeObservatory.startDemo').when, /!claudeObservatory\.demoPresent/, 'Start shows only when no demo is running');
    // Demo mode sits at the END of the title bar, and INLINE. Only the `navigation` group renders as
    // icons; anything else is swept into the "..." overflow, so a plain "put it last" group would have
    // removed these four from the row rather than moving them along it.
    const allTitles = pkg.contributes.menus['view/title'];
    const isDemo = (cmd) => /claudeObservatory\.(startDemo|restartDemo|exitDemo|startTour)$/.test(cmd);
    const nonDemoOrders = allTitles
      .filter((m) => !isDemo(m.command) && /^navigation@\d+$/.test(m.group || ''))
      .map((m) => Number(m.group.split('@')[1]));
    assert.ok(nonDemoOrders.length > 0, 'there are other inline title-bar actions to sort after');
    for (const m of allTitles.filter((x) => isDemo(x.command))) {
      assert.match(m.group || '', /^navigation@\d+$/, `${m.command} stays inline, not in the ... overflow`);
      assert.ok(
        Number(m.group.split('@')[1]) > Math.max(...nonDemoOrders),
        `${m.command} sorts after every other inline title-bar action`
      );
    }
    for (const c of ['restartDemo', 'exitDemo'])
      assert.match(titles.find((m) => m.command === `claudeObservatory.${c}`).when, /&& claudeObservatory\.demoPresent/, `${c} shows only while a demo is running`);
    const welcome = pkg.contributes.viewsWelcome.filter((w) => w.view === 'claudeObservatory.edits');
    assert.ok(welcome.length >= 3, 'the Edits view keeps its three empty-state variants');
    for (const w of welcome)
      assert.match(w.contents, /command:claudeObservatory\.startDemo/, 'every Edits empty state offers the demo, including the hooks-missing one');
    const palette = pkg.contributes.menus.commandPalette || [];
    assert.equal(palette.find((m) => m.command === 'claudeObservatory.tourGoto').when, 'false', 'tourGoto is panel-driven, not a palette command');
    for (const c of ['tourNext', 'tourBack'])
      assert.equal(palette.find((m) => m.command === `claudeObservatory.${c}`).when, 'claudeObservatory.demoTour', `${c} is offered only during a tour`);

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
    // 0.8.7 review (P11): Context — what shaped this session — sits BEFORE Next steps and NESTS under its
    // own header, so a long list collapses as one unit instead of burying everything after it.
    fs.writeFileSync(path.join(ws, 'CLAUDE.md'), '# project instructions\n'); // one file-present source
    const obsCtx = obsTree.getChildren();
    const ctxHead = obsCtx.find((n) => n.kind === 'ctxhead');
    assert.ok(ctxHead, 'the Context section appears once this session has a context source');
    assert.ok(obsCtx.indexOf(ctxHead) < obsCtx.findIndex((n) => n.kind === 'steps'), 'Context is placed BEFORE Next steps');
    assert.ok(!obsCtx.some((n) => n.kind === 'ctxsrc'), 'context sources are no longer flat root-level siblings');
    const ctxKids = obsTree.getChildren(ctxHead);
    assert.ok(ctxKids.length >= 1 && ctxKids.every((n) => n.kind === 'ctxsrc'), 'the sources nest under the Context header');
    const ctxItem = obsTree.getTreeItem(ctxHead);
    assert.equal(ctxItem.collapsibleState, vscode.TreeItemCollapsibleState.Expanded, 'a short Context list opens');
    assert.match(String(ctxItem.description), new RegExp('^' + ctxKids.length + ' · '), 'the header states how many sources it holds');
    const bigCtx = obsTree.getTreeItem({ kind: 'ctxhead', note: ctxHead.note, sources: new Array(6).fill(ctxKids[0].src) });
    assert.equal(bigCtx.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed, 'a long Context list auto-folds — its header still carries the count');
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
    assert.match(String(actTree.getTreeItem(editGroup).description), /3/, 'the Edits subsection counts the seeded edits (two in the workspace, one outside it)');
    assert.ok(!actGroups.some((n) => n.kind === 'agroup' && n.label === 'Subagents'), 'the Subagents category is dropped (those are the Overview fleet)');
    const actRows = actTree.getChildren(editGroup);
    assert.equal(actRows.length, 3, 'the Edits subsection expands to its action rows');
    // Rows are newest-first, so the head of the list is the out-of-workspace edit — which has no store
    // record to review. The linked one is the row that drills into its review.
    const aItem = actTree.getTreeItem(actRows.find((n) => n.rec.editId != null));
    assert.match(aItem.label, /Edit/, 'an action row shows the tool');
    assert.ok(/\d\d:\d\d|--:--/.test(aItem.label), 'an action row leads with a TIMESTAMP column');
    assert.equal(aItem.command.command, 'claudeObservatory.viewChanges', 'an edit-action links to its review (viewChanges)');
    assert.ok(typeof aItem.command.arguments[0] === 'number', 'the edit-action carries the store edit id to review');
    // 0.8.7 review (P6): a flagged command must say WHY in place — core already scored the reasons, and
    // making the user leave the panel to learn what "⚠ HIGH" meant is the whole cost of the flag.
    const riskItem = actTree.getTreeItem({ kind: 'arow', rec: {
      ts: Date.now(), tool: 'Bash', category: 'exec', target: 'rm -rf build', ok: false, isError: false,
      risk: { level: 'medium', reasons: ['recursive/forced delete (rm -rf)', 'writes outside the workspace'] },
    } });
    assert.match(String(riskItem.description), /⚠ medium/, 'a flagged row spells the level out ("medium", never "med")');
    assert.match(String(riskItem.tooltip), /⚠ medium risk: recursive\/forced delete \(rm -rf\) · writes outside the workspace/,
      'the tooltip states core’s own reasons for the flag');
    // 0.8.7: the footprint folded into the Risk + Egress audits, which live HERE — and both sections are
    // built from the SAME parsed action stream, so the seeded out-of-workspace read/edit must surface.
    const oLive = actGroups.find((n) => n.kind === 'ogroup');
    assert.ok(oLive, 'an edit outside the workspace grows its own section in the Actions tree');
    assert.deepEqual(oLive.writes.map((w) => w.file), ['~/notes/outside.md'], 'it names the file, home-shortened as core reports it');
    assert.deepEqual([oLive.files, oLive.edits], [1, 1], 'and counts the files and the edits that landed there');
    const eLive = actGroups.find((n) => n.kind === 'egroup');
    assert.ok(eLive && eLive.channels.some((ch) => ch.kind === 'file' && ch.scope === 'local' && ch.target === '~/notes/outside.md'),
      'a read from outside the workspace is an EGRESS channel — reach past the boundary, exactly like a fetch');
    assert.ok(actGroups.indexOf(oLive) < actGroups.indexOf(eLive) && actGroups.indexOf(oLive) > actGroups.findIndex((n) => n.kind === 'agroup'),
      'the audits sit after the action categories, risk before egress (the order the CLI reports them)');
    // Risk gains the edits that landed outside the workspace — the one fact the file ledger cannot state,
    // since it shows every path workspace-relative.
    const oGroup = actTree.getTreeItem({ kind: 'ogroup', writes: new Array(50).fill({ file: '~/notes/x.md', count: 2 }), files: 62, edits: 130 });
    assert.equal(oGroup.label, 'Outside the workspace', 'the out-of-workspace writes get their own section, after the command groups');
    assert.equal(String(oGroup.description), '50 of 62 files · 130 edits', 'the header counts files and edits, and says the list is partial');
    assert.match(String(oGroup.tooltip), /12 file\(s\) not shown/, 'a capped list says how many rows it hid — never reads as the whole story');
    assert.equal(String(actTree.getTreeItem({ kind: 'ogroup', writes: [{ file: '~/a.md', count: 1 }], files: 1, edits: 1 }).description), '1 files · 1 edits',
      'an uncapped list states its size plainly (no phantom "of")');
    const oRow = actTree.getTreeItem({ kind: 'orow', w: { file: '~/notes/x.md', count: 3 } });
    assert.equal(oRow.label, 'x.md', 'a row names the file');
    assert.match(String(oRow.description), /~\/notes · ×3/, '…with its directory and how many edits landed there');
    assert.equal(oRow.command.command, 'vscode.open', 'a row opens the file that was written outside the workspace');
    assert.ok(!oRow.command.arguments[0].fsPath.startsWith('~'), 'core’s ~-shortened display path is expanded before opening');
    // Egress gains `file` channels — files READ from outside the workspace. Their scope is 'local', which
    // renders as its own word ("outside", as the CLI prints it): 'unknown' means we could not classify a
    // destination, and printing a known fact as an admission would be a lie.
    const eLocal = actTree.getTreeItem({ kind: 'erow', ch: { kind: 'file', target: '~/.claude/CLAUDE.md', scope: 'local', count: 4 } });
    assert.equal(eLocal.label, 'CLAUDE.md', 'a file channel names the file it read');
    assert.match(String(eLocal.description), /file · outside ×4/, 'a local (out-of-workspace) read renders as "outside"');
    assert.ok(!/unknown/.test(String(eLocal.description) + String(eLocal.tooltip)), 'a local scope is never collapsed into "unknown"');
    assert.equal(eLocal.command.command, 'vscode.open', 'a file channel opens the file it names');
    const eUnknown = actTree.getTreeItem({ kind: 'erow', ch: { kind: 'mcp', target: 'some-server', scope: 'unknown', count: 1 } });
    assert.match(String(eUnknown.description), /mcp · unknown/, '…and an unclassifiable destination still says "unknown"');
    assert.equal(eUnknown.command, undefined, 'a non-file channel has nothing to open');
    assert.match(String(actTree.getTreeItem({ kind: 'egroup', channels: [] }).tooltip), /read from outside this workspace/,
      'the Egress header says it now covers out-of-workspace reads as well as the network');
    // 0.8.7 review (B16): the root feed — which walks every sibling worktree for live conflicts, ~100ms of
    // SYNCHRONOUS host work — is computed once per REFRESH CYCLE, not once per getChildren() call.
    const firstActions = (nodes) => (nodes.find((n) => n.kind === 'agroup') || {}).actions;
    const ag1 = firstActions(actTree.getChildren());
    assert.ok(ag1, 'the Actions root has at least one category group to compare');
    assert.ok(firstActions(actTree.getChildren()) === ag1, 'a second getChildren() in the same cycle reuses the computed feed (no second fleet scan)');
    actTree.refresh();
    assert.ok(firstActions(actTree.getChildren()) !== ag1, 'refresh() drops it — the fleet’s time-derived "active" flags are never frozen across cycles');

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
    // 0.8.7: the context-per-turn chart is GONE (core no longer emits the series) — and so is its scaffolding.
    assert.ok(!/tk-fill|renderFill|class="spark"/.test(stView.webview.html), 'the context-per-turn chart and its scaffolding are removed');
    assert.match(stView.webview.html, /id="nb-model"/, 'the model / effort chip stays (it is not part of the removed chart)');
    // 0.8.7 review (B23): removing the chart also removed every mention of compaction. The events still
    // ride vitals.compactions, so a one-line readout (count + last drop) is restored — no chart.
    assert.match(stView.webview.html, /id="nb-compact"/, 'the compaction readout chip is present');
    assert.ok(/function renderCompactions/.test(stView.webview.html) && /renderVitals\(m\.v\); renderCompactions\(m\.v\)/.test(stView.webview.html),
      'the compactions the host already posts are actually rendered');
    assert.ok(/' compaction'\+\(cs\.length===1\?'':'s'\)\+' · last dropped '/.test(stView.webview.html), 'the readout is count + the size of the LAST drop');
    assert.ok(/if\(!cs\.length\)\{ el\.style\.display='none'/.test(stView.webview.html), 'a session that never compacted shows no chip (absent data renders absent)');
    assert.ok(!/\$/.test('⤺ 1 compaction · last dropped 992k'), 'the readout carries no dollar amount');
    // CLI-missing hint: a failed scan (before any data) posts statsError so the webview shows install help
    const stMsgs = [];
    stView.webview.postMessage = (m) => stMsgs.push(m);
    stProvider.postStatsError();
    assert.ok(stMsgs.some((m) => m.type === 'statsError'), 'failed stats scan posts the CLI-missing hint');

    // Overview webview (0.8.0 round 3 — MASTER–DETAIL): the standalone Multitasking view is folded IN.
    // LEFT NAV = two sub-tabs Fleet · Workflows (rendered from multitask --json). RIGHT DETAIL = the
    // change-map (Folders strip · churn-ranked Files ledger) for the SELECTED nav item (from
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
    // TOP NAVBAR: the session-wide review actions — Accept All · Reject All · Clear Resolved · Refresh —
    // each posting to the host command. No session picker: the Sessions tab below IS the selector (0.8.8),
    // and a dropdown over it would be the same control twice.
    assert.match(cmView.webview.html, /id="ov-toolbar"|class="ov-toolbar"/, 'Overview: a top navbar is present');
    assert.ok(!/id="ov-sess"/.test(cmView.webview.html), 'Overview: the session dropdown is gone');
    assert.ok(/data-sess-auto/.test(cmView.webview.html),
      '…and the Sessions tab offers the one thing only the dropdown could: going back to automatic resolution');
    assert.ok(/id="ov-keepall"/.test(cmView.webview.html) && /id="ov-undoall"/.test(cmView.webview.html) && /id="ov-clearres"/.test(cmView.webview.html) && /id="ov-refresh"/.test(cmView.webview.html),
      'the navbar carries Accept All · Reject All · Clear Resolved · Refresh');
    assert.ok(/Accept All/.test(cmView.webview.html) && /Reject All/.test(cmView.webview.html) && /Clear Resolved/.test(cmView.webview.html),
      'the navbar buttons are labelled to match the Observations toolbar');
    // LEFT NAV = 25% of the panel width (change-map detail gets the remaining 75%).
    // The split is the reader's to set (0.8.8): 25% is where it OPENS, not where it is stuck.
    assert.ok(/\.ov-nav \{[^}]*flex:0 0 var\(--ov-nav, 25%\)/.test(cmView.webview.html),
      'Overview: the left nav opens at 25%, sized by a variable rather than a constant');
    assert.ok(/id="ov-gutter"/.test(cmView.webview.html) && /addEventListener\('pointerdown'/.test(cmView.webview.html),
      '…and a draggable gutter sits between the panes');
    assert.ok(/navW:NAV_W, navH:NAV_H/.test(cmView.webview.html) && /--ov-navv/.test(cmView.webview.html),
      '…and the split is remembered per axis (a nav WIDTH side by side, a nav HEIGHT stacked)');
    // LEFT NAV: the Fleet · Workflows sub-tabs + item list.
    assert.match(cmView.webview.html, /id="ov-navtabs"/, 'Overview: left-nav sub-tab bar present (Fleet · Workflows)');
    assert.ok(/'Fleet'/.test(cmView.webview.html) && /'Workflows'/.test(cmView.webview.html), 'the left nav labels Fleet/Workflows');
    assert.ok(/renderNavTabs/.test(cmView.webview.html) && /function applyPanes/.test(cmView.webview.html), 'switching a nav tab toggles panes (renderNavTabs/applyPanes)');
    assert.match(cmView.webview.html, /id="ov-fleet"/, 'Overview: the Fleet list container is present');
    assert.match(cmView.webview.html, /id="ov-workflows"/, 'Overview: the Workflows list container is present');
    // Live conflicts MOVED to the Actions panel (0.8.3) — the Overview must no longer render them.
    assert.ok(!/ov-collisions/.test(cmView.webview.html), 'Overview: the live-collisions strip is gone (it lives in the Actions panel now)');
    // The Tasks tab: third nav pane, strict-rollup-joined rows, done-collapse toggle.
    assert.match(cmView.webview.html, /id="ov-tasks"/, 'Overview: the Tasks pane container is present');
    assert.ok(/'Tasks'/.test(cmView.webview.html) && /renderTasks/.test(cmView.webview.html), 'the left nav labels Tasks and renders it');
    assert.ok(/rollupByTask/.test(cmView.webview.html) && /mt-ttog/.test(cmView.webview.html), 'task rows join the strict rollup + completed tasks collapse behind a toggle');
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
    assert.ok(!/id="cm-ribbon"/.test(cmView.webview.html), 'Overview: the subtask ribbon is gone (0.8.8) — the detail is Folders + Files');
    assert.match(cmView.webview.html, /id="cm-strip"/, 'Overview: module proportion strip present');
    assert.match(cmView.webview.html, /id="cm-ledger"/, 'Overview: ranked file ledger present');
    // The folded folders EXPAND (0.8.8). A "+K more" that is only a label leaves the tail unreachable,
    // which is exactly the bug this replaced: the chip has to be a control, and it has to fold back.
    assert.ok(/data-more="1"/.test(cmView.webview.html) && /data-less="1"/.test(cmView.webview.html),
      'Overview: the strip\'s tail chip opens every folder, and a second chip folds them back');
    assert.ok(/getAttribute\('data-more'\)\)\{ STRIP_ALL=true/.test(cmView.webview.html)
      && /getAttribute\('data-less'\)\)\{ STRIP_ALL=false/.test(cmView.webview.html),
      '…and both chips are wired to the expansion state, not to the folder filter');
    assert.ok(/\.cm-strip \{[^}]*flex-wrap:wrap/.test(cmView.webview.html)
      && /\.cm-sg \{[^}]*flex:1 1 86px/.test(cmView.webview.html),
      'the strip wraps and its tiles hold a readable floor width (no slivers in a narrow panel)');
    assert.ok(/\.cm-strip\.open \{[^}]*max-height:[^}]*overflow-y:auto/.test(cmView.webview.html),
      'expanded, the strip is capped and scrolls — opening 90 folders cannot push the ledger off-screen');
    assert.match(cmView.webview.html, /id="cm-readout"/, 'Overview: footer readout present');
    assert.ok(!/id="cm-area"|data-area=/.test(cmView.webview.html), 'the count/size toggle is gone (always ± lines)');
    assert.ok(!/buildFiles|buildModules|buildChangeMap|listRepoSiblings|fleetConflicts|buildActionGroups/.test(cmView.webview.html), 'the client must not re-aggregate — core/CLI ship both payloads (changemap + multitask)');
    assert.ok(!/renderRibbon/.test(cmView.webview.html) && !/a\.subtasks/.test(cmView.webview.html), 'Overview: no ribbon renderer and no subtasks[] reads remain');
    // a WORKFLOW nav item renders a synthetic per-workflow detail slice (rollup → chips, files → ledger,
    // taskIds), joined to CM by workflow id.
    assert.ok(/function workflowSlice/.test(cmView.webview.html) && /kind==='workflow'/.test(cmView.webview.html), 'Overview: a selected workflow renders a per-workflow detail slice (workflowSlice)');
    assert.ok(/function detailSlice/.test(cmView.webview.html) && /cmAgent/.test(cmView.webview.html), 'Overview: the detail joins the nav selection to the changemap slice by session/workflowId');
    // 0.8.7: the footprint badge row and its drill-down are GONE — folded into the Risk and Egress audits
    // (Actions panel), which is now the ONE audit surface. `changemap --json` no longer emits the key, so a
    // renderer still reading it would paint a silent blank; nothing may read it, and no scaffolding survives.
    assert.ok(!/cm-caps|cm-capd|cm-cdr|renderCaps|renderCapDetail|capBadge|data-cap=|data-facet|--fp-/.test(cmView.webview.html),
      'the footprint badge row, its drill-down, its palette and its click-through are gone from the Overview');
    assert.ok(!/\.footprint|\['footprint'\]/.test(cmView.webview.html),
      'nothing in the Overview reads the removed footprint key (the comments explaining the fold are fine)');
    assert.ok(!/openPath/.test(cmView.webview.html), 'the drill-down’s openPath message went with it (the Actions tree opens its own file rows)');
    // 0.8.7: the fleet lists every sibling session, so a session switch must re-point the DETAIL selection.
    assert.ok(/SEL = k \? \{kind:'agent', session:k\} : null; PR_ID=null;/.test(cmView.webview.html), 'switching sessions re-points the Overview selection (and drops the old prompt scope)');
    // 0.8.7 (3) the PROCESSES tab: background shells left running. No pid column — the transcript records
    // no OS pid, so the harness's shell id is the identity.
    assert.match(cmView.webview.html, /id="ov-pane-processes"/, 'Overview: the Processes pane container is present');
    assert.match(cmView.webview.html, /id="ov-processes"/, 'Overview: the Processes list container is present');
    assert.ok(/'Processes'/.test(cmView.webview.html) && /function renderProcesses/.test(cmView.webview.html), 'the left nav labels Processes and renders it');
    assert.ok(/function procState/.test(cmView.webview.html) && /'exit '\+p\.exitCode/.test(cmView.webview.html) && /fmtBytes/.test(cmView.webview.html),
      'process rows show running / exit state, runtime and output volume');
    assert.ok(!/p\.pid|\bpid:/.test(cmView.webview.html) && /no OS pid/.test(cmView.webview.html), 'the Processes tab invents no pid — the harness’s shell id is the identity, and the code says why');
    // 0.8.7 fix: Active only must hide EXITED shells (fleet/workflows/tasks all honor the toggle; the
    // Processes pane was the outlier), and an emptied list must read as the filter's doing, not "none ran".
    assert.ok(/if\(ACTIVE_ONLY\)\{ var running=\[\];[^}]*\.running\)/.test(cmView.webview.html),
      'the Processes pane drops non-running shells when Active only is on');
    assert.ok(/No running shells/.test(cmView.webview.html) && /clear <b>Active only<\/b> to see the '\+exitedHidden/.test(cmView.webview.html),
      'an Active-only-emptied Processes pane says why it is empty and how many exited shells are hidden');
    // 0.8.7 review: the tab is ALWAYS present (JetBrains parity) — one that vanishes when the CLI can't
    // answer hides the failure. Its badge is running/total, tinted while a shell is still going, and the
    // three states it can be in (nothing read yet · no answer · genuinely none) get three sentences.
    assert.ok(/defs\.push\(\['processes'/.test(cmView.webview.html) && !/if\(PR\) defs\.push/.test(cmView.webview.html),
      'the Processes tab is always present, so a CLI that cannot answer is reported rather than hidden');
    assert.ok(/psum\? \(psum\.running\+'\/'\+psum\.total\) : ''/.test(cmView.webview.html), 'the Processes tab badge is running/total, and blank when there is no payload to count');
    assert.ok(/\.ov-tn\.hot \{ color: var\(--mt-done\)/.test(cmView.webview.html), 'the running/total badge is tinted with the same green the running row badge uses');
    assert.ok(/Reading this session’s background shells…/.test(cmView.webview.html), 'state 1: nothing has been read yet');
    assert.ok(/No answer for background shells/.test(cmView.webview.html), 'state 2: the CLI returned nothing — stated, not silently blamed on the session');
    assert.ok(/No background shells — Claude starts one only when it runs a command/.test(cmView.webview.html), 'state 3: this session genuinely started none');
    // 0.8.7 review (B21): Tasks + Processes are the ACTIVE session's payloads; selecting a sibling fleet
    // row re-points the change map and the feed but NOT these two, so both panes say so.
    assert.ok(/function offSession/.test(cmView.webview.html) && /function scopeNote/.test(cmView.webview.html), 'the session-scope note exists for the tabs the fleet selection does not re-point');
    assert.ok(/scopeNote\('Tasks'\)/.test(cmView.webview.html) && /scopeNote\('Background shells'\)/.test(cmView.webview.html), 'both session-scoped panes carry the note');
    assert.ok(/ACTIVE session’s numbered task list/.test(cmView.webview.html) && /background shells the ACTIVE session launched/.test(cmView.webview.html),
      'the tab tooltips name the scope too');
    assert.ok(!/\.mt-scope \{[^}]*var\(--mt-attn\)/.test(cmView.webview.html), 'the scope note does not borrow the amber that means "outside the workspace"');
    // 0.8.7 (5) REQUESTS — its own WINDOW in the dock (left of the Overview), not a tab inside it, so
    // the list of asks and the view it scopes are visible at the same time. Picking one filters the
    // Overview beside it: fleet · runs · tasks · shells, and the whole change map.
    const rqProvider = webviewProviders['claudeObservatory.prompts'];
    assert.ok(rqProvider, 'the Prompts window is registered');
    let rqMsgHandler = null;
    const rqView = {
      webview: { options: {}, html: '', postMessage: () => {}, onDidReceiveMessage: (cb) => { rqMsgHandler = cb; return { dispose() {} }; } },
      onDidChangeVisibility: () => ({ dispose() {} }),
      visible: false, // no subprocess spawn while hidden
    };
    rqProvider.resolveWebviewView(rqView);
    assert.match(rqView.webview.html, /id="rq-list"/, 'Prompts: the list container is present');
    assert.ok(/#'\+r\.index/.test(rqView.webview.html) && /esc\(r\.text\|\|r\.title\)/.test(rqView.webview.html),
      'a row carries the ask’s own number and the ask itself');
    // NO TRUNCATION anywhere: the ask wraps over as many lines as it needs (user rule 2026-07-23). An
    // ellipsis or a line clamp would throw away the only copy of what the person actually said.
    assert.ok(/\.rq-ask \{[^}]*white-space:pre-wrap[^}]*\}/.test(rqView.webview.html), 'the ask wraps (pre-wrap), never clipped');
    assert.ok(!/\.rq-ask \{[^}]*text-overflow:ellipsis/.test(rqView.webview.html) && !/-webkit-line-clamp/.test(rqView.webview.html),
      'no ellipsis and no line clamp on the ask');
    assert.ok(/r\.edits\+' edit'/.test(rqView.webview.html) && /r\.agents\.length\+' subagent'/.test(rqView.webview.html)
      && /r\.workflows\.length\+' workflow run'/.test(rqView.webview.html) && /r\.processes\.length\+' shell'/.test(rqView.webview.html)
      && /r\.compactions/.test(rqView.webview.html) && /fmtDur\(r\.durationMs\)/.test(rqView.webview.html),
      'the facts are edits · subagents · workflow runs · shells · compactions · duration');
    // 0.8.7: each row also carries files, folders, tokens and tasks — the full per-request headline.
    assert.ok(/\(r\.files\|\|0\)\+'f · '\+\(r\.folders\|\|0\)\+'fo'/.test(rqView.webview.html), 'the edit line names files and folders touched');
    assert.ok(/r\.tokens\) f\.push/.test(rqView.webview.html) && /fmtTok\(r\.tokens\)\+' tok/.test(rqView.webview.html), 'a row shows the tokens spent answering');
    assert.ok(/r\.tasks\) w\.push\(r\.tasks\+' task'/.test(rqView.webview.html), 'a row shows the tasks worked');
    // A request with 0 edits is normal and common — rendered as itself, never hidden, never made to look wrong.
    assert.ok(/no edits — a question or a decision/.test(rqView.webview.html), 'an ask that produced no edits says so plainly');
    assert.ok(/r\.actions \? \('no edits · '\+r\.actions\+' tool call'/.test(rqView.webview.html),
      'an ask that ran tools but changed no files says THAT — calling it "a question" would be wrong');
    assert.ok(/if\(r\.added\|\|r\.removed\)/.test(rqView.webview.html), 'the ±lines cell is omitted when there are none, never a fabricated +0 −0');
    assert.ok(/\(r\.endTs\?''\:'~'\)\+fmtDur\(r\.durationMs\)/.test(rqView.webview.html), 'the in-flight ask’s duration is marked "~" (endTs 0 is not a finished number)');
    // The same three states every list in this product keeps apart.
    assert.ok(/Reading this session’s prompts…/.test(rqView.webview.html), 'state 1: nothing has been read yet');
    assert.ok(/No answer for <b>prompts<\/b>/.test(rqView.webview.html), 'state 2: the CLI returned nothing — stated, not blamed on the session');
    assert.ok(/No prompts recorded yet/.test(rqView.webview.html), 'state 3: this session genuinely has none');
    // A failed tool call is not a risk flag — it must not borrow ⚠ + the risk colour.
    assert.ok(/rq-err[^>]*>✗ '\+r\.errors/.test(rqView.webview.html) && /\.rq-err \{[^}]*var\(--mt-warn\)/.test(rqView.webview.html),
      'failed tool calls are marked ✗ in the warn colour');
    // Selecting: the WINDOW owns the pick, the host relays it, the Overview scopes to it.
    assert.ok(/type:'select', id:SEL/.test(rqView.webview.html), 'clicking a row posts the selection to the host');
    assert.ok(/SEL = \(SEL===id\)\? null : id/.test(rqView.webview.html), 'clicking the selected ask again clears the scope');
    assert.equal(typeof rqProvider.selection, 'object', 'the host holds the selection (null until something is picked)');
    rqMsgHandler({ type: 'select', id: 'abc123' });
    assert.equal(rqProvider.selection, 'abc123', 'the host records the picked ask');
    rqMsgHandler({ type: 'select', id: null });
    assert.equal(rqProvider.selection, null, '…and drops it again');
    // 0.8.7: each row expands to review Claude's reply — a caret that toggles the response, fetched
    // lazily from the host (the prose can be large, so it never rides the list payload) and rendered
    // wrapped, never clipped. The caret must NOT change the scope selection.
    assert.ok(/class="rq-exp/.test(rqView.webview.html) && /function toggleResp/.test(rqView.webview.html), 'each row has an expand-response caret');
    assert.ok(/type:'expand', id:id/.test(rqView.webview.html), 'expanding an unfetched response asks the host for it');
    assert.ok(/\.rq-rtext \{[^}]*white-space:pre-wrap/.test(rqView.webview.html), 'the response wraps and never clips');
    assert.ok(/closest\('\.rq-exp'\)/.test(rqView.webview.html) && /ev\.stopPropagation\(\); toggleResp/.test(rqView.webview.html),
      'a caret click toggles the response without changing the scope selection');
    // The Overview carries no Prompts tab — Prompts is the window beside it. It DOES carry the new
    // Sessions tab (0.8.8): this workspace's sessions, click to SWITCH the review.
    assert.ok(!/id="ov-pane-requests"/.test(cmView.webview.html) && !/id="ov-pane-prompts"/.test(cmView.webview.html),
      'the Overview has no prompts tab (it is a window)');
    assert.ok(/var ids=\['sessions','fleet','workflows','tasks','processes'\]/.test(cmView.webview.html),
      'the Overview’s panes are Sessions · Fleet · Workflows · Tasks · Processes — Sessions leads, since which session you are reviewing precedes every other question');
    assert.ok(/NAV='sessions'/.test(cmView.webview.html), 'and the panel opens on it');
    assert.ok(/id="ov-pane-sessions"/.test(cmView.webview.html) && /function renderSessions/.test(cmView.webview.html),
      'the Sessions tab renders this workspace’s sessions');
    assert.ok(/switchToSession/.test(cmView.webview.html), 'selecting a Sessions row switches the review (a different selection semantic, stated in its desc)');
    // No scope banner IN the Overview: the Prompts window beside it already shows the picked ask.
    assert.ok(!/id="ov-reqbar"/.test(cmView.webview.html) && !/function renderReqBar/.test(cmView.webview.html),
      'the Overview carries no prompt-scope banner (the Prompts window shows the ask)');
    assert.ok(/function setPromptScope/.test(cmView.webview.html) && /m\.type==='prompt'/.test(cmView.webview.html),
      'the Overview still applies the ask scope the host relays');
    // The filtering itself: one helper, applied by every pane, over core's per-ask id sets.
    assert.ok(/function reqFilter/.test(cmView.webview.html) && /function prSlice/.test(cmView.webview.html),
      'one filter helper, reading core’s per-prompt slice (CM.prompts)');
    assert.ok(/reqFilter\(wf, 'workflowIds'/.test(cmView.webview.html)
      && /reqFilter\(all, 'processIds'/.test(cmView.webview.html) && /has\(rqf\.agentIds/.test(cmView.webview.html),
      'runs, shells and subagents each filter by the ask that STARTED them');
    assert.ok(/function promptSliceView/.test(cmView.webview.html) && /var rq=promptSliceView\(\); if\(rq\) return rq;/.test(cmView.webview.html),
      'the change map draws the ask’s own slice (files/folders aggregated in core)');
    assert.ok(/if\(!r\) return \{ rows:list, hidden:0, scoped:false \}/.test(cmView.webview.html),
      'with no slice to filter by (an older CLI), nothing is filtered — a scoped banner over unfiltered rows would be a lie');
    // OBS_DUMP_HTML=<dir> writes each panel's real HTML out, so a layout check can render the shipped
    // markup at several widths instead of guessing at it. Off by default; the assertions below are the test.
    if (process.env.OBS_DUMP_HTML) {
      fs.mkdirSync(process.env.OBS_DUMP_HTML, { recursive: true });
      for (const [name, view] of [['overview', cmView], ['prompts', rqView], ['stats', stView]])
        if (view) fs.writeFileSync(path.join(process.env.OBS_DUMP_HTML, name + '.html'), String(view.webview.html));
    }
    // The webview's scripts must PARSE. They are built as template literals in TS, so a bare apostrophe
    // inside a single-quoted JS string is invisible to tsc and to every string assertion here, yet it
    // kills the whole panel at runtime with a SyntaxError. Compile each <script> the page ships.
    for (const [label, view] of [['overview', cmView], ['prompts', rqView], ['stats', stView]]) {
      if (!view) continue;
      // Scanned, not regex-matched. A tag-matching regex has to be written case-insensitively AND to
      // tolerate `</script >`, and getting either wrong makes this guard silently vacuous: it would
      // find no blocks and still report that every shipped script parses. Index scanning has neither
      // failure mode (CodeQL flags the regex form as js/bad-tag-filter for exactly this reason).
      const html = String(view.webview.html);
      const hay = html.toLowerCase();
      const scripts = [];
      for (let at = hay.indexOf('<script'); at >= 0; ) {
        const bodyStart = hay.indexOf('>', at);
        if (bodyStart < 0) break;
        const bodyEnd = hay.indexOf('</script', bodyStart);
        if (bodyEnd < 0) break;
        scripts.push(html.slice(bodyStart + 1, bodyEnd));
        at = hay.indexOf('<script', bodyEnd);
      }
      assert.ok(scripts.length, `${label}: the panel ships at least one script`);
      for (const body of scripts) {
        assert.doesNotThrow(() => new Function(body), `${label}: every shipped script parses`);
      }
    }
    assert.ok(/hidden — not started by prompt #/.test(cmView.webview.html),
      'a pane whose rows dropped says how many and why — in prompt vocabulary (0.8.8), never "request"');
    assert.ok(!/request #/.test(cmView.webview.html), 'no user-visible copy still says "request"');
    assert.ok(/if\(PR_ID\) vscode\.postMessage\(\{type:pr, promptId:PR_ID\}\)/.test(cmView.webview.html),
      'the bulk actions retarget to the picked ask');
    // The bottom summary names the picked ask — and since core aggregates its files/folders, it reports them.
    assert.ok(/rq\.rollup\.pending/.test(cmView.webview.html) && /\(rq\.files\|\|\[\]\)\.length/.test(cmView.webview.html),
      'the bottom summary names the ask with its own review counts, files and folders');
    // 0.8.7 (4) the FEED pane: core's `mode` decides whether it is a live tail or a finished audit log,
    // and only a live one keeps being fetched — on the panel's EXISTING refresh tick, never a new timer.
    assert.match(cmView.webview.html, /id="ov-feed"/, 'Overview: the live-feed / audit-log pane is present');
    assert.ok(/function renderFeed/.test(cmView.webview.html) && /mode==='live'/.test(cmView.webview.html) && /audit log/.test(cmView.webview.html),
      'the pane labels itself live or audit from core’s mode');
    assert.ok(/updated '\+ago\(f\.lastTs\)/.test(cmView.webview.html), 'a live feed shows the age of the newest evidence, never a claim of realtime');
    assert.ok(/earlier entr/.test(cmView.webview.html), 'a truncated feed says how many earlier entries are not shown');
    assert.ok(/e\.kind==='output'/.test(cmView.webview.html) && /ov-fout/.test(cmView.webview.html), 'raw output lines render monospace, with no fabricated timestamp');
    assert.ok(/e\.ok===false/.test(cmView.webview.html) && /f\.note/.test(cmView.webview.html), 'failed rows are marked and core’s note explains an empty feed');
    assert.ok(!/setInterval|setTimeout\(function\(\)\{ *vscode\.postMessage\(\{type:'feed'/.test(cmView.webview.html), 'the feed adds no polling timer of its own');
    // 0.8.7 review (P3): one failed spawn (an older CLI on PATH) must not permanently disable the only
    // re-fetch. Only a GOOD 'audit' answer stops the polling; an explicit Refresh always re-attempts.
    const bundleSrc = fs.readFileSync(BUNDLE, 'utf8');
    assert.ok(!/feedLive/.test(bundleSrc), 'the "is it live" latch a failed fetch could never clear is gone');
    assert.ok(/feedSettled = ok && d\.mode === "audit"/.test(bundleSrc), 'only a fetch that landed and reported audit settles the feed');
    assert.ok(/this\.feedRef && \(force \|\| !this\.feedSettled\)/.test(bundleSrc), 'live feeds, failed fetches and an explicit Refresh all re-attempt');
    assert.ok(/registerCommand\("claudeObservatory\.refresh", \(\) => refreshAll\(true\)\)/.test(bundleSrc), 'the Refresh command forces — a pane stuck on a failed spawn is recoverable from the UI');
    // 0.8.7 review (P4): the pane repaints on the panel's tick, but an UNCHANGED payload must not rebuild
    // the body (that discards scroll + selection), and a live tail follows only when it actually grew.
    assert.ok(/function feedShell/.test(cmView.webview.html) && /if\(!host\.querySelector\('\.ov-fbody'\)\) feedShell\(host\)/.test(cmView.webview.html),
      'the feed shell is built once per selection, not on every tick');
    assert.ok(/if\(h===FEED_BODY\) return;/.test(cmView.webview.html), 'an identical payload skips the repaint entirely');
    assert.ok(/if\(live && rows>FEED_ROWS\) body\.scrollTop=body\.scrollHeight;/.test(cmView.webview.html), 'a live tail is followed only when the row count GREW');
    // 0.8.8: the ribbon (and its compaction anchoring) is gone — compactions live in Actions + Stats.
    assert.ok(!/afterChapterId|afterSubtaskId/.test(cmView.webview.html), 'no ribbon compaction anchoring remains (the field shipped as afterChapterId)');
    // 0.8.7: the one footprint fact worth a glance survives on the fleet row — that the session reached
    // OUTSIDE the workspace — re-pointed at the multitask payload's `outside:{reads,writes}`.
    assert.ok(/function outsideSuffix/.test(cmView.webview.html) && /\(a&&a\.outside\)\|\|null/.test(cmView.webview.html),
      'the fleet row’s outside-touch suffix reads the payload’s outside{reads,writes}');
    assert.ok(/'↗ '\+bits\.join\(' · '\)\+' outside'/.test(cmView.webview.html), '…and renders it as "↗ 3 read · 20 written outside"');
    assert.ok(/read outside this workspace — Actions ▸ Egress names them/.test(cmView.webview.html) &&
      /written outside this workspace — Actions ▸ Risk names them/.test(cmView.webview.html),
      'reads and writes are never summed in the tooltip — a read out there is egress, a write is risk — and each points at the audit that names the files');
    assert.ok(!/\+'⚠'\+high|c\.mcp&&c\.mcp\.calls|c\.web&&c\.web\.calls/.test(cmView.webview.html),
      'the suffix no longer restates risk / mcp / web — the row has its own ⚠ cell and those are Egress’s answer');
    assert.ok(cmView.webview.html.includes(core.EXERCISED_NOTE),
      'the suffix still carries core’s single-sourced caveat — these are things the session EXERCISED, never things it was permitted');
    // …and it has to be VISIBLE: the row is the tail of a 25%-wide column, where an unwrapped flex line
    // renders its last items hundreds of pixels past the right edge (measured in the headless harness).
    assert.ok(/\.mt-arow \{[^}]*flex-wrap:wrap/.test(cmView.webview.html), 'a fleet row wraps instead of clipping the facts at its tail');
    // A hidden view must not shell out; and a failed scan (before any data) posts the CLI-missing hint.
    const cmMsgs = [];
    cmView.webview.postMessage = (m) => cmMsgs.push(m);
    cmProvider.refresh();
    assert.equal(cmMsgs.length, 0, 'a hidden Overview does not spawn the CLI or post');
    cmMsgHandler({ type: 'feed', kind: 'process', id: 'bg123' });
    assert.equal(cmMsgs.length, 0, 'a hidden Overview does not fetch a feed either');
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

    // Task review actions: the Tasks tab rows route to the STRICT task ops. The commands are
    // registered; verify the message handler routes each correctly.
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
    assert.ok(typeof commands['claudeObservatory.clearCompletedTasks'] === 'function', 'clearCompletedTasks registered');
    const ccSeen = [];
    const realCC = commands['claudeObservatory.clearCompletedTasks'];
    commands['claudeObservatory.clearCompletedTasks'] = () => { ccSeen.push(1); };
    cmMsgHandler({ type: 'clearCompletedTasks' });
    commands['claudeObservatory.clearCompletedTasks'] = realCC;
    assert.equal(ccSeen.length, 1, 'the "clear completed tasks" control routes to its command');

    // Top-navbar review actions route to the existing session-wide commands (the same the Observations
    // toolbar drives): the session selector + Accept All / Reject All / Clear Resolved / Refresh.
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

    // (1) PROMPT-SCOPED BULK ACTIONS: a picked prompt scopes the title-bar Accept All / Reject All /
    // Clear Resolved buttons to that ask and relabels them "…in #N". Verified from the embedded
    // webview source (the smoke harness renders the shell but doesn't execute its script).
    assert.ok(/function relabelBulk/.test(cmView.webview.html), 'the bulk buttons relabel to the selected scope (relabelBulk)');
    assert.ok(/Accept All in /.test(cmView.webview.html) && /Reject All in /.test(cmView.webview.html) && /Clear in /.test(cmView.webview.html),
      'the scoped bulk buttons read "… in #N"');
    assert.ok(/bulk\('ov-keepall','keepAll','promptKeep'\)/.test(cmView.webview.html)
      && /bulk\('ov-undoall','undoAll','promptUndo'\)/.test(cmView.webview.html)
      && /bulk\('ov-clearres','clearResolved','promptClear'\)/.test(cmView.webview.html),
      'a selected prompt reroutes Accept All / Reject All / Clear to the prompt ops');

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
    // (3) THE PROMPT AXIS — the LAST axis on the review nav bar. Step/Review/Accept/Reject
    // affordances scoped to one of the user's own asks (the Subtask axis is gone in 0.8.8).
    for (const id of ['ov-promptprev', 'ov-promptcount', 'ov-promptnext', 'ov-reviewprompt', 'ov-acceptprompt', 'ov-rejectprompt']) {
      assert.ok(cmView.webview.html.includes(`id="${id}"`), `the review nav bar carries the Prompt-axis control ${id}`);
    }
    for (const gone of ['ov-chaptercount', 'ov-subtaskcount', 'ov-acceptchapter', 'ov-rejectchapter']) {
      assert.ok(!cmView.webview.html.includes(`id="${gone}"`), `the fifth axis is gone (${gone}) — four axes: Diff · File · Folder · Prompt`);
    }
    // The strict per-task ops must be REACHABLE, not merely registered: the Tasks rows post them.
    assert.ok(/data-tkeep/.test(cmView.webview.html) && /data-tundo/.test(cmView.webview.html) && /data-tclear/.test(cmView.webview.html),
      'Tasks tab: each row with edits offers Accept / Reject / Clear over its strict span');
    assert.ok(/type:'taskKeep'|type:msg/.test(cmView.webview.html), 'Tasks tab: the chips post the task ops to the host');
    assert.ok(/mt-tclrall/.test(cmView.webview.html), 'Tasks tab: a clear-resolved-in-completed-tasks affordance exists');
    assert.ok(/id="ov-promptcount"[^>]*>Prompt –\/–</.test(cmView.webview.html), 'the Prompt counter starts at –/– (no position is claimed before one is known)');
    assert.ok(/'Prompt '\+\(p\.prompt\.i\|\|'–'\)\+'\/'\+p\.prompt\.n/.test(cmView.webview.html) && /'\ · #'\+p\.prompt\.index/.test(cmView.webview.html),
      'the counter shows both the review position (i/n) and the ask’s OWN session number (#k) — they differ');
    // …and it routes to the host commands, which resolve the scope in core (never re-derived here).
    for (const [msg, cmd] of [
      ['navPromptPrev', 'claudeObservatory.navPromptPrev'],
      ['navPromptNext', 'claudeObservatory.navPromptNext'],
      ['reviewCurrentPrompt', 'claudeObservatory.reviewCurrentPrompt'],
      ['acceptCurrentPrompt', 'claudeObservatory.acceptCurrentPrompt'],
      ['rejectCurrentPrompt', 'claudeObservatory.rejectCurrentPrompt'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      let seen = 0;
      const real = commands[cmd];
      commands[cmd] = () => { seen++; };
      cmMsgHandler({ type: msg });
      commands[cmd] = real;
      assert.equal(seen, 1, `the Overview nav-bar "${msg}" control routes to ${cmd}`);
    }
    // the Prompts window's selected row drives the id-scoped ops directly (the same shape the task ops use).
    for (const [msg, cmd] of [
      ['promptKeep', 'claudeObservatory.promptKeep'],
      ['promptUndo', 'claudeObservatory.promptUndo'],
      ['promptClear', 'claudeObservatory.promptClear'],
      ['reviewPrompt', 'claudeObservatory.reviewPrompt'],
    ]) {
      assert.ok(typeof commands[cmd] === 'function', `${cmd} registered`);
      const seen = [];
      const real = commands[cmd];
      commands[cmd] = (id) => { seen.push(id); };
      cmMsgHandler({ type: msg, promptId: 'req7' });
      commands[cmd] = real;
      assert.deepEqual(seen, ['req7'], `a scoped ${msg} routes to ${cmd} with the prompt id`);
    }
    // The Prompts WINDOW fetches its own list (one spawn, its own visibility gate); the Overview does
    // NOT spawn `prompts --json` — the per-ask slices it filters by ride the changemap payload.
    assert.ok(/"prompts", "--json", "--session", session/.test(bundleSrc), 'the Prompts window fetches prompts --json for the active session');
    assert.ok(/rq = d && Array\.isArray\(d\.prompts\) && d\.summary \? d : null/.test(bundleSrc), 'a CLI that cannot answer prompts lands as null, not as a crash');
    assert.ok(/cm === void 0 \|\| mt === void 0 \|\| pr === void 0\)/.test(bundleSrc), 'the Overview paint waits for its three spawns (prompts is no longer one of them)');
    assert.ok(!/setInterval[^;]*prompts/.test(bundleSrc), 'the Prompts window adds no polling timer of its own');
    assert.ok(/"prompts", "--id", id, "--response", "--json", "--session", session/.test(bundleSrc),
      'a row expand fetches Claude’s reply via prompts --id --response --json');

    // the live position push: setNavPos posts a {navpos} message to a VISIBLE Overview so the counters update.
    assert.ok(typeof cmProvider.setNavPos === 'function', 'the Overview exposes setNavPos (the host pushes the live Diff/File position)');
    cmView.visible = true;
    const navPosMsgs = [];
    cmView.webview.postMessage = (m) => navPosMsgs.push(m);
    cmProvider.setNavPos({ diff: { i: 1, n: 3 }, file: { i: 2, n: 4 }, request: { i: 2, n: 5, index: 9, title: 'add the requests axis' } });
    cmView.visible = false;
    assert.ok(navPosMsgs.some((m) => m.type === 'navpos' && m.pos && m.pos.diff.n === 3 && m.pos.file.i === 2),
      'setNavPos pushes the Diff/File position to the visible Overview counters');
    assert.ok(navPosMsgs.some((m) => m.type === 'navpos' && m.pos && m.pos.request && m.pos.request.n === 5 && m.pos.request.index === 9),
      'setNavPos carries the Request-axis position too (review place i/n + the ask’s own number)');

    // 0.8.0 stabilization: the literal-tabs prototype (overviewTabs/OverviewTab) was superseded by the
    // Fleet/Workflows master–detail nav and removed — the export must stay gone (dead code guard).
    assert.equal(ext.overviewTabs, undefined, 'overviewTabs prototype removed — per-agent views are the Fleet nav rows');

    // 0.8.8: the display-subtask layer is gone entirely — strict per-task attribution only.
    assert.ok(!/label:'unassigned'/.test(cmView.webview.html), 'no "unassigned" ribbon row can render');
    assert.ok(!/w\.subtasks/.test(cmView.webview.html) && !/ch\.synthetic/.test(cmView.webview.html), 'no subtask reads remain in the webview');

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

    // The mock's own contract, pinned. Both overloads of show*Message must hand back the FIRST action;
    // getting this wrong makes the code under test take a branch it never asked for, and only on the
    // paths a local run happens not to exercise.
    assert.equal(await vscode.window.showWarningMessage('probe', 'First', 'Second'), 'First', 'positional-items overload returns the first action');
    assert.equal(await vscode.window.showWarningMessage('probe', { modal: true }, 'First', 'Second'), 'First', 'options-object overload returns the first action too');
    assert.deepEqual(await vscode.window.showWarningMessage('probe', { title: 'First' }, { title: 'Second' }), { title: 'First' }, 'a MessageItem action is an action, not an options object');

    // --- demo mode + the guided tour (0.8.9) ---
    // Re-point the Overview's sink: the nav-position block above claimed it, and the tour's messages to
    // this panel (tab, ring, show-all) are what the rest of this section asserts on.
    const cmTourMsgs = [];
    cmView.webview.postMessage = (m) => cmTourMsgs.push(m);
    // The install/update offer must NEVER fire in an automated run. Its guard is that
    // `context.extension` is absent under this mock — the same guard checkForUpdate already relies on —
    // so if it ever fires here it would also fire in every CI job and every headless host.
    assert.equal(infoMessages.filter((m) => /Claude Observatory is (installed|now )/.test(m)).length, 0, 'the first-run offer stays out of automated runs');

    for (const c of ['startDemo', 'restartDemo', 'startTour', 'tourNext', 'tourBack', 'tourGoto', 'exitDemo']) {
      assert.ok(typeof commands[`claudeObservatory.${c}`] === 'function', `${c} registered`);
    }
    // The tour is a detachable webview PANEL, not a sidebar view: a sidebar slot would sit in the very
    // container whose other views the tour keeps asking you to look at.
    assert.ok(!webviewProviders['claudeObservatory.tour'], 'the tour is not a sidebar view');
    assert.ok(!pkg.contributes.views.claudeObservatory.some((v) => v.id === 'claudeObservatory.tour'), 'and is not contributed as one');
    // The in-panel tip strip was removed: the step's text belongs in the tour, and repeating it inside
    // every panel cost vertical space in each of them to say the same sentence twice.
    assert.ok(!fs.readFileSync(BUNDLE, 'utf8').includes('ov-tourtip'), 'the in-panel tip strip is gone and stays gone');
    for (const id of ['id="count"', 'id="title"', 'id="body"', 'id="tip"', 'id="next"', 'id="back"', 'id="dock"', 'id="exit"', 'id="dots"', 'id="action"', 'id="actionlabel"', 'id="actionstate"']) {
      assert.ok(fs.readFileSync(BUNDLE, 'utf8').includes(id), `the tour panel renders ${id}`);
    }
    // Stats and Prompts ring their own controls now: an anchor is BROADCAST to every tour-aware panel
    // and each rings it only if its own map knows the name. Routing by view instead would send a
    // Stats-local anchor to the Overview, which rings nothing and reads as broken.
    for (const id of ['id="tk-sec"', 'id="usage-sec"', 'id="rv-sec"', 'TOUR_ANCHORS', "'stats-model'", "'prompts-list'"]) {
      assert.ok(fs.readFileSync(BUNDLE, 'utf8').includes(id), `the Stats/Prompts shells carry ${id}`);
    }

    // The Overview handles the tour message (tab + in-panel tip + the ring on the named control).
    const cmHtml = webviewProviders['claudeObservatory.changemap'];
    assert.ok(cmHtml, 'the Overview view is registered');

    // Replay, cancelled at the first beat: exercises the command, the progress wiring, the shouldStop
    // plumbing and the session override without paying for a ~17s paced run.
    progressCancelled = true;
    const cfgBefore = configWrites.length;
    await commands['claudeObservatory.startDemo']();
    // Stopping at the first beat is stopping BEFORE the first capture, so there are no store records —
    // what must exist is the seeded workspace, which is the thing Exit has to be able to reclaim.
    assert.ok(fs.existsSync(path.join(ws, 'observatory-demo', '.observatory-demo')), 'the demo workspace is seeded and marked');
    assert.equal(core.listSessions().filter((s) => core.isDemoSession(s.id)).length, 0, 'a replay stopped at beat one captured nothing');
    assert.deepEqual(
      configWrites.slice(cfgBefore).filter(([k]) => k === 'session'),
      [],
      'demo mode never writes claudeObservatory.session — that would dirty .vscode/settings.json in the user repo'
    );
    // A stopped replay deliberately does NOT open the tour — there would be nothing to tour.
    assert.equal(webviewPanels.length, 0, 'a cancelled replay does not open a tour');
    // …and neither does the tour COMMAND, because there is no demo session for it to act on. The tour
    // accepts and reverts edits, some of them on a nine-second timer, so it may only ever run against
    // the demo — a guard that has to hold whichever route reached it, not only the button.
    quickPick = 1; // "Everything"
    await commands['claudeObservatory.startTour']();
    assert.equal(webviewPanels.length, 0, 'the tour refuses to open with no demo session to act on');
    assert.match(
      warnMessages[warnMessages.length - 1] || '',
      /guided tour runs against the demo session/i,
      'and says why rather than opening onto a real session'
    );

    // Record a real one, unpaced, so the tour below walks a store with actual records in it.
    await core.runDemo({ cwd: ws, fast: true, fleet: false });
    quickPick = 1; // "Everything"
    await commands['claudeObservatory.startTour']();
    assert.equal(webviewPanels.length, 1, 'the tour opened as a webview panel, not a sidebar view');
    const tourView = webviewPanels[0];
    assert.match(tourView.title, /guided tour/i);
    const live = () => webviewPanels[webviewPanels.length - 1];
    // The tour panel got a step, and it is core's first step rather than one invented here.
    const stepMsgs = tourView.webview.posts.filter((m) => m.type === 'step');
    assert.ok(stepMsgs.length >= 1, 'the tour opened on a step');
    assert.equal(stepMsgs[stepMsgs.length - 1].step.id, core.demoTour()[0].id, 'and it is core’s script, not a local copy');
    assert.equal(stepMsgs[stepMsgs.length - 1].n, core.demoTour().length, 'with the full step count for its progress readout');
    // It plays by DEFAULT, and says how long the step has rather than moving without warning. Asserted
    // here, before any navigation: every manual control pauses, so this is the only moment it holds.
    const firstAuto = tourView.webview.posts.filter((m) => m.type === 'auto');
    assert.ok(firstAuto.length > 0, 'the tour reports its autoplay state');
    assert.equal(firstAuto[0].playing, true, 'and it plays by default');
    assert.ok(firstAuto[0].secs > 0, 'with seconds left on this step');
    await commands['claudeObservatory.tourNext']();
    assert.equal(tourView.webview.posts.filter((m) => m.type === 'step').pop().i, 1, 'Next advances a step');
    await commands['claudeObservatory.tourBack']();
    assert.equal(tourView.webview.posts.filter((m) => m.type === 'step').pop().i, 0, 'Back returns to the previous one');

    // --- action steps: the wait/auto state machine, driven end to end ---
    // Arm a wait step, mutate the store the way a reader would, and assert the tour notices. This is
    // the whole interactive feature; nothing else in the suite covers it.
    const waitStep = core.demoTour().findIndex((x) => x.action?.mode === 'wait');
    assert.ok(waitStep >= 0, 'the script has a wait step to drive');
    await commands['claudeObservatory.tourGoto'](waitStep);
    const armed = live().webview.posts.filter((m) => m.type === 'step').pop();
    assert.equal(armed.actionState, 'waiting', 'a wait step arms as waiting');
    // Mutate the DEMO session — the one the tour pinned. The watch is keyed to that session precisely so
    // a count taken against one log is never compared with a count taken against another.
    const demoS = core.demoSessionsFor({ cwd: ws })[0];
    assert.ok(demoS, 'the replay left a demo session for the tour to act on');
    const pend = core.readLog(demoS).find((r) => r.status === 'pending');
    core.setStatus(demoS, pend.id, core.demoTour()[waitStep].action.kind === 'undo-edit' ? 'undone' : 'kept');
    await commands['claudeObservatory.refresh']();
    assert.equal(live().webview.posts.filter((m) => m.type === 'action').pop().state, 'satisfied', 'and notices when the reader does it');

    // --- autoplay ---
    const autoPosts = () => live().webview.posts.filter((m) => m.type === 'auto');
    // Any manual control hands over the wheel — the rule both of the site's demo engines use.
    await commands['claudeObservatory.tourNext']();
    assert.equal(autoPosts().pop().playing, false, 'Next pauses autoplay');
    await commands['claudeObservatory.tourBack']();
    assert.equal(autoPosts().pop().playing, false, 'and it stays paused');
    await commands['claudeObservatory.tourPlayPause']();
    assert.equal(autoPosts().pop().playing, true, 'the transport resumes it');
    await commands['claudeObservatory.tourPlayPause']();
    assert.equal(autoPosts().pop().playing, false, 'and pauses it again');

    // A WAIT step under autoplay really performs its action rather than skipping it — a reader who
    // only watches still sees Keep happen. Assert the STORE changed, not merely that a message flew.
    // Earlier assertions resolved everything, so seed a pending edit — otherwise the step correctly
    // reports there is nothing left to accept rather than accepting something.
    const ab = core.writeBlob(demoS, Buffer.from('a\n'));
    const aa = core.writeBlob(demoS, Buffer.from('a\nb\n'));
    core.appendLog(demoS, { ts: 9950, tool: 'Edit', file: F, beforeBlob: ab, afterBlob: aa, status: 'pending' });
    const keepStep = core.demoTour().findIndex((x) => x.action?.kind === 'keep-edit');
    await commands['claudeObservatory.tourGoto'](keepStep);
    const keptBefore = core.readLog(demoS).filter((r) => r.status === 'kept').length;
    await commands['claudeObservatory.tourPlayPause'](); // resume: arms the countdown
    await new Promise((r) => setTimeout(r, core.DEMO_ACTION_COUNTDOWN_MS + 600));
    assert.ok(core.readLog(demoS).filter((r) => r.status === 'kept').length > keptBefore, 'an unanswered ask applies itself rather than being skipped');
    // …and it advances exactly ONE step. Performing the action refreshes, which makes the watcher arm a
    // beat of its own — so two timers are in flight for the same moment. They are guarded today, but the
    // guards are what make that safe, and this pins the outcome rather than the guards.
    await new Promise((r) => setTimeout(r, 2200));
    const landed = live().webview.posts.filter((m) => m.type === 'step').pop().i;
    assert.equal(landed, keepStep + 1, 'the tour moved on by one, not two');
    await commands['claudeObservatory.tourPlayPause'](); // pause again so the rest of the test is stable

    // …and the other shape: with nothing pending, the step reports it instead of hanging.
    for (const r of core.readLog(demoS)) if (r.status === 'pending') core.setStatus(demoS, r.id, 'kept');
    await commands['claudeObservatory.tourGoto'](keepStep);
    assert.equal(
      live().webview.posts.filter((m) => m.type === 'step').pop().actionState,
      'vacated',
      'nothing left to accept is reported, not waited on'
    );

    // Moving on DISARMS: a later mutation must post nothing, or every step leaks a watcher.
    const plain = core.demoTour().findIndex((x) => !x.action);
    await commands['claudeObservatory.tourGoto'](plain);
    const actionsBefore = live().webview.posts.filter((m) => m.type === 'action').length;
    const pend2 = core.readLog(demoS).find((r) => r.status === 'pending');
    if (pend2) core.setStatus(demoS, pend2.id, 'kept');
    await commands['claudeObservatory.refresh']();
    assert.equal(live().webview.posts.filter((m) => m.type === 'action').length, actionsBefore, 'a step with no action watches nothing');

    // Floating is the default, and the choice is remembered for next time rather than re-asked.
    assert.equal(live().webview.posts.filter((m) => m.type === 'step').pop().docked, true, 'the tour is docked by default');
    await commands['claudeObservatory.tourFloat']();
    const floated = webviewPanels[webviewPanels.length - 1];
    assert.equal(floated.webview.posts.filter((m) => m.type === 'step').pop().docked, false, 'and it reports itself floating');
    // Stepping BETWEEN the toggles is the regression: setDocked disposes the panel to rebuild it, and
    // without a guard that dispose fires tourClosed -> endTour, leaving Next/Back dead.
    await commands['claudeObservatory.tourNext']();
    assert.ok(live().webview.posts.filter((m) => m.type === 'step').length > 0, 'the tour still steps after a float');
    await commands['claudeObservatory.tourDock']();
    await commands['claudeObservatory.tourNext']();
    const afterToggles = live().webview.posts.filter((m) => m.type === 'step').pop();
    assert.ok(afterToggles, 'and still steps after docking again — the toggle did not end the tour');

    // An AUTO step that could not run must not claim it did. Resolve everything the demo has, then land
    // on the accept-a-task step: with nothing pending there is no task to accept, and "✓ done" over a
    // screen where nothing moved is the exact failure this reports instead.
    for (const r of core.readLog(demoS)) if (r.status === 'pending') core.setStatus(demoS, r.id, 'kept');
    const autoStep = core.demoTour().findIndex((x) => x.action?.mode === 'auto' && x.action.kind === 'keep-task');
    await commands['claudeObservatory.tourGoto'](autoStep);
    assert.equal(
      live().webview.posts.filter((m) => m.type === 'step').pop().actionState,
      'vacated',
      'an auto step that did nothing says so rather than reporting done'
    );

    // Docking carries the action state across. Dropping it re-rendered a satisfied step as "waiting" —
    // invisible in a screenshot, and exactly the kind of thing only a state assertion catches.
    await commands['claudeObservatory.tourFloat']();
    await commands['claudeObservatory.tourDock']();
    assert.equal(
      live().webview.posts.filter((m) => m.type === 'step').pop().actionState,
      'vacated',
      'and the state survives a dock/float rebuild'
    );

    // The Overview's Active-only filter is held open for the tour, and handed back when it ends: the
    // demo leaves five of six tasks completed, which that filter hides.
    const showAlls = () => cmTourMsgs.filter((m) => m.type === 'showall');
    assert.equal(showAlls().at(-1)?.on, true, 'a running tour asks the Overview to show every row');

    // The short track is the same script, filtered — and choosing it really shortens the tour.
    // End the TOUR, not the demo: the demo has to survive, because the tour refuses to open without one.
    await commands['claudeObservatory.tourClosed']();
    quickPick = 0; // "Essentials"
    await commands['claudeObservatory.startTour']();
    const shortPanel = webviewPanels[webviewPanels.length - 1];
    const shortN = shortPanel.webview.posts.filter((m) => m.type === 'step').pop().n;
    assert.equal(shortN, core.demoTrackSizes().essentials, 'the short track walks the essential steps');
    assert.ok(shortN < core.demoTrackSizes().everything, 'and it is genuinely shorter');
    // Dismissing the chooser opens nothing at all.
    await commands['claudeObservatory.tourClosed']();
    const before = webviewPanels.length;
    quickPick = null;
    await commands['claudeObservatory.startTour']();
    assert.equal(webviewPanels.length, before, 'a dismissed chooser leaves no half-opened tour');
    quickPick = 1;
    await commands['claudeObservatory.startTour']();

    // Walk EVERY step. Each one activates a different view and, for the Overview, a different tab; a
    // branch that throws (an unknown view, an editor step with nothing pending, a provider that is not
    // resolved) would otherwise only show up when a reader reached that step in a real session.
    const tour = core.demoTour();
    for (let i = 0; i < tour.length; i++) {
      await commands['claudeObservatory.tourGoto'](i);
      const posted = live().webview.posts.filter((m) => m.type === 'step').pop();
      assert.equal(posted.i, i, `step ${i} (${tour[i].id}) posts its own index`);
      assert.equal(posted.step.id, tour[i].id, `step ${i} posts core's step, unchanged`);
    }
    // Past the end finishes the tour rather than throwing or wrapping.
    await commands['claudeObservatory.tourGoto'](tour.length - 1);
    const lastPanel = live();
    await commands['claudeObservatory.tourNext']();
    assert.equal(lastPanel.webview.posts.filter((m) => m.type === 'step').pop().i, tour.length - 1, 'Next on the last step ends the tour, leaving it on the last step');
    assert.ok(lastPanel.disposed, 'and the tour window closes with it');

    // …and hands the filter back the moment it ends, rather than leaving the reader's Overview changed.
    await commands['claudeObservatory.tourClosed']();
    assert.equal(showAlls().at(-1)?.on, false, 'and gives the filter back when the tour ends');

    // Finishing the SHORT track offers the other 28 rather than just closing — the only place a reader
    // who picked Essentials is told the rest exists.
    quickPick = 0; // "Essentials"
    await commands['claudeObservatory.startTour']();
    const shortTour = core.demoTour('essentials');
    await commands['claudeObservatory.tourGoto'](shortTour.length - 1);
    const infoBefore = infoMessages.length;
    infoPick = `See the other ${core.demoTrackSizes().remainder}`;
    await commands['claudeObservatory.tourNext']();
    assert.ok(
      infoMessages.slice(infoBefore).some((m) => /short track/i.test(m)),
      'the end of the short track offers the remainder'
    );
    const contd = live().webview.posts.filter((m) => m.type === 'step').pop();
    assert.equal(contd.n, core.demoTrackSizes().remainder, 'and accepting walks exactly the complement');
    assert.equal(contd.step.id, core.demoTour('remainder')[0].id, 'starting at its first step');
    infoPick = undefined;

    // Exit removes every trace — and still writes nothing to settings.
    // A demo file left open is the failure that makes the demo folder UNREMOVABLE: saving that buffer
    // after the folder is deleted recreates a file inside it, and the `.observatory-demo` sentinel that
    // authorizes deletion went with the tree. The tour deliberately opens one, so Exit closes them.
    const demoTab = { input: { uri: Uri.file(path.join(ws, 'observatory-demo', 'src', 'features.py')) } };
    const otherTab = { input: { uri: Uri.file(path.join(ws, 'app.txt')) } };
    openTabs.push(demoTab, otherTab);
    const cfgBeforeExit = configWrites.length;
    await commands['claudeObservatory.exitDemo']();
    assert.ok(!openTabs.includes(demoTab), 'exitDemo closes editors on demo files before deleting them');
    assert.ok(openTabs.includes(otherTab), 'and leaves the user’s own files open');
    assert.equal(core.listSessions().filter((s) => core.isDemoSession(s.id)).length, 0, 'exitDemo removed the demo session(s)');
    assert.ok(!fs.existsSync(path.join(ws, 'observatory-demo')), 'and the demo workspace folder');
    assert.deepEqual(configWrites.slice(cfgBeforeExit).filter(([k]) => k === 'session'), [], 'exitDemo writes no config either');
    progressCancelled = false;
  } finally {
    Module._load = origLoad;
  }
});
