# PLAN — Native macOS capture without the large Mic Mode pill

This plan is self-contained. The core agent and every sub-agent must follow the repo-root
`AGENTS.md`, this directory's `CONTEXT.md`, and `RULES.md`. The branch is
`feature/macos-native-capture`, created from `feature/electron-port` at
`e9239753c50bfd34cf526e85dbd82995728eebf2`. This user-authorized feature branch is the
only merge target; do not open a PR or merge it into `feature/electron-port`, `developer`,
or `main`.

## 0. Objective and immutable Definition of Done

Use a bundled native Swift/Core Audio helper for continuous capture on macOS while retaining
the existing Electron renderer capture path on Windows. Preserve one-second prebuffer,
shortcuts, overlay, transcription, and live history. The small macOS privacy dot may remain;
the large orange Mic Mode pill must not.

```bash
test "$(git branch --show-current)" = "feature/macos-native-capture"
git merge-base --is-ancestor e9239753c50bfd34cf526e85dbd82995728eebf2 HEAD
git diff --exit-code e9239753c50bfd34cf526e85dbd82995728eebf2 -- \
  Sources Tests Package.swift hammerspoon launchd \
  app/src/main/capture/rendererCaptureSource.ts app/src/renderer/capture
./scripts/verify-port.sh
./scripts/verify-macos-native-capture.sh
./scripts/verify-macos-native-capture-live.sh
./scripts/verify-electron-ci-tip.sh feature/macos-native-capture "$(git rev-parse HEAD)"
```

Expected final lines are respectively `ALL GATES PASSED`,
`MACOS NATIVE CAPTURE GATES PASSED`, `MACOS LIVE MIC INDICATOR GATE PASSED`, and
`ELECTRON CI TIP MATRIX PASSED: <url>`.

## 1. Branch topology and worktrees

All work accumulates on `feature/macos-native-capture`. Each implementer uses a separate
sibling worktree and its named branch. Commit only owned files. Never use `git stash`,
`git reset`, `git rebase`, `git clean`, history rewrites, or commands that alter another
worktree. Preserve the user's untracked `app/build/icon 2.svg`.

## 2. Prep acceptance floor

The core agent owns this plan, `CONTEXT.md`, `RULES.md`, briefs, the files under
`acceptance/`, `app/tests/acceptance/macos-native-capture/`, and all acceptance scripts.
They are pinned by `acceptance/acceptance-floor.sha256` and may not be changed after the
prep commit. The tests deliberately fail before implementation.

## 3. Pathfinder and waves

Wave 0 runs ST-M1, ST-M2, and ST-M3 in parallel while core owns config, composition,
status, and live integration. ST-M1 is the pathfinder. After ST-M1 passes its real macOS
helper gate, merge it and record findings in `CONTEXT.md`. ST-M4 starts only after ST-M1
and ST-M3 merge. Every subtask runs implementer, fresh adversarial review, fixes, and a
mechanical core merge gate.

## 4. Subtasks

| ID | Branch | Owned files | Success command |
|---|---|---|---|
| ST-M1 | `mac-capture/st1-native-helper` | `app/native/macos-capture/**` | `./scripts/accept-st-m1-native-helper.sh` |
| ST-M2 | `mac-capture/st2-electron-adapter` | new native files in `app/src/main/capture/**` and capture `index.ts` | `./scripts/accept-st-m2-electron-adapter.sh` |
| ST-M3 | `mac-capture/st3-build-orchestrator` | `app/scripts/build-native-capture.mjs` and its non-acceptance tests | `./scripts/accept-st-m3-build-orchestrator.sh` |
| ST-M4 | `mac-capture/st4-packaging-ci` | builder config, optional afterPack hook, dist smoke, Electron CI | `./scripts/accept-st-m4-packaging-ci.sh` |

## 5. Review loop

Review receives only the diff, criteria, contract, and rules. It must assume the code is
wrong and look for fake capture, a visual detector that can pass without its positive
control, silent PCM loss, malformed-frame bugs, leaks, swallowed errors, macOS renderer
fallback, Windows Swift invocation, reference-source changes, and weakened tests.
Implementers never review themselves; reviewers never push fixes.

## 6. Merge gates

At each request the core runs the immutable command, verifies pinned acceptance hashes and
ownership, confirms a fresh review is clean, merges with `--no-ff`, reruns the subtask plus
typecheck, and pushes. ST-M1 additionally requires real helper capture. ST-M4 requires a
launchable bundled helper on macOS and no helper in Windows output.

## 7. Anti-gaming rules

- A test that is skipped, deleted, or weakened does not count as passing. The test set at plan time is the floor.
- Stubbing a function to make checks pass is failure, not progress.
- If a workaround needs a paragraph-long comment to justify it, the code is wrong — fix the code.
- Success commands are immutable once the plan is issued.

## 8. Failure and decisions

Decisions D28 onward are binding. AVAudioEngine is first; if the real visual pathfinder
still detects the large pill, replace only the helper's capture primitive with AUHAL while
preserving the protocol. Never fall back automatically to Electron capture. If one failure
mode repeats twice, append a clarification to `RULES.md` and continue existing branches.
Clarifications may not narrow scope or weaken any command.

## 9. Completion response

Report final command outputs, exact tip SHA, green CI URL, live artifact paths and SHA-256
hashes, and any appended decisions/rules. Stop at the green feature branch without a PR.
