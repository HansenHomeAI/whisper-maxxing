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

### A5 — A built test target is not an executed test target

The native package twice returned success from `swift test` while the active Command Line
Tools installation discovered and ran zero tests. ST-M1 is not mergeable unless the
immutable command visibly executes a nonzero, inventory-pinned set of substantive helper
tests and fails if discovery or execution returns zero. Compiling test sources or relying
only on the helper's protocol self-test does not satisfy this rule. A package-local harness
may compensate for toolchain discovery differences, but it must execute the same test
inventory on both Command Line Tools and full-Xcode CI without changing the acceptance
wrapper or silently double-skipping either path.

### A6 — A4 supersedes A3's direct IOProc requirement

A3 selected a direct HAL IOProc before the decisive launch-context result was understood.
The unchanged historical AVAudioEngine capture produced real PCM and zero large orange
components when its microphone-owning process was launched in the GUI launchd domain,
while the hardened direct-IOProc worker repeatedly blocked in
`AudioDeviceCreateIOProcID` before readiness. The launchd worker must therefore return to
the plan's AVAudioEngine-first capture path; A4's supervisor/worker boundary is the behavior
that suppresses the large pill. If the final packaged live pixel gate disproves that result,
replace AVAudioEngine with AUHAL inside the same worker as the original plan requires. Do
not return to direct IOProc, change the protocol or queue bound, add renderer fallback, or
relax any visual, PCM, lifecycle, or Windows gate.

### A7 — The supervisor owns bounded launchd cleanup at every phase

Launchd-job leakage has recurred during worker startup and permission-blocked capture. A
SIGTERM received before submit, during PID discovery, during socket accept, or after the
worker connects must cancel that phase and remove the submitted job, worker process,
socket, and private directory before the Electron adapter's one-second grace expires. The
same bound applies when the worker cannot consume its control byte. Every launchctl
removal failure or filesystem-cleanup failure must be observable on stderr and through a
nonzero helper outcome; cleanup errors may not be swallowed. Cancellation and cleanup
must still produce one byte-complete terminal protocol frame—never a partial frame or a
second terminal. Tests must exercise the before-submit, after-submit/before-connect, and
connected-but-unresponsive races rather than relying on the normal fast startup path.

### A8 — The worker owns orphan cleanup and stopped is the only terminal frame

Supervisor-SIGKILL leakage recurred after A4: socket EOF stopped the launchd worker but
left both its submitted label and private `/tmp/wmc-*` directory behind. The worker must
distinguish a graceful supervisor control byte from orphaning socket EOF. On EOF it removes
the private directory and its own launchd job without supervisor participation; normal
shutdown remains race-safe with the supervisor's A7 cleanup. A real connected-worker test
must SIGKILL the supervisor and prove the worker, job, socket, and directory all disappear.
The Electron parser's existing acceptance floor also fixes the complete stream order as
`ready`, zero or more `pcm`, optional `error`, then exactly one `stopped`; `error` is not a
terminal frame, and neither startup cancellation nor startup failure may emit `stopped`
before `ready`.
