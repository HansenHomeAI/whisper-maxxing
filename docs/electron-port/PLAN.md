# PLAN — Port whisper-maxxing to a cross-platform Electron app

This plan is self-contained: the executor needs no prior conversation context. You are the
**core agent**. Follow the repo-root `AGENTS.md` at all times, and require every sub-agent
you spawn to do the same. Binding rules for all agents: `docs/electron-port/RULES.md`.
Architecture, decisions, and invariants: `docs/electron-port/CONTEXT.md` (read it fully
before anything else). Sub-agent briefs: `docs/electron-port/briefs/`.

## 0. Objective & Definition of Done

Port the whisper-maxxing dictation stack (Swift daemon + Hammerspoon, macOS-only) to a
single Electron app in `app/` that runs identically-feeling dictation on macOS and fully
featured dictation on Windows: same hotkeys (Command on macOS, Control on Windows), same
overlay pill and alert toasts with the exact same strings and timings, same paste and
undo-replace behavior, the same wire-compatible loopback control protocol, and the same
reliability ladder (resident whisper-server → CLI fallback → quality-gated second pass →
salvage, with prebuffer, stall recovery, and strict result ordering) — plus one new feature:
a settings window with searchable transcription history, opened by `wdctl open-settings`.
The Swift stack remains untouched and working. Success is exactly this, nothing softer:

```bash
./scripts/verify-port.sh          # from repo root on macOS — every gate must print ALL GATES PASSED
```

which enforces: spec fixtures unmodified (SHA-256 pinned), Swift sources unchanged vs base
commit `1e7a840` and `swift build && swift run transcript-quality-tests` green, zero
`.only(`/`.skip(` in `app/`, and green runs of `npm run typecheck`, `test:unit` (all parity
fixture cases executed), `test:pipeline`, `test:capture`, `test:ux`, `test:settings`,
`e2e:settings`, `e2e:overlay`, `e2e:capture-smoke`, `e2e:protocol`, `SOAK_CYCLES=50 npm run
soak` (with a parseable `soak-report.json`), and `npm run dist` + artifact smoke check.
Additionally, machine-checkable outside that script:

```bash
gh run list --workflow electron-ci.yml --branch feature/electron-port --limit 1   # conclusion: success (macos-14 + windows-2022 matrix)
```

and one recorded `e2e:protocol` + soak run against real whisper.cpp on macOS (output pasted
into the final merge summary). "Looks good" is not a criterion anywhere in this plan.

## 1. Branch topology

- Feature branch: `feature/electron-port` (already created off `developer` at `1e7a840` and
  pushed to `origin`). All work accumulates at its tip; when done, the complete feature is
  visible in this one branch.
- Sub-agents branch off `feature/electron-port` using the names in §4
  (`port/st<N>-<slug>`), push early, and merge back into `feature/electron-port` only —
  never into `developer` or `main`.
- Git hygiene for parallel safety (also in RULES.md, binding): agents commit only the files
  their brief owns; no `git stash`, `git reset`, `git rebase`, `git clean`, no history
  rewrites, no touching shared state. Integration conflicts are resolved by you at merge
  gates, nowhere else.

## 2. Prep artifacts (already written and committed — do not regenerate)

The planning agent produced these; they are on the branch and are the spec:

- `docs/electron-port/CONTEXT.md` — architecture of the Swift reference implementation,
  the decided Electron target architecture, the control-protocol wire contract, the nine
  reliability invariants, the Swift→TS file map, conventions, and decisions D1–D9.
- `docs/electron-port/RULES.md` — binding rules incl. the anti-gaming rules and the
  amendment protocol. You may only APPEND amendments.
- `docs/electron-port/acceptance/parity-cases.json` — every case from
  `Tests/TranscriptQualityTests/main.swift`, machine-readable. The TS parity suite must
  execute all of them and assert the executed count equals the fixture count.
- `docs/electron-port/acceptance/normalize-transcript-cases.json` — 16 cases pinning
  `normalizeTranscript` semantics from `hammerspoon/init.lua`.
- `docs/electron-port/acceptance/ux-parity.json` — exact alert strings, health messages,
  timings, hotkeys, overlay geometry, and behavioral contract of the UX shell.
- `docs/electron-port/acceptance/fixtures.sha256` — pinned hashes; `verify-port.sh` fails
  if any fixture changes. Adversarial design notes: parity suites are count-asserted so
  cases can't be cherry-picked; E2E tests assert on artifacts (Playwright DOM/screenshot
  pixels, WAV bytes on disk, `history.jsonl` contents, `soak-report.json`) and use
  runtime-generated nonce transcripts from the fake whisper server so no implementation can
  hardcode its way past them; visual checks inspect the rendered overlay window, not logs.
- `docs/electron-port/briefs/ST-1 … ST-7` — per-subtask scope, owned files, exclusions,
  success command.
- `scripts/verify-port.sh` — the Definition-of-Done gate.
- Repo-root `AGENTS.md`.

## 3. Pathfinder wave

**Pathfinder: ST-1 (app scaffold + core domain port + parity tests + CI).** It exercises
every piece of shared machinery — npm/TS/vitest/Playwright setup, the fixture-driven test
pattern, the CI matrix, and the branch→merge flow. Launch it immediately.

In parallel (no shared files with ST-1):
- **You (core agent) start ST-7** — the protocol-level E2E + soak harness. It is your
  hardest-leverage task and is independently validatable: run it against the EXISTING Swift
  daemon on this Mac first (`WD_TARGET=swift`, port 44123). A harness that passes against
  the Swift stack is a trustworthy referee for everything that follows.
- **ST-6a** (Windows whisper.cpp bootstrap script) — pure PowerShell in `scripts/`, zero
  coupling to `app/`.

ST-2, ST-3, ST-4, ST-5 genuinely depend on ST-1's scaffold (they import `app/src/core` and
its test wiring), so they wait for ST-1's first successful merge. When ST-1 merges, fold
everything learned (build quirks, Electron/Playwright pinning, CI gotchas, fixture-runner
pattern) into CONTEXT.md and, if a rule is needed, an amendment in RULES.md — before
launching the dependent wave.

## 4. Fan-out

| ID | Branch | Scope (brief) | Owned files | Inputs | Success command | Excluded |
|---|---|---|---|---|---|---|
| ST-1 | `port/st1-core-scaffold` | Scaffold + core port + parity tests + CI ([brief](briefs/ST-1-core-scaffold.md)) | `app/**`, `.github/workflows/electron-ci.yml` | CONTEXT.md, parity-cases.json, Swift core sources | `cd app && npm ci && npm run typecheck && npm run test:unit` + green CI | Swift sources, acceptance fixtures |
| ST-2 | `port/st2-transcription` | Transcription ladder + fake whisper server ([brief](briefs/ST-2-transcription-pipeline.md)) | `app/src/main/transcription/**`, `app/tests/pipeline/**`, `app/tests/fakes/fake-whisper-{server.ts,cli.mjs}` | ST-1 merge, `TranscriptionManager.swift` | `cd app && npm run typecheck && npm run test:pipeline` | `app/src/core`, package.json |
| ST-3 | `port/st3-capture` | Capture chain + fake capture source ([brief](briefs/ST-3-audio-capture.md)) | `app/src/{main,renderer}/capture/**`, `app/tests/capture/**`, `app/tests/fakes/fake-capture-source.ts`, `app/tests/fixtures/audio/**` | ST-1 merge, `AudioCapture.swift` | `cd app && npm run typecheck && npm run test:capture` | core, transcription, ux dirs |
| ST-4 | `port/st4-ux-shell` | Hotkeys, overlay, alerts, paste/undo-replace, poller ([brief](briefs/ST-4-ux-shell.md)) | `app/src/main/ux/**`, `app/src/renderer/overlay/**`, `app/resources/win/**`, `app/tests/ux/**` | ST-1 merge, `hammerspoon/init.lua`, ux-parity.json, normalize fixture | `cd app && npm run typecheck && npm run test:ux` | core, transcription, capture dirs |
| ST-5 | `port/st5-settings-history` | History store + settings window + tray + wdctl ([brief](briefs/ST-5-settings-history.md)) | `app/src/main/history/**`, `app/src/renderer/settings/**`, `app/src/main/tray.ts`, `app/tests/settings/**`, `app/bin/wdctl.mjs` | ST-1 merge | `cd app && npm run typecheck && npm run test:settings && npm run e2e:settings` | everything else in `app/src` |
| ST-6a | `port/st6a-whisper-windows` | Windows whisper.cpp bootstrap ([brief](briefs/ST-6-packaging-platform.md)) | `scripts/setup-whisper-windows.{ps1,Tests.ps1}`, `docs/windows-setup.md` | none | `Invoke-Pester -Path scripts/setup-whisper-windows.Tests.ps1` | `app/**` |
| ST-6b | `port/st6b-packaging` | electron-builder, first-run, login item, dist CI ([brief](briefs/ST-6-packaging-platform.md)) | `app/electron-builder.yml`, `app/build/**`, `app/src/main/{firstRun,loginItem}.ts`, `app/tests/dist-smoke/**`, dist job in CI yml, package.json `build`/`scripts.dist` keys only | wave-1 merges | `cd app && npm run dist && node tests/dist-smoke/check-artifacts.mjs` + CI dist job | all other package.json keys |
| ST-7 | `port/st7-e2e-soak` | Protocol E2E + soak (CORE AGENT) ([brief](briefs/ST-7-e2e-soak.md)) | `app/tests/e2e/{protocol,soak}/**`, `scripts/run-soak.sh` | Swift daemon first, then merged app | `cd app && npm run e2e:protocol && SOAK_CYCLES=50 npm run soak` | all `app/src/**` |

Integration seam decided now (not during execution): `app/src/main/daemon.ts` and
`app/src/main/index.ts` — the thin composition files that wire capture + transcription + ux +
history into the control-command handler — are owned by **you, the core agent**, and are
written/extended at merge gates as each subsystem lands (each subsystem exports a
registration hook per its brief). No sub-agent edits them. This removes the only file two
subtasks could otherwise contend on.

Waves: **Wave 0** (now, parallel): ST-1, ST-7-vs-Swift, ST-6a. **Wave 1** (after ST-1
merges, parallel — disjoint files): ST-2, ST-3, ST-4, ST-5. **Wave 2** (after wave 1):
ST-6b, plus you: integration in `daemon.ts`, then ST-7 run against Electron, then the full
`verify-port.sh` gate.

## 5. Roles & loop per subtask

Each subtask runs: **1 implementer → adversarial review → fixes → merge request.**

- The implementer receives its brief file (plus CONTEXT.md, RULES.md, AGENTS.md) and its
  brief ends with: *"Set your goal: make `<success command>` pass end-to-end. Iterate in
  your branch until it does."*
- Adversarial review runs in a **fresh context** that receives ONLY: the branch diff
  (`git diff feature/electron-port...port/stN-*`), the brief's success criteria, and the
  relevant acceptance fixtures — never the implementer's reasoning or chat. Instruction to
  the reviewer, verbatim: *"Assume this code is wrong. Find why. Look specifically for:
  semantics that drift from the referenced Swift/Lua source; tests that pass without
  exercising the claimed behavior; swallowed errors; fake/stubbed behavior standing in for
  real behavior; race conditions in the async paths; and violations of RULES.md. Report
  concrete defects with file:line."* Findings go back to the implementer for fixes; repeat
  until the reviewer finds nothing disqualifying.
- Implementers never review their own work. Reviewers never push fixes.

## 6. Merge gates (core agent's check-in points)

You do not babysit sub-agents. Between gates you work ST-7 and the integration seam. You
engage only when a sub-agent requests merge, and the gate is mechanical:

1. Check out the sub-branch tip fresh; run the brief's success command yourself. Paste
   output ≠ proof.
2. Verify the test floor: no test skipped/deleted/weakened (`git diff` on test files must
   be additive in coverage; `grep -rnE '\.(only|skip)\('` clean; fixture-count assertions
   intact; `shasum -c docs/electron-port/acceptance/fixtures.sha256` clean).
3. Verify ownership: `git diff --name-only feature/electron-port...HEAD` ⊆ the brief's
   owned files.
4. Wire the subsystem's registration hook into `daemon.ts`/`index.ts` (your files), run
   `test:unit` + the subtask suite on the merge result, merge (`--no-ff`), push, delete
   the sub-branch.
5. If anything fails, send it back with the failing output. If the same failure mode
   appears a second time anywhere, append a RULES.md amendment (§8).

## 7. Anti-gaming rules (verbatim; also in RULES.md)

- A test that is skipped, deleted, or weakened does not count as passing. The test set at
  plan time is the floor.
- Stubbing a function to make checks pass is failure, not progress.
- If a workaround needs a paragraph-long comment to justify it, the code is wrong — fix the
  code.
- Success commands are immutable once the plan is issued.

## 8. Failure & decision protocol

- Every key decision is already made: D1–D9 in CONTEXT.md, the toolchain, the port/paths
  coexistence scheme, the subtask boundaries, the integration seam, the history-store
  format, and the new `openSettings` command. If an unresolved decision surfaces during
  execution, that is a planning bug: **you decide immediately** (biasing toward the Swift
  implementation's behavior and toward reliability over convenience) and record the
  decision as D10, D11, … in CONTEXT.md in the same commit as the code it unblocks.
- **Amend, don't restart.** If the same failure mode appears twice (across agents or
  attempts), append a clarifying rule to RULES.md ("Amendments" section) on
  `feature/electron-port` and inject it into affected agents, which continue from their
  existing branches with progress intact. Amendments may clarify *how* to do the work; they
  may never narrow scope or weaken *what* success means.
- If an agent's branch becomes unrecoverable (broken beyond its own diff), spawn a
  replacement implementer on a fresh branch off `feature/electron-port` with the same brief
  plus a note on what killed the first attempt — the brief and success command never change.

## 9. Response format

On completion, reply with: the final `./scripts/verify-port.sh` output, the CI run URL for
the green `electron-ci.yml` matrix on the branch tip, the recorded real-whisper protocol+soak
output, and a short list of every RULES.md amendment and D-decision added during execution.
Do not open a PR to `main` or `developer`; stop at a fully green `feature/electron-port`.
