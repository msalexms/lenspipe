import { execFileSync, spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { chromePath } from './chrome-path.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactsDir = resolve(root, 'artifacts');
const iconPng = resolve(artifactsDir, 'icon-1024.png');
const iconsOut = resolve(root, 'src-tauri', 'icons');
const profile = resolve(artifactsDir, 'chrome-icon-profile');

await mkdir(artifactsDir, { recursive: true });
await mkdir(iconsOut, { recursive: true });
await rm(profile, { recursive: true, force: true });

const svgHtml = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; width: 1024px; height: 1024px; background: transparent; overflow: hidden; }
  svg { display: block; width: 1024px; height: 1024px; }
</style>
</head>
<body>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="48" y="48" width="928" height="928" rx="208" fill="#FFF6E9" stroke="#1E1B2E" stroke-width="36"/>
  <g transform="translate(152 156) scale(10)">
    <g transform="translate(2.8 2.8)" fill="#1E1B2E" stroke="#1E1B2E" stroke-width="3.2" stroke-linejoin="round">
      <path d="M16 5l11 10h18L56 5l5 15v13H11V20z"/>
      <rect x="7" y="25" width="58" height="39" rx="10"/>
      <rect x="4" y="42" width="8" height="12" rx="4"/>
      <rect x="60" y="42" width="8" height="12" rx="4"/>
    </g>
    <path d="M16 5l11 10h18L56 5l5 15v13H11V20z" fill="#2B36D9" stroke="#1E1B2E" stroke-width="3.2" stroke-linejoin="round"/>
    <circle cx="24" cy="21" r="2.7" fill="#FFFFFF"/>
    <circle cx="48" cy="21" r="2.7" fill="#FFFFFF"/>
    <rect x="7" y="25" width="58" height="39" rx="10" fill="#7CC4FF" stroke="#1E1B2E" stroke-width="3.2" stroke-linejoin="round"/>
    <rect x="13" y="31" width="11" height="5" rx="2.5" fill="#FFE27A" stroke="#1E1B2E" stroke-width="2.2"/>
    <circle cx="56" cy="34" r="3.6" fill="#FF5C39" stroke="#1E1B2E" stroke-width="2.2"/>
    <circle cx="36" cy="45" r="13.5" fill="#FFFFFF" stroke="#1E1B2E" stroke-width="3.2"/>
    <circle cx="36" cy="45" r="7.5" fill="#1E1B2E"/>
    <circle cx="33" cy="42" r="2.5" fill="#FFFFFF"/>
    <rect x="4" y="42" width="8" height="12" rx="4" fill="#2B36D9" stroke="#1E1B2E" stroke-width="2.8"/>
    <rect x="60" y="42" width="8" height="12" rx="4" fill="#2B36D9" stroke="#1E1B2E" stroke-width="2.8"/>
  </g>
</svg>
</body>
</html>`;

const port = 9400 + (process.pid % 200);
const chrome = spawn(chromePath(), [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
try {
  let pages;
  for (let i = 0; i < 40; i++) {
    try { pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; }
    catch { await pause(100); }
  }
  if (!pages) throw new Error('Chrome DevTools endpoint failed to start');
  ws = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const response = JSON.parse(data.toString());
    const handler = pending.get(response.id);
    if (handler) {
      pending.delete(response.id);
      response.error ? handler.reject(response.error) : handler.resolve(response.result);
    }
  });
  const call = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { resolve: res, reject: rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1024, height: 1024, deviceScaleFactor: 1, mobile: false });
  await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  const frameTree = await call('Page.getFrameTree');
  await call('Page.setDocumentContent', { frameId: frameTree.frameTree.frame.id, html: svgHtml });
  await pause(200);
  const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await writeFile(iconPng, Buffer.from(shot.data, 'base64'));
} finally {
  ws?.close();
  chrome.kill();
  await pause(300);
  await rm(profile, { recursive: true, force: true });
}

const tauriCli = resolve(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
execFileSync(process.execPath, [tauriCli, 'icon', iconPng, '--output', iconsOut], { stdio: 'inherit' });
await rm(resolve(iconsOut, 'android'), { recursive: true, force: true });
await rm(resolve(iconsOut, 'ios'), { recursive: true, force: true });
console.log(`Generated Tauri desktop icons in ${iconsOut}`);
