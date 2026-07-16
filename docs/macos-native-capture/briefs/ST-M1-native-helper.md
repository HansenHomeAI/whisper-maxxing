# ST-M1 — Native helper pathfinder

Follow `AGENTS.md`, `CONTEXT.md`, and `RULES.md`. Branch from the feature tip into
`mac-capture/st1-native-helper`; use a separate worktree and push immediately.

Own only `app/native/macos-capture/**`. Build a nested Swift package and executable exactly
matching the frozen protocol, real AVAudioEngine capture, conversion, device semantics,
bounded output queue, signals, `--version`, and deterministic `--self-test`. Do not touch
Electron, packaging, root Swift sources, or acceptance files.

Set your goal: make `./scripts/accept-st-m1-native-helper.sh` pass end-to-end. Iterate in your branch until it does.
