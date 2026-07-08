# Bundled claude-statusline

`install-statusline.sh` is a **vendored copy** of
[cell-observatory/claude-statusline](https://github.com/cell-observatory/claude-statusline)
(self-contained installer; it embeds the whole status line). It ships inside the
`claude-observatory` npm package so `claude-observatory statusline` can install the status line
with no network and no second repo — the Usage bars in the VS Code / JetBrains front-ends read
the `statusline-last.json` it writes.

- Upstream stays the source of truth for statusline-only users.
- Refresh this copy with `scripts/sync-statusline.sh` (run from the repo root) and commit the diff.
- Vendored from upstream commit: `93deebf` (Support ISO-8601 rate-limit resets).
