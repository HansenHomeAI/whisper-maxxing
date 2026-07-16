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
