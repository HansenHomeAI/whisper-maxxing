import { app, Menu, nativeImage, Tray } from "electron";

export interface TrayControllerOptions {
  openSettings(): Promise<void>;
  onError(error: Error): void;
}

export function createTray(options: TrayControllerOptions): Tray {
  const tray = new Tray(createTrayImage());
  tray.setToolTip("WhisperDictation");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Open Settings",
        click: () => {
          void options.openSettings().catch((error: unknown) => {
            options.onError(asError(error));
          });
        },
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", () => {
    void options.openSettings().catch((error: unknown) => {
      options.onError(asError(error));
    });
  });
  return tray;
}

function createTrayImage(): Electron.NativeImage {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">',
    '<path fill="white" d="M9 1.5a3 3 0 0 0-3 3v4a3 3 0 1 0 6 0v-4a3 3 0 0 0-3-3Zm-5 7a1 1 0 0 1 2 0 3 3 0 1 0 6 0 1 1 0 1 1 2 0 5 5 0 0 1-4 4.9V15h2a1 1 0 1 1 0 2H6a1 1 0 1 1 0-2h2v-1.6A5 5 0 0 1 4 8.5Z"/>',
    "</svg>",
  ].join("");
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
  image.setTemplateImage(true);
  return image;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
