import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";
import { build } from "vite";

import { sendJSONSocketRequest } from "../../../src/core/jsonSocket.js";

const appRoot = path.resolve(import.meta.dirname, "../../..");

test("control start and stop show a pixel-verified recording pill", async ({}, testInfo) => {
  await build({
    configFile: path.join(appRoot, "vite.config.ts"),
    logLevel: "silent",
  });
  const rendererPath = path.join(appRoot, "dist-renderer", "overlay", "index.html");
  await assertProductionRenderer(rendererPath);
  const electronApp = await electron.launch({
    args: ["tests/ux/fixtures/overlayHarness.cjs"],
    env: {
      ...process.env,
      WD_E2E_OVERLAY_URL: pathToFileURL(rendererPath).href,
    },
  });
  try {
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

    const startResponse = await sendJSONSocketRequest(
      { command: "start" },
      "127.0.0.1",
      controlPort,
    );
    expect(startResponse.ok).toBe(true);
    const page = await electronApp.firstWindow();
    await expect(page).toHaveTitle("WhisperDictation Overlay");
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

    const placement = await electronApp.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error("Overlay window is missing");
      }
      return {
        actual: window.getBounds(),
        workArea: screen.getPrimaryDisplay().workArea,
        focusable: window.isFocusable(),
      };
    });
    expect(placement.focusable).toBe(false);
    expect(placement.actual.x).toBe(
      Math.round(placement.workArea.x + (placement.workArea.width - 520) / 2),
    );
    expect(placement.actual.y).toBe(
      Math.round(placement.workArea.y + placement.workArea.height - 100 - 20),
    );

    const stopResponse = await sendJSONSocketRequest(
      { command: "stop" },
      "127.0.0.1",
      controlPort,
    );
    expect(stopResponse.ok).toBe(true);
    await expect(page.getByTestId("recording-pill")).toBeHidden();
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

async function assertProductionRenderer(rendererPath: string): Promise<void> {
  const html = await readFile(rendererPath, "utf8");
  expect(html).toContain("WhisperDictation Overlay");
  expect(html).not.toContain("main.ts");
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((reference): reference is string => reference !== undefined);
  expect(references.length).toBeGreaterThan(0);
  for (const reference of references) {
    expect(reference.startsWith("/")).toBe(false);
    await expect(
      access(path.resolve(path.dirname(rendererPath), reference)),
    ).resolves.toBeUndefined();
  }
}
