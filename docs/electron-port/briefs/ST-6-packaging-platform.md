# ST-6 — Packaging, installers, platform setup

Two independent halves with different start times.

## ST-6a — Windows whisper.cpp bootstrap (launch IMMEDIATELY — no dependency on app/)

Branch: `port/st6a-whisper-windows` off `feature/electron-port`.

Write `scripts/setup-whisper-windows.ps1`: clones/updates whisper.cpp, builds
`whisper-server.exe` + `whisper-cli.exe` with CMake (Release), downloads `small.en` and
optionally `large-v3` models, honors `WHISPER_CPP_ROOT`/`WHISPER_MODEL` env overrides, and
prints the resolved binary/model paths as JSON on the last line so the app installer can
consume them. Also `scripts/setup-whisper-windows.Tests.ps1` (Pester) covering argument
parsing and path resolution with a mocked build step, and a `-CheckOnly` mode that validates
an existing tree without building.

Owned files: `scripts/setup-whisper-windows.ps1`, `scripts/setup-whisper-windows.Tests.ps1`,
`docs/windows-setup.md`.

Success command (runs on Windows CI and locally):
```powershell
Invoke-Pester -Path scripts/setup-whisper-windows.Tests.ps1 -Output Detailed
```

## ST-6b — Electron packaging + login launch (launch AFTER wave 1 merges)

Branch: `port/st6b-packaging` off `feature/electron-port`.

- electron-builder config (`app/electron-builder.yml`): macOS dmg+zip (hardened runtime,
  `NSMicrophoneUsageDescription`, entitlements for mic), Windows NSIS. App id
  `com.hansenhomeai.whisper-maxxing`.
- First-run setup flow: detect missing config → write a default config (per-OS paths, ports
  44124/8179/8180), point at whisper binaries/models (env override or the JSON emitted by
  `setup-whisper-windows.ps1`), guide macOS mic + Accessibility grants with direct
  deep-links to the right System Settings panes.
- Launch at login via `app.setLoginItemSettings`, toggleable by config.
- CI: extend `.github/workflows/electron-ci.yml` with a `dist` job on both OSes that uploads
  the artifacts and then runs the packaged binary with `--version` (mac: the .app binary in
  the unpacked dir; win: the unpacked exe) asserting exit 0 and the version string.

Owned files: `app/electron-builder.yml`, `app/build/**` (icons/entitlements),
`app/src/main/firstRun.ts`, `app/src/main/loginItem.ts`, `app/tests/dist-smoke/**`, and the
`dist` job block of `.github/workflows/electron-ci.yml`. You MAY edit `app/package.json`
ONLY in the `"build"`/`"scripts.dist"` keys — this is the single sanctioned exception to the
package.json freeze; the merge gate diff-checks that nothing else in the file changed.

Success command:
```bash
cd app && npm run dist && node tests/dist-smoke/check-artifacts.mjs
```
(`check-artifacts.mjs` asserts the expected artifact files exist and the unpacked binary
answers `--version`.) Plus green `dist` job on both CI OSes.

Read `docs/electron-port/CONTEXT.md` and `RULES.md` first. Follow repo-root `AGENTS.md`.
Set your goal: make your half's success command pass end-to-end. Iterate in your branch until
it does.
