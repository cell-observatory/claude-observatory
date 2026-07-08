#!/usr/bin/env bash
# Build shareable release artifacts into ./release :
#   - claude-observatory.vsix                    (VS Code extension)
#   - claude-observatory-<ver>.tgz               (npm-installable CLI:  npm i -g <tgz>)
#   - claude-observatory-jetbrains-<ver>.zip     (JetBrains plugin — when JDK/Gradle available)
# Invoked by `npm run release`. Does NOT publish or commit.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf release && mkdir -p release

echo "▸ Building core + CLI…"
npm run build --silent

echo "▸ Packing the CLI (npm tarball)…"
( cd packages/cli && npm pack --silent --pack-destination ../../release >/dev/null )

echo "▸ Building + packaging the VS Code extension…"
npm run build:vscode --silent
( cd packages/vscode && npm run package --silent )
cp packages/vscode/claude-observatory.vsix release/

echo "▸ Building the JetBrains plugin…"
if command -v gradle >/dev/null 2>&1; then
  ( cd packages/jetbrains && \
    JAVA_HOME="${JAVA_HOME:-$([ -d /opt/homebrew/opt/openjdk@21 ] && echo /opt/homebrew/opt/openjdk@21 || echo "")}" \
    gradle buildPlugin --console=plain -q )
  cp packages/jetbrains/build/distributions/claude-observatory-jetbrains-*.zip release/
else
  echo "  (skipped — gradle not found; CI builds the .zip on tagged releases)"
fi

echo
echo "Release artifacts:"
ls -1 release
echo
echo "Share:  the .tgz installs the CLI with  npm i -g ./claude-observatory-<ver>.tgz"
echo "        the .vsix installs the sidebar with  code --install-extension claude-observatory.vsix"
echo "        the .zip installs in JetBrains IDEs via Settings → Plugins → Install Plugin from Disk"
