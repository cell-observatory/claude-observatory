#!/usr/bin/env bash
# Build + install the JetBrains plugin into your real IDE in one shot — no Settings→Plugins dance.
# Usage:  ./scripts/install-jetbrains.sh [--no-build]
# Then fully restart the IDE (⌘Q → reopen); a plugin's classes can't hot-swap in a running JVM.
set -euo pipefail
cd "$(dirname "$0")/../packages/jetbrains"

if [ "${1:-}" != "--no-build" ]; then
  echo "▸ Building the plugin…"
  if command -v gradle >/dev/null 2>&1; then GRADLE=gradle; else GRADLE=./gradlew; fi
  JAVA_HOME="${JAVA_HOME:-$([ -d /opt/homebrew/opt/openjdk@21 ] && echo /opt/homebrew/opt/openjdk@21 || echo "")}" \
    $GRADLE buildPlugin --console=plain -q
fi

ZIP=$(ls -t build/distributions/claude-observatory-jetbrains-*.zip 2>/dev/null | head -1)
[ -n "$ZIP" ] || { echo "no plugin zip found — build failed?"; exit 1; }

# Plugin dirs across platforms: macOS keeps them under <config>/plugins; desktop Linux puts them
# straight in ~/.local/share/JetBrains/<Product>; JetBrains Remote Development (Gateway/Toolbox)
# backends use per-project ~/.config/JetBrains/RemoteDev-*/<project>/plugins. Covering all three
# means this script also works when run ON an SSH host that serves remote development.
shopt -s nullglob
PLUGIN_DIRS=()
for DIR in "$HOME/Library/Application Support/JetBrains/"{PyCharm,IntelliJIdea,WebStorm,GoLand}*; do
  [ -d "$DIR/plugins" ] && PLUGIN_DIRS+=("$DIR/plugins")
done
for DIR in "$HOME/.local/share/JetBrains/"{PyCharm,IntelliJIdea,WebStorm,GoLand}*; do
  [ -d "$DIR" ] && PLUGIN_DIRS+=("$DIR")
done
for DIR in "$HOME/.config/JetBrains/RemoteDev-"*/*; do
  [ -d "$DIR/plugins" ] && PLUGIN_DIRS+=("$DIR/plugins")
done
# Windows via Git Bash: plugins live under %APPDATA%\JetBrains\<Product><Version>\plugins.
if [ -n "${APPDATA:-}" ]; then
  for DIR in "${APPDATA//\\//}/JetBrains/"{PyCharm,IntelliJIdea,WebStorm,GoLand}*; do
    [ -d "$DIR/plugins" ] && PLUGIN_DIRS+=("$DIR/plugins")
  done
fi
INSTALLED=0
# `${arr[@]}` on an EMPTY array is an unbound-variable error under `set -u`, so with no IDE installed
# this died with a bash internal error at this line and the explanatory message below never printed —
# the one case where it most needed to. The `+` form expands to nothing instead.
for DEST in ${PLUGIN_DIRS[@]+"${PLUGIN_DIRS[@]}"}; do
  rm -rf "$DEST/claude-observatory-jetbrains"
  unzip -qo "$ZIP" -d "$DEST/"
  echo "✓ installed $(basename "$ZIP") → $DEST/claude-observatory-jetbrains"
  INSTALLED=1
done
[ "$INSTALLED" -eq 1 ] || {
  echo "no JetBrains IDE plugin dirs found (looked in ~/Library/Application Support/JetBrains,"
  echo "~/.local/share/JetBrains, ~/.config/JetBrains/RemoteDev-*, and %APPDATA%/JetBrains)"; exit 1; }
echo
echo "Now FULLY restart the IDE (⌘Q → reopen) — or the remote-dev backend — to load the new version."
echo
echo "▸ Auto-update future releases (one time): Settings → Plugins → ⚙ → Manage Plugin Repositories → +"
echo "  → paste https://github.com/cell-observatory/claude-observatory/releases/latest/download/updatePlugins.xml"
