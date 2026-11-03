#!/usr/bin/env bash
# Rebuild Memory Galaxy from a vault:
#   1. rescan the vault into src/graph.json (the fallback the pane can show offline)
#   2. rebundle src/memory-galaxy.jsx into plugin.js
#
#   ./rebuild.sh /path/to/your/vault
#
# Falls back to $OBSIDIAN_VAULT_PATH, then to the vault recorded in src/graph.json.
# Hermes Desktop hot-reloads plugin.js, so no restart is needed after a rebuild.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

VAULT="${1:-${OBSIDIAN_VAULT_PATH:-}}"
if [ -z "$VAULT" ]; then
  VAULT="$(node -e "try{console.log(require('./src/graph.json').vault||'')}catch(e){}")"
fi
if [ -z "$VAULT" ]; then
  echo "usage: ./rebuild.sh /path/to/your/vault" >&2
  exit 1
fi
if [ ! -d "$VAULT" ]; then
  echo "no such vault directory: $VAULT" >&2
  exit 1
fi

node src/scan-vault.mjs "$VAULT" src/graph.json

# The plugin imports nothing outside the Hermes SDK and react, so esbuild is the
# only build dependency: use a local one when present, otherwise let npx fetch it.
if command -v esbuild >/dev/null 2>&1; then
  ESBUILD="esbuild"
else
  ESBUILD="npx --yes esbuild@0.25.0"
fi

$ESBUILD src/memory-galaxy.jsx \
  --bundle --format=esm --jsx=automatic --minify \
  --external:@hermes/plugin-sdk --external:react --external:react/jsx-runtime \
  --outfile=plugin.js

echo "Built plugin.js from $VAULT"
