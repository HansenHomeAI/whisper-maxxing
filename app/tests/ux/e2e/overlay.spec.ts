import net from "node:net";

import { _electron as electron, expect, test } from "@playwright/test";

import { overlayDataUrl } from "../../../src/renderer/overlay/overlayDocument.js";

test("control start and stop show a pixel-verified recording pill", async ({}, testInfo) => {
  const electronApp = await electron.launch({
    args: ["tests/ux/fixtures/overlayHarness.cjs"],
    env: { ...process.env, OVERLAY_DOCUMENT: overlayDataUrl() },
  });
  try {
    const page = await electronApp.firstWindow();
    const readControlPort = () =>
      electronApp.evaluate(() => {
        return (
          globalThis as typeof globalThis & { __overlayControlPort?: number }
        ).__overlayControlPort;
      });
    await expect.poll(readControlPort).toBeGreaterThan(0);
    const controlPort = await readControlPort();
    if (controlPort === undefined) {
      throw new Error("Overlay control port was not published");
    }

    await sendControl(controlPort, "start");
    await expect(page.getByTestId("recording-pill")).toBeVisible();
    await expect(page.getByTestId("recording-pill")).toContainText("Recording");
    await page.screenshot({ path: testInfo.outputPath("recording-overlay.png") });

    const redPixels = await electronApp.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error("Overlay window is missing");
      }
      const image = await window.capturePage();
      const bitmap = image.toBitmap();
      const size = image.getSize();
      const scale = size.width / 520;
      const centerX = Math.round(207 * scale);
      const centerY = Math.round(79 * scale);
      const radius = Math.round(10 * scale);
      let count = 0;
      for (let y = centerY - radius; y <= centerY + radius; y += 1) {
        for (let x = centerX - radius; x <= centerX + radius; x += 1) {
          const offset = (y * size.width + x) * 4;
          const blue = bitmap[offset] ?? 0;
          const green = bitmap[offset + 1] ?? 0;
          const red = bitmap[offset + 2] ?? 0;
          const alpha = bitmap[offset + 3] ?? 0;
          if (red > 180 && green < 120 && blue < 120 && alpha > 100) {
            count += 1;
          }
        }
      }
      return count;
    });
    expect(redPixels).toBeGreaterThan(50);

    await sendControl(controlPort, "stop");
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) =>
          Boolean(BrowserWindow.getAllWindows()[0]?.isVisible()),
        ),
      )
      .toBe(false);
  } finally {
    await electronApp.close();
  }
});

async function sendControl(port: number, command: "start" | "stop"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
      socket.write(`${JSON.stringify({ command })}\n`);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      try {
        const decoded = JSON.parse(response) as { ok?: boolean };
        if (!decoded.ok) {
          reject(new Error(`Control command failed: ${response}`));
          return;
        }
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}
