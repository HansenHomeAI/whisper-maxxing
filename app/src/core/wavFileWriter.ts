export function mono16BitPCMData(
  samples: Iterable<number>,
  sampleRate: number,
): Uint8Array {
  const pcm = Int16Array.from(samples);
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = pcm.length * bytesPerSample;
  const output = new Uint8Array(44 + dataSize);
  const view = new DataView(output.buffer);

  writeASCII(output, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeASCII(output, 8, "WAVE");
  writeASCII(output, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitsPerSample, true);
  writeASCII(output, 36, "data");
  view.setUint32(40, dataSize, true);

  for (let index = 0; index < pcm.length; index += 1) {
    view.setInt16(44 + index * bytesPerSample, pcm[index] ?? 0, true);
  }
  return output;
}

function writeASCII(output: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    output[offset + index] = value.charCodeAt(index);
  }
}
