#!/usr/bin/env bash
# Claude Observatory — one-command install / update. No build toolchain, no registry account.
# Downloads the latest GitHub Release and installs the CLI + editor extensions + status line + hooks.
#
#   curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash
#
# Safe to re-run — re-running is how you update. Does NOT commit anything.
set -euo pipefail

REPO="cell-observatory/claude-observatory"
c_arrow=$'\033[1;36m▸\033[0m'; c_warn=$'\033[1;33m!\033[0m'; c_ok=$'\033[1;32m✓\033[0m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s %s\n' "$c_arrow" "$1"; }
warn() { printf '%s %s\n' "$c_warn" "$1"; }
ok()   { printf '%s %s\n' "$c_ok" "$1"; }

command -v npm  >/dev/null 2>&1 || { warn "npm not found — install Node.js 18+ first."; exit 1; }
command -v curl >/dev/null 2>&1 || { warn "curl not found — install curl first."; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

say "Finding the latest release…"
JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/releases/latest")"
# Parse without jq (may be absent): pull the tag and asset download URLs out of the JSON.
TAG="$(printf '%s\n' "$JSON" | grep -o '"tag_name":[^,]*' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TAG" ] || { warn "Could not find a published release for $REPO."; exit 1; }
urls() { printf '%s\n' "$JSON" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/'; }
say "Latest release: $TAG"

CLI_URL="$(urls | grep -E '\.tgz$'            | head -1 || true)"
VSIX_URL="$(urls | grep -E '\.vsix$'          | head -1 || true)"
ZIP_URL="$(urls | grep -E 'jetbrains.*\.zip$' | head -1 || true)"

# --- CLI (required) ---
[ -n "$CLI_URL" ] || { warn "release $TAG has no CLI tarball."; exit 1; }
say "Installing the claude-observatory CLI…"
curl -fsSL "$CLI_URL" -o "$TMP/cli.tgz"
npm i -g "$TMP/cli.tgz" --silent || { warn "Global install failed (permissions?). Try: sudo npm i -g $TMP/cli.tgz"; exit 1; }
CLI="$(command -v claude-observatory || true)"
[ -n "$CLI" ] && ok "CLI ready: $CLI" || warn "claude-observatory not on PATH — check your npm global bin dir (npm prefix -g)."

# --- VS Code extension (if the 'code' CLI is present) ---
if [ -n "$VSIX_URL" ] && command -v code >/dev/null 2>&1; then
  say "Installing the VS Code extension…"
  curl -fsSL "$VSIX_URL" -o "$TMP/ext.vsix"
  code --install-extension "$TMP/ext.vsix" --force \
    && ok "VS Code extension installed — fully quit VS Code (⌘Q) once so the activity-bar icon refreshes."
elif [ -n "$VSIX_URL" ]; then
  warn "VS Code 'code' CLI not found — skipped the extension. Later: download the .vsix from the $TAG release and 'code --install-extension' it."
fi

# --- JetBrains plugin (download; install is one step in the IDE) ---
if [ -n "$ZIP_URL" ]; then
  DEST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/claude-observatory-jetbrains.zip"
  mkdir -p "$(dirname "$DEST")"
  curl -fsSL "$ZIP_URL" -o "$DEST"
  say "JetBrains plugin downloaded: $DEST"
  printf '  %sInstall in any JetBrains IDE: Settings → Plugins → ⚙ → Install Plugin from Disk → pick that file → restart.%s\n' "$c_dim" "$c_off"
  printf '  %sThen auto-update future releases (one time): Settings → Plugins → ⚙ → Manage Plugin Repositories → +%s\n' "$c_dim" "$c_off"
  printf '  %s→ paste https://github.com/%s/releases/latest/download/updatePlugins.xml%s\n' "$c_dim" "$REPO" "$c_off"
fi

# --- status line (usage bars) ---
if command -v jq >/dev/null 2>&1; then
  say "Installing the bundled status line…"
  claude-observatory statusline >/dev/null 2>&1 && ok "Status line installed." || warn "Status line install skipped."
else
  warn "jq not found — skipped the status line. Install jq, then: claude-observatory statusline"
fi

# --- capture hooks (with the closed-Claude guard) ---
printf '\n%s Install the capture hooks with Claude Code CLOSED — a running session reverts mid-session hook edits.\n' "$c_warn"
if [ -t 0 ]; then
  printf 'Install the capture hooks now? Writes ~/.claude/settings.json (backed up first). [y/N] '
  read -r ans || ans=""
  case "$ans" in [yY]*) claude-observatory init ;; *) say "Skipped — run 'claude-observatory init' before launching Claude Code." ;; esac
else
  say "Non-interactive shell — run 'claude-observatory init' before launching Claude Code."
fi

printf '\n'
say "Health check:"
claude-observatory doctor || true

ok "Done. Update anytime by re-running this script, or with: claude-observatory update"
