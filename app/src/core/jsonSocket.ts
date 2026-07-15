import { createConnection, createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";

import {
  decodeControlRequest,
  decodeControlResponse,
  type ControlRequest,
  type ControlResponse,
} from "./controlProtocol.js";
import { isLoopbackControlHost } from "./appConfig.js";

const DECODING_ERROR = "Unable to decode the control response.";

export type ControlRequestHandler = (
  request: ControlRequest,
) => ControlResponse | Promise<ControlResponse>;
export type JSONSocketErrorReporter = (error: Error) => void;

export class JSONSocketServer {
  private server: Server | null = null;
  private listenPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopRequested = false;
  private readonly reportedErrors: Error[] = [];
  private readonly activeSockets = new Set<Socket>();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly handler: ControlRequestHandler,
    private readonly errorReporter: JSONSocketErrorReporter = defaultErrorReporter,
  ) {
    assertLoopback(host);
  }

  async start(): Promise<AddressInfo> {
    if (this.server !== null || this.stopPromise !== null) {
      throw new Error("The control socket is already listening.");
    }

    const server = createServer((socket) => {
      this.handleClient(socket);
    });
    this.server = server;
    this.stopRequested = false;

    const listenPromise = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        server.on("error", (error) => {
          this.reportError(
            new Error(`Control socket server error: ${error.message}`),
          );
        });
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen({ host: this.host, port: this.port, backlog: 16 });
    });
    this.listenPromise = listenPromise;

    try {
      await listenPromise;
    } catch (error) {
      if (this.server === server) {
        this.server = null;
      }
      throw new Error(`Unable to bind the control socket: ${errorMessage(error)}`);
    } finally {
      if (this.listenPromise === listenPromise) {
        this.listenPromise = null;
      }
    }

    if (this.stopRequested) {
      throw new Error("The control socket was stopped while it was starting.");
    }

    const address = server.address();
    if (address === null || typeof address === "string") {
      await this.stop();
      throw new Error("Unable to listen on the control socket.");
    }
    return address;
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== null) {
      await this.stopPromise;
      return;
    }

    const stopPromise = this.stopServer();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = null;
      }
    }
  }

  takeReportedErrors(): Error[] {
    return this.reportedErrors.splice(0, this.reportedErrors.length);
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return;
    }
    this.stopRequested = true;
    await this.listenPromise?.catch(() => undefined);

    const closePromise = server.listening
      ? this.closeListeningServer(server)
      : null;
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    if (closePromise !== null) {
      await closePromise;
    }
    if (this.server === server) {
      this.server = null;
    }
    this.stopRequested = false;
  }

  private handleClient(socket: Socket): void {
    this.activeSockets.add(socket);
    socket.once("close", () => {
      this.activeSockets.delete(socket);
    });
    let received = Buffer.alloc(0);
    let handled = false;

    socket.on("data", (chunk: Buffer) => {
      if (handled) {
        return;
      }
      received = Buffer.concat([received, chunk]);
      const newlineIndex = received.indexOf(0x0a);
      if (newlineIndex < 0) {
        return;
      }
      handled = true;
      const line = received.subarray(0, newlineIndex).toString("utf8");
      void this.respond(socket, line);
    });
    socket.on("end", () => {
      if (!handled && received.length > 0) {
        handled = true;
        void this.respond(socket, received.toString("utf8"));
      }
    });
    socket.on("error", (error) => {
      this.reportError(
        new Error(`Control socket client transport error: ${error.message}`),
      );
      socket.destroy();
    });
  }

  private async respond(socket: Socket, line: string): Promise<void> {
    let request: ControlRequest;
    try {
      request = decodeControlRequest(JSON.parse(line) as unknown);
    } catch {
      this.writeResponse(socket, { ok: false, error: DECODING_ERROR });
      return;
    }

    let response: ControlResponse;
    try {
      response = await this.handler(request);
    } catch (error) {
      response = { ok: false, error: errorMessage(error) };
    }

    this.writeResponse(socket, response);
  }

  private writeResponse(socket: Socket, response: ControlResponse): void {
    try {
      socket.end(`${JSON.stringify(response)}\n`);
    } catch (error) {
      this.reportError(
        new Error(`Unable to encode the control response: ${errorMessage(error)}`),
      );
      socket.destroy();
    }
  }

  private reportError(error: Error): void {
    this.reportedErrors.push(error);
    this.errorReporter(error);
  }

  private closeListeningServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          const error = new Error("Timed out while closing the control socket.");
          this.reportError(error);
          resolve();
        }
      }, 1_000);
      timeout.unref();

      server.close((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }
}

export async function sendJSONSocketRequest(
  request: ControlRequest,
  host: string,
  port: number,
  timeoutMilliseconds = 1_200,
): Promise<ControlResponse> {
  assertLoopback(host);
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = createConnection({ host, port });
    let response = Buffer.alloc(0);
    let settled = false;

    const finish = (
      action: () => void,
      destroyError?: Error,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      action();
      socket.destroy(destroyError);
    };
    const timeout = setTimeout(() => {
      finish(
        () => reject(new Error("The control socket returned an invalid response.")),
        new Error("Control socket request timed out."),
      );
    }, timeoutMilliseconds);

    socket.once("connect", () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch (error) {
        finish(() =>
          reject(new Error(`Unable to encode the control request: ${errorMessage(error)}`)),
        );
      }
    });
    socket.on("data", (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const newlineIndex = response.indexOf(0x0a);
      if (newlineIndex < 0) {
        return;
      }
      try {
        const value = JSON.parse(
          response.subarray(0, newlineIndex).toString("utf8"),
        ) as unknown;
        const decoded = decodeControlResponse(value);
        finish(() => resolve(decoded));
      } catch {
        finish(() => reject(new Error(DECODING_ERROR)));
      }
    });
    socket.once("error", (error) => {
      finish(() =>
        reject(
          new Error(`Unable to connect to the control socket: ${error.message}`),
        ),
      );
    });
    socket.once("end", () => {
      if (!settled) {
        finish(() =>
          reject(new Error("The control socket returned an invalid response.")),
        );
      }
    });
  });
}

function assertLoopback(host: string): void {
  if (!isLoopbackControlHost(host)) {
    throw new Error("controlHost must be loopback-only: 127.0.0.1, localhost, ::1");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultErrorReporter(error: Error): void {
  console.error(`[control-socket] ${error.message}`);
}
