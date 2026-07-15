const { writeFileSync } = require("node:fs");
const { writeFile } = require("node:fs/promises");
const { pathToFileURL } = require("node:url");

const { app, BrowserWindow } = require("electron");

const outputPath = requireEnvironment("CAPTURE_SMOKE_OUTPUT");
const tempDirectory = requireEnvironment("CAPTURE_SMOKE_TEMP");
const moduleRoot = requireEnvironment("CAPTURE_SMOKE_MODULE_ROOT");
const capturePagePath = requireEnvironment("CAPTURE_SMOKE_PAGE");

app.setPath("userData", `${tempDirectory}/user-data`);

let engine = null;
let lifecycleWindow = null;
let shutdownStarted = false;
let artifactFailuresRemaining = Number(
  process.env.CAPTURE_SMOKE_ARTIFACT_FAILURES ?? 0,
);
app.on("before-quit", (event) => {
  if (shutdownStarted) {
    return;
  }
  event.preventDefault();
  shutdownStarted = true;
  void Promise.resolve()
    .then(() => shutdownAndExit())
    .catch((error) => {
      reportDetachedFailureAndExit("Capture shutdown chain failed", error);
    });
});

void Promise.resolve()
  .then(() => app.whenReady())
  .then(() => runCaptureScenario())
  .catch((error) => {
    reportDetachedFailureAndExit("Capture readiness chain failed", error);
  });

async function runCaptureScenario() {
  try {
    lifecycleWindow = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      webPreferences: { sandbox: true },
    });
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
    await writeArtifact({
      ok: true,
      wavPath: capture?.wavPath,
      sampleCount: capture?.sampleCount,
      defaultInputDeviceName,
      transferDetached: captureSource.lastFrameTransferDetached,
      allWindowsHidden,
    });
  } catch (error) {
    await writeFailure(error);
  }
}

async function shutdownAndExit() {
  if (process.env.CAPTURE_SMOKE_SHUTDOWN_CHAIN_FAILURE) {
    throw new Error("injected capture shutdown chain failure");
  }
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
      writeFailureSynchronously(
        new AggregateError(
          [error, artifactError],
          "Capture teardown and failure-artifact write both failed.",
        ),
      );
    }
  } finally {
    lifecycleWindow?.destroy();
    lifecycleWindow = null;
    app.exit(exitCode);
  }
}

async function writeFailure(error) {
  await writeArtifact({ ok: false, error: errorMessage(error) });
}

async function writeArtifact(value) {
  if (artifactFailuresRemaining > 0) {
    artifactFailuresRemaining -= 1;
    throw new Error("injected capture artifact write failure");
  }
  await writeFile(outputPath, JSON.stringify(value));
}

function reportDetachedFailureAndExit(context, error) {
  writeFailureSynchronously(
    new Error(`${context}: ${errorMessage(error)}`),
  );
  try {
    lifecycleWindow?.destroy();
  } catch (cleanupError) {
    process.stderr.write(
      `Capture terminal cleanup failed: ${errorMessage(cleanupError)}\n`,
    );
  }
  lifecycleWindow = null;
  process.exitCode = 1;
  try {
    app.exit(1);
  } catch (exitError) {
    process.stderr.write(
      `Capture terminal Electron exit failed: ${errorMessage(exitError)}\n`,
    );
    process.exit(1);
  }
}

function writeFailureSynchronously(error) {
  try {
    writeFileSync(
      outputPath,
      JSON.stringify({ ok: false, error: errorMessage(error) }),
    );
  } catch (artifactError) {
    process.stderr.write(
      `Capture terminal failure artifact write failed: ${errorMessage(artifactError)}\n`,
    );
  }
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
