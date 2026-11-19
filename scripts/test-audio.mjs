// End-to-end audio test: a simulated iPhone sends a 440 Hz tone through the relay in bursts (as audio
// does when it shares the TCP connection with large video frames) and a real Chrome plays it in the
// studio. Checks the studio reports audio arriving, playing and without dropouts.
// Needs a running server: TEST_ORIGIN=https://localhost:8443 (default).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chromePath } from './chrome-path.mjs';

const origin = process.env.TEST_ORIGIN || 'https://localhost:8443';
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (type, value) => Buffer.concat([Buffer.from([type]), Buffer.from(JSON.stringify(value))]);

// --- simulated iPhone ---
const sender = new WebSocket(`${origin.replace(/^http/, 'ws')}/ws/sender`, { rejectUnauthorized: false });
await new Promise((resolve, reject) => { sender.once('open', resolve); sender.once('error', reject); });
sender.on('message', (data) => {
  const b = Buffer.from(data);
  if (b[0] !== 0x10) return;
  const m = JSON.parse(b.subarray(1));
  if (m.type === 'ping') sender.send(json(0x10, { type: 'pong', id: m.id }));
  // Like the real sender: a newly joined studio asks for the current state.
  if (m.type === 'command' && m.command === 'request-state') state(currentExtra);
});
let currentExtra = {};
const state = (extra = {}) => sender.send(json(0x10, {
  type: 'sender-state',
  settings: { orientation: 'landscape', preset: '1080p30', codec: 'avc1.640032', bitrate: 40e6, bitrateMode: 'variable', micEnabled: true, muted: false, torch: false, selectedLens: '', ...extra },
  lenses: [], microphones: [], capabilities: {}, trackSettings: {},
}));
sender.send(json(0x04, { decoderConfig: { codec: 'pcm-s16le', sampleRate: 48000, numberOfChannels: 1 }, sampleRate: 48000, channels: 1, bitsPerSample: 16 }));
state();
let phase = 0;
let sent = 0;
const chunk = () => {
  const samples = 960; // 20 ms at 48 kHz
  const packet = Buffer.alloc(9 + samples * 2);
  packet[0] = 0x05;
  packet.writeDoubleBE(sent * 20_000, 1);
  for (let i = 0; i < samples; i++) packet.writeInt16LE(Math.round(Math.sin((phase++ * 2 * Math.PI * 440) / 48000) * 12000), 9 + i * 2);
  sent++;
  return packet;
};
// Bursty delivery (~100 ms of audio at a time), but at exactly real-time rate like a real microphone:
// send however many 20 ms chunks wall-clock time says are due (setInterval alone drifts late).
const startedAt = performance.now();
const burst = setInterval(() => {
  const due = Math.floor((performance.now() - startedAt) / 20);
  while (sent < due) sender.send(chunk());
}, 100);

// --- real Chrome playing it in the studio ---
const profile = fileURLToPath(new URL('../artifacts/chrome-audio/', import.meta.url));
const port = 9700 + (process.pid % 200);
const chrome = spawn(chromePath(), [
  '--headless=new', '--ignore-certificate-errors', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
let cdp;
try {
  let pages;
  for (let i = 0; i < 50 && !pages; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await pause(100); }
  }
  cdp = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => cdp.once('open', resolve));
  let id = 1; const pending = new Map();
  cdp.on('message', (data) => { const r = JSON.parse(data); pending.get(r.id)?.(r.result); pending.delete(r.id); });
  const call = (method, params = {}) => new Promise((resolve) => { const n = id++; pending.set(n, resolve); cdp.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  await call('Page.navigate', { url: `${origin}/control` });
  await pause(1500);
  await evaluate(`document.getElementById('connection-modal')?.close(); document.getElementById('audio-monitor').click()`);
  await pause(1500); // let the jitter buffer settle
  const readings = [];
  for (let i = 0; i < 7; i++) {
    await pause(1000);
    readings.push(await evaluate(`document.getElementById('audio-status').textContent + ' [' + document.getElementById('audio-status').dataset.level + ']'`));
  }
  console.log(readings.join('\n'));
  const last = readings.at(-1);
  assert.match(last, /Audio arriving · \d+ ms buffer/, 'studio must report audio arriving and buffered');
  assert.match(last, /\[ok\]/, 'audio status must be healthy');
  // The adaptive buffer may drop out a few times while it grows to fit the bursts; after that it must hold.
  assert.doesNotMatch(readings.slice(-3).join(' '), /dropouts/, 'once adapted, bursty delivery must not cause dropouts');

  // Mic problem reported by the iPhone reaches the studio.
  sender.send(json(0x10, { type: 'sender-notice', topic: 'microphone', level: 'warning', message: 'Microphone blocked for this site.' }));
  currentExtra = { micEnabled: false, micProblem: 'Microphone blocked for this site.' };
  state(currentExtra);
  await pause(800);
  const blocked = await evaluate(`document.getElementById('audio-status').textContent + ' [' + document.getElementById('audio-status').dataset.level + ']'`);
  console.log(blocked);
  assert.match(blocked, /blocked.*\[warn\]/, 'a blocked iPhone mic must be shown in the studio');
  console.log(`Audio test passed: ${sent} bursty chunks played, dropout-free once the buffer adapted, and mic problems surface in the studio.`);
} finally {
  clearInterval(burst);
  sender.close();
  cdp?.close();
  chrome.kill();
  await pause(400);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(0);
