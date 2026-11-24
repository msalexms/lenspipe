import assert from 'node:assert/strict';

class FakeWebSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = '';
  bufferedAmount = 0;
  sentControl: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: EventListener): void { super.addEventListener(type, listener); }
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  send(data: ArrayBuffer): void {
    const bytes = new Uint8Array(data);
    if (bytes[0] === 0x10) {
      this.sentControl.push(JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as Record<string, unknown>);
    }
  }
  close(): void { this.readyState = 3; }
}

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = [];
  state = 'unconfigured';
  decodeQueueSize = 0;
  config: unknown;
  decoded: unknown[] = [];
  private output: (frame: unknown) => void;
  private error: (error: Error) => void;

  constructor(init: { output: (frame: unknown) => void; error: (error: Error) => void }) {
    this.output = init.output;
    this.error = init.error;
    FakeVideoDecoder.instances.push(this);
  }
  configure(config: unknown): void { this.config = config; this.state = 'configured'; }
  decode(chunk: unknown): void { this.decoded.push(chunk); }
  close(): void { this.state = 'closed'; }
  emitFatalError(): void { this.state = 'closed'; this.error(new Error('simulated hardware decoder failure')); }
}
class FakeEncodedVideoChunk {
  constructor(readonly init: unknown) {}
}

Object.assign(globalThis, {
  window: globalThis,
  location: { protocol: 'https:', host: 'localhost:8443' },
  WebSocket: FakeWebSocket,
  VideoDecoder: FakeVideoDecoder,
  EncodedVideoChunk: FakeEncodedVideoChunk,
});

const { StreamReceiver } = await import('../src/receiver');
const drawn: Array<{ op: string; args: number[] }> = [];
const record = (op: string) => (...args: number[]) => { drawn.push({ op, args }); };
const context = {
  drawImage: (_frame: unknown, ...args: number[]) => { drawn.push({ op: 'drawImage', args }); },
  setTransform: record('setTransform'),
  rotate: record('rotate'),
  scale: record('scale'),
};
const canvas = {
  width: 0,
  height: 0,
  getContext: () => context,
  dataset: {},
  style: {},
  parentElement: null,
} as unknown as HTMLCanvasElement;
const receiver = new StreamReceiver(canvas, '/ws/control') as any;
const metadata = { decoderConfig: { codec: 'avc1.640032', codedWidth: 1920, codedHeight: 1080 } };
const bytes = new Uint8Array([1, 2, 3]);

receiver.configureVideo(metadata);
assert.equal(FakeVideoDecoder.instances.length, 1);
receiver.decodeVideo(false, 1, bytes);
assert.equal(FakeVideoDecoder.instances[0].decoded.length, 0, 'deltas before a keyframe must not be decoded');
receiver.decodeVideo(true, 2, bytes);
assert.equal(FakeVideoDecoder.instances[0].decoded.length, 1);

const firstDecoder = FakeVideoDecoder.instances[0];
firstDecoder.decodeQueueSize = 7;
receiver.decodeVideo(false, 3, bytes);
assert.equal(FakeVideoDecoder.instances.length, 1, 'queue congestion should drop deltas without destroying the decoder');
assert.equal((receiver as any).waitingForKeyframe, true, 'dependent deltas must wait for the next keyframe');
firstDecoder.decodeQueueSize = 0;
receiver.decodeVideo(false, 4, bytes);
assert.equal(firstDecoder.decoded.length, 1, 'deltas after a congested drop must be skipped until a keyframe');
receiver.decodeVideo(true, 5, bytes);
assert.equal(firstDecoder.decoded.length, 2, 'a keyframe restores decoding on the existing decoder');

FakeVideoDecoder.instances[0].emitFatalError();
await new Promise<void>((resolve) => queueMicrotask(resolve));
assert.equal(FakeVideoDecoder.instances.length, 2, 'a fatal error must recreate the decoder from cached config');
assert.equal(FakeVideoDecoder.instances[1].state, 'configured');
assert.deepEqual((FakeVideoDecoder.instances[1].config as any).codec, 'avc1.640032');
receiver.decodeVideo(false, 6, bytes);
assert.equal(FakeVideoDecoder.instances[1].decoded.length, 0, 'recovered decoder still requires a keyframe');
receiver.decodeVideo(true, 7, bytes);
assert.equal(FakeVideoDecoder.instances[1].decoded.length, 1);

// Rotation: iOS sends sensor-oriented pixels plus a display rotation in the config packet.
const fakeFrame = (timestamp: number) => ({ displayWidth: 1920, displayHeight: 1080, timestamp, close: () => undefined });
receiver.configureVideo({ ...metadata, orientation: { rotation: 0, flip: false } });
drawn.length = 0;
receiver.draw(fakeFrame(100));
assert.deepEqual([canvas.width, canvas.height], [1920, 1080], 'upright landscape keeps its size');
assert.equal(drawn.filter((entry) => entry.op === 'rotate').length, 0, 'no transform when no rotation is needed');

receiver.configureVideo({ ...metadata, orientation: { rotation: 180, flip: false } });
drawn.length = 0;
receiver.draw(fakeFrame(101));
assert.deepEqual([canvas.width, canvas.height], [1920, 1080], 'upside-down landscape keeps its size');
assert.ok(Math.abs(drawn.find((entry) => entry.op === 'rotate')!.args[0] - Math.PI) < 1e-9, 'phone held upside down is turned 180°');

receiver.configureVideo({ ...metadata, orientation: { rotation: 90, flip: false } });
drawn.length = 0;
receiver.draw(fakeFrame(102));
assert.deepEqual([canvas.width, canvas.height], [1080, 1920], 'portrait: a quarter turn swaps the canvas to 1080×1920');
assert.deepEqual(drawn.find((entry) => entry.op === 'drawImage')!.args, [-960, -540, 1920, 1080], 'frame drawn centred before rotation');
const lastConfig = FakeVideoDecoder.instances.at(-1)!.config as Record<string, unknown>;
assert.ok(!('rotation' in lastConfig), 'rotation is never passed to the decoder (no double rotation)');
receiver.configureVideo({ ...metadata, orientation: { rotation: 0, flip: false } });

// HEVC High tier: a decoder that rejects the High tier string is retried as Main tier.
receiver.configureVideo({ decoderConfig: { codec: 'hvc1.1.6.H153.B0', codedWidth: 3840, codedHeight: 2160 } });
const highTier = FakeVideoDecoder.instances.at(-1)!;
assert.equal((highTier.config as any).codec, 'hvc1.1.6.H153.B0');
highTier.emitFatalError();
await new Promise<void>((resolve) => queueMicrotask(resolve));
assert.equal((FakeVideoDecoder.instances.at(-1)!.config as any).codec, 'hvc1.1.6.L153.B0', 'High tier must fall back to Main tier');

// Tighter decode queue bound: <= 3 is decoded, > 3 triggers delta drop & keyframe wait.
receiver.configureVideo(metadata);
const queueDecoder = FakeVideoDecoder.instances.at(-1)!;
receiver.decodeVideo(true, 200, bytes);
queueDecoder.decodeQueueSize = 3;
receiver.decodeVideo(false, 201, bytes);
assert.equal(queueDecoder.decoded.length, 2, 'decodeQueueSize === 3 must still decode');
queueDecoder.decodeQueueSize = 4;
receiver.decodeVideo(false, 202, bytes);
assert.equal(queueDecoder.decoded.length, 2, 'decodeQueueSize > 3 must drop delta');
assert.equal(receiver.waitingForKeyframe, true, 'dropping at queue > 3 waits for next keyframe');
queueDecoder.decodeQueueSize = 0;
receiver.decodeVideo(true, 203, bytes);
assert.equal(queueDecoder.decoded.length, 3);

// Manual preview pause / resume: sends video-subscription, closes decoder, suppresses keyframes while paused.
const mainWs = FakeWebSocket.instances[0];
mainWs.open();
mainWs.sentControl.length = 0;
const dropsBeforePause = receiver.droppedFrames;
const decoderBeforePause = FakeVideoDecoder.instances.at(-1)!;
receiver.setVideoEnabled(false);
assert.equal(receiver.videoEnabled, false);
assert.equal(decoderBeforePause.state, 'closed', 'pausing closes the active VideoDecoder to free GPU resources');
assert.deepEqual(mainWs.sentControl, [{ type: 'video-subscription', enabled: false }]);
mainWs.sentControl.length = 0;
receiver.decodeVideo(false, 204, bytes);
receiver.decodeVideo(true, 205, bytes);
assert.equal(receiver.droppedFrames, dropsBeforePause, 'frames ignored while paused must not count as drops');
assert.equal(mainWs.sentControl.length, 0, 'paused receiver must never request keyframes');
const decodersCountBeforeResume = FakeVideoDecoder.instances.length;
receiver.setVideoEnabled(true);
assert.equal(receiver.videoEnabled, true);
assert.equal(FakeVideoDecoder.instances.length, decodersCountBeforeResume + 1, 'resuming reconfigures decoder from cache');
assert.deepEqual(mainWs.sentControl, [
  { type: 'video-subscription', enabled: true },
  { type: 'command', command: 'force-keyframe' },
]);

receiver.close();

// Auto-pause on document.hidden: /ws/control follows visibilitychange, while /ws/obs NEVER auto-pauses.
class FakeDocument extends EventTarget {
  hidden = false;
}
const fakeDoc = new FakeDocument();
Object.assign(globalThis, { document: fakeDoc });

const bgControl = new StreamReceiver(canvas, '/ws/control') as any;
const bgControlWs = FakeWebSocket.instances.at(-1)!;
bgControlWs.open();
bgControl.configureVideo(metadata);
bgControl.decodeVideo(true, 300, bytes);
bgControlWs.sentControl.length = 0;

fakeDoc.hidden = true;
fakeDoc.dispatchEvent(new Event('visibilitychange'));
assert.equal(bgControl.videoEnabled, false, '/ws/control must auto-pause when page is hidden');
assert.deepEqual(bgControlWs.sentControl, [{ type: 'video-subscription', enabled: false }]);
bgControlWs.sentControl.length = 0;
bgControl.decodeVideo(false, 301, bytes);
assert.equal(bgControlWs.sentControl.length, 0, 'hidden /ws/control must not fire keyframe requests');

fakeDoc.hidden = false;
fakeDoc.dispatchEvent(new Event('visibilitychange'));
assert.equal(bgControl.videoEnabled, true, '/ws/control must resume when visible again');
assert.ok(bgControlWs.sentControl.some((msg) => msg.type === 'video-subscription' && msg.enabled === true));

// Manual pause stays respected across tab visibility transitions.
bgControl.setVideoEnabled(false);
fakeDoc.hidden = true;
fakeDoc.dispatchEvent(new Event('visibilitychange'));
fakeDoc.hidden = false;
fakeDoc.dispatchEvent(new Event('visibilitychange'));
assert.equal(bgControl.videoEnabled, false, 'manual pause stays paused after visibility returns');
bgControl.close();

const obsReceiver = new StreamReceiver(canvas, '/ws/obs') as any;
FakeWebSocket.instances.at(-1)!.open();
obsReceiver.configureVideo(metadata);
fakeDoc.hidden = true;
fakeDoc.dispatchEvent(new Event('visibilitychange'));
assert.equal(obsReceiver.videoEnabled, true, '/ws/obs must never auto-pause when document.hidden is true (OBS OSR)');
obsReceiver.close();

console.log('Decoder regression test passed: fatal errors rebuild, dropped deltas purge references, queue > 3 drops cleanly, keyframes restore decoding, rotation is applied once when drawing, HEVC High tier falls back to Main tier, and pause/background subscriptions behave properly.');
