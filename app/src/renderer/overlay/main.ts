import { UX_CONTRACT } from "../../main/ux/uxContract.js";

import type { OverlayRenderState } from "./types.js";

const pill = requiredElement<HTMLDivElement>("#pill");
const dot = requiredElement<HTMLSpanElement>("#dot");
const label = requiredElement<HTMLSpanElement>("#label");
const alertNode = requiredElement<HTMLDivElement>("#alert");
const rgba = UX_CONTRACT.overlay.dotColorRGBA;
const white = UX_CONTRACT.overlay.backgroundWhiteAlpha;

pill.style.height = `${UX_CONTRACT.overlay.heightPx}px`;
pill.style.borderRadius = `${UX_CONTRACT.overlay.heightPx / 2}px`;
pill.style.background = `rgba(${Math.round(white[0] * 255)}, ${Math.round(
  white[0] * 255,
)}, ${Math.round(white[0] * 255)}, ${white[1]})`;
dot.style.width = `${UX_CONTRACT.overlay.dotRadiusPx * 2}px`;
dot.style.height = `${UX_CONTRACT.overlay.dotRadiusPx * 2}px`;
dot.style.marginLeft = `${22 - UX_CONTRACT.overlay.dotRadiusPx}px`;
dot.style.marginRight = `${10 - UX_CONTRACT.overlay.dotRadiusPx}px`;
dot.style.background = `rgba(${Math.round(rgba[0] * 255)}, ${Math.round(
  rgba[1] * 255,
)}, ${Math.round(rgba[2] * 255)}, ${rgba[3]})`;
label.style.fontSize = `${UX_CONTRACT.overlay.labelTextSizePx}px`;
label.style.paddingRight = "12px";

window.whisperOverlay = {
  render(state: OverlayRenderState) {
    if (state.recording) {
      const width =
        state.recording.profile === "robust"
          ? UX_CONTRACT.overlay.widthRobustPx
          : UX_CONTRACT.overlay.widthFastPx;
      pill.style.width = `${width}px`;
      label.textContent = state.recording.label;
      pill.hidden = false;
    } else {
      pill.hidden = true;
      label.textContent = "";
    }
    alertNode.textContent = state.alert ?? "";
    alertNode.hidden = state.alert === null;
    document.body.dataset.visible = state.recording || state.alert ? "true" : "false";
  },
};
window.whisperOverlay.render({ recording: null, alert: null });

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`Overlay element is missing: ${selector}`);
  }
  return element;
}
