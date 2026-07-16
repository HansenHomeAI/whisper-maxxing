#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "live native capture verification requires macOS" >&2
  exit 1
fi
cd "$ROOT/app"
npm run dist
node tests/acceptance/macos-native-capture/live-gate.mjs
echo "MACOS LIVE MIC INDICATOR GATE PASSED"
