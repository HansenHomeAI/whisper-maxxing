export class Int16RingBuffer {
  readonly capacity: number;
  private storage: Int16Array;
  private writeIndex = 0;
  private sampleCount = 0;

  constructor(capacity: number) {
    this.capacity = Math.max(Math.trunc(capacity), 1);
    this.storage = new Int16Array(this.capacity);
  }

  append(samples: Iterable<number>): void {
    for (const sample of samples) {
      this.storage[this.writeIndex] = sample;
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
      this.sampleCount = Math.min(this.sampleCount + 1, this.capacity);
    }
  }

  snapshot(): Int16Array {
    if (this.sampleCount === 0) {
      return new Int16Array();
    }
    if (this.sampleCount < this.capacity) {
      return this.storage.slice(0, this.sampleCount);
    }

    const snapshot = new Int16Array(this.capacity);
    snapshot.set(this.storage.subarray(this.writeIndex), 0);
    snapshot.set(
      this.storage.subarray(0, this.writeIndex),
      this.capacity - this.writeIndex,
    );
    return snapshot;
  }

  clear(): void {
    this.storage = new Int16Array(this.capacity);
    this.writeIndex = 0;
    this.sampleCount = 0;
  }

  get availableMilliseconds(): number {
    return this.sampleCount / 16;
  }
}
