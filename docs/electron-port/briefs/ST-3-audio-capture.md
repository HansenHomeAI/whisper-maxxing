# ST-3 — Audio capture chain

Branch: `port/st3-capture` off `feature/electron-port` (launch AFTER ST-1 merges).
Read `docs/electron-port/CONTEXT.md` and `RULES.md` first. Follow repo-root `AGENTS.md`.

## Scope

Port `Sources/whisper-dictation-daemon/AudioCapture.swift` semantics to Electron:

- `app/src/renderer/capture/` — hidden capture window: `getUserMedia` (audio, no processing
  constraints that mangle speech: disable echoCancellation/noiseSuppression/autoGainControl to
  match raw capture), `AudioWorklet` that downsamples to 16 kHz mono Int16 and posts frames
  (with a monotonic timestamp) to the main process.
- `app/src/main/capture/` — `CaptureEngine` implementing the same public surface the daemon
  needs: `startAsync`, `startSession(profile)`, `stopSession(discard)` returning a
  `StoppedCapture` (WAV path + timing metrics), `isRecording`, `currentRecordingProfile`,
  `prebufferAvailableMilliseconds`, `readinessAssessment` (via core `captureReadiness`),
  `engineStartupMilliseconds`, `defaultInputDeviceName`. Rolling prebuffer of
  `prebufferMilliseconds` (default 1000) using the core ring buffer; on `startSession` the
  prebuffer is prepended to the session audio.
- Device preference: `enumerateDevices` label match for `preferredInputDevice`;
  `enforcePreferredInputDevice` failure surfaces as engine-not-ready with a clear message.
- Stall handling: track seconds-since-last-frame; wire core `captureRestartPolicy` — restart
  the capture window/stream on failure, escalate to `app.relaunch()`-style full restart after
  3 consecutive failures (make the escalation action injectable so tests observe it without
  relaunching).
- Define the `CaptureSource` interface the engine consumes, plus
  `app/tests/fakes/fake-capture-source.ts` streaming Int16 frames from WAV fixtures with a
  controllable clock.

**Tests** in `app/tests/capture/` (suite `test:capture`):
- prebuffer content is included: feed a fixture where a marker tone starts 500 ms before
  `startSession`; assert the produced WAV contains the marker samples (inspect WAV bytes).
- stop returns correct duration/coverage metrics; discard produces no WAV.
- stall: freeze the fake clock feed ⇒ readiness flips to `capture-buffer-stale`; restart
  policy escalation fires the injected restart action after 3 failures.
- WAV output is valid 16 kHz mono s16le (parse the header, don't trust the writer).
- One Playwright Electron test (`e2e:capture-smoke`, may live in `app/tests/capture/e2e/`):
  launch the app with `--use-fake-device-for-media-stream` and
  `--use-file-for-fake-audio-capture=<fixture.wav>`, run start→stop through the real hidden
  window, assert a non-silent WAV lands in the temp directory (RMS of decoded samples above
  a floor).

## Owned files

- `app/src/main/capture/**`, `app/src/renderer/capture/**`
- `app/tests/capture/**`, `app/tests/fakes/fake-capture-source.ts`
- WAV fixtures under `app/tests/fixtures/audio/`

## Do NOT touch

`app/src/core/**`, `app/package.json`, other subtasks' directories, anything outside `app/`.

## Success command

```bash
cd app && npm run typecheck && npm run test:capture
```

Set your goal: make the success command pass end-to-end. Iterate in your branch until it does.
