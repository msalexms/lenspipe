import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { chromePath } from './chrome-path.mjs';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';

// `--docs` (npm run screenshots) refreshes the README images in docs/screenshots/; otherwise they are scratch files.
const docs = process.argv.includes('--docs');
const root = fileURLToPath(new URL(docs ? '../docs/screenshots/' : '../artifacts/ui/', import.meta.url));
const profile = fileURLToPath(new URL('../artifacts/chrome-profile/', import.meta.url));
await mkdir(root, { recursive: true });
await rm(profile, { recursive: true, force: true });
const port = 9300 + (process.pid % 200);
const origin = process.env.TEST_ORIGIN || 'https://localhost:8443';
const chrome = spawn(chromePath(), [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--ignore-certificate-errors', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let pages;
  for (let i = 0; i < 40; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; }
    catch { await pause(100); }
  }
  assert.ok(pages, 'Chrome DevTools endpoint should become available');
  ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const response = JSON.parse(data.toString());
    const handler = pending.get(response.id);
    if (handler) { pending.delete(response.id); response.error ? handler.reject(response.error) : handler.resolve(response.result); }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const viewport = async (width, height, mobile = false) => {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  };
  const navigate = async (path) => {
    await call('Page.navigate', { url: `${origin}${path}` });
    await pause(650);
    await evaluate(`document.getElementById('connection-modal')?.close()`);
  };
  const demoFrame = async (width, height) => {
    await evaluate(`(() => {
      const canvas = document.querySelector('canvas');
      canvas.width = ${width}; canvas.height = ${height};
      canvas.style.aspectRatio = '${width} / ${height}';
      canvas.style.width = ''; canvas.style.height = ''; // drop the size pinned by the receiver for the 300×150 default canvas
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#153e31'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#75f0b3'; ctx.lineWidth = Math.max(canvas.width, canvas.height) / 100;
      ctx.strokeRect(20, 20, canvas.width - 40, canvas.height - 40);
      ctx.beginPath(); ctx.arc(canvas.width / 2, canvas.height / 2, Math.min(canvas.width, canvas.height) * .22, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#e8f5ef'; ctx.textAlign = 'center'; ctx.font = Math.max(canvas.width, canvas.height) / 24 + 'px sans-serif';
      ctx.fillText('${width} × ${height}', canvas.width / 2, canvas.height / 2);
      document.getElementById('waiting')?.classList.add('hidden');
    })()`);
    const metrics = await evaluate(`(() => {
      const r = document.querySelector('canvas').getBoundingClientRect();
      return { width: r.width, height: r.height, ratio: r.width / r.height, viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth };
    })()`);
    assert.ok(Math.abs(metrics.ratio - width / height) < .002, `${width}×${height} canvas must preserve its aspect ratio: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.pageWidth <= metrics.viewportWidth + 1, `Layout must not overflow horizontally: ${JSON.stringify(metrics)}`);
    console.log(`${width}×${height}: displayed ${metrics.width.toFixed(1)}×${metrics.height.toFixed(1)} (${metrics.ratio.toFixed(4)})`);
    return metrics;
  };
  const screenshot = async (name) => {
    const image = await call('Page.captureScreenshot', { format: 'png' });
    await writeFile(`${root}${name}.png`, Buffer.from(image.data, 'base64'));
  };

  await call('Page.enable');
  await viewport(1440, 900);
  await navigate('/control');
  await demoFrame(1080, 1920);
  await demoFrame(1920, 1080);
  await screenshot('control-desktop');
  await evaluate(`(() => {
    const b = document.getElementById('health-banner'); b.hidden = false;
    document.getElementById('health-title').textContent = "⚠ Wi-Fi can't keep up with 120 Mbps";
    document.getElementById('health-detail').textContent = 'RTT 420 ms · 850 ms queued on the iPhone · 6 frames/s skipped. A USB cable carries far more.';
    document.getElementById('health-action').textContent = 'Lower to 50 Mbps';
  })()`);
  await pause(100);
  await screenshot('control-health');
  await evaluate(`document.getElementById('connection-modal').showModal()`);
  await pause(4000);
  // Never publish this PC's address or pairing key: show a demo endpoint in the QR card instead.
  const demoUrl = 'https://192.168.1.20:8443/sender#k=demo-pairing-key';
  const demoQr = await QRCode.toDataURL(demoUrl, { width: 260, margin: 1, color: { dark: '#1a1a18', light: '#ffffff' } });
  await evaluate(`(async () => {
    const image = new Image(); image.src = ${JSON.stringify(demoQr)}; await image.decode();
    for (const canvas of document.querySelectorAll('#connection-modal canvas')) canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const element of document.querySelectorAll('#connection-modal *')) {
      if (!element.children.length && element.textContent.startsWith('https://')) element.textContent = ${JSON.stringify(demoUrl)}.replace(/#.*/, '');
    }
  })()`);
  await screenshot('control-connection');
  await evaluate(`document.getElementById('connection-modal').close()`);
  await evaluate(`document.getElementById('settings-modal').showModal()`);
  await pause(100);
  const settingsMetrics = await evaluate(`(() => { const r = document.querySelector('#settings-modal').getBoundingClientRect(); return { width: r.width, height: r.height, viewportHeight: innerHeight }; })()`);
  assert.ok(settingsMetrics.height <= settingsMetrics.viewportHeight, `Settings dialog must fit the viewport: ${JSON.stringify(settingsMetrics)}`);
  await screenshot('control-settings');
  await evaluate(`document.getElementById('settings-modal').close()`);

  await navigate('/obs');
  await demoFrame(1080, 1920);
  await demoFrame(1920, 1080);

  await viewport(390, 844, true);
  await navigate('/control');
  await demoFrame(1920, 1080);
  await screenshot('control-mobile');

  await navigate('/sender');
  const senderMetrics = await evaluate(`({ viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth, startVisible: !!document.getElementById('start')?.getBoundingClientRect().height })`);
  assert.equal(senderMetrics.startVisible, true);
  assert.ok(senderMetrics.pageWidth <= senderMetrics.viewportWidth + 1);
  await screenshot('sender-mobile');
  await evaluate(`(() => {
    document.getElementById('start-screen').classList.add('hidden');
    document.getElementById('camera-preview').style.background = 'radial-gradient(circle at 50% 35%, #294b3d, #090c0b 70%)';
    const lenses = document.getElementById('lens-buttons');
    for (const [index, label] of ['0.5×', '1×', 'Tele', 'Front'].entries()) {
      const button = document.createElement('button'); button.textContent = label;
      if (index === 1) button.classList.add('active');
      lenses.append(button);
    }
  })()`);
  await evaluate(`(() => {
    const b = document.getElementById('health-banner'); b.hidden = false;
    document.getElementById('health-title').textContent = "⚠ Wi-Fi can't keep up with 120 Mbps";
    document.getElementById('health-detail').textContent = 'RTT 420 ms · 850 ms queued on the iPhone · 6 frames/s skipped. A USB cable carries far more.';
    document.getElementById('health-action').textContent = 'Lower to 50 Mbps';
  })()`);
  await screenshot('sender-controls-mobile');
  await evaluate(`document.getElementById('settings-sheet').showModal()`);
  await pause(250);
  await screenshot('sender-settings-mobile');
  await evaluate(`document.getElementById('settings-sheet').close()`);
  await viewport(844, 390, true);
  await pause(100);
  const landscapeMetrics = await evaluate(`({ viewportWidth: innerWidth, pageWidth: document.documentElement.scrollWidth })`);
  assert.ok(landscapeMetrics.pageWidth <= landscapeMetrics.viewportWidth + 1);
  await screenshot('sender-controls-landscape');
  console.log(`UI checks passed at 1440×900, 390×844, and 844×390; screenshots saved in ${docs ? 'docs/screenshots' : 'artifacts/ui'}/.`);
} finally {
  ws?.close();
  chrome.kill();
  await pause(250);
  await rm(profile, { recursive: true, force: true });
}
