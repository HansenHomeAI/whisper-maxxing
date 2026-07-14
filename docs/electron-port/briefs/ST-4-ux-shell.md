# ST-4 — UX shell: hotkeys, overlay, alerts, paste, result polling

Branch: `port/st4-ux-shell` off `feature/electron-port` (launch AFTER ST-1 merges).
Read `docs/electron-port/CONTEXT.md` and `RULES.md` first. Follow repo-root `AGENTS.md`.

## Scope

Port `hammerspoon/init.lua` to `app/src/main/ux/` + `app/src/renderer/overlay/`. The contract
is `docs/electron-port/acceptance/ux-parity.json` — import every string/timing/geometry value
from a single constants module (`app/src/main/ux/uxContract.ts`) and write a unit test that
loads the fixture file and asserts the module matches it value-for-value.

- **State machine** (`dictationController.ts`): idle/starting/recording/stopping states,
  toggle semantics, cancel, retry-robust guard ("Stop Recording First"), pending session
  tracking, replacement-target bookkeeping — a 1:1 port of the Lua logic including the
  watchdog reconciliation (`watchDaemonStatus`) and `restoreState` on launch. Pure logic,
  dependency-injected (control client, clock, alert sink, paste engine) — fully unit-testable.
- **normalizeTranscript** ported 1:1; driven by
  `docs/electron-port/acceptance/normalize-transcript-cases.json` (execute all cases, assert
  the count).
- **Hotkeys**: `globalShortcut` — `CommandOrControl+.`, `CommandOrControl+;`,
  `CommandOrControl+,` (macOS must resolve to Command).
- **Overlay + alerts renderer**: one transparent, frameless, always-on-top, click-through,
  non-activating BrowserWindow; recording pill per the fixture geometry; alert toasts with
  the fixture's duration/format (including the ` (N)` pending suffix).
- **Paste engine** (`pasteEngine.ts`): clipboard write + platform keystroke helper
  (macOS `osascript` System Events; Windows PowerShell `SendInput` helper committed under
  `app/resources/win/`), frontmost-app identity probe, undo-replace flow per the fixture's
  `behavior.undoReplace`. Injectable executor so tests assert the exact command sequence
  (undo → delay → paste) without touching the real clipboard.
- **Result poller**: 150 ms `nextResult` loop while pending, stop at zero; health-warning
  throttle 300 s.

**Tests** in `app/tests/ux/` (suite `test:ux`): fixture-driven contract + normalize tests;
state-machine tests (double-start shows "Recording" alert and doesn't double-send; stop
enqueues pending and starts polling; cancel path; retry-robust while recording; watchdog
resync when daemon state drifts; error result surfaces `errorMessage`); paste-engine tests
(undo-replace only within window + same app; expired window pastes normally; clipboard set
before keystroke). Plus one Playwright E2E (`e2e:overlay`): drive start/stop via the control
socket, assert the overlay window becomes visible with the "Recording" pill (screenshot the
overlay window and assert red-dot pixels present at the expected coordinates) and disappears
after stop.

## Owned files

- `app/src/main/ux/**`, `app/src/renderer/overlay/**`, `app/resources/win/**`
- `app/tests/ux/**`

## Do NOT touch

`app/src/core/**`, `app/src/main/transcription/**`, `app/src/main/capture/**`,
`app/package.json`, other subtasks' directories.

## Success command

```bash
cd app && npm run typecheck && npm run test:ux
```

Set your goal: make the success command pass end-to-end. Iterate in your branch until it does.
