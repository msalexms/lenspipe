/**
 * Reads camera frames off the main thread. iOS Safari only exposes MediaStreamTrackProcessor inside
 * dedicated workers; without it the sender has to copy frames out of the <video> element, which is
 * paced by the display and can skip camera frames.
 */

type InMessage =
  | { type: 'start'; track: MediaStreamTrack }
  | { type: 'ack' }
  | { type: 'stop' };

const scope = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<InMessage>) => void) | null;
  close(): void;
};

/** Frames handed to the main thread but not yet consumed. Camera buffer pools are small, so cap it. */
const MAX_IN_FLIGHT = 2;
let inFlight = 0;
let skipped = 0;
let reader: ReadableStreamDefaultReader<VideoFrame> | undefined;
let track: MediaStreamTrack | undefined;

scope.onmessage = (event) => {
  const message = event.data;
  if (message.type === 'start') void start(message.track);
  else if (message.type === 'ack') inFlight = Math.max(0, inFlight - 1);
  else if (message.type === 'stop') stop();
};

async function start(next: MediaStreamTrack): Promise<void> {
  track = next;
  if (typeof MediaStreamTrackProcessor === 'undefined') {
    scope.postMessage({ type: 'unsupported', reason: 'MediaStreamTrackProcessor is not available in workers' });
    next.stop();
    return;
  }
  try {
    reader = new MediaStreamTrackProcessor({ track: next }).readable.getReader();
  } catch (error) {
    scope.postMessage({ type: 'unsupported', reason: String(error) });
    next.stop();
    return;
  }
  scope.postMessage({ type: 'ready' });
  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      if (inFlight >= MAX_IN_FLIGHT) {
        // The main thread is behind: drop the oldest-possible frame here instead of queueing camera buffers.
        frame.close();
        skipped++;
        continue;
      }
      inFlight++;
      scope.postMessage({ type: 'frame', frame, skipped }, [frame as unknown as Transferable]);
      skipped = 0;
    }
    scope.postMessage({ type: 'ended' });
  } catch (error) {
    scope.postMessage({ type: 'error', reason: String(error) });
  }
}

function stop(): void {
  void reader?.cancel().catch(() => undefined);
  reader = undefined;
  track?.stop();
  track = undefined;
  scope.postMessage({ type: 'stopped' });
  scope.close();
}
