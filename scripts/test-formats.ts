import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, PRESETS, h264Codec, hevcCodecs, limitCrop, sanitizeSettings } from '../src/stream-settings';

// Defaults: the best picture with the least fuss, from an iOS video mode.
assert.equal(DEFAULT_SETTINGS.preset, '4k30');
assert.equal(DEFAULT_SETTINGS.orientation, 'landscape');
// 16:9 formats are iOS video modes; the 4:3 ones are photo modes and must be flagged for the warning.
for (const preset of Object.values(PRESETS)) {
  assert.equal(preset.photoMode, preset.ratio === '4:3', `${preset.label} flagged correctly`);
  assert.equal(preset.width * (preset.ratio === '4:3' ? 3 : 9), preset.height * (preset.ratio === '4:3' ? 4 : 16), `${preset.label} has its ratio`);
}
assert.equal(PRESETS[DEFAULT_SETTINGS.preset].photoMode, false, 'the default is a video mode');
assert.equal(h264Codec(4032, 3024, 30, 60_000_000), 'avc1.64003C', '12 MP needs level 6.0');

// Codec levels follow the frame size, rate and bitrate.
assert.equal(h264Codec(1920, 1080, 30, 20_000_000), 'avc1.640028', '1080p30 at 20 Mbps fits level 4.0');
assert.equal(h264Codec(1920, 1080, 30, 40_000_000), 'avc1.64002A', 'above 25 Mbps level 4.0 is too small: 4.2');
assert.equal(h264Codec(1920, 1080, 60, 60_000_000), 'avc1.64002A', '1080p60 at 60 Mbps fits 4.2');
assert.equal(h264Codec(1920, 1080, 60, 80_000_000), 'avc1.640032', 'above 62.5 Mbps: 5.0');
assert.equal(h264Codec(3840, 2160, 30, 60_000_000), 'avc1.640033', '4K30 is level 5.1');
assert.equal(h264Codec(3840, 2160, 60, 60_000_000), 'avc1.640034', '4K60 is level 5.2');
assert.deepEqual(hevcCodecs(3840, 2160, 80_000_000), ['hvc1.1.6.H153.B0', 'hvc1.1.6.L153.B0']);
assert.deepEqual(hevcCodecs(1920, 1080, 30_000_000), ['hvc1.1.6.L153.B0']);

// Encoder limit safety net: a frame the encoder refuses is centre-cropped to the largest accepted size.
const frame = { x: 0, y: 0, width: 3840, height: 2160 };
assert.deepEqual(limitCrop(frame, null, { long: 3200, short: 1800 }), { x: 320, y: 180, width: 3200, height: 1800 });
assert.equal(limitCrop(frame, null, { long: 4096, short: 2304 }), null, 'fits: untouched');

// Settings from the network are checked.
assert.deepEqual(sanitizeSettings({ preset: '1080p30', turned: true }), { preset: '1080p30', turned: true });
assert.deepEqual(sanitizeSettings({ framing: 'upright', preset: '4x3-12mp30' }), { preset: '4x3-12mp30' }, 'removed options are ignored');

console.log('Formats test passed: 4:3 photo modes are flagged, 4K30 video mode by default, codec levels fit every format.');
