# CONTEXT — Native macOS capture

## Base and current architecture

The immutable base is `e9239753c50bfd34cf526e85dbd82995728eebf2`. Electron currently
constructs `RendererCaptureSource` in `app/src/main/index.ts`. It owns a hidden
`BrowserWindow`, calls `getUserMedia`, and streams mono Int16 frames into `CaptureEngine`.
`CaptureEngine` already owns readiness, one-second ring prebuffer, session samples, WAV
writing, stall detection, restart policy, and error surfacing. A replacement only needs to
implement the existing `CaptureSource` interface.

The Swift reference uses AVAudioEngine, AVAudioConverter, and `CoreAudioDevice` to capture
and convert the selected input to 16 kHz mono Int16. `Sources/`, `Tests/`, root
`Package.swift`, `hammerspoon/`, and `launchd/` remain read-only.

## Native helper protocol

The executable product is `whisper-mac-capture` under the nested Swift package
`app/native/macos-capture`. Normal mode captures a real device. `--self-test` emits a
deterministic ready frame, deterministic nonzero PCM, and stopped frame without opening a
device; CI uses it only to validate the transport. `--version` prints the protocol version.

stdout contains frames only: one-byte type, four-byte little-endian payload length, then
payload. Types: `1` ready JSON, `2` raw little-endian Int16 PCM, `3` error JSON, `4` stopped
with an empty payload. Payloads are limited to 262144 bytes. Ready JSON contains
`protocolVersion:1`, `sampleRateHz:16000`, `channels:1`, `sampleFormat:"s16le"`, and
`defaultInputDeviceName`. Logs use stderr.

Real PCM is aggregated into 320-sample/20 ms chunks. A dedicated serial output queue is
bounded to 100 frames. Overflow emits an error and exits nonzero; frames are never silently
dropped. Input device arguments are passed as argv values, never through a shell.

## Platform and lifecycle

`macCaptureBackend` is optional and defaults to `native`. On Darwin, `native` selects the
helper and `electron` is an explicit emergency fallback. Windows and other platforms always
select `electron-renderer`, even if a config contains `native`. There is no automatic native
failure fallback. The status response adds `captureBackend`.

The adapter handles fragmented and coalesced stdout, rejects unknown types, oversized
payloads, odd PCM lengths, invalid ready JSON, premature exits, and frames after stopped.
`stop()` sends SIGTERM, waits one second, then SIGKILLs and waits again. Cleanup is
idempotent. Unexpected exit or protocol error invokes `onError`, which enters the existing
visible CaptureEngine recovery path.

Development resolves the helper from the nested release build. Packaged macOS resolves it
at `process.resourcesPath/bin/whisper-mac-capture`. Windows never compiles or packages it.

## Decisions

- D28: D1 in `docs/electron-port/CONTEXT.md` is superseded only on macOS. Windows retains
  renderer capture unchanged.
- D29: `macCaptureBackend` is `native | electron`, optional/default native. Windows ignores
  it and always uses renderer capture.
- D30: Native failure is visible and retries native; no silent renderer fallback.
- D31: The internal helper wire protocol is the framed binary protocol above.
- D32: The queue is bounded to 100 20 ms frames; overflow is fatal and observable.
- D33: Existing preferred-device semantics remain; no built-in microphone is forced.
- D34: `captureBackend` is an additive control-status field.
- D35: macOS builds bundle the helper; Windows builds do not invoke Swift or contain it.
- D36: Live visual proof uses real screen pixels, a clean baseline, an Electron positive
  control, Retina-normalized component thresholds, and a native target.
- D37: AVAudioEngine is first. AUHAL is the fixed second implementation only if the
  pathfinder proves AVAudioEngine still produces the large pill.
- D38: ST-M2 may own its implementation-specific regression file
  `app/tests/capture/native-mac-capture-regressions.spec.ts`. Fresh review required these
  lifecycle/parser assertions, the file does not overlap another agent, and it raises the
  acceptance floor without changing any pinned test.
- D39: The merge-gate AVAudioEngine run at ST-M1 SHA
  `018dbacf7b81b4ee10e4ca43b1565b7730cae7bc` produced real PCM but also a pinned-probe
  large orange component of 80×48 pixels and area 2,909 at 2× scale. D37 therefore
  resolves to AUHAL. AVAudioEngine is no longer permitted as the final native capture
  primitive or fallback.
- D40: The AUHAL client format is the wire format itself: 16 kHz mono signed Int16 on
  output scope, input element 1. That configuration passed the real visual gate and emitted
  exact 640-byte PCM frames. A later device-native-rate AUHAL variant with a separate
  conversion worker reproduced the large pill, so device-rate staging is forbidden. An
  incompatible device surfaces an error instead of selecting another backend.
- D41: D40/A2 are superseded by measured behavior. A direct 16 kHz client on the 48 kHz
  default device fails its first AUHAL render with OSStatus `-10863` and no PCM, while the
  correct device-rate AUHAL plus converter still reproduces the large pill. The next fixed
  native primitive is direct HAL device input using `AudioDeviceCreateIOProcID` and
  `AudioDeviceStart`, with conversion and the wire protocol unchanged. It is mergeable only
  if the same run proves zero large components and real nonzero PCM; otherwise the objective
  remains unmet rather than being waived.
- D42: The persistent large pill follows macOS process responsibility. The unchanged
  historical native Swift daemon produces the pill when shell-launched, but as a GUI-domain
  launchd job it reports a real 1,000 ms prebuffer with only the 10×10 privacy dot. The
  helper is therefore split into a direct Electron-child protocol supervisor and a
  same-binary launchd capture worker connected by a private AF_UNIX socket. Only the worker
  opens the device. The supervisor remains the direct `whisper-mac-capture` child expected by
  runtime cleanup; both the worker process and submitted job are removed on graceful stop,
  supervisor death, and application quit.
- D43: ST-M1 merged at helper SHA `4a1ad51cac87b86d5f3efcd8bc0094def8e63643`.
  A signed release binary copied outside the Documents worktree emitted 35 real 640-byte
  PCM frames with 11,122 nonzero samples, one ready frame, exactly one stopped frame, no
  error or trailing bytes, and no leaked process or launchd job. The pinned 2x detector
  reported `largeComponentCount:0`; the earlier clean-baseline run isolated only the
  10x10 yellow/orange audio privacy indicator. The purple screen-sharing indicator is a
  separate macOS surface and is not an audio-detector component.
- D44: The final capture primitive is AVAudioEngine inside the GUI-domain launchd worker.
  The worker context, rather than changing the device or format contract, is what removes
  the large Mic Mode pill. The direct Electron child remains a microphone-free protocol
  supervisor.
- D45: A worktree binary under Documents triggered an unrelated macOS Folder Access prompt.
  The prompt was denied; the helper needs no Documents permission. Ad-hoc signing and
  copying the acceptance binary under `/tmp` produced real PCM and the expected microphone
  permission behavior without granting broader filesystem access.
- D46: The complete helper stream is `ready`, zero or more `pcm`, optional one `error`, and
  exactly one `stopped`. The worker owns orphan cleanup after supervisor socket EOF. At the
  merge gate, synchronized early-entry cancellation finished in 317 ms, connected
  unresponsive cancellation in 649 ms, and supervisor SIGKILL orphan cleanup in 85 ms;
  every case left zero workers, jobs, sockets, or private directories.

## Prep commit

`PREP_COMMIT=d527261f89802060ad9ee86587be1aaf8551cc44`. Every merge gate verifies the
pinned acceptance files still match this commit.
