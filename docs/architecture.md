# Architecture

## Goal

The main design goal is immediate capture.

The old pattern of:

1. resolve the microphone
2. launch a recorder
3. stop recording
4. launch a fresh `whisper-cli`

is too slow and tends to miss the first words.

This repo replaces that with a resident architecture.

## Runtime Pieces

### Native Capture Daemon

[`whisper-dictation-daemon`](../Sources/whisper-dictation-daemon/main.swift) runs as a user LaunchAgent.

Responsibilities:

- starts `AVAudioEngine` once
- keeps a rolling `Int16` ring buffer
- starts and stops sessions on command
- writes recorded sessions to WAV
- queues them for transcription

### Resident Transcription Service

The daemon manages `whisper-server` through [`TranscriptionManager.swift`](../Sources/whisper-dictation-daemon/TranscriptionManager.swift).

Behavior:

- prewarms `whisper-server` on launch
- uses HTTP for fast resident inference
- falls back to `whisper-cli` if the server path fails
- retains the most recent capture in memory so it can be retranscribed with the robust model
- keeps completed results in memory until Hammerspoon pulls them

### Control CLI

[`whisper-dictation-ctl`](../Sources/whisper-dictation-ctl/main.swift) is a tiny command client used by Hammerspoon and the benchmark scripts.

Commands:

- `warmup`
- `start`
- `retry-robust`
- `stop`
- `cancel`
- `next-result`
- `status`
- `shutdown`

### Hammerspoon Layer

[`hammerspoon/init.lua`](../hammerspoon/init.lua) handles:

- keyboard bindings
- on-screen recording state
- background result polling
- transcript paste into the active app

## Why This Is Fast

The fast path is:

1. hotkey fires
2. Hammerspoon calls `whisper-dictation-ctl start`
3. the daemon starts a logical session immediately
4. the prebuffer already contains the lead-in audio
5. on stop, the daemon queues the clip to a resident `whisper-server`

That removes:

- microphone enumeration on every key press
- recorder process launch on every key press
- model load on every transcription

## Lifecycle

### Install Time

[`scripts/install-local.sh`](../scripts/install-local.sh):

- builds the binaries
- writes the config file
- installs the dictation LaunchAgent
- installs the Hammerspoon startup LaunchAgent
- installs the Hammerspoon dictation module with a guarded loader
- warms the daemon

### Login Time

`launchd` starts the daemon and Hammerspoon automatically.

### Dictation Time

- start: open a logical session and keep buffering
- stop: flush buffered audio, enqueue transcription, paste when complete
- retry-robust: enqueue the most recent capture again using the robust model
- cancel: discard the active session without transcription

Successful dictations are not retained by default. Failed or low-confidence sessions can write salvage artifacts for debugging, and successful recent capture retention is opt-in through config.
