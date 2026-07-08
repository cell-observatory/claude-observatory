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
  const S = 'extSess';

  // seed: projects dir so resolveSessionId(ws) === S, and a store with 2 edits on one file
  const proj = path.join(home, '.claude', 'projects', ws.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, S + '.jsonl'), JSON.stringify({ type: 'ai-title', aiTitle: 'Reviewing app.txt edits' }));
  const F = path.join(ws, 'app.txt');
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
  const statusBarItem = { text: '', tooltip: '', command: undefined, backgroundColor: undefined, show() {}, hide() {}, dispose() {} };
  let clipboardText = '';
  let decoCounter = 0;
  let opened = null;
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
  };
  const doc = {
    uri: Uri.file(F),
    lineCount: 5,
    getText: () => 'AAA\nb\nc\nZZZ\n',
    lineAt: (n) => ({ range: new Range(n, 0, n, 3) }),
  };
  const mockEditor = { document: doc, selection: null, setDecorations: (t, opts) => decoCalls.push({ typeId: t.id, opts }), revealRange() {} };
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
    workspace: {
      workspaceFolders: [{ uri: Uri.file(ws) }],
      textDocuments: [],
      asRelativePath: (f) => path.relative(ws, typeof f === 'string' ? f : f.fsPath),
      registerTextDocumentContentProvider: (s, p) => { contentProviders[s] = p; return { dispose() {} }; },
      createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }),
      onDidChangeTextDocument: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (_k, def) => def, update: () => Promise.resolve() }),
      openTextDocument: (uri) => Promise.resolve({ uri, lineCount: 5, getText: () => 'AAA\nb\nc\nZZZ\n', lineAt: (n) => ({ range: new Range(n, 0, n, 3) }) }),
    },
    window: {
      createTreeView: (id, opts) => {
        trees[id] = opts.treeDataProvider;
        return { badge: undefined, description: undefined, onDidChangeVisibility: () => ({ dispose() {} }), dispose() {} };
      },
      createStatusBarItem: () => statusBarItem,
      setStatusBarMessage: () => ({ dispose() {} }),
      createTextEditorDecorationType: () => ({ id: ++decoCounter, dispose() {} }),
      registerFileDecorationProvider: (p) => { decoProvider = p; return { dispose() {} }; },
      registerWebviewViewProvider: (id, p) => { webviewProviders[id] = p; return { dispose() {} }; },
      withProgress: (_o, task) => task({ report() {} }),
      onDidChangeWindowState: () => ({ dispose() {} }),
      onDidChangeActiveTextEditor: () => ({ dispose() {} }),
      activeTextEditor: mockEditor,
      visibleTextEditors: [mockEditor],
      showTextDocument: (d) => { opened = d; return Promise.resolve({ document: d, selection: null, revealRange() {} }); },
      showInformationMessage: () => Promise.resolve(undefined),
      showWarningMessage: (_m, _o, ...items) => Promise.resolve(items[0]),
    },
    commands: {
      registerCommand: (id, cb) => { commands[id] = cb; return { dispose() {} }; },
      executeCommand: (cmd, ...args) => {
        if (cmd === 'vscode.diff') { diffCalls.push(args); return Promise.resolve(); }
        return Promise.resolve(commands[cmd] && commands[cmd](...args));
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
    ext.activate({ subscriptions: [] });

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

    // inline overlay: right-side annotations, one per pending edit (#1 -> line 0, #2 -> line 3)
    const annCall = decoCalls.filter((c) => c.typeId === 2).pop();
    assert.ok(annCall, 'annotation decorations applied');
    assert.equal(annCall.opts.length, 2, 'one annotation per pending edit');
    const annByLine = Object.fromEntries(annCall.opts.map((o) => [o.range.start.line, o]));
    assert.ok(annByLine[0] && /#1/.test(annByLine[0].renderOptions.after.contentText), 'edit #1 annotated at line 0');
    assert.ok(annByLine[3] && /#2/.test(annByLine[3].renderOptions.after.contentText), 'edit #2 annotated at line 3');
    assert.match(annByLine[0].hoverMessage.value, /command:claudeObservatory\.inline(Keep|Undo|Diff)/, 'hover carries action links');
    assert.match(annByLine[0].hoverMessage.value, /command:claudeObservatory\.chatEdit/, 'hover carries a Chat link');

    // inline CodeLens: visible Keep / Undo / Diff actions above each pending edit
    assert.ok(lensProvider, 'CodeLens provider registered');
    const lenses = lensProvider.provideCodeLenses(doc);
    assert.ok(lenses.length >= 4, 'lenses provided for the pending edits');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.inlineKeep' && /Keep #\d/.test(l.command.title)), 'a Keep lens carries the id');
    assert.ok(lenses.some((l) => l.command.command === 'claudeObservatory.inlineUndo'), 'an Undo lens');

    // hovering the highlighted (changed) text pops the same Keep/Undo/Diff/Chat menu
    assert.ok(hoverProvider, 'hover provider registered');
    const hv = hoverProvider.provideHover(doc, new Position(0, 0)); // line 0 is edit #1's changed line
    assert.ok(hv && /command:claudeObservatory\.inline(Keep|Undo)/.test(hv.contents.value), 'hover over highlighted text shows the menu');

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
    assert.match(stView.webview.html, /Gathering stats/i, 'stats placeholder present until the scan returns');
    assert.match(stView.webview.html, /id="ustale"/, 'stale-cache hint present (panel-only sessions)');
    // CLI-missing hint: a failed scan (before any data) posts statsError so the webview shows install help
    const stMsgs = [];
    stView.webview.postMessage = (m) => stMsgs.push(m);
    stProvider.postStatsError();
    assert.ok(stMsgs.some((m) => m.type === 'statsError'), 'failed stats scan posts the CLI-missing hint');

    // realtime observatory: status-bar telescope shows the pending count + the review scoreboard tooltip
    assert.match(statusBarItem.text, /telescope/, 'status bar telescope present');
    assert.match(statusBarItem.text, /2/, 'status bar shows 2 pending');
    assert.match(statusBarItem.tooltip.value, /2 pending · 0 accepted · 0 reverted/, 'scoreboard lives in the telescope tooltip');
    assert.ok(typeof commands['claudeObservatory.reviewNext'] === 'function', 'reviewNext registered');
    await commands['claudeObservatory.reviewNext']();
    assert.ok(opened && opened.uri.fsPath === F, 'reviewNext opened the file with the oldest pending edit');
    opened = null;

    // new commands exist
    for (const c of ['claudeObservatory.keepAll', 'claudeObservatory.undoAll', 'claudeObservatory.chatEdit',
      'claudeObservatory.showObservation', 'claudeObservatory.analyzeEdit', 'claudeObservatory.refreshRecap']) {
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
  } finally {
    Module._load = origLoad;
  }
});
