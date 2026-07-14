# ST-2 — Transcription pipeline (the reliability heart)

Branch: `port/st2-transcription` off `feature/electron-port` (launch AFTER ST-1 merges).
Read `docs/electron-port/CONTEXT.md` and `RULES.md` first. Follow repo-root `AGENTS.md`.

## Scope

Port `Sources/whisper-dictation-daemon/TranscriptionManager.swift` (read all 1413 lines) to
`app/src/main/transcription/`. Preserve the full ladder:

- whisper-server process lifecycle per profile (fast/robust): spawn, health-check, prewarm
  (robust lazy unless `warmRobustServerOnLaunch`), stale-process cleanup on the configured
  port, server state machine exposed as `currentServerState(profile)` strings matching the
  Swift values (`stopped`, `starting`, `ready`, `failed` — verify exact strings in the Swift
  source).
- HTTP inference with `serverRequestTimeoutSeconds` / `robustServerRequestTimeoutSeconds`.
- CLI fallback via `whisper-cli` with `cliTimeoutSeconds` when the server path fails, and
  after no-speech server results (mirror the Swift flow exactly).
- Capture-integrity gate before transcription (fail with salvage, `capture-duration-gap` /
  `capture-stalled` reasons in `errorMessage`).
- Transcript-quality gate after transcription (`requiresSecondPass` ⇒ robust/CLI second pass;
  low-confidence result carries diagnostic + salvage exactly like `lowConfidenceResult`).
- Salvage persistence (WAV + diagnostic JSON) to the configured salvage directory; successful
  captures retained in memory for `retryRobust`; `persistRecentCaptures` opt-in behavior.
- Serial pending queue with `pendingCount()`, results delivered via completion callback with
  full `SessionMetrics` (queueWaitMilliseconds, transcriptionMilliseconds, mode strings).

Inject the transport (HTTP fetcher, process spawner, clock) so everything is testable.

**Test fakes you own** (shared infra others will reuse):
- `app/tests/fakes/fake-whisper-server.ts` — scriptable HTTP fake: fixed transcripts
  (including caller nonces), delays, 5xx, hang-forever, refuse-connection.
- `app/tests/fakes/fake-whisper-cli.mjs` — script that emits a scripted transcript or error.

**Tests** in `app/tests/pipeline/` (vitest, suite `test:pipeline`), covering at minimum:
happy path; server timeout → CLI fallback succeeds; server + CLI both fail → error result
with salvage, never a silent drop; quality gate triggers second pass and second-pass result
wins; second pass still bad → low-confidence result with salvage; capture-integrity failure →
no inference call made; retry-robust re-enqueues last capture; robust model unconfigured →
clear error; queue processes N sessions in order with exactly one result each. Assert on the
actual `SessionResultPayload` objects and on salvage files existing on disk with the right
contents — not on log lines. Use nonce transcripts from the fake so expected text cannot be
hardcoded in the implementation.

## Owned files

- `app/src/main/transcription/**`
- `app/tests/pipeline/**`
- `app/tests/fakes/fake-whisper-server.ts`, `app/tests/fakes/fake-whisper-cli.mjs`

## Do NOT touch

`app/src/core/**` (request core changes at the merge gate), `app/package.json`, anything
outside `app/`, other subtasks' directories.

## Success command

```bash
cd app && npm run typecheck && npm run test:pipeline
```

Set your goal: make the success command pass end-to-end. Iterate in your branch until it does.
