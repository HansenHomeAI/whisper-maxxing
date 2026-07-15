export class FirDownsampler {
  constructor(
    inputSampleRate: number,
    outputSampleRate?: number,
    tapCount?: number,
  );
  process(input: Iterable<number>): Int16Array;
}
