import assert from 'node:assert/strict';
import { encodeRotation, holdState, rotatePoint, sensorRotation } from '../src/stream-settings';

/** Shape of the picture the PC draws: the buffer turned by the rotation sent with it. */
const shape = (width: number, height: number, rotation: number) => {
  const quarter = rotation % 180 !== 0;
  return (quarter ? height : width) >= (quarter ? width : height) ? 'landscape' : 'portrait';
};

// iOS sensor frames are landscape (1920×1080) however the phone is held. The output rotation depends only
// on the chosen aspect and the 180° turn, never on how the iPhone is held, so it can never flip by itself.
for (const facing of ['environment', 'user'] as const) {
  for (const orientation of ['landscape', 'portrait'] as const) {
    for (const turned of [false, true]) {
      const target = sensorRotation(orientation, turned, facing, true);
      const rotation = encodeRotation(target, 0, 1920, 1080, orientation);
      assert.equal(shape(1920, 1080, rotation), orientation, `${facing} ${orientation} turned=${turned}`);
      assert.equal(rotation, target, 'sensor frames are sent with the target rotation unchanged');
    }
  }
}
// The values match WebKit's rotation for a phone held that way, so that hold comes out upright.
assert.equal(sensorRotation('landscape', false, 'environment', true), 0);
assert.equal(sensorRotation('portrait', false, 'environment', true), 90);
assert.equal(sensorRotation('landscape', false, 'user', true), 180);
assert.equal(sensorRotation('portrait', false, 'user', true), 270);
assert.equal(sensorRotation('landscape', true, 'environment', true), 180, 'turned adds 180°');
assert.equal(sensorRotation('portrait', true, 'environment', true), 270);

// Frames copied from Safari's <video> are already turned the way the phone is held: that is undone.
// Phone upright (video frame 1080×1920, turned 90°) with 16:9 chosen still gives a landscape picture.
assert.equal(encodeRotation(0, 90, 1080, 1920, 'landscape'), 270);
assert.equal(shape(1080, 1920, 270), 'landscape');
assert.equal(encodeRotation(90, 90, 1080, 1920, 'portrait'), 0);
// An unexpected buffer shape still yields the chosen aspect.
assert.equal(shape(1080, 1920, encodeRotation(0, 0, 1080, 1920, 'landscape')), 'landscape');
// Desktop browsers deliver upright frames: 16:9 as is, 9:16 a quarter turn.
assert.equal(sensorRotation('landscape', false, 'user', false), 0);
assert.equal(sensorRotation('portrait', false, 'user', false), 90);

// Hold warning: compares the rotation sent with how iOS would show the camera for the way the phone is held.
// WebKit's rotations (back camera): phone sideways (landscape) 0, upright 90, upside-down landscape 180.
const landscape = sensorRotation('landscape', false, 'environment', true);
assert.equal(holdState(landscape, 0), 'ok', '16:9, phone sideways');
assert.equal(holdState(landscape, 90), 'across', '16:9, phone upright: the picture comes out on its side');
assert.equal(holdState(landscape, 180), 'upside-down', '16:9, phone sideways the other way round');
assert.equal(holdState(sensorRotation('landscape', true, 'environment', true), 180), 'ok', 'Rotate 180° fixes it');
assert.equal(holdState(sensorRotation('portrait', false, 'environment', true), 90), 'ok', '9:16, phone upright');
assert.equal(holdState(sensorRotation('portrait', false, 'environment', true), 0), 'across', '9:16, phone sideways');
// Front camera uses its own rotations (phone sideways 180, upright 270).
assert.equal(holdState(sensorRotation('landscape', false, 'user', true), 180), 'ok');
assert.equal(holdState(sensorRotation('portrait', false, 'user', true), 270), 'ok');
assert.equal(holdState(sensorRotation('landscape', false, 'user', true), 270), 'across');

// Focus taps: a point turned by r and back by -r is unchanged; corners move clockwise.
assert.deepEqual(rotatePoint(0, 0, 90), { x: 1, y: 0 });
assert.deepEqual(rotatePoint(1, 0, 90), { x: 1, y: 1 });
assert.deepEqual(rotatePoint(0.25, 0.1, 180), { x: 0.75, y: 0.9 });
for (const r of [0, 90, 180, 270, -90]) {
  const there = rotatePoint(0.2, 0.7, r);
  const back = rotatePoint(there.x, there.y, -r);
  assert.ok(Math.abs(back.x - 0.2) < 1e-9 && Math.abs(back.y - 0.7) < 1e-9, `round trip ${r}`);
}

console.log('Orientation test passed: 16:9 / 9:16 and the 180° turn decide the picture, and holding the iPhone across it or upside down is detected.');
