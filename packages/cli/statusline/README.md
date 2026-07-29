# Bundled claude-statusline

`install-statusline.sh` is a **vendored copy** of
[cell-observatory/claude-statusline](https://github.com/cell-observatory/claude-statusline)
(self-contained installer; it embeds the whole status line). It ships inside the
`claude-observatory` npm package so `claude-observatory statusline` can install the status line
with no network and no second repo — the Usage bars in the VS Code / JetBrains front-ends read
the `statusline-last.json` it writes.

- Upstream stays the source of truth for statusline-only users.
- Refresh this copy with `scripts/sync-statusline.sh` (run from the repo root) and commit the diff.
- Vendored from upstream commit: `3ff1e1b` / v0.4.0-to-be (branch `0.4.0`, PR #2 — three rows:
  clock/branch/path, then the session title + ↑↓↺ token counters fed by `claude-observatory usage
  --json` with the ◷ duration at the end, then the usage bars; on Enterprise/API plans the `5h`/`wk`
  segments show measured token totals and persist `five_meas`/`week_meas` for the Usage panels).
  Re-run `scripts/sync-statusline.sh` after upstream merges/tags if the copy drifts.