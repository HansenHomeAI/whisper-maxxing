# Focused local recovery and one-day diagnostics

## Objective

Protect valuable local dictation without changing normal UX. Active Electron recordings are
written to a private crash-recovery WAV, retained until delivery is acknowledged, and kept
for 24 hours after failure or interruption. A small redacted JSONL trace explains capture,
transcription, delivery, recovery, and cleanup events. Nothing is uploaded.

## Decisions

- Missing `localDiagnosticsEnabled` and `recordingRecoveryEnabled` keys default to `false`.
  Fresh configs explicitly enable both. Existing installs are enabled only deliberately.
- Successful audio is deleted after `ackResult(delivered)` unless
  `persistRecentCaptures` is enabled. Failure, empty output, paste failure, missing
  acknowledgement, crash, or shutdown retains it for 24 hours.
- Explicit cancel deletes its owned audio.
- The managed recovery namespace does not import or delete existing history,
  `WhisperSalvage`, or `recent` files.
- Normal overlay, hotkeys, strings, and timings remain unchanged. A stalled or non-durable
  recording stops instead of silently claiming to record.

## Implementation

1. **Session isolation.** `stop` and `cancel` accept the session ID returned by `start` and
   reject mismatches. Status exposes the active session and process instance. Managed E2E
   targets use isolated ports plus a known instance nonce, and cleanup acts only on sessions
   it created.
2. **File-backed capture.** When enabled, capture opens a user-private `.wav.part` before
   acknowledging start, writes the prebuffer only after start, appends frames through a
   bounded queue, and syncs audio plus metadata at least once per second. Stop patches the
   header and atomically renames the same file; the long recording is never duplicated in
   memory.
3. **Delivery ownership.** The controller sends `ackResult` with `delivered`, `pasteFailed`,
   or `noOutput`. The recovery file survives transcription and result polling and is deleted
   only after confirmed delivery.
4. **Crash recovery.** Startup repairs aligned abandoned partial WAVs exactly once. Graceful
   quit retains active audio. Stall or storage failure ends the false recording state and
   preserves every committed sample.
5. **Private diagnostics.** Daily JSONL files record allowlisted lifecycle events and
   normalized outcomes, never transcripts, audio, clipboard data, device identity,
   environment, command arguments, or request bodies. Local roots are scrubbed from bounded
   messages. New managed logs expire after 24 hours plus cleanup grace.
6. **Local inspection.** `wdctl diagnostics --since 24h`, `wdctl recoveries list`, and
   `wdctl recoveries export <session-id> <destination.wav>` inspect or export local evidence
   without a new UI.

## Retention and limits

- Diagnostic and terminal recovery retention: 24 hours; cleanup at startup and hourly.
- Cleanup grace: one hour.
- Disk reserve before capture: 2 GiB.
- Recovery cap: 10 GiB; active recordings are never cleanup targets.
- Under exceptional disk pressure, the oldest terminal recovery may be removed and the
  event is surfaced. Hardware failure and a completely full disk cannot be guaranteed
  against.
- POSIX files/directories use `0600`/`0700`; Windows uses the current-user application data
  boundary. The app never transmits artifacts, but same-user software, administrators,
  malware, and backups remain outside the v1 threat model.

## Release gates

- Process/power-loss recovery loses no more than one second after the last received frame.
- Ten-minute, one-hour, and synthetic four-hour captures keep duration-independent memory.
- Crash boundaries before and after sync, finalization, transcription, polling, paste, and
  acknowledgement recover exactly once.
- Failure, no speech, empty output, paste failure, no acknowledgement, shutdown, stall, disk
  failure, and queue overflow retain a playable WAV; delivered acknowledgement deletes it.
- Wrong session IDs, wrong instance nonce, and E2E cleanup cannot alter production work.
- Privacy scans find no transcript, audio, device identity, credentials, or raw local paths
  in diagnostics.
- Existing UX, parity, capture, pipeline, settings, protocol, soak, packaging, Swift, full
  verification, and macOS/Windows CI gates remain green.
