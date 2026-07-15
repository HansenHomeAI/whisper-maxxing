class WhisperCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.position = 0;
    this.pending = new Float32Array();
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
    const combined = new Float32Array(this.pending.length + mono.length);
    combined.set(this.pending);
    combined.set(mono, this.pending.length);

    const ratio = sampleRate / 16_000;
    const output = [];
    while (this.position + 1 < combined.length) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const value =
        combined[left] + (combined[left + 1] - combined[left]) * fraction;
      output.push(Math.max(-1, Math.min(1, value)));
      this.position += ratio;
    }

    const consumed = Math.min(Math.floor(this.position), combined.length);
    this.pending = combined.slice(consumed);
    this.position -= consumed;
    if (output.length > 0) {
      const samples = new Int16Array(output.length);
      for (let index = 0; index < output.length; index += 1) {
        const value = output[index];
        samples[index] = value < 0 ? Math.round(value * 32_768) : Math.round(value * 32_767);
      }
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
