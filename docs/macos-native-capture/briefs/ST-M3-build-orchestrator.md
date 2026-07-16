# ST-M3 — Platform-aware build orchestrator

Follow `AGENTS.md`, `CONTEXT.md`, and `RULES.md`. Branch from the feature tip into
`mac-capture/st3-build-orchestrator`; use a separate worktree and push immediately.

Own `app/scripts/build-native-capture.mjs` and non-acceptance tests for it. Export an
injectable `buildNativeCapture` function and provide a CLI. Darwin runs Swift release build;
Windows and other platforms return without locating or invoking Swift. Do not edit
`package.json`, CI, builder config, runtime capture, or acceptance files.

Set your goal: make `./scripts/accept-st-m3-build-orchestrator.sh` pass end-to-end. Iterate in your branch until it does.
