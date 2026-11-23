import {
  PACKET,
  encodeControl,
  encodeJsonPacket,
  encodePcmChunk,
  encodeVideoChunk,
  normalizeRotation,
  parsePacket,
  videoMetadataToWire,
  type ControlMessage,
} from '../protocol';
import { BinarySocket } from '../socket';
import { paintRange, watchRanges } from '../amstech-ui';
import {
  CODEC_H264,
  CODEC_HEVC,
  DEFAULT_SETTINGS,
  MIN_BITRATE,
  PHOTO_MODE_WARNING,
  PRESETS,
  PROFILES,
  codecName,
  describeSettings,
  formatTrackMode,
  aspectLabel,
  encodeRotation,
  h264Codecs,
  hevcCodecs,
  limitCrop,
  matchingProfile,
  holdState,
  type CropRect,
  type Hold,
  quarterTurns,
  rotatePoint,
  sanitizeSettings,
  sensorRotation,
  uprightEncodeRotation,
  type BitrateMode,
  type LatencyMode,
  type Orientation,
  type PresetName,
  type ProfileName,
  type StreamSettings,
} from '../stream-settings';
import { HealthBanner, HealthMonitor } from '../health';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Turns getUserMedia(audio) failures into something actionable on mobile browsers. */
function microphoneErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return IS_IOS
      ? 'Microphone blocked for this site. On iPhone: Settings → Apps → Safari → Microphone → Ask/Allow, '
        + 'or in Safari tap aA → Website Settings → Microphone → Allow, then reload this page.'
      : 'Microphone blocked for this site. Tap the lock or site-settings icon in the address bar → Permissions → Microphone → Allow, then reload this page.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone found for the selected source; choose Default microphone.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy (a call, voice assistant or another app). End it and try again.';
  return `Microphone failed: ${error instanceof Error ? error.message : String(error)}`;
}

const KEYFRAME_INTERVAL_SECONDS = 2;

/** How a frame must be turned to look like the iPhone's own preview. */
interface FrameOrientation {
  rotation: number;
  flip: boolean;
  /** Where the value came from: the frame itself, the device orientation table, or the <video> path. */
  source: 'frame' | 'device' | 'video';
}

/**
 * iOS never rotates camera pixels: frames stay in sensor orientation and carry a display rotation that
 * Safari's <video> applies. This is WebKit's own table (AVVideoCaptureSource), indexed by the interface
 * orientation in `window.orientation` units, for when VideoFrame.rotation isn't exposed.
 */
const DEVICE_ROTATION = {
  environment: { '90': 0, '-90': 180, '0': 90, '180': 270 },
  user: { '90': 180, '-90': 0, '0': 270, '180': 90 },
} as const;

/** The DEVICE_ROTATION table describes WebKit on iOS only; elsewhere camera frames arrive upright. */
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_MOBILE = IS_IOS || /Android|Mobile/i.test(navigator.userAgent);

function interfaceOrientation(): number {
  const legacy = (window as Window & { orientation?: number }).orientation;
  if (typeof legacy === 'number') return legacy;
  const angle = screen.orientation?.angle ?? 90;
  return angle === 270 ? -90 : angle;
}
const MIN_FORCED_KEYFRAME_GAP_MS = 250;
const PREFERENCES_KEY = 'camera-link:stream-settings';

interface EncoderCandidate {
  config: VideoEncoderConfig & Record<string, unknown>;
  codecBase: string;
  bitrateMode: BitrateMode;
  latencyMode: LatencyMode;
  isCodecFallback: boolean;
}

function loadPreferences(): Partial<StreamSettings> {
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(PREFERENCES_KEY) || '{}'));
  } catch {
    return {};
  }
}

class CameraSender {
  private readonly socket = new BinarySocket('/ws/sender');
  private readonly preview = $<HTMLVideoElement>('camera-preview');
  private encoder?: VideoEncoder;
  private videoStream?: MediaStream;
  private track?: MediaStreamTrack;
  private reader?: ReadableStreamDefaultReader<VideoFrame>;
  private videoFrameCallback?: number;
  private captureWorker?: Worker;
  private captureWatchdog?: number;
  private workerCaptureUnsupported = false;
  private captureSource: 'track' | 'worker' | 'video' | '' = '';
  private captureGeneration = 0;
  private encoderGeneration = 0;
  private encoderFrameCount = 0;
  private framesSinceKeyframe = 0;
  private lastKeyframeAt = 0;
  private encoderFrameRate = 30;
  private encoderErrorCount = 0;
  private encoderCandidates: EncoderCandidate[] = [];
  private encoderCandidateIndex = 0;
  private encoderProducedOutput = false;
  private encoderFallbackTried = false;
  private encoderWidth = 0;
  private encoderHeight = 0;
  private forceNextKeyframe = true;
  private lastVideoConfigPacket?: ArrayBuffer;
  private lastAudioConfigPacket?: ArrayBuffer;
  private started = false;
  private switching = Promise.resolve();
  private pendingZoom: number | null = null;
  private applyingZoom = false;
  // Requested settings (persisted). The `active*` fields report what the encoder actually accepted.
  private orientation: Orientation = DEFAULT_SETTINGS.orientation;
  private preset: PresetName = DEFAULT_SETTINGS.preset;
  private codec = DEFAULT_SETTINGS.codec;
  private bitrate = DEFAULT_SETTINGS.bitrate;
  private requestedBitrateMode: BitrateMode = DEFAULT_SETTINGS.bitrateMode;
  private latencyMode: LatencyMode = DEFAULT_SETTINGS.latencyMode;
  private bitrateMode: BitrateMode = DEFAULT_SETTINGS.bitrateMode;
  private activeLatencyMode: LatencyMode = DEFAULT_SETTINGS.latencyMode;
  private activeCodec = '';
  private lenses: MediaDeviceInfo[] = [];
  private microphones: MediaDeviceInfo[] = [];
  private selectedLens = '';
  private selectedMicrophone = '';
  private torch = false;
  /** What the user asked for; survives camera reopens (lens/preset changes) and is re-applied after them. */
  private torchWanted = false;
  private sizeMismatchFrames = 0;
  private turned = false;
  /** The buffer rectangle sent for the current frame when the encoder limit crops it (null = whole frame). */
  private frameCrop: CropRect | null = null;
  /** Fraction of the picture the crop keeps, for the preview guide. */
  private cropShare = { width: 1, height: 1 };
  /**
   * Largest frame the iPhone encoder accepted for the current format/codec (found by probing when the full
   * size is refused). Frames are centre-cropped to it. Reset when the format or codec changes.
   */
  private encodeLimit: { long: number; short: number } | null = null;
  /**
   * How the phone is held relative to the chosen aspect (iOS only). 'across' or 'upside-down' means the
   * picture comes out on its side or upside down: both this page and the studio show a warning.
   */
  private hold: Hold = 'ok';
  private holdCandidate: Hold = 'ok';
  private holdTimer?: number;
  /**
   * How Safari's <video> currently turns the camera (it follows the phone), and how the sent picture is
   * turned relative to that. The preview is rotated by the latter so it shows exactly what the PC gets.
   */
  private displayRotation = 0;
  private previewRotation = 0;
  /** Rotation baked into the current encoder's config packet; null until its first frame. */
  private encoderOrientation: FrameOrientation | null = null;
  /** Last frame seen (metadata only; never used after the frame is closed except for plain fields). */
  private lastFrameMeta?: { rotation?: number; flip?: boolean; codedWidth: number; codedHeight: number; displayWidth: number; displayHeight: number };
  private trackFacing: 'environment' | 'user' = 'environment';
  private sampleFrameMeta = true;
  /** Set while a rotation/size-triggered encoder rebuild is queued: frames are skipped, not sent to the old encoder. */
  private reconfigurePending = false;
  /** Size of the latest keyframe, so the flow-control cap always fits one keyframe. */
  private lastKeyframeBytes = 0;
  /** Actual encoder output of the last completed second (bits/s). Safari caps realtime far below `bitrate`. */
  private encodedBitrate = 0;
  // Lag diagnostics: drops split by cause (cumulative) and the worst socket backlog seen this second.
  private networkDrops = 0;
  private encoderDrops = 0;
  private peakBufferedBytes = 0;
  private readonly health = new HealthMonitor();
  private healthBanner?: HealthBanner;
  private lastNetworkDrops = 0;
  private lastEncoderDrops = 0;
  private lastAckedBytes = 0;
  private focusMode = 'continuous';
  private exposureMode = 'continuous';
  private exposureEv = 0;
  private micEnabled = false;
  private muted = false;
  private micStream?: MediaStream;
  private audioContext?: AudioContext;
  private audioNode?: AudioWorkletNode;
  private audioPeak = 0;
  private audioPacketsSent = 0;
  /** Why the mic isn't working, shown on the iPhone and forwarded to the PC; null when fine. */
  private micProblem: string | null = null;
  private transport = 'Unknown';
  private sentBytes = 0;
  private sentFrames = 0;
  private displayedFps = 0;
  private droppedFrames = 0;
  private wakeLock?: WakeLockSentinel;
  private silentAudio = document.createElement('audio');
  private toastTimer?: number;

  constructor() {
    this.setSettingsFields({ ...this.currentSettings(), ...loadPreferences() });
    this.bitrateMode = this.requestedBitrateMode;
    this.activeLatencyMode = this.latencyMode;
    this.bindUi();
    this.healthBanner = new HealthBanner((changes) => this.enqueue(() => this.applySettings(changes)));
    this.syncUi();
    this.onVisibilityChange = this.onVisibilityChange.bind(this);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.socket.addEventListener('packet', (event) => this.onPacket((event as CustomEvent<ArrayBuffer>).detail));
    this.socket.addEventListener('open', () => {
      if (this.lastVideoConfigPacket) this.socket.send(this.lastVideoConfigPacket);
      if (this.micEnabled && this.lastAudioConfigPacket) this.socket.send(this.lastAudioConfigPacket);
      this.forceNextKeyframe = true;
      this.sendState();
      if (this.started) this.toast('Connected to PC');
    });
    this.socket.addEventListener('status', (event) => {
      if ((event as CustomEvent<string>).detail === 'offline') $('transport').textContent = 'OFFLINE';
    });
    this.socket.addEventListener('pairing-required', () => {
      const message = 'This phone is not paired. Scan the QR code shown in the PC studio (Connect phone) again.';
      $('transport').textContent = 'NOT PAIRED';
      const note = $('start-note');
      note.textContent = message;
      note.classList.add('error');
      this.toast(message);
    });
    this.socket.start();
    window.setInterval(() => this.reportTelemetry(), 1000);
  }

  private currentSettings(): StreamSettings {
    return {
      orientation: this.orientation,
      turned: this.turned,
      preset: this.preset,
      codec: this.codec,
      bitrate: this.bitrate,
      bitrateMode: this.requestedBitrateMode,
      latencyMode: this.latencyMode,
    };
  }

  private setSettingsFields(settings: StreamSettings): void {
    this.orientation = settings.orientation;
    this.turned = settings.turned;
    this.preset = settings.preset;
    this.codec = settings.codec;
    this.bitrate = settings.bitrate;
    this.requestedBitrateMode = settings.bitrateMode;
    this.latencyMode = settings.latencyMode;
  }

  private savePreferences(): void {
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(this.currentSettings()));
    } catch {
      // Private browsing or blocked storage: settings simply won't persist.
    }
  }

  /**
   * Single entry point for every stream setting change (local UI, profiles, and PC remote commands).
   * Camera-level changes reopen the camera; encoder-only changes just rebuild the encoder.
   */
  private async applySettings(changes: Partial<StreamSettings>): Promise<void> {
    const previous = this.currentSettings();
    const next: StreamSettings = { ...previous, ...sanitizeSettings(changes as Record<string, unknown>) };
    // The aspect and the 180° turn only change the rotation sent with the frames (see sensorRotation), so
    // only the preset touches the camera; the encoder rebuilds itself on the next frame with the new rotation.
    const encoderChanged = next.codec !== previous.codec || next.bitrate !== previous.bitrate
      || next.bitrateMode !== previous.bitrateMode || next.latencyMode !== previous.latencyMode;
    this.setSettingsFields(next);
    const cameraChanged = next.preset !== previous.preset;
    // A new format or codec may allow a larger frame: probe the encoder limit again.
    if (cameraChanged || next.codec !== previous.codec) this.encodeLimit = null;
    try {
      if (!this.started || !this.track) return;
      this.encoderErrorCount = 0;
      // Resizing the live track avoids reopening the camera (no black frame, torch stays lit).
      if (cameraChanged && !(await this.resizeInPlace())) await this.restartCamera(previous);
      else if (encoderChanged) await this.configureEncoder();
    } catch (error) {
      this.setSettingsFields(previous);
      if (!cameraChanged) await this.configureEncoder().catch(() => undefined);
      throw error;
    } finally {
      this.savePreferences();
      this.syncUi();
      this.sendState();
    }
  }

  private applyProfile(name: ProfileName): void {
    const profile = PROFILES[name];
    if (!profile) return;
    // Close the sheet so the confirmation toast (and the restarted preview) are visible.
    $<HTMLDialogElement>('settings-sheet').close();
    this.enqueue(async () => {
      await this.applySettings(profile.settings);
      this.toast(`${profile.label}: ${describeSettings(this.currentSettings()).title}`);
    });
  }

  private bindUi(): void {
    $<HTMLButtonElement>('start').addEventListener('click', () => void this.start());
    $('orientation').addEventListener('click', () => this.enqueue(() => this.applySettings({
      orientation: this.orientation === 'landscape' ? 'portrait' : 'landscape',
    })));
    $('turn').addEventListener('click', () => this.enqueue(() => this.applySettings({ turned: !this.turned })));
    $('hold-action').addEventListener('click', () => {
      const changes: Partial<StreamSettings> = this.hold === 'upside-down'
        ? { turned: !this.turned }
        : { orientation: this.orientation === 'landscape' ? 'portrait' : 'landscape' };
      this.enqueue(() => this.applySettings(changes));
    });
    $('reset-settings').addEventListener('click', () => {
      $<HTMLDialogElement>('settings-sheet').close();
      this.enqueue(async () => {
        await this.applySettings({ ...DEFAULT_SETTINGS });
        this.toast(`Defaults restored: ${describeSettings(this.currentSettings()).title}`);
      });
    });
    $('open-settings').addEventListener('click', () => $<HTMLDialogElement>('settings-sheet').showModal());
    const settingsSheet = $<HTMLDialogElement>('settings-sheet');
    settingsSheet.addEventListener('click', (event) => {
      if (event.target !== settingsSheet || event.detail === 0) return;
      const rect = settingsSheet.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) settingsSheet.close();
    });
    $('profile-max-quality').addEventListener('click', () => this.applyProfile('max-quality'));
    $('profile-low-latency').addEventListener('click', () => this.applyProfile('low-latency'));
    $<HTMLSelectElement>('rate-control').addEventListener('change', (event) => {
      const bitrateMode = (event.currentTarget as HTMLSelectElement).value as BitrateMode;
      this.enqueue(() => this.applySettings({ bitrateMode }));
    });
    $<HTMLSelectElement>('latency-mode').addEventListener('change', (event) => {
      const latencyMode = (event.currentTarget as HTMLSelectElement).value as LatencyMode;
      this.enqueue(() => this.applySettings({ latencyMode }));
    });
    $('zoom').addEventListener('input', (event) => {
      const input = event.currentTarget as HTMLInputElement;
      $('zoom-label').textContent = `${Number(input.value).toFixed(1)}×`;
      this.scheduleZoom(Number(input.value));
    });
    $('torch').addEventListener('click', () => void this.setTorch(!this.torch));
    $('mic').addEventListener('click', () => this.enqueue(() => this.setMicrophone(!this.micEnabled)));
    $('mute').addEventListener('click', () => this.setMute(!this.muted));
    $('blackout').addEventListener('click', () => this.enableBlackout());
    this.bindBlackoutExit();
    this.bindTapToFocus();
    // The stage changes size with the layout (portrait / landscape UI); keep the turned <video> fitted.
    if ('ResizeObserver' in window && this.preview.parentElement) new ResizeObserver(() => this.layoutPreview()).observe(this.preview.parentElement);
    else window.addEventListener('resize', () => this.layoutPreview());
    $<HTMLSelectElement>('preset').addEventListener('change', (event) => {
      const preset = (event.currentTarget as HTMLSelectElement).value as PresetName;
      this.enqueue(async () => {
        await this.applySettings({ preset });
        if (PRESETS[this.preset].photoMode) this.toast('4:3 photo mode: less phone video processing. See the note in Settings.', 4500);
      });
    });
    $<HTMLSelectElement>('codec').addEventListener('change', (event) => {
      const codec = (event.currentTarget as HTMLSelectElement).value;
      this.enqueue(() => this.applySettings({ codec }));
    });
    $<HTMLSelectElement>('bitrate').addEventListener('change', (event) => {
      const bitrate = Number((event.currentTarget as HTMLSelectElement).value);
      this.enqueue(() => this.applySettings({ bitrate }));
    });
    $<HTMLSelectElement>('mic-device').addEventListener('change', (event) => {
      this.selectedMicrophone = (event.currentTarget as HTMLSelectElement).value;
      if (this.micEnabled) this.enqueue(() => this.restartMicrophone());
    });
    $('focus-mode').addEventListener('change', (event) => void this.applyTrackConstraint('focusMode', (event.currentTarget as HTMLSelectElement).value));
    $('exposure-mode').addEventListener('change', (event) => void this.applyTrackConstraint('exposureMode', (event.currentTarget as HTMLSelectElement).value));
    $('exposure-ev').addEventListener('input', (event) => {
      this.setExposureEv(Number((event.currentTarget as HTMLInputElement).value));
    });
  }

  private async start(): Promise<void> {
    const button = $<HTMLButtonElement>('start');
    const note = $('start-note');
    button.disabled = true;
    button.textContent = 'Requesting access…';
    note.classList.remove('error');
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS. Open the https:// link from the PC studio.');
      if (!('VideoEncoder' in window) || !('VideoFrame' in window)) throw new Error('WebCodecs VideoEncoder is not supported by this browser. Use iOS Safari 16.4+ or Android Chrome / Edge.');
      this.started = true;
      await Promise.race([
        this.socket.waitUntilOpen(),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1500)),
      ]);
      await this.switchCamera();
      await this.enumerateDevices();
      $('start-screen').classList.add('hidden');
      await this.keepScreenAwake();
      await this.playSilentKeepAlive();
    } catch (error) {
      this.started = false;
      button.disabled = false;
      button.textContent = 'Try camera again';
      note.classList.add('error');
      note.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  private enqueue(operation: () => Promise<void>): void {
    this.switching = this.switching.then(operation).catch((error) => {
      console.error(error);
      this.toast(error instanceof Error ? error.message : String(error));
    });
  }

  /**
   * Capture size requested from the camera. It is always the landscape preset: iOS hands out sensor-
   * oriented frames whatever is asked, so a swapped (portrait) request did not make the picture portrait,
   * and could fail and roll the aspect back. The 16:9 / 9:16 choice is applied as a rotation (`sensorRotation`).
   */
  private desiredDimensions(): { width: number; height: number; frameRate: number } {
    const preset = PRESETS[this.preset];
    return { width: preset.width, height: preset.height, frameRate: preset.frameRate };
  }

  /**
   * Warns, here and in the studio, when the phone is held so that the picture comes out on its side (held
   * across the chosen aspect) or upside down. Only iOS reports how the phone is held. The state must stay
   * the same for 0.6 s, so turning the phone does not flash the warning.
   */
  private watchHold(display: number, rotation: number): void {
    if (!IS_MOBILE) return;
    const next = IS_IOS
      ? holdState(sensorRotation(this.orientation, this.turned, this.trackFacing, true), display)
      : holdState(quarterTurns(rotation - (this.turned ? 180 : 0)), display);
    if (next === this.hold) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
      return;
    }
    if (this.holdTimer !== undefined && next === this.holdCandidate) return;
    this.holdCandidate = next;
    window.clearTimeout(this.holdTimer);
    this.holdTimer = window.setTimeout(() => {
      this.holdTimer = undefined;
      this.hold = this.holdCandidate;
      this.renderHoldHint();
      this.sendState();
    }, 600);
  }

  private renderHoldHint(): void {
    const hint = $('hold-hint');
    if (this.hold === 'ok' || !this.started) {
      hint.hidden = true;
      return;
    }
    const landscape = this.orientation === 'landscape';
    const ratio = PRESETS[this.preset].ratio;
    const flipped = ratio.split(':').reverse().join(':');
    const aspect = landscape ? ratio : flipped;
    if (this.hold === 'upside-down') {
      $('hold-title').textContent = 'The picture is upside down';
      $('hold-detail').textContent = 'Turn the phone round, or rotate the picture.';
      $('hold-action').textContent = 'Rotate 180°';
    } else {
      $('hold-title').textContent = landscape ? 'Turn the phone sideways' : 'Turn the phone upright';
      $('hold-detail').textContent = `The stream is ${aspect}, so the picture comes out on its side. If the phone is already ${landscape ? 'sideways' : 'upright'}, turn off Rotation Lock.`;
      $('hold-action').textContent = `Use ${landscape ? flipped : ratio}`;
    }
    hint.hidden = false;
  }

  private async switchCamera(deviceId = this.selectedLens): Promise<void> {
    const previousLens = this.selectedLens;
    try {
      await this.openCamera(deviceId);
    } catch (error) {
      this.stopVideoExtraction();
      this.videoStream?.getTracks().forEach((track) => track.stop());
      this.videoStream = undefined;
      this.track = undefined;
      if (previousLens && previousLens !== deviceId && this.started) {
        this.toast('Lens unavailable; restoring the previous camera');
        await this.openCamera(previousLens);
        return;
      }
      throw error;
    }
  }

  private async openCamera(deviceId = this.selectedLens): Promise<void> {
    const generation = ++this.captureGeneration;
    this.stopVideoExtraction();
    this.videoStream?.getTracks().forEach((track) => track.stop());
    this.track = undefined;
    // The LED goes off with the old capture session; `torchWanted` is re-applied once the new track is live.
    this.torch = false;
    this.updateTorchUi();

    const desired = this.desiredDimensions();
    const minFps = desired.frameRate >= 60 ? 50 : desired.frameRate;
    const deviceConstraint = deviceId ? { exact: deviceId } : undefined;
    const baseVideo: MediaTrackConstraints = {
      deviceId: deviceConstraint,
      facingMode: deviceId ? undefined : { ideal: 'environment' },
    };
    const tiers: MediaTrackConstraints[] = [
      {
        ...baseVideo,
        width: { exact: desired.width },
        height: { exact: desired.height },
        frameRate: { exact: desired.frameRate },
      },
      {
        ...baseVideo,
        width: { min: desired.width, ideal: desired.width },
        height: { min: desired.height, ideal: desired.height },
        frameRate: { min: minFps, ideal: desired.frameRate },
      },
      {
        ...baseVideo,
        width: { min: 1280, ideal: desired.width },
        height: { min: 720, ideal: desired.height },
        frameRate: { min: minFps, ideal: desired.frameRate },
      },
      {
        ...baseVideo,
        width: { min: 720, ideal: desired.height },
        height: { min: 1280, ideal: desired.width },
        frameRate: { min: minFps, ideal: desired.frameRate },
      },
      {
        ...baseVideo,
        width: { ideal: desired.width },
        height: { ideal: desired.height },
        frameRate: { min: minFps, ideal: desired.frameRate },
      },
      {
        ...baseVideo,
        width: { ideal: desired.height },
        height: { ideal: desired.width },
        frameRate: { min: minFps, ideal: desired.frameRate },
      },
      {
        ...baseVideo,
        width: { ideal: desired.width },
        height: { ideal: desired.height },
        frameRate: { ideal: desired.frameRate },
      },
      baseVideo,
    ];
    let stream: MediaStream | undefined;
    let firstError: unknown;
    for (const video of tiers) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
        break;
      } catch (error) {
        if (!firstError) firstError = error;
      }
    }
    if (!stream) throw firstError;
    if (generation !== this.captureGeneration || !this.started) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    this.videoStream = stream;
    this.track = stream.getVideoTracks()[0];
    this.trackFacing = this.track.getSettings().facingMode === 'user' ? 'user' : 'environment';

    const maxCap = this.track.getCapabilities?.().frameRate?.max || desired.frameRate;
    if ((this.track.getSettings().frameRate || 0) < minFps) {
      const targetMax = Math.min(desired.frameRate, maxCap);
      const targetMin = Math.min(minFps, maxCap);
      const upgradeTiers: MediaTrackConstraints[] = [
        {
          width: { min: desired.width, ideal: desired.width },
          height: { min: desired.height, ideal: desired.height },
          frameRate: { min: targetMin, ideal: targetMax },
        },
        {
          width: { min: desired.height, ideal: desired.height },
          height: { min: desired.width, ideal: desired.width },
          frameRate: { min: targetMin, ideal: targetMax },
        },
        {
          width: { ideal: desired.width },
          height: { ideal: desired.height },
          frameRate: { min: targetMin, ideal: targetMax },
        },
        {
          width: { ideal: desired.height },
          height: { ideal: desired.width },
          frameRate: { min: targetMin, ideal: targetMax },
        },
        {
          width: { ideal: desired.width },
          height: { ideal: desired.height },
          frameRate: { ideal: desired.frameRate },
        },
      ];
      for (const constraints of upgradeTiers) {
        try {
          await this.track.applyConstraints(constraints);
          if ((this.track.getSettings().frameRate || 0) >= minFps) break;
        } catch {
          // Try softer frameRate constraint if Safari rejects the stricter tier.
        }
      }
    }
    if (generation !== this.captureGeneration || !this.started) return;

    this.selectedLens = this.track.getSettings().deviceId || deviceId;
    if (this.lenses.length === 0) await this.enumerateDevices();
    const wideLens = this.findPhysicalWideLens();
    const currentLens = this.lenses.find((lens) => lens.deviceId === this.selectedLens);
    const actualFps = this.track.getSettings().frameRate || 0;
    if (!deviceId) {
      const isVirtualMulti = currentLens ? this.isVirtualMultiLens(currentLens.label) : false;
      if ((isVirtualMulti || actualFps < minFps) && wideLens && wideLens.deviceId !== this.selectedLens) {
        await this.openCamera(wideLens.deviceId);
        return;
      }
    }

    this.preview.srcObject = stream;
    await this.preview.play().catch(() => undefined);
    if (generation !== this.captureGeneration || !this.started) return;

    if (actualFps < minFps && desired.frameRate >= 60) {
      const activeIndex = Math.max(0, currentLens ? this.lenses.indexOf(currentLens) : 0);
      const onPhysicalWide = wideLens?.deviceId === this.selectedLens
        || (currentLens !== undefined && this.lensLabel(currentLens, activeIndex) === '1×');
      const reportedMax = this.track.getCapabilities?.().frameRate?.max || maxCap;
      if (onPhysicalWide) {
        this.toast(`This browser capped ${this.track.label || '1×'} at ${Math.round(actualFps || 30)} FPS (max: ${Math.round(reportedMax)} FPS; check battery saver or lighting)`);
      } else {
        this.toast('This lens is capped at 30 FPS on this phone; switch to 1× for 60 FPS');
      }
    }
    if (this.preview.readyState < 1) {
      // Bounded: an unresolved wait here would block every later queued operation.
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 3000);
        this.preview.addEventListener('loadedmetadata', () => { window.clearTimeout(timer); resolve(); }, { once: true });
      });
      if (generation !== this.captureGeneration || !this.started) return;
    }

    this.track.onunmute = () => {
      this.forceNextKeyframe = true;
      void this.preview.play().catch(() => undefined);
    };
    this.track.onended = () => {
      if (this.started && document.visibilityState === 'visible') window.setTimeout(() => this.enqueue(() => this.restartCamera()), 500);
    };
    this.configureTrackUi();
    await this.restoreTorch();
    if (generation !== this.captureGeneration || !this.started) return;
    await this.configureEncoder();
    this.startFrameExtraction(generation);
    this.sendState();
  }

  /**
   * Reopens the camera with the current preset/orientation. `fallback` is the last known-good
   * preset/orientation, restored if the new request cannot be opened.
   */
  private async restartCamera(fallback?: Pick<StreamSettings, 'orientation' | 'preset'>): Promise<void> {
    if (!this.started) return;
    const lens = this.selectedLens;
    try {
      await this.switchCamera(lens);
    } catch (error) {
      if (fallback && lens && this.started) {
        // Exact presets/lens changes can fail after the old track was released. Restore the last working request.
        this.orientation = fallback.orientation;
        this.preset = fallback.preset;
        await this.openCamera(lens);
        this.syncUi();
        this.toast('Capture preset unavailable; restored the previous preset');
        return;
      }
      throw error;
    }
    this.forceNextKeyframe = true;
  }

  private stopVideoExtraction(): void {
    if (this.videoFrameCallback !== undefined) this.preview.cancelVideoFrameCallback(this.videoFrameCallback);
    this.videoFrameCallback = undefined;
    void this.reader?.cancel().catch(() => undefined);
    this.reader = undefined;
    window.clearTimeout(this.captureWatchdog);
    const worker = this.captureWorker;
    this.captureWorker = undefined;
    if (worker) {
      // Let the worker stop its cloned track (which would otherwise keep the camera busy), then kill it.
      worker.postMessage({ type: 'stop' });
      window.setTimeout(() => worker.terminate(), 300);
    }
  }

  /**
   * Frame source preference: MediaStreamTrackProcessor on the main thread (Chromium), then inside a
   * Worker (iOS Safari only exposes it there), then copying from the <video> element as a last resort.
   */
  private startFrameExtraction(generation: number): void {
    this.stopVideoExtraction();
    if ('MediaStreamTrackProcessor' in window && this.track) {
      this.captureSource = 'track';
      const processor = new MediaStreamTrackProcessor({ track: this.track });
      this.reader = processor.readable.getReader();
      void this.pumpTrackFrames(this.reader, generation);
    } else if (!this.workerCaptureUnsupported && 'Worker' in window && this.track) {
      this.startWorkerCapture(this.track, generation);
    } else {
      this.pumpVideoElementFrames(generation);
    }
  }

  private startWorkerCapture(track: MediaStreamTrack, generation: number): void {
    let worker: Worker | undefined;
    let clone: MediaStreamTrack | undefined;
    const fallback = (reason: unknown, permanent: boolean) => {
      if (!worker || this.captureWorker !== worker) return;
      console.info('Worker frame capture unavailable; using <video> frames', reason);
      if (permanent) this.workerCaptureUnsupported = true;
      this.stopVideoExtraction();
      if (generation === this.captureGeneration) this.pumpVideoElementFrames(generation);
    };
    try {
      worker = new Worker(new URL('./capture-worker.ts', import.meta.url), { type: 'module' });
      // Transfer a clone so the original keeps feeding the on-screen preview.
      clone = track.clone();
      this.captureWorker = worker;
      this.captureSource = 'worker';
      worker.postMessage({ type: 'start', track: clone }, [clone as unknown as Transferable]);
    } catch (error) {
      // Track transfer (DataCloneError) or module workers are unsupported.
      clone?.stop();
      worker?.terminate();
      this.captureWorker = undefined;
      this.workerCaptureUnsupported = true;
      console.info('Worker frame capture unavailable; using <video> frames', error);
      this.pumpVideoElementFrames(generation);
      return;
    }
    const activeWorker = worker;
    let receivedFrame = false;
    this.captureWatchdog = window.setTimeout(() => {
      if (!receivedFrame && !track.muted) fallback('no frames within 3 s', true);
    }, 3000);
    activeWorker.onmessage = (event: MessageEvent<{ type: string; frame?: VideoFrame; skipped?: number; reason?: string }>) => {
      const data = event.data;
      if (data.type === 'frame' && data.frame) {
        activeWorker.postMessage({ type: 'ack' });
        if (this.captureWorker !== activeWorker) {
          data.frame.close();
          return;
        }
        if (!receivedFrame) {
          receivedFrame = true;
          window.clearTimeout(this.captureWatchdog);
        }
        this.droppedFrames += data.skipped || 0;
        this.encodeFrame(data.frame, generation);
      } else if (data.type === 'unsupported') {
        fallback(data.reason, true);
      } else if (data.type === 'error') {
        fallback(data.reason, !receivedFrame);
      }
    };
    activeWorker.onerror = (event) => fallback(event.message, !receivedFrame);
  }

  private async pumpTrackFrames(reader: ReadableStreamDefaultReader<VideoFrame>, generation: number): Promise<void> {
    try {
      while (generation === this.captureGeneration) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        this.encodeFrame(frame, generation);
      }
    } catch (error) {
      if (generation === this.captureGeneration) console.warn('Camera frame pump stopped', error);
    }
  }

  private pumpVideoElementFrames(generation: number): void {
    this.captureSource = 'video';
    const onFrame = (now: number, metadata: VideoFrameCallbackMetadata) => {
      if (generation !== this.captureGeneration) return;
      let frame: VideoFrame | undefined;
      try {
        frame = new VideoFrame(this.preview, { timestamp: Math.round(metadata.mediaTime * 1_000_000 || now * 1000) });
        this.encodeFrame(frame, generation);
      } catch (error) {
        frame?.close();
        console.warn('VideoFrame creation failed', error);
      }
      this.videoFrameCallback = this.preview.requestVideoFrameCallback(onFrame);
    };
    this.videoFrameCallback = this.preview.requestVideoFrameCallback(onFrame);
  }

  private encodeFrame(frame: VideoFrame, generation: number): void {
    try {
      if (generation !== this.captureGeneration || !this.encoder || this.encoder.state !== 'configured' || !this.socket.isOpen) return;
      // A rebuild for a new rotation/size is queued: the current encoder must not see these frames.
      if (this.reconfigurePending) return;
      const orientation = this.frameOrientation(frame);
      // Pixel dimensions before rotation: the encoder works on the sensor-oriented buffer (or its crop).
      const crop = this.frameCrop;
      const frameWidth = crop?.width || frame.visibleRect?.width || frame.codedWidth;
      const frameHeight = crop?.height || frame.visibleRect?.height || frame.codedHeight;
      if (!this.encoderOrientation) {
        this.encoderOrientation = orientation;
      } else if (orientation.rotation !== this.encoderOrientation.rotation || orientation.flip !== this.encoderOrientation.flip) {
        // The phone was turned. Start a new encoder so the next config packet (and keyframe) carry the new
        // rotation; WebCodecs also rejects frames whose orientation differs from the encoder's first frame.
        this.encoderWidth = frameWidth;
        this.encoderHeight = frameHeight;
        this.rebuildEncoder(frameWidth, frameHeight);
        return;
      }
      if (frameWidth && frameHeight && (frameWidth !== this.encoderWidth || frameHeight !== this.encoderHeight)) {
        // Frames already in flight at the old size arrive right after an in-place resize: skip a couple
        // before concluding the camera really changed size and rebuilding the encoder.
        if (++this.sizeMismatchFrames < 3) return;
        this.sizeMismatchFrames = 0;
        this.encoderWidth = frameWidth;
        this.encoderHeight = frameHeight;
        this.rebuildEncoder(frameWidth, frameHeight);
        return;
      }
      this.sizeMismatchFrames = 0;
      // Backlog = data the server hasn't confirmed yet (end-to-end), not just Safari's local buffer.
      // Keeping it to ~250 ms of video bounds the latency: if the link is slower than the bitrate,
      // frames are skipped (lower fps) instead of piling up as ever-growing lag.
      const buffered = Math.max(this.socket.bufferedAmount, this.socket.unackedBytes);
      this.peakBufferedBytes = Math.max(this.peakBufferedBytes, buffered);
      // Room for one keyframe is the only floor, so the bound stays ~250 ms at low bitrates too.
      const socketHighWater = Math.max(256 * 1024, (this.controlBitrate() / 8) * 0.25, this.lastKeyframeBytes * 1.25);
      // Quality mode legitimately holds a few frames for lookahead/reordering.
      const maxEncodeQueue = this.activeLatencyMode === 'quality' ? 8 : 3;
      // The encoder never saw a dropped frame, so the reference chain is intact: no keyframe needed.
      // Forcing one here would inject a large I-frame exactly when the link is congested.
      if (buffered > socketHighWater) {
        this.droppedFrames++;
        this.networkDrops++;
        return;
      }
      if (this.encoder.encodeQueueSize > maxEncodeQueue) {
        this.droppedFrames++;
        this.encoderDrops++;
        return;
      }
      // WebSocket runs over TCP, so nothing is lost in transit: keyframes are only needed for joins and
      // recovery. A long GOP spends the bitrate on detail instead of on frequent large I-frames.
      const now = performance.now();
      const gopFrames = Math.max(30, Math.round((this.encoderFrameRate || 30) * KEYFRAME_INTERVAL_SECONDS));
      const forcedAllowed = this.forceNextKeyframe
        && (this.encoderFrameCount === 0 || now - this.lastKeyframeAt >= MIN_FORCED_KEYFRAME_GAP_MS);
      const keyFrame = this.encoderFrameCount === 0 || forcedAllowed || this.framesSinceKeyframe >= gopFrames;
      if (crop) {
        // A cropped view shares the camera's pixels: nothing is copied.
        const view = new VideoFrame(frame, { visibleRect: crop });
        try {
          this.encoder.encode(view, { keyFrame });
        } finally {
          view.close();
        }
      } else {
        this.encoder.encode(frame, { keyFrame });
      }
      if (keyFrame) {
        // Coalesce bursts of keyframe requests (several receivers joining, relay + receiver both asking).
        this.forceNextKeyframe = false;
        this.framesSinceKeyframe = 0;
        this.lastKeyframeAt = now;
      }
      this.framesSinceKeyframe++;
      this.encoderFrameCount++;
    } catch (error) {
      console.warn('Frame encode failed', error);
      this.droppedFrames++;
      this.forceNextKeyframe = true;
    } finally {
      frame.close();
    }
  }

  /**
   * Bitrate that actually left the encoder, clamped for flow control. Safari caps realtime encoding
   * around 15 Mbps whatever is requested, and bounding backlog time by the request (e.g. 60 Mbps)
   * would allow ~4x more queued video before dropping a frame. The 2 Mbps floor keeps the bound sane
   * while the first second's measurement is still 0; VBR scenes that encode almost nothing keep it.
   */
  private controlBitrate(): number {
    return Math.min(this.bitrate, Math.max(this.encodedBitrate, 2_000_000));
  }

  /** Hot path (every frame): no allocations beyond the result; diagnostics are assembled once per second. */
  private frameOrientation(frame: VideoFrame): FrameOrientation {
    const meta = frame as VideoFrame & { rotation?: number; flip?: boolean };
    if (this.sampleFrameMeta) {
      // Copy plain fields once per second for diagnostics (a closed VideoFrame reports 0x0).
      this.sampleFrameMeta = false;
      this.lastFrameMeta = {
        rotation: meta.rotation, flip: meta.flip,
        codedWidth: frame.codedWidth, codedHeight: frame.codedHeight,
        displayWidth: frame.displayWidth, displayHeight: frame.displayHeight,
      };
    }
    // How the camera would be shown upright for the way the phone is held right now (Safari's <video>).
    const fromFrame = typeof meta.rotation === 'number';
    const display = fromFrame ? normalizeRotation(meta.rotation)
      : IS_IOS ? ((DEVICE_ROTATION[this.trackFacing] as Record<string, number>)[String(interfaceOrientation())] ?? 0) : 0;
    // Frames copied from the <video> element are already turned by that amount; sensor frames are not.
    const bufferRotation = this.captureSource === 'video' && IS_IOS ? display : 0;
    const visible = frame.visibleRect
      ? { x: frame.visibleRect.x, y: frame.visibleRect.y, width: frame.visibleRect.width, height: frame.visibleRect.height }
      : { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
    const { rotation, crop } = this.geometry(visible, bufferRotation, display);
    this.watchHold(display, rotation);
    this.setFrameCrop(crop, visible, rotation);
    this.setDisplayRotation(display, quarterTurns(rotation + bufferRotation - display));
    const source = fromFrame ? 'frame' : this.captureSource === 'video' || !IS_IOS ? 'video' : 'device';
    return { rotation, flip: fromFrame ? Boolean(meta.flip) : false, source };
  }

  /**
   * Rotation to send (fixed by the chosen aspect and the 180° turn, never by how the phone is held) and the
   * buffer rectangle to encode (the whole frame, unless the encoder refused that size).
   */
  private geometry(visible: CropRect, bufferRotation: number, display = 0): { rotation: number; crop: CropRect | null } {
    const rotation = IS_IOS
      ? encodeRotation(sensorRotation(this.orientation, this.turned, this.trackFacing, true), bufferRotation, visible.width, visible.height, this.orientation)
      : uprightEncodeRotation(visible.width, visible.height, display, this.orientation, this.turned);
    return { rotation, crop: this.encodeLimit ? limitCrop(visible, null, this.encodeLimit) : null };
  }

  /**
   * Size the first frames will be encoded at, before any frame has arrived. iOS reports the capture size the
   * way the phone is held (2160×3840 when upright), but frames arrive in sensor orientation (landscape).
   */
  private expectedEncodeSize(width: number, height: number): { width: number; height: number } {
    const visible = IS_IOS && this.captureSource !== 'video'
      ? { x: 0, y: 0, width: Math.max(width, height), height: Math.min(width, height) }
      : { x: 0, y: 0, width, height };
    const display = IS_IOS ? ((DEVICE_ROTATION[this.trackFacing] as Record<string, number>)[String(interfaceOrientation())] ?? 0) : 0;
    const bufferRotation = this.captureSource === 'video' && IS_IOS ? display : 0;
    const { crop } = this.geometry(visible, bufferRotation, display);
    return crop ? { width: crop.width, height: crop.height } : { width: visible.width, height: visible.height };
  }

  /** Largest size (same aspect, steps of 4 %) the encoder accepts, when the full size is refused. */
  private async findEncodableSize(width: number, height: number, frameRate: number, bitrate = this.bitrate): Promise<{ width: number; height: number } | null> {
    if (!VideoEncoder.isConfigSupported) return null;
    for (let scale = 0.96; scale >= 0.3; scale *= 0.96) {
      const w = Math.floor((width * scale) / 16) * 16;
      const h = Math.floor((height * scale) / 16) * 16;
      for (const candidate of this.buildEncoderCandidates(w, h, frameRate, bitrate)) {
        try {
          if ((await VideoEncoder.isConfigSupported(candidate.config)).supported) return { width: w, height: h };
        } catch {
          // Try the next candidate / size.
        }
      }
    }
    return null;
  }

  private setFrameCrop(crop: CropRect | null, visible: CropRect, rotation: number): void {
    this.frameCrop = crop;
    const quarter = rotation % 180 !== 0;
    const share = crop
      ? { width: (quarter ? crop.height : crop.width) / (quarter ? visible.height : visible.width), height: (quarter ? crop.width : crop.height) / (quarter ? visible.width : visible.height) }
      : { width: 1, height: 1 };
    if (Math.abs(share.width - this.cropShare.width) < 0.001 && Math.abs(share.height - this.cropShare.height) < 0.001) return;
    this.cropShare = share;
    this.updateCropGuide();
  }

  /** Shades the part of the preview that is not sent (only when the encoder limit crops the frame). */
  private updateCropGuide(): void {
    const guide = $('crop-guide');
    const content = this.started ? this.previewContentRect() : null;
    const stage = this.preview.parentElement;
    if (!content || !stage || (this.cropShare.width > 0.995 && this.cropShare.height > 0.995)) {
      guide.hidden = true;
      return;
    }
    const origin = stage.getBoundingClientRect();
    const width = content.width * this.cropShare.width;
    const height = content.height * this.cropShare.height;
    Object.assign(guide.style, {
      left: `${content.left - origin.left + (content.width - width) / 2}px`,
      top: `${content.top - origin.top + (content.height - height) / 2}px`,
      width: `${width}px`,
      height: `${height}px`,
    });
    guide.hidden = false;
  }

  /** Rotates the local preview (cheaply, only on change) so it matches the picture the PC receives. */
  private setDisplayRotation(display: number, preview: number): void {
    if (display === this.displayRotation && preview === this.previewRotation) return;
    this.displayRotation = display;
    this.previewRotation = preview;
    this.layoutPreview();
  }

  private orientationDiagnostics(): Record<string, unknown> {
    const meta = this.lastFrameMeta;
    return {
      ...this.encoderOrientation,
      frameRotation: typeof meta?.rotation === 'number' ? meta.rotation : null,
      frameFlip: typeof meta?.flip === 'boolean' ? meta.flip : null,
      interfaceOrientation: interfaceOrientation(),
      displayRotation: this.displayRotation,
      turned: this.turned,
      coded: meta ? `${meta.codedWidth}x${meta.codedHeight}` : null,
      display: meta ? `${meta.displayWidth}x${meta.displayHeight}` : null,
      capture: this.captureSource,
      ios: IS_IOS,
    };
  }

  private rebuildEncoder(width?: number, height?: number): void {
    if (this.reconfigurePending) return;
    this.reconfigurePending = true;
    this.enqueue(async () => {
      try {
        await this.configureEncoder(width, height);
      } finally {
        this.reconfigurePending = false;
      }
    });
  }

  /** Full codec strings to try for a base codec, best first. */
  private codecVariants(codecBase: string, width: number, height: number, frameRate: number, bitrate: number): string[] {
    // High profile first, then Main and Constrained Baseline for hardware encoders that reject High (12 MP uses level 6.0).
    if (codecBase === CODEC_H264) return h264Codecs(width, height, frameRate, bitrate);
    // HEVC High tier for high bitrates; Main tier stays as the last resort for encoders that reject it.
    if (codecBase === CODEC_HEVC) return hevcCodecs(width, height, bitrate);
    return [codecBase];
  }

  private buildEncoderConfig(
    codec: string,
    width: number,
    height: number,
    frameRate: number,
    bitrate: number,
    bitrateMode: BitrateMode,
    latencyMode: LatencyMode,
  ): VideoEncoderConfig & Record<string, unknown> {
    const config: VideoEncoderConfig & Record<string, unknown> = {
      codec,
      width,
      height,
      bitrate,
      framerate: frameRate,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode,
      bitrateMode,
    };
    if (codec.startsWith('avc1')) config.avc = { format: 'avc' };
    if (codec.startsWith('hvc1')) config.hevc = { format: 'hevc' };
    return config;
  }

  /** Ordered fallbacks: codec variant, then latency mode, then rate control; H.264 last if HEVC fails. */
  private buildEncoderCandidates(width: number, height: number, frameRate: number, bitrate: number): EncoderCandidate[] {
    const latencies: LatencyMode[] = this.latencyMode === 'quality' ? ['quality', 'realtime'] : ['realtime', 'quality'];
    const modes: BitrateMode[] = this.requestedBitrateMode === 'variable' ? ['variable', 'constant'] : ['constant', 'variable'];
    const bases = this.codec === CODEC_H264 ? [CODEC_H264] : [this.codec, CODEC_H264];
    const candidates: EncoderCandidate[] = [];
    for (const codecBase of bases) {
      for (const codec of this.codecVariants(codecBase, width, height, frameRate, bitrate)) {
        for (const latencyMode of latencies) {
          for (const bitrateMode of modes) {
            candidates.push({
              config: this.buildEncoderConfig(codec, width, height, frameRate, bitrate, bitrateMode, latencyMode),
              codecBase,
              bitrateMode,
              latencyMode,
              isCodecFallback: codecBase !== this.codec,
            });
          }
        }
      }
    }
    return candidates;
  }

  private async configureEncoder(overrideWidth?: number, overrideHeight?: number): Promise<void> {
    if (!this.track || !this.started) return;
    const generation = ++this.encoderGeneration;
    this.encoderFallbackTried = false;
    const preset = this.desiredDimensions();
    const settings = this.track.getSettings();
    // Encode the size that will actually be sent, in sensor orientation (iOS reports the capture size the way
    // the phone is held); a frame may be cropped to what the encoder accepts.
    const size = overrideWidth && overrideHeight
      ? { width: overrideWidth, height: overrideHeight }
      : this.expectedEncodeSize(settings.width || this.preview.videoWidth || preset.width, settings.height || this.preview.videoHeight || preset.height);
    const frameRate = settings.frameRate || preset.frameRate;
    this.encoderWidth = size.width;
    this.encoderHeight = size.height;
    this.encoderFrameRate = frameRate;
    this.encoderCandidates = this.buildEncoderCandidates(size.width, size.height, frameRate, this.bitrate);
    try {
      await this.startEncoderFrom(0, generation);
    } catch (error) {
      if (generation !== this.encoderGeneration) return;
      if (!(await this.configureEncoderFallback(size.width, size.height, frameRate, generation))) throw error;
    }
  }

  /** Step down bitrate at full resolution first, then crop to the largest frame size the hardware encoder accepts. */
  private async configureEncoderFallback(width: number, height: number, frameRate: number, generation: number): Promise<boolean> {
    if (this.encoderFallbackTried || generation !== this.encoderGeneration) return false;
    this.encoderFallbackTried = true;
    for (const bitrate of [40_000_000, 20_000_000, MIN_BITRATE].filter((b) => b < this.bitrate)) {
      if (generation !== this.encoderGeneration) return false;
      this.encoderCandidates = this.buildEncoderCandidates(width, height, frameRate, bitrate);
      try {
        await this.startEncoderFrom(0, generation);
        if (generation !== this.encoderGeneration) return false;
        this.bitrate = bitrate;
        this.savePreferences();
        this.syncUi();
        this.sendState();
        this.toast(`This phone encodes up to ${Math.round(bitrate / 1_000_000)} Mbps for this format`, 5000);
        return true;
      } catch {
        // Try the next lower bitrate.
      }
    }
    let fitBitrate = this.bitrate;
    let fit = await this.findEncodableSize(width, height, frameRate, fitBitrate);
    if (!fit && this.bitrate > MIN_BITRATE) {
      fitBitrate = MIN_BITRATE;
      fit = await this.findEncodableSize(width, height, frameRate, fitBitrate);
    }
    if (!fit || generation !== this.encoderGeneration) return false;
    this.encodeLimit = { long: Math.max(fit.width, fit.height), short: Math.min(fit.width, fit.height) };
    this.encoderWidth = fit.width;
    this.encoderHeight = fit.height;
    if (fitBitrate !== this.bitrate) {
      this.bitrate = fitBitrate;
      this.savePreferences();
    }
    this.encoderCandidates = this.buildEncoderCandidates(fit.width, fit.height, frameRate, this.bitrate);
    await this.startEncoderFrom(0, generation);
    this.syncUi();
    this.sendState();
    this.toast(`This phone encodes up to ${Math.max(fit.width, fit.height)}×${Math.min(fit.width, fit.height)} for this format; the picture is cropped to fit`, 5000);
    return true;
  }

  /** Starts the first usable candidate at or after `start` (also used when the hardware rejects one later). */
  private async startEncoderFrom(start: number, generation: number): Promise<void> {
    const track = this.track;
    const isCurrent = () => generation === this.encoderGeneration && track === this.track && this.started;
    const candidates = this.encoderCandidates;
    let lastError: unknown;
    for (let index = start; index < candidates.length; index++) {
      if (!isCurrent()) return;
      const candidate = candidates[index];
      if (VideoEncoder.isConfigSupported) {
        try {
          const support = await VideoEncoder.isConfigSupported(candidate.config);
          if (!isCurrent()) return;
          if (!support.supported) continue;
        } catch (error) {
          if (!isCurrent()) return;
          lastError = error;
          continue;
        }
      }
      try {
        this.createEncoder(candidate.config, generation);
      } catch (error) {
        lastError = error;
        continue;
      }
      this.encoderCandidateIndex = index;
      this.bitrateMode = candidate.bitrateMode;
      this.activeLatencyMode = candidate.latencyMode;
      this.activeCodec = candidate.config.codec;
      if (candidate.isCodecFallback && this.codec !== CODEC_H264) {
        this.codec = CODEC_H264;
        this.savePreferences();
        this.syncUi();
        this.toast('HEVC unavailable on this device; switched to H.264 High');
      }
      this.forceNextKeyframe = true;
      this.encoderFrameCount = 0;
      this.framesSinceKeyframe = 0;
      this.sendState();
      return;
    }
    if (lastError instanceof Error) throw lastError;
    const first = candidates[0]?.config;
    throw new Error(`${codecName(this.codec)} encoder is unavailable at ${first?.width ?? 0}×${first?.height ?? 0}`);
  }

  private createEncoder(config: VideoEncoderConfig, generation: number): void {
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close();
    this.lastVideoConfigPacket = undefined;
    this.encoderOrientation = null;
    this.encoderProducedOutput = false;
    const encoder: VideoEncoder = new VideoEncoder({
      output: (chunk, metadata) => {
        if (generation !== this.encoderGeneration || this.encoder !== encoder) return;
        this.encoderErrorCount = 0;
        this.encoderProducedOutput = true;
        if (metadata?.decoderConfig) {
          const orientation = this.encoderOrientation ?? { rotation: 0, flip: false };
          const configPacket = encodeJsonPacket(PACKET.VIDEO_CONFIG, {
            ...videoMetadataToWire(metadata),
            orientation: { rotation: orientation.rotation, flip: orientation.flip },
          });
          this.lastVideoConfigPacket = configPacket;
          this.socket.send(configPacket);
        }
        const packet = encodeVideoChunk(chunk);
        if (chunk.type === 'key') this.lastKeyframeBytes = packet.byteLength;
        if (this.socket.send(packet)) {
          this.sentBytes += packet.byteLength;
          this.sentFrames++;
        } else {
          this.forceNextKeyframe = true;
        }
      },
      error: (error) => {
        if (generation !== this.encoderGeneration || this.encoder !== encoder) return;
        console.error('Video encoder error', error);
        this.forceNextKeyframe = true;
        if (!this.encoderProducedOutput) {
          // isConfigSupported accepted it but the hardware did not: move on to the next candidate or fallback.
          const next = this.encoderCandidateIndex + 1;
          this.enqueue(async () => {
            if (next < this.encoderCandidates.length) {
              await this.startEncoderFrom(next, generation);
            } else if (!(await this.configureEncoderFallback(this.encoderWidth, this.encoderHeight, this.encoderFrameRate, generation))) {
              this.toast('Encoder failed on this device. Try H.264 or a lower format/bitrate in Settings.', 6000);
            }
          });
          return;
        }
        this.encoderErrorCount++;
        if (this.encoderErrorCount > 2) {
          this.toast('Encoder stopped after repeated errors. Try H.264 or a lower format in Settings, or reload the page.', 6000);
          return;
        }
        this.toast('Encoder restarted after an error');
        if (this.started) this.enqueue(() => this.configureEncoder());
      },
    });
    this.encoder = encoder;
    encoder.configure(config);
  }

  private async enumerateDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    this.lenses = devices.filter((device) => device.kind === 'videoinput');
    this.microphones = devices.filter((device) => device.kind === 'audioinput');
    this.renderLenses();
    this.renderMicrophones();
    this.sendState();
  }

  private isVirtualMultiLens(label: string): boolean {
    return /triple|dual|doble|dupla|doppia|double|fusion|auto/i.test(label);
  }

  private findPhysicalWideLens(): MediaDeviceInfo | undefined {
    return this.lenses.find((lens) =>
      /wide|back|rear|trasera|gran angular|posterior/i.test(lens.label)
      && !this.isVirtualMultiLens(lens.label)
      && !/ultra|0[.,]5|tele|periscop|front|face|frontal|delantera/i.test(lens.label),
    );
  }

  private lensLabel(device: MediaDeviceInfo, index: number): string {
    const label = device.label || `Camera ${index + 1}`;
    if (/ultra|0[.,]5/i.test(label)) return '0.5×';
    if (/tele|periscop/i.test(label)) return 'Tele';
    if (/macro/i.test(label)) return 'Macro';
    if (/front|face|frontal|delantera/i.test(label)) return 'Front';
    if (this.isVirtualMultiLens(label)) return 'Auto';
    if (/wide|back|rear|trasera|gran angular|posterior/i.test(label)) return '1×';
    return label.replace(/\s*(camera|cámara)\s*/gi, ' ').trim() || `Lens ${index + 1}`;
  }

  private getLensLabels(): string[] {
    const counts = new Map<string, number>();
    return this.lenses.map((device, index) => {
      let label = this.lensLabel(device, index);
      if (IS_IOS && label === '1×' && counts.has('1×') && !counts.has('Auto')) {
        label = 'Auto';
      }
      const seen = (counts.get(label) || 0) + 1;
      counts.set(label, seen);
      if (seen > 1 && !IS_IOS && label === '1×') return `Back ${seen}`;
      return seen === 1 ? label : `${label} (${seen})`;
    });
  }

  /**
   * Lenses shown on the phone, ordered like the Camera app (0.5×, 1×, Back N, Tele, Macro, Auto, Front).
   * iOS exposes up to three virtual multi-lens cameras (Dual, Dual Wide, Triple) that all switch lenses
   * automatically; only the most capable one is shown as "Auto" (plus whichever is in use).
   */
  private visibleLenses(labels: string[]): number[] {
    const autoRank = (label: string) => (/triple/i.test(label) ? 0 : /dual wide|doble gran|dual-wide/i.test(label) ? 1 : 2);
    const autos = this.lenses.map((device, index) => ({ device, index }))
      .filter(({ device, index }) => labels[index].startsWith('Auto') && (IS_IOS || this.isVirtualMultiLens(device.label)))
      .sort((a, b) => autoRank(a.device.label) - autoRank(b.device.label));
    const hidden = new Set(autos.slice(1).filter(({ device }) => device.deviceId !== this.selectedLens).map(({ index }) => index));
    const orderList = ['0.5×', '1×', 'Back', 'Tele', 'Macro', 'Auto', 'Front'];
    const order = (label: string) => {
      const idx = orderList.findIndex((name) => label.startsWith(name));
      return idx === -1 ? orderList.length : idx;
    };
    return this.lenses.map((_, index) => index)
      .filter((index) => !hidden.has(index))
      .sort((a, b) => order(labels[a]) - order(labels[b]) || a - b);
  }

  /** Lenses shown in the UI (iPhone and PC studio): deduplicated Auto and Camera-app order. */
  private visibleLensEntries(): Array<{ deviceId: string; label: string; detail: string }> {
    const labels = this.getLensLabels();
    const visible = this.visibleLenses(labels);
    const autoCount = visible.filter((index) => labels[index].startsWith('Auto')).length;
    return visible.map((index) => {
      const device = this.lenses[index];
      // A single Auto entry needs no "(2)" suffix.
      const label = autoCount === 1 && labels[index].startsWith('Auto') ? 'Auto' : labels[index];
      return { deviceId: device.deviceId, label, detail: device.label || label };
    });
  }

  private renderLenses(): void {
    const container = $('lens-buttons');
    container.replaceChildren();
    for (const entry of this.visibleLensEntries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = entry.label;
      button.title = entry.detail;
      const active = entry.deviceId === this.selectedLens;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
      button.addEventListener('click', () => {
        if (entry.deviceId !== this.selectedLens) this.enqueue(() => this.switchCamera(entry.deviceId));
      });
      container.append(button);
    }
  }

  private renderMicrophones(): void {
    const select = $<HTMLSelectElement>('mic-device');
    const value = this.selectedMicrophone;
    select.replaceChildren(new Option('Default microphone', ''));
    this.microphones.forEach((device, index) => select.add(new Option(device.label || `Microphone ${index + 1}`, device.deviceId)));
    select.value = value;
    select.disabled = !this.micEnabled;
  }

  private configureTrackUi(): void {
    if (!this.track) return;
    const capabilities = this.track.getCapabilities?.() || {};
    const settings = this.track.getSettings();
    const zoom = capabilities.zoom;
    const zoomInput = $<HTMLInputElement>('zoom');
    zoomInput.disabled = !zoom;
    if (zoom) {
      zoomInput.min = String(zoom.min);
      zoomInput.max = String(zoom.max);
      zoomInput.step = String(zoom.step || 0.1);
      zoomInput.value = String((settings as MediaTrackSettings & { zoom?: number }).zoom || zoom.min);
      $('zoom-label').textContent = `${Number(zoomInput.value).toFixed(1)}×`;
      paintRange(zoomInput);
    }
    $<HTMLButtonElement>('torch').disabled = !capabilities.torch;
    this.configureModeSelect('focus-mode', capabilities.focusMode, this.focusMode);
    this.configureModeSelect('exposure-mode', capabilities.exposureMode, this.exposureMode);
    $<HTMLInputElement>('exposure-ev').disabled = false;
    this.applyExposureVisual(this.exposureEv);
    this.renderLenses();
  }

  private configureModeSelect(id: string, modes: string[] | undefined, activeMode: string): void {
    const select = $<HTMLSelectElement>(id);
    select.disabled = false;
    const available = modes?.length ? modes : ['continuous', 'manual'];
    select.replaceChildren(...available.map((mode) => new Option(formatTrackMode(mode), mode)));
    if (available.includes(activeMode)) select.value = activeMode;
  }

  private scheduleZoom(value: number): void {
    this.pendingZoom = value;
    if (this.applyingZoom) return;
    void this.flushZoom();
  }

  private async flushZoom(): Promise<void> {
    if (!this.track) {
      this.pendingZoom = null;
      return;
    }
    this.applyingZoom = true;
    try {
      while (this.pendingZoom !== null && this.track) {
        const value = this.pendingZoom;
        this.pendingZoom = null;
        await this.applyAdvanced({ zoom: value });
      }
      this.sendState();
    } catch (error) {
      this.toast('Zoom is not supported by this lens');
      console.warn(error);
    } finally {
      this.applyingZoom = false;
    }
  }

  private async applyTrackConstraint(property: 'zoom' | 'focusMode' | 'exposureMode', value: number | string): Promise<void> {
    if (!this.track) return;
    if (property === 'zoom') {
      this.scheduleZoom(Number(value));
      return;
    }
    const mode = String(value);
    if (property === 'focusMode') this.focusMode = mode;
    else this.exposureMode = mode;

    const capabilities = this.track.getCapabilities?.() || {};
    const supportedModes = property === 'focusMode' ? capabilities.focusMode : capabilities.exposureMode;
    const candidates = mode === 'manual' ? ['manual', 'single-shot', 'locked'] : [mode];
    let applied = false;
    for (const candidate of candidates) {
      try {
        await this.applyAdvanced({ [property]: candidate });
        applied = true;
        break;
      } catch {
        // Try next candidate or report Safari hardware limitation below.
      }
    }
    if (!applied && !supportedModes?.length) {
      this.toast('This browser locks AF/AE in hardware; use the EV slider to adjust exposure');
    } else if (!applied) {
      const label = property === 'focusMode' ? 'Focus mode' : 'Exposure mode';
      this.toast(`${label} is not supported by this lens`);
    }
    this.syncUi();
    this.sendState();
  }

  /**
   * applyConstraints may replace the track's whole constraint set, so every partial change re-states the
   * current zoom and torch: changing focus, EV or zoom must never switch the torch off or reset the zoom.
   */
  private applyAdvanced(changes: MediaTrackConstraintSet, track = this.track): Promise<void> {
    if (!track) return Promise.resolve();
    const capabilities = track.getCapabilities?.() || {};
    const keep: MediaTrackConstraintSet = {};
    const zoom = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom;
    if (capabilities.zoom && zoom) keep.zoom = zoom;
    if (capabilities.torch && this.torch) keep.torch = true;
    return track.applyConstraints({ advanced: [{ ...keep, ...changes }] });
  }

  /** EV that the camera hardware cannot apply and must be emulated with a display-side CSS filter. */
  private softwareEv(): number {
    const evCap = this.track?.getCapabilities?.()?.exposureCompensation;
    if (!evCap) return this.exposureEv;
    const hardwareEv = Math.max(evCap.min, Math.min(evCap.max, this.exposureEv));
    return Math.round((this.exposureEv - hardwareEv) * 10) / 10;
  }

  /**
   * Tap-to-focus at a normalized (0..1) frame position, only while autofocus (continuous) is selected.
   * Uses a real focus point where Safari exposes one; otherwise re-triggers an autofocus pass.
   */
  private async focusAt(x: number, y: number): Promise<'point' | 'refocus' | 'locked' | 'unsupported'> {
    const track = this.track;
    if (!track) return 'unsupported';
    if (this.focusMode !== 'continuous') return 'locked';
    const capabilities = track.getCapabilities?.() || {};
    const point = { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
    if ('pointsOfInterest' in capabilities || 'pointsOfInterest' in track.getSettings()) {
      try {
        await this.applyAdvanced({ pointsOfInterest: [point] }, track);
        return 'point';
      } catch {
        // Fall through to a plain autofocus pass.
      }
    }
    const modes = capabilities.focusMode || [];
    if (modes.includes('single-shot')) {
      try {
        await this.applyAdvanced({ focusMode: 'single-shot' }, track);
        // Return to continuous AF once the one-off pass has settled, unless the user changed mode meanwhile.
        window.setTimeout(() => {
          if (this.track === track && this.focusMode === 'continuous') {
            void this.applyAdvanced({ focusMode: 'continuous' }, track).catch(() => undefined);
          }
        }, 1200);
        return 'refocus';
      } catch {
        // Fall through.
      }
    }
    if (modes.includes('continuous')) {
      try {
        await this.applyAdvanced({ focusMode: 'continuous' }, track);
        return 'refocus';
      } catch {
        // Fall through.
      }
    }
    return 'unsupported';
  }

  private async handleFocusRequest(x: number, y: number, source: 'local' | 'remote'): Promise<void> {
    // (x, y) is a point of the sent picture; the camera takes it in Safari's upright view of the camera.
    const camera = rotatePoint(x, y, -this.previewRotation);
    const result = await this.focusAt(camera.x, camera.y);
    this.showFocusRing(x, y, result);
    this.socket.sendControl('sender-focus', { result, x, y });
    if (source === 'local') this.toastFocusResult(result);
  }

  private focusNoticeShown = false;

  private toastFocusResult(result: string): void {
    if (result === 'locked') this.toast('Focus is locked. Set Focus to Continuous to tap-to-focus');
    else if (result === 'unsupported' && !this.focusNoticeShown) this.toast('This browser does not expose focus control on this lens');
    else if (result === 'refocus' && !this.focusNoticeShown) this.toast('Refocusing (this browser only allows a full-frame autofocus pass)');
    if (result === 'unsupported' || result === 'refocus') this.focusNoticeShown = true;
  }

  /**
   * Sizes and turns the <video> inside its stage. Safari shows the camera the way the phone is held; a
   * quarter turn swaps the box so `object-fit: contain` still fills the stage after the CSS rotation.
   */
  private layoutPreview(): void {
    const stage = this.preview.parentElement;
    if (!stage) return;
    const quarter = this.previewRotation % 180 !== 0;
    const width = stage.clientWidth;
    const height = stage.clientHeight;
    this.preview.style.width = `${quarter ? height : width}px`;
    this.preview.style.height = `${quarter ? width : height}px`;
    this.preview.style.transform = `translate(-50%, -50%) rotate(${this.previewRotation}deg)`;
    this.updateCropGuide();
  }

  /** On-screen rectangle of the sent picture inside the letterboxed, rotated preview. */
  private previewContentRect(): { left: number; top: number; width: number; height: number } | null {
    const stage = this.preview.parentElement;
    if (!stage || !this.preview.videoWidth || !this.preview.videoHeight) return null;
    const quarter = this.previewRotation % 180 !== 0;
    const pictureWidth = quarter ? this.preview.videoHeight : this.preview.videoWidth;
    const pictureHeight = quarter ? this.preview.videoWidth : this.preview.videoHeight;
    const rect = stage.getBoundingClientRect();
    const scale = Math.min(rect.width / pictureWidth, rect.height / pictureHeight);
    const width = pictureWidth * scale;
    const height = pictureHeight * scale;
    return { left: rect.left + (rect.width - width) / 2, top: rect.top + (rect.height - height) / 2, width, height };
  }

  /** Maps a tap on the preview to picture coordinates (as the PC sees them); ignores taps on the black bars. */
  private bindTapToFocus(): void {
    this.preview.parentElement?.addEventListener('click', (event) => {
      const content = this.started ? this.previewContentRect() : null;
      if (!content) return;
      const x = (event.clientX - content.left) / content.width;
      const y = (event.clientY - content.top) / content.height;
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      void this.handleFocusRequest(x, y, 'local');
    });
  }

  private showFocusRing(x: number, y: number, result: string): void {
    const content = this.previewContentRect();
    if (!content) return;
    const ring = $('focus-ring');
    // A refocus pass is full-frame, so the ring goes to the centre to avoid implying a point was used.
    const [px, py] = result === 'point' ? [x, y] : [0.5, 0.5];
    ring.style.left = `${content.left + px * content.width}px`;
    ring.style.top = `${content.top + py * content.height}px`;
    ring.dataset.result = result;
    ring.classList.remove('visible');
    void ring.offsetWidth;
    ring.classList.add('visible');
  }

  private applyExposureVisual(ev: number): void {
    const input = $<HTMLInputElement>('exposure-ev');
    input.value = String(ev);
    $('ev-label').textContent = `${ev > 0 ? '+' : ''}${ev.toFixed(1)} EV`;
    paintRange(input);
    // Hardware EV is already baked into the frames; only the residual is emulated (avoids applying it twice).
    const residual = this.softwareEv();
    this.preview.style.filter = residual === 0 ? '' : `brightness(${Math.pow(2, residual * 0.5).toFixed(3)})`;
  }

  private setExposureEv(rawValue: number): void {
    const ev = Math.max(-2, Math.min(2, Math.round((Number(rawValue) || 0) * 10) / 10));
    this.exposureEv = ev;
    this.applyExposureVisual(ev);
    const evCap = this.track?.getCapabilities?.()?.exposureCompensation;
    if (this.track && evCap) {
      const hardwareEv = Math.max(evCap.min, Math.min(evCap.max, ev));
      void this.applyAdvanced({ exposureCompensation: hardwareEv }).catch(() => undefined);
    }
    this.sendState();
  }

  private async setTorch(enabled: boolean): Promise<void> {
    if (await this.applyTorch(enabled)) this.torchWanted = enabled;
    else if (enabled) this.toast('Torch is unavailable on the active lens');
  }

  /** Re-lights the torch after a camera reopen if the user had it on and the new lens has one. */
  private async restoreTorch(): Promise<void> {
    if (this.torchWanted && this.track?.getCapabilities?.().torch) await this.applyTorch(true);
  }

  private async applyTorch(enabled: boolean): Promise<boolean> {
    if (!this.track) return false;
    try {
      await this.applyAdvanced({ torch: enabled });
      this.torch = enabled;
      return true;
    } catch {
      return false;
    } finally {
      this.updateTorchUi();
      this.sendState();
    }
  }

  private updateTorchUi(): void {
    const button = $('torch');
    button.classList.toggle('active', this.torch);
    button.setAttribute('aria-pressed', String(this.torch));
    button.textContent = this.torch ? 'Torch on' : 'Torch';
  }

  /**
   * Applies the new preset/orientation to the live track. Returns false (leaving the caller to reopen the
   * camera) when Safari can't deliver exactly that size from the current capture session.
   */
  private async resizeInPlace(): Promise<boolean> {
    const track = this.track;
    if (!track || track.readyState !== 'live') return false;
    const desired = this.desiredDimensions();
    const capabilities = track.getCapabilities?.() || {};
    const maxFps = capabilities.frameRate?.max || desired.frameRate;
    const minFps = Math.min(desired.frameRate >= 60 ? 50 : desired.frameRate, maxFps);
    // applyConstraints replaces the whole constraint set: carry zoom and torch over so they don't reset.
    const current = track.getSettings() as MediaTrackSettings & { zoom?: number };
    const keep: MediaTrackConstraintSet = {};
    if (capabilities.zoom && current.zoom) keep.zoom = current.zoom;
    if (capabilities.torch && this.torchWanted) keep.torch = true;
    try {
      await track.applyConstraints({
        width: { exact: desired.width },
        height: { exact: desired.height },
        frameRate: { min: minFps, ideal: desired.frameRate },
        ...(Object.keys(keep).length ? { advanced: [keep] } : {}),
      });
    } catch {
      return false;
    }
    const settings = track.getSettings();
    // iOS reports the size rotated when the phone is upright (1080×1920 for a 1920×1080 capture): accept both.
    const sameSize = (settings.width === desired.width && settings.height === desired.height)
      || (settings.width === desired.height && settings.height === desired.width);
    if (track !== this.track || !sameSize) return false;
    await this.restoreTorch();
    this.configureTrackUi();
    await this.configureEncoder();
    this.forceNextKeyframe = true;
    return true;
  }

  private async restartMicrophone(): Promise<void> {
    this.stopAudio();
    await this.setMicrophone(true);
  }

  private async setMicrophone(enabled: boolean): Promise<void> {
    this.micEnabled = enabled;
    try {
      if (enabled) {
        await this.startAudio();
        await this.enumerateDevices();
      } else {
        this.stopAudio();
        this.muted = false;
        this.audioPeak = 0;
      }
    } catch (error) {
      this.micEnabled = false;
      this.muted = false;
      this.stopAudio();
      this.reportMicProblem(microphoneErrorMessage(error));
      throw new Error(this.micProblem ?? 'Microphone failed');
    } finally {
      const micButton = $('mic');
      micButton.classList.toggle('active', this.micEnabled);
      micButton.setAttribute('aria-pressed', String(this.micEnabled));
      micButton.textContent = this.micEnabled ? 'Mic on' : 'Mic off';
      const muteButton = $<HTMLButtonElement>('mute');
      const mutedActive = this.micEnabled && this.muted;
      muteButton.classList.toggle('active', mutedActive);
      muteButton.setAttribute('aria-pressed', String(mutedActive));
      muteButton.textContent = mutedActive ? 'Muted' : 'Mute';
      muteButton.disabled = !this.micEnabled;
      $<HTMLSelectElement>('mic-device').disabled = !this.micEnabled;
      this.sendState();
    }
  }

  private async startAudio(): Promise<void> {
    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          deviceId: this.selectedMicrophone ? { exact: this.selectedMicrophone } : undefined,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      const settings = this.micStream.getAudioTracks()[0].getSettings();
      this.selectedMicrophone = settings.deviceId || this.selectedMicrophone;
      try {
        this.audioContext = new AudioContext({ sampleRate: settings.sampleRate || 48000, latencyHint: 'interactive' });
      } catch {
        this.audioContext = new AudioContext({ latencyHint: 'interactive' });
      }
      await this.audioContext.audioWorklet.addModule('/pcm-capture-worklet.js');
      const source = this.audioContext.createMediaStreamSource(this.micStream);
      this.audioNode = new AudioWorkletNode(this.audioContext, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1 });
      const sink = this.audioContext.createGain();
      sink.gain.value = 0;
      source.connect(this.audioNode).connect(sink).connect(this.audioContext.destination);
      this.audioNode.port.onmessage = (event: MessageEvent<{ samples: ArrayBuffer; peak: number; timestamp: number }>) => {
        const samples = new Float32Array(event.data.samples);
        this.audioPeak = event.data.peak;
        if (!this.micEnabled || this.muted || !this.socket.isOpen) return;
        const pcm = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
        if (this.socket.send(encodePcmChunk(event.data.timestamp, pcm))) this.audioPacketsSent++;
      };
      const audioConfigPacket = encodeJsonPacket(PACKET.AUDIO_CONFIG, {
        decoderConfig: { codec: 'pcm-s16le', sampleRate: this.audioContext.sampleRate, numberOfChannels: 1 },
        sampleRate: this.audioContext.sampleRate,
        channels: 1,
        bitsPerSample: 16,
      });
      this.lastAudioConfigPacket = audioConfigPacket;
      this.socket.send(audioConfigPacket);
      this.micEnabled = true;
      await this.ensureAudioRunning();
    } catch (error) {
      this.micEnabled = false;
      this.stopAudio();
      this.syncUi();
      this.sendState();
      throw error;
    }
  }

  /**
   * iOS may keep an AudioContext suspended until the user touches the page (e.g. the mic was turned on
   * from the PC). resume() can then stay pending, so never await it unbounded inside the operation queue:
   * wait briefly, and otherwise start on the next tap and tell both screens.
   */
  private async ensureAudioRunning(): Promise<void> {
    const context = this.audioContext;
    if (!context) return;
    await Promise.race([context.resume().catch(() => undefined), new Promise((resolve) => window.setTimeout(resolve, 1000))]);
    if (context.state === 'running') {
      this.reportMicProblem(null);
      return;
    }
    this.reportMicProblem('Tap the phone screen once to start the microphone (mobile browsers need a touch to start audio).');
    const resumeOnTouch = () => {
      if (this.audioContext !== context) return;
      void context.resume().then(() => {
        if (context.state === 'running') this.reportMicProblem(null);
      }).catch(() => undefined);
    };
    document.addEventListener('touchend', resumeOnTouch, { once: true });
    document.addEventListener('click', resumeOnTouch, { once: true });
  }

  private reportMicProblem(problem: string | null): void {
    if (problem === this.micProblem) return;
    this.micProblem = problem;
    if (problem) this.toast(problem, 6000);
    this.socket.sendControl('sender-notice', { topic: 'microphone', level: problem ? 'warning' : 'ok', message: problem });
    this.sendState();
  }

  private stopAudio(): void {
    this.lastAudioConfigPacket = undefined;
    this.audioNode?.disconnect();
    this.audioNode = undefined;
    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = undefined;
    void this.audioContext?.close();
    this.audioContext = undefined;
  }

  private setMute(muted: boolean): void {
    this.muted = this.micEnabled && muted;
    const button = $('mute');
    button.classList.toggle('active', this.muted);
    button.setAttribute('aria-pressed', String(this.muted));
    button.textContent = this.muted ? 'Muted' : 'Mute';
    this.sendState();
  }

  private onPacket(raw: ArrayBuffer): void {
    const packet = parsePacket(raw);
    if (!packet || packet.kind !== 'json' || packet.packetType !== PACKET.CONTROL) return;
    const message = packet.data;
    if (message.type === 'ack') {
      this.socket.acknowledge(Number(message.bytes));
    } else if (message.type === 'ping') {
      this.socket.sendControl('pong', { id: message.id });
    } else if (message.type === 'hello' || message.type === 'transport') {
      this.transport = String(message.transport || 'Unknown');
      $('transport').textContent = this.transport.toUpperCase();
    } else if (message.type === 'command') {
      void this.handleRemoteCommand(message);
    }
  }

  private async handleRemoteCommand(message: ControlMessage): Promise<void> {
    const command = String(message.command || '');
    if (command === 'force-keyframe') {
      this.forceNextKeyframe = true;
      return;
    }
    if (command === 'request-state') {
      this.sendState();
      return;
    }
    if (command === 'set-zoom') {
      const value = Number(message.value);
      $<HTMLInputElement>('zoom').value = String(value);
      $('zoom-label').textContent = `${value.toFixed(1)}×`;
      paintRange($<HTMLInputElement>('zoom'));
      this.scheduleZoom(value);
      return;
    }
    if (command === 'focus-at') {
      const x = Number(message.x);
      const y = Number(message.y);
      if (Number.isFinite(x) && Number.isFinite(y)) void this.handleFocusRequest(x, y, 'remote');
      return;
    }
    if (command === 'set-ev') {
      this.setExposureEv(Number(message.value));
      return;
    }
    this.enqueue(async () => {
      switch (command) {
        case 'set-lens': await this.switchCamera(String(message.deviceId)); break;
        case 'set-torch': await this.setTorch(Boolean(message.enabled)); break;
        // Stream settings: one command for any combination (used by the PC settings dialog and profiles)…
        case 'set-encoding':
          await this.applySettings(sanitizeSettings(message.settings as Record<string, unknown> | undefined));
          break;
        // …plus the original single-field commands, kept for compatibility.
        case 'set-orientation': await this.applySettings({ orientation: message.orientation === 'portrait' ? 'portrait' : 'landscape' }); break;
        case 'set-preset': await this.applySettings(sanitizeSettings({ preset: message.preset })); break;
        case 'set-bitrate': await this.applySettings(sanitizeSettings({ bitrate: message.bitrate })); break;
        case 'set-codec': await this.applySettings(sanitizeSettings({ codec: message.codec })); break;
        case 'set-mic': await this.setMicrophone(Boolean(message.enabled)); break;
        case 'set-mic-device':
          this.selectedMicrophone = String(message.deviceId || '');
          if (this.micEnabled) await this.restartMicrophone();
          this.sendState();
          break;
        case 'set-mute': this.setMute(Boolean(message.muted)); break;
        case 'set-focus': await this.applyTrackConstraint('focusMode', String(message.mode)); break;
        case 'set-exposure': await this.applyTrackConstraint('exposureMode', String(message.mode)); break;
      }
      this.syncUi();
    });
  }

  private syncUi(): void {
    $('turn').setAttribute('aria-pressed', String(this.turned));
    $('turn').classList.toggle('active', this.turned);
    $('orientation').textContent = aspectLabel(this.currentSettings());
    $<HTMLSelectElement>('preset').value = this.preset;
    const photoNote = $('photo-mode-note');
    photoNote.hidden = !PRESETS[this.preset].photoMode;
    photoNote.textContent = `${PHOTO_MODE_WARNING} 12 MP may be cropped to what this phone can encode.`;
    this.renderHoldHint();
    $<HTMLSelectElement>('codec').value = this.codec;
    $<HTMLSelectElement>('bitrate').value = String(this.bitrate);
    $<HTMLSelectElement>('rate-control').value = this.requestedBitrateMode;
    $<HTMLSelectElement>('latency-mode').value = this.latencyMode;
    const settings = this.currentSettings();
    const summary = describeSettings(settings);
    $('settings-summary').textContent = summary.title;
    $('encoder-active').textContent = this.encoderStatusText();
    const activeProfile = matchingProfile(settings);
    $('profile-max-quality').classList.toggle('active', activeProfile === 'max-quality');
    $('profile-low-latency').classList.toggle('active', activeProfile === 'low-latency');
    const micButton = $('mic');
    micButton.classList.toggle('active', this.micEnabled);
    micButton.setAttribute('aria-pressed', String(this.micEnabled));
    micButton.textContent = this.micEnabled ? 'Mic on' : 'Mic off';
    const muteButton = $<HTMLButtonElement>('mute');
    const mutedActive = this.micEnabled && this.muted;
    muteButton.classList.toggle('active', mutedActive);
    muteButton.setAttribute('aria-pressed', String(mutedActive));
    muteButton.textContent = mutedActive ? 'Muted' : 'Mute';
    muteButton.disabled = !this.micEnabled;
    this.updateTorchUi();
    $<HTMLSelectElement>('mic-device').disabled = !this.micEnabled;
    $<HTMLSelectElement>('mic-device').value = this.selectedMicrophone;
    $<HTMLSelectElement>('focus-mode').value = this.focusMode;
    $<HTMLSelectElement>('exposure-mode').value = this.exposureMode;
    this.applyExposureVisual(this.exposureEv);
    this.renderLenses();
  }

  /** What the encoder is really doing, which can differ from the request after automatic fallbacks. */
  private encoderStatusText(): string {
    if (!this.activeCodec) return 'Encoder idle';
    const source = { track: 'track reader', worker: 'worker reader', video: 'video element', '': '—' }[this.captureSource];
    const fallbacks: string[] = [];
    if (this.bitrateMode !== this.requestedBitrateMode) fallbacks.push(`${this.requestedBitrateMode === 'variable' ? 'VBR' : 'CBR'} unsupported`);
    if (this.activeLatencyMode !== this.latencyMode) fallbacks.push(`${this.latencyMode} mode unsupported`);
    return `Active: ${this.activeCodec} · ${this.bitrateMode === 'variable' ? 'VBR' : 'CBR'} · ${this.activeLatencyMode} · frames via ${source}`
      + (fallbacks.length ? ` (${fallbacks.join(', ')})` : '');
  }

  private sendState(): void {
    if (document.getElementById('encoder-active')) $('encoder-active').textContent = this.encoderStatusText();
    if (!this.socket.isOpen) return;
    this.socket.send(encodeControl({
      type: 'sender-state',
      settings: {
        orientation: this.orientation,
        turned: this.turned,
        hold: this.hold,
        preset: this.preset,
        codec: this.codec,
        bitrate: this.bitrate,
        bitrateMode: this.bitrateMode,
        requestedBitrateMode: this.requestedBitrateMode,
        latencyMode: this.latencyMode,
        activeLatencyMode: this.activeLatencyMode,
        activeCodec: this.activeCodec,
        captureSource: this.captureSource,
        encoderStatus: this.encoderStatusText(),
        micEnabled: this.micEnabled,
        micProblem: this.micProblem,
        micState: this.audioContext?.state ?? 'off',
        muted: this.muted,
        torch: this.torch,
        selectedLens: this.selectedLens,
        selectedMicrophone: this.selectedMicrophone,
        focusMode: this.focusMode,
        exposureMode: this.exposureMode,
        exposureEv: this.exposureEv,
        softwareEv: this.softwareEv(),
      },
      lenses: this.visibleLensEntries(),
      microphones: this.microphones.map((device) => ({ deviceId: device.deviceId, label: device.label })),
      capabilities: this.track?.getCapabilities?.() || {},
      trackSettings: this.track?.getSettings() || {},
    }));
  }

  private reportTelemetry(): void {
    const fps = this.sentFrames;
    const mbps = (this.sentBytes * 8) / 1_000_000;
    // What the encoder actually produced this second: Safari can cap it far below `bitrate`.
    this.encodedBitrate = this.sentBytes * 8;
    // Report the size as displayed (after rotation), e.g. 1080×1920 when held in portrait.
    const pixelWidth = this.encoderWidth || this.preview.videoWidth || this.track?.getSettings().width || 0;
    const pixelHeight = this.encoderHeight || this.preview.videoHeight || this.track?.getSettings().height || 0;
    const quarterTurn = this.encoderOrientation?.rotation === 90 || this.encoderOrientation?.rotation === 270;
    const width = quarterTurn ? pixelHeight : pixelWidth;
    const height = quarterTurn ? pixelWidth : pixelHeight;
    const queue = this.encoder?.encodeQueueSize || 0;
    const db = this.audioPeak > 0 ? 20 * Math.log10(this.audioPeak) : -Infinity;
    this.displayedFps = fps;
    this.sentFrames = 0;
    this.sentBytes = 0;
    $('bitrate-live').textContent = `${mbps.toFixed(1)} Mbps`;
    $('resolution-live').textContent = width ? `${width}×${height}` : '—';
    $('fps-live').textContent = `${fps} FPS`;
    $('queue-live').textContent = `Q${queue}`;
    $('transport').textContent = this.socket.isOpen ? this.transport.toUpperCase() : 'OFFLINE';
    $<HTMLElement>('audio-level').style.setProperty('--level', String(Math.min(1, this.audioPeak)));
    $('audio-db').textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB` : '−∞ dB';
    this.audioPeak *= 0.6;

    // Backlog in milliseconds of the video actually being produced, not of what was requested:
    // with a capped encoder the two differ by up to 4x, and the warning threshold is in time.
    const bufferedMs = (this.peakBufferedBytes * 8 * 1000) / Math.max(1_000_000, this.controlBitrate());
    this.peakBufferedBytes = Math.max(this.socket.bufferedAmount, this.socket.unackedBytes);
    // What the PC actually received this second: the real capacity of the link right now.
    const acked = this.socket.ackedBytes;
    const linkMbps = acked >= this.lastAckedBytes ? ((acked - this.lastAckedBytes) * 8) / 1_000_000 : 0;
    this.lastAckedBytes = acked;
    const networkDrops = this.networkDrops - this.lastNetworkDrops;
    const encoderDrops = this.encoderDrops - this.lastEncoderDrops;
    this.lastNetworkDrops = this.networkDrops;
    this.lastEncoderDrops = this.encoderDrops;
    const streaming = this.started && this.socket.isOpen && this.encoder?.state === 'configured';
    this.healthBanner?.show(this.health.update(streaming ? {
      settings: this.currentSettings(),
      transport: this.transport,
      bufferedMs,
      networkDrops,
      encoderDrops,
      encoderQueue: queue,
      senderFps: fps,
      relayMbps: linkMbps,
    } : null));

    this.socket.sendControl('sender-telemetry', {
      fps: this.displayedFps,
      encodedMbps: mbps,
      encoderQueue: queue,
      droppedFrames: this.droppedFrames,
      networkDrops: this.networkDrops,
      encoderDrops: this.encoderDrops,
      bufferedMs,
      linkMbps,
      width,
      height,
      audioDb: Number.isFinite(db) ? db : null,
      audioPackets: this.audioPacketsSent,
      micState: this.audioContext?.state ?? 'off',
      orientation: this.orientationDiagnostics(),
      exposureEv: this.exposureEv,
      softwareEv: this.softwareEv(),
    });
    this.sampleFrameMeta = true;
  }

  private async keepScreenAwake(): Promise<void> {
    try {
      if (this.wakeLock?.released !== false) this.wakeLock = await navigator.wakeLock?.request('screen');
      this.wakeLock?.addEventListener('release', () => { this.wakeLock = undefined; }, { once: true });
    } catch {
      console.info('Wake Lock unavailable; silent media keep-alive is active');
    }
  }

  private async playSilentKeepAlive(): Promise<void> {
    if (!this.silentAudio.src) {
      const sampleCount = 8000;
      const wav = new Uint8Array(44 + sampleCount * 2);
      const view = new DataView(wav.buffer);
      const text = (offset: number, value: string) => [...value].forEach((char, i) => { wav[offset + i] = char.charCodeAt(0); });
      text(0, 'RIFF'); view.setUint32(4, wav.length - 8, true); text(8, 'WAVEfmt ');
      view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      text(36, 'data'); view.setUint32(40, sampleCount * 2, true);
      this.silentAudio.src = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
      this.silentAudio.loop = true;
      this.silentAudio.volume = 0.01;
    }
    await this.silentAudio.play().catch(() => undefined);
  }

  private blackoutHintTimer?: number;

  private flashBlackoutHint(durationMs = 2200): void {
    const overlay = $('blackout-overlay');
    overlay.classList.add('show-hint');
    window.clearTimeout(this.blackoutHintTimer);
    this.blackoutHintTimer = window.setTimeout(() => overlay.classList.remove('show-hint'), durationMs);
  }

  private enableBlackout(): void {
    window.getSelection()?.removeAllRanges();
    document.documentElement.classList.add('blackout-active');
    $('blackout-overlay').classList.add('active');
    this.flashBlackoutHint(2400);
    void this.keepScreenAwake();
    void this.playSilentKeepAlive();
  }

  private bindBlackoutExit(): void {
    const overlay = $('blackout-overlay');
    let startAt = 0;
    let animation = 0;
    const cancel = (remind = false) => {
      const held = startAt > 0;
      startAt = 0;
      cancelAnimationFrame(animation);
      overlay.classList.remove('holding');
      overlay.style.setProperty('--hold', '0%');
      if (remind && held && overlay.classList.contains('active')) this.flashBlackoutHint(1800);
    };
    const exit = () => {
      cancel(false);
      window.clearTimeout(this.blackoutHintTimer);
      overlay.classList.remove('active', 'show-hint');
      document.documentElement.classList.remove('blackout-active');
      window.getSelection()?.removeAllRanges();
    };
    overlay.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      overlay.setPointerCapture(event.pointerId);
      startAt = performance.now();
      overlay.classList.add('holding');
      const update = () => {
        if (!startAt) return;
        const progress = Math.min(100, ((performance.now() - startAt) / 2000) * 100);
        overlay.style.setProperty('--hold', `${progress}%`);
        if (progress >= 100) exit();
        else animation = requestAnimationFrame(update);
      };
      animation = requestAnimationFrame(update);
    });
    // A hardware keyboard (iPad, or a desktop browser) exits with Escape instead of the hold.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && overlay.classList.contains('active')) exit();
    });
    overlay.addEventListener('pointerup', () => cancel(true));
    overlay.addEventListener('pointercancel', () => cancel(false));
    overlay.addEventListener('contextmenu', (event) => event.preventDefault());
    // iOS starts text selection / the loupe from touch events, which pointer preventDefault doesn't stop.
    const blockTouch = (event: TouchEvent) => { if (event.cancelable) event.preventDefault(); };
    overlay.addEventListener('touchstart', blockTouch, { passive: false });
    overlay.addEventListener('touchmove', blockTouch, { passive: false });
    overlay.addEventListener('touchend', blockTouch, { passive: false });
    document.addEventListener('selectstart', (event) => {
      if (document.documentElement.classList.contains('blackout-active')) event.preventDefault();
    });
  }

  private async onVisibilityChange(): Promise<void> {
    if (document.visibilityState !== 'visible' || !this.started) return;
    await this.keepScreenAwake();
    await this.playSilentKeepAlive();
    if (this.audioContext && this.micEnabled) await this.ensureAudioRunning();
    if (!this.track || this.track.readyState === 'ended' || this.track.muted) this.enqueue(() => this.restartCamera());
    else this.forceNextKeyframe = true;
  }

  private toast(message: string, durationMs = 2500): void {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.add('visible');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => toast.classList.remove('visible'), durationMs);
  }
}

watchRanges();
new CameraSender();
