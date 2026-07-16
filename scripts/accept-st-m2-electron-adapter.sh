#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/app"
npm run typecheck
npm run test:native-capture
echo "ST-M2 ELECTRON ADAPTER PASSED"
