interface MediaStreamTrackProcessor<T = VideoFrame> {
  readonly readable: ReadableStream<T>;
}

declare var MediaStreamTrackProcessor: {
  prototype: MediaStreamTrackProcessor;
  new (init: { track: MediaStreamTrack }): MediaStreamTrackProcessor;
};

interface HTMLVideoElement {
  requestVideoFrameCallback(callback: (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void): number;
  cancelVideoFrameCallback(handle: number): void;
}

interface WakeLockSentinel extends EventTarget {
  released: boolean;
  release(): Promise<void>;
}

interface Navigator {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinel>;
  };
}

interface MediaTrackCapabilities {
  zoom?: { min: number; max: number; step?: number };
  torch?: boolean;
  focusMode?: string[];
  exposureMode?: string[];
  exposureCompensation?: { min: number; max: number; step?: number };
  pointsOfInterest?: unknown;
}

interface MediaTrackConstraintSet {
  zoom?: number | { ideal?: number; exact?: number };
  torch?: boolean;
  focusMode?: string;
  exposureMode?: string;
  exposureCompensation?: number;
  /** Image Capture: normalized (0..1) points used for focus/exposure metering. */
  pointsOfInterest?: Array<{ x: number; y: number }>;
}
