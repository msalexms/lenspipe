import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { resolve, extname, sep } from 'node:path';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { ensureCertificate } from './certificates.js';
import { checkCertificateTrust, installCertificateTrust, type CertTrustInstallResult } from './cert-trust.js';
import { NetworkScanner } from './network.js';
import { resolveAppPaths } from './paths.js';
import { StreamRelay } from './relay.js';
import { isLocalRequest, loadPairingToken, PAIRING_REQUIRED_CLOSE_CODE, tokenMatches } from './pairing.js';

/**
 * Listens on `port`, or on the next free one (up to 10 tries) when it is busy. `skip` is a port this
 * server already uses on another interface.
 */
async function listenOnFreePort(app: FastifyInstance, port: number, host: string, skip?: number): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    if (port === skip) port++;
    try {
      await app.listen({ port, host });
      return port;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EADDRINUSE' && code !== 'EACCES') || attempt >= 9 || port >= 65535) throw error;
      port++;
    }
  }
}

/** The request's Origin is this server. A missing Origin passes unless `required` (non-browser clients send none). */
function isSameOrigin(request: FastifyRequest, required = false): boolean {
  const origin = request.headers.origin;
  if (!origin) return !required;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff',
};

/**
 * Largest accepted WebSocket message. A 4K60 keyframe at the top preset is a few MiB; the ws default
 * (100 MiB) would let a paired-but-malicious client make the relay allocate it in one message.
 */
const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_DIAGNOSTIC_REPORTS = 50;

/**
 * Defense in depth for pages served on the LAN: scripts, styles, fonts and connections stay
 * same-origin, no other site may frame the studio or the OBS view (OBS itself loads /obs as a
 * top-level browser source, not a frame), and responses are never sniffed into another content
 * type. `connect-src 'self'` covers the same-origin WebSocket (wss is the https scheme upgrade).
 * No page uses inline <style> or <script>: keep it that way, or the browser drops them silently.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

async function main(): Promise<void> {
  const paths = resolveAppPaths();
  const requestedPort = Number(process.env.PORT || 8443);
  let port = requestedPort;
  const dist = paths.distDir;
  const network = new NetworkScanner(port);
  network.start();
  const certificate = await ensureCertificate(network.snapshot, paths.certsDir);
  const certFilePath = resolve(certificate.directory, 'local-cert.pem');
  const pairingToken = await loadPairingToken(paths.certsDir);

  const relay = new StreamRelay(network);
  relay.start();

  let localHttpPort: number | null = null;
  let pendingCertTrust: Promise<CertTrustInstallResult> | null = null;

  async function serveBuiltFile(pathname: string, reply: FastifyReply) {
    const file = resolve(dist, pathname);
    if (file !== dist && !file.startsWith(dist + sep)) return reply.code(400).send();
    try {
      const info = await stat(file);
      if (!info.isFile()) return reply.code(404).send();
      const isHashedAsset = pathname.startsWith('assets/') || pathname.startsWith('/assets/');
      return reply.type(MIME[extname(file)] || 'application/octet-stream')
        .header('content-length', info.size)
        .header('cache-control', isHashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache')
        .send(createReadStream(file));
    } catch {
      return reply.code(404).send();
    }
  }

  const isLocal = (request: FastifyRequest) => isLocalRequest(request.socket.remoteAddress, request.headers);

  /**
   * This PC (see isLocalRequest), or a device presenting the pairing key: pages send it in `x-pairing-key`,
   * WebSockets (which cannot carry custom headers) in `?k=`.
   */
  function isPaired(request: FastifyRequest): boolean {
    return isLocal(request)
      || tokenMatches(request.headers['x-pairing-key'], pairingToken)
      || tokenMatches((request.query as Record<string, unknown>).k, pairingToken);
  }

  /**
   * Cross-site WebSocket hijacking guard. Browsers always send `Origin` on a WebSocket upgrade, so a page on
   * another site (open in any tab on this PC or the LAN) could otherwise connect to /ws/control, watch the
   * camera and turn the iPhone microphone on. Only pages served by this server are accepted; non-browser
   * clients (the test scripts) send no Origin and are unaffected.
   */
  const sameOriginOnly = async (request: FastifyRequest, reply: FastifyReply) => {
    if (isSameOrigin(request)) return;
    request.log.warn({ origin: request.headers.origin }, 'Rejected cross-origin WebSocket');
    return reply.code(403).send();
  };

  // `any`: the same routes serve the HTTPS app and the plain-HTTP loopback app, whose server types differ.
  async function registerRoutes(instance: FastifyInstance<any, any, any, any>, localOnly: boolean): Promise<void> {
    await instance.register(websocket, { options: { maxPayload: MAX_WS_PAYLOAD_BYTES } });

    if (localOnly) {
      // Loopback HTTP listener is strictly for local WebView / local OBS Studio (defeats DNS rebinding).
      instance.addHook('onRequest', async (request, reply) => {
        if (!isLocal(request)) return reply.code(403).send();
      });
    }

    instance.get('/', async (_request, reply) => reply.redirect('/control'));

    instance.addHook('onSend', async (_request, reply) => {
      reply.header('Content-Security-Policy', CSP);
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('X-Frame-Options', 'SAMEORIGIN');
    });

    for (const view of ['sender', 'control', 'obs', 'diag']) {
      instance.get(`/${view}`, async (_request, reply) => serveBuiltFile(`${view}.html`, reply));
    }
    instance.get('/*', async (request, reply) => serveBuiltFile((request.params as Record<string, string>)['*'] || '', reply));

    // Network details (interface names, addresses, firewall commands) are for paired devices only, and the
    // pairing key itself only for pages opened on this PC, which put it in the QR codes and the OBS URL.
    instance.get('/api/network', async (request, reply) => {
      if (!isPaired(request)) return reply.code(401).send();
      return isLocal(request)
        ? {
            ...network.snapshot,
            pairingToken,
            certPath: certFilePath,
            platform: process.platform,
            desktop: paths.desktop,
            httpPort: localHttpPort,
          }
        : network.snapshot;
    });

    // Other devices only learn that the server is up; ports and platform are for this PC.
    instance.get('/api/health', async (request) => (isLocal(request) ? {
      ok: true,
      port,
      httpPort: localHttpPort,
      desktop: paths.desktop,
      platform: process.platform,
    } : { ok: true }));

    instance.get('/api/obs/cert-trust', async (request, reply) => {
      if (!isLocal(request)) return reply.code(403).send();
      return checkCertificateTrust(certFilePath, certificate.cert);
    });

    instance.post('/api/obs/cert-trust', async (request, reply) => {
      // Installs a root certificate: only a page served here, on this PC, may ask (the custom header forces a CORS preflight).
      if (!isLocal(request) || !isSameOrigin(request, true) || request.headers['x-lenspipe-action'] !== 'trust-cert') {
        return reply.code(403).send();
      }
      if (!pendingCertTrust) {
        pendingCertTrust = installCertificateTrust(certFilePath, certificate.cert).finally(() => {
          pendingCertTrust = null;
        });
      }
      return pendingCertTrust;
    });

    /** Camera-format diagnostics from /diag on the iPhone, saved to diagnostics/ for troubleshooting. */
    instance.post('/api/diagnostics', { bodyLimit: 512 * 1024 }, async (request, reply) => {
      if (!isPaired(request)) return reply.code(401).send();
      if (!isSameOrigin(request)) return reply.code(403).send();
      const directory = paths.diagnosticsDir;
      await mkdir(directory, { recursive: true });
      // Bounded, so even a paired device cannot fill the disk with reports.
      if ((await readdir(directory)).length >= MAX_DIAGNOSTIC_REPORTS) return reply.code(429).send();
      const file = resolve(directory, `camera-formats-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      await writeFile(file, JSON.stringify(request.body, null, 2));
      console.log(`Camera diagnostics saved: ${file}`);
      return { saved: true };
    });

    const routes = [
      ['/ws/sender', 'sender', 'sender'],
      ['/ws/control', 'receiver', 'control'],
      ['/ws/obs', 'receiver', 'obs'],
    ] as const;
    for (const [path, role, label] of routes) {
      instance.get(path, { websocket: true, preValidation: sameOriginOnly, logLevel: 'warn' }, (socket, request) => {
        if (!isPaired(request)) {
          request.log.warn({ remoteAddress: request.socket.remoteAddress, path }, 'Rejected unpaired device');
          socket.close(PAIRING_REQUIRED_CLOSE_CODE, 'Pairing required');
          return;
        }
        relay.accept(socket, role, request.socket.remoteAddress, label);
      });
    }
  }

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL || 'info' },
    https: { key: certificate.key, cert: certificate.cert },
    // A local studio: page, asset and poll requests would only bury the useful messages.
    logController: new LogController({ disableRequestLogging: true }),
  });
  await registerRoutes(app, false);

  let httpApp: FastifyInstance | null = null;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    relay.stop();
    network.stop();
    await Promise.allSettled([app.close(), httpApp?.close()]);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (process.env.LENSPIPE_PARENT_WATCH === '1') {
    process.stdin.resume();
    process.stdin.once('end', () => { void shutdown(); });
    process.stdin.once('close', () => { void shutdown(); });
  }

  port = await listenOnFreePort(app, requestedPort, '0.0.0.0');
  network.setPort(port);

  if (paths.desktop || process.env.LENSPIPE_LOCAL_HTTP === '1') {
    const plainApp = Fastify({
      logger: { level: process.env.LOG_LEVEL || 'info' },
      logController: new LogController({ disableRequestLogging: true }),
    });
    await registerRoutes(plainApp, true);
    localHttpPort = await listenOnFreePort(plainApp, Number(process.env.LOCAL_HTTP_PORT || port + 1), '127.0.0.1', port);
    httpApp = plainApp;
  }

  console.log(`\n${certificate.generated ? 'Generated' : 'Using'} local TLS certificate: ${certificate.directory}`);
  if (port !== requestedPort) {
    console.log(`Port ${requestedPort} is busy; using port ${port} -> https://localhost:${port}/control`);
  }
  console.log(`Studio: https://localhost:${port}/control`);
  if (localHttpPort) console.log(`Desktop Studio (local HTTP): http://127.0.0.1:${localHttpPort}/control`);
  for (const endpoint of network.snapshot.usb) console.log(`USB sender: ${endpoint.url}/sender#k=${pairingToken} (${endpoint.name})`);
  for (const endpoint of network.snapshot.wifi) console.log(`Wi-Fi sender: ${endpoint.url}/sender#k=${pairingToken} (${endpoint.name})`);
  console.log('USB/Wi-Fi endpoints update automatically every 3 seconds.');
  if (paths.desktop) {
    const studioUrl = localHttpPort ? `http://127.0.0.1:${localHttpPort}/control` : `https://localhost:${port}/control`;
    const obsLocalUrl = localHttpPort ? `http://127.0.0.1:${localHttpPort}/obs` : `https://localhost:${port}/obs`;
    console.log(`LENSPIPE_READY ${JSON.stringify({
      url: studioUrl,
      obsUrl: obsLocalUrl,
      httpsUrl: `https://localhost:${port}/control`,
      port,
      httpPort: localHttpPort,
      dataDir: paths.dataDir,
    })}`);
  }

  const warnedFirewall = new Set<string>();
  const warnedLinkDown = new Set<string>();
  const reportFirewall = (snapshot: typeof network.snapshot) => {
    for (const endpoint of snapshot.usb) {
      if (!endpoint.linkDown) {
        if (warnedLinkDown.delete(endpoint.name)) console.log(`✓ The phone is answering again on "${endpoint.name}".`);
        continue;
      }
      if (warnedLinkDown.has(endpoint.name)) continue;
      warnedLinkDown.add(endpoint.name);
      console.warn(`\n⚠ "${endpoint.name}" is up but the phone does not answer (no ARP reply from its hotspot address).`);
      console.warn('  On iPhone: Settings → Personal Hotspot → toggle "Allow Others to Join" off/on, keep the screen open,');
      console.warn('  then unplug/replug the cable and tap "Trust" if asked.\n');
    }
    for (const endpoint of [...snapshot.usb, ...snapshot.wifi]) {
      if (!endpoint.firewallFix || warnedFirewall.has(endpoint.name)) continue;
      warnedFirewall.add(endpoint.name);
      console.warn(`\n⚠ "${endpoint.name}" (${endpoint.address}) is a Public network: Windows Firewall will block the phone.`);
      console.warn('  Run once in PowerShell as administrator:');
      console.warn(`  ${endpoint.firewallFix}\n`);
    }
  };
  network.on('change', reportFirewall);
  reportFirewall(network.snapshot);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
