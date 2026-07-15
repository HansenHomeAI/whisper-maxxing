import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export type FakeWhisperScenario =
  | { kind: "transcript"; text: string }
  | { kind: "no-speech" }
  | { kind: "delay"; milliseconds: number; text: string }
  | { kind: "http-error"; status: number; body?: string }
  | { kind: "hang" }
  | { kind: "refuse-connection" };

export interface FakeWhisperRequest {
  method: string;
  url: string;
  body: Buffer;
}

export class FakeWhisperServer {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly scenarios: FakeWhisperScenario[];
  readonly requests: FakeWhisperRequest[] = [];

  constructor(scenarios: readonly FakeWhisperScenario[] = []) {
    this.scenarios = [...scenarios];
  }

  enqueue(...scenarios: readonly FakeWhisperScenario[]): void {
    this.scenarios.push(...scenarios);
  }

  get port(): number {
    const address = this.server?.address();
    if (address === null || address === undefined || typeof address === "string") {
      throw new Error("The fake whisper server is not listening.");
    }
    return (address as AddressInfo).port;
  }

  get inferenceRequestCount(): number {
    return this.requests.filter((request) => request.url === "/inference").length;
  }

  async start(port = 0): Promise<void> {
    if (this.server !== null) {
      throw new Error("The fake whisper server is already started.");
    }
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return;
    }
    this.server = null;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await readBody(request);
    const url = request.url ?? "/";
    this.requests.push({ method: request.method ?? "GET", url, body });
    if (url !== "/inference") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }

    const scenario = this.scenarios.shift();
    if (scenario === undefined) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("No scripted fake whisper scenario remains");
      return;
    }
    switch (scenario.kind) {
      case "transcript":
        json(response, 200, { text: scenario.text });
        return;
      case "no-speech":
        json(response, 200, { text: "[BLANK_AUDIO]" });
        return;
      case "delay":
        await new Promise<void>((resolve) =>
          setTimeout(resolve, scenario.milliseconds),
        );
        if (!response.destroyed) {
          json(response, 200, { text: scenario.text });
        }
        return;
      case "http-error":
        response.writeHead(scenario.status, { "content-type": "text/plain" });
        response.end(scenario.body ?? "scripted error");
        return;
      case "hang":
        return;
      case "refuse-connection":
        request.socket.destroy();
        return;
    }
  }
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
