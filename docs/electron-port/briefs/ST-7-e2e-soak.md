# ST-7 — Protocol E2E + soak harness (CORE AGENT'S OWN TASK)

Branch: `port/st7-e2e-soak` off `feature/electron-port`. This is the core agent's
hardest-leverage work, done between merge gates. It starts IMMEDIATELY because of one key
property: the harness is protocol-level, so it can be built and validated against the
EXISTING Swift daemon on macOS before any Electron code exists. A harness that passes
against the Swift stack is a trustworthy referee for the Electron stack.

## Scope

- `app/tests/e2e/protocol/` — a black-box test suite that talks only through the control
  socket (via `app/bin/wdctl.mjs` once it exists; direct node:net JSON client until then)
  and the filesystem. Target selection by env: `WD_CONTROL_PORT` + `WD_TARGET=swift|electron`.
  Scenarios (each asserts on real payloads, not logs):
  1. status contract: all `StatusPayload` fields present with sane types; `engineReady`
     true within a startup budget.
  2. start → stop → next-result loop delivers exactly one result with metrics
     (audioDurationMilliseconds > 0, coverage fields populated).
  3. cancel delivers no result and pendingCount returns to 0.
  4. retry-robust: after a completed session, `retry-robust` enqueues and delivers a robust
     result; while recording it returns the documented error.
  5. overlapping results: two quick sessions back-to-back; both session ids round-trip via
     `next-result` with correct ordering semantics (per `SessionResultBuffer` rules).
  6. `next-result` with an unknown sessionId returns `resultAvailable:false` and discards
     nothing.
- `app/tests/e2e/soak/` — `npm run soak`: SOAK_CYCLES (default 50) start/speak/stop cycles
  (fake audio file via Chromium fake-mic flags on Electron; real prebuffered mic silence is
  acceptable against Swift). Hard assertions: every started session yields exactly one
  result; zero results lost or duplicated; pendingCount returns to 0 after each drain; the
  daemon process never restarts unexpectedly (compare pid at start/end unless a restart was
  policy-triggered and logged); wall-clock per-cycle latency recorded to a JSON report
  artifact (`soak-report.json`) with p50/p95 — the report file must be written and parseable
  for the run to count.
- Against Electron (after wave 1 merges): run the full protocol suite + soak with the fake
  whisper server AND once with real whisper.cpp locally on macOS; wire `e2e:protocol` into
  CI for both OSes using the fake server and fake mic.
- Validation gate for the harness itself: the protocol suite (minus `openSettings`) must
  pass against the running Swift daemon on the author's Mac before it is used to judge
  Electron work. Record that run's output in the merge request.

## Owned files

- `app/tests/e2e/protocol/**`, `app/tests/e2e/soak/**`, `scripts/run-soak.sh`

## Do NOT touch

Implementation directories (`app/src/**` except none), fixtures under
`docs/electron-port/acceptance/**`.

## Success command

```bash
cd app && npm run e2e:protocol && SOAK_CYCLES=50 npm run soak
```
(against the Electron app with fake mic + fake whisper server; plus one recorded local run
against real whisper.cpp on macOS.)

Set your goal: make the success command pass end-to-end. Iterate in your branch until it does.
