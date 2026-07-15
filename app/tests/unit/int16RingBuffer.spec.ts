import { describe, expect, it } from "vitest";

import { Int16RingBuffer } from "../../src/core/int16RingBuffer.js";

describe("Int16RingBuffer", () => {
  it("keeps samples in append order before reaching capacity", () => {
    const buffer = new Int16RingBuffer(5);
    buffer.append(new Int16Array([1, 2, 3]));

    expect([...buffer.snapshot()]).toEqual([1, 2, 3]);
    expect(buffer.availableMilliseconds).toBe(3 / 16);
  });

  it("keeps only the newest samples after wrapping", () => {
    const buffer = new Int16RingBuffer(4);
    buffer.append([1, 2, 3]);
    buffer.append([4, 5, 6]);

    expect([...buffer.snapshot()]).toEqual([3, 4, 5, 6]);
  });

  it("resets contents and timing when cleared", () => {
    const buffer = new Int16RingBuffer(0);
    buffer.append([12, 13]);
    expect([...buffer.snapshot()]).toEqual([13]);

    buffer.clear();
    expect([...buffer.snapshot()]).toEqual([]);
    expect(buffer.availableMilliseconds).toBe(0);
  });
});
