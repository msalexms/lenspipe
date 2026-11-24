import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  let binary = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--binary' && argv[i + 1]) binary = argv[i + 1];
    else if (argv[i].startsWith('--binary=')) binary = argv[i].slice('--binary='.length);
  }
  return { binary };
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('Timed out waiting for LENSPIPE_READY')), 15000);
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/^LENSPIPE_READY (.+)$/m);
      if (match) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolvePromise(JSON.parse(match[1]));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Desktop server exited prematurely with code ${code}`));
    });
  });
}

function rawHttpGet(port, hostHeader, path = '/api/health') {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Host: hostHeader },
    }, (res) => {
      res.resume();
      res.once('end', () => resolvePromise(res.statusCode));
    });
    req.once('error', rejectPromise);
    req.end();
  });
}

const { binary } = parseArgs(process.argv.slice(2));
const tempDataDir = await mkdtemp(resolve(tmpdir(), 'lenspipe-desktop-test-'));
const distDir = resolve(root, 'dist');
const httpsPort = 18453;
const httpPort = 18454;

const command = binary ? resolve(root, binary) : process.execPath;
const args = binary ? [] : [resolve(root, 'dist-server', 'index.js')];

const child = spawn(command, args, {
  env: {
    ...process.env,
    LENSPIPE_DESKTOP: '1',
    LENSPIPE_LOCAL_HTTP: '1',
    LENSPIPE_PARENT_WATCH: '1',
    LENSPIPE_DATA_DIR: tempDataDir,
    LENSPIPE_DIST_DIR: distDir,
    PORT: String(httpsPort),
    LOCAL_HTTP_PORT: String(httpPort),
    LOG_LEVEL: 'warn',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

try {
  const ready = await waitForReady(child);
  assert.equal(ready.url, `http://127.0.0.1:${httpPort}/control`);
  assert.equal(ready.obsUrl, `http://127.0.0.1:${httpPort}/obs`);
  assert.equal(ready.port, httpsPort);
  assert.equal(ready.httpPort, httpPort);
  assert.equal(ready.dataDir, tempDataDir);
  assert.ok(existsSync(resolve(tempDataDir, 'certs', 'local-cert.pem')), 'Certs should be written under LENSPIPE_DATA_DIR');

  for (const path of ['/control', '/obs', '/api/health', '/api/obs/cert-trust']) {
    const res = await fetch(`http://127.0.0.1:${httpPort}${path}`);
    assert.equal(res.status, 200, `Loopback HTTP ${path} should return 200`);
    if (path === '/api/health') {
      const health = await res.json();
      assert.equal(health.ok, true);
      assert.equal(health.httpPort, httpPort);
      assert.equal(health.desktop, true);
    }
  }

  // DNS rebinding guard: non-local Host header must be rejected with 403 on loopback HTTP.
  const evilStatus = await rawHttpGet(httpPort, `evil.example:${httpPort}`);
  assert.equal(evilStatus, 403, 'Loopback HTTP must reject non-local Host header');

  // Cross-transport relay: phone sender on HTTPS -> local OBS receiver on loopback HTTP.
  const sender = new WebSocket(`wss://localhost:${httpsPort}/ws/sender`, { rejectUnauthorized: false });
  const obs = new WebSocket(`ws://127.0.0.1:${httpPort}/ws/obs`);
  await Promise.all([
    new Promise((res, rej) => { sender.once('open', res); sender.once('error', rej); }),
    new Promise((res, rej) => { obs.once('open', res); obs.once('error', rej); }),
  ]);

  const videoConfig = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from(JSON.stringify({ decoderConfig: { codec: 'avc1.640032', codedWidth: 1920, codedHeight: 1080 } })),
  ]);
  const receivedConfig = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('Timed out waiting for relayed videoConfig over HTTP')), 4000);
    obs.on('message', (data) => {
      const buf = Buffer.from(data);
      if (buf[0] === 0x01) {
        clearTimeout(timer);
        resolvePromise(buf);
      }
    });
  });
  sender.send(videoConfig);
  const relayed = await receivedConfig;
  assert.deepEqual(relayed, videoConfig, 'HTTPS sender packet must relay verbatim to loopback HTTP OBS receiver');
  sender.close();
  obs.close();

  // Parent-exit watchdog: closing stdin must trigger clean shutdown (exit 0 within 5 s).
  const exited = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error('Server did not exit cleanly when stdin closed')), 5000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });
  child.stdin.end();
  const exitCode = await exited;
  assert.equal(exitCode, 0, `Server should exit cleanly with 0 on parent stdin close, got ${exitCode}`);

  console.log(`Desktop server check passed (${binary ? 'SEA binary' : 'node dist-server'}): LENSPIPE_READY, loopback HTTP, DNS-rebinding 403, HTTPS->HTTP relay, and stdin watchdog OK.`);
} finally {
  if (child.exitCode === null) child.kill();
  await new Promise((r) => setTimeout(r, 300));
  await rm(tempDataDir, { recursive: true, force: true });
}
