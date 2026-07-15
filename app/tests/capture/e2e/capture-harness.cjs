const { writeFile } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const { app } = require("electron");

const outputPath = requireEnvironment("CAPTURE_SMOKE_OUTPUT");
const tempDirectory = requireEnvironment("CAPTURE_SMOKE_TEMP");
const moduleRoot = requireEnvironment("CAPTURE_SMOKE_MODULE_ROOT");
const capturePagePath = requireEnvironment("CAPTURE_SMOKE_PAGE");

app.setPath("userData", `${tempDirectory}/user-data`);

let engine = null;
app.once("before-quit", () => {
  void engine?.dispose();
});

void app.whenReady().then(async () => {
  try {
    const [{ CaptureEngine }, { RendererCaptureSource }] = await Promise.all([
      importModule(`${moduleRoot}/src/main/capture/captureEngine.js`),
      importModule(`${moduleRoot}/src/main/capture/rendererCaptureSource.js`),
    ]);
    engine = new CaptureEngine({
      source: new RendererCaptureSource({ capturePagePath }),
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
    await writeFile(
      outputPath,
      JSON.stringify({
        ok: true,
        wavPath: capture?.wavPath,
        sampleCount: capture?.sampleCount,
        defaultInputDeviceName: engine.defaultInputDeviceName,
      }),
    );
  } catch (error) {
    await writeFile(
      outputPath,
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.stack : String(error),
      }),
    );
  }
});

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
