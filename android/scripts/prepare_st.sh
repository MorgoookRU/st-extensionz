#!/usr/bin/env bash
# Builds the SillyTavern bundle (assets/st.zip) that the Android app extracts on first start.
#
#   prepare_st.sh <output st.zip> [SillyTavern git ref]
#
# - clones SillyTavern (default: the "release" branch),
# - installs production dependencies (all of them are pure JS / WASM, no native addons),
# - removes source maps, type definitions, tests and git metadata,
# - writes a phone-friendly config.yaml (see server/apply-lite-config.mjs),
# - bundles the Extensionz extension (with its performance module) as a global extension.
set -euo pipefail

OUT="$(realpath -m "$1")"
REF="${2:-release}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
WORK="$(mktemp -d)"
ST="$WORK/st"

echo "Cloning SillyTavern ($REF)..."
git clone --depth 1 --branch "$REF" https://github.com/SillyTavern/SillyTavern.git "$ST"
ST_COMMIT="$(git -C "$ST" rev-parse --short HEAD)"
ST_VERSION="$(node -p "require('$ST/package.json').version")"

echo "Installing production dependencies..."
(cd "$ST" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

echo "Configuring..."
cp "$ST/default/config.yaml" "$ST/config.yaml"
node "$REPO_ROOT/server/apply-lite-config.mjs" "$ST"
rm -f "$ST/config.yaml.before-lite"
node --input-type=module - "$ST" <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const root = process.argv[2];
const YAML = createRequire(path.join(root, 'package.json'))('yaml');
const file = path.join(root, 'config.yaml');
const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
doc.setIn(['port'], 8123);
doc.setIn(['listen'], false);
doc.setIn(['whitelistMode'], true);
doc.setIn(['browserLaunch', 'enabled'], false);
fs.writeFileSync(file, doc.toString());
EOF

echo "Bundling Extensionz..."
EXT="$ST/public/scripts/extensions/third-party/st-extensionz"
mkdir -p "$EXT"
(cd "$REPO_ROOT" && git ls-files -z -- ':!android' ':!.github' | xargs -0 -I{} cp --parents {} "$EXT/")

echo "Pruning..."
rm -rf "$ST/.git" "$ST/.github" "$ST/docker" "$ST/colab" "$ST/tests" "$ST/node_modules/.bin" "$ST/node_modules/.cache"
find "$ST/node_modules" -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' -o -name '*.md' -o -name '*.markdown' \) -delete
find "$ST/node_modules" -type d \( -name test -o -name tests -o -name __tests__ -o -name docs -o -name example -o -name examples \) -prune -exec rm -rf {} +
find "$ST" -type l -delete

printf 'sillytavern=%s\ncommit=%s\nbuilt=%s\n' "$ST_VERSION" "$ST_COMMIT" "$(date -u +%Y-%m-%dT%H:%MZ)" > "$ST/.apk-bundle"

echo "Zipping..."
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
(cd "$ST" && zip -q -r -9 -X "$OUT" .)
echo "SillyTavern $ST_VERSION ($ST_COMMIT): $(du -h "$OUT" | cut -f1) -> $OUT"
echo "ST_VERSION=$ST_VERSION" >> "${GITHUB_ENV:-/dev/null}"
rm -rf "$WORK"
