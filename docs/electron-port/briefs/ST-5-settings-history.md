# ST-5 — Settings & history window

Branch: `port/st5-settings-history` off `feature/electron-port` (launch AFTER ST-1 merges).
Read `docs/electron-port/CONTEXT.md` and `RULES.md` first. Follow repo-root `AGENTS.md`.

## Scope

The one genuinely new feature of the port:

- **History store** (`app/src/main/history/historyStore.ts`): append-only `history.jsonl` in
  `app.getPath('userData')` (path injectable for tests). One JSON object per successful
  dictation: `{ sessionId, text, profile, completedAt, audioDurationMilliseconds,
  transcriptionMilliseconds, transcriptionMode }`. Text + metrics only — NEVER audio, never
  salvage contents. Enabled by default via a new optional config key `persistHistory`
  (default `true`); cap 1000 entries (compact oldest-first on append past cap);
  `clear()` truncates the file. Corrupt lines are skipped on read, never crash.
- **Control command `openSettings`** (wire verb per CONTEXT.md): register in the daemon's
  command handler (coordinate: the handler lives in `app/src/main/daemon.ts` — if ST-2/ST-4
  own adjacent code, add your handler via a registration hook exported from your module and
  request the one-line wiring at the merge gate rather than editing shared files).
- **Settings window** (`app/src/renderer/settings/`): normal BrowserWindow (reuse-focus if
  already open). Contents: history list newest-first (text, relative time, profile badge,
  duration, transcription ms), search-as-you-type filter, per-entry Copy button, Clear
  History button (confirmation dialog), and a read-only view of the active config (loaded
  from the main process; secrets none). Match the product's minimal dark aesthetic (the
  overlay pill style: near-black, rounded, white text).
- **Tray**: minimal tray icon with "Open Settings" and "Quit".

**Tests**:
- Store unit tests in `app/tests/settings/` (suite `test:settings`, script already defined
  by ST-1): append/read round-trip, cap at 1000, clear truncates, corrupt line skipped,
  disabled flag writes nothing.
- Playwright E2E (`e2e:settings`): launch the app with a seeded temp `history.jsonl`
  containing nonce transcripts generated at test runtime; send `open-settings` through the
  control socket with `app/bin/wdctl.mjs`; assert the window opens and the DOM shows the
  nonce texts in order; type in search and assert filtering; click Clear and assert both the
  DOM is empty and the file on disk is truncated. Nonces make hardcoded-DOM stubbing fail.

## Owned files

- `app/src/main/history/**`, `app/src/renderer/settings/**`, `app/src/main/tray.ts`
- `app/tests/settings/**`
- `app/bin/wdctl.mjs` (you own the new CLI; keep verbs identical to the Swift ctl + `open-settings`)

## Do NOT touch

`app/src/core/**`, `app/src/main/transcription/**`, `app/src/main/capture/**`,
`app/src/main/ux/**`, `app/package.json`, other subtasks' directories.

## Success command

```bash
cd app && npm run typecheck && npm run test:settings && npm run e2e:settings
```

Set your goal: make the success command pass end-to-end. Iterate in your branch until it does.
