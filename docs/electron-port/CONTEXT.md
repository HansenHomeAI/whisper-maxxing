# CONTEXT — Electron Port of whisper-maxxing

Everything a sub-agent needs to work on the Electron port without this file's author present.
Read this fully before touching code. Companion files: [PLAN.md](PLAN.md), [RULES.md](RULES.md),
briefs under [briefs/](briefs/), acceptance fixtures under [acceptance/](acceptance/).

## What this product is

Low-latency, fully local hotkey dictation. The user presses `cmd+.`, speaks, presses `cmd+.`
again, and the transcript is pasted into the frontmost app. `cmd+;` retranscribes the last
recording with a higher-accuracy model (optionally replacing the just-pasted text), `cmd+,`
cancels. Months of work went into reliability: never lose audio, never paste a partial or
garbage transcript silently, always recover from stalls. **Reliability parity is the entire
point of this port. Feature work that risks it loses.**

## Current (Swift/macOS) architecture — the reference implementation

Four pieces, all in this repo:

1. **Capture daemon** — `Sources/whisper-dictation-daemon/` (LaunchAgent).
   - `AudioCapture.swift`: one resident `AVAudioEngine`, a rolling Int16 ring buffer
     (`prebufferMilliseconds`, default 1000 ms) so the first words before the hotkey are kept.
     Stall detection + restart policy (`CaptureRestartPolicy`: retry in-process, restart the
     whole process after 3 consecutive failures).
   - `TranscriptionManager.swift` (1413 lines — read it; it is the reliability heart):
     manages resident `whisper-server` processes (profiles `fast` + `robust`, lazy robust
     startup), HTTP inference with bounded timeouts, CLI fallback via `whisper-cli` when the
     server path fails, transcript-quality gate (`TranscriptQuality.assess`) that forces a
     second pass for suspiciously short transcripts on long audio, capture-integrity gate
     (`CaptureIntegrity.assess`) that fails a session outright rather than pasting a partial
     transcript, salvage persistence of failed/low-confidence sessions to
     `~/Documents/WhisperSalvage`, and in-memory retention of the last capture for
     `retry-robust`.
   - `Daemon.swift`: wires capture + transcription to the control socket; completed results
     sit in `SessionResultBuffer` until the client pulls them (ordering rules are tested —
     requesting session B must not discard or return session A).
2. **Shared core** — `Sources/WhisperDictationCore/`: `AppConfig` (config schema + loopback-only
   enforcement), `ControlProtocol` (all wire types), `Int16RingBuffer`, `SessionResultBuffer`,
   `TranscriptQuality`, `CaptureIntegrity`, `CaptureReadiness`, `CaptureRestartPolicy`,
   `WAVFileWriter`, `JSONSocket`, `DiskSpace`, `CoreAudioDevice`.
3. **Control CLI** — `Sources/whisper-dictation-ctl/`: sends one JSON request over TCP to the
   daemon, prints one JSON response. Used by Hammerspoon, scripts, and all black-box tests.
4. **Hammerspoon layer** — `hammerspoon/init.lua`: hotkeys, recording overlay pill, alert
   toasts, result polling (150 ms), status watchdog (2 s), transcript normalization
   (`normalizeTranscript`), paste via clipboard + synthetic `cmd+v`, and the undo-replace flow
   (if the last paste was < 15 s ago in the same app, `cmd+;`'s result sends `cmd+z` first,
   waits 80 ms, then pastes the replacement).

Docs: `docs/architecture.md`, `docs/operations.md`, `docs/latency-analysis.md`, `README.md`.

## The control protocol (wire contract — DO NOT change existing semantics)

JSON over loopback TCP (`JSONSocket.swift`). One request → one response per connection.
Commands (`ControlProtocol.swift` is the source of truth):

| command | effect |
|---|---|
| `warmup` | no-op ping, `ok:true` |
| `start` / `startRobust` | begin a session (fast/robust profile); returns `sessionId`, `status` |
| `stop` | end session, enqueue transcription; returns `sessionId`, `pendingCount` |
| `cancel` | end session, discard audio |
| `retryRobust` | re-enqueue last retained capture with robust model; error if recording |
| `nextResult` | pop one completed result (optionally by `sessionId`); `resultAvailable`, `result` |
| `status` | full `StatusPayload` |
| `shutdown` | graceful exit |

`StatusPayload` fields (recording, recordingProfile, pendingCount, engineReady,
engineHealthMessage, engineStartupMilliseconds, prebufferAvailableMilliseconds,
preferredInputDevice, defaultInputDevice, serverState, robustServerState,
availableDiskSpaceBytes, lowDiskSpaceMessage) and `SessionResultPayload`/`SessionMetrics`
must be reproduced field-for-field so existing tooling and the Swift `whisper-dictation-ctl`
keep working against the Electron daemon.

**The port adds one command:** `openSettings` (ctl verb `open-settings`) — opens/focuses the
settings & history window and returns `ok:true`.

## Target (Electron) architecture — decided, do not re-litigate

All new code lives in **`app/`** (TypeScript, strict mode). The Swift stack is **untouched**
and remains the author's daily driver until sign-off.

- **Main process** hosts the ported daemon: control TCP server (wire-compatible), transcription
  engine, session/result buffers, config, history store, global hotkeys, paste engine, window
  management. The daemon logic must be UI-free and dependency-injected (capture source,
  whisper transport, clock) so it is unit-testable headless.
- **Capture**: hidden renderer window using `getUserMedia` + `AudioWorklet`. Downsample to
  16 kHz mono Int16 in the worklet, stream frames to main over a MessagePort. Ring prebuffer
  (1000 ms) maintained in main. Device preference/enforcement via `enumerateDevices` matching
  by label. Stall detection: same readiness semantics as `CaptureReadiness` (buffer older than
  ~2 s ⇒ not ready). Chromium's `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-audio-capture` flags make deterministic capture E2E possible.
- **Whisper**: unchanged external `whisper-server` / `whisper-cli` binaries (`.exe` on
  Windows), spawned and health-checked by the app exactly like `TranscriptionManager` does.
  Windows builds of whisper.cpp are produced by `scripts/setup-whisper-windows.ps1` (ST-6a).
- **Hotkeys**: Electron `globalShortcut`. macOS: `Command+.`, `Command+;`, `Command+,`
  (identical to today). Windows: `Control+.`, `Control+;`, `Control+,`.
- **Overlay & alerts**: one transparent, frameless, always-on-top, click-through,
  non-focusable BrowserWindow rendering the recording pill (bottom-center, red dot + label)
  and alert toasts. Exact strings, sizes, and timings are in
  [acceptance/ux-parity.json](acceptance/ux-parity.json) — they are the parity contract.
- **Paste engine**: overwrite clipboard, then synthesize the paste keystroke.
  macOS: `osascript -e 'tell application "System Events" to keystroke "v" using command down'`
  (requires Accessibility grant for the app). Windows: bundled PowerShell helper using
  `SendInput` for `ctrl+v`. Undo-replace: identical 15 s window + same-frontmost-app check
  (macOS: frontmost bundle id; Windows: foreground process name), `cmd/ctrl+z`, 80 ms delay,
  paste. Clipboard is intentionally NOT restored afterward (parity with today).
- **Result delivery**: main-process poller replicates `init.lua` — 150 ms result poll while
  `pendingCount > 0`, 2 s status watchdog, health warnings throttled to one per 300 s,
  `normalizeTranscript` ported 1:1 (fixture: `acceptance/normalize-transcript-cases.json`).
- **Settings & history window**: normal BrowserWindow opened by `wdctl open-settings` or the
  tray menu. Shows transcription history (newest first: text, timestamp, profile, duration,
  transcription ms), a search box, per-entry copy button, a Clear History button, and
  read-only display of active config. History store: append-only `history.jsonl` in
  `app.getPath('userData')`, text + metrics only (never audio), enabled by default, capped at
  1000 entries, clear = truncate file. Audio persistence remains opt-in exactly as today.
- **Tray**: minimal tray icon with Open Settings / Quit (gives Windows users a surface).
- **Config**: same JSON schema as `AppConfig` (a superset; new keys must be optional with
  defaults so a legacy config still loads — the Swift tests encode this rule). Path: macOS
  `~/Library/Application Support/WhisperDictation/config.json` (shared with Swift stack),
  Windows `%APPDATA%/WhisperDictation/config.json`. Loopback-only `controlHost` enforcement
  is a hard requirement.
- **Coexistence defaults (A/B on the author's Mac)**: Electron control port **44124** (Swift
  keeps 44123), Electron whisper ports **8179/8180** (Swift keeps 8177/8178). Set via config.
- **New CLI**: `app/bin/wdctl.mjs` (Node, no deps) — same verbs as `whisper-dictation-ctl`
  plus `open-settings`; reads the config file for host/port, honors `WDCTL_CONFIG` env
  override. The Swift ctl continues to work against the Electron daemon on macOS because the
  wire format is identical.
- **Launch at login**: `app.setLoginItemSettings` on both platforms (replaces LaunchAgent for
  the Electron app).
- **Toolchain**: npm, Vite (renderer), `tsc --noEmit` typecheck, vitest (unit/integration),
  Playwright `_electron` (E2E), electron-builder (dmg/zip + nsis). Node 22 LTS. Electron:
  latest stable at scaffold time, then pinned exactly. GitHub Actions matrix:
  `macos-14` + `windows-2022` (`.github/workflows/electron-ci.yml`).

## Test fakes (shared infrastructure, built in ST-2/ST-3)

- **Fake whisper server** (`app/tests/fakes/fake-whisper-server.ts`): HTTP server mimicking
  `whisper-server`'s inference endpoint with a scriptable scenario queue — fixed transcripts
  (including caller-supplied nonce strings), delays, 5xx, hangs, connection refusals. Also a
  fake `whisper-cli` shim script. All reliability-ladder tests run against these; no models
  or GPUs in CI.
- **Fake capture source**: injectable `CaptureSource` interface streaming Int16 frames from
  WAV fixtures with a controllable clock, so prebuffer/stall/restart logic is tested
  deterministically.

## Reliability invariants (the port fails if any of these regress)

1. Prebuffer: audio from up to 1000 ms before `start` is included in the session.
2. Ladder: server → CLI fallback → (quality gate) second pass → salvage; bounded timeouts at
   every step; a failure surfaces as an explicit `errorMessage` result, never a silent drop.
3. Capture-integrity gate: a capture whose audio duration is far below wall-clock fails with
   salvage rather than pasting a partial transcript (thresholds in `CaptureIntegrity.swift`).
4. Quality gate: long audio + tiny transcript triggers a robust second pass
   (thresholds in `TranscriptQuality.swift`).
5. Result ordering: `nextResult(sessionId)` never returns or discards a different session's
   result; overlapping sessions all deliver (see `SessionResultBuffer` tests).
6. Stall recovery: stale capture buffers are detected, restart policy escalates
   retry → process restart after 3 consecutive failures.
7. Every started-and-stopped session produces exactly one result (transcript, no-speech,
   or error) — the 50-cycle soak asserts this.
8. Control socket stays loopback-only; non-loopback `controlHost` in config is a fatal
   config error.
9. Legacy config files (missing newer optional keys) still load with documented defaults.

## Key file map (Swift → TypeScript port targets)

| Swift source (reference) | Port target |
|---|---|
| `Sources/WhisperDictationCore/*.swift` | `app/src/core/*` (pure, no Electron imports) |
| `Sources/whisper-dictation-daemon/TranscriptionManager.swift` | `app/src/main/transcription/*` |
| `Sources/whisper-dictation-daemon/AudioCapture.swift` | `app/src/main/capture/*` + `app/src/renderer/capture/*` |
| `Sources/whisper-dictation-daemon/Daemon.swift` | `app/src/main/daemon.ts` |
| `Sources/whisper-dictation-ctl/main.swift` | `app/bin/wdctl.mjs` |
| `hammerspoon/init.lua` | `app/src/main/ux/*` + `app/src/renderer/overlay/*` |
| `Tests/TranscriptQualityTests/main.swift` | `app/tests/unit/parity.spec.ts` (driven by `acceptance/parity-cases.json`) |

## Conventions

- TypeScript strict; no `any` in `app/src/core`. Core modules must not import `electron`.
- Tests colocated under `app/tests/{unit,pipeline,capture,ux,e2e}`; fixtures under
  `app/tests/fixtures` (code-owned) — files under `docs/electron-port/acceptance/` are the
  immutable spec-owned fixtures (see RULES.md).
- Follow existing repo style: small focused modules, descriptive names, no comment noise.
- Commit messages: imperative, ≤ 60 chars, matching existing history
  (e.g. "Port session result buffer to core").

## Decisions already made (recorded here so no executor re-opens them)

- D1: Hidden-renderer Web Audio capture, not a native Node addon.
- D2: Wire-compatible control protocol; Electron daemon on port 44124 by default.
- D3: Swift sources untouched during the port; both stacks coexist on macOS.
- D4: History = text + metrics JSONL, on by default, capped 1000; audio persistence stays opt-in.
- D5: Clipboard is overwritten by paste and not restored (parity over improvement).
- D6: npm + Vite + vitest + Playwright + electron-builder; no pnpm/yarn, no Jest.
- D7: All third-party dependencies are declared by ST-1; `app/package.json` is frozen after
  ST-1 merges — new deps only via a core-agent commit at a merge gate.
- D8: Windows hotkeys use Control instead of Command; all other UX strings/timings identical.
- D9: `openSettings` is the only new control command in this port.
- D10: Subsystem Playwright specs stay inside their brief-owned test trees:
  `tests/capture/e2e`, `tests/ux/e2e`, and `tests/settings/e2e`. The frozen npm E2E commands
  target those directories explicitly, and Playwright scans only those three patterns. This
  resolves the original scaffold path mismatch without broadening branch ownership.

## Pathfinder findings

- GitHub `macos-14` must select `/Applications/Xcode_16.2.app/Contents/Developer` before
  running the Swift reference checks; the runner default does not reliably provide the Swift
  6 toolchain required by this package.
- The scaffold pins Node-facing dependencies exactly and keeps every future suite command
  explicit. A suite whose directory has not landed fails instead of reporting an empty pass.
- The Node control server must track accepted sockets and destroy them during shutdown.
  Closing only the listening server can wait forever on an idle client or stalled handler.
  Asynchronous transport failures are routed through an observable error reporter.
- Swift transcript character semantics require two Unicode predicates: Foundation
  `whitespacesAndNewlines` edge trimming includes U+200B, while internal
  `Character.isWhitespace` filtering does not.
