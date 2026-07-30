#!/usr/bin/env bash
# Claude Observatory — one-command install / update. No build toolchain, no registry account.
# Downloads a GitHub Release and installs the CLI + editor extensions + status line + hooks.
#
#   curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-observatory/main/scripts/bootstrap.sh | bash
#
# Pre-release channel (rolling build of the dev branch — newest features, less soak):
#   curl -fsSL .../scripts/bootstrap.sh | bash -s -- --channel dev
#
# Windows: this is bash. Run it from Git Bash, or use install.ps1 (PowerShell, no bash needed).
# Safe to re-run — re-running is how you update. Does NOT commit anything.
set -euo pipefail

REPO="cell-observatory/claude-observatory"
c_arrow=$'\033[1;36m▸\033[0m'; c_warn=$'\033[1;33m!\033[0m'; c_ok=$'\033[1;32m✓\033[0m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s %s\n' "$c_arrow" "$1"; }
warn() { printf '%s %s\n' "$c_warn" "$1"; }
ok()   { printf '%s %s\n' "$c_ok" "$1"; }

CHANNEL="stable"
while [ $# -gt 0 ]; do
  case "$1" in
    # `shift 2` with nothing after --channel fails under `set -e` and the script exits SILENTLY, so
    # require the value explicitly and say what is missing.
    --channel)
      [ $# -ge 2 ] || { warn "--channel needs a value: stable or dev"; exit 1; }
      CHANNEL="$2"; shift 2 ;;
    --channel=*) CHANNEL="${1#*=}"; shift ;;
    --dev|--pre|--prerelease) CHANNEL="dev"; shift ;;
    -h|--help)
      printf 'usage: bootstrap.sh [--channel stable|dev]\n\n  stable  tagged releases (default)\n  dev     rolling pre-release built from the dev branch\n'
      exit 0 ;;
    *) warn "unknown option: $1  (try --help)"; exit 1 ;;
  esac
done
case "$CHANNEL" in
  stable|main|release) CHANNEL="stable" ;;
  dev|pre|prerelease|pre-release) CHANNEL="dev" ;;
  *) warn "unknown channel \"$CHANNEL\" — use stable or dev"; exit 1 ;;
esac

command -v npm  >/dev/null 2>&1 || { warn "npm not found — install Node.js 18+ first."; exit 1; }
command -v curl >/dev/null 2>&1 || { warn "curl not found — install curl first."; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# The CLI tarball is the ONE thing this script has to fetch itself — it is what provides
# `install-extensions`, which then does every editor from here on (detection, download, sha256
# verification, Windows .cmd shims). `releases/latest` is the stable channel; the rolling pre-release
# keeps a fixed `dev-latest` tag so its URLs never move.
if [ "$CHANNEL" = "dev" ]; then
  say "Finding the newest pre-release…"
  REL_URL="https://api.github.com/repos/$REPO/releases/tags/dev-latest"
else
  say "Finding the latest release…"
  REL_URL="https://api.github.com/repos/$REPO/releases/latest"
fi
JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$REL_URL")" || {
  warn "Could not reach the release API for $REPO (channel: $CHANNEL)."; exit 1; }
# Parse without jq (may be absent): the tag, and the CLI tarball's download URL.
TAG="$(printf '%s\n' "$JSON" | grep -o '"tag_name":[^,]*' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$TAG" ] || { warn "Could not find a $CHANNEL release for $REPO."; exit 1; }
CLI_URL="$(printf '%s\n' "$JSON" | grep -o '"browser_download_url": *"[^"]*"' | sed 's/.*"\(https[^"]*\)"/\1/' | grep -E '\.tgz$' | head -1 || true)"
say "Release: $TAG  (channel: $CHANNEL)"

# --- CLI (required) ---
[ -n "$CLI_URL" ] || { warn "release $TAG has no CLI tarball."; exit 1; }
say "Installing the claude-observatory CLI…"
curl -fsSL "$CLI_URL" -o "$TMP/cli.tgz"
npm i -g "$TMP/cli.tgz" --silent || warn "Global install failed (permissions?). Try: sudo npm i -g $TMP/cli.tgz — continuing so the other components still install."
CLI="$(command -v claude-observatory || true)"
[ -n "$CLI" ] && ok "CLI ready: $CLI" || warn "claude-observatory not on PATH — check your npm global bin dir (npm prefix -g)."

# --- editor extensions (whatever is on this machine) ---
# One call for the VS Code family AND JetBrains. This used to be ~30 lines of bash that curled the
# .vsix with no integrity check and, for JetBrains, only downloaded the zip and printed three lines of
# "Settings → Plugins → Install Plugin from Disk" — so the one-liner never actually installed the
# JetBrains plugin. The CLI detects both families, verifies each asset's sha256, and handles Windows.
if [ -n "$CLI" ]; then
  say "Installing the editor extensions…"
  claude-observatory install-extensions --channel "$CHANNEL" || warn "Some editor surfaces could not be installed — see the notes above."
else
  warn "Skipped the editor extensions: the CLI is not on PATH. Once it is, run: claude-observatory install-extensions"
fi

# --- status line (usage bars) ---
if command -v jq >/dev/null 2>&1 && command -v bash >/dev/null 2>&1; then
  say "Installing the bundled status line…"
  claude-observatory statusline >/dev/null 2>&1 && ok "Status line installed." || warn "Status line install skipped."
else
  warn "jq not found — skipped the status line (it is a bash script and parses its input with jq)."
  printf '  %sDebian/Ubuntu: sudo apt-get install -y jq   ·   macOS: brew install jq   ·   Windows: winget install jqlang.jq%s\n' "$c_dim" "$c_off"
  printf '  %sThen: claude-observatory statusline%s\n' "$c_dim" "$c_off"
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
