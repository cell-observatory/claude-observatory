#!/usr/bin/env bash
# Claude Observatory — one-shot installer for the CLI + VS Code extension from a clean checkout.
# Safe to re-run. Does NOT commit anything. Usage:  ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

c_arrow=$'\033[1;36m▸\033[0m'; c_warn=$'\033[1;33m!\033[0m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s %s\n' "$c_arrow" "$1"; }
warn() { printf '%s %s\n' "$c_warn" "$1"; }
step=0; total=4
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
[ -n "$CLI" ] && say "CLI ready: $CLI" || warn "claude-observatory not on PATH — check your npm global bin dir (npm bin -g)."

head "Building + packaging the VS Code extension"
npm run build:vscode --silent
( cd packages/vscode && npm run package --silent )
VSIX="$PWD/packages/vscode/claude-observatory.vsix"
say "Packaged: $VSIX"
if command -v code >/dev/null 2>&1; then
  # Run inside a Remote-SSH / devcontainer terminal and this installs into the REMOTE extension
  # host — exactly where the extension must live (it reads the remote's ~/.claude). Run it locally
  # and it installs locally. Either way it targets the host whose 'code' is on PATH.
  code --install-extension "$VSIX" --force
  say "Extension installed. Fully quit VS Code (⌘Q) once so its activity-bar icon refreshes."
else
  warn "VS Code 'code' CLI not found — packaged the .vsix but did not install it."
  printf '  %sInstall it yourself:%s\n' "$c_dim" "$c_off"
  printf "    • Local VS Code:              code --install-extension %s\n" "$VSIX"
  printf "    • Remote-SSH / devcontainer:  open the folder on the remote, then run that same command\n"
  printf "      %sinside the remote window's terminal — VS Code injects 'code' into the remote PATH so it\n" "$c_dim"
  printf "      installs on the remote host (where it belongs). Or: Extensions view → '…' → 'Install\n"
  printf "      from VSIX…' and choose 'Install in SSH: <host>' / 'Install in Dev Container'.%s\n" "$c_off"
  printf "    • No 'code' at all:           Cmd/Ctrl-Shift-P → \"Shell Command: Install 'code' command in PATH\".\n"
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
