# ST-M4 — Packaging and CI

Follow `AGENTS.md`, `CONTEXT.md`, and `RULES.md`. Start only after ST-M1 and ST-M3 merge;
branch into `mac-capture/st4-packaging-ci`, use a separate worktree, and push immediately.

Own `app/electron-builder.yml`, optional `app/build/afterPack.mjs`,
`app/tests/dist-smoke/check-artifacts.mjs`, and `.github/workflows/electron-ci.yml`. Bundle
and verify the executable only on macOS; prove the Windows artifact excludes it and Windows
jobs never run Swift. Do not edit runtime source, config, package scripts, root Swift, or
acceptance files.

Set your goal: make `./scripts/accept-st-m4-packaging-ci.sh` pass end-to-end. Iterate in your branch until it does.
