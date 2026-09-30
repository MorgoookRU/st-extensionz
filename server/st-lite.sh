#!/usr/bin/env bash
# Starts SillyTavern with memory-friendly Node.js settings. Made for Termux on Android,
# works on any Linux/macOS machine with little RAM.
#
#   bash st-lite.sh                      # finds SillyTavern automatically
#   bash st-lite.sh ~/SillyTavern        # or pass its folder
#   bash st-lite.sh ~/SillyTavern --port 8001   # extra arguments go to SillyTavern
#
# Environment variables:
#   ST_HEAP_MB=384      V8 heap limit in MB (lower = less RAM, too low = crashes on huge imports)
#   ST_NO_WAKELOCK=1    do not call termux-wake-lock
#
# Measured on SillyTavern 1.19 with a 1500-message chat: Node RSS 358 -> 277 MB idle,
# 456 -> 283 MB peak, compared with a plain `node server.js`.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

is_st_root() {
    [ -f "$1/server.js" ] && [ -f "$1/package.json" ] && grep -q '"name": *"sillytavern"' "$1/package.json"
}

ST_DIR=""
if [ $# -gt 0 ] && [ -d "$1" ] && is_st_root "$1"; then
    ST_DIR="$(cd "$1" && pwd)"
    shift
else
    dir="$SCRIPT_DIR"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        if is_st_root "$dir"; then ST_DIR="$dir"; break; fi
        [ "$dir" = "/" ] && break
        dir="$(dirname "$dir")"
    done
    if [ -z "$ST_DIR" ] && is_st_root "$HOME/SillyTavern"; then ST_DIR="$HOME/SillyTavern"; fi
fi

if [ -z "$ST_DIR" ]; then
    echo "SillyTavern folder not found. Usage: bash st-lite.sh /path/to/SillyTavern" >&2
    exit 1
fi

cd "$ST_DIR" || exit 1

# SillyTavern's own start.sh runs "npm install" on every start, which takes a while on a phone.
# Only reinstall when package-lock.json changed (e.g. after "git pull").
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    echo "Installing dependencies..."
    npm install --no-audit --no-fund --loglevel=error --no-progress --omit=dev || exit 1
fi

# Keeps Android from suspending Termux while the server runs (screen off, app in background).
if [ -z "${ST_NO_WAKELOCK:-}" ] && command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
    trap 'termux-wake-unlock' EXIT
fi

HEAP_MB="${ST_HEAP_MB:-384}"

# --optimize-for-size is not allowed inside NODE_OPTIONS, so the flags go on the command line.
#   --max-old-space-size   caps the heap, so V8 collects garbage instead of growing
#   --max-semi-space-size  smaller young generation (default 16 MB per semi-space)
#   --optimize-for-size    V8 prefers memory over peak speed
echo "Starting SillyTavern from $ST_DIR (heap limit ${HEAP_MB} MB)"
node --max-old-space-size="$HEAP_MB" --max-semi-space-size=2 --optimize-for-size server.js "$@"
