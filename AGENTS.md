# AGENTS.md — whisper-maxxing

Instructions for any coding agent working in this repository.

## What this repo is

Low-latency local hotkey dictation. Production stack today: Swift daemon + Hammerspoon on
macOS (see `docs/architecture.md`). An Electron cross-platform port is in progress on the
`feature/electron-port` branch — if you are working on that branch or its children, the
governing documents are `docs/electron-port/PLAN.md`, `CONTEXT.md`, and `RULES.md`
(RULES.md is binding; read it before your first commit).

## Build & test

Swift stack (macOS):

```bash
swift build
swift run transcript-quality-tests   # unit/parity suite; must always pass
./bin/whisper-dictation-ctl status   # live daemon health (if installed)
COUNT=2 ./scripts/benchmark-pipeline.sh
```

Electron port (once `app/` exists):

```bash
cd app && npm ci
npm run typecheck && npm run test:unit
npm run test:pipeline && npm run test:capture && npm run test:ux && npm run test:settings
npm run e2e && SOAK_CYCLES=50 npm run soak
./scripts/verify-port.sh   # from repo root: the full Definition-of-Done gate
```

## Hard rules

- Reliability is the product. Never trade it for speed of delivery. Every error path must
  surface to the user (result `errorMessage` or alert) — no silent catches, no swallowed
  promises.
- The control socket is loopback-only. Never bind or connect it to a non-loopback host.
  No new network access of any kind (no telemetry, no update checks).
- Privacy: successful dictation audio is never persisted unless `persistRecentCaptures` is
  explicitly true. Transcript history (text + metrics) is governed by `persistHistory`.
- Tests are the floor: never skip, delete, or weaken an existing test to get green. No
  `.only(` / `.skip(` committed.
- On `feature/electron-port` work: commit only files your brief owns; no `git stash`,
  `git reset`, `git rebase`, or history rewrites; branch off and merge back into
  `feature/electron-port` only.
- Swift sources are the reference implementation for the port — read them, do not modify
  them on port branches.
- Match existing style: small focused modules, descriptive names, minimal comments.
  Commit messages: imperative mood, ≤ 60 chars (see `git log`).

## Conventions

- TypeScript: strict mode; `app/src/core/**` stays pure (no `electron`, no platform APIs).
- Exact user-facing strings/timings/geometry come from
  `docs/electron-port/acceptance/ux-parity.json` — never inline them.
- Config schema changes must keep legacy config files loading (optional keys + defaults),
  matching the pattern in `Sources/WhisperDictationCore/AppConfig.swift`.
