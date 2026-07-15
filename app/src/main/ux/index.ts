export { DictationController, type DictationSnapshot } from "./dictationController.js";
export {
  registerSystemUxHotkeys,
  registerUxHotkeys,
  HOTKEY_ACCELERATORS,
} from "./hotkeys.js";
export { normalizeTranscript } from "./normalizeTranscript.js";
export { OverlayWindow, overlayBounds } from "./overlayWindow.js";
export { PasteEngine, createSystemPasteEngine } from "./pasteEngine.js";
export type {
  AlertSink,
  ControlClient,
  Logger,
  OverlaySink,
  PasteEnginePort,
  ReplacementTarget,
  Scheduler,
} from "./types.js";
export { UX_CONTRACT, UX_MILLISECONDS, withPendingCount } from "./uxContract.js";
