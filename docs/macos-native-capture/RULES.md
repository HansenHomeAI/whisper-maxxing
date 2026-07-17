# RULES — Native macOS capture

Follow repo-root `AGENTS.md`. This branch is the user-authorized child feature branch and
merges only into `feature/macos-native-capture`. Sub-agents use separate worktrees and own
only the files in their brief. Never stash, reset, rebase, clean, or rewrite history.

## Anti-gaming rules

- A test that is skipped, deleted, or weakened does not count as passing. The test set at plan time is the floor.
- Stubbing a function to make checks pass is failure, not progress.
- If a workaround needs a paragraph-long comment to justify it, the code is wrong — fix the code.
- Success commands are immutable once the plan is issued.

## Binding implementation rules

- Do not edit the existing renderer capture implementation or Swift reference stack.
- Acceptance files pinned by `acceptance/acceptance-floor.sha256` are immutable.
- Runtime capture errors must reach the existing user-visible alert/health path.
- No automatic macOS fallback to renderer capture.
- No new runtime network access, telemetry, or audio persistence.
- Windows must not require or invoke Swift and must keep renderer capture.
- stdout from the native helper is protocol-only; stderr is logging-only.
- No `.only(` or `.skip(`.

## Amendments

The core agent may append clarifications after a failure mode repeats twice. An amendment
may clarify implementation but never narrow scope or weaken acceptance.

### A1 — The final helper must use AUHAL input

Two real AVAudioEngine capture checks produced inconsistent menu-bar results; the merge-gate
run at ST-M1 SHA `018dbacf7b81b4ee10e4ca43b1565b7730cae7bc` conclusively produced a
`80×48` pixel orange component (`2×` scale, `2,909` pixels) and the visible large Mic
Mode pill. The helper must therefore use AUHAL for input capture. AVAudioEngine may not
remain as the capture primitive or an automatic fallback. ST-M1 is not mergeable until a
fresh baseline-subtracted pinned-probe run reports zero large components while the same run
proves real nonzero PCM and a clean stopped frame.

### A2 — Keep the AUHAL client stream at the protocol format

The AUHAL variant that requested 16 kHz mono signed Int16 directly on output scope, input
element 1 passed the pinned pixel gate. Reconfiguring that same AUHAL to expose the device's
native sample rate and adding a separate sample-rate-conversion worker reproduced the
`80×48` large orange component. The final helper must therefore request the protocol's
16 kHz mono signed Int16 format directly from AUHAL and must not add a device-rate staging
queue. A device that rejects this client format is a visible native-helper error; it is not
permission to fall back to AVAudioEngine or Electron capture.

### A3 — A2 is superseded; prove direct HAL device input

A2 reconstructed the earlier passing experiment incorrectly. On the actual 48 kHz default
device, a 16 kHz AUHAL client starts but the first render fails with
`kAudioUnitErr_CannotDoInCurrentContext` (`-10863`) and emits no PCM; Apple's AUHAL
contract requires separate sample-rate conversion. The device-rate AUHAL plus conversion
produces real PCM but has repeatedly reproduced the large pill. The pathfinder must now use
the lower Core Audio device IOProc API (`AudioDeviceCreateIOProcID`/`AudioDeviceStart`) and
prove the unchanged zero-large-component plus real-PCM gate. This amendment supersedes A2's
mandated client format, but not its prohibition on AVAudioEngine/Electron fallback or any
acceptance criterion.

### A4 — Separate the protocol supervisor from the launchd capture worker

Direct shell/child capture reproduces the large pill even with the unchanged historical
native Swift daemon, while the same daemon launched as a GUI-domain launchd job produces
real PCM and only the small privacy dot. The Electron child must therefore remain a bounded
protocol supervisor named `whisper-mac-capture`, while a launchd-owned same-binary worker is
the only process that opens the microphone. They communicate over a private local socket.
TERM must yield a valid stopped frame; supervisor SIGKILL/socket EOF must make the worker
stop and remove its submitted launchd job; application quit must leave neither process nor
job. This is local process isolation only: no network listener, telemetry, retained audio,
renderer fallback, permission change, or visual-test relaxation is allowed.
