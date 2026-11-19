export const PACKET = {
  VIDEO_CONFIG: 0x01,
  VIDEO_KEYFRAME: 0x02,
  VIDEO_DELTA: 0x03,
  AUDIO_CONFIG: 0x04,
  AUDIO_CHUNK: 0x05,
  CONTROL: 0x10,
} as const;

export function encodeControl(value: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  return Buffer.concat([Buffer.from([PACKET.CONTROL]), json]);
}
