import { spawn } from "node:child_process";

const binary = process.argv[2];
if (!binary) throw new Error("helper binary path is required");

const child = spawn(binary, ["--self-test"], { stdio: ["ignore", "pipe", "pipe"] });
const stdout = [];
const stderr = [];
child.stdout.on("data", (chunk) => stdout.push(chunk));
child.stderr.on("data", (chunk) => stderr.push(chunk));
const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
if (exit.code !== 0) {
  throw new Error(`helper self-test failed ${JSON.stringify(exit)}: ${Buffer.concat(stderr)}`);
}
const data = Buffer.concat(stdout);
let offset = 0;
const frames = [];
while (offset < data.length) {
  if (data.length - offset < 5) throw new Error("truncated helper header");
  const type = data[offset];
  const length = data.readUInt32LE(offset + 1);
  if (length > 262_144 || offset + 5 + length > data.length) throw new Error("invalid helper frame length");
  frames.push({ type, payload: data.subarray(offset + 5, offset + 5 + length) });
  offset += 5 + length;
}
if (frames.length !== 3 || frames[0].type !== 1 || frames[1].type !== 2 || frames[2].type !== 4) {
  throw new Error(`unexpected helper frame sequence: ${frames.map((frame) => frame.type).join(",")}`);
}
const ready = JSON.parse(frames[0].payload.toString("utf8"));
if (ready.protocolVersion !== 1 || ready.sampleRateHz !== 16000 || ready.channels !== 1 || ready.sampleFormat !== "s16le") {
  throw new Error(`invalid ready payload: ${JSON.stringify(ready)}`);
}
if (frames[1].payload.length !== 640) throw new Error(`expected 320 PCM samples, got ${frames[1].payload.length / 2}`);
let nonzero = 0;
for (let index = 0; index < frames[1].payload.length; index += 2) {
  if (frames[1].payload.readInt16LE(index) !== 0) nonzero += 1;
}
if (nonzero < 300) throw new Error(`self-test PCM is not meaningfully nonzero: ${nonzero}`);
console.log("NATIVE HELPER PROTOCOL ACCEPTED");
