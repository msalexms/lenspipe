export const PACKET = {
  VIDEO_CONFIG: 0x01,
  VIDEO_KEYFRAME: 0x02,
  VIDEO_DELTA: 0x03,
  AUDIO_CONFIG: 0x04,
  AUDIO_CHUNK: 0x05,
  CONTROL: 0x10,
} as const;

export type ControlMessage = {
  type: string;
  [key: string]: unknown;
};

export type ParsedPacket =
  | { kind: 'json'; packetType: number; data: ControlMessage; raw: ArrayBuffer }
  | { kind: 'frame'; packetType: number; timestamp: number; data: Uint8Array; raw: ArrayBuffer };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Snaps any angle to 0/90/180/270. */
export function normalizeRotation(value: unknown): number {
  const degrees = Number(value) || 0;
  return ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
}

export function encodeJsonPacket(packetType: number, value: unknown): ArrayBuffer {
  const json = encoder.encode(JSON.stringify(value));
  const packet = new Uint8Array(json.byteLength + 1);
  packet[0] = packetType;
  packet.set(json, 1);
  return packet.buffer;
}

export function encodeControl(value: ControlMessage): ArrayBuffer {
  return encodeJsonPacket(PACKET.CONTROL, value);
}

export function encodeVideoChunk(chunk: EncodedVideoChunk): ArrayBuffer {
  const packet = new Uint8Array(chunk.byteLength + 9);
  packet[0] = chunk.type === 'key' ? PACKET.VIDEO_KEYFRAME : PACKET.VIDEO_DELTA;
  new DataView(packet.buffer).setFloat64(1, chunk.timestamp, false);
  chunk.copyTo(packet.subarray(9));
  return packet.buffer;
}

export function encodePcmChunk(timestamp: number, pcm: Int16Array): ArrayBuffer {
  const packet = new Uint8Array(9 + pcm.byteLength);
  packet[0] = PACKET.AUDIO_CHUNK;
  new DataView(packet.buffer).setFloat64(1, timestamp, false);
  packet.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 9);
  return packet.buffer;
}

export function parsePacket(packet: ArrayBuffer): ParsedPacket | null {
  if (packet.byteLength < 1) return null;
  const bytes = new Uint8Array(packet);
  const packetType = bytes[0];
  if (packetType === PACKET.CONTROL || packetType === PACKET.VIDEO_CONFIG || packetType === PACKET.AUDIO_CONFIG) {
    try {
      return { kind: 'json', packetType, data: JSON.parse(decoder.decode(bytes.subarray(1))), raw: packet };
    } catch {
      return null;
    }
  }
  if (packet.byteLength < 9) return null;
  return {
    kind: 'frame',
    packetType,
    timestamp: new DataView(packet).getFloat64(1, false),
    data: bytes.subarray(9),
    raw: packet,
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const blockSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += blockSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
  }
  return btoa(binary);
}

export function bufferToBase64(value: AllowSharedBufferSource): string {
  if (value instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(value));
  const view = value as ArrayBufferView;
  return bytesToBase64(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
}

export function base64ToBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function videoConfigToWire(config: VideoDecoderConfig): Record<string, unknown> {
  const wire: Record<string, unknown> = { ...config };
  if (config.description) wire.description = bufferToBase64(config.description);
  return wire;
}

export function videoConfigFromWire(config: Record<string, unknown>): VideoDecoderConfig {
  const decoded = { ...config };
  if (typeof decoded.description === 'string') decoded.description = base64ToBuffer(decoded.description);
  return decoded as unknown as VideoDecoderConfig;
}

export function videoMetadataToWire(metadata?: EncodedVideoChunkMetadata): Record<string, unknown> {
  if (!metadata?.decoderConfig) return {};
  return {
    ...metadata,
    decoderConfig: videoConfigToWire(metadata.decoderConfig),
  };
}
