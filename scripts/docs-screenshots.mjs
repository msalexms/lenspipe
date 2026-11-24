// npm run screenshots: the README images in docs/screenshots/, taken from a real stream.
//
// Starts its own server (fresh data folder), then headless Chrome plays the phone with a fake camera that
// shows scripts/assets/demo-scene.svg, the studio and OBS decode it, and each view is captured live.
// Needs `npm run build` first, Chrome (or CHROME_PATH) and ffmpeg (or FFMPEG) to make the fake camera video.
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { chromePath } from './chrome-path.mjs';

const out = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const scene = fileURLToPath(new URL('./assets/demo-scene.svg', import.meta.url));
const serverEntry = fileURLToPath(new URL('../dist-server/index.js', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'lenspipe-docs-'));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const children = [];

/**
 * The studio's view of the network: a ready iPhone USB link and a generic Wi-Fi address, with a demo key,
 * so the connect dialog shows both QR codes and never this PC's addresses or real key.
 */
const STUDIO_NETWORK = `(() => {
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await original(input, init);
    if (!String(input).startsWith('/api/network') || !response.ok) return response;
    const network = await response.json();
    Object.assign(network, {
      pairingToken: 'demo-pairing-key',
      usb: [{ name: 'iPhone USB', address: '172.20.10.3', transport: 'USB', url: 'https://172.20.10.3:8443' }],
      wifi: [{ name: 'Ethernet', address: '192.168.1.20', transport: 'Wi-Fi', url: 'https://192.168.1.20:8443' }],
    });
    return new Response(JSON.stringify(network), { headers: { 'content-type': 'application/json' } });
  };
})()`;

/** Opens a dialog without the keyboard focus ring its first button would get. */
const showDialog = (id) => `(() => { document.getElementById('${id}').showModal(); document.activeElement?.blur(); })()`;

function launchChrome(args) {
  const child = spawn(chromePath(), ['--headless=new', '--hide-scrollbars', '--no-first-run', ...args], { stdio: 'ignore' });
  children.push(child);
  return child;
}

async function devtools(port) {
  for (let i = 0; i < 80; i++) {
    try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await pause(100); }
  }
  throw new Error('Chrome DevTools did not start');
}

function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const response = JSON.parse(data.toString());
    const handler = pending.get(response.id);
    if (!handler) return;
    pending.delete(response.id);
    if (response.error) handler.reject(new Error(JSON.stringify(response.error)));
    else handler.resolve(response.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, call }));
    ws.once('error', reject);
  });
}

/**
 * Chrome names its fake camera after the video file's path: show iPhone-like lenses instead. Only the
 * first is a real device; the others just fill the lens buttons and are never opened.
 */
const PHONE_DEVICES = `(() => {
  const original = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
  const fake = (kind, deviceId, label) => ({ kind, deviceId, label, groupId: 'demo', toJSON() { return this; } });
  navigator.mediaDevices.enumerateDevices = async () => {
    const devices = await original();
    const camera = devices.find((device) => device.kind === 'videoinput');
    const microphone = devices.find((device) => device.kind === 'audioinput');
    return [
      fake('videoinput', 'demo-ultra-wide', 'Back Ultra Wide Camera'),
      ...(camera ? [fake('videoinput', camera.deviceId, 'Back Camera')] : []),
      fake('videoinput', 'demo-telephoto', 'Back Telephoto Camera'),
      fake('videoinput', 'demo-front', 'Front Camera'),
      ...(microphone ? [fake('audioinput', microphone.deviceId, 'iPhone Microphone')] : []),
    ];
  };
})()`;

async function page(browser, port, url, width, height, mobile = false, init = '') {
  // Each page in its own window, so every one stays visible (hidden tabs pause decoding and capture).
  const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', newWindow: true });
  const { call } = await connect(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  if (mobile) await call('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36' });
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
  if (init) await call('Page.addScriptToEvaluateOnNewDocument', { source: init });
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  const waitFor = async (expression, label, timeout = 20000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await evaluate(expression)) return;
      await pause(200);
    }
    throw new Error(`Timed out waiting for ${label}`);
  };
  const screenshot = async (name) => {
    const image = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(join(out, `${name}.png`), Buffer.from(image.data, 'base64'));
    console.log(`docs/screenshots/${name}.png`);
  };
  const navigate = async (target) => {
    await call('Page.navigate', { url: target });
    await waitFor(`document.readyState === 'complete'`, `${target} to load`);
  };
  await navigate(url);
  return { call, evaluate, waitFor, screenshot, navigate };
}

/** A private IPv4 address of this PC, so the phone page connects like a Wi-Fi phone would. */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address)) return item.address;
    }
  }
  return 'localhost';
}

try {
  await mkdir(out, { recursive: true });

  // 1. The fake camera: the demo scene with a slow push-in and light grain, so it streams like real video.
  const scenePng = join(work, 'scene.png');
  const render = launchChrome(['--disable-gpu', '--window-size=1920,1080', `--screenshot=${scenePng}`, pathToFileURL(scene).href]);
  await new Promise((resolve) => render.once('exit', resolve));
  const video = join(work, 'camera.y4m');
  execFileSync(process.env.FFMPEG || 'ffmpeg', [
    '-loglevel', 'error', '-y', '-loop', '1', '-i', scenePng,
    '-vf', "scale=2112:1188,zoompan=z='1+0.0006*on':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,noise=alls=5:allf=t,format=yuv420p",
    '-frames:v', '90', video,
  ]);
  // …and a fake microphone with steady sound, so the level meter moves.
  const audio = join(work, 'mic.wav');
  execFileSync(process.env.FFMPEG || 'ffmpeg', [
    '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.25:duration=10', '-ar', '48000', '-ac', '1', audio,
  ]);

  // 2. A fresh server, so no earlier test data or real pairing key shows up.
  const port = 8743;
  const server = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, PORT: String(port), LENSPIPE_DATA_DIR: join(work, 'data'), LOG_LEVEL: 'warn' },
    stdio: 'ignore',
  });
  children.push(server);
  const host = lanAddress();
  const origin = `https://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${origin}/api/health`); break; } catch { await pause(150); }
  }
  const pairingKey = (await readFile(join(work, 'data', 'certs', 'pairing-token'), 'utf8')).trim();

  // 3. Chrome: one window per page.
  const debugPort = 9500 + (process.pid % 200);
  launchChrome([
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(work, 'chrome')}`,
    '--ignore-certificate-errors', '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, `--use-file-for-fake-audio-capture=${audio}`,
    '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    'about:blank',
  ]);
  const version = await devtools(debugPort);
  const browser = await connect(version.webSocketDebuggerUrl);

  // The phone: starts its camera and streams.
  const phone = await page(browser, debugPort, `https://${host}:${port}/sender#k=${pairingKey}`, 390, 844, true, PHONE_DEVICES);
  await phone.evaluate(`document.getElementById('start').click()`);
  await phone.waitFor(`document.getElementById('start-screen').classList.contains('hidden') && !/^0 /.test(document.getElementById('fps-live').textContent)`, 'the phone to stream');
  await phone.evaluate(`document.getElementById('mic').click()`);

  // OBS, so the studio shows it as connected.
  await page(browser, debugPort, `${origin}/obs`, 1280, 720);

  // Opened once the stream is steady, so start-up drops don't show in its counters.
  await pause(3000);
  const studio = await page(browser, debugPort, `${origin}/control`, 1440, 900, false, STUDIO_NETWORK);
  await studio.waitFor(`document.getElementById('connection-status').classList.contains('online') && Number(document.getElementById('metric-decoded').textContent) > 60`, 'the studio to decode');
  await studio.waitFor(`!document.getElementById('obs-status-pill').hidden`, 'OBS to report');
  await pause(3000);
  await studio.evaluate(`document.getElementById('health-dismiss')?.click()`);
  await studio.screenshot('control-desktop');

  await studio.evaluate(showDialog('settings-modal'));
  await pause(300);
  await studio.screenshot('control-settings');
  await studio.evaluate(`document.getElementById('settings-modal').close()`);

  // Connect dialog (demo network, see STUDIO_NETWORK).
  await studio.evaluate(showDialog('connection-modal'));
  await pause(1500);
  await studio.screenshot('control-connection');
  await studio.evaluate(`document.getElementById('connection-modal').close()`);

  // The phone: its settings sheet upright, then live held sideways (as it is mounted to film).
  await phone.evaluate(`document.getElementById('health-dismiss')?.click()`);
  await phone.evaluate(showDialog('settings-sheet'));
  await pause(400);
  await phone.screenshot('sender-settings');
  await phone.evaluate(`document.getElementById('settings-sheet').close()`);
  await phone.call('Emulation.setDeviceMetricsOverride', {
    width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 },
  });
  await pause(1500);
  await phone.evaluate(`document.getElementById('health-dismiss')?.click()`);
  await pause(300);
  await phone.screenshot('sender-live');
  console.log('README screenshots updated.');
} finally {
  for (const child of children) child.kill();
  await pause(500);
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
