#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/app/tests/acceptance/macos-native-capture/verify-build-orchestrator.mjs"
echo "ST-M3 BUILD ORCHESTRATOR PASSED"
