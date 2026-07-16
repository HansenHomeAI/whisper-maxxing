#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="e9239753c50bfd34cf526e85dbd82995728eebf2"
cd "$ROOT"

test "$(git branch --show-current)" = "feature/macos-native-capture"
git merge-base --is-ancestor "$BASE" HEAD
git diff --exit-code "$BASE" -- Sources Tests Package.swift hammerspoon launchd \
  app/src/main/capture/rendererCaptureSource.ts app/src/renderer/capture

(cd docs/macos-native-capture && shasum -a 256 -c acceptance/acceptance-floor.sha256)
(cd docs/electron-port/acceptance && shasum -a 256 -c fixtures.sha256)
if grep -rnE '\.(only|skip)\(' app/src app/tests --include='*.ts' --include='*.mjs' 2>/dev/null; then
  echo "focused or skipped test found" >&2
  exit 1
fi

./scripts/accept-st-m1-native-helper.sh
./scripts/accept-st-m2-electron-adapter.sh
./scripts/accept-st-m3-build-orchestrator.sh
(cd app && npm run test:capture)

echo "MACOS NATIVE CAPTURE GATES PASSED"
