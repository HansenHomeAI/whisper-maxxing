export interface CapturedAudioFrame {
  samples: Int16Array;
  timestampMilliseconds: number;
}

export interface CaptureSourceStartOptions {
  preferredInputDevice: string | null;
  enforcePreferredInputDevice: boolean;
  onFrame: (frame: CapturedAudioFrame) => void;
  onError: (error: Error) => void;
}

export interface CaptureSourceInfo {
  defaultInputDeviceName: string | null;
}

export interface CaptureSource {
  start(options: CaptureSourceStartOptions): Promise<CaptureSourceInfo>;
  stop(): Promise<void>;
}

export interface CaptureClock {
  now(): number;
}

export interface CaptureDateClock {
  nowDate(): Date;
}

export const systemCaptureClock: CaptureClock = {
  now: () => performance.now(),
};

export const systemCaptureDateClock: CaptureDateClock = {
  nowDate: () => new Date(),
};
