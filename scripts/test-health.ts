import assert from 'node:assert/strict';
import { HealthMonitor, classifySample, type HealthSample } from '../src/health';
import { DEFAULT_SETTINGS } from '../src/stream-settings';

const healthy: HealthSample = {
  settings: { ...DEFAULT_SETTINGS, preset: '1080p60', bitrate: 120_000_000 },
  transport: 'Wi-Fi', bufferedMs: 20, networkDrops: 0, encoderDrops: 0, encoderQueue: 1, senderFps: 60,
  rttMs: 12, relayMbps: 90, receiverFps: 60, decoderQueue: 0, receiverDrops: 0, relayDrops: 0,
};
assert.equal(classifySample(healthy), null);

// Wi-Fi saturated: RTT balloons and the iPhone backlog grows.
const congested = { ...healthy, rttMs: 450, bufferedMs: 900, networkDrops: 6, relayMbps: 45, receiverFps: 40 };
assert.equal(classifySample(congested), 'network', 'network beats the PC symptoms it causes');
const monitor = new HealthMonitor();
assert.equal(monitor.update(congested), null, 'one bad second is not enough');
assert.equal(monitor.update(healthy), null);
assert.equal(monitor.update(congested), null);
const issue = monitor.update(congested);
assert.equal(issue?.kind, 'network', 'raised after 3 of the last 5 seconds');
assert.equal(issue?.changes?.bitrate, 30_000_000, 'suggests ~80% of what actually got through (45 Mbps), rounded down');
assert.match(issue!.title, /Wi-Fi can't keep up with 120 Mbps/);
for (let i = 0; i < 3; i++) assert.equal(monitor.update(healthy)?.kind, 'network', 'sticky until 4 clean seconds');
assert.equal(monitor.update(healthy), null, 'cleared after 4 clean seconds');

// PC can't draw fast enough while the network is fine.
const slowPc = { ...healthy, receiverFps: 31, decoderQueue: 5 };
assert.equal(classifySample(slowPc), 'pc');
const pc = new HealthMonitor();
pc.update(slowPc); pc.update(slowPc);
const pcIssue = pc.update(slowPc);
assert.equal(pcIssue?.kind, 'pc');
assert.deepEqual(pcIssue?.changes, { preset: '1080p30' }, '1080p60 steps down to 1080p30');

// iPhone encoder saturated.
assert.equal(classifySample({ ...healthy, settings: { ...healthy.settings, preset: '4k60' }, encoderDrops: 8, senderFps: 38, encoderQueue: 9 }), 'encoder');

// iPhone-only samples (no PC fields) never report a PC problem.
assert.equal(classifySample({ ...healthy, receiverFps: undefined, rttMs: undefined }), null);
// A stalled iPhone (reports stopped, counted as queued time by the studio) is a link problem, not the PC.
assert.equal(classifySample({ ...healthy, bufferedMs: 4000, senderFps: 0, receiverFps: 0 }), 'network');

console.log('Health test passed: congestion, slow PC and saturated encoder are told apart, with hysteresis and sensible suggestions.');
