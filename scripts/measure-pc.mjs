// Opens the studio in a GPU-enabled headless Chrome on this PC and samples the receiver's
// arrival -> drawn latency for a few seconds. Read-only: it never clicks or sends commands.
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import WebSocket from 'ws';
import { chromePath } from './chrome-path.mjs';
import { fileURLToPath } from 'node:url';

const profile = fileURLToPath(new URL('../artifacts/chrome-measure/', import.meta.url));
const port = 9500 + (process.pid % 200);
const chrome = spawn(chromePath(), [
  '--headless=new', '--ignore-certificate-errors', '--no-first-run', '--autoplay-policy=no-user-gesture-required',
  '--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let pages;
  for (let i = 0; i < 50 && !pages; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { await pause(100); }
  }
  ws = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve) => ws.once('open', resolve));
  let id = 1; const pending = new Map();
  ws.on('message', (data) => { const r = JSON.parse(data); pending.get(r.id)?.(r.result); pending.delete(r.id); });
  const call = (method, params = {}) => new Promise((resolve) => { const n = id++; pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: (process.env.TEST_ORIGIN || 'https://localhost:8443') + '/control' });
  await pause(2000);
  const gpu = await evaluate(`(async () => {
    const support = await VideoDecoder.isConfigSupported({ codec: 'avc1.640034', codedWidth: 1920, codedHeight: 1080, hardwareAcceleration: 'prefer-hardware' });
    const c = document.createElement('canvas').getContext('webgl'); const ext = c && c.getExtension('WEBGL_debug_renderer_info');
    return { hwH264: support.supported, renderer: ext ? c.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown' };
  })()`);
  console.log('GPU', JSON.stringify(gpu));
  for (let i = 0; i < 12; i++) {
    await pause(1000);
    console.log(await evaluate(`document.getElementById('metric-fps').innerText.replace(/\\s+/g, ' ') + ' | ' + document.getElementById('metric-queue').innerText + ' | ' + document.getElementById('preview-resolution').innerText`));
  }
} finally {
  ws?.close(); chrome.kill(); await pause(400);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
process.exit(0);
