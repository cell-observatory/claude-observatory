#!/usr/bin/env bash
# Claude Observatory — one-shot installer from a clean checkout: CLI + the editor extensions for
# whatever editors are on this machine (VS Code family and/or JetBrains) + status line + hooks.
# Everything is built from THIS tree; nothing is downloaded. Safe to re-run. Does NOT commit anything.
#
#   ./install.sh                 # skips the JetBrains plugin unless --jetbrains is given (slow build)
#   ./install.sh --jetbrains     # also build + install the JetBrains plugin (needs JDK 21 + Gradle)
#
# For a release install with no toolchain, use scripts/bootstrap.sh (or install.ps1 on Windows), which
# also takes --channel stable|dev.
set -euo pipefail
cd "$(dirname "$0")"

WITH_JETBRAINS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --jetbrains|--with-jetbrains) WITH_JETBRAINS=1; shift ;;
    -h|--help)
      printf 'usage: ./install.sh [--jetbrains]\n\n  --jetbrains  also build + install the JetBrains plugin (needs JDK 21 + Gradle)\n'
      exit 0 ;;
    *) printf 'unknown option: %s (try --help)\n' "$1" >&2; exit 1 ;;
  esac
done

c_arrow=$'\033[1;36m▸\033[0m'; c_warn=$'\033[1;33m!\033[0m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s %s\n' "$c_arrow" "$1"; }
warn() { printf '%s %s\n' "$c_warn" "$1"; }
step=0; total=$((5 + WITH_JETBRAINS))
head() { step=$((step+1)); printf '\n%s[%d/%d]%s %s\n' "$c_dim" "$step" "$total" "$c_off" "$1"; }

command -v npm >/dev/null 2>&1 || { warn "npm not found — install Node.js 18+ first."; exit 1; }

head "Installing workspace dependencies"
npm install --silent

head "Building core + CLI"
npm run build --silent

head "Linking the claude-observatory CLI onto your PATH"
npm i -g ./packages/cli --silent || {
  warn "Global install failed (permissions?). Try:  sudo npm i -g ./packages/cli"; exit 1; }
CLI="$(command -v claude-observatory || true)"
[ -n "$CLI" ] && say "CLI ready: $CLI" || warn "claude-observatory not on PATH — check your npm global bin dir (npm prefix -g)."

head "Building + packaging the VS Code extension"
npm run build:vscode --silent
( cd packages/vscode && npm run package --silent )
VSIX="$PWD/packages/vscode/claude-observatory.vsix"
say "Packaged: $VSIX"

JB_ZIP=""
if [ "$WITH_JETBRAINS" = "1" ]; then
  head "Building the JetBrains plugin (JDK 21 + Gradle)"
  if bash scripts/install-jetbrains.sh --build-only; then
    JB_ZIP="$(ls -t packages/jetbrains/build/distributions/claude-observatory-jetbrains-*.zip 2>/dev/null | head -1 || true)"
    [ -n "$JB_ZIP" ] && JB_ZIP="$PWD/${JB_ZIP#./}"
  fi
  # Never silently: if the build failed, say so — the install step below will simply skip JetBrains.
  [ -n "$JB_ZIP" ] || warn "The JetBrains plugin did not build — skipping it (the rest still installs)."
fi

head "Installing the extensions into the editors on this machine"
# One call covers the VS Code family AND JetBrains, from the artifacts just built — no network, and it
# installs into editors that do not have the extension yet (which `update` deliberately will not do).
# Run this inside a Remote-SSH / devcontainer terminal and it targets the REMOTE host, which is exactly
# where the extension has to live: it reads that host's ~/.claude.
# No scope flag: in local-artifact mode the CLI acts only on families it was GIVEN an artifact for, and
# names `./install.sh --jetbrains` for the one it skipped. Passing --vscode-only instead meant a
# JetBrains-only machine got "no VS Code-family editor found" plus three lines of VS Code advice, and the
# plugin it actually needed was never mentioned.
INSTALL_ARGS=(--vsix "$VSIX")
[ -n "$JB_ZIP" ] && INSTALL_ARGS+=(--jetbrains-zip "$JB_ZIP")
# Prefer this tree's freshly-built CLI: the global one was installed a moment ago, but if that step
# failed (permissions) we should still be able to install the extensions.
if [ -f "$PWD/packages/cli/dist/index.js" ]; then
  CO=(node "$PWD/packages/cli/dist/index.js")
elif [ -n "$CLI" ]; then
  CO=(claude-observatory)
else
  CO=()
fi
if [ ${#CO[@]} -gt 0 ]; then
  "${CO[@]}" install-extensions "${INSTALL_ARGS[@]}" || {
    warn "Some editor surfaces could not be installed — see the notes above."
    printf "  %sManual fallback: code --install-extension %s%s\n" "$c_dim" "$VSIX" "$c_off"
    printf "  %sNo 'code' on PATH? In VS Code: Cmd/Ctrl-Shift-P → \"Shell Command: Install 'code' command in PATH\".%s\n" "$c_dim" "$c_off"
  }
else
  warn "The CLI is not on PATH, so the extensions were not installed."
  printf "  %sOnce it is: claude-observatory install-extensions --vsix %s%s\n" "$c_dim" "$VSIX" "$c_off"
fi

head "Installing the bundled status line (powers the sidebar Usage bars)"
# The status line is bundled (packages/cli/statusline). Never clobber a user's own statusLine:
# install only when none is configured, or when the existing one is already claude-statusline.
SETTINGS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
EXISTING=$(jq -r '.statusLine.command // ""' "$SETTINGS" 2>/dev/null || echo "")
if [ -z "$EXISTING" ] || printf '%s' "$EXISTING" | grep -q 'statusline\.sh'; then
  if command -v jq >/dev/null 2>&1; then
    bash packages/cli/statusline/install-statusline.sh && say "Status line installed (idempotent — safe to re-run)."
  else
    warn "jq not found — skipped the status line. Install jq, then run: claude-observatory statusline"
  fi
else
  warn "You already have a custom statusLine configured — left it alone."
  printf '  %sTo switch to claude-statusline later:  claude-observatory statusline%s\n' "$c_dim" "$c_off"
fi

cat <<EOF

  ${c_dim}────────────────────────────────────────────────────────────────${c_off}
  ${c_warn} Install the capture hooks with Claude Code CLOSED.
    A running session reverts hook edits made mid-session, so hooks
    added while it's open silently won't take effect.
  ${c_dim}────────────────────────────────────────────────────────────────${c_off}
EOF

if [ -t 0 ]; then
  printf 'Install the capture hooks now? Writes ~/.claude/settings.json (backed up first). [y/N] '
  read -r ans || ans=""
  case "$ans" in
    [yY]*) claude-observatory init ;;
    *)     say "Skipped — run 'claude-observatory init' before launching Claude Code." ;;
  esac
else
  say "Non-interactive shell — run 'claude-observatory init' before launching Claude Code."
fi

printf '\n%s Done. Verify anytime with:  claude-observatory status\n' "$c_arrow"
