# ST-M2 — Electron native adapter

Follow `AGENTS.md`, `CONTEXT.md`, and `RULES.md`. Branch from the feature tip into
`mac-capture/st2-electron-adapter`; use a separate worktree and push immediately.

Own the new native protocol/parser/source/factory modules under `app/src/main/capture/**`
and that directory's `index.ts`. Implement the frozen contract, platform selection, binary
resolution, validation, surfaced failures, and bounded cleanup. Do not edit renderer
capture, config, application composition, package/build files, or acceptance files.

Set your goal: make `./scripts/accept-st-m2-electron-adapter.sh` pass end-to-end. Iterate in your branch until it does.
