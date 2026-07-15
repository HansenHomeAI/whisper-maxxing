export class FirDownsampler {
  constructor(inputSampleRate, outputSampleRate = 16_000, tapCount = 127) {
    if (inputSampleRate <= 0 || outputSampleRate <= 0) {
      throw new Error("Audio sample rates must be positive.");
    }
    this.inputSampleRate = inputSampleRate;
    this.outputSampleRate = outputSampleRate;
    this.bypass = inputSampleRate <= outputSampleRate;
    this.phase = 0;
    this.writeIndex = 0;
    this.coefficients = designLowPass(
      inputSampleRate,
      outputSampleRate,
      tapCount,
    );
    this.history = new Float64Array(this.coefficients.length);
  }

  process(input) {
    if (this.bypass) {
      return toInt16(input);
    }

    const output = [];
    for (const sample of input) {
      this.history[this.writeIndex] = sample;
      this.writeIndex = (this.writeIndex + 1) % this.history.length;
      this.phase += this.outputSampleRate;
      if (this.phase >= this.inputSampleRate) {
        this.phase -= this.inputSampleRate;
        output.push(this.filteredSample());
      }
    }
    return toInt16(output);
  }

  filteredSample() {
    let sum = 0;
    for (let index = 0; index < this.coefficients.length; index += 1) {
      const historyIndex =
        (this.writeIndex - 1 - index + this.history.length) %
        this.history.length;
      sum += this.history[historyIndex] * this.coefficients[index];
    }
    return sum;
  }
}

function designLowPass(inputRate, outputRate, requestedTapCount) {
  const tapCount = Math.max(31, requestedTapCount | 1);
  const center = (tapCount - 1) / 2;
  const cutoff = (outputRate * 0.45) / inputRate;
  const coefficients = new Float64Array(tapCount);
  let total = 0;
  for (let index = 0; index < tapCount; index += 1) {
    const distance = index - center;
    const sinc =
      distance === 0
        ? 2 * cutoff
        : Math.sin(2 * Math.PI * cutoff * distance) /
          (Math.PI * distance);
    const window =
      0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (tapCount - 1));
    coefficients[index] = sinc * window;
    total += coefficients[index];
  }
  for (let index = 0; index < coefficients.length; index += 1) {
    coefficients[index] /= total;
  }
  return coefficients;
}

function toInt16(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]));
    output[index] =
      value < 0 ? Math.round(value * 32_768) : Math.round(value * 32_767);
  }
  return output;
}

if (typeof AudioWorkletProcessor !== "undefined") {
  class WhisperCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.downsampler = new FirDownsampler(sampleRate);
    }

    process(inputs) {
      const channels = inputs[0];
      if (!channels || channels.length === 0 || channels[0].length === 0) {
        return true;
      }

      const mono = new Float32Array(channels[0].length);
      for (const channel of channels) {
        for (let index = 0; index < channel.length; index += 1) {
          mono[index] += channel[index] / channels.length;
        }
      }
      const samples = this.downsampler.process(mono);
      if (samples.length > 0) {
        this.port.postMessage(
          {
            type: "frame",
            samples,
            timestampMilliseconds: currentTime * 1_000,
          },
          [samples.buffer],
        );
      }
      return true;
    }
  }

  registerProcessor("whisper-capture", WhisperCaptureProcessor);
}
