#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/app"
npm run dist
node tests/dist-smoke/check-artifacts.mjs
if ! grep -q 'macos-14' "$ROOT/.github/workflows/electron-ci.yml" || ! grep -q 'windows-2022' "$ROOT/.github/workflows/electron-ci.yml"; then
  echo "CI matrix is missing macOS or Windows" >&2
  exit 1
fi
echo "ST-M4 PACKAGING CI PASSED"
