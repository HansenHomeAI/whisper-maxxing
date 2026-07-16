const modulePath = new URL("../../../scripts/build-native-capture.mjs", import.meta.url);
const { buildNativeCapture } = await import(modulePath);

const calls = [];
const run = async (command, args, options) => {
  calls.push({ command, args, options });
};
await buildNativeCapture({ platform: "win32", run, appRoot: "/tmp/app" });
await buildNativeCapture({ platform: "linux", run, appRoot: "/tmp/app" });
if (calls.length !== 0) throw new Error("non-Darwin build invoked Swift");
await buildNativeCapture({ platform: "darwin", run, appRoot: "/tmp/app" });
if (calls.length !== 1 || calls[0].command !== "swift") throw new Error("Darwin build did not invoke Swift once");
const joined = calls[0].args.join(" ");
if (!joined.includes("build") || !joined.includes("--package-path") || !joined.includes("-c release") || !joined.includes("--product whisper-mac-capture")) {
  throw new Error(`incorrect Swift invocation: ${joined}`);
}
console.log("NATIVE BUILD ORCHESTRATOR ACCEPTED");
