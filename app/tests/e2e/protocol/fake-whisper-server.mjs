import { createServer } from "node:http";

const port = argumentNumber("--port");
const host = argumentValue("--host") ?? "127.0.0.1";
const transcriptNonce = process.env.WD_E2E_TRANSCRIPT_NONCE;
if (!transcriptNonce) {
  throw new Error("WD_E2E_TRANSCRIPT_NONCE is required");
}
let inferenceCount = 0;

const server = createServer(async (request, response) => {
  for await (const _chunk of request) {
    // Consume the multipart body so the production client completes normally.
  }
  if (request.url === "/inference") {
    inferenceCount += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ text: `electron-${transcriptNonce}-${inferenceCount}` }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});

server.listen(port, host);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentNumber(name) {
  const value = Number(argumentValue(name));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
