import type { WhisperOverlayApi } from "./types.js";

declare global {
  interface Window {
    whisperOverlay: WhisperOverlayApi;
  }
}

export {};
