/** Stream settings shared by the iPhone sender and the PC studio. */

export const CODEC_H264 = 'avc1.640032';
export const CODEC_HEVC = 'hvc1.1.6.L153.B0';

export type Orientation = 'landscape' | 'portrait';
export type AspectRatio = '16:9' | '4:3';
/** How the phone is held relative to the chosen aspect: right, across it (turned 90°), or upside down. */
export type Hold = 'ok' | 'across' | 'upside-down';
/** `variable` spends bits where the picture needs them; `constant` keeps the link load flat. */
export type BitrateMode = 'constant' | 'variable';
/** `quality` lets the encoder look ahead / reorder frames; `realtime` minimizes delay. */
export type LatencyMode = 'quality' | 'realtime';

export interface StreamSettings {
  orientation: Orientation;
  /** Turn the picture over (180°) for an iPhone mounted upside down. */
  turned: boolean;
  preset: PresetName;
  codec: string;
  bitrate: number;
  bitrateMode: BitrateMode;
  latencyMode: LatencyMode;
}

/**
 * Output formats, in landscape terms. The 16:9 ones are iOS video modes with the iPhone's full video
 * processing (temporal noise reduction, video HDR, tone mapping, downscaling from the whole sensor). The 4:3
 * ones are the whole sensor, which Safari exposes as photo modes (`photoMode`): wider field of view, but
 * delivered with much less of that processing, so noisier and flatter. They carry a warning in the UI.
 */
export const PRESETS = {
  '4k60': { width: 3840, height: 2160, frameRate: 60, ratio: '16:9', photoMode: false, label: '4K60' },
  '4k30': { width: 3840, height: 2160, frameRate: 30, ratio: '16:9', photoMode: false, label: '4K30' },
  '1080p60': { width: 1920, height: 1080, frameRate: 60, ratio: '16:9', photoMode: false, label: '1080p60' },
  '1080p30': { width: 1920, height: 1080, frameRate: 30, ratio: '16:9', photoMode: false, label: '1080p30' },
  '4x3-12mp30': { width: 4032, height: 3024, frameRate: 30, ratio: '4:3', photoMode: true, label: '12 MP 4:3' },
  '4x3-1440p30': { width: 1920, height: 1440, frameRate: 30, ratio: '4:3', photoMode: true, label: '1440p 4:3' },
  '4x3-1080p60': { width: 1440, height: 1080, frameRate: 60, ratio: '4:3', photoMode: true, label: '1080p60 4:3' },
} as const satisfies Record<string, { width: number; height: number; frameRate: number; ratio: AspectRatio; photoMode: boolean; label: string }>;

/** Shown wherever a 4:3 photo mode is selected or active. */
export const PHOTO_MODE_WARNING = 'Photo mode: the whole 4:3 sensor, but the iPhone does not apply its video processing (noise reduction, video HDR, tone mapping), so the picture is noisier and flatter than the 16:9 formats.';
export type PresetName = keyof typeof PRESETS;
export type Preset = (typeof PRESETS)[PresetName];

/** Output size of a preset for an orientation (portrait swaps it). */
export function presetSize(preset: Preset, orientation: Orientation): { width: number; height: number } {
  return orientation === 'portrait' ? { width: preset.height, height: preset.width } : { width: preset.width, height: preset.height };
}

export const MIN_BITRATE = 20_000_000;
export const MAX_BITRATE = 200_000_000;

/**
 * Defaults: the best picture with the least fuss. 4K at 30 fps (every lens delivers it), landscape,
 * H.264 (every PC decodes it in hardware), 60 Mbps VBR in quality mode (Safari only reaches high bitrates
 * in quality mode).
 */
export const DEFAULT_SETTINGS: StreamSettings = {
  orientation: 'landscape',
  turned: false,
  preset: '4k30',
  codec: CODEC_H264,
  bitrate: 60_000_000,
  bitrateMode: 'variable',
  latencyMode: 'quality',
};

export const PROFILES = {
  'max-quality': {
    label: 'Max quality',
    detail: '4K30 · HEVC · 80 Mbps · VBR · quality',
    settings: { preset: '4k30', codec: CODEC_HEVC, bitrate: 80_000_000, bitrateMode: 'variable', latencyMode: 'quality' },
  },
  'low-latency': {
    label: 'Low latency',
    detail: '1080p60 · H.264 · 40 Mbps · CBR · realtime',
    settings: { preset: '1080p60', codec: CODEC_H264, bitrate: 40_000_000, bitrateMode: 'constant', latencyMode: 'realtime' },
  },
} as const satisfies Record<string, { label: string; detail: string; settings: Partial<StreamSettings> }>;

export type ProfileName = keyof typeof PROFILES;

/** Keeps only valid, known values from an untrusted settings object. */
export function sanitizeSettings(input: Record<string, unknown> | undefined): Partial<StreamSettings> {
  const result: Partial<StreamSettings> = {};
  if (!input) return result;
  if (input.orientation === 'landscape' || input.orientation === 'portrait') result.orientation = input.orientation;
  if (typeof input.turned === 'boolean') result.turned = input.turned;
  if (typeof input.preset === 'string' && input.preset in PRESETS) result.preset = input.preset as PresetName;
  if (input.codec === CODEC_H264 || input.codec === CODEC_HEVC) result.codec = input.codec;
  const bitrate = Number(input.bitrate);
  if (Number.isFinite(bitrate) && bitrate > 0) result.bitrate = Math.max(MIN_BITRATE, Math.min(MAX_BITRATE, bitrate));
  if (input.bitrateMode === 'constant' || input.bitrateMode === 'variable') result.bitrateMode = input.bitrateMode;
  if (input.latencyMode === 'quality' || input.latencyMode === 'realtime') result.latencyMode = input.latencyMode;
  return result;
}

export function codecName(codec: string): string {
  return codec.startsWith('hvc1') || codec.startsWith('hev1') ? 'HEVC' : 'H.264';
}

export function describeSettings(settings: StreamSettings): { title: string; detail: string } {
  return {
    title: `${PRESETS[settings.preset].label} · ${codecName(settings.codec)} · ${Math.round(settings.bitrate / 1_000_000)} Mbps`,
    detail: `${settings.bitrateMode === 'variable' ? 'VBR' : 'CBR'} · ${settings.latencyMode === 'quality' ? 'quality mode' : 'low-latency mode'} · ${aspectLabel(settings)}${PRESETS[settings.preset].photoMode ? ' · photo mode' : ''}${settings.turned ? ' · turned' : ''}`,
  };
}

/** "16:9", "9:16", "4:3" or "3:4". */
export function aspectLabel(settings: Pick<StreamSettings, 'preset' | 'orientation'>): string {
  const ratio = PRESETS[settings.preset].ratio;
  return settings.orientation === 'landscape' ? ratio : ratio.split(':').reverse().join(':');
}

export function matchingProfile(settings: StreamSettings): ProfileName | null {
  for (const [name, profile] of Object.entries(PROFILES) as Array<[ProfileName, (typeof PROFILES)[ProfileName]]>) {
    const p: Partial<StreamSettings> = profile.settings;
    if (
      settings.preset === p.preset
      && settings.codec === p.codec
      && settings.bitrate === p.bitrate
      && settings.bitrateMode === p.bitrateMode
      && settings.latencyMode === p.latencyMode
    ) {
      return name;
    }
  }
  return null;
}

export function formatTrackMode(mode: string): string {
  switch (mode) {
    case 'continuous': return 'Continuous';
    case 'manual': return 'Locked';
    case 'single-shot': return 'Single-shot';
    case 'none': return 'None';
    default: return mode;
  }
}

export type Facing = 'environment' | 'user';

/** Snaps any angle to 0, 90, 180 or 270. */
export function quarterTurns(degrees: number): number {
  return (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
}

/**
 * Fixed output orientation: the clockwise rotation, relative to the camera sensor, that the PC shows.
 * The chosen aspect alone decides the shape (16:9 = the sensor as it is, 9:16 = a quarter turn) and how
 * the iPhone is held is ignored, so the picture never flips by itself. `turned` adds 180° for an
 * upside-down mount. The bases are WebKit's own rotations for a phone held landscape / upright, so a
 * phone held that way comes out upright. Elsewhere (desktop browsers) frames arrive upright already.
 */
export function sensorRotation(orientation: Orientation, turned: boolean, facing: Facing, ios: boolean): number {
  const portrait = orientation === 'portrait';
  const base = ios && facing === 'user' ? (portrait ? 270 : 180) : (portrait ? 90 : 0);
  return quarterTurns(base + (turned ? 180 : 0));
}

/**
 * Rotation to send for a buffer that is already turned by `bufferRotation` (frames copied from Safari's
 * <video> follow the phone; sensor frames are 0). If the result would not have the chosen shape (an
 * unexpected portrait buffer) it adds a quarter turn, so the aspect is always the one selected.
 */
export function encodeRotation(target: number, bufferRotation: number, width: number, height: number, orientation: Orientation): number {
  const rotation = quarterTurns(target - bufferRotation);
  const quarter = rotation % 180 !== 0;
  const landscape = (quarter ? height : width) >= (quarter ? width : height);
  return landscape === (orientation === 'landscape') ? rotation : quarterTurns(rotation + 90);
}

/** Where a normalized point of a picture lands after the picture is turned clockwise by `rotation`. */
/**
 * Whether the picture comes out the right way up. `target` is the rotation sent (from the chosen aspect and
 * the 180° turn) and `display` how iOS would turn the camera for the way the phone is held, both relative
 * to the sensor. Equal: upright. Half a turn apart: upside down. A quarter: the phone is held across the
 * aspect (upright for 16:9, sideways for 9:16), so the scene comes out on its side.
 */
export function holdState(target: number, display: number): Hold {
  const difference = quarterTurns(target - display);
  return difference === 0 ? 'ok' : difference === 180 ? 'upside-down' : 'across';
}

export function rotatePoint(x: number, y: number, rotation: number): { x: number; y: number } {
  switch (quarterTurns(rotation)) {
    case 90: return { x: 1 - y, y: x };
    case 180: return { x: 1 - x, y: 1 - y };
    case 270: return { x: y, y: 1 - x };
    default: return { x, y };
  }
}

export interface CropRect { x: number; y: number; width: number; height: number }

/**
 * H.264 High profile codec string with the lowest level that fits the frame size, macroblock rate and
 * bitrate (levels 4.0 to 6.0; 6.0 is needed above ~8.9 MP, e.g. a 12 MP 4:3 frame).
 */
export function h264Codec(width: number, height: number, frameRate: number, bitrate: number): string {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const levels: Array<[number, number, number, number]> = [
    // [level_idc, max frame MBs, max MBs/s, max High-profile bitrate]
    [40, 8192, 245_760, 25_000_000],
    [42, 8704, 522_240, 62_500_000],
    [50, 22_080, 589_824, 168_750_000],
    [51, 36_864, 983_040, 300_000_000],
    [52, 36_864, 2_073_600, 300_000_000],
    [60, 139_264, 4_177_920, 300_000_000],
  ];
  const level = levels.find(([, maxFrame, maxRate, maxBitrate]) => frameMbs <= maxFrame && frameMbs * frameRate <= maxRate && bitrate <= maxBitrate)?.[0] ?? 60;
  return `avc1.6400${level.toString(16).toUpperCase().padStart(2, '0')}`;
}

/** HEVC Main profile strings, best first: High tier for high bitrates, level 6.0 above 8.9 MP luma. */
export function hevcCodecs(width: number, height: number, bitrate: number): string[] {
  if (width * height > 8_912_896) return bitrate > 60_000_000 ? ['hvc1.1.6.H180.B0', 'hvc1.1.6.L180.B0'] : ['hvc1.1.6.L180.B0', 'hvc1.1.6.H180.B0'];
  if (bitrate > 160_000_000) return ['hvc1.1.6.H156.B0', 'hvc1.1.6.H153.B0', CODEC_HEVC];
  if (bitrate > 40_000_000) return ['hvc1.1.6.H153.B0', CODEC_HEVC];
  return [CODEC_HEVC];
}

/**
 * Keeps a frame (or its crop) within the largest size the iPhone encoder accepts, by a centred crop with
 * the same aspect. The limit is orientation-agnostic: `long` and `short` sides. Returns the original crop
 * (or null) when it already fits.
 */
export function limitCrop(visible: CropRect, crop: CropRect | null, limit: { long: number; short: number }): CropRect | null {
  const base = crop ?? visible;
  const long = Math.max(base.width, base.height);
  const short = Math.min(base.width, base.height);
  if (long <= limit.long && short <= limit.short) return crop;
  const scale = Math.min(limit.long / long, limit.short / short);
  const width = Math.max(8, Math.floor((base.width * scale) / 8) * 8);
  const height = Math.max(8, Math.floor((base.height * scale) / 8) * 8);
  const even = (value: number) => Math.floor(value / 2) * 2;
  return { x: even(base.x + (base.width - width) / 2), y: even(base.y + (base.height - height) / 2), width, height };
}
