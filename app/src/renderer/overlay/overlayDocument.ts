import type { TranscriptionProfile } from "../../core/controlProtocol.js";
import { UX_CONTRACT } from "../../main/ux/uxContract.js";

export interface OverlayRenderState {
  recording: { profile: TranscriptionProfile; label: string } | null;
  alert: string | null;
}

export function createOverlayDocument(): string {
  const contract = JSON.stringify(UX_CONTRACT).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>WhisperDictation Overlay</title>
    <style>
      :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; user-select: none; }
      #surface { width: 100%; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 8px; }
      #alert { min-height: 42px; max-width: 100%; padding: 10px 18px; border-radius: 21px; background: rgba(20, 20, 20, 0.88); color: rgba(255,255,255,0.95); font-size: 19px; line-height: 22px; text-align: center; white-space: nowrap; }
      #pill { display: flex; align-items: center; flex: 0 0 auto; background: rgba(20, 20, 20, 0.85); }
      #dot { flex: 0 0 auto; border-radius: 50%; }
      #label { flex: 1 1 auto; color: rgba(255,255,255,0.95); text-align: center; white-space: nowrap; }
      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main id="surface" aria-live="polite">
      <div id="alert" role="status" hidden></div>
      <div id="pill" data-testid="recording-pill" hidden>
        <span id="dot" data-testid="recording-dot"></span>
        <span id="label"></span>
      </div>
    </main>
    <script>
      const contract = ${contract};
      const pill = document.querySelector("#pill");
      const dot = document.querySelector("#dot");
      const label = document.querySelector("#label");
      const alertNode = document.querySelector("#alert");
      const rgba = contract.overlay.dotColorRGBA;
      const white = contract.overlay.backgroundWhiteAlpha;
      pill.style.height = contract.overlay.heightPx + "px";
      pill.style.borderRadius = (contract.overlay.heightPx / 2) + "px";
      pill.style.background = "rgba(" + Math.round(white[0] * 255) + "," + Math.round(white[0] * 255) + "," + Math.round(white[0] * 255) + "," + white[1] + ")";
      dot.style.width = (contract.overlay.dotRadiusPx * 2) + "px";
      dot.style.height = (contract.overlay.dotRadiusPx * 2) + "px";
      dot.style.marginLeft = (22 - contract.overlay.dotRadiusPx) + "px";
      dot.style.marginRight = (10 - contract.overlay.dotRadiusPx) + "px";
      dot.style.background = "rgba(" + Math.round(rgba[0] * 255) + "," + Math.round(rgba[1] * 255) + "," + Math.round(rgba[2] * 255) + "," + rgba[3] + ")";
      label.style.fontSize = contract.overlay.labelTextSizePx + "px";
      label.style.paddingRight = "12px";

      window.whisperOverlay = {
        render(state) {
          if (state.recording) {
            const width = state.recording.profile === "robust"
              ? contract.overlay.widthRobustPx
              : contract.overlay.widthFastPx;
            pill.style.width = width + "px";
            label.textContent = state.recording.label;
            pill.hidden = false;
          } else {
            pill.hidden = true;
            label.textContent = "";
          }
          alertNode.textContent = state.alert || "";
          alertNode.hidden = !state.alert;
          document.body.dataset.visible = state.recording || state.alert ? "true" : "false";
        }
      };
      window.whisperOverlay.render({ recording: null, alert: null });
    </script>
  </body>
</html>`;
}

export function overlayDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(createOverlayDocument())}`;
}
