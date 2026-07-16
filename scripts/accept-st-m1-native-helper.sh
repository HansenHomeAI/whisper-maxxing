#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
swift test --package-path "$ROOT/app/native/macos-capture"
swift build --package-path "$ROOT/app/native/macos-capture" -c release --product whisper-mac-capture
BINARY="$(swift build --package-path "$ROOT/app/native/macos-capture" -c release --show-bin-path)/whisper-mac-capture"
test -x "$BINARY"
node "$ROOT/app/tests/acceptance/macos-native-capture/verify-helper.mjs" "$BINARY"
echo "ST-M1 NATIVE HELPER PASSED"
