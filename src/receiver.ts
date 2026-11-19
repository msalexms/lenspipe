import {
  PACKET,
  normalizeRotation,
  parsePacket,
  videoConfigFromWire,
  type ControlMessage,
} from './protocol';
import { BinarySocket } from './socket';
import { patchAvcCForLowDelay } from './h264-sps';

const KEYFRAME_RETRY_MS = 1000;
/** Matches the tier/level field of an HEVC High tier codec string, e.g. `hvc1.1.6.H153.B0`. */
const HEVC_HIGH_TIER = /^((?:hvc1|hev1)\.[^.]+\.[^.]+\.)H(?=\d)/;

class PcmPlayer {
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private gain?: GainNode;
  private loading?: Promise<void>;
  private pending: ArrayBuffer[] = [];
  private muted = false;
  private generation = 0;
  /** Latest jitter-buffer report from the worklet. */
  stats = { bufferedMs: 0, underruns: 0, dropped: 0, received: 0, playing: false };

  get isConfigured(): boolean {
    return Boolean(this.context);
  }

  async configure(sampleRate: number): Promise<void> {
    if (this.context && this.context.sampleRate === sampleRate) return;
    const generation = ++this.generation;
    this.node?.disconnect();
    this.node = undefined;
    this.gain?.disconnect();
    this.pending = [];
    void this.context?.close();
    const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
    const gain = context.createGain();
    this.context = context;
    this.gain = gain;
    gain.gain.value = this.muted ? 0 : 1;
    gain.connect(context.destination);
    this.loading = context.audioWorklet.addModule('/pcm-player-worklet.js').then(() => {
      if (generation !== this.generation || this.context !== context || context.state === 'closed') return;
      const node = new AudioWorkletNode(context, 'pcm-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.node = node;
      node.port.onmessage = (event: MessageEvent<PcmPlayer['stats']>) => { this.stats = event.data; };
      node.connect(gain);
      for (const pcm of this.pending.splice(0)) node.port.postMessage(pcm, [pcm]);
    }).catch((error) => {
      if (generation === this.generation) console.warn('Audio worklet initialization failed', error);
    });
    await this.loading;
    if (generation === this.generation) void context.resume().catch(() => undefined);
  }

  push(pcm: ArrayBuffer): void {
    if (this.node) this.node.port.postMessage(pcm, [pcm]);
    else {
      this.pending.push(pcm);
      if (this.pending.length > 6) this.pending.shift();
    }
  }

  resume(): void {
    void this.context?.resume().catch(() => undefined);
  }

  /** 'none' until audio has arrived; otherwise the AudioContext state ('running' / 'suspended'). */
  get state(): string {
    return this.context?.state ?? 'none';
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.gain && this.context) this.gain.gain.setTargetAtTime(muted ? 0 : 1, this.context.currentTime, 0.01);
  }

  close(): void {
    this.generation++;
    this.node?.disconnect();
    this.node = undefined;
    this.gain?.disconnect();
    this.gain = undefined;
    void this.context?.close();
    this.context = undefined;
  }
}

export class StreamReceiver extends EventTarget {
  readonly socket: BinarySocket;
  private readonly context: CanvasRenderingContext2D;
  private decoder?: VideoDecoder;
  private audio = new PcmPlayer();
  private waitingForKeyframe = true;
  private keyframeRequested = false;
  private lastKeyframeRequestAt = 0;
  private hevcMainTierOnly = false;
  private audioChunks = 0;
  /** Set if the stream turns out to reorder frames, so the low-delay SPS patch must not be used. */
  private reorderingSeen = false;
  private lowDelayPatched = false;
  private lastDecodedTimestamp = -Infinity;
  /** Display rotation/mirroring sent by the iPhone (iOS keeps camera pixels in sensor orientation). */
  private rotation = 0;
  private flip = false;
  private configSignature = '';
  private lastVideoMetadata?: ControlMessage;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private framesThisSecond = 0;
  /** Arrival time of each chunk handed to the decoder, by timestamp, to measure arrival -> drawn. */
  private readonly arrivals = new Map<number, number>();
  private pipelineSum = 0;
  private pipelineMax = 0;
  private pipelineCount = 0;
  private telemetryTimer: number;
  private resizeObserver?: ResizeObserver;

  constructor(private readonly canvas: HTMLCanvasElement, path: '/ws/control' | '/ws/obs') {
    super();
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context = context;
    if (canvas.parentElement && 'ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => this.fitCanvas());
      this.resizeObserver.observe(canvas.parentElement);
    }
    this.socket = new BinarySocket(path);
    this.socket.addEventListener('packet', (event) => this.onPacket((event as CustomEvent<ArrayBuffer>).detail));
    this.socket.addEventListener('pairing-required', () => this.dispatchEvent(new Event('pairing-required')));
    this.socket.addEventListener('status', (event) => {
      const status = (event as CustomEvent<string>).detail;
      this.dispatchEvent(new CustomEvent('status', { detail: status }));
      if (status === 'online') {
        this.waitingForKeyframe = true;
        this.keyframeRequested = false;
        this.requestKeyframe();
        this.command('request-state');
      }
    });
    this.telemetryTimer = window.setInterval(() => this.reportTelemetry(), 1000);
    this.socket.start();
  }

  command(command: string, payload: Record<string, unknown> = {}): void {
    this.socket.sendControl('command', { command, ...payload });
  }

  setAudioMuted(muted: boolean): void {
    this.audio.setMuted(muted);
  }

  resumeAudio(): void {
    this.audio.resume();
  }

  private onPacket(raw: ArrayBuffer): void {
    const packet = parsePacket(raw);
    if (!packet) return;
    if (packet.kind === 'json') {
      if (packet.packetType === PACKET.CONTROL) this.onControl(packet.data);
      else if (packet.packetType === PACKET.VIDEO_CONFIG) this.configureVideo(packet.data);
      else if (packet.packetType === PACKET.AUDIO_CONFIG) {
        const sampleRate = Number(packet.data.sampleRate) || 48000;
        void this.audio.configure(sampleRate);
      }
      return;
    }

    if (packet.packetType === PACKET.AUDIO_CHUNK) {
      this.audioChunks++;
      if (!this.audio.isConfigured) void this.audio.configure(48000);
      const sampleCount = packet.data.byteLength >>> 1;
      const view = new DataView(packet.data.buffer, packet.data.byteOffset, packet.data.byteLength);
      const pcm = new ArrayBuffer(sampleCount * 4);
      const floats = new Float32Array(pcm);
      for (let i = 0; i < sampleCount; i++) floats[i] = view.getInt16(i * 2, true) / 32768;
      this.audio.push(pcm);
      return;
    }
    if (packet.packetType === PACKET.VIDEO_KEYFRAME || packet.packetType === PACKET.VIDEO_DELTA) {
      this.decodeVideo(packet.packetType === PACKET.VIDEO_KEYFRAME, packet.timestamp, packet.data);
    }
  }

  private onControl(message: ControlMessage): void {
    if (message.type === 'ping') {
      this.socket.sendControl('pong', { id: message.id });
      return;
    }
    if (message.type === 'stream-state') {
      this.waitingForKeyframe = true;
      this.keyframeRequested = false;
      if (!message.online) this.applyExposureFilter(0);
    } else if (message.type === 'sender-state') {
      const settings = message.settings as Record<string, unknown> | undefined;
      const ev = settings && (typeof settings.softwareEv === 'number' ? settings.softwareEv : settings.exposureEv);
      if (typeof ev === 'number') this.applyExposureFilter(ev);
    } else if (message.type === 'sender-telemetry') {
      // Only the EV the iPhone could not apply in hardware is emulated here, otherwise it would double up.
      const ev = typeof message.softwareEv === 'number' ? message.softwareEv : message.exposureEv;
      if (typeof ev === 'number') this.applyExposureFilter(ev);
    }
    this.dispatchEvent(new CustomEvent('control', { detail: message }));
    this.dispatchEvent(new CustomEvent(message.type, { detail: message }));
  }

  private applyExposureFilter(ev: number): void {
    if (!this.canvas.style) return;
    const clamped = Math.max(-2, Math.min(2, Number(ev) || 0));
    this.canvas.style.filter = clamped === 0 ? '' : `brightness(${Math.pow(2, clamped * 0.5).toFixed(3)})`;
  }

  private configureVideo(metadata: ControlMessage): void {
    const rawConfig = metadata.decoderConfig;
    if (!rawConfig || typeof rawConfig !== 'object') return;
    this.lastVideoMetadata = metadata;
    const orientation = metadata.orientation as { rotation?: number; flip?: boolean } | undefined;
    this.rotation = normalizeRotation(orientation?.rotation);
    this.flip = Boolean(orientation?.flip);
    const config = videoConfigFromWire(rawConfig as Record<string, unknown>);
    // Orientation is applied once, when drawing. Should an encoder also put it in the decoder config,
    // a browser that honours it would rotate the frames a second time.
    delete (config as VideoDecoderConfig & { rotation?: number }).rotation;
    delete (config as VideoDecoderConfig & { flip?: boolean }).flip;
    // Tier only affects the capability check, not the bitstream: if this decoder rejected a High tier
    // HEVC string, announce it as Main tier and let the hardware decode the same stream.
    if (this.hevcMainTierOnly) config.codec = config.codec.replace(HEVC_HIGH_TIER, '$1L');
    config.hardwareAcceleration = 'prefer-hardware';
    config.optimizeForLatency = true;
    // Without VUI bitstream_restriction the H.264 decoder holds a whole DPB (13 frames at 1080p/L5.0)
    // before showing anything. The iPhone stream never reorders frames, so declare that in the SPS.
    this.lowDelayPatched = false;
    if (!this.reorderingSeen && /^avc[13]\./.test(config.codec) && config.description) {
      const source = config.description instanceof ArrayBuffer
        ? new Uint8Array(config.description)
        : new Uint8Array((config.description as ArrayBufferView).buffer, (config.description as ArrayBufferView).byteOffset, (config.description as ArrayBufferView).byteLength);
      const patched = patchAvcCForLowDelay(source);
      if (patched) {
        config.description = patched;
        this.lowDelayPatched = true;
      }
    }
    const signature = JSON.stringify(metadata.decoderConfig);
    if (signature === this.configSignature && this.decoder?.state === 'configured') return;
    this.configSignature = signature;
    this.decoder?.close();
    let decoder: VideoDecoder;
    decoder = new VideoDecoder({
      output: (frame) => {
        if (this.decoder === decoder) this.draw(frame);
        else frame.close();
      },
      error: (error) => {
        console.error('Video decoder error', error);
        if (!this.hevcMainTierOnly && HEVC_HIGH_TIER.test(config.codec)) {
          this.hevcMainTierOnly = true;
        } else {
          this.dispatchEvent(new CustomEvent('decoder-error', { detail: error.message }));
        }
        // WebCodecs errors are fatal. Rebuild from the cached config before asking for a keyframe.
        queueMicrotask(() => {
          if (this.decoder === decoder) this.recoverDecoder();
        });
      },
    });
    this.decoder = decoder;
    try {
      decoder.configure(config);
      this.waitingForKeyframe = true;
      this.keyframeRequested = false;
      this.requestKeyframe();
    } catch (error) {
      console.error('Unsupported decoder configuration', error);
      this.decoder = undefined;
      decoder.close();
      this.dispatchEvent(new CustomEvent('decoder-error', { detail: String(error) }));
    }
  }

  private requestKeyframe(): void {
    // Re-ask if the previous request went unanswered (e.g. sent while the iPhone was reconnecting).
    const now = performance.now();
    if (this.keyframeRequested && now - this.lastKeyframeRequestAt < KEYFRAME_RETRY_MS) return;
    this.keyframeRequested = true;
    this.lastKeyframeRequestAt = now;
    this.command('force-keyframe');
  }

  private recoverDecoder(): void {
    this.waitingForKeyframe = true;
    this.keyframeRequested = false;
    this.decoder?.close();
    this.decoder = undefined;
    this.configSignature = '';
    if (this.lastVideoMetadata) this.configureVideo(this.lastVideoMetadata);
    this.requestKeyframe();
  }

  private decodeVideo(keyframe: boolean, timestamp: number, data: Uint8Array): void {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.waitingForKeyframe && !keyframe) {
      this.droppedFrames++;
      this.requestKeyframe();
      return;
    }
    if (!keyframe && this.decoder.decodeQueueSize > 6) {
      this.droppedFrames++;
      // Drop congested deltas and wait for a fresh keyframe without tearing down the hardware decoder.
      this.waitingForKeyframe = true;
      this.requestKeyframe();
      return;
    }
    if (keyframe) {
      this.waitingForKeyframe = false;
      this.keyframeRequested = false;
    } else if (this.lowDelayPatched && timestamp < this.lastDecodedTimestamp) {
      // B-frames after all: the "no reordering" promise would show frames out of order. Rebuild unpatched.
      console.warn('Frame reordering detected; disabling the low-delay H.264 output patch');
      this.reorderingSeen = true;
      this.droppedFrames++;
      this.recoverDecoder();
      return;
    }
    this.lastDecodedTimestamp = timestamp;
    try {
      if (this.arrivals.size > 240) this.arrivals.clear();
      this.arrivals.set(timestamp, performance.now());
      this.decoder.decode(new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp, data }));
    } catch {
      this.droppedFrames++;
      this.recoverDecoder();
    }
  }

  private draw(frame: VideoFrame): void {
    try {
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      const quarterTurn = this.rotation === 90 || this.rotation === 270;
      const outWidth = quarterTurn ? height : width;
      const outHeight = quarterTurn ? width : height;
      if (this.canvas.width !== outWidth || this.canvas.height !== outHeight) {
        this.canvas.width = outWidth;
        this.canvas.height = outHeight;
        this.canvas.dataset.orientation = outWidth >= outHeight ? 'landscape' : 'portrait';
        this.canvas.style.aspectRatio = `${outWidth} / ${outHeight}`;
        this.fitCanvas();
      }
      if (this.rotation || this.flip) {
        // Turn the sensor-oriented frame the same way the iPhone's own preview does.
        this.context.setTransform(1, 0, 0, 1, outWidth / 2, outHeight / 2);
        this.context.rotate((this.rotation * Math.PI) / 180);
        if (this.flip) this.context.scale(-1, 1);
        this.context.drawImage(frame, -width / 2, -height / 2, width, height);
        this.context.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        this.context.drawImage(frame, 0, 0, width, height);
      }
      const arrivedAt = this.arrivals.get(frame.timestamp);
      if (arrivedAt !== undefined) {
        this.arrivals.delete(frame.timestamp);
        const ms = performance.now() - arrivedAt;
        this.pipelineSum += ms;
        this.pipelineCount++;
        this.pipelineMax = Math.max(this.pipelineMax, ms);
      }
      this.decodedFrames++;
      this.framesThisSecond++;
    } finally {
      frame.close();
    }
  }

  private reportTelemetry(): void {
    const fps = this.framesThisSecond;
    this.framesThisSecond = 0;
    // Average time from a frame arriving over the WebSocket to it being drawn (decode + render).
    const pipelineMs = this.pipelineCount ? Math.round(this.pipelineSum / this.pipelineCount) : 0;
    const pipelineMaxMs = Math.round(this.pipelineMax);
    this.pipelineSum = 0;
    this.pipelineCount = 0;
    this.pipelineMax = 0;
    const stats = {
      fps,
      decodedFrames: this.decodedFrames,
      droppedFrames: this.droppedFrames,
      decoderQueue: this.decoder?.decodeQueueSize || 0,
      pipelineMs,
      pipelineMaxMs,
    };
    this.socket.sendControl('receiver-telemetry', stats);
    this.dispatchEvent(new CustomEvent('local-telemetry', {
      detail: { ...stats, audio: { state: this.audio.state, chunksPerSecond: this.audioChunks, ...this.audio.stats } },
    }));
    this.audioChunks = 0;
  }

  fitCanvas(): void {
    const parent = this.canvas.parentElement;
    const fw = this.canvas.width;
    const fh = this.canvas.height;
    if (!parent || !fw || !fh) return;
    const cw = parent.clientWidth;
    const ch = parent.clientHeight;
    if (!cw || !ch) return;
    const frameRatio = fw / fh;
    const boxRatio = cw / ch;
    const width = boxRatio > frameRatio ? ch * frameRatio : cw;
    const height = boxRatio > frameRatio ? ch : cw / frameRatio;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  }

  close(): void {
    window.clearInterval(this.telemetryTimer);
    this.resizeObserver?.disconnect();
    this.decoder?.close();
    this.audio.close();
    this.socket.stop();
  }
}
