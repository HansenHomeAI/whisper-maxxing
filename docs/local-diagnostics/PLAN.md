# PLAN — Local diagnostics and recoverable recordings

This plan is self-contained and implementation-ready. It improves failure tracing and
recording recovery without adding screens, telemetry, remote log collection, or a new
everyday UX. All data stays on the user's machine and is automatically bounded.

## 0. Outcome and non-negotiable guarantees

The finished system must make every dictation answerable after the fact:

1. What state was the app in, and what failed?
2. Did audio frames continue arriving for the whole recording?
3. Which transcription attempts ran, for how long, and why did they fall back?
4. If no transcript was produced, is the audio locally recoverable?

The implementation must preserve these invariants:

- No network access, telemetry, upload, or cross-device log collection.
- Diagnostic logs never contain transcript text or audio samples.
- Recovery audio is a separate, local-only artifact, not a log attachment.
- A successfully transcribed recording is deleted immediately unless the existing
  `persistRecentCaptures` setting is explicitly enabled.
- Recovery artifacts and diagnostics expire after 24 hours and are also size-capped.
- Existing overlay geometry, hotkeys, strings, and normal interaction flow do not change.
- Every new config key is optional with a safe default so old config files keep loading.
- The loopback-only control boundary remains loopback-only.

## 1. Verified current-state gaps

This plan is based on the current Electron implementation at commit `5d21438`.

| Area | Current behavior | Failure consequence |
|---|---|---|
| App diagnostics | `app/src/main/index.ts` sends errors to `console.error` and the overlay. | Finder-launched app output is not a durable, searchable incident trace. |
| Server logs | Fast and robust whisper servers append plain process output to configured files. | Server evidence exists, but it is not correlated to an app/session/attempt. |
| Active capture | `CaptureEngine` stores every active sample in `activeSession.samples` in RAM. | A process crash, forced restart, shutdown, or power loss destroys the recording. Long recordings continually grow memory. |
| Stop path | `activeSession` is cleared before WAV construction and atomic write. | A write failure leaves no active-session recovery path. |
| Dispose path | `dispose()` clears `activeSession` unconditionally. | An in-progress recording is lost during app shutdown/restart. |
| Input stall | Frame staleness is detected after two seconds, but capture restart is deferred while recording. | A long session can remain visibly “recording” after frames stop; integrity is fully measured only at stop. |
| Failed transcription | Final failures and quality failures save a WAV under `salvageDirectory`. | Completed captures are often recoverable, but pre-stop crashes are not. Existing salvage has no time-based cleanup. |
| Successful capture proof | `persistRecentCaptures` stores WAV + transcript JSON and keeps the latest 12. It defaults to `false`. | Count-based retention does not provide a privacy-bounded 24-hour incident window. |
| History | JSONL history records successful, non-empty results only. | It cannot explain failures, retries, capture stalls, or app restarts. |
| Control ownership | `stop` and `cancel` act on the one global active session without matching `sessionId`. | A test or stale client can cancel a recording it did not start. |
| E2E cleanup | Protocol cleanup cancels any recording seen on its target port. | A mis-targeted test can cancel a real production recording. |

The critical distinction is that logs improve diagnosis, but only a continuously written
audio recovery spool can salvage speech that existed before a crash.

## 2. Target architecture

### 2.1 Structured local event journal

Add a small append-only JSONL logger under the configured app data directory:

```text
WhisperDictation/
  logs/
    diagnostics-2026-07-20.jsonl
  recovery/
    active/<session-id>.pcm.part
    active/<session-id>.json
    retained/<session-id>.wav
    retained/<session-id>.json
```

Each diagnostic event has a versioned envelope:

```json
{
  "schemaVersion": 1,
  "timestamp": "2026-07-20T18:24:12.345Z",
  "monotonicMilliseconds": 42198,
  "severity": "info",
  "component": "transcription",
  "event": "server_attempt_failed",
  "processInstanceId": "...",
  "sessionId": "...",
  "attemptId": "...",
  "fields": { "profile": "robust", "elapsedMilliseconds": 120031 },
  "error": { "name": "Error", "message": "...", "stack": "..." }
}
```

Rules:

- Use one `processInstanceId` per app launch and the existing capture `sessionId` from
  start through paste/result completion. Use a fresh `attemptId` for server retry, CLI
  fallback, and robust second-pass attempts.
- Write lifecycle transitions, not raw audio frames. During recording, emit one heartbeat
  every five seconds with cumulative samples, wall duration, audio duration, coverage,
  last-frame age, backend, device identity hash, and spool bytes.
- Record app start/stop/crash recovery; capture start/first frame/stall/stop/finalize;
  queue entry/dequeue; server spawn/readiness/request/retry; CLI start/timeout/termination;
  quality decision; salvage; result polling; paste success/failure; and retention cleanup.
- Replace the current `console.error`-only path and inject this logger into capture,
  daemon, transcription, UX, history, server lifecycle, and process spawning. The existing
  overlay continues surfacing operational errors.
- Redact transcript fields, command-line model paths where not needed, the home-directory
  prefix, environment variables, and request bodies. Enforce redaction through typed event
  builders rather than accepting arbitrary objects.
- Create directories and files with user-only permissions (`0700` directories, `0600`
  files). A logger write error must be surfaced and rate-limited, but must not crash audio
  capture.
- Rotate daily and when a file reaches 10 MiB. Keep at most 24 hours plus a one-hour
  cleanup grace and cap all diagnostic files at 50 MiB. Run cleanup at startup, hourly,
  and after rotation.

### 2.2 Explicit session state ledger

Model the lifecycle as a monotonic state machine and log every accepted transition:

```text
starting -> recording -> stopping -> captured -> queued
         -> cancelled              -> transcribing -> completed
                                      |             -> failed/recoverable
                                      -> retrying
```

Persist a compact sidecar for active/recoverable sessions. It contains only state,
timestamps, profile, sample count, format, capture metrics, and failure metadata. It must
not contain transcript text. Startup can then distinguish a genuine interrupted recording
from an unrelated or corrupt file.

Invalid or duplicate transitions must create an error event. This ledger also provides a
single source for future local diagnostic summaries instead of reconstructing truth from
unrelated log lines.

### 2.3 Crash-safe audio recovery spool

Replace the active-session RAM array with a bounded streaming writer:

1. At session start, create `<session>.pcm.part` and its sidecar atomically. Include the
   prebuffer, then append each 16 kHz mono Int16 frame as it arrives.
2. Serialize appends through one ordered write queue. Flush at least every second or
   256 KiB, whichever comes first, and issue a durable checkpoint every five seconds.
3. Update sidecar checkpoints atomically after the audio checkpoint. The sidecar records
   the committed byte count, allowing startup recovery to ignore an incomplete tail.
4. On normal stop, close the writer, validate frame alignment, build a valid WAV header,
   and atomically rename into the normal pipeline input.
5. After successful result delivery, delete the temporary capture immediately unless
   `persistRecentCaptures` is true.
6. On final transcription/integrity failure, move the WAV and sidecar to `retained/`, add
   the existing diagnostic reason, and return its local path through `salvagePath`.
7. On startup, inspect abandoned `.part` files, truncate to the last complete Int16 frame
   at or below the committed checkpoint, finalize a valid WAV, and retain it for recovery.
   Do not automatically transcribe or paste it; that would change user behavior.
8. On explicit user cancel, delete the owned spool after closing it. Log a metadata-only
   cancellation tombstone. A foreign or mismatched cancel must be rejected, not applied.

Add optional backward-compatible config keys:

```json
{
  "localDiagnosticsEnabled": true,
  "diagnosticRetentionHours": 24,
  "recordingRecoveryEnabled": true,
  "recoveryRetentionHours": 24,
  "diagnosticMaxBytes": 52428800,
  "recoveryMaxBytes": 5368709120
}
```

For privacy compatibility, absent `recordingRecoveryEnabled` initially defaults to
`false`; first-run config generation writes it explicitly as `true`. Existing installs are
updated only by an explicit migration decision and never by silently treating a missing
key as consent. The local development installation can opt in immediately. The spool is
temporary operational state: successful audio still cannot outlive successful delivery
unless `persistRecentCaptures` is explicitly enabled.

Before and during capture, track free disk space. Never delete an active spool. If the
size cap or disk floor is reached, delete the oldest finalized recovery first. If writing
the active spool fails, surface an immediate error through the existing alert mechanism
while retaining any already committed audio; do not wait until the user stops recording.

### 2.4 Detect a dead recording while it is still running

The existing two-second watchdog already polls status. Extend status with active session
ID, sample count, recording start time, committed spool bytes, and last-frame age. If frame
age exceeds the existing stall threshold while recording:

- set an explicit unhealthy state and diagnostic event immediately;
- use the existing alert channel to tell the user audio input stalled (no new window,
  setting, or layout);
- preserve the committed spool;
- keep refusing to claim healthy recording until new frames arrive;
- defer destructive capture-source restart until the current recoverable session is
  safely closed, unless a tested source handoff can preserve continuity.

The overlay may remain visually unchanged, but the system must never continue silently
claiming a healthy recording after frame flow has stopped.

### 2.5 Session ownership and test isolation

This is the first implementation milestone because it prevents another recording-loss
incident while later work is underway.

- Make `stop` and `cancel` require the caller's `sessionId`; reject a mismatch without
  touching the active recording. The controller stores the ID returned by `start` and
  supplies it. Define a narrow compatibility path for legacy clients, then remove it after
  all shipped clients have migrated.
- Add a random `processInstanceId`/target nonce to status for test targets. Managed E2E
  processes require the expected nonce before any destructive command.
- Use ephemeral or preflighted isolated ports for managed tests. Refuse an external target
  unless `WD_EXTERNAL_TARGET=1`, and refuse destructive external-target cleanup unless a
  separately explicit `WD_ALLOW_DESTRUCTIVE_EXTERNAL_TARGET=1` is set.
- Change `drainOwnedSessions` so it drains result IDs it owns but never cancels an unknown
  active session.
- Add a production-path/port guard so `verify-port.sh` cannot accidentally target the
  installed app's config or port 44124.

### 2.6 Local inspection and recovery commands

Extend `wdctl` only; do not add UI:

```bash
wdctl diagnostics summary --since 24h
wdctl diagnostics path
wdctl diagnostics bundle --since 24h
wdctl recoveries list
wdctl recoveries inspect <session-id>
wdctl recoveries export <session-id> <destination.wav>
```

`summary` groups by session and prints the last successful state, failure chain, capture
coverage, retry ladder, and artifact path. `bundle` contains redacted logs and metadata
only; audio is excluded unless a separate explicit `--include-audio <session-id>` is
provided. Export never deletes the retained source.

## 3. Implementation sequence

### Milestone 0 — Stop cross-session cancellation

Primary files: `app/src/core/controlProtocol.ts`, `app/src/main/daemon.ts`,
`app/src/main/ux/dictationController.ts`, `app/tests/e2e/protocol/**`, and protocol/UX tests.

Deliver session-matched stop/cancel, test target nonce validation, isolated ports, and an
adversarial regression proving a production session cannot be cancelled by test cleanup.

### Milestone 1 — Structured diagnostics and retention

Add `app/src/main/diagnostics/**` and unit tests. Extend config, first-run generation, and
path derivation. Route every current error reporter through typed structured events while
retaining current alerts. Add rotation, redaction, permissions, corruption tolerance, and
fake-clock retention tests.

### Milestone 2 — Streaming recovery spool

Add `app/src/main/capture/recoverySpool.ts`; refactor `CaptureEngine` so active audio is
streamed rather than accumulated in an array. Make normal stop finalization atomic. Add
startup recovery, immediate success cleanup, 24-hour failed-artifact retention, size/disk
caps, and config migration behavior.

### Milestone 3 — Correlation and local tools

Instrument the full capture-to-paste lifecycle with stable session and attempt IDs. Extend
status and `wdctl` inspection/recovery commands. Add session-oriented diagnostic summary
tests and confirm bundles exclude transcripts and audio by default.

### Milestone 4 — Fault-injection and release proof

Run the complete matrix below, the existing Definition-of-Done gate, installed-app smoke,
and CI on macOS and Windows. Promote only after all measurable acceptance criteria pass.

## 4. Required fault-injection matrix

| Fault | Injection point | Required result |
|---|---|---|
| App `SIGKILL` | 10 min and 60 min into recording | Startup yields a valid recoverable WAV losing no more than one second after the last flush. |
| Power-loss approximation | Kill after PCM write but before sidecar rename, and inverse ordering boundaries | Recovery uses the last committed aligned checkpoint; no corrupt WAV is presented as valid. |
| Native helper crash | Mid-recording | Existing alert fires promptly, trace shows last frame, committed audio remains recoverable. |
| Frame stall | Source stays alive but emits no frames | Watchdog reports unhealthy within the existing threshold; recording is not silently reported healthy. |
| Stop/write failure | Permission removal and simulated `ENOSPC` | Already committed audio survives and error is surfaced immediately. |
| Server crash/timeout | First and retry requests | Attempt IDs and timings show restart-once behavior, then CLI fallback. |
| CLI timeout/unkillable child | Fallback path | Trace records termination outcome and WAV path remains recoverable. |
| Both transcribers fail | Final result | Result has `errorMessage` and valid local salvage path. |
| App exit during transcription | After WAV finalization | Startup ledger finds completed audio and does not discard it. |
| Duplicate/stale client | Wrong session ID on stop/cancel | Request is rejected; correct recording continues. |
| Mis-targeted E2E | Installed production port already active | Test fails closed before start/cancel/shutdown. |
| Log file corrupt/torn | Invalid final JSONL line | Reader skips/reports only bad line and retains all valid events. |
| Clock/retention boundary | 23h59m, 24h, 25h | Active spool is never deleted; expired finalized artifacts/logs are removed within one-hour grace. |
| Privacy scan | All emitted events and bundles | No transcript, PCM/WAV bytes, environment secrets, or unredacted home path. |
| Long-duration soak | 4-hour synthetic capture | Memory stays bounded, sample accounting remains monotonic, WAV is valid, and heartbeat cadence stays bounded. |

## 5. Machine-checkable acceptance criteria

The feature is complete only when all are true:

1. A forced app kill during a recording produces a playable 16 kHz mono WAV on restart,
   with at most one second of audio missing after the last completed flush.
2. A transcription failure always returns either a valid `salvagePath` or an explicit
   second error explaining why local persistence failed.
3. Successful audio is absent within 10 seconds of completed delivery when
   `persistRecentCaptures` is false.
4. An active session's RAM use is bounded and does not scale with recording duration.
5. A stopped frame stream is surfaced within the current watchdog threshold plus one poll
   interval; it cannot remain silently healthy.
6. Stop/cancel/shutdown from a mismatched client cannot alter an owned recording.
7. Diagnostics older than 24 hours plus one-hour grace are removed, total logs stay below
   50 MiB, and retained recovery stays below 5 GiB without deleting an active spool.
8. A repository scan and runtime network monitor show no new network endpoints or outbound
   calls.
9. Diagnostic logs and default bundles contain no transcript text or audio content and
   have user-only filesystem permissions.
10. Existing UX snapshots, hotkey tests, transcript parity, protocol, 50-cycle soak,
    packaging, Swift tests, and the full `./scripts/verify-port.sh` gate remain green.

## 6. Release and rollback

Ship the work behind the two explicit config switches. First enable diagnostics locally,
then recovery spooling locally, and run real long recordings plus forced-crash exercises.
After CI and installed-app proof, merge to `developer`, observe local use for at least one
retention window, then promote the same commit to `main`.

Rollback can disable structured diagnostics and recovery independently without changing
capture/transcription UX. Disabling recovery must first finalize or retain any active spool;
it must never delete in-flight audio as part of a config toggle or upgrade.
