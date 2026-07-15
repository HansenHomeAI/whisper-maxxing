import { createConnection, createServer as createNetServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  JSONSocketServer,
  sendJSONSocketRequest,
} from "../../src/core/jsonSocket.js";
import type { ControlResponse } from "../../src/core/controlProtocol.js";

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
      error: "Unable to decode the control response.",
    });
  });

  it("closes a socket when stop overlaps start without leaking the port", async () => {
    const port = await findAvailablePort();
    server = new JSONSocketServer("127.0.0.1", port, () => ({ ok: true }));

    const starting = server.start();
    const stopping = server.stop();
    await expect(starting).rejects.toThrow("stopped while it was starting");
    await stopping;

    server = new JSONSocketServer("127.0.0.1", port, () => ({ ok: true }));
    const address = await server.start();
    expect(address.port).toBe(port);
  });

  it("reports response encoding failures through an observable path", async () => {
    const circularResponse: Record<string, unknown> = { ok: true };
    circularResponse.self = circularResponse;
    let resolveReportedError: (error: Error) => void = () => undefined;
    const reportedError = new Promise<Error>((resolve) => {
      resolveReportedError = resolve;
    });
    server = new JSONSocketServer(
      "127.0.0.1",
      0,
      () => circularResponse as unknown as ControlResponse,
      resolveReportedError,
    );
    const address = await server.start();

    await sendRawAndWaitForClose(address.port, '{"command":"status"}\n');
    expect((await reportedError).message).toContain(
      "Unable to encode the control response",
    );
    expect(server.takeReportedErrors()).toHaveLength(1);
    expect(server.takeReportedErrors()).toEqual([]);
  });

  it("stops promptly with an idle accepted client", async () => {
    server = new JSONSocketServer("127.0.0.1", 0, () => ({ ok: true }));
    const address = await server.start();
    const client = await connectRawClient(address.port);
    client.write("partial-request");
    await delay(20);

    await withTimeout(server.stop(), 500);
    await withTimeout(waitForClose(client), 500);
  });

  it("stops promptly while a request handler is stalled", async () => {
    let handlerStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    server = new JSONSocketServer("127.0.0.1", 0, () => {
      handlerStarted();
      return new Promise<ControlResponse>(() => undefined);
    });
    const address = await server.start();
    const client = await connectRawClient(address.port);
    client.write('{"command":"status"}\n');
    await started;

    await withTimeout(server.stop(), 500);
    await withTimeout(waitForClose(client), 500);
  });

  it("reports an asynchronous client transport reset", async () => {
    let handlerStarted: () => void = () => undefined;
    let releaseHandler: () => void = () => undefined;
    let reportError: (error: Error) => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const reportedError = new Promise<Error>((resolve) => {
      reportError = resolve;
    });
    server = new JSONSocketServer(
      "127.0.0.1",
      0,
      async () => {
        handlerStarted();
        await handlerGate;
        return { ok: true };
      },
      reportError,
    );
    const address = await server.start();
    const client = await connectRawClient(address.port);
    client.on("error", () => undefined);
    client.write('{"command":"status"}\n');
    await started;

    client.resetAndDestroy();
    await delay(20);
    releaseHandler();

    const error = await withTimeout(reportedError, 1_000);
    expect(error.message).toContain("client transport error");
    expect(server.takeReportedErrors()).toContain(error);
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

function sendRawAndWaitForClose(port: number, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => socket.end(line));
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

async function findAvailablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function connectRawClient(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForClose(socket: Socket): Promise<void> {
  if (socket.closed) {
    return Promise.resolve();
  }
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Operation exceeded ${milliseconds} ms.`)),
      milliseconds,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
