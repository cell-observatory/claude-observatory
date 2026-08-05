# 🔬 Claude Observatory

[![Linux](https://github.com/cell-observatory/claude-observatory/actions/workflows/linux.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/linux.yml)
[![macOS](https://github.com/cell-observatory/claude-observatory/actions/workflows/macos.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/macos.yml)
[![Windows](https://github.com/cell-observatory/claude-observatory/actions/workflows/windows.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/windows.yml)
[![VS Code](https://github.com/cell-observatory/claude-observatory/actions/workflows/vscode.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/vscode.yml)
[![JetBrains](https://github.com/cell-observatory/claude-observatory/actions/workflows/jetbrains.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/jetbrains.yml)
[![CodeQL](https://github.com/cell-observatory/claude-observatory/actions/workflows/codeql.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/codeql.yml)
[![Pages](https://github.com/cell-observatory/claude-observatory/actions/workflows/pages.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/pages.yml)
[![Release](https://github.com/cell-observatory/claude-observatory/actions/workflows/release.yml/badge.svg)](https://github.com/cell-observatory/claude-observatory/actions/workflows/release.yml)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot&logoColor=white)](https://github.com/cell-observatory/claude-observatory/blob/main/.github/dependabot.yml)
[![Version](https://img.shields.io/badge/version-v0.9.3-blue)](https://github.com/cell-observatory/claude-observatory/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/cell-observatory/claude-observatory/blob/main/LICENSE)



**[🔬 Live showcase →](https://cell-observatory.github.io/claude-observatory/)** &nbsp;·&nbsp; **[Interactive demo →](https://cell-observatory.github.io/claude-observatory/showcase.html#demo)** &nbsp;·&nbsp; [Changelog](CHANGELOG.md)

**Per-edit Keep / Undo for [Claude Code](https://claude.com/claude-code).** Every file change Claude makes
becomes a reviewable entry with its own surgical undo — in your **terminal**, **VS Code**, and **JetBrains
IDEs** — at **zero extra Claude tokens**. The review model resembles Cursor's per-change keep/undo, but it
is standalone, shareable, and git-free. It is built for **established and mission-critical codebases**
rather than throwaway prototypes.

![The observatory in VS Code: the Observatory Traces sidebar (Edits · Diffs · File History), the editor with the inline lens and the compact review bar, the Observatory Dashboards bottom panel (Overview · Stats), the Observatory Timeline panel (Prompts · Observations · Actions) with its session selector and Group tabs toggle, and the microscope scoreboard in the status bar](docs/media/layout.png)

## Why use it?

Claude can change dozens of files in one turn. On established and mission-critical codebases, a giant
diff skimmed at the end is not review. The observatory keeps you **in the loop on every edit**, deciding
one change at a time.

- **Surgical review of AI edits** — accept, undo, or diff each change individually; undo one edit while
  keeping later edits to the same file.
- **Established and mission-critical codebases** — keep a human in the loop when Claude touches code whose
  failure is expensive.
- **Any surface** — the same store is read/written by the CLI, the VS Code sidebar, and the JetBrains
  plugin, so terminal and editor stay in sync (great for remote/SSH/devcontainers where Claude runs on a host).
- **Shareable & auditable** — a git-free content-addressed log of what the agent did and what you decided,
  that you own and can hand to a teammate.

Complements Claude Code's native `/rewind` (whole-turn) with **per-edit** control, and costs **zero extra
tokens** — capture runs in local hooks, entirely outside the model loop.

## Quickstart

**1 — Install** the CLI + editor extensions from the latest [release](https://github.com/cell-observatory/claude-observatory/releases)
(requires Node.js 18+; no build toolchain, no accounts):

```bash
# macOS / Linux (and Windows via Git Bash)
curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash
```

```powershell
# Windows — native, no bash needed
irm https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/install.ps1 | iex
```

Both install the CLI and then the extensions for whatever editors are on the machine — VS Code family
and/or JetBrains. For the rolling [pre-release channel](#keeping-up-to-date) — the choice is remembered,
so later updates follow it — a piped script needs its arguments passed through:

```bash
curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash -s -- --channel dev
```

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/install.ps1))) -Channel dev
```

**2 — Wire the capture hooks** — with **Claude Code closed** (it snapshots hooks at session start):

```bash
claude-observatory init          # add --with-statusline for the 5h/week Usage bars
```

**3 — Launch Claude Code** and start working. Every edit is captured automatically; open the **🔬 Claude
Observatory** view in your editor (or run `claude-observatory list`) to review.

**Try it without Claude** — the same scenario is clickable in the browser on the
**[interactive demo](https://cell-observatory.github.io/claude-observatory/showcase.html#demo)** on the
homepage, nothing to install. In your editor, run **Start Demo Mode** from the VS Code command palette or JetBrains Find Action, use
the buttons at the end of the Overview's nav bar, or click **Try the demo** in an empty panel. It replays a scripted
session through the real pipeline in an isolated `demo-*` session and an `observatory-demo/` folder it
creates in the current directory, then walks you through every panel. In the terminal the same replay is
`claude-observatory demo`, and `claude-observatory demo --tour` prints the tour as prose. Starting it
again resets it; **Exit Demo Mode** (or `claude-observatory demo --clean`) removes every trace.

![claude-observatory demo — the simulator narrates each beat (three prompts, the plan, tasks 1–4, a failed call, a subagent, a second agent on demo/hotfix, a workflow run, the recap) and ends with nine pending edits in observatory-demo/, pointing at demo --tour and demo --clean](docs/media/demo.png)

**Prefer to let Claude install it?** Paste this prompt into a Claude Code session:

```text
Please install Claude Observatory (github.com/cell-observatory/claude-observatory) for me:
run its installer with
  curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash
then run `claude-observatory doctor` and show me the output. Note: the capture hooks only
take effect on a fresh session — after installing, tell me to quit you, run
`claude-observatory init` in a plain terminal, and relaunch you.
```

> Verify anytime with `claude-observatory doctor`. Update by re-running the one-liner or `claude-observatory update`.
> Full install options (Windows, build-from-source, per-editor, teams) are in [Install](#install) below;
> remote/SSH/devcontainer setup is in **[docs/REMOTE.md](docs/REMOTE.md)**.

## `.observatoryignore` — the edits not worth your attention

Lockfiles, `dist/`, snapshots, generated clients. Put them in a `.observatoryignore` and they are
**never recorded**: not captured, so not listed, not counted, and not revertible — there is nothing
to revert. It is `.gitignore` syntax, because that is the syntax you already know.

```gitignore
package-lock.json
dist/*
!dist/manifest.json
**/*.mp4
```

**One mode, and it is the sharp one.** There is no "hide but keep" — anything a rule matches simply
never enters the store. That makes this the one file in the product where a typo costs data rather
than visibility, which is why `ignore --check` names the rule that decided and why the linter below
reports a rule that can never fire. A rule you add later also applies to what is already recorded:
the matching edits are dropped on the next capture, and the count is reported.

Files nest like `.gitignore`: one in any directory governs its subtree, and the nearest wins.
There are **three tiers**, in git's own precedence order — highest first:

| Where | For |
| --- | --- |
| `.observatoryignore`, in any directory | rules everyone on the project should share (committed) |
| `.git/info/observatoryignore` | rules for *this checkout only* — never committed |
| `~/.claude/.observatoryignore` | your own rules, in every repo you work in |

That middle tier is git's `$GIT_DIR/info/exclude`, and it exists for the same reason: without it, the
only way to exclude something in one checkout is to commit that decision into a repo other people
work in.

Because a hand-written pattern can misfire, one verb explains any single path:

```console
$ claude-observatory ignore --check package-lock.json
ignored package-lock.json
  by  package-lock.json   (.observatoryignore:1)
  edits to it are never recorded — there is nothing to undo later
```

**And it tells you when a rule can never fire**, which `git check-ignore` does not. Write the trap —
`dist/` and then `!dist/manifest.json`, rather than the `dist/*` above — and the verb says so
unprompted, before you go looking:

```console
$ claude-observatory ignore
…
1 rule(s) can never match:
  !dist/manifest.json   (.observatoryignore:3)
    "dist/" on line 2 excludes dist/, and nothing beneath an
    excluded directory is ever consulted. Write "dist/*" there instead, then negate.
```

That is gitignore's most famous trap — the manual's own words are *"it is not possible to
re-include a file if a parent directory of that file is excluded"*. This follows git rather than
quietly diverging from it — git tried twice to relax the rule and reverted both times, for reasons
(directory pruning) that do not apply here but whose *other* justification, keeping one top-level
file consistent with nested ones, does. So the behaviour matches and the tool explains it instead.

For scripting, the verb takes git's flags and answers the way `git check-ignore` does — many paths or
`--stdin`, `-v` for the machine format `<source>:<line>:<pattern><TAB><path>`, `-n` to report
non-matching paths too, `-z` for NUL separators, `-q` for exit status only, and **exit 0 when a path
is ignored, 1 when none are**. Its `-v` output is verified byte-for-byte against real `git
check-ignore -v -n` in the test suite, so anything that already parses git parses this.

## Install

The one-liner in [Quickstart](#quickstart) covers most people. The details:

### Keeping up to date

`claude-observatory update` refreshes **everything installed** — the CLI, the VS Code extension, and
the JetBrains plugin — from the release channel you follow (add `--check` to preview without
installing); re-running the [one-liner](#quickstart) does the same. The CLI also nudges you once a
day when a newer release exists (opt out with `CLAUDE_OBSERVATORY_NO_UPDATE_CHECK=1`).

There are **two release channels** (full story: [the Releases page](https://cell-observatory.github.io/claude-observatory/releases.html)):

- **Stable** (the default) — tagged releases, cut from `main`.
- **Pre-release** — a rolling build of the `dev` branch, republished on every push, versioned
  `<next>-dev.<n>`. Newest features, less soak time.

Switch from the **version chip** at the right edge of the Overview's toolbar in either editor
(it shows the running version; its menu offers **Update now** and the channel switch), or from the
terminal: `claude-observatory update --channel dev` (back with `--channel stable` — switching
installs that channel's newest immediately, downgrades included, and updates follow it from then
on). Beyond that, each surface can keep **itself** current:

- **CLI** — `claude-observatory update`, or the daily nudge above; `claude-observatory version --check`
  shows your installed version next to the latest release at any time.
- **VS Code** — a background check (once a day) offers a one-click **Update now**; or run
  **“Claude Observatory: Check for updates”** from the Command Palette. Downloads are sha256-verified.
- **JetBrains** — add the self-hosted plugin repository **once** and the IDE auto-updates the plugin
  like any Marketplace plugin (see [the JetBrains guide](packages/jetbrains/README.md#auto-updates)):
  **Settings → Plugins → ⚙ → Manage Plugin Repositories → +**, then paste
  `https://github.com/cell-observatory/claude-observatory/releases/latest/download/updatePlugins.xml`
  (pre-release channel: the same path under `releases/download/dev-latest/` instead of
  `releases/latest/download/`).

**Platforms:** macOS and Linux work as-is. On **Windows**, install with `install.ps1` (native PowerShell —
no bash, no WSL); the CLI, capture hooks, editor extensions and `update` all run natively, and npm's
`.cmd` shims are handled through one launcher (`packages/core/src/spawn.ts`). Piping the bash one-liner
into PowerShell is the one thing to avoid: with WSL installed it silently installs everything *inside*
WSL, where Claude Code on the Windows side cannot see it. The **bundled status line is the exception** —
it is a bash script that parses its input with `jq` (and uses `python3` for the token estimates), so the
Usage bars need Git Bash + `jq` (`winget install jqlang.jq`) on PATH; everything else works without them. Windows paths are canonicalized
for drive-letter case everywhere (capture, lookups, both editors); a store written by v0.8.9 or earlier
may hold phantom `+N −0` / `+0 −N` edit pairs from that bug — they heal on read, and
`claude-observatory clean --phantoms` removes them for good (#43).

**Build from source (contributors):**

```bash
./install.sh                 # deps → build → CLI on PATH → extensions → status line → offer `init`
./install.sh --jetbrains     # also build + install the JetBrains plugin (needs JDK 21 + Gradle)
```

Or step by step:

```bash
npm install                  # workspace deps
npm run build                # build core + cli
npm i -g ./packages/cli      # put `claude-observatory` on PATH  (or: npm link in packages/cli)
claude-observatory init --with-statusline   # capture hooks + the bundled status line (backs settings up first)
```

The [claude-statusline](https://github.com/cell-observatory/claude-statusline) status line is **bundled**
— `claude-observatory statusline` installs/refreshes it with no network (it powers the Usage bars; it's a
bash script and needs `jq` on the PATH, on every platform). Refresh the vendored copy with
`scripts/sync-statusline.sh`.

> **Important — install hooks _before_ launching Claude Code.** Claude Code snapshots your hooks at session
> start, so hooks added to a **running** session get reverted. Run `claude-observatory init` with Claude
> Code closed, then launch it. Verify with `claude-observatory status`.

**VS Code extension** (optional):

```bash
npm run build:vscode
cd packages/vscode && npm run package     # -> claude-observatory.vsix
code --install-extension claude-observatory.vsix
```

Fully quit VS Code (⌘Q) once after installing so the activity-bar icon refreshes. The extension then
keeps itself current — a daily background check offers a one-click **Update now** (see [Keeping up to
date](#keeping-up-to-date)).

**JetBrains / PyCharm plugin** (optional; needs JDK 21 + Gradle to build — or grab the `.zip` from a
[Release](https://github.com/cell-observatory/claude-observatory/releases)):

```bash
./scripts/install-jetbrains.sh   # build + install into your local JetBrains IDEs, then restart the IDE
```

Or manually: **Settings → Plugins → ⚙ → Install Plugin from Disk…** with the built/downloaded zip. Works in
every JetBrains IDE (platform-only APIs — PyCharm CE/Pro, IntelliJ, WebStorm, …). For hands-off updates
afterward, add the [plugin repository](packages/jetbrains/README.md#auto-updates) once. Details:
[packages/jetbrains/README.md](packages/jetbrains/README.md).

**Teams:** run `claude-observatory init --project` to write the hook into the repo's `./.claude/settings.json`
(checked in). Teammates then only need `claude-observatory` on their PATH.

### Remote development (SSH & devcontainers)

The extension runs on the **remote host** (where Claude, the
transcripts, and the store live). Full setup — Remote-SSH, JetBrains Gateway/Toolbox, the devcontainer
template, and relocating `CLAUDE_CONFIG_DIR` — is in **[docs/REMOTE.md](docs/REMOTE.md)**.

## How it works

| Piece | What it does |
| --- | --- |
| **Capture hook** (`capture`) | PreToolUse snapshots the file before an edit, PostToolUse commits before + after. Zero-dep, always `exit 0`, never writes to the model context. Captures `Edit` / `Write` / `MultiEdit` / `NotebookEdit` — and files changed by `Bash` (set `CLAUDE_OBSERVATORY_NO_BASH=1` to opt out). |
| **Store** | `~/.claude/claude-observatory/<session_id>/` — `log.jsonl` (append-only) + content-addressed `blobs/`. No network. |
| **Session resolution** | The active session is the newest transcript **that holds a real conversation**. Local commands (`/effort`, `/model`), interrupted commands, and bridge records write command-only transcript stubs; those never displace the session under review (0.8.4). When the current session has no edits yet, the panels say so honestly and offer a one-click switch to the previous session's work. |
| **Undo engine** | Position-anchored 3-way line merge (base = the file right after the edit; sides = current on-disk content and the pre-edit content). Later edits to other lines survive; a genuine overlap → clear conflict + per-file restore. Anchoring on line positions (not fuzzy text search) keeps it safe against duplicated content. |
| **Observations** | Correlates each edit with Claude's real reasoning + to-dos parsed from the session transcript — zero token. |
| **Front-ends** | The CLI (in-process), the VS Code sidebar (in-process `core`), and the JetBrains plugin (over the CLI + store) — all on the same store + engine. |

Architecture deep-dive: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

## Packages

One data layer, one backend, three front ends:

- `packages/core` — capture + store + surgical undo + transcript observations + shared installer (pure TS;
  only runtime dep is `diff`). No model calls, and no rendering.
- `packages/cli` — the `claude-observatory` bin: installer, every verb, and the machine-readable
  `--json` surface **all three front ends read**. Bundles the [claude-statusline](https://github.com/cell-observatory/claude-statusline) installer.

…and the three front ends over it:

- `packages/tui` — the terminal app: the frame, layout, glyph sets, key decoder and options screen,
  plus the runtime the bare `claude-observatory` command opens.
- `packages/vscode` — the VS Code extension (bundled with esbuild).
- `packages/jetbrains` — the PyCharm/JetBrains plugin (Kotlin — see its
  [README](packages/jetbrains/README.md)).

## Contributing

New features **ship in every front end** — TUI, VS Code, and JetBrains — with shared logic in core/CLI.
Start here:

- **[CONTRIBUTING.md](CONTRIBUTING.md)** — the practical "add a feature across all platforms" guide, with
  the file-by-file steps, the build/test cheat-sheet, and the cross-platform parity checklist.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how the pieces fit: core → CLI `--json` → both editors.
- **Have an idea?** Open a [feature request](https://github.com/cell-observatory/claude-observatory/issues/new?template=feature_request.yml).

```bash
npm test          # core unit tests + the extension smoke test
npm run e2e       # end-to-end CLI + capture-hook integration harness
npm run release   # build shareable artifacts into ./release (CLI .tgz + .vsix + JetBrains .zip)
```

To cut a release: `git tag v0.5.0 && git push origin v0.5.0` — CI re-runs the suites (npm + e2e + Gradle)
and attaches the CLI `.tgz`, the VS Code `.vsix`, and the JetBrains `.zip` to a
[GitHub Release](https://github.com/cell-observatory/claude-observatory/releases). See
[docs/DEMO.md](docs/DEMO.md) for a feature-by-feature walkthrough, or the
**[visual showcase](https://cell-observatory.github.io/claude-observatory/showcase.html)**.

## Notes

- Binary and >5 MB files are skipped. **Bash-driven file changes are tracked too** — a Bash command
  snapshots the candidate tree under its cwd before/after and records one edit per changed file (bounded:
  skips vendor/build dirs, caps the file count). Opt out with `CLAUDE_OBSERVATORY_NO_BASH=1`.
- New-file creates are captured (undo deletes the file). No-op edits are not logged.
- **Multi-agent is git-free and path-only.** Agents running in separate git **worktrees** of one repo are
  unified into a single fleet by reading the `.git` pointer files (never shelling out to the git binary);
  the cross-agent views (the Overview's Fleet tab, siblings, task log) are **path-only** — filenames, never contents — so
  nothing leaks between agents. Attribution stays **honest**: an edit belongs to a task only when it was
  captured while that task was in progress, and an edit outside every in-progress window stays unassigned
  rather than being swept into a neighboring task. `task-keep`, `task-undo`, and `task-clear` act on that
  strict span and on nothing else.
- Everything is local: no network calls, no telemetry, **zero extra Claude tokens** — every 0.8.0 view is
  mined from the transcript + the local store. Deep analysis only runs the `claude` CLI you already have,
  and only when you ask.
