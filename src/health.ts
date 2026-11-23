/**
 * Lag detection shared by the iPhone sender and the PC studio. Each second a sample of the pipeline is
 * classified by where it is falling behind; a warning is raised only when a cause persists, and comes
 * with a one-tap setting change that relieves it.
 */
import { CODEC_H264, MIN_BITRATE, PRESETS, codecName, type PresetName, type StreamSettings } from './stream-settings';

export type HealthKind = 'network' | 'encoder' | 'pc';

export interface HealthSample {
  settings: StreamSettings;
  transport: string;
  /** Worst iPhone WebSocket backlog this second, expressed as milliseconds of video at the target bitrate. */
  bufferedMs: number;
  /** Frames the iPhone skipped this second because the link was backed up / the encoder was saturated. */
  networkDrops: number;
  encoderDrops: number;
  encoderQueue: number;
  senderFps: number;
  // PC-side signals (absent on the iPhone).
  rttMs?: number | null;
  relayMbps?: number | null;
  receiverFps?: number | null;
  decoderQueue?: number;
  receiverDrops?: number;
  relayDrops?: number;
  /** Time video spends on the PC side: queued in the server for the tab + arrival -> drawn in the tab. */
  receiverLatencyMs?: number;
}

export interface HealthIssue {
  kind: HealthKind;
  title: string;
  detail: string;
  actionLabel: string | null;
  changes: Partial<StreamSettings> | null;
}

const WINDOW = 5;
const RAISE_AFTER = 3;
const CLEAR_AFTER = 4;
const PRIORITY: HealthKind[] = ['network', 'encoder', 'pc'];

export function classifySample(sample: HealthSample): HealthKind | null {
  // Uplink congestion shows up as a growing send backlog on the iPhone and as pongs queued behind video.
  if (sample.bufferedMs > 300 || sample.networkDrops >= 2 || (sample.rttMs ?? 0) > 200) return 'network';
  const targetFps = PRESETS[sample.settings.preset].frameRate;
  if (sample.encoderDrops >= 2 || (sample.encoderQueue >= 4 && sample.senderFps < targetFps * 0.8)) return 'encoder';
  if (sample.receiverFps != null && sample.senderFps >= 10) {
    if (sample.receiverFps < sample.senderFps * 0.8 || (sample.decoderQueue ?? 0) >= 4
      || (sample.receiverDrops ?? 0) >= 2 || (sample.relayDrops ?? 0) >= 2
      || (sample.receiverLatencyMs ?? 0) > 120) return 'pc';
  }
  return null;
}

export class HealthMonitor {
  private history: Array<HealthKind | null> = [];
  private active: HealthKind | null = null;

  /** Pass `null` while nothing is streaming. */
  update(sample: HealthSample | null): HealthIssue | null {
    if (!sample) {
      this.history = [];
      this.active = null;
      return null;
    }
    this.history.push(classifySample(sample));
    if (this.history.length > WINDOW) this.history.shift();
    const raised = PRIORITY.find((kind) => this.history.filter((entry) => entry === kind).length >= RAISE_AFTER);
    if (raised) this.active = raised;
    else if (this.active && this.history.length >= CLEAR_AFTER && !this.history.slice(-CLEAR_AFTER).includes(this.active)) this.active = null;
    return this.active ? describeIssue(this.active, sample) : null;
  }
}

const mbps = (bitrate: number) => `${Math.round(bitrate / 1_000_000)} Mbps`;

function lowerPreset(preset: PresetName): PresetName | null {
  // Step down within the same aspect ratio, so the picture keeps its shape.
  const order: PresetName[] = PRESETS[preset].ratio === '4:3'
    ? ['4x3-12mp30', '4x3-1440p30']
    : ['4k60', '4k30', '1080p60', '1080p30'];
  const index = order.indexOf(preset);
  return index >= 0 ? order[index + 1] ?? null : null;
}

function lowerBitrate(settings: StreamSettings, relayMbps?: number | null): number | null {
  let target = settings.bitrate * 0.6;
  // When congested, what reaches the PC is roughly what the link can carry: aim below it.
  if (relayMbps && relayMbps > 1) target = Math.min(target, relayMbps * 1_000_000 * 0.8);
  const next = Math.max(MIN_BITRATE, Math.floor(target / 10_000_000) * 10_000_000);
  return next < settings.bitrate ? next : null;
}

function presetAction(settings: StreamSettings): Pick<HealthIssue, 'actionLabel' | 'changes'> {
  const preset = lowerPreset(settings.preset);
  if (preset) return { actionLabel: `Switch to ${PRESETS[preset].label}`, changes: { preset } };
  if (settings.codec !== CODEC_H264) return { actionLabel: 'Switch to H.264', changes: { codec: CODEC_H264 } };
  return { actionLabel: null, changes: null };
}

export function describeIssue(kind: HealthKind, sample: HealthSample): HealthIssue {
  const { settings } = sample;
  const format = `${PRESETS[settings.preset].label} ${codecName(settings.codec)}`;
  if (kind === 'network') {
    const link = sample.transport === 'USB' ? 'The USB link' : sample.transport === 'Wi-Fi' ? 'Wi-Fi' : 'The network';
    const facts: string[] = [];
    if (sample.rttMs != null && sample.rttMs > 100) facts.push(`RTT ${Math.round(sample.rttMs)} ms`);
    if (sample.bufferedMs > 100) facts.push(`${Math.round(sample.bufferedMs)} ms queued on the phone`);
    if (sample.networkDrops > 0) facts.push(`${sample.networkDrops} frames/s skipped`);
    const bitrate = lowerBitrate(settings, sample.relayMbps);
    const advice = sample.transport === 'Wi-Fi' ? ' A USB cable carries far more.' : '';
    return {
      kind,
      title: `${link} can't keep up with ${mbps(settings.bitrate)}`,
      detail: `${facts.join(' · ') || 'Video is arriving late'}.${advice}`,
      ...(bitrate ? { actionLabel: `Lower to ${mbps(bitrate)}`, changes: { bitrate } } : presetAction(settings)),
    };
  }
  if (kind === 'encoder') {
    const targetFps = PRESETS[settings.preset].frameRate;
    return {
      kind,
      title: `The phone can't encode ${format} in real time`,
      detail: `${sample.senderFps} of ${targetFps} fps, encoder queue ${sample.encoderQueue}. Heat and battery-saver mode make this worse.`,
      ...presetAction(settings),
    };
  }
  const shown = sample.receiverFps ?? 0;
  const latency = sample.receiverLatencyMs ?? 0;
  return {
    kind,
    title: shown < sample.senderFps * 0.8
      ? `This PC is falling behind (${shown} of ${sample.senderFps} fps shown)`
      : `This PC adds ${Math.round(latency)} ms of delay`,
    detail: `Decoding/drawing ${format} is too heavy for this browser right now. Each open preview (studio + OBS) decodes separately.`,
    ...presetAction(settings),
  };
}

/** Binds the warning banner present on both pages (#health-banner and its children). */
export class HealthBanner {
  private issue: HealthIssue | null = null;
  private readonly snoozedUntil = new Map<HealthKind, number>();
  private readonly root = document.getElementById('health-banner') as HTMLElement;

  constructor(private readonly apply: (changes: Partial<StreamSettings>) => void) {
    document.getElementById('health-action')?.addEventListener('click', () => {
      if (!this.issue?.changes) return;
      this.apply(this.issue.changes);
      // Give the new settings a few seconds to settle before judging them.
      this.snooze(this.issue.kind, 8_000);
    });
    document.getElementById('health-dismiss')?.addEventListener('click', () => {
      if (this.issue) this.snooze(this.issue.kind, 60_000);
    });
  }

  show(issue: HealthIssue | null): void {
    const visible = issue && (this.snoozedUntil.get(issue.kind) ?? 0) < Date.now() ? issue : null;
    this.issue = visible;
    this.root.hidden = !visible;
    this.root.dataset.kind = visible?.kind ?? '';
    if (!visible) return;
    (document.getElementById('health-title') as HTMLElement).textContent = visible.title;
    (document.getElementById('health-detail') as HTMLElement).textContent = visible.detail;
    const action = document.getElementById('health-action') as HTMLButtonElement;
    action.hidden = !visible.actionLabel;
    action.textContent = visible.actionLabel ?? '';
  }

  private snooze(kind: HealthKind, ms: number): void {
    this.snoozedUntil.set(kind, Date.now() + ms);
    this.show(null);
  }
}
