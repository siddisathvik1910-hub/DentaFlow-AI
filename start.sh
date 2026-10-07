#!/usr/bin/env bash
# One-command start for macOS / Linux:  ./start.sh
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Node.js is required. Install the LTS version from https://nodejs.org (v20 or v22 recommended)."; exit 1; fi
MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then echo "Node.js 18 or newer is required (you have $(node -v))."; exit 1; fi
if [ ! -d node_modules ]; then echo "Installing dependencies (first run only)..."; npm install --no-audit --no-fund; fi
[ -f .env ] || cp .env.example .env
URL="http://localhost:${PORT:-3000}"
( sleep 3; (command -v open >/dev/null && open "$URL/app") || (command -v xdg-open >/dev/null && xdg-open "$URL/app") || true ) >/dev/null 2>&1 &
exec npm start
