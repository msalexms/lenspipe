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
const MAX_DECODE_QUEUE = 3;
/** Matches the tier/level field of an HEVC High tier codec string, e.g. `hvc1.1.6.H153.B0`. */
const HEVC_HIGH_TIER = /^((?:hvc1|hev1)\.[^.]+\.[^.]+\.)H(?=\d)/;

const VERTEX_SHADER_SRC = `#version 300 es
uniform vec2 u_rot;
uniform float u_flip;
out vec2 v_uv;
void main() {
  vec2 ndc = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(ndc, 0.0, 1.0);
  vec2 n = vec2(ndc.x, -ndc.y);
  vec2 s = vec2((n.x * u_rot.x + n.y * u_rot.y) * u_flip, -n.x * u_rot.y + n.y * u_rot.x);
  v_uv = s * 0.5 + 0.5;
}`;

const FRAGMENT_SHADER_SRC = `#version 300 es
precision mediump float;
uniform sampler2D u_tex;
uniform float u_gain;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  vec4 c = texture(u_tex, v_uv);
  fragColor = vec4(clamp(c.rgb * u_gain, 0.0, 1.0), 1.0);
}`;

interface GlRenderer {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  texture: WebGLTexture;
  uRot: WebGLUniformLocation | null;
  uFlip: WebGLUniformLocation | null;
  uGain: WebGLUniformLocation | null;
}

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

export type VideoPauseReason = 'manual' | 'hidden' | null;

export class StreamReceiver extends EventTarget {
  readonly socket: BinarySocket;
  private context2d?: CanvasRenderingContext2D;
  private glRenderer?: GlRenderer;
  private glLost = false;
  private rendererMode: 'idle' | 'webgl2' | '2d' = 'idle';
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
  private frameWidth = 0;
  private frameHeight = 0;
  private exposureEv = 0;
  private exposureGain = 1;
  private manualPaused = false;
  private pageHidden = false;
  private videoActive = true;
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
  private readonly onVisibilityChange = (): void => {
    this.pageHidden = Boolean(document.hidden);
    this.syncVideoSubscription();
  };
  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.glLost = true;
  };
  private readonly onContextRestored = (): void => {
    this.glLost = false;
    if (!this.glRenderer) return;
    const restored = this.initWebGlRenderer(this.glRenderer.gl);
    if (restored) {
      this.glRenderer = restored;
      this.requestKeyframe();
    } else {
      this.glRenderer = undefined;
    }
  };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly path: '/ws/control' | '/ws/obs') {
    super();
    // Auto-pause only /ws/control when backgrounded; OBS CEF OSR can report document.hidden = true while visible on scene.
    if (this.path === '/ws/control' && typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      this.pageHidden = Boolean(document.hidden);
      this.videoActive = !this.pageHidden;
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', this.onContextLost);
      canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    }
    if (canvas.parentElement && typeof window !== 'undefined' && 'ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => this.fitCanvas());
      this.resizeObserver.observe(canvas.parentElement);
    }
    this.socket = new BinarySocket(this.path);
    this.socket.addEventListener('packet', (event) => this.onPacket((event as CustomEvent<ArrayBuffer>).detail));
    this.socket.addEventListener('pairing-required', () => this.dispatchEvent(new Event('pairing-required')));
    this.socket.addEventListener('status', (event) => {
      const status = (event as CustomEvent<string>).detail;
      this.dispatchEvent(new CustomEvent('status', { detail: status }));
      if (status === 'online') {
        this.waitingForKeyframe = true;
        this.keyframeRequested = false;
        this.socket.sendControl('video-subscription', { enabled: this.videoActive });
        if (this.videoActive) this.requestKeyframe();
        this.command('request-state');
      }
    });
    this.telemetryTimer = window.setInterval(() => this.reportTelemetry(), 1000);
    this.socket.start();
  }

  get videoEnabled(): boolean {
    return this.videoActive;
  }

  get videoManualPaused(): boolean {
    return this.manualPaused;
  }

  get videoPausedReason(): VideoPauseReason {
    return this.manualPaused ? 'manual' : this.pageHidden ? 'hidden' : null;
  }

  setVideoEnabled(enabled: boolean): void {
    this.manualPaused = !enabled;
    this.syncVideoSubscription();
  }

  private syncVideoSubscription(): void {
    const prevActive = this.videoActive;
    const prevReason = this.videoPausedReason;
    const nextActive = !this.manualPaused && !this.pageHidden;
    this.videoActive = nextActive;
    const nextReason = this.videoPausedReason;

    if (nextActive !== prevActive) {
      this.socket.sendControl('video-subscription', { enabled: nextActive });
      if (!nextActive) {
        this.waitingForKeyframe = true;
        this.keyframeRequested = false;
        this.arrivals.clear();
        this.framesThisSecond = 0;
        this.decoder?.close();
        this.decoder = undefined;
        this.configSignature = '';
      } else {
        this.waitingForKeyframe = true;
        this.keyframeRequested = false;
        if (this.lastVideoMetadata) this.configureVideo(this.lastVideoMetadata);
        else this.requestKeyframe();
      }
    }

    if (nextActive !== prevActive || nextReason !== prevReason) {
      this.dispatchEvent(new CustomEvent('video-state', {
        detail: { enabled: nextActive, manualPaused: this.manualPaused, reason: nextReason },
      }));
    }
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
    const clamped = Math.max(-2, Math.min(2, Number(ev) || 0));
    this.exposureEv = clamped;
    this.exposureGain = clamped === 0 ? 1 : Math.pow(2, clamped * 0.5);
    if (!this.canvas.style) return;
    if (this.glRenderer) {
      this.canvas.style.filter = '';
      return;
    }
    this.canvas.style.filter = clamped === 0 ? '' : `brightness(${this.exposureGain.toFixed(3)})`;
  }

  private configureVideo(metadata: ControlMessage): void {
    const rawConfig = metadata.decoderConfig;
    if (!rawConfig || typeof rawConfig !== 'object') return;
    this.lastVideoMetadata = metadata;
    const orientation = metadata.orientation as { rotation?: number; flip?: boolean } | undefined;
    this.rotation = normalizeRotation(orientation?.rotation);
    this.flip = Boolean(orientation?.flip);
    if (!this.videoActive) return;
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
    if (!this.videoActive) return;
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
    if (!this.videoActive) return;
    if (this.lastVideoMetadata) this.configureVideo(this.lastVideoMetadata);
    this.requestKeyframe();
  }

  private decodeVideo(keyframe: boolean, timestamp: number, data: Uint8Array): void {
    if (!this.videoActive || !this.decoder || this.decoder.state !== 'configured') return;
    if (this.waitingForKeyframe && !keyframe) {
      this.droppedFrames++;
      this.requestKeyframe();
      return;
    }
    if (!keyframe && this.decoder.decodeQueueSize > MAX_DECODE_QUEUE) {
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

  private compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.warn('WebGL2 shader compile error', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  private initWebGlRenderer(gl: WebGL2RenderingContext): GlRenderer | null {
    const vs = this.compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SRC);
    const fs = this.compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER_SRC);
    if (!vs || !fs) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      return null;
    }
    const program = gl.createProgram();
    if (!program) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return null;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.warn('WebGL2 program link error', gl.getProgramInfoLog(program));
      gl.deleteProgram(program);
      return null;
    }
    const texture = gl.createTexture();
    if (!texture) {
      gl.deleteProgram(program);
      return null;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
    gl.useProgram(program);
    const uTex = gl.getUniformLocation(program, 'u_tex');
    if (uTex) gl.uniform1i(uTex, 0);
    return {
      gl,
      program,
      texture,
      uRot: gl.getUniformLocation(program, 'u_rot'),
      uFlip: gl.getUniformLocation(program, 'u_flip'),
      uGain: gl.getUniformLocation(program, 'u_gain'),
    };
  }

  /** Acquires the GPU/2D context lazily on the first decoded frame so pre-stream UI tools stay compatible. */
  private ensureRenderer(): 'webgl2' | '2d' {
    if (this.glRenderer) return 'webgl2';
    if (this.context2d) return '2d';
    const maybeGl = this.canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      desynchronized: true,
    } as WebGLContextAttributes) as WebGL2RenderingContext | null;
    if (maybeGl && typeof maybeGl.createShader === 'function' && typeof maybeGl.texImage2D === 'function') {
      const renderer = this.initWebGlRenderer(maybeGl);
      if (renderer) {
        this.glRenderer = renderer;
        this.rendererMode = 'webgl2';
        if (this.canvas.style) this.canvas.style.filter = '';
        return 'webgl2';
      }
    }
    const context = this.canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) throw new Error('Canvas 2D is unavailable');
    this.context2d = context;
    this.rendererMode = '2d';
    this.applyExposureFilter(this.exposureEv);
    return '2d';
  }

  private drawWebGl(frame: VideoFrame): void {
    const renderer = this.glRenderer;
    if (!renderer || this.glLost || renderer.gl.isContextLost()) return;
    const { gl, program, texture, uRot, uFlip, uGain } = renderer;
    gl.viewport(0, 0, gl.drawingBufferWidth || this.canvas.width, gl.drawingBufferHeight || this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame as unknown as TexImageSource);
    const radians = (this.rotation * Math.PI) / 180;
    gl.useProgram(program);
    if (uRot) gl.uniform2f(uRot, Math.cos(radians), Math.sin(radians));
    if (uFlip) gl.uniform1f(uFlip, this.flip ? -1 : 1);
    if (uGain) gl.uniform1f(uGain, this.exposureGain);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private syncWebGlBufferSize(cssWidth?: number, cssHeight?: number): void {
    if (!this.glRenderer || !this.frameWidth || !this.frameHeight) return;
    const dpr = typeof window !== 'undefined' ? Math.max(1, Number(window.devicePixelRatio) || 1) : 1;
    let targetWidth = this.frameWidth;
    let targetHeight = this.frameHeight;
    if (cssWidth && cssHeight && cssWidth > 0 && cssHeight > 0) {
      targetWidth = Math.max(1, Math.min(this.frameWidth, Math.round(cssWidth * dpr)));
      targetHeight = Math.max(1, Math.min(this.frameHeight, Math.round(cssHeight * dpr)));
    }
    if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }
  }

  private draw(frame: VideoFrame): void {
    try {
      const mode = this.ensureRenderer();
      const width = frame.displayWidth;
      const height = frame.displayHeight;
      const quarterTurn = this.rotation === 90 || this.rotation === 270;
      const outWidth = quarterTurn ? height : width;
      const outHeight = quarterTurn ? width : height;
      const frameResized = this.frameWidth !== outWidth || this.frameHeight !== outHeight;
      this.frameWidth = outWidth;
      this.frameHeight = outHeight;
      if (frameResized) {
        if (this.canvas.dataset) this.canvas.dataset.orientation = outWidth >= outHeight ? 'landscape' : 'portrait';
        if (this.canvas.style) this.canvas.style.aspectRatio = `${outWidth} / ${outHeight}`;
        this.fitCanvas();
      }
      if (mode === 'webgl2') {
        if (frameResized) {
          const rectSize = this.displayedSize();
          this.syncWebGlBufferSize(rectSize?.width, rectSize?.height);
        }
        this.drawWebGl(frame);
      } else {
        const ctx = this.context2d!;
        if (this.canvas.width !== outWidth || this.canvas.height !== outHeight) {
          this.canvas.width = outWidth;
          this.canvas.height = outHeight;
        }
        if (this.rotation || this.flip) {
          // Turn the sensor-oriented frame the same way the iPhone's own preview does.
          ctx.setTransform(1, 0, 0, 1, outWidth / 2, outHeight / 2);
          ctx.rotate((this.rotation * Math.PI) / 180);
          if (this.flip) ctx.scale(-1, 1);
          ctx.drawImage(frame, -width / 2, -height / 2, width, height);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        } else {
          ctx.drawImage(frame, 0, 0, width, height);
        }
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
      renderer: this.rendererMode,
      videoEnabled: this.videoActive,
    };
    this.socket.sendControl('receiver-telemetry', stats);
    this.dispatchEvent(new CustomEvent('local-telemetry', {
      detail: { ...stats, audio: { state: this.audio.state, chunksPerSecond: this.audioChunks, ...this.audio.stats } },
    }));
    this.audioChunks = 0;
  }

  private displayedSize(): { width: number; height: number } | null {
    const parent = this.canvas.parentElement;
    const fw = this.frameWidth || this.canvas.width;
    const fh = this.frameHeight || this.canvas.height;
    if (!parent || !fw || !fh) return null;
    const cw = parent.clientWidth;
    const ch = parent.clientHeight;
    if (!cw || !ch) return null;
    const frameRatio = fw / fh;
    const boxRatio = cw / ch;
    const width = boxRatio > frameRatio ? ch * frameRatio : cw;
    const height = boxRatio > frameRatio ? ch : cw / frameRatio;
    return { width, height };
  }

  fitCanvas(): void {
    const size = this.displayedSize();
    if (!size) {
      if (this.glRenderer && this.frameWidth && this.frameHeight) this.syncWebGlBufferSize();
      return;
    }
    this.canvas.style.width = `${size.width}px`;
    this.canvas.style.height = `${size.height}px`;
    this.syncWebGlBufferSize(size.width, size.height);
  }

  close(): void {
    window.clearInterval(this.telemetryTimer);
    if (this.path === '/ws/control' && typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
    if (typeof this.canvas.removeEventListener === 'function') {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
      this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    }
    this.resizeObserver?.disconnect();
    this.decoder?.close();
    if (this.glRenderer) {
      const { gl, texture, program } = this.glRenderer;
      if (!gl.isContextLost()) {
        gl.deleteTexture(texture);
        gl.deleteProgram(program);
      }
      this.glRenderer = undefined;
    }
    this.audio.close();
    this.socket.stop();
  }
}
