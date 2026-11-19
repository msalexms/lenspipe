import assert from 'node:assert/strict';
import { inspectSps, patchAvcCForLowDelay, patchSpsForLowDelay } from '../src/h264-sps';

// avcC captured from an iPhone (Safari WebCodecs, H.264 High, 1080p, "quality" mode).
const avcC = Buffer.from('01640032ffe1001027640032ac5680780227e59b8101010101000428ee3cb0fdf8f800', 'hex');
const sps = avcC.subarray(8, 8 + avcC.readUInt16BE(6));

const before = inspectSps(sps)!;
assert.ok(before, 'the iPhone SPS must parse');
assert.equal(before.profile, 100);
assert.equal(before.level, 50);
assert.equal(before.widthMbs * 16, 1920);
assert.equal(before.reorder, null, 'the original SPS lacks bitstream_restriction, forcing a 13-frame output delay');

const patched = patchSpsForLowDelay(sps)!;
const after = inspectSps(patched)!;
assert.equal(after.reorder, 0, 'patched SPS declares no reordering');
assert.equal(after.dpb, Math.max(1, before.maxRefFrames), 'max_dec_frame_buffering must cover the reference frames');
for (const key of ['profile', 'level', 'widthMbs', 'heightMapUnits', 'maxRefFrames', 'vuiPresent', 'fullRange'] as const) {
  assert.equal(after[key], before[key], `${key} must be preserved`);
}
assert.deepEqual(Buffer.from(patchSpsForLowDelay(patched)!), Buffer.from(patched), 'patching is idempotent');

const newAvcC = patchAvcCForLowDelay(avcC)!;
assert.ok(newAvcC);
assert.deepEqual(Buffer.from(newAvcC.subarray(0, 6)), Buffer.from(avcC.subarray(0, 6)), 'avcC header unchanged');
const ppsAndTail = avcC.subarray(8 + sps.length);
assert.deepEqual(Buffer.from(newAvcC.subarray(newAvcC.length - ppsAndTail.length)), Buffer.from(ppsAndTail), 'PPS and High-profile tail copied verbatim');

// Emulation prevention: an SPS whose payload contains 00 00 0x must stay escaped after rewriting.
// Baseline 640x480 SPS without VUI, built bit by bit: profile 66, level 3.0, POC type 2, 1 ref frame.
const bits: number[] = [];
const u = (n: number, v: number) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
const ue = (v: number) => { const c = v + 1; const len = Math.floor(Math.log2(c)); u(len, 0); u(len + 1, c); };
u(8, 66); u(8, 0xc0); u(8, 30); ue(0); ue(0); ue(2); ue(1); u(1, 0); ue(39); ue(29); u(1, 1); u(1, 1); u(1, 0); u(1, 0);
bits.push(1); while (bits.length % 8) bits.push(0);
const noVui = Buffer.alloc(1 + bits.length / 8);
noVui[0] = 0x67;
bits.forEach((bit, i) => { noVui[1 + (i >> 3)] |= bit << (7 - (i & 7)); });
assert.equal(inspectSps(noVui)!.vuiPresent, false);
assert.equal(inspectSps(noVui)!.widthMbs * 16, 640);
const noVuiPatched = patchSpsForLowDelay(noVui)!;
assert.equal(inspectSps(noVuiPatched)!.reorder, 0, 'a VUI is added when the SPS had none');
for (let i = 2; i < noVuiPatched.length; i++) {
  assert.ok(!(noVuiPatched[i - 2] === 0 && noVuiPatched[i - 1] === 0 && noVuiPatched[i] <= 2), 'no start-code emulation');
}
console.log(`SPS test passed: iPhone SPS (level ${before.level / 10}, ${before.maxRefFrames} ref) rewritten to max_num_reorder_frames=0, all other fields preserved.`);
