#!/usr/bin/env bash
# Provision Claude Observatory + claude-statusline INSIDE a devcontainer.
# Referenced by devcontainer.json's postCreateCommand. Idempotent — safe to re-run on rebuild.
#
# Installs, under $CLAUDE_CONFIG_DIR (a persistent volume, per devcontainer.json):
#   • jq + a UTF-8 locale         (required by the status line)
#   • the claude-observatory CLI  (capture hook + stats subprocess)
#   • the claude-statusline        (writes statusline-last.json → the sidebar's Usage bars)
#   • the PreToolUse/PostToolUse capture hooks in settings.json
# The VS Code extension itself is a private .vsix — installed separately (see the note at the end).
set -euo pipefail

CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
say() { printf '▸ %s\n' "$1"; }

say "Claude config dir: $CFG"
# A freshly-created named volume is root-owned; take ownership so the hook/CLI/statusline can write.
if [ ! -w "$CFG" ] 2>/dev/null || [ ! -d "$CFG" ]; then
  sudo mkdir -p "$CFG" && sudo chown -R "$(id -u):$(id -g)" "$CFG"
fi
mkdir -p "$CFG"

# 1) jq (required by the status line) + a UTF-8 locale (keeps the bar glyphs intact).
if ! command -v jq >/dev/null 2>&1; then
  say "Installing jq + locales"
  sudo apt-get update -qq && sudo apt-get install -y -qq jq locales
fi

# 2) The claude-observatory CLI. Prefer a repo checkout mounted into the container (set
#    OBSERVATORY_REPO, or mount it at one of the common paths below); otherwise fall back to npm.
if command -v claude-observatory >/dev/null 2>&1; then
  say "CLI already present: $(command -v claude-observatory)"
else
  REPO="${OBSERVATORY_REPO:-}"
  for d in "$REPO" /workspaces/claude-observatory /workspace/claude-observatory; do
    [ -n "$d" ] && [ -f "$d/packages/cli/package.json" ] && REPO="$d" && break
  done
  if [ -n "$REPO" ] && [ -f "$REPO/packages/cli/package.json" ]; then
    say "Installing CLI from checkout: $REPO"
    ( cd "$REPO" && npm install --silent && npm run build --silent && npm i -g ./packages/cli --silent )
  else
    say "Installing CLI from the latest GitHub Release"
    TGZ_URL="$(curl -fsSL -H 'Accept: application/vnd.github+json' \
      https://api.github.com/repos/cell-observatory/claude-observatory/releases/latest \
      | grep -o '"browser_download_url": *"[^"]*\.tgz"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
    if [ -n "$TGZ_URL" ]; then
      curl -fsSL "$TGZ_URL" -o /tmp/claude-observatory.tgz && npm i -g /tmp/claude-observatory.tgz --silent \
        || say "  CLI install failed — mount the repo and set OBSERVATORY_REPO."
    else
      say "  No release tarball found — mount the repo and set OBSERVATORY_REPO."
    fi
  fi
fi

# 3) The status line (writes statusline-last.json that the sidebar's Usage bars read). It is
#    BUNDLED with the CLI — no network needed; honors CLAUDE_CONFIG_DIR so it lands in the same
#    persistent dir the extension reads. Curl fallback only if the CLI install failed above.
say "Installing the bundled claude-statusline"
if command -v claude-observatory >/dev/null 2>&1; then
  claude-observatory statusline || say "  statusline install failed — is jq installed?"
else
  curl -fsSL https://raw.githubusercontent.com/cell-observatory/claude-statusline/main/install-statusline.sh | bash \
    || say "  statusline install skipped (no CLI, no network) — run 'claude-observatory statusline' later."
fi

# 4) Capture hooks into $CFG/settings.json. Safe here: postCreate runs with no live Claude session,
#    and Claude Code reverts hooks edited mid-session. init honors CLAUDE_CONFIG_DIR.
if command -v claude-observatory >/dev/null 2>&1; then
  say "Installing capture hooks"
  claude-observatory init || say "  'claude-observatory init' failed — run it once the CLI is ready."
fi

cat <<EOF

  ────────────────────────────────────────────────────────────────
  ▸ CLI + statusline + hooks provisioned under: $CFG  (persistent volume)
  ▸ Install the VS Code extension INTO this container (it isn't on the Marketplace):
      1. In the claude-observatory repo run 'npm run release' to build claude-observatory.vsix
      2. Make the .vsix reachable inside the container (mount its folder, or copy it in)
      3. In THIS container's terminal:  code --install-extension /path/to/claude-observatory.vsix
     — or use the Extensions view → '…' → 'Install from VSIX…' → 'Install in Dev Container'.
  ────────────────────────────────────────────────────────────────
EOF
