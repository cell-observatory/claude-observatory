/**
 * Live demo simulator (0.8.0): replays a scripted Claude Code session through the REAL pipeline —
 * transcript lines appended to the real project dir, edits captured via the same Pre/PostToolUse hook
 * logic (`handleHookPayload`), a subagent transcript, and a workflow run — so every panel in both
 * editors lights up live, exactly as it would during a real session. Two jobs:
 *
 *   1. SHOWCASE — `claude-observatory demo` in an open workspace simulates a prompt to Claude and
 *      shows live changes: the Overview's chapter ribbon fills chapter by chapter, the Fleet nav
 *      gains a subagent and a workflow run, Observations streams the reasoning, and Accept/Reject/
 *      task-scoped review genuinely work (the edits are real store records on real files).
 *   2. AUTOMATED TEST — `--fast` replays the whole scenario in under a second, hermetically under
 *      CLAUDE_CONFIG_DIR, so the e2e suite can assert every 0.8.0 `--json` surface against a session
 *      produced by the same code path a real one takes.
 *
 * ISOLATION (never pollutes real work):
 *   · the session id is `demo-<8hex>` — the prefix gates every demo-only behavior incl. cleanup;
 *   · every file edit is confined to a dedicated workspace folder (default `<cwd>/observatory-demo/`),
 *     marked with a `.observatory-demo` sentinel so cleanup can prove it owns the directory;
 *   · reviewing the demo leaves no residue: `autoClearDemo` drops the store records of a fully
 *     reviewed (no pending) demo session, and `demo --clean` removes everything — transcript,
 *     subagents/workflows, store, and the workspace folder.
 *
 * Zero token — nothing here calls a model; it only writes the files a real session would have written.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { projectDir } from './session';
import { handleHookPayload } from './capture';
import { readLog, clearResolved, removeSession, isSafeSessionId } from './store';
import { claudeConfigDir } from './paths';

export interface DemoOptions {
  /** Workspace folder the demo edits live in (created if missing). Default: `<cwd>/observatory-demo`. */
  dir?: string;
  /** No pacing — the whole scenario lands in well under a second (the automated-test mode). */
  fast?: boolean;
  /** Pacing multiplier for the live showcase: 2 = twice as fast. Ignored with `fast`. */
  speed?: number;
  /** The invocation cwd — the OPEN project whose panels should light up (transcript lands in ITS
   *  project dir, so the editors' session auto-resolution picks the demo up). Default process.cwd(). */
  cwd?: string;
  /** Progress narration (one line per beat); silent when omitted. */
  log?: (line: string) => void;
}

export interface DemoResult {
  session: string;
  workspace: string;
  transcript: string;
  /** Store edits the scenario captured (the review units the panels show). */
  edits: number;
  /** Scenario beats executed. */
  steps: number;
}

const DEMO_ID_RE = /^demo-[0-9a-f]{8}$/;
const MARKER = '.observatory-demo';

/** True for a simulator-owned session id — the gate for every demo-only behavior. */
export function isDemoSession(id: string): boolean {
  return DEMO_ID_RE.test(id);
}

/**
 * Demo sessions leave no residue once reviewed: when EVERY edit of a demo session is resolved
 * (kept/undone — e.g. the user hit Accept All), drop the resolved records entirely so the panels
 * empty out and a re-run starts clean. No-op (false) for real sessions, unreviewed demos, and
 * already-empty stores. Called after the CLI's keep/undo/task ops and the editors' refresh paths.
 */
export function autoClearDemo(sessionId: string): boolean {
  if (!isDemoSession(sessionId)) return false;
  let log;
  try {
    log = readLog(sessionId);
  } catch {
    return false;
  }
  if (log.length === 0 || log.some((r) => r.status === 'pending')) return false;
  return clearResolved(sessionId) > 0;
}

// --- scenario runner ------------------------------------------------------------------------------

/** Monotonic ms clock: strictly increasing across transcript lines, never ahead of real time by more
 *  than the +1ms nudges (the store stamps captures with the REAL Date.now(), and strict-span task
 *  attribution compares the two — so the clock must track real time, not a synthetic timeline). */
class DemoClock {
  private last = 0;
  now(): number {
    this.last = Math.max(this.last + 1, Date.now());
    return this.last;
  }
  iso(): string {
    return new Date(this.now()).toISOString();
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The demo app the scenario edits — a tiny ML training pipeline (the same story the docs mockups
 *  tell). Stdlib-only Python, so the demo files actually run. */
const SEED_FILES: Record<string, string> = {
  'src/features.py':
    'from statistics import mean\n\n\ndef summarize(values):\n    return {"count": len(values), "mean": mean(values)}\n',
  'src/train.py': 'from features import summarize\n\nprint(summarize([1.0, 2.0, 3.0]))\n',
  'src/models/dataset.py':
    'class Dataset:\n    def __init__(self, features, labels):\n        self.features = features\n        self.labels = labels\n',
};

/**
 * Run the built-in scenario. Everything is appended INCREMENTALLY (one beat at a time, paced unless
 * `fast`), so watchers fire and the panels update live. Returns once the scenario has fully landed.
 */
export async function runDemo(opts: DemoOptions = {}): Promise<DemoResult> {
  // Physical path, symlinks resolved — a real session's `cwd` field is the shell's getcwd(), and the
  // project-dir mangling must produce the SAME directory a CLI invoked from there will look in.
  const cwd = fs.realpathSync(opts.cwd ?? process.cwd());
  const workspace = path.resolve(opts.dir ?? path.join(cwd, 'observatory-demo'));
  const session = `demo-${crypto.randomBytes(4).toString('hex')}`;
  if (!isSafeSessionId(session) || !isDemoSession(session)) throw new Error('demo session id failed its own gate');
  const proj = projectDir(cwd);
  fs.mkdirSync(proj, { recursive: true });
  const transcript = path.join(proj, `${session}.jsonl`);
  const say = opts.log ?? (() => {});
  // Fast mode still sleeps a few ms per beat: the clock nudges lines +1ms apart, and real time must
  // stay ahead of it so the store's Date.now() captures interleave correctly with the todo flips.
  const delay = opts.fast ? 8 : Math.max(60, Math.round(800 / (opts.speed && opts.speed > 0 ? opts.speed : 1)));
  const clock = new DemoClock();
  let steps = 0;

  // Seed the demo workspace (never touches anything outside it).
  fs.mkdirSync(path.join(workspace, 'src', 'models'), { recursive: true });
  fs.writeFileSync(path.join(workspace, MARKER), `${session}\n`);
  for (const [rel, content] of Object.entries(SEED_FILES)) {
    fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
    fs.writeFileSync(path.join(workspace, rel), content);
  }

  const append = (obj: unknown) => fs.appendFileSync(transcript, JSON.stringify(obj) + '\n');
  const beat = async (label: string) => {
    steps++;
    say(label);
    await sleep(delay);
  };
  let toolSeq = 0;
  const tid = () => `demo_tu_${++toolSeq}`;

  // One assistant turn: optional reasoning text, then tool_uses (each later resolved by a result line).
  const assistant = (blocks: unknown[], usage = { input_tokens: 40, output_tokens: 120 }) =>
    append({
      type: 'assistant',
      sessionId: session,
      timestamp: clock.iso(),
      // Model + effort are stamped the way current Claude Code stamps them, so the demo session lights
      // up the Stats panel's model/effort chip instead of leaving it blank.
      effort: 'high',
      message: {
        role: 'assistant',
        id: `demo_msg_${toolSeq}_${steps}`,
        model: 'claude-opus-4-8',
        usage: { ...usage, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: blocks,
      },
    });
  /** A context compaction, exactly as the harness records one — so the demo exercises the compaction
   *  marker, the Actions row and the context meter's saw-tooth. */
  const compaction = (preTokens: number, postTokens: number, cumulative: number) =>
    append({
      type: 'system',
      subtype: 'compact_boundary',
      content: 'Conversation compacted',
      sessionId: session,
      isSidechain: false,
      timestamp: clock.iso(),
      compactMetadata: { trigger: 'auto', preTokens, postTokens, cumulativeDroppedTokens: cumulative, durationMs: 92_000 },
    });
  const result = (toolUseId: string) =>
    append({
      type: 'user',
      sessionId: session,
      timestamp: clock.iso(),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false }] },
    });
  const todos = (list: { content: string; status: string }[]) => {
    const id = tid();
    assistant([{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: list } }]);
    result(id);
  };

  // The NUMBERED task list (TaskCreate/TaskUpdate, 0.8.3) — seeded alongside the todos so the
  // Overview's Tasks tab shows live, LINKED data. Same titles as the to-dos: the merged plan dedupes
  // (todos win), so this never mints twin chapters. Task state is written both ways a real session
  // leaves it: transcript tool calls (the history + spans) AND the live task-dir files.
  const taskDir = path.join(claudeConfigDir(), 'tasks', session);
  const TASKS: { subject: string; description: string; activeForm: string }[] = [
    { subject: 'Add feature scaling to the pipeline', description: 'z-score scale() in features.py, wired into train.py', activeForm: 'Adding feature scaling' },
    { subject: 'Validate the training dataset', description: 'Dataset.validate() — length match + non-empty', activeForm: 'Validating the dataset' },
    { subject: 'Tests and docs', description: 'subagent tests + workflow usage docs', activeForm: 'Writing tests and docs' },
  ];
  const taskStatus = ['pending', 'pending', 'pending'];
  const writeTaskFiles = () => {
    fs.mkdirSync(taskDir, { recursive: true });
    TASKS.forEach((t, i) =>
      fs.writeFileSync(
        path.join(taskDir, `${i + 1}.json`),
        JSON.stringify({ id: String(i + 1), subject: t.subject, description: t.description, activeForm: t.activeForm, status: taskStatus[i], blocks: [], blockedBy: [] })
      ));
  };
  const taskCreateAll = () => {
    TASKS.forEach((t, i) => {
      const id = tid();
      assistant([{ type: 'tool_use', id, name: 'TaskCreate', input: { subject: t.subject, description: t.description, activeForm: t.activeForm } }]);
      append({
        type: 'user',
        sessionId: session,
        timestamp: clock.iso(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Task #${i + 1} created successfully: ${t.subject}` }] },
      });
    });
    writeTaskFiles();
  };
  const taskUpdate = (n: number, status: string) => {
    taskStatus[n - 1] = status;
    const id = tid();
    assistant([{ type: 'tool_use', id, name: 'TaskUpdate', input: { taskId: String(n), status } }]);
    result(id);
    writeTaskFiles();
  };

  /** A REAL captured edit: Pre hook → mutate the file → Post hook (the store record every review
   *  surface acts on), plus the matching transcript tool_use so reasoning/actions correlate. */
  const edit = (rel: string, newContent: string, reasoning: string, tool: 'Edit' | 'Write' = 'Edit') => {
    const file = path.join(workspace, rel);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    const hook = (event: string) => ({
      session_id: session,
      cwd,
      hook_event_name: event,
      tool_name: tool,
      tool_input: { file_path: file },
    });
    handleHookPayload(hook('PreToolUse'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, newContent);
    handleHookPayload(hook('PostToolUse'));
    const id = tid();
    const input =
      tool === 'Write'
        ? { file_path: file, content: newContent }
        : { file_path: file, old_string: before ?? '', new_string: newContent };
    assistant([
      { type: 'text', text: reasoning },
      { type: 'tool_use', id, name: tool, input },
    ]);
    result(id);
  };

  // ---------- the story: a prompt, a plan, three chapters, a subagent, a workflow, a recap ----------

  await beat('▸ prompt — asking Claude to extend the training pipeline');
  append({
    type: 'user',
    sessionId: session,
    cwd,
    gitBranch: 'demo/pipeline',
    timestamp: clock.iso(),
    message: { role: 'user', content: 'Add feature scaling and dataset validation to the training pipeline, then bring in tests and docs.' },
  });
  append({ type: 'ai-title', aiTitle: 'Pipeline: scaling, validation, tests', timestamp: clock.iso() });
  assistant([{ type: 'text', text: 'I will plan this as three tasks: feature scaling, dataset validation, then tests and docs via a subagent and a workflow.' }]);

  await beat('▸ plan — three to-dos (the Overview chapters) + the numbered task list');
  todos([
    { content: 'Add feature scaling to the pipeline', status: 'in_progress' },
    { content: 'Validate the training dataset', status: 'pending' },
    { content: 'Tests and docs', status: 'pending' },
  ]);
  taskCreateAll();
  taskUpdate(1, 'in_progress');

  await beat('▸ chapter 1 — feature scaling (2 edits)');
  edit(
    'src/features.py',
    'from statistics import mean, stdev\n\n\ndef summarize(values):\n    return {"count": len(values), "mean": mean(values)}\n\n\ndef scale(values):\n    mu, sigma = mean(values), stdev(values)\n    return [(v - mu) / sigma for v in values]\n',
    'Adding scale() — z-score standardization so features share a range before training.'
  );
  await beat('  … wiring it into the entrypoint');
  edit(
    'src/train.py',
    'from features import summarize, scale\n\nfeatures = scale([1.0, 2.0, 3.0])\nprint(summarize(features))\n',
    'Scaling the features in the training entrypoint before they reach the model.'
  );
  {
    // A shell action for the timeline (transcript-only: Bash capture diffs the whole tree — overkill here).
    const id = tid();
    assistant([
      { type: 'text', text: 'Quick sanity run of the pipeline before moving on.' },
      { type: 'tool_use', id, name: 'Bash', input: { command: 'python src/train.py', description: 'Run the training entrypoint' } },
    ]);
    result(id);
  }

  await beat('▸ chapter 2 — dataset validation');
  todos([
    { content: 'Add feature scaling to the pipeline', status: 'completed' },
    { content: 'Validate the training dataset', status: 'in_progress' },
    { content: 'Tests and docs', status: 'pending' },
  ]);
  taskUpdate(1, 'completed');
  taskUpdate(2, 'in_progress');
  edit(
    'src/models/dataset.py',
    'class Dataset:\n    def __init__(self, features, labels):\n        self.features = features\n        self.labels = labels\n\n    def validate(self):\n        if len(self.features) != len(self.labels):\n            return {"ok": False, "error": "features/labels length mismatch"}\n        if not self.features:\n            return {"ok": False, "error": "empty dataset"}\n        return {"ok": True}\n',
    'Adding Dataset.validate() — matching feature/label lengths and a non-empty check, returned as {ok, error}.'
  );

  // A long session fills its context window and the harness compacts it. The turns on either side
  // carry realistic context sizes so the meter shows the climb and the drop, not a flat line.
  await beat('  … context fills up and the harness compacts the conversation');
  assistant([{ type: 'text', text: 'Continuing — the dataset checks are in place.' }], { input_tokens: 2_400, output_tokens: 320 });
  compaction(178_000, 12_400, 165_600);
  append({
    type: 'user',
    sessionId: session,
    timestamp: clock.iso(),
    isCompactSummary: true,
    message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.' },
  });
  assistant([{ type: 'text', text: 'Picking up from the summary — tests are next.' }], { input_tokens: 900, output_tokens: 140 });

  await beat('▸ chapter 3 — tests, written by a subagent');
  todos([
    { content: 'Add feature scaling to the pipeline', status: 'completed' },
    { content: 'Validate the training dataset', status: 'completed' },
    { content: 'Tests and docs', status: 'in_progress' },
  ]);
  taskUpdate(2, 'completed');
  taskUpdate(3, 'in_progress');
  const subDir = path.join(proj, session, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const spawnId = tid();
  assistant([
    { type: 'text', text: 'Handing the test-writing to a subagent while I prepare the docs workflow.' },
    { type: 'tool_use', id: spawnId, name: 'Task', input: { description: 'Write pipeline tests', subagent_type: 'general-purpose', prompt: 'Write tests for scale/summarize/validate.' } },
  ]);
  fs.writeFileSync(
    path.join(subDir, 'agent-demosub1.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Write pipeline tests', toolUseId: spawnId, spawnDepth: 1 })
  );
  const subFile = path.join(subDir, 'agent-demosub1.jsonl');
  const subLine = (blocks: unknown[]) =>
    fs.appendFileSync(
      subFile,
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        agentId: 'demosub1',
        sessionId: session,
        timestamp: clock.iso(),
        message: { role: 'assistant', id: `demo_sub_${++toolSeq}`, usage: { input_tokens: 30, output_tokens: 90, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: blocks },
      }) + '\n'
    );
  // Resolve each subagent tool_use so its live phase classifies structurally (a pending tool_use with
  // no result would read as a stale permission block minutes later).
  const subResult = (toolUseId: string) =>
    fs.appendFileSync(
      subFile,
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        agentId: 'demosub1',
        sessionId: session,
        timestamp: clock.iso(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false }] },
      }) + '\n'
    );
  {
    const t = tid();
    subLine([{ type: 'tool_use', id: t, name: 'TodoWrite', input: { todos: [{ content: 'Write tests for scale/summarize/validate', status: 'in_progress' }] } }]);
    subResult(t);
  }
  await beat('  … the subagent\'s edit lands, attributed by its action window');
  {
    // The subagent's edit: captured under the parent session (exactly like real Claude Code — hooks
    // carry the parent session_id), attributed to the subagent by its transcript ts-window.
    const rel = 'tests/test_pipeline.py';
    const file = path.join(workspace, rel);
    const content =
      'import sys, pathlib\n\nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "src"))\nfrom features import scale, summarize\nfrom models.dataset import Dataset\n\nscaled = scale([1.0, 2.0, 3.0])\nassert abs(sum(scaled)) < 1e-9\nassert summarize(scaled)["count"] == 3\nassert Dataset([[1.0]], [0]).validate()["ok"] is True\nassert Dataset([[1.0]], []).validate()["ok"] is False\nprint("pipeline tests: all assertions pass")\n';
    const writeId = tid();
    subLine([{ type: 'text', text: 'Covering scale, summarize, and both validate branches.' }, { type: 'tool_use', id: writeId, name: 'Write', input: { file_path: file, content } }]);
    const hook = (event: string) => ({ session_id: session, cwd, hook_event_name: event, tool_name: 'Write', tool_input: { file_path: file } });
    handleHookPayload(hook('PreToolUse'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    handleHookPayload(hook('PostToolUse'));
    subResult(writeId);
    subLine([{ type: 'text', text: 'Tests written and passing locally.' }]);
  }
  result(spawnId);

  await beat('▸ a workflow run starts — documentation, one level above the subagents');
  const wfDir = path.join(subDir, 'workflows', 'wf_demo');
  const stateDir = path.join(proj, session, 'workflows');
  const scriptsDir = path.join(stateDir, 'scripts');
  fs.mkdirSync(wfDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(
    path.join(scriptsDir, 'demo-docs-wf_demo.js'),
    "export const meta = {\n  name: 'Demo Docs',\n  description: 'Write usage docs for the training pipeline',\n  phases: [{ title: 'Docs' }],\n}\nphase('Docs')\n"
  );
  fs.writeFileSync(path.join(wfDir, 'agent-demowf1.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', spawnDepth: 1 }));
  fs.writeFileSync(path.join(wfDir, 'journal.jsonl'), JSON.stringify({ type: 'started', key: 'Docs', agentId: 'demowf1' }) + '\n');
  const wfFile = path.join(wfDir, 'agent-demowf1.jsonl');
  const wfLine = (blocks: unknown[]) =>
    fs.appendFileSync(
      wfFile,
      JSON.stringify({
        type: 'assistant',
        isSidechain: true,
        timestamp: clock.iso(),
        message: { role: 'assistant', id: `demo_wf_${++toolSeq}`, usage: { input_tokens: 60, output_tokens: 180, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: blocks },
      }) + '\n'
    );
  const wfResult = (toolUseId: string) =>
    fs.appendFileSync(
      wfFile,
      JSON.stringify({
        type: 'user',
        isSidechain: true,
        timestamp: clock.iso(),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: false }] },
      }) + '\n'
    );
  {
    const t = tid();
    wfLine([{ type: 'tool_use', id: t, name: 'Read', input: { file_path: path.join(workspace, 'src/features.py') } }]);
    wfResult(t);
  }
  await beat('  … the workflow agent writes the documentation');
  {
    const rel = 'docs/USAGE.md';
    const file = path.join(workspace, rel);
    const content =
      '# Pipeline usage\n\n```python\nfrom features import scale, summarize\nsummarize(scale([1.0, 2.0, 3.0]))  # {"count": 3, "mean": 0.0}\n```\n\nValidate a dataset before training:\n\n```python\nDataset(features, labels).validate()  # {"ok": True} | {"ok": False, "error": ...}\n```\n';
    const writeId = tid();
    wfLine([{ type: 'text', text: 'Documenting the public API with runnable examples.' }, { type: 'tool_use', id: writeId, name: 'Write', input: { file_path: file, content } }]);
    const hook = (event: string) => ({ session_id: session, cwd, hook_event_name: event, tool_name: 'Write', tool_input: { file_path: file } });
    handleHookPayload(hook('PreToolUse'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    handleHookPayload(hook('PostToolUse'));
    wfResult(writeId);
  }
  {
    const t = tid();
    wfLine([{ type: 'tool_use', id: t, name: 'Read', input: { file_path: path.join(workspace, 'docs/USAGE.md') } }]);
    wfResult(t);
  }
  fs.appendFileSync(path.join(wfDir, 'journal.jsonl'), JSON.stringify({ type: 'result', key: 'Docs', agentId: 'demowf1', result: { ok: true } }) + '\n');
  fs.writeFileSync(
    path.join(stateDir, 'wf_demo.json'),
    JSON.stringify({
      workflowName: 'Demo Docs',
      summary: 'Write usage docs for the training pipeline',
      phases: [{ title: 'Docs', detail: 'usage docs' }],
      workflowProgress: [
        { type: 'workflow_phase', index: 0, title: 'Docs' },
        { type: 'workflow_agent', label: 'docs-writer', phaseTitle: 'Docs', phaseIndex: 0, agentId: 'demowf1', tokens: 240, toolCalls: 3, state: 'completed', durationMs: 4000 },
      ],
      totalTokens: 240,
      totalToolCalls: 3,
      durationMs: 4000,
      status: 'completed',
      startTime: new Date().toISOString(),
      agentCount: 1,
    })
  );

  await beat('▸ recap — plan complete, next steps surfaced');
  todos([
    { content: 'Add feature scaling to the pipeline', status: 'completed' },
    { content: 'Validate the training dataset', status: 'completed' },
    { content: 'Tests and docs', status: 'completed' },
  ]);
  taskUpdate(3, 'completed');
  assistant([
    {
      type: 'text',
      text:
        'Done. The pipeline now scales its features, datasets are validated before training, a subagent wrote the tests, and a workflow produced the usage docs.\n\nNext steps:\n- Review the pending edits in the Overview (try Accept on a chapter)\n- Run `python observatory-demo/tests/test_pipeline.py`\n- Remove the demo with `claude-observatory demo --clean`',
    },
  ]);

  const edits = readLog(session).length;
  say(`✔ demo session ${session} — ${edits} captured edits across ${steps} beats`);
  return { session, workspace, transcript, edits, steps };
}

// --- cleanup --------------------------------------------------------------------------------------

export interface DemoCleanResult {
  /** Demo session ids removed (transcript + subagents/workflows + store). */
  sessions: string[];
  /** Workspace folders removed (only ones carrying the `.observatory-demo` marker). */
  workspaces: string[];
}

/**
 * Remove every trace of the simulator for this project: each `demo-<8hex>` session's transcript, its
 * `<proj>/<session>/` tree (subagents + workflows), its store, and the demo workspace folder — but a
 * workspace is only deleted when it carries the `.observatory-demo` sentinel (never a user directory,
 * even if passed via --dir by mistake). Real sessions can never match the id gate.
 */
export function cleanDemo(opts: { cwd?: string; dir?: string } = {}): DemoCleanResult {
  let cwd = opts.cwd ?? process.cwd();
  try {
    cwd = fs.realpathSync(cwd); // the same physical-path rule runDemo records under
  } catch {
    /* keep as given */
  }
  const proj = projectDir(cwd);
  const sessions: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(proj);
  } catch {
    /* no project dir — nothing recorded */
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const id = name.slice(0, -'.jsonl'.length);
    if (!isDemoSession(id)) continue;
    try {
      fs.rmSync(path.join(proj, name), { force: true });
      fs.rmSync(path.join(proj, id), { recursive: true, force: true }); // subagents/ + workflows/
      fs.rmSync(path.join(claudeConfigDir(), 'tasks', id), { recursive: true, force: true }); // the task list (0.8.3)
      removeSession(id); // the store (log + blobs)
      sessions.push(id);
    } catch {
      /* best-effort per session */
    }
  }
  const workspaces: string[] = [];
  const candidate = path.resolve(opts.dir ?? path.join(cwd, 'observatory-demo'));
  if (fs.existsSync(path.join(candidate, MARKER))) {
    try {
      fs.rmSync(candidate, { recursive: true, force: true });
      workspaces.push(candidate);
    } catch {
      /* leave it — the marker still identifies it for a retry */
    }
  }
  return { sessions, workspaces };
}
