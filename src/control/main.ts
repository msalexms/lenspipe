import QRCode from 'qrcode';
import { StreamReceiver } from '../receiver';
import { pairingToken, rememberPairingToken, withPairingToken } from '../pairing';
import type { ControlMessage } from '../protocol';
import { HealthBanner, HealthMonitor } from '../health';
import {
  DEFAULT_SETTINGS,
  PHOTO_MODE_WARNING,
  PRESETS,
  presetSize,
  PROFILES,
  aspectLabel,
  codecName,
  describeSettings,
  formatTrackMode,
  matchingProfile,
  type ProfileName,
  type StreamSettings,
} from '../stream-settings';
import { paintRanges, stepsBar, watchRanges } from '../amstech-ui';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
type NetworkEndpoint = { name: string; address: string; transport?: 'USB' | 'Wi-Fi'; url: string; networkCategory?: string; firewallFix?: string; linkDown?: boolean };
type NetworkSnapshot = { usb: NetworkEndpoint[]; wifi: NetworkEndpoint[]; updatedAt: number };
type SenderSettings = {
  orientation: 'landscape' | 'portrait';
  turned?: boolean;
  /** How the iPhone is held relative to the aspect: 'across' / 'upside-down' get a warning here. */
  hold?: 'ok' | 'across' | 'upside-down';
  preset: string;
  codec: string;
  bitrate: number;
  /** Rate control the encoder actually accepted. */
  bitrateMode: string;
  requestedBitrateMode?: StreamSettings['bitrateMode'];
  latencyMode?: StreamSettings['latencyMode'];
  encoderStatus?: string;
  micEnabled: boolean;
  muted: boolean;
  torch: boolean;
  selectedLens: string;
  selectedMicrophone?: string;
  focusMode?: string;
  exposureMode?: string;
  exposureEv?: number;
};
type Lens = { deviceId: string; label: string; detail: string };
type Microphone = { deviceId: string; label: string };
type ReceiverTelemetry = {
  id: number;
  label: string;
  videoEnabled?: boolean;
  queuedMs: number;
  fps: number;
  decoderQueue: number;
  pipelineMs: number;
  pipelineMaxMs: number;
  relayDroppedFrames: number;
};

const receiver = new StreamReceiver($<HTMLCanvasElement>('preview'), '/ws/control');
const PC_HEALTH_WARMUP_MS = 2500;
let phoneOnline = false;
let audioEnabled = false;
let latestObs: ReceiverTelemetry | null = null;
let streamStartedAt = 0;
let localVideoResumedAt = 0;
let obsConnectedAt = 0;
let latestLensesKey = '';
let latestMicsKey = '';
let lastEncoderQueue = 0;
let lastDecoderQueue = 0;
let draggingBitrate = false;
let draggingZoom = false;
let draggingEv = false;
let bitrateTimer = 0;
let toastTimer = 0;
let latestNetwork: NetworkSnapshot = { usb: [], wifi: [], updatedAt: 0 };
let renderedNetworkSignature = '';
let networkRenderGeneration = 0;
// Lag detection: latest values from each 1 Hz source, combined on every server telemetry tick.
let latestSettings: StreamSettings | null = null;
/** Command that fixes the current hold warning (switch aspect or rotate 180°). */
let holdFix: Record<string, unknown> | null = null;
let latestSender: ControlMessage | null = null;
let latestSenderAt = 0;
let latestLocal = { fps: 0, decoderQueue: 0, droppedFrames: 0, pipelineMs: 0 };
let lastPipelineMs = 0;
const previousCounts = { networkDrops: 0, encoderDrops: 0, receiverDrops: 0, relayDrops: 0 };
const health = new HealthMonitor();
const healthBanner = new HealthBanner((changes) => {
  setEncoding(changes);
  toast('Sent to the phone');
});

function delta(key: keyof typeof previousCounts, total: number): number {
  const value = Math.max(0, total - previousCounts[key]);
  previousCounts[key] = total;
  return value;
}

function summarizeObs(receivers: ReceiverTelemetry[]): {
  count: number;
  summary: ReceiverTelemetry;
  latencyMs: number;
} | null {
  const obs = receivers.filter((entry) => entry.label === 'obs');
  if (!obs.length) return null;
  const active = obs.filter((entry) => entry.videoEnabled !== false);
  const fps = active.length ? Math.min(...active.map((entry) => Number(entry.fps) || 0)) : 0;
  const pipelineMs = active.length ? Math.max(...active.map((entry) => Number(entry.pipelineMs) || 0)) : 0;
  const pipelineMaxMs = active.length ? Math.max(...active.map((entry) => Number(entry.pipelineMaxMs) || 0)) : 0;
  const queuedMs = active.length ? Math.max(...active.map((entry) => Number(entry.queuedMs) || 0)) : 0;
  const decoderQueue = active.length ? Math.max(...active.map((entry) => Number(entry.decoderQueue) || 0)) : 0;
  const relayDroppedFrames = Math.max(0, ...obs.map((entry) => Number(entry.relayDroppedFrames) || 0));
  return {
    count: obs.length,
    latencyMs: pipelineMs + queuedMs,
    summary: {
      id: obs[0].id,
      label: 'obs',
      videoEnabled: active.length > 0,
      queuedMs,
      fps,
      decoderQueue,
      pipelineMs,
      pipelineMaxMs,
      relayDroppedFrames,
    },
  };
}

function renderObsStatus(receivers: ReceiverTelemetry[]): ReceiverTelemetry | null {
  const pill = $('obs-status-pill');
  const text = $('obs-status-text');
  const dot = pill.querySelector('.dot');
  const result = summarizeObs(receivers);
  if (!result) {
    latestObs = null;
    obsConnectedAt = 0;
    pill.hidden = true;
    pill.dataset.level = 'ok';
    updateQueueMetric();
    return null;
  }
  const now = performance.now();
  if (obsConnectedAt === 0) obsConnectedAt = now;
  const { count, summary, latencyMs } = result;
  latestObs = summary;
  const prefix = count > 1 ? `OBS ×${count}` : 'OBS';
  const targetFps = latestSettings ? PRESETS[latestSettings.preset].frameRate : 0;
  const senderFps = Number(latestSender?.fps) || 0;
  const expectedFps = senderFps > 0 ? Math.min(targetFps || senderFps, senderFps) : targetFps;
  const obsWarmingUp = now - Math.max(streamStartedAt, obsConnectedAt) < PC_HEALTH_WARMUP_MS;
  const warn = phoneOnline && (
    latencyMs > 35
    || summary.decoderQueue >= 3
    || (!obsWarmingUp && expectedFps >= 10 && summary.fps < expectedFps * 0.8)
  );
  pill.hidden = false;
  pill.dataset.level = warn ? 'warn' : 'ok';
  if (dot) dot.className = warn ? 'dot live' : 'dot ok';
  text.textContent = phoneOnline ? `${prefix} · ${summary.fps} FPS · ${latencyMs} ms` : `${prefix} connected`;
  pill.title = `${prefix} · ${summary.fps} FPS · decode+draw ${summary.pipelineMs} ms (max ${summary.pipelineMaxMs} ms) · relay queue ${summary.queuedMs} ms · decoder queue ${summary.decoderQueue} · relay drops ${summary.relayDroppedFrames}`;
  updateQueueMetric();
  return summary;
}

function updateHealth(server: ControlMessage): void {
  const receivers = (server.receivers as ReceiverTelemetry[] | undefined) ?? [];
  const obsSummary = renderObsStatus(receivers);
  const sender = latestSender;
  const online = Boolean(server.online) && phoneOnline && latestSettings && sender;
  const networkDrops = delta('networkDrops', Number(sender?.networkDrops) || 0);
  const encoderDrops = delta('encoderDrops', Number(sender?.encoderDrops) || 0);
  const receiverDrops = delta('receiverDrops', latestLocal.droppedFrames);
  const previewActive = receiver.videoEnabled;
  const relayTotal = previewActive
    ? (Number(server.relayDroppedFrames) || 0)
    : (obsSummary?.relayDroppedFrames ?? (Number(server.relayDroppedFrames) || 0));
  const relayDrops = delta('relayDrops', relayTotal);
  // The iPhone reports every second over the same connection as the video. If its reports stop while it
  // is still connected, everything is stuck behind a backlog: count that silence as queued time, so a
  // stalled link is never blamed on this PC using stale numbers.
  const now = performance.now();
  const silenceMs = now - latestSenderAt;
  const stalled = silenceMs > 2500;
  if (stalled && server.online) {
    $('metric-fps-value').textContent = '—';
    $('metric-queue').textContent = `no phone data for ${(silenceMs / 1000).toFixed(1)} s`;
  }
  const activeQueuedMs = Math.max(
    0,
    ...receivers.filter((entry) => entry.videoEnabled !== false).map((entry) => entry.queuedMs),
  );
  const localWarmingUp = now - Math.max(streamStartedAt, localVideoResumedAt) < PC_HEALTH_WARMUP_MS;
  const obsWarmingUp = obsConnectedAt === 0 || now - Math.max(streamStartedAt, obsConnectedAt) < PC_HEALTH_WARMUP_MS;
  const obsActive = Boolean(obsSummary && obsSummary.videoEnabled !== false);
  const pcMetrics = previewActive && !localWarmingUp
    ? {
        receiverFps: latestLocal.fps,
        decoderQueue: latestLocal.decoderQueue,
        receiverDrops,
        relayDrops,
        receiverLatencyMs: latestLocal.pipelineMs + activeQueuedMs,
      }
    : obsActive && !obsWarmingUp
      ? {
          receiverFps: obsSummary!.fps,
          decoderQueue: obsSummary!.decoderQueue,
          receiverDrops: 0,
          relayDrops,
          receiverLatencyMs: obsSummary!.pipelineMs + obsSummary!.queuedMs,
        }
      : {
          receiverFps: undefined,
          decoderQueue: 0,
          receiverDrops: 0,
          relayDrops: 0,
          receiverLatencyMs: 0,
        };
  healthBanner.show(health.update(online ? {
    settings: latestSettings!,
    transport: String(server.transport || 'Unknown'),
    bufferedMs: Math.max(Number(sender!.bufferedMs) || 0, stalled ? silenceMs : 0),
    networkDrops,
    encoderDrops,
    encoderQueue: Number(sender!.encoderQueue) || 0,
    senderFps: stalled ? 0 : Number(sender!.fps) || 0,
    rttMs: server.rttMs == null ? null : Number(server.rttMs),
    relayMbps: Number(server.throughputMbps) || 0,
    ...pcMetrics,
  } : null));
}

function toast(message: string, durationMs = 1800): void {
  const element = $('studio-toast');
  element.textContent = message;
  element.classList.add('visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove('visible'), durationMs);
}

async function copyText(text: string, label = 'URL'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label} copied`);
  } catch {
    toast(text);
  }
}

function setOnline(online: boolean): void {
  if (!online) renderHoldBanner('ok', 'landscape', false);
  phoneOnline = online;
  if (online) {
    streamStartedAt = performance.now();
    localVideoResumedAt = streamStartedAt;
  } else {
    streamStartedAt = 0;
    localVideoResumedAt = 0;
  }
  $('waiting').classList.toggle('hidden', online);
  const statusChip = $('connection-status');
  const statusText = online ? 'Phone connected' : 'Waiting for phone…';
  statusChip.classList.toggle('online', online);
  statusChip.title = statusText;
  const dot = document.createElement('i');
  dot.setAttribute('aria-hidden', 'true');
  statusChip.replaceChildren(dot, Object.assign(document.createElement('span'), { textContent: statusText }));
  $('remote-dot').classList.toggle('online', online);
  const onlineControls = [
    'remote-lens', 'remote-mic', 'remote-focus', 'remote-exposure', 'remote-ev',
    'landscape', 'portrait', 'force-keyframe',
    'remote-preset', 'remote-codec', 'remote-bitrate', 'remote-rate-control', 'remote-latency',
  ];
  for (const id of onlineControls) {
    $<HTMLSelectElement | HTMLButtonElement | HTMLInputElement>(id).disabled = !online;
  }
  syncLensButtons();
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-profile]')) {
    button.disabled = !online;
    if (!online) button.classList.remove('active');
  }
  if (!online) {
    for (const id of ['remote-torch', 'remote-mute', 'remote-mic-device', 'remote-zoom']) {
      $<HTMLSelectElement | HTMLButtonElement | HTMLInputElement>(id).disabled = true;
    }
    updateToggle('remote-torch', false);
    updateToggle('remote-mic', false);
    updateToggle('remote-mute', false);
    senderMicEnabled = false;
    senderMuted = false;
    micProblem = null;
    lastEncoderQueue = 0;
    lastPipelineMs = 0;
    $('preview-resolution').textContent = '— × —';
    $('metric-fps-value').textContent = '0';
    $('metric-bitrate-value').textContent = '0.0';
    $('metric-rtt').textContent = '— ms';
    $('metric-queue').textContent = 'decoder queue 0';
    $('encoder-mode').textContent = 'Encoder idle';
    $('encoder-mode').title = 'Encoder idle';
    $('settings-encoder-status').textContent = 'Connect a phone to apply settings.';
    $<HTMLElement>('remote-audio-level').style.setProperty('--level', '0');
    $('remote-audio-db').textContent = '−∞ dB';
    renderAudioStatus();
  }
  renderPreviewPauseState();
}

function renderPreviewPauseState(): void {
  const toggle = $<HTMLButtonElement>('preview-toggle');
  const pausedByUser = receiver.videoManualPaused;
  toggle.textContent = pausedByUser ? 'Resume preview' : 'Pause preview';
  toggle.setAttribute('aria-pressed', String(pausedByUser));
  toggle.classList.toggle('yellow-button', pausedByUser);
  toggle.classList.toggle('ico-eye', pausedByUser);
  toggle.classList.toggle('ico-eye-off', !pausedByUser);
  $('preview-paused').hidden = !(phoneOnline && !receiver.videoEnabled);
  updateQueueMetric();
}

function updateQueueMetric(): void {
  const element = $('metric-queue');
  if (!receiver.videoEnabled) {
    if (latestObs && latestObs.videoEnabled !== false && phoneOnline) {
      const obsMs = latestObs.pipelineMs + latestObs.queuedMs;
      element.textContent = `OBS ${obsMs} ms · preview paused`;
      element.title = `Local studio preview paused · OBS decode+draw ${latestObs.pipelineMs} ms · relay queue ${latestObs.queuedMs} ms`;
    } else {
      element.textContent = 'preview paused';
      element.title = 'Local studio preview video decoding is paused; remote controls and OBS remain active';
    }
    return;
  }
  element.textContent = `Q ${lastEncoderQueue}/${lastDecoderQueue} · PC ${lastPipelineMs} ms`;
  element.title = `Encoder queue ${lastEncoderQueue} · decoder queue ${lastDecoderQueue} · PC decode/draw ${lastPipelineMs} ms`;
}

// The receiver owns connection/reconnection and server ping responses.
receiver.addEventListener('stream-state', (event) => {
  const message = (event as CustomEvent<ControlMessage>).detail;
  // A (re)connected iPhone starts fresh: never judge it by the previous session's last report.
  latestSender = null;
  latestSenderAt = performance.now();
  setOnline(Boolean(message.online));
  updateTransport(String(message.transport || 'Unknown'), onlineText(message.online));
});
receiver.addEventListener('sender-state', (event) => {
  applySenderState((event as CustomEvent<ControlMessage>).detail);
});
receiver.addEventListener('telemetry', (event) => {
  const data = (event as CustomEvent<ControlMessage>).detail;
  $('metric-rtt').textContent = data.rttMs == null ? '— ms' : `${Number(data.rttMs).toFixed(1)} ms`;
  $('metric-bitrate-value').textContent = Number(data.throughputMbps || 0).toFixed(1);
  $('metric-dropped').textContent = String(Number(data.droppedFrames) || 0);
  updateTransport(String(data.transport || 'Unknown'), onlineText(data.online));
  updateHealth(data);
});
receiver.addEventListener('sender-telemetry', (event) => {
  const data = (event as CustomEvent<ControlMessage>).detail;
  latestSender = data;
  latestSenderAt = performance.now();
  $('metric-fps-value').textContent = String(Number(data.fps) || 0);
  lastEncoderQueue = Number(data.encoderQueue) || 0;
  updateQueueMetric();
  if (data.width && data.height) $('preview-resolution').textContent = `${data.width} × ${data.height}`;
  const db = typeof data.audioDb === 'number' && Number.isFinite(data.audioDb) ? data.audioDb : null;
  const levelPct = db === null ? 0 : Math.max(0, Math.min(100, Math.pow(10, db / 20) * 100));
  $<HTMLElement>('remote-audio-level').style.setProperty('--level', String(levelPct / 100));
  $('remote-audio-db').textContent = db === null ? '−∞ dB' : `${db.toFixed(1)} dB`;
});
receiver.addEventListener('local-telemetry', (event) => {
  const data = (event as CustomEvent<{ fps: number; decodedFrames: number; droppedFrames: number; decoderQueue: number; pipelineMs: number }>).detail;
  latestLocal = { fps: data.fps, decoderQueue: data.decoderQueue, droppedFrames: data.droppedFrames, pipelineMs: data.pipelineMs };
  lastAudio = (data as unknown as { audio?: AudioStats }).audio ?? null;
  renderAudioStatus();
  lastPipelineMs = data.pipelineMs;
  $('metric-decoded').textContent = data.decodedFrames.toLocaleString();
  lastDecoderQueue = Number(data.decoderQueue) || 0;
  updateQueueMetric();
  if (!phoneOnline) $('metric-dropped').textContent = String(data.droppedFrames);
});
// Click-to-focus: the canvas is sized to the frame's aspect ratio, so its rect maps 1:1 to the frame.
const previewCanvas = $<HTMLCanvasElement>('preview');
let lastFocusAt = 0;
previewCanvas.addEventListener('click', (event) => {
  if (!phoneOnline || !receiver.videoEnabled) return;
  const rect = previewCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) / rect.width;
  const y = (event.clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return;
  lastFocusAt = performance.now();
  receiver.command('focus-at', { x, y });
});
receiver.addEventListener('sender-focus', (event) => {
  const data = (event as CustomEvent<ControlMessage>).detail;
  const result = String(data.result);
  const rect = previewCanvas.getBoundingClientRect();
  const frame = previewCanvas.parentElement!.getBoundingClientRect();
  const [x, y] = result === 'point' ? [Number(data.x), Number(data.y)] : [0.5, 0.5];
  const ring = $('focus-ring');
  ring.style.left = `${rect.left - frame.left + x * rect.width}px`;
  ring.style.top = `${rect.top - frame.top + y * rect.height}px`;
  ring.dataset.result = result;
  ring.classList.remove('visible');
  void ring.offsetWidth;
  ring.classList.add('visible');
  // Only explain results for clicks made here (the iPhone shows its own messages for its own taps).
  if (performance.now() - lastFocusAt > 3000) return;
  if (result === 'locked') toast('Focus is locked: set Focus to Continuous in Settings');
  else if (result === 'unsupported') toast('This browser does not expose focus control on this lens');
  else if (result === 'refocus') toast('Refocusing (this browser only allows a full-frame autofocus pass)');
});
// Microphone problems reported by the iPhone (permission denied, needs a tap, busy) are shown here too,
// otherwise turning the mic on from the studio would just silently stay off.
let micProblem: string | null = null;
let senderMicEnabled = false;
let senderMuted = false;
receiver.addEventListener('sender-notice', (event) => {
  const data = (event as CustomEvent<ControlMessage>).detail;
  if (data.topic !== 'microphone') return;
  micProblem = typeof data.message === 'string' ? data.message : null;
  if (micProblem) toast(micProblem, 7000);
  renderAudioStatus();
});

type AudioStats = { state: string; chunksPerSecond: number; bufferedMs: number; underruns: number; playing: boolean };
let lastAudio: AudioStats | null = null;
let lastUnderruns = 0;

function renderAudioStatus(): void {
  const element = $('audio-status');
  let text: string;
  let level: 'idle' | 'ok' | 'warn';
  if (micProblem) {
    [text, level] = [micProblem.startsWith('Tap') ? 'Tap the phone screen to start its mic' : 'Phone mic blocked: see message on the phone', 'warn'];
  } else if (!senderMicEnabled) {
    [text, level] = ['', 'idle'];
  } else if (senderMuted) {
    [text, level] = ['Phone mic muted', 'idle'];
  } else if (!lastAudio || lastAudio.chunksPerSecond === 0) {
    [text, level] = ['Mic on, but no audio is arriving', 'warn'];
  } else if (audioEnabled && lastAudio.state === 'suspended') {
    [text, level] = ['Audio arriving · click "Preview audio" again to unblock sound', 'warn'];
  } else {
    const glitches = Math.max(0, lastAudio.underruns - lastUnderruns);
    [text, level] = [`Audio arriving · ${Math.round(lastAudio.bufferedMs)} ms buffer${glitches ? ` · ${glitches} dropouts` : ''}${audioEnabled ? '' : ' · preview off'}`, 'ok'];
  }
  if (lastAudio) lastUnderruns = lastAudio.underruns;
  element.textContent = text;
  element.dataset.level = level;
  // "Phone mic off" needs no label: the Preview audio button already shows it.
  element.hidden = text.length === 0;
}

receiver.addEventListener('decoder-error', () => toast('Codec unsupported by this browser; try H.264 High'));
receiver.addEventListener('network', (event) => {
  const data = (event as CustomEvent<ControlMessage>).detail;
  if (data.network) void renderNetwork(data.network as NetworkSnapshot);
});
receiver.addEventListener('status', (event) => {
  if ((event as CustomEvent<string>).detail === 'offline') setOnline(false);
});
receiver.addEventListener('pairing-required', () => {
  // Only reachable from another device: the PC itself never needs the key.
  const overlay = $('waiting');
  overlay.querySelector('strong')!.textContent = 'This device is not paired';
  overlay.querySelector('span:not(.kicker)')!.textContent = 'Open the studio URL with its pairing key (copy it from the PC studio), or use the PC itself.';
  $('waiting-connect').hidden = true;
});
// Learn the pairing key up front so the OBS URL and QR codes carry it.
void refreshNetwork();

function onlineText(value: unknown): string {
  return value ? 'LIVE' : 'NO SIGNAL';
}

function updateTransport(transport: string, status = 'LIVE'): void {
  const display = transport === 'Unknown' ? status : transport.toUpperCase();
  $('transport-badge').textContent = display;
  $('metric-transport').textContent = transport === 'Unknown' ? '—' : transport.toUpperCase();
}

function applySenderState(message: ControlMessage): void {
  const settings = message.settings as SenderSettings | undefined;
  if (!settings) return;
  const lenses = (message.lenses || []) as Lens[];
  const lensKey = lenses.map((lens) => `${lens.deviceId}:${lens.label}`).join('|');
  const lensSelect = $<HTMLSelectElement>('remote-lens');
  if (lensKey !== latestLensesKey) {
    latestLensesKey = lensKey;
    lensSelect.replaceChildren(...lenses.map((lens) => {
      const option = new Option(lens.label, lens.deviceId);
      option.title = lens.detail;
      return option;
    }));
  }
  lensSelect.value = settings.selectedLens;
  lensSelect.disabled = !phoneOnline || lenses.length === 0;
  syncLensButtons();
  const isLandscape = settings.orientation === 'landscape';
  $('landscape').classList.toggle('active', isLandscape);
  $('landscape').setAttribute('aria-pressed', String(isLandscape));
  $('portrait').classList.toggle('active', !isLandscape);
  $('portrait').setAttribute('aria-pressed', String(!isLandscape));
  $<HTMLSelectElement>('remote-preset').value = settings.preset;
  updatePresetLabels(settings.orientation, settings.preset);
  const photoMode = Boolean(PRESETS[settings.preset as keyof typeof PRESETS]?.photoMode);
  const photoNote = $('remote-photo-mode-note');
  photoNote.hidden = !photoMode;
  photoNote.textContent = `${PHOTO_MODE_WARNING} 12 MP may be cropped to what the phone can encode, and needs a GPU that decodes level 6.0.`;
  $('stream-summary-detail').classList.toggle('photo-mode-detail', photoMode);
  renderHoldBanner(phoneOnline ? settings.hold : 'ok', settings.orientation, Boolean(settings.turned), settings.preset);
  $<HTMLSelectElement>('remote-codec').value = settings.codec;
  if (!draggingBitrate) {
    $<HTMLInputElement>('remote-bitrate').value = String(settings.bitrate / 1_000_000);
    $('bitrate-value').textContent = `${settings.bitrate / 1_000_000} Mbps`;
  }
  const requestedMode = settings.requestedBitrateMode || (settings.bitrateMode === 'constant' ? 'constant' : 'variable');
  const latencyMode = settings.latencyMode || 'realtime';
  $<HTMLSelectElement>('remote-rate-control').value = requestedMode;
  $<HTMLSelectElement>('remote-latency').value = latencyMode;
  updateToggle('remote-turned', Boolean(settings.turned));
  $<HTMLButtonElement>('remote-turned').disabled = !phoneOnline;
  latestSettings = {
    orientation: settings.orientation,
    turned: Boolean(settings.turned),
    preset: (settings.preset in PRESETS ? settings.preset : '4k30') as StreamSettings['preset'],
    codec: settings.codec,
    bitrate: settings.bitrate,
    bitrateMode: requestedMode,
    latencyMode,
  };
  const activeProfile = matchingProfile(latestSettings);
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-profile]')) {
    button.classList.toggle('active', button.dataset.profile === activeProfile);
  }
  const summary = describeSettings(latestSettings);
  $('stream-summary').textContent = summary.title;
  $('stream-summary-detail').textContent = summary.detail;
  renderStreamSummary(latestSettings);
  const status = settings.encoderStatus || (settings.bitrateMode === 'constant' ? 'CBR active' : 'VBR active');
  $('encoder-mode').textContent = status;
  $('encoder-mode').title = status;
  $('settings-encoder-status').textContent = status;
  updateToggle('remote-torch', settings.torch);
  updateToggle('remote-mic', settings.micEnabled);
  updateToggle('remote-mute', settings.muted);
  senderMicEnabled = settings.micEnabled;
  senderMuted = settings.muted;
  micProblem = (settings as SenderSettings & { micProblem?: string | null }).micProblem ?? null;
  renderAudioStatus();
  $<HTMLButtonElement>('remote-mute').disabled = !settings.micEnabled;

  const microphones = (message.microphones || []) as Microphone[];
  const micKey = microphones.map((mic) => `${mic.deviceId}:${mic.label}`).join('|');
  const micSelect = $<HTMLSelectElement>('remote-mic-device');
  if (micKey !== latestMicsKey) {
    latestMicsKey = micKey;
    micSelect.replaceChildren(
      new Option('Default microphone', ''),
      ...microphones.map((mic, index) => new Option(mic.label || `Microphone ${index + 1}`, mic.deviceId)),
    );
  }
  micSelect.value = settings.selectedMicrophone || '';
  micSelect.disabled = !phoneOnline || !settings.micEnabled;
  if (!settings.micEnabled) {
    $<HTMLElement>('remote-audio-level').style.setProperty('--level', '0');
    $('remote-audio-db').textContent = '−∞ dB';
  }

  const capabilities = (message.capabilities || {}) as MediaTrackCapabilities;
  $<HTMLButtonElement>('remote-torch').disabled = !capabilities.torch;
  const trackSettings = (message.trackSettings || {}) as MediaTrackSettings & { zoom?: number };
  const zoom = capabilities.zoom;
  const zoomInput = $<HTMLInputElement>('remote-zoom');
  zoomInput.disabled = !zoom;
  if (zoom) {
    zoomInput.min = String(zoom.min);
    zoomInput.max = String(zoom.max);
    zoomInput.step = String(zoom.step || 0.1);
    if (!draggingZoom) {
      zoomInput.value = String(trackSettings.zoom || zoom.min);
      $('zoom-value').textContent = `${Number(zoomInput.value).toFixed(1)}×`;
    }
  }
  updateModeSelect('remote-focus', capabilities.focusMode, settings.focusMode);
  updateModeSelect('remote-exposure', capabilities.exposureMode, settings.exposureMode);
  const evInput = $<HTMLInputElement>('remote-ev');
  evInput.disabled = !phoneOnline;
  if (!draggingEv && typeof settings.exposureEv === 'number') {
    const ev = settings.exposureEv;
    evInput.value = String(ev);
    $('ev-value').textContent = `${ev > 0 ? '+' : ''}${ev.toFixed(1)} EV`;
  }
  paintRanges();
  if ($<HTMLDialogElement>('obs-modal').open) updateObsModal();
}

/** The stream box of the side panel: the current settings as a cajetín (format, codec, bitrate, rate · mode). */
function renderStreamSummary(settings: StreamSettings): void {
  $('sum-format').textContent = `${PRESETS[settings.preset].label} · ${aspectLabel(settings)}`;
  $('sum-codec').textContent = codecName(settings.codec);
  $('sum-bitrate').textContent = `${Math.round(settings.bitrate / 1_000_000)} Mbps`;
  $('sum-mode').textContent = `${settings.bitrateMode === 'variable' ? 'VBR' : 'CBR'} · ${settings.latencyMode === 'quality' ? 'quality' : 'realtime'}`;
}

/**
 * Lens as segmented buttons, like the iPhone. The hidden <select> stays the source of truth: the buttons set its
 * value and fire its change event, so the command code is the same.
 */
let lensButtonsKey: string | null = null;
function syncLensButtons(): void {
  const select = $<HTMLSelectElement>('remote-lens');
  const box = $('remote-lens-buttons');
  const options = latestLensesKey ? [...select.options] : [];
  const key = options.map((option) => `${option.value}:${option.text}`).join('|');
  if (key !== lensButtonsKey) {
    lensButtonsKey = key;
    if (!options.length) {
      box.replaceChildren(Object.assign(document.createElement('span'), { className: 'segments-empty', textContent: 'Waiting for camera…' }));
    } else {
      box.replaceChildren(...options.map((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.value = option.value;
        button.textContent = option.text;
        if (option.title) button.title = option.title;
        button.addEventListener('click', () => {
          if (select.value === option.value) return;
          select.value = option.value;
          select.dispatchEvent(new Event('change'));
          syncLensButtons();
        });
        return button;
      }));
    }
  }
  for (const button of box.querySelectorAll<HTMLButtonElement>('button')) {
    const active = button.dataset.value === select.value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = select.disabled;
  }
}

/** Format names with the size as it will arrive (portrait swaps it). */
function updatePresetLabels(orientation: 'landscape' | 'portrait', current: string): void {
  const select = $<HTMLSelectElement>('remote-preset');
  for (const option of select.options) {
    const preset = PRESETS[option.value as keyof typeof PRESETS];
    if (!preset) continue;
    const { width, height } = presetSize(preset, orientation);
    const name = preset.ratio === '4:3' ? (preset.width >= 4000 ? '12 MP' : `${preset.height}p`) : preset.width >= 3840 ? '4K' : '1080p';
    option.text = `${name} · ${width}×${height} · ${preset.frameRate} fps`;
  }
  // The aspect buttons follow the format's ratio: 16:9 / 9:16 or 4:3 / 3:4.
  const ratio = (PRESETS[current as keyof typeof PRESETS] ?? PRESETS['4k30']).ratio;
  const portrait = ratio.split(':').reverse().join(':');
  $('landscape').replaceChildren(`${ratio} `, Object.assign(document.createElement('small'), { textContent: 'Landscape' }));
  $('portrait').replaceChildren(`${portrait} `, Object.assign(document.createElement('small'), { textContent: 'Portrait' }));
}

/** The iPhone is held across the chosen aspect or upside down: the picture arrives on its side. */
function renderHoldBanner(hold: SenderSettings['hold'], orientation: 'landscape' | 'portrait', turned: boolean, preset = '4k30'): void {
  const banner = $('hold-banner');
  if (!hold || hold === 'ok') {
    banner.hidden = true;
    holdFix = null;
    return;
  }
  const landscape = orientation === 'landscape';
  if (hold === 'upside-down') {
    $('hold-banner-title').textContent = 'The picture is upside down';
    $('hold-banner-detail').textContent = 'Turn the phone round, or rotate the picture.';
    $('hold-banner-action').textContent = 'Rotate 180°';
    holdFix = { command: 'set-encoding', settings: { turned: !turned } };
  } else {
    $('hold-banner-title').textContent = landscape ? 'Turn the phone sideways' : 'Turn the phone upright';
    const ratio = (PRESETS[preset as keyof typeof PRESETS] ?? PRESETS['4k30']).ratio;
    const [here, there] = landscape ? [ratio, ratio.split(':').reverse().join(':')] : [ratio.split(':').reverse().join(':'), ratio];
    $('hold-banner-detail').textContent = `The stream is ${here} but the phone is ${landscape ? 'upright' : 'sideways'}, so the picture arrives on its side. If it is not, turn off Rotation Lock on the phone.`;
    $('hold-banner-action').textContent = `Use ${there}`;
    holdFix = { command: 'set-orientation', orientation: landscape ? 'portrait' : 'landscape' };
  }
  banner.hidden = false;
}
$('hold-banner-action').addEventListener('click', () => {
  if (!holdFix) return;
  const { command, ...payload } = holdFix;
  receiver.command(String(command), payload);
});

function updateToggle(id: string, on: boolean): void {
  const button = $<HTMLButtonElement>(id);
  button.classList.toggle('active', on);
  button.setAttribute('aria-pressed', String(on));
  const status = button.querySelector('span');
  if (status) status.textContent = on ? 'ON' : 'OFF';
}

function updateModeSelect(id: string, modes?: string[], activeMode?: string): void {
  const select = $<HTMLSelectElement>(id);
  select.disabled = !phoneOnline;
  const available = modes?.length ? modes : ['continuous', 'manual'];
  const current = activeMode || select.value;
  if (select.options.length !== available.length || available.some((mode, index) => select.options[index].value !== mode)) {
    select.replaceChildren(...available.map((mode) => new Option(formatTrackMode(mode), mode)));
  }
  if (available.includes(current)) select.value = current;
}

$('remote-lens').addEventListener('change', (event) => receiver.command('set-lens', { deviceId: (event.currentTarget as HTMLSelectElement).value }));
$('remote-torch').addEventListener('click', () => receiver.command('set-torch', { enabled: !$('remote-torch').classList.contains('active') }));
$('remote-mic').addEventListener('click', () => receiver.command('set-mic', { enabled: !$('remote-mic').classList.contains('active') }));
$('remote-mute').addEventListener('click', () => receiver.command('set-mute', { muted: !$('remote-mute').classList.contains('active') }));
$('landscape').addEventListener('click', () => receiver.command('set-orientation', { orientation: 'landscape' }));
$('portrait').addEventListener('click', () => receiver.command('set-orientation', { orientation: 'portrait' }));
$('remote-turned').addEventListener('click', () => receiver.command('set-encoding', { settings: { turned: !$('remote-turned').classList.contains('active') } }));
function setEncoding(settings: Partial<StreamSettings>): void {
  receiver.command('set-encoding', { settings });
}
$('remote-preset').addEventListener('change', (event) => setEncoding({ preset: (event.currentTarget as HTMLSelectElement).value as StreamSettings['preset'] }));
$('remote-codec').addEventListener('change', (event) => setEncoding({ codec: (event.currentTarget as HTMLSelectElement).value }));
$('remote-rate-control').addEventListener('change', (event) => setEncoding({ bitrateMode: (event.currentTarget as HTMLSelectElement).value as StreamSettings['bitrateMode'] }));
$('remote-latency').addEventListener('change', (event) => setEncoding({ latencyMode: (event.currentTarget as HTMLSelectElement).value as StreamSettings['latencyMode'] }));
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-profile]')) {
  button.addEventListener('click', () => {
    if (!phoneOnline) return;
    const profile = PROFILES[button.dataset.profile as ProfileName];
    if (!profile) return;
    setEncoding(profile.settings);
    $<HTMLDialogElement>('settings-modal').close();
    toast(`${profile.label} profile sent to the phone`);
  });
}
function enableBackdropClose(dialog: HTMLDialogElement): void {
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog || event.detail === 0) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right
      && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
}
enableBackdropClose($<HTMLDialogElement>('settings-modal'));
enableBackdropClose($<HTMLDialogElement>('connection-modal'));
enableBackdropClose($<HTMLDialogElement>('about-modal'));
enableBackdropClose($<HTMLDialogElement>('obs-modal'));
const openSettings = () => $<HTMLDialogElement>('settings-modal').showModal();
const openAbout = () => $<HTMLDialogElement>('about-modal').showModal();
$('open-settings').addEventListener('click', openSettings);
$('header-settings').addEventListener('click', openSettings);
$('header-about').addEventListener('click', openAbout);
$('footer-about').addEventListener('click', openAbout);
const bitrateInput = $<HTMLInputElement>('remote-bitrate');
bitrateInput.addEventListener('pointerdown', () => { draggingBitrate = true; });
bitrateInput.addEventListener('input', () => {
  const bitrate = Number(bitrateInput.value);
  $('bitrate-value').textContent = `${bitrate} Mbps`;
  window.clearTimeout(bitrateTimer);
  bitrateTimer = window.setTimeout(() => {
    setEncoding({ bitrate: bitrate * 1_000_000 });
  }, 120);
});
bitrateInput.addEventListener('change', () => {
  draggingBitrate = false;
  window.clearTimeout(bitrateTimer);
  setEncoding({ bitrate: Number(bitrateInput.value) * 1_000_000 });
});

const zoomInput = $<HTMLInputElement>('remote-zoom');
zoomInput.addEventListener('pointerdown', () => { draggingZoom = true; });
zoomInput.addEventListener('input', () => {
  const zoom = Number(zoomInput.value);
  $('zoom-value').textContent = `${zoom.toFixed(1)}×`;
  receiver.command('set-zoom', { value: zoom });
});
zoomInput.addEventListener('change', () => { draggingZoom = false; });

const evInput = $<HTMLInputElement>('remote-ev');
evInput.addEventListener('pointerdown', () => { draggingEv = true; });
evInput.addEventListener('input', () => {
  const ev = Number(evInput.value);
  $('ev-value').textContent = `${ev > 0 ? '+' : ''}${ev.toFixed(1)} EV`;
  receiver.command('set-ev', { value: ev });
});
evInput.addEventListener('change', () => { draggingEv = false; });

window.addEventListener('pointerup', () => {
  draggingBitrate = false;
  draggingZoom = false;
  draggingEv = false;
});
window.addEventListener('pointercancel', () => {
  draggingBitrate = false;
  draggingZoom = false;
  draggingEv = false;
});

$('remote-mic-device').addEventListener('change', (event) => receiver.command('set-mic-device', { deviceId: (event.currentTarget as HTMLSelectElement).value }));
$('remote-focus').addEventListener('change', (event) => receiver.command('set-focus', { mode: (event.currentTarget as HTMLSelectElement).value }));
$('remote-exposure').addEventListener('change', (event) => receiver.command('set-exposure', { mode: (event.currentTarget as HTMLSelectElement).value }));
$('force-keyframe').addEventListener('click', forceKeyframe);
document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
  const target = event.target as HTMLElement | null;
  if (target && (['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)) return;
  if (document.querySelector('dialog[open]')) return;
  if (event.key.toLowerCase() === 'k' && phoneOnline) forceKeyframe();
});
function forceKeyframe(): void {
  if (!phoneOnline) return;
  receiver.command('force-keyframe');
  toast('Keyframe requested');
}
$('preview-toggle').addEventListener('click', () => {
  const nextEnabled = receiver.videoManualPaused;
  receiver.setVideoEnabled(nextEnabled);
  toast(nextEnabled ? 'Preview resumed' : 'Preview paused (OBS stays live)');
});
$('resume-preview').addEventListener('click', () => {
  receiver.setVideoEnabled(true);
  toast('Preview resumed');
});
receiver.addEventListener('video-state', () => {
  latestLocal = { fps: 0, decoderQueue: 0, droppedFrames: latestLocal.droppedFrames, pipelineMs: 0 };
  previousCounts.receiverDrops = latestLocal.droppedFrames;
  if (receiver.videoEnabled) localVideoResumedAt = performance.now();
  renderPreviewPauseState();
});
$('audio-monitor').addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  receiver.setAudioMuted(!audioEnabled);
  receiver.resumeAudio();
  const button = $('audio-monitor');
  button.textContent = `Preview audio: ${audioEnabled ? 'on' : 'off'}`;
  button.setAttribute('aria-pressed', String(audioEnabled));
  renderAudioStatus();
});
receiver.setAudioMuted(true);
type ObsOs = 'win32' | 'darwin' | 'linux';
function detectBrowserOs(): ObsOs {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua)) return 'darwin';
  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) return 'linux';
  return 'win32';
}
let localCertPath = '';
let serverPlatform = '';
let obsOs: ObsOs = detectBrowserOs();
let obsOsManual = false;
let obsManualToggled = false;
let certTrust: { checked: boolean; trusted: boolean | null; supported: boolean; busy: boolean } = {
  checked: false,
  trusted: null,
  supported: false,
  busy: false,
};

function isLocalBrowserHost(): boolean {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1' || location.hostname === '::1';
}

function obsUrl(): string {
  return withPairingToken(`${location.origin}/obs`);
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function obsCertPathFor(os: ObsOs): string {
  if (localCertPath && os === serverPlatform) return localCertPath;
  return os === 'win32' ? '.\\certs\\local-cert.pem' : './certs/local-cert.pem';
}

async function refreshObsCertTrust(): Promise<void> {
  if (!isLocalBrowserHost()) return;
  try {
    const response = await fetch('/api/obs/cert-trust', { cache: 'no-store' });
    if (!response.ok) {
      certTrust = { ...certTrust, checked: true, trusted: null, supported: false };
    } else {
      const data = await response.json() as { trusted: boolean | null; supported: boolean };
      certTrust = {
        ...certTrust,
        checked: true,
        trusted: data.trusted,
        supported: Boolean(data.supported),
      };
    }
  } catch {
    certTrust = { ...certTrust, checked: true, trusted: null, supported: false };
  }
  renderObsCertGuide();
}

function renderObsCertGuide(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-obs-os]')) {
    const active = button.dataset.obsOs === obsOs;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
  const showAuto = isLocalBrowserHost() && (!serverPlatform || obsOs === serverPlatform);
  const isLocalHttp = isLocalBrowserHost() && location.protocol === 'http:';
  $('obs-cert-auto').hidden = !showAuto;
  const card = $('obs-trust-card');
  const title = $('obs-trust-title');
  const statusPill = $('obs-cert-status');
  const statusDot = statusPill.querySelector('.dot');
  const statusText = statusPill.querySelector('span:last-child');
  const trustBtn = $<HTMLButtonElement>('obs-trust-btn');
  const details = $<HTMLDetailsElement>('obs-manual-details');
  const summary = $('obs-manual-summary');

  if (showAuto && isLocalHttp) {
    card.dataset.trusted = 'true';
    title.textContent = '✓ Ready for local OBS';
    if (statusDot) statusDot.className = 'dot ok';
    if (statusText) statusText.textContent = 'No certificate needed (local HTTP)';
    summary.textContent = 'Using HTTPS or OBS on another PC?';
    if (certTrust.checked && certTrust.trusted === false && certTrust.supported) {
      trustBtn.hidden = false;
      trustBtn.disabled = certTrust.busy;
      trustBtn.textContent = certTrust.busy ? 'Confirm in OS prompt…' : 'Also trust HTTPS cert';
    } else {
      trustBtn.hidden = true;
    }
    if (!obsManualToggled && !obsOsManual) details.open = false;
  } else {
    summary.textContent = 'Manual command / other OS';
    if (showAuto && certTrust.trusted === true) {
      card.dataset.trusted = 'true';
      title.textContent = '✓ Certificate trusted for OBS';
      if (statusDot) statusDot.className = 'dot ok';
      if (statusText) statusText.textContent = 'Trusted on this PC';
      trustBtn.hidden = true;
      if (!obsManualToggled && !obsOsManual) details.open = false;
    } else {
      card.dataset.trusted = 'false';
      title.textContent = '⚠ Blank or black source in OBS?';
      if (showAuto) {
        if (!certTrust.checked) {
          if (statusDot) statusDot.className = 'dot';
          if (statusText) statusText.textContent = 'Checking…';
          trustBtn.hidden = true;
        } else if (certTrust.trusted === false && certTrust.supported) {
          if (statusDot) statusDot.className = 'dot live';
          if (statusText) statusText.textContent = 'Not trusted yet';
          trustBtn.hidden = false;
          trustBtn.disabled = certTrust.busy;
          trustBtn.textContent = certTrust.busy ? 'Confirm in OS prompt…' : 'Trust for OBS (1 click)';
        } else {
          if (statusDot) statusDot.className = 'dot';
          if (statusText) statusText.textContent = 'Manual setup required';
          trustBtn.hidden = true;
        }
      }
      if (!obsManualToggled) details.open = true;
    }
  }
  const path = obsCertPathFor(obsOs);
  const usingAbsolute = Boolean(localCertPath && obsOs === serverPlatform);
  const intro = $('obs-cert-intro');
  const cmd = $('obs-cert-cmd');
  const note = $('obs-cert-note');
  if (obsOs === 'darwin') {
    intro.textContent = 'Run once in Terminal (adds the local CA to the System Keychain), then fully quit (Cmd + Q) and reopen OBS:';
    cmd.textContent = `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${shQuote(path)}`;
    note.textContent = 'GUI alternative: double-click local-cert.pem in Finder to open Keychain Access, set Trust → Always Trust, then restart OBS.';
  } else if (obsOs === 'linux') {
    intro.textContent = 'OBS Browser Source uses Chromium NSS. Install libnss3-tools (Debian/Ubuntu) or nss-tools (Fedora/Arch), run once, then restart OBS:';
    cmd.textContent = `certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "LensPipe" -i ${shQuote(path)}`;
    note.textContent = 'If ~/.pki/nssdb doesn\'t exist yet, create it with: mkdir -p ~/.pki/nssdb && certutil -d sql:$HOME/.pki/nssdb -N --empty-password. For Flatpak OBS, add local-cert.pem to the system CA store (update-ca-certificates / update-ca-trust).';
  } else {
    intro.textContent = usingAbsolute
      ? 'Run once in PowerShell (from any folder), confirm the Windows prompt, then restart OBS completely:'
      : 'Run in PowerShell from the LensPipe folder, confirm the prompt, then restart OBS completely:';
    cmd.textContent = `Import-Certificate -FilePath ${psQuote(path)} -CertStoreLocation Cert:\\CurrentUser\\Root`;
    note.textContent = 'Installs into CurrentUser\\Root (no admin needed). Only trust a certificate generated on your own PC.';
  }
}

function updateObsModal(): void {
  $('obs-url').textContent = obsUrl();
  const localHost = isLocalBrowserHost();
  const lanBase = latestNetwork.wifi[0]?.url;
  if (localHost && location.protocol === 'http:') {
    $('obs-url-hint').textContent = lanBase
      ? `Use this local URL when OBS runs on this PC (no certificate trust or pairing key needed). From another PC on the same LAN, use ${withPairingToken(`${lanBase}/obs`)}.`
      : 'Use this local URL when OBS runs on this PC (no certificate trust or pairing key needed).';
  } else if (localHost) {
    $('obs-url-hint').textContent = lanBase
      ? `Use this URL when OBS runs on this PC (no pairing key needed). From another PC on the same LAN, use ${withPairingToken(`${lanBase}/obs`)}.`
      : 'Use this URL when OBS runs on this PC (no pairing key needed here).';
  } else {
    $('obs-url-hint').textContent = 'Includes the pairing key (#k=…) required by OBS on another device.';
  }
  const activePreset = latestSettings ? PRESETS[latestSettings.preset] : PRESETS[DEFAULT_SETTINGS.preset];
  const activeOrientation = latestSettings?.orientation ?? DEFAULT_SETTINGS.orientation;
  const size = presetSize(activePreset, activeOrientation);
  $('obs-size-hint').textContent = `${size.width} × ${size.height}`;
  renderObsCertGuide();
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-obs-os]')) {
  button.addEventListener('click', () => {
    const os = button.dataset.obsOs;
    if (os !== 'win32' && os !== 'darwin' && os !== 'linux') return;
    obsOs = os;
    obsOsManual = true;
    renderObsCertGuide();
  });
}

document.querySelector('#obs-manual-details summary')?.addEventListener('click', () => {
  obsManualToggled = true;
});

$('obs-trust-btn').addEventListener('click', async () => {
  if (certTrust.busy) return;
  certTrust.busy = true;
  renderObsCertGuide();
  try {
    const response = await fetch('/api/obs/cert-trust', {
      method: 'POST',
      headers: { 'x-lenspipe-action': 'trust-cert' },
    });
    if (!response.ok) {
      toast('Could not trust certificate — try the manual command below', 4500);
      return;
    }
    const result = await response.json() as { trusted: boolean; supported: boolean; message?: string };
    certTrust.checked = true;
    certTrust.trusted = Boolean(result.trusted);
    certTrust.supported = Boolean(result.supported);
    toast(result.message || (result.trusted ? 'Certificate trusted — restart OBS' : 'Could not trust certificate'), 4500);
  } catch {
    toast('Could not trust certificate — try the manual command below', 4500);
  } finally {
    certTrust.busy = false;
    renderObsCertGuide();
  }
});

$('open-obs').addEventListener('click', (event) => {
  if (event.shiftKey) {
    window.open('/obs', '_blank');
    return;
  }
  obsManualToggled = false;
  updateObsModal();
  $<HTMLDialogElement>('obs-modal').showModal();
  void refreshObsCertTrust();
});
$('open-obs').title = 'Show OBS Studio setup guide and URL. Shift-click to open /obs directly.';
$('obs-copy-url').addEventListener('click', () => void copyText(obsUrl(), 'OBS browser source URL'));
$('obs-open-preview').addEventListener('click', () => window.open('/obs', '_blank'));
$('obs-copy-cert').addEventListener('click', () => void copyText($('obs-cert-cmd').textContent || '', 'Certificate command'));
$('show-connection').addEventListener('click', openConnection);
$('waiting-connect').addEventListener('click', openConnection);
function openConnection(): void {
  void refreshNetwork();
  $<HTMLDialogElement>('connection-modal').showModal();
}

// While the connect dialog is open, QR codes must track interface changes at full speed. Closed,
// the snapshots pushed over the WebSocket keep the page current; the slow poll only remains as a
// fallback (pairing token, or the pushed path being down) instead of an HTTPS request every 3 s.
const connectionModal = $<HTMLDialogElement>('connection-modal');
const NETWORK_POLL_OPEN_MS = 3000;
const NETWORK_POLL_IDLE_MS = 30000;
function scheduleNetworkPoll(): void {
  window.setTimeout(() => {
    void refreshNetwork().finally(scheduleNetworkPoll);
  }, connectionModal.open ? NETWORK_POLL_OPEN_MS : NETWORK_POLL_IDLE_MS);
}

async function refreshNetwork(): Promise<void> {
  try {
    // A studio opened on another paired device proves it with the key; this PC needs none.
    const token = pairingToken();
    const response = await fetch('/api/network', { cache: 'no-store', headers: token ? { 'x-pairing-key': token } : {} });
    if (!response.ok) return;
    const network = await response.json() as NetworkSnapshot & { pairingToken?: string; certPath?: string; platform?: string };
    if (network.pairingToken) rememberPairingToken(network.pairingToken);
    if (network.certPath) localCertPath = network.certPath;
    if (network.platform === 'win32' || network.platform === 'darwin' || network.platform === 'linux') {
      serverPlatform = network.platform;
      if (!obsOsManual) obsOs = network.platform;
    }
    await renderNetwork(network);
    if ($<HTMLDialogElement>('obs-modal').open) renderObsCertGuide();
  } catch {
    // The next poll retries; video/control traffic is unaffected.
  }
}

async function renderNetwork(network: NetworkSnapshot): Promise<void> {
  // The key is part of the signature: QR codes drawn before it was known must be redrawn with it.
  const signature = JSON.stringify({ usb: network.usb, wifi: network.wifi, token: pairingToken() });
  if (renderedNetworkSignature === signature) return;
  renderedNetworkSignature = signature;
  latestNetwork = network;
  const generation = ++networkRenderGeneration;
  // USB first: a pill says whether the cable is seen, and the chapter bar marks the step you are on
  const usbFound = network.usb.length > 0;
  setStatePill('usb-state', usbFound, usbFound ? 'Detected' : 'Not detected');
  setStatePill('wifi-state', network.wifi.length > 0, network.wifi.length > 0 ? 'Ready' : 'No network');
  $('usb-steps').innerHTML = stepsBar(['Cable', 'Tethering', 'Scan', 'Trust'], usbFound ? 2 : 0);
  await Promise.all([
    renderEndpoints('usb-endpoints', network.usb, 'No phone USB interface detected. Connect the cable and enable Personal Hotspot (iPhone) or USB tethering (Android).', generation),
    renderEndpoints('wifi-endpoints', network.wifi, 'No private LAN interface detected. Connect this PC to Wi-Fi or Ethernet.', generation),
  ]);
  if ($<HTMLDialogElement>('obs-modal').open) updateObsModal();
}

function setStatePill(id: string, on: boolean, text: string): void {
  const pill = $(id);
  pill.querySelector('.dot')?.classList.toggle('ok', on);
  const label = pill.querySelector('span:last-child');
  if (label) label.textContent = text;
  pill.title = text;
}

async function renderEndpoints(id: string, endpoints: NetworkEndpoint[], empty: string, generation: number): Promise<void> {
  const container = $(id);
  const fragment = document.createDocumentFragment();
  if (!endpoints.length) {
    const message = document.createElement('div');
    message.className = 'empty-endpoint';
    message.textContent = empty;
    fragment.append(message);
    if (generation === networkRenderGeneration) container.replaceChildren(fragment);
    return;
  }
  const tasks: Array<Promise<void>> = [];
  for (const endpoint of endpoints) {
    const url = withPairingToken(`${endpoint.url}/sender`);
    const row = document.createElement('div');
    row.className = 'endpoint';
    const qr = document.createElement('canvas');
    const info = document.createElement('div');
    const code = document.createElement('code');
    code.textContent = url;
    const interfaceName = document.createElement('small');
    const isLan = id === 'wifi-endpoints' || endpoint.transport === 'Wi-Fi';
    interfaceName.textContent = isLan ? `PC network: ${endpoint.name}` : endpoint.name;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'copy-button secondary-button small-button with-icon ico-copy';
    copy.textContent = 'Copy URL';
    copy.addEventListener('click', () => void copyText(url, 'Sender URL'));
    info.append(code, interfaceName, copy);
    row.append(qr, info);
    fragment.append(row);
    if (endpoint.linkDown) fragment.append(linkDownWarning());
    if (endpoint.firewallFix) fragment.append(firewallWarning(endpoint));
    tasks.push(QRCode.toCanvas(qr, url, { width: 260, margin: 1, color: { dark: '#1a1a18', light: '#ffffff' } }));
  }
  await Promise.all(tasks);
  if (generation === networkRenderGeneration) container.replaceChildren(fragment);
}

/** The USB adapter looks connected in Windows, but the iPhone isn't serving the hotspot over it. */
function linkDownWarning(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'firewall-warning';
  const title = document.createElement('strong');
  title.textContent = '⚠ The phone is not answering over the cable';
  const text = document.createElement('p');
  text.textContent = 'Windows shows the USB network as connected, but nothing comes back from the phone, so the page cannot load. On iPhone:';
  const steps = document.createElement('ol');
  for (const step of [
    'Settings → Personal Hotspot: turn “Allow Others to Join” off and on again, and keep that screen open.',
    'Unplug and replug the cable; unlock the phone and tap “Trust” if asked.',
    'The status bar should show the hotspot indicator (link icon / green pill). This warning disappears within a few seconds.',
  ]) {
    const item = document.createElement('li');
    item.textContent = step;
    steps.append(item);
  }
  box.append(title, text, steps);
  return box;
}

/** Windows puts new phone USB networks on the Public profile, where Node's firewall rule doesn't apply. */
function firewallWarning(endpoint: NetworkEndpoint): HTMLElement {
  const box = document.createElement('div');
  box.className = 'firewall-warning';
  const title = document.createElement('strong');
  title.textContent = `⚠ Windows Firewall will block the phone on “${endpoint.name}”`;
  const text = document.createElement('p');
  text.textContent = 'Windows classifies this network as Public, and Node.js is only allowed on Private networks, so the page never loads on the phone. '
    + 'Run this once in PowerShell as administrator (it only opens this port to this USB subnet):';
  const command = document.createElement('code');
  command.textContent = endpoint.firewallFix || '';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy-button secondary-button small-button with-icon ico-copy';
  copy.textContent = 'Copy command';
  copy.addEventListener('click', () => void copyText(endpoint.firewallFix || '', 'Firewall command'));
  const alternative = document.createElement('small');
  alternative.textContent = `Alternative: Settings → Network & internet → Ethernet → “${endpoint.name}” → Network profile type → Private.`;
  box.append(title, text, command, copy, alternative);
  return box;
}

setOnline(false);
watchRanges();
void refreshNetwork();
scheduleNetworkPoll();
window.setTimeout(() => { if (!phoneOnline) openConnection(); }, 1100);
