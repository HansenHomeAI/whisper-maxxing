# RULES — Electron Port

Binding rules for every agent (core and sub) working on `feature/electron-port`.
The core agent may APPEND clarifying rules under "Amendments" below; amendments may clarify
*how* to do the work, never narrow scope or weaken what success means.

## Anti-gaming rules (verbatim from the plan — immutable)

- A test that is skipped, deleted, or weakened does not count as passing. The test set at
  plan time is the floor.
- Stubbing a function to make checks pass is failure, not progress.
- If a workaround needs a paragraph-long comment to justify it, the code is wrong — fix the
  code.
- Success commands are immutable once the plan is issued.

## Git hygiene (parallel safety)

- All work happens on branches off `feature/electron-port`; merge back into
  `feature/electron-port` only, never directly to `developer` or `main`.
- Sub-agent branch names: `port/st<N>-<slug>` as listed in PLAN.md §4.
- Commit ONLY files inside your brief's "owned files" globs. If you believe you must touch a
  file outside them, stop and request it at your merge gate instead.
- Never run `git stash`, `git reset`, `git rebase`, `git checkout -- <path>` on shared files,
  `git clean`, or any command that rewrites history or touches state outside your branch.
- Push your branch to origin early and after every green test run.

## Fixture immutability

- Files under `docs/electron-port/acceptance/` are the spec. Do not edit them. Their SHA-256
  hashes are pinned in `docs/electron-port/acceptance/fixtures.sha256` and checked by
  `scripts/verify-port.sh`. If a fixture is genuinely wrong, raise it at a merge gate; only
  the core agent may correct it, in a dedicated commit that also updates the hash file and
  records the reason in CONTEXT.md.
- Tests that consume a fixture must iterate ALL cases in it and assert the executed-case
  count equals the fixture's case count.

## Code rules

- Swift sources (`Sources/`, `Tests/`, `Package.swift`), `hammerspoon/`, `launchd/`, and
  existing `scripts/*.sh` are read-only reference material for this port. Do not modify them.
- `app/src/core/**` must not import `electron` or any platform module — pure logic only.
- No `.only(` / `.skip(` anywhere in `app/`. `scripts/verify-port.sh` greps for this.
- No network access at runtime except loopback (control socket, whisper server) — this is a
  local-only dictation tool; keep it that way. No telemetry, no update pings in this port.
- New dependencies: forbidden outside ST-1. Request at a merge gate; core agent adds them.
- Every error path must surface to the user as a result `errorMessage` or an alert — never a
  silent catch.

## Process rules

- Follow the repo-root `AGENTS.md` for build/test commands and conventions.
- Before requesting merge: run your brief's success command from a clean checkout of your
  branch tip and paste the full output (not an excerpt) in the merge request.
- If the same failure mode bites you twice, report it at the gate so the core agent can add
  an Amendment here rather than letting a third agent hit it.

## Amendments (core agent appends below; never edits above this line)

- A1 (capture E2E timeout recurrence): Electron fake-microphone harnesses must set the
  fake-device and fake-audio Chromium flags before app readiness, use an explicit renderer
  readiness/artifact handshake, dispose the capture engine during `before-quit`, and close
  Electron plus temporary files in `finally`. On macOS CI the dedicated test harness may use
  `--no-sandbox`; production windows must retain their configured sandbox behavior.
- A2 (Playwright Electron launch recurrence): Electron E2E main entrypoints must not block
  module evaluation with top-level `await app.whenReady()`, because Playwright's Electron
  launch handshake can hang before it attaches. Start readiness work from an explicit async
  function without top-level await, surface its rejection to the artifact/test channel, and
  close the Electron application in test cleanup.
