import type { SessionResultPayload } from "./controlProtocol.js";

export class SessionResultBuffer {
  private readonly results: SessionResultPayload[] = [];

  append(result: SessionResultPayload): void {
    this.results.push(result);
  }

  popNext(sessionId?: string | null): SessionResultPayload | null {
    if (this.results.length === 0) {
      return null;
    }
    if (sessionId === undefined || sessionId === null || sessionId.length === 0) {
      return this.results.shift() ?? null;
    }

    const index = this.results.findIndex((result) => result.sessionId === sessionId);
    if (index < 0) {
      return null;
    }
    return this.results.splice(index, 1)[0] ?? null;
  }

  count(): number {
    return this.results.length;
  }
}
