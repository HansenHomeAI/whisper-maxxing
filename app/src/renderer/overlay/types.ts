import type { TranscriptionProfile } from "../../core/controlProtocol.js";

export interface OverlayRenderState {
  recording: { profile: TranscriptionProfile; label: string } | null;
  alert: string | null;
}

export interface WhisperOverlayApi {
  render(state: OverlayRenderState): void;
}
