require("tsx/cjs");

const { app } = require("electron");
const { JSONSocketServer, sendJSONSocketRequest } = require("../../../src/core/jsonSocket.ts");
const { DictationController } = require("../../../src/main/ux/dictationController.ts");
const { OverlayWindow } = require("../../../src/main/ux/overlayWindow.ts");

const rendererUrl = process.env.WD_E2E_OVERLAY_URL;
if (!rendererUrl) {
  throw new Error("WD_E2E_OVERLAY_URL is required");
}

let backendServer;
let uxServer;
let overlay;

function daemonStatus(recording, profile = null) {
  return {
    recording,
    recordingProfile: profile,
    pendingCount: 0,
    engineReady: true,
    prebufferAvailableMilliseconds: 1_000,
    serverState: "ready",
  };
}

async function startHarness() {
  await app.whenReady();
  let recording = false;
  let profile = "fast";

  backendServer = new JSONSocketServer("127.0.0.1", 0, async (request) => {
    switch (request.command) {
      case "warmup":
        return { ok: true };
      case "start":
      case "startRobust":
        recording = true;
        profile = request.command === "startRobust" ? "robust" : "fast";
        return { ok: true, sessionId: "overlay-session", status: daemonStatus(true, profile) };
      case "stop":
        recording = false;
        return { ok: true, sessionId: "overlay-session", pendingCount: 0, status: daemonStatus(false) };
      case "cancel":
        recording = false;
        return { ok: true, pendingCount: 0, status: daemonStatus(false) };
      case "status":
        return { ok: true, pendingCount: 0, status: daemonStatus(recording, recording ? profile : null) };
      case "nextResult":
        return { ok: true, pendingCount: 0, resultAvailable: false };
      default:
        return { ok: false, error: `Unsupported harness command: ${request.command}` };
    }
  });
  const backendAddress = await backendServer.start();
  overlay = new OverlayWindow({
    onError: (error) => console.error("production overlay error", error),
    rendererUrl,
  });
  const controller = new DictationController({
    controlClient: {
      send: (request) =>
        sendJSONSocketRequest(request, "127.0.0.1", backendAddress.port),
    },
    alerts: overlay,
    overlay,
    pasteEngine: {
      frontmostAppIdentity: async () => "overlay-harness",
      paste: async () => undefined,
    },
  });

  uxServer = new JSONSocketServer("127.0.0.1", 0, async (request) => {
    if (request.command === "start") {
      await controller.startRecording("fast");
      return { ok: true };
    }
    if (request.command === "stop") {
      await controller.stopRecording(false);
      return { ok: true };
    }
    if (request.command === "status") {
      const snapshot = controller.snapshot();
      return {
        ok: true,
        pendingCount: snapshot.pendingCount,
        status: daemonStatus(snapshot.state === "recording", snapshot.profile),
      };
    }
    return { ok: false, error: `Unsupported UX command: ${request.command}` };
  });
  const uxAddress = await uxServer.start();
  globalThis.__overlayControlPort = uxAddress.port;
}

void startHarness().catch((error) => {
  console.error("overlay harness startup failed", error);
  app.exit(1);
});

app.on("before-quit", () => {
  overlay?.close();
  void Promise.all([uxServer?.stop(), backendServer?.stop()]).catch((error) => {
    console.error("overlay harness shutdown failed", error);
  });
});
