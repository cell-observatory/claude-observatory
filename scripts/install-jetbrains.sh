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

# Newest JetBrains IDE config dirs that have a plugins folder (PyCharm, IntelliJ, …).
shopt -s nullglob
CANDIDATES=("$HOME/Library/Application Support/JetBrains/"{PyCharm,IntelliJIdea,WebStorm,GoLand}*)
INSTALLED=0
for DIR in "${CANDIDATES[@]}"; do
  [ -d "$DIR/plugins" ] || continue
  DEST="$DIR/plugins/claude-observatory-jetbrains"
  rm -rf "$DEST"
  unzip -qo "$ZIP" -d "$DIR/plugins/"
  echo "✓ installed $(basename "$ZIP") → $DEST"
  INSTALLED=1
done
[ "$INSTALLED" -eq 1 ] || { echo "no JetBrains IDE plugin dirs found under ~/Library/Application Support/JetBrains"; exit 1; }
echo
echo "Now FULLY restart the IDE (⌘Q → reopen) to load the new version."
