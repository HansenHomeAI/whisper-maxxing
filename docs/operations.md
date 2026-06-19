# Operations

The README is the primary setup guide. This page is a compact command reference for an installed local stack.

## Build And Install

```bash
swift build
swift run transcript-quality-tests
./scripts/build-release.sh
WHISPER_CPP_ROOT=~/src/whisper.cpp ./scripts/install-local.sh
```

Install-time options that matter most:

- `PREFERRED_INPUT_DEVICE` and `ENFORCE_PREFERRED_INPUT_DEVICE=true`
- `WHISPER_MODEL_PATH`
- `WHISPER_VAD_MODEL_PATH`
- `WHISPER_ROBUST_MODEL_PATH`
- `SERVER_REQUEST_TIMEOUT_SECONDS`, default `30`
- `ROBUST_SERVER_REQUEST_TIMEOUT_SECONDS`, default `120`
- `CLI_TIMEOUT_SECONDS`, default `90`
- `PERSIST_RECENT_CAPTURES=true`, opt-in successful audio/transcript retention

`CONTROL_HOST` must remain loopback-only.

## Health Checks

```bash
./bin/whisper-dictation-ctl status
./bin/whisper-dictation-ctl warmup
./bin/whisper-dictation-ctl start
sleep 1
./bin/whisper-dictation-ctl stop
./bin/whisper-dictation-ctl next-result
./bin/whisper-dictation-ctl retry-robust
```

Expected status: `ok:true`, `engineReady:true`, `serverState:"ready"`, and a full prebuffer.

## LaunchAgent

```bash
launchctl print gui/$(id -u)/com.hansenhomeai.whisper-dictation
launchctl kickstart -k gui/$(id -u)/com.hansenhomeai.whisper-dictation
launchctl bootout gui/$(id -u)/com.hansenhomeai.whisper-dictation
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hansenhomeai.whisper-dictation.plist
launchctl print gui/$(id -u)/com.hansenhomeai.hammerspoon
```

## Logs And Artifacts

- LaunchAgent stderr: `~/Library/Logs/WhisperDictation/launch-agent.stderr.log`
- LaunchAgent stdout: `~/Library/Logs/WhisperDictation/launch-agent.stdout.log`
- Hammerspoon startup stderr: `~/Library/Logs/WhisperDictation/hammerspoon-launch-agent.stderr.log`
- Hammerspoon startup stdout: `~/Library/Logs/WhisperDictation/hammerspoon-launch-agent.stdout.log`
- Whisper server log: `~/Library/Logs/WhisperDictation/whisper-server.log`
- Failed or low-confidence salvage: `~/Documents/WhisperSalvage`
- Optional successful recent captures: `~/Documents/WhisperSalvage/recent`

## Benchmarks

```bash
ITERATIONS=12 ./scripts/benchmark-startup.sh
COUNT=5 ./scripts/benchmark-pipeline.sh
LOAD=1 COUNT=5 ./scripts/benchmark-pipeline.sh
```

`scripts/benchmark-current.sh` compares old-style fresh process timings against a resident server and accepts `WHISPER_CPP_ROOT`, `WHISPER_MODEL_PATH`, and `FFMPEG` overrides.
