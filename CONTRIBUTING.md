# Contributing to Claude Observatory

Thanks for helping build the observatory. This guide is the practical "add a feature across all
platforms" playbook. For the deeper "how it really works" reference — the dependency graph, the
store format, the `--json` contract table — see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## The golden rule

> **Every feature ships in BOTH editors, with the shared logic in `core` → exposed over the CLI
> `--json` surface → rendered by each front-end.**

No feature lands in one editor only. The engine and every view-model live in `packages/core`; the
CLI is the machine-readable view API; the two editors are thin renderers. If you catch yourself
writing tree-building, delta math, or transcript parsing inside `packages/vscode` or
`packages/jetbrains`, stop — that logic belongs in `core`.

```
                 packages/core  (pure TS engine + view-models; only runtime dep: diff)
                 buildEditTree / undoEdit / computeStats / observe / …
                          │
                          ▼
                 packages/cli  (`claude-observatory` — the --json view API + terminal UI)
                 switch(argv[0]) → cmdTree/cmdObserve/cmdStats/… → emitJson(...)
                    │                                              │
          in-process import                              subprocess: `… --json`
                    │                                              │
                    ▼                                              ▼
        packages/vscode                                packages/jetbrains (Kotlin)
        import * as core                               ObservatoryCli.run([...,"--json"])
        core.buildEditTree(...) directly               → Gson parser → hand-mirrored model
        + spawns `stats --json`                        + reads store off disk via StoreReader
```

Two things to internalize about that diagram:

- **VS Code consumes `core` in-process** (`import * as core from '@claude-observatory/core'`) for
  almost everything, and only *spawns* the CLI for the heavy `stats --json` scan. It renders the
  same view-models the CLI emits, computed by the same functions.
- **JetBrains never imports `core`.** It (a) reads the store off disk through Kotlin ports of a few
  `core` modules (`StoreReader`, `SessionResolver`, `ClaudePaths`), and (b) shells out to
  `claude-observatory … --json` for every store *mutation* and every diff-dependent read. The undo
  engine's correctness lives in one place — the TS core — on purpose.

## Repo layout

| Package | What it is |
| --- | --- |
| `packages/core` | Pure-TS engine + view-models (store, surgical undo, edit-tree, observations, stats). Only runtime dep is `diff`. Re-exports from `src/index.ts`. No model calls. |
| `packages/cli` | The `claude-observatory` bin: installer + terminal review UI + the machine-readable `--json` surface both editors build on. `main()` is a `switch` on `argv[0]`. |
| `packages/vscode` | The VS Code extension. Imports `core` in-process; declares all UI in `package.json`'s `contributes`; bundled with esbuild. |
| `packages/jetbrains` | The JetBrains/PyCharm plugin (Kotlin). A front-end over the CLI + store — hand-mirrored models, port-fidelity tests, panels under `ui/`. |

## Add a feature end-to-end

Numbered steps, mapped to the concrete files you touch. The `tree --json` path (see the worked
example below) is the reference implementation of every step.

### 0. `core` — the logic and the shape

- Add/extend a function in the right module under `packages/core/src/` (e.g. `tree.ts`,
  `observe.ts`, `stats.ts`, `undo.ts`, `store.ts`).
- If you add data, extend the relevant `interface` in the same module (e.g. a new field on
  `TreeEdit`, `EditRecord`, or `StatsResult`).
- **Re-export it** from `packages/core/src/index.ts` (`export * from './<mod>'`) so the CLI and the
  VS Code extension can reach it.
- Keep it pure: no `vscode`/IDE imports, no network, no model calls.

### 1. `cli` — expose it over `--json`

- Add or extend a handler in `packages/cli/src/index.ts`: a `cmdX(args)` function that calls your
  `core` function and emits the result with `emitJson(...)`.
- Wire it into the `switch (cmd)` in `main()`, and add a line to `usage()`.
- **`--json` field names are a stable contract** — both editors parse them by name. Renaming a
  field is a breaking change; add, don't rename.
- Reuse a session with `getSessionId(args)` (honours `--session`, env vars, then `resolveSessionId`).

### 2. VS Code — consume `core`, declare UI

- In `packages/vscode/src/extension.ts`, call `core.*` in-process (e.g. `core.buildEditTree`,
  `core.undoEdit`, `core.setStatus`, `core.readLog`, `core.fileMemory`). For a heavy scan, spawn the
  CLI subprocess instead (that's how Stats works).
- If it's tree/observe-shaped data, it flows through the existing providers (`EditsProvider`, the
  Observations/Timeline providers) — extend those rather than adding a parallel path.
- Declare every UI affordance in `packages/vscode/package.json` under `contributes`:
  `commands`, `menus`, `keybindings`, `views`/`viewsContainers`, `configuration`.

### 3. JetBrains — wrapper, model, service, panel, registration

- Add a typed wrapper in `core/ObservatoryCli.kt` (e.g. `treeJson(...)`, `observeJson(...)`) that
  shells out to your new `--json` command.
- If it returns a **new shape**, add a Kotlin `data class` + a Gson parser under `model/`
  (`Models.kt` / `Tree.kt` / `Observe.kt`), **mirroring the TS type field-for-field**.
- If you touched a **store-format** read (log/blob/session/path semantics), update the corresponding
  port in `core/StoreReader.kt` / `SessionResolver.kt` / `ClaudePaths.kt` and keep the
  port-fidelity tests green (see step 4).
- Fetch/cache in a service (`services/ObservatoryService.kt` or a dedicated cache), render in the
  matching panel under `ui/`, and register any new actions / tool windows / status-bar widgets in
  `src/main/resources/META-INF/plugin.xml`.

### 4. Tests — four suites

| Suite | File | When to touch |
| --- | --- | --- |
| core unit | `packages/core/test/core.test.js` | any new/changed `core` function |
| e2e | `test/e2e.sh` | anything that touches the CLI (add a `--json` assertion with `jq`) |
| VS Code smoke | `packages/vscode/test/smoke.test.js` | new command/provider/contribution |
| Kotlin port-fidelity | `packages/jetbrains/src/test/kotlin/.../StoreReaderTest.kt`, `SessionResolverTest.kt` | any change to a mirrored store/session model |

### 5. Version — keep everything in lockstep

Run `node scripts/version.mjs` (checks for drift) before you push. To bump, run
`node scripts/version.mjs <x.y.z>` — it rewrites all four `package.json` versions, the JetBrains
`build.gradle.kts`, and the `@claude-observatory/core` dep-pins together. `version:check` is gated
inside `npm test`, so drift fails CI.

## Worked example: the `tree --json` path

The folder → file → class → edit tree is the canonical shared view. It exists exactly once and is
rendered by both editors:

1. **core** — `buildEditTree(session, { root, filter })` in `packages/core/src/tree.ts` returns an
   `EditTree` (`folders` / `files` → `TreeFolder` → `TreeFile` → `TreeClass` → `TreeEdit` with
   `added`/`removed` deltas). Re-exported from `index.ts`.
2. **cli** — `cmdTree` (`case 'tree'` in `main()`) calls `core.buildEditTree(...)` and
   `emitJson(...)` it. Listed in `usage()` as `tree [--root <d>] [--filter <q>]`.
3. **VS Code** — `EditsProvider.getChildren` calls `core.buildEditTree(session, { root, filter })`
   **directly** (in-process) and walks the returned structure. No local tree logic.
4. **JetBrains** — `ObservatoryService.refreshEditTree()` calls `ObservatoryCli.treeJson(...)`,
   `model/Tree.kt`'s `TreeParser.parse(...)` turns the JSON into the mirrored `EditTree` data
   classes, and `ui/EditsTreePanel.kt` renders it.

Copy this shape for any new structured view.

## Build & test cheat-sheet

| Task | Command |
| --- | --- |
| Build core + CLI | `npm run build` |
| Build the VS Code bundle | `npm run build:vscode` |
| Build the JetBrains plugin | `gradle buildPlugin` (in `packages/jetbrains`) |
  (Gradle itself needs a JVM to launch: on a bare macOS either `brew install gradle` or `JAVA_HOME=/opt/homebrew/opt/openjdk@21 ./gradlew …` — the build then provisions its own JDK 21 toolchain.)
| Unit + smoke tests | `npm test` (runs `version:check` → build → build:vscode → `node --test` on core + smoke) |
| End-to-end CLI + hook | `npm run e2e` (`bash test/e2e.sh`, isolated temp `$HOME`) |

**TypeScript is held at 5.x on purpose.** Your editor needs no setup: IntelliJ's TypeScript service
auto-detects `node_modules/typescript`, and VS Code works with its own bundled copy either way.

The reason for the pin is that TypeScript 7 — the native rewrite — ships only the `tsc` driver on npm.
`node_modules/typescript/lib` holds no `tsserver.js` and no `lib.*.d.ts`, and `require('typescript')`
returns nothing but a version, because the compiler lives in a per-platform binary. Builds and CI pass
on it (they only ever invoke `tsc`), so the breakage is invisible to automation and shows up only as an
editor that has quietly stopped reporting type errors. `.github/dependabot.yml` therefore ignores
TypeScript majors; when the language service ships, take the major deliberately —
`tsconfig.base.json` already uses `node16` resolution, which is all 7.x needs from this repo.
| JetBrains port tests | `gradle test` (in `packages/jetbrains`) |
| Everything | `npm run test:all` |
| Check/bump version | `node scripts/version.mjs [<x.y.z>]` |
| Refresh screenshots/media | `node scripts/render-media.mjs` |

CI (`.github/workflows/{linux,macos,windows}.yml` — one workflow per OS so each carries its own
README badge) runs `npm test` across `node {20,22}` plus e2e on Linux/macOS, while `vscode.yml`
builds the release artifacts and `jetbrains.yml` runs the Gradle suite + `buildPlugin`
(e2e is skipped on Windows), plus a `jetbrains` job that runs `gradle test buildPlugin`.

## Cross-platform parity checklist

Every feature PR must satisfy:

- [ ] Shipped in **VS Code** (`packages/vscode`)
- [ ] Shipped in **JetBrains** (`packages/jetbrains`)
- [ ] Shared logic lives in **core** (`packages/core`) and is exposed via **CLI `--json`** (`packages/cli`)
- [ ] `--json` field names are **identical** across CLI / VS Code / JetBrains (stable contract; add, don't rename)
- [ ] 4 test suites updated as needed: core unit, e2e, VS Code smoke, Kotlin port-fidelity
- [ ] `node scripts/version.mjs` run (versions in lockstep)
- [ ] Screenshots / docs updated (`scripts/render-media.mjs`, README, `docs/`)

## Proposing a feature & the PR flow

- **Propose** with the [Feature request](.github/ISSUE_TEMPLATE/feature_request.yml) issue form —
  it asks which surface it affects, which platforms it must land in, and the expected `--json`
  surface.
- **Open a PR** using the [pull request template](.github/pull_request_template.md) — it carries the
  parity checklist above and a "tested on: CLI / VS Code / JetBrains" line. Fill both in.

By convention, features ship on **all** platforms; a platform-specific exception needs a reason in
the issue/PR.

### Branches & releases: how a change reaches users

```text
feature/fix branch ──PR──▶ dev (pre-release channel) ──PR──▶ main (stable channel, tagged releases)
```

- **Feature and fix PRs target the persistent `dev` branch**, not `main`. Every PR runs the full
  three-OS test matrix.
- **Every push to `dev`** makes the [Dev pre-release workflow](.github/workflows/dev-release.yml)
  re-stamp the version as `<next>-dev.<run#>`, rebuild every artifact, and refresh the ONE rolling
  GitHub release (tag `dev-latest`, marked *prerelease* so `releases/latest` — the stable channel —
  never serves it). Anyone on the **pre-release channel** (`claude-observatory update --channel dev`,
  or the version chip in either editor's Overview) gets it on their next update.
- **When dev has soaked**, a `dev → main` PR promotes everything at once; merging it is followed by a
  version bump if needed and a `vX.Y.Z` tag, which the [Release workflow](.github/workflows/release.yml)
  turns into the official GitHub Release — the stable channel. After a promote, bump `dev`'s
  committed version to the next target (the rolling builds derive `<next>-dev.<n>` from it).
- `main` stays the default branch (installer URLs and docs point at `raw/main`), and history that
  shipped keeps the names it shipped with — the changelog's past entries are immutable.

The user-facing story of the two channels lives on
[the Releases page](https://cell-observatory.github.io/claude-observatory/releases.html).
