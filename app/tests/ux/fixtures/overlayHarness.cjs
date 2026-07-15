const { app, BrowserWindow } = require("electron");
const net = require("node:net");

const documentUrl = process.env.OVERLAY_DOCUMENT;
if (!documentUrl) {
  throw new Error("OVERLAY_DOCUMENT is required");
}

let server;

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: 520,
    height: 100,
    show: false,
    frame: false,
    transparent: true,
    focusable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setIgnoreMouseEvents(true);
  await window.loadURL(documentUrl);

  server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline));
      if (request.command === "start") {
        await window.webContents.executeJavaScript(
          'window.whisperOverlay.render({recording:{profile:"fast",label:"Recording"},alert:null})',
        );
        window.showInactive();
        socket.end('{"ok":true}\n');
        return;
      }
      if (request.command === "stop") {
        await window.webContents.executeJavaScript(
          "window.whisperOverlay.render({recording:null,alert:null})",
        );
        window.hide();
        socket.end('{"ok":true}\n');
        return;
      }
      socket.end('{"ok":false,"error":"unknown command"}\n');
    });
    socket.on("error", (error) => console.error("overlay control socket error", error));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to read overlay control address");
  }
  globalThis.__overlayControlPort = address.port;
});

app.on("before-quit", () => server?.close());
