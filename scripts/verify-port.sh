#!/usr/bin/env bash
# Definition-of-Done gate for the Electron port (see docs/electron-port/PLAN.md §0).
# Run from the repo root on macOS at the tip of feature/electron-port.
# Windows coverage is provided by the electron-ci.yml matrix; this script checks that too
# only indirectly (it will remind you). Every check here must pass — no partial credit.
set -euo pipefail

BASE_COMMIT="1e7a84025c5b5f656a66e503d5e35fe4a7456360" # feature branch base (developer tip at plan time)
FAIL=0
step() { printf '\n=== %s ===\n' "$1"; }

step "0. Spec fixtures are unmodified"
(cd docs/electron-port/acceptance && shasum -a 256 -c fixtures.sha256)

step "1. Swift reference stack untouched and still green"
if ! git diff --quiet "$BASE_COMMIT" -- Sources Tests Package.swift hammerspoon launchd; then
  echo "FAIL: Swift/Hammerspoon reference sources were modified relative to $BASE_COMMIT"
  git diff --stat "$BASE_COMMIT" -- Sources Tests Package.swift hammerspoon launchd
  exit 1
fi
swift build
swift run transcript-quality-tests

step "2. No skipped/focused tests in app/"
if grep -rnE '\.(only|skip)\(' app/src app/tests --include='*.ts' --include='*.mjs' 2>/dev/null; then
  echo "FAIL: .only(/.skip( found in app tests or sources"
  exit 1
fi

step "3. Typecheck + unit parity suite"
(cd app && npm ci && npm run typecheck && npm run test:unit)

step "4. Transcription pipeline reliability ladder"
(cd app && npm run test:pipeline)

step "5. Capture suite"
(cd app && npm run test:capture)

step "6. UX contract suite"
(cd app && npm run test:ux)

step "7. Settings & history suites"
(cd app && npm run test:settings && npm run e2e:settings)

step "8. Overlay + capture-smoke E2E"
(cd app && npm run e2e:overlay && npm run e2e:capture-smoke)

step "9. Protocol E2E + 50-cycle soak"
(cd app && npm run e2e:protocol && SOAK_CYCLES=50 npm run soak)
test -s app/soak-report.json || { echo "FAIL: soak-report.json missing or empty"; exit 1; }

step "10. Packaged artifacts"
(cd app && npm run dist && node tests/dist-smoke/check-artifacts.mjs)

step "REMINDER (not machine-checked here)"
echo " - electron-ci.yml matrix (macos-14 + windows-2022) must be green on the branch tip."
echo " - One recorded protocol+soak run against real whisper.cpp on macOS (ST-7 brief)."

printf '\nALL GATES PASSED\n'
