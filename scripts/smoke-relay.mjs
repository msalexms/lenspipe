import assert from 'node:assert/strict';
import WebSocket from 'ws';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const origin = process.env.TEST_ORIGIN || 'https://localhost:8443';
const wsOrigin = origin.replace(/^http/, 'ws');

for (const path of ['/sender', '/control', '/obs', '/api/network', '/pcm-player-worklet.js']) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, `${path} should return HTTP 200`);
}

const pending = new Map();
function connect(role) {
  const ws = new WebSocket(`${wsOrigin}/ws/${role}`, { rejectUnauthorized: false });
  const messages = [];
  pending.set(ws, messages);
  ws.on('message', (data, binary) => {
    assert.equal(binary, true);
    const packet = Buffer.from(data);
    if (packet[0] === 0x10) {
      const message = JSON.parse(packet.subarray(1).toString());
      if (message.type === 'ping') ws.send(Buffer.concat([Buffer.from([0x10]), Buffer.from(JSON.stringify({ type: 'pong', id: message.id }))]));
      messages.push(message);
    } else messages.push(packet);
  });
  return ws;
}
function open(ws) {
  return new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
}
function waitFor(ws, predicate, label, timeout = 3000) {
  const messages = pending.get(ws);
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMessage); reject(new Error(`Timed out waiting for ${label}`)); }, timeout);
    function onMessage(data) {
      const packet = Buffer.from(data);
      let message = packet;
      if (packet[0] === 0x10) {
        try { message = JSON.parse(packet.subarray(1).toString()); } catch { return; }
      }
      if (predicate(message)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      }
    }
    ws.on('message', onMessage);
  });
}
function jsonPacket(value) {
  return Buffer.concat([Buffer.from([0x10]), Buffer.from(JSON.stringify(value))]);
}

const control = connect('control');
const sender = connect('sender');
await Promise.all([open(control), open(sender)]);
await waitFor(sender, (message) => message.type === 'hello', 'sender hello');

const videoConfig = Buffer.concat([Buffer.from([0x01]), Buffer.from(JSON.stringify({ decoderConfig: { codec: 'avc1.640032', codedWidth: 1920, codedHeight: 1080 } }))]);
const audioConfig = Buffer.concat([Buffer.from([0x04]), Buffer.from(JSON.stringify({ decoderConfig: { codec: 'pcm-s16le', sampleRate: 48000, numberOfChannels: 1 }, sampleRate: 48000 }))]);
sender.send(videoConfig);
sender.send(audioConfig);
await waitFor(control, (message) => Buffer.isBuffer(message) && message[0] === 1, 'live video config');
await waitFor(control, (message) => Buffer.isBuffer(message) && message[0] === 4, 'live audio config');

const obs = connect('obs');
await open(obs);
const cachedVideo = await waitFor(obs, (message) => Buffer.isBuffer(message) && message[0] === 1, 'cached video config');
const cachedAudio = await waitFor(obs, (message) => Buffer.isBuffer(message) && message[0] === 4, 'cached audio config');
assert.deepEqual(cachedVideo, videoConfig);
assert.deepEqual(cachedAudio, audioConfig);

const keyframe = Buffer.alloc(13);
keyframe[0] = 0x02;
keyframe.writeDoubleBE(123456.75, 1);
keyframe.writeUInt32BE(0xa1b2c3d4, 9);
sender.send(keyframe);
for (const client of [control, obs]) {
  const relayed = await waitFor(client, (message) => Buffer.isBuffer(message) && message[0] === 2, 'keyframe');
  assert.deepEqual(relayed, keyframe, 'video frame bytes must be relayed unchanged');
}

// Flow control: the relay acknowledges every byte it received from the sender on this connection.
const mediaBytes = videoConfig.length + audioConfig.length + keyframe.length;
const ack = await waitFor(sender, (message) => message.type === 'ack' && message.bytes >= mediaBytes, 'byte acknowledgement covering all media');
assert.ok(ack.bytes >= mediaBytes, `ack must count every received byte: ${ack.bytes}`);

control.send(jsonPacket({ type: 'command', command: 'focus-at', x: 0.25, y: 0.75 }));
await waitFor(sender, (message) => message.type === 'command' && message.command === 'focus-at' && message.x === 0.25, 'focus command');
sender.send(jsonPacket({ type: 'sender-focus', result: 'point', x: 0.25, y: 0.75 }));
await waitFor(control, (message) => message.type === 'sender-focus' && message.result === 'point', 'focus result broadcast');

sender.send(jsonPacket({ type: 'sender-telemetry', fps: 60, droppedFrames: 2, width: 1920, height: 1080 }));
await waitFor(control, (message) => message.type === 'sender-telemetry' && message.fps === 60, 'sender telemetry');
control.send(jsonPacket({ type: 'command', command: 'set-zoom', value: 2 }));
await waitFor(sender, (message) => message.type === 'command' && message.command === 'set-zoom' && message.value === 2, 'remote command');
const serverTelemetry = await waitFor(control, (message) => message.type === 'telemetry' && message.online && typeof message.throughputMbps === 'number', 'server throughput telemetry', 4000);
assert.ok(serverTelemetry.throughputMbps > 0);

for (const client of [sender, control, obs]) client.close();
console.log('Smoke test passed: HTTPS views, cached configs, byte-identical video relay, byte acknowledgements, focus round-trip, two-way control, and live telemetry.');
