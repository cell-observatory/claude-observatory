# Changelog

All notable changes to Claude Observatory are recorded here, following
[Keep a Changelog](https://keepachangelog.com) and [Semantic Versioning](https://semver.org).
Per-tag release artifacts and auto-generated notes are on the
[Releases page](https://github.com/cell-observatory/claude-observatory/releases).

## [0.4.2] — 2026-07-10

A correctness, security, and cross-editor-parity release from a full-project audit. No breaking
changes — the `--json` contract is additive only, and the on-disk store format is unchanged.

### Fixed — data integrity & correctness (core engine)

- **Undo no longer corrupts non-UTF-8 files.** The restore engine now writes the exact stored bytes
  on every whole-file path and compares state by sha256 instead of round-tripping through UTF-8
  (which silently rewrote latin-1 / invalid-UTF-8 files as `U+FFFD`, even on the clean-revert path).
- **The append-only store is now actually race-safe.** `clearResolved`/GC run under a per-session
  advisory lock (stale-broken so it can't wedge capture), and GC treats in-flight staging +
  `__bash__` manifest blobs as referenced — closing a window where a concurrent capture record could
  be dropped or point at a GC'd blob.
- **Stats no longer over-count tokens/messages ~2.3–2.9×.** Assistant turns are deduplicated by
  `message.id` (current Claude Code emits one JSONL line per content block with identical usage).
- **"Why Claude made this edit" is attributed correctly** — a `Bash` record (e.g. `prettier --write`)
  no longer shifts every later same-file edit's reasoning to the wrong entry.
- Blob writes are atomic (tmp + rename); the stats cache is invalidated on a timezone change; the
  "current session" stats card is internally consistent; JetBrains `listSessions` orders by log mtime
  (matching the CLI) instead of max edit-ts.

### Added — features & parity (CLI + VS Code + JetBrains)

- **CLI:** `insights` (human Observations view), `timeline` (chronological feed), and a real
  `uninstall --all` (reverts the bundled status line only if it's ours; `--purge-store` to delete
  captured edits).
- **Both editors:** a "Next steps" suggestions group, and store maintenance (reclaim disk / drop
  session) — previously CLI-only.
- **JetBrains:** an "Install capture hooks" action, and Project-view badges (`●N`) on files with
  pending edits (parity with the VS Code file decorations).
- **Dropped captures are surfaced** — files too large/binary, or a Bash tree over the cap, record a
  `skip` marker so `status` shows "not captured: N change(s)" instead of silently doing nothing.

### Changed

- **Inline review shows only the _latest_ edit per line.** Stacking a keep/undo menu per edit on a
  shared line was noisy and ambiguous; older same-line edits now live in the Timeline (undoing the
  latest surgically reveals the previous state). Consistent across VS Code and JetBrains.
- **JetBrains performance:** memoized session resolution, blob reads moved off the EDT, faster macOS
  store watching (~2 s vs ~10 s), a StatsPanel timer/listener leak fixed, and a `locate` subprocess
  hang/deadlock guarded with a timeout.
- **Onboarding accuracy:** correct `npm prefix -g` guidance (was the removed `npm bin -g`), a
  working `status` hook-health check for the portable hook, and honest Bash-capture docs.

### Security

- Store directories are created `0700` and blobs/log `0600`; the Bash full-tree walk skips
  secret-bearing names (`.env`, `*.pem`, `id_rsa`, `.npmrc`, …) so it never vacuums them into the store.
- Fixed a ReDoS in the observations "next steps" parsing (O(n²) on transcript-mined text).
- Session ids are validated before any store path, closing `clean --drop ../…` arbitrary deletion.
- Self-update verifies the release asset's sha256 before `npm i -g`, and downloads to a private
  `0700` temp dir.

### Build / CI

- `version:set` now updates `package-lock.json` (and `version:check` verifies it), so a bump can't
  redden `npm ci`. Release + CI use the pinned Gradle wrapper (`./gradlew`). Added Dependabot and a
  guarded `npm publish --provenance` release step.

### Tests

- A regression test ships with every fix, plus a `--json` contract golden test (rename-guard for both
  editors) and JetBrains port-fidelity tests (`TreeParser`/`ObserveParser` + a discriminating
  `listSessions` test).

[0.4.2]: https://github.com/cell-observatory/claude-observatory/releases/tag/v0.4.2
