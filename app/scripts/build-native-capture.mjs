import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultAppRoot = resolve(dirname(scriptPath), "..");

function runCommand(command, args, options) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, options);

    child.once("error", rejectCommand);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveCommand();
        return;
      }

      const outcome = signal ? `signal ${signal}` : `exit code ${code}`;
      rejectCommand(new Error(`${command} failed with ${outcome}`));
    });
  });
}

export async function buildNativeCapture({
  platform = process.platform,
  run = runCommand,
  appRoot = defaultAppRoot,
} = {}) {
  if (platform !== "darwin") {
    return false;
  }

  const packagePath = join(appRoot, "native", "macos-capture");
  await run(
    "swift",
    [
      "build",
      "--package-path",
      packagePath,
      "-c",
      "release",
      "--product",
      "whisper-mac-capture",
    ],
    { stdio: "inherit" },
  );
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await buildNativeCapture();
}
