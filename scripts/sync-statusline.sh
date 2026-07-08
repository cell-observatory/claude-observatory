#!/usr/bin/env bash
# Refresh the vendored statusline installer from upstream (cell-observatory/claude-statusline).
# Prefers a sibling checkout (../claude-statusline); falls back to GitHub raw. Run from repo root.
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="packages/cli/statusline/install-statusline.sh"
SIBLING="../claude-statusline/install-statusline.sh"
URL="https://raw.githubusercontent.com/cell-observatory/claude-statusline/main/install-statusline.sh"

if [ -f "$SIBLING" ]; then
  SRC_DESC="sibling checkout ($(git -C ../claude-statusline rev-parse --short HEAD 2>/dev/null || echo 'unknown rev'))"
  cp "$SIBLING" "$DEST"
else
  SRC_DESC="$URL"
  curl -fsSL "$URL" -o "$DEST"
fi
chmod +x "$DEST"
bash -n "$DEST"
echo "✓ synced $DEST from $SRC_DESC"
echo "  Update the vendored-commit note in packages/cli/statusline/README.md, then commit."
