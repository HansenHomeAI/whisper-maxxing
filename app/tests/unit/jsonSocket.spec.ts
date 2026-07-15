import { createConnection } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  JSONSocketServer,
  sendJSONSocketRequest,
} from "../../src/core/jsonSocket.js";

let server: JSONSocketServer | null = null;

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe("JSONSocket", () => {
  it("exchanges exactly one newline-delimited request and response", async () => {
    server = new JSONSocketServer("127.0.0.1", 0, (request) => ({
      ok: true,
      sessionId: request.sessionId ?? null,
    }));
    const address = await server.start();

    const response = await sendJSONSocketRequest(
      { command: "nextResult", sessionId: "recording-a" },
      "127.0.0.1",
      address.port,
    );

    expect(response).toEqual({ ok: true, sessionId: "recording-a" });
  });

  it("surfaces malformed requests as an explicit error response", async () => {
    server = new JSONSocketServer("127.0.0.1", 0, () => ({ ok: true }));
    const address = await server.start();

    const response = await sendRawLine(address.port, "not-json\n");
    expect(JSON.parse(response) as unknown).toEqual({
      ok: false,
      error: expect.any(String),
    });
  });

  it("refuses non-loopback server and client hosts", async () => {
    expect(() => new JSONSocketServer("0.0.0.0", 44_124, () => ({ ok: true }))).toThrow(
      "loopback-only",
    );
    await expect(
      sendJSONSocketRequest({ command: "status" }, "example.com", 44_124),
    ).rejects.toThrow("loopback-only");
  });
});

function sendRawLine(port: number, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(line));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.includes("\n")) {
        socket.destroy();
        resolve(response.trimEnd());
      }
    });
    socket.once("error", reject);
  });
}
