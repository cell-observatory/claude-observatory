#!/usr/bin/env bash
# Build shareable release artifacts into ./release :
#   - claude-observatory.vsix         (VS Code extension)
#   - claude-observatory-<ver>.tgz    (npm-installable CLI:  npm i -g <tgz>)
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

echo
echo "Release artifacts:"
ls -1 release
echo
echo "Share:  the .tgz installs the CLI with  npm i -g ./claude-observatory-<ver>.tgz"
echo "        the .vsix installs the sidebar with  code --install-extension claude-observatory.vsix"
