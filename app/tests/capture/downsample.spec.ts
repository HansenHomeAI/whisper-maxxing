import { describe, expect, it } from "vitest";

import { FirDownsampler } from "../../src/renderer/capture/capture-worklet.js";

describe("FirDownsampler", () => {
  it("rejects frequencies above the 16 kHz Nyquist limit", () => {
    const passband = downsampleTone(1_000);
    const rejected = downsampleTone(12_000);
    const passbandRms = rms(passband.subarray(200));
    const rejectedRms = rms(rejected.subarray(200));

    expect(passband.length).toBe(16_000);
    expect(rejected.length).toBe(16_000);
    expect(passbandRms).toBeGreaterThan(15_000);
    expect(rejectedRms).toBeLessThan(passbandRms * 0.01);
  });
});

function downsampleTone(frequency: number): Int16Array {
  const inputRate = 48_000;
  const samples = new Float32Array(inputRate);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = 0.8 * Math.sin((2 * Math.PI * frequency * index) / inputRate);
  }
  return new FirDownsampler(inputRate).process(samples);
}

function rms(samples: Int16Array): number {
  let total = 0;
  for (const sample of samples) {
    total += sample * sample;
  }
  return Math.sqrt(total / samples.length);
}
