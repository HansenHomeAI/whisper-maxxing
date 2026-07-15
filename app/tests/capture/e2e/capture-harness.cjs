const { writeFile } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const { app, BrowserWindow } = require("electron");

const outputPath = requireEnvironment("CAPTURE_SMOKE_OUTPUT");
const tempDirectory = requireEnvironment("CAPTURE_SMOKE_TEMP");
const moduleRoot = requireEnvironment("CAPTURE_SMOKE_MODULE_ROOT");
const capturePagePath = requireEnvironment("CAPTURE_SMOKE_PAGE");

app.setPath("userData", `${tempDirectory}/user-data`);

let engine = null;
let shutdownStarted = false;
app.on("before-quit", (event) => {
  if (shutdownStarted) {
    return;
  }
  event.preventDefault();
  shutdownStarted = true;
  void shutdownAndExit();
});

void app.whenReady().then(async () => {
  try {
    const [{ CaptureEngine }, { RendererCaptureSource }] = await Promise.all([
      importModule(`${moduleRoot}/src/main/capture/captureEngine.js`),
      importModule(`${moduleRoot}/src/main/capture/rendererCaptureSource.js`),
    ]);
    const captureSource = new RendererCaptureSource({ capturePagePath });
    const source = process.env.CAPTURE_SMOKE_DISPOSE_FAILURE
      ? {
          start: (options) => captureSource.start(options),
          stop: async () => {
            await captureSource.stop();
            throw new Error("injected capture dispose failure");
          },
        }
      : captureSource;
    engine = new CaptureEngine({
      source,
      config: {
        prebufferMilliseconds: 1_000,
        preferredInputDevice: null,
        enforcePreferredInputDevice: false,
        tempDirectory,
      },
    });
    await engine.startAsync();
    engine.startSession("fast");
    await new Promise((resolve) => setTimeout(resolve, 900));
    const capture = await engine.stopSession(false);
    const defaultInputDeviceName = engine.defaultInputDeviceName;
    const allWindowsHidden = BrowserWindow.getAllWindows().every(
      (window) => !window.isVisible(),
    );
    await engine.dispose();
    engine = null;
    await writeFile(
      outputPath,
      JSON.stringify({
        ok: true,
        wavPath: capture?.wavPath,
        sampleCount: capture?.sampleCount,
        defaultInputDeviceName,
        transferDetached: captureSource.lastFrameTransferDetached,
        allWindowsHidden,
      }),
    );
  } catch (error) {
    await writeFailure(error);
  }
});

async function shutdownAndExit() {
  let exitCode = 0;
  try {
    if (engine) {
      await withTimeout(engine.dispose(), 1_500);
      engine = null;
    }
  } catch (error) {
    exitCode = 1;
    try {
      await writeFailure(
        new Error(`Capture E2E teardown failed: ${errorMessage(error)}`),
      );
    } catch (artifactError) {
      process.stderr.write(
        `Capture teardown and failure-artifact write failed: ${errorMessage(artifactError)}\n`,
      );
    }
  } finally {
    app.exit(exitCode);
  }
}

async function writeFailure(error) {
  await writeFile(
    outputPath,
    JSON.stringify({
      ok: false,
      error: errorMessage(error),
    }),
  );
}

function withTimeout(promise, milliseconds) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Capture engine disposal timed out.")),
        milliseconds,
      );
    }),
  ]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function errorMessage(error) {
  if (error instanceof AggregateError) {
    return `${error.message} ${error.errors.map(errorMessage).join("; ")}`;
  }
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function importModule(path) {
  return import(pathToFileURL(path).href);
}
