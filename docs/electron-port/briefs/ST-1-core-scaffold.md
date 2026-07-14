# ST-1 — App scaffold + core domain port (PATHFINDER)

Branch: `port/st1-core-scaffold` off `feature/electron-port`.
Read `docs/electron-port/CONTEXT.md` and `RULES.md` first. Follow repo-root `AGENTS.md`.

## Scope

You are the pathfinder: you validate the build system, test harness, CI, and merge flow for
everyone else. Deliver:

1. **Scaffold `app/`**: npm project, TypeScript strict, Vite for renderer builds, vitest,
   Playwright (`@playwright/test` with `_electron`), electron-builder config placeholder,
   `npm run typecheck` (`tsc --noEmit`), and this exact script set: `test:unit`,
   `test:pipeline`, `test:capture`, `test:ux`, `test:settings`, `e2e` (runs all e2e
   projects), `e2e:capture-smoke`, `e2e:overlay`, `e2e:settings`, `e2e:protocol`, `soak`,
   `dist`. Suites whose directories don't exist yet must FAIL when invoked — never silently
   pass. Pin Electron + all deps exactly.
   Declare ALL dependencies now (D7 in CONTEXT.md): electron, typescript, vite, vitest,
   @playwright/test, playwright, electron-builder, tsx, @types/node. Nothing else without a
   merge-gate request.
2. **Port `Sources/WhisperDictationCore/` to `app/src/core/`** (pure TS, no `electron`
   imports): appConfig, controlProtocol types, int16RingBuffer, sessionResultBuffer,
   transcriptQuality, captureIntegrity, captureReadiness, captureRestartPolicy, wavFileWriter,
   plus a `jsonSocket` loopback TCP server/client (node:net) matching the Swift framing in
   `Sources/WhisperDictationCore/JSONSocket.swift`. Match Swift semantics exactly — read each
   Swift file; thresholds and reason strings are behavior, not decoration.
3. **Parity tests**: `app/tests/unit/parity.spec.ts` loads
   `docs/electron-port/acceptance/parity-cases.json`, executes EVERY case, and asserts the
   executed-case count equals the fixture's total. Add ring-buffer and wavFileWriter unit
   tests of your own (byte-level WAV header assertions against a known-good fixture you
   generate with the Swift `WAVFileWriter` and commit under `app/tests/fixtures/`).
4. **CI**: `.github/workflows/electron-ci.yml` — matrix `macos-14` + `windows-2022`, runs
   `npm ci && npm run typecheck && npm run test:unit` in `app/`, plus the existing Swift
   checks (`swift build && swift run transcript-quality-tests`) on macOS only.

## Owned files

- `app/**` (you create it)
- `.github/workflows/electron-ci.yml`

## Do NOT touch

`Sources/`, `Tests/`, `Package.swift`, `hammerspoon/`, `launchd/`, `scripts/` (except nothing),
`docs/electron-port/acceptance/**`, README.

## Success command

```bash
cd app && npm ci && npm run typecheck && npm run test:unit
```

Plus: push your branch and confirm `electron-ci.yml` is green on both OSes for it.

Set your goal: make the success command pass end-to-end. Iterate in your branch until it does.
