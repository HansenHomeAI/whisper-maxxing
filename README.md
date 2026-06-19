# whisper-maxxing

Low-latency local dictation for macOS. `whisper-maxxing` keeps audio capture and `whisper.cpp` warm so hotkey dictation starts immediately, preserves the first words with a rolling prebuffer, and pastes completed transcripts through Hammerspoon.

## What You Get

- native Swift capture daemon managed by `launchd`
- resident `whisper-server` with bounded request timeouts and CLI fallback
- 1-second rolling prebuffer
- Hammerspoon hotkeys:
  - `cmd + .` starts or stops dictation
  - `cmd + ;` retranscribes the last recording with the higher-accuracy model
  - `cmd + ,` cancels the active recording
- loopback-only local control socket
- successful dictation audio/transcript persistence off by default

## Requirements

- macOS 14 or later
- Xcode command line tools with Swift 6 support
- [Hammerspoon](https://www.hammerspoon.org/)
- `whisper.cpp` built locally with:
  - `build/bin/whisper-server`
  - `build/bin/whisper-cli`
  - a model such as `models/ggml-small.en.bin`
  - optional robust model `models/ggml-large-v3.bin`

This repo does not vendor `whisper.cpp` or model files.

## Build `whisper.cpp`

One standard setup path:

```bash
git clone https://github.com/ggml-org/whisper.cpp.git ~/src/whisper.cpp
cd ~/src/whisper.cpp
cmake -B build
cmake --build build --config Release
./models/download-ggml-model.sh small.en
./models/download-ggml-model.sh large-v3
```

Any local checkout is fine if it contains the binaries and model. Pass its path during install if it is not in a default location.

## macOS Permissions

Before first real use, grant:

- Microphone access to the dictation daemon/Terminal path that starts it.
- Accessibility access to Hammerspoon so it can paste into the frontmost app.

Open System Settings > Privacy & Security, then check Microphone and Accessibility. If dictation starts but produces no text, permissions are one of the first things to verify.

## Install

From this repo:

```bash
WHISPER_CPP_ROOT=~/src/whisper.cpp ./scripts/install-local.sh
```

The installer builds release binaries, writes config, installs the dictation LaunchAgent, installs a Hammerspoon startup LaunchAgent, installs `~/.hammerspoon/whisper-dictation.lua`, and adds a small guarded loader to `~/.hammerspoon/init.lua` if needed. Existing `init.lua` is backed up before modification.

Common overrides:

```bash
WHISPER_CPP_ROOT=~/src/whisper.cpp \
WHISPER_MODEL_PATH=~/src/whisper.cpp/models/ggml-small.en.bin \
WHISPER_ROBUST_MODEL_PATH=~/src/whisper.cpp/models/ggml-large-v3.bin \
PREFERRED_INPUT_DEVICE="MacBook Pro Microphone" \
ENFORCE_PREFERRED_INPUT_DEVICE=true \
WHISPER_THREADS=6 \
./scripts/install-local.sh
```

Useful optional settings:

- `WHISPER_VAD_MODEL_PATH`: enables VAD for longer recordings when readable.
- `SERVER_REQUEST_TIMEOUT_SECONDS`: default `30`.
- `WHISPER_ROBUST_MODEL_PATH`: enables `cmd + ;` retranscription, usually `ggml-large-v3.bin`.
- `ROBUST_WHISPER_SERVER_PORT`: default `8178`.
- `ROBUST_SERVER_REQUEST_TIMEOUT_SECONDS`: default `120`.
- `WARM_ROBUST_SERVER_ON_LAUNCH=true`: preloads the robust server instead of starting it lazily.
- `CLI_TIMEOUT_SECONDS`: default `90`.
- `PERSIST_RECENT_CAPTURES=true`: stores successful recent audio/transcript proof under `~/Documents/WhisperSalvage/recent`.
- `HAMMERSPOON_INSTALL_MODE=overwrite`: replaces `~/.hammerspoon/init.lua` with this repo's config instead of using the safe include mode.

`CONTROL_HOST` is intentionally loopback-only. Use `127.0.0.1`, `localhost`, or `::1`; do not expose the control socket to a network.

## Verify

```bash
./bin/whisper-dictation-ctl status
```

Expected healthy fields include:

- `"ok": true`
- `"engineReady": true`
- `"serverState": "ready"`
- `"robustServerState": "stopped"` until the robust shortcut is first used, unless robust warmup is enabled
- `"prebufferAvailableMilliseconds": 1000`

Run a real control loop:

```bash
./bin/whisper-dictation-ctl start
sleep 1
./bin/whisper-dictation-ctl stop
./bin/whisper-dictation-ctl next-result
```

Run the robust retry path:

```bash
./bin/whisper-dictation-ctl retry-robust
while ./bin/whisper-dictation-ctl status | grep -q '"pendingCount":[1-9]'; do sleep 1; done
./bin/whisper-dictation-ctl next-result
```

Run code checks:

```bash
swift build
swift run transcript-quality-tests
COUNT=2 ./scripts/benchmark-pipeline.sh
```

## Privacy

Dictation is local. Audio is recorded to temporary WAV data for transcription.

By default, successful dictations are not saved after completion. Failed or low-confidence sessions may save diagnostic salvage files under `~/Documents/WhisperSalvage` so you can debug what happened. Set `PERSIST_RECENT_CAPTURES=true` only if you explicitly want successful recent audio and transcript JSON saved for inspection.

## Troubleshooting

- No text appears: run `./bin/whisper-dictation-ctl status`, check Microphone permissions, then check `~/Library/Logs/WhisperDictation/launch-agent.stderr.log`.
- Hotkey does nothing: confirm Hammerspoon is running, Accessibility is granted, `launchctl print gui/$(id -u)/com.hansenhomeai.hammerspoon` is loaded, and `~/.hammerspoon/init.lua` loads `~/.hammerspoon/whisper-dictation.lua`.
- `cmd + ;` says no previous recording: make one normal `cmd + .` recording first; robust retry uses the most recent in-memory audio and does not start a new recording.
- Robust retry replacement: if the last dictation paste was within 15 seconds and you are still in the same app, `cmd + ;` undoes that paste before inserting the higher-accuracy transcript. Older pastes are left alone and the retry is inserted normally.
- Wrong microphone: rerun install with `PREFERRED_INPUT_DEVICE` and `ENFORCE_PREFERRED_INPUT_DEVICE=true`.
- Duplicate server or stale daemon: rerun `./scripts/install-local.sh`; matching stale `whisper-server` processes on the configured port are cleaned before launch.

## Repo Layout

- `Sources/WhisperDictationCore`: shared config, socket protocol, buffering, and transcript quality helpers
- `Sources/whisper-dictation-daemon`: capture daemon and transcription queue
- `Sources/whisper-dictation-ctl`: control CLI used by Hammerspoon and scripts
- `hammerspoon/init.lua`: repo-managed Hammerspoon dictation module
- `scripts/install-local.sh`: local installer
- `docs/architecture.md`, `docs/operations.md`, `docs/latency-analysis.md`: focused reference notes

## License

MIT. See [LICENSE](LICENSE).
