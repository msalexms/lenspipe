import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** WebSocket close code sent to a client that is not paired. Browsers can read it; HTTP statuses they cannot. */
export const PAIRING_REQUIRED_CLOSE_CODE = 4401;

/**
 * Pairing key that every device other than this PC must present to use the stream. It travels in the
 * QR code / OBS URL fragment, so anyone else on the same network cannot watch the camera or control
 * the iPhone. It is stored next to the certificate so URLs stay valid across restarts; delete
 * `certs/pairing-token` to revoke every paired device.
 */
export async function loadPairingToken(directory = resolve(process.cwd(), 'certs')): Promise<string> {
  const path = resolve(directory, 'pairing-token');
  try {
    const stored = (await readFile(path, 'utf8')).trim();
    if (/^[\w-]{22,}$/.test(stored)) return stored;
  } catch { /* first run */ }
  await mkdir(directory, { recursive: true });
  const token = randomBytes(18).toString('base64url');
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function normalize(address: string | undefined): string {
  return (address || '').replace(/^::ffff:/, '');
}

/** True when the request comes from this PC itself (loopback or any of its own interface addresses). */
export function isThisComputer(remoteAddress: string | undefined): boolean {
  const address = normalize(remoteAddress);
  if (!address) return false;
  if (address === '::1' || address.startsWith('127.')) return true;
  return Object.values(os.networkInterfaces()).some((list) => list?.some((info) => normalize(info.address) === address));
}

/** Hostname part of a Host header: `localhost:8443` -> `localhost`, `[::1]:8443` -> `::1`. */
function hostName(host: string | undefined): string {
  if (!host) return '';
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(host);
  if (bracketed) return bracketed[1].toLowerCase();
  return host.replace(/:\d+$/, '').toLowerCase();
}

/** Headers a reverse proxy or tunnel adds; a request carrying them did not come from a browser on this PC. */
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'x-original-host'];

/**
 * A request made on this PC itself, which is trusted without the pairing key. The source address alone is
 * not enough: a tunnel or port forwarder running on this PC (ngrok, VS Code / Dev Tunnels port forwarding,
 * Tailscale Funnel, `netsh portproxy`, a reverse proxy) relays outside requests from 127.0.0.1. Those keep
 * the public host name in `Host` or add forwarding headers, so both must also point at this PC.
 */
export function isLocalRequest(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): boolean {
  if (!isThisComputer(remoteAddress)) return false;
  if (PROXY_HEADERS.some((name) => headers[name] !== undefined)) return false;
  const host = hostName(typeof headers.host === 'string' ? headers.host : undefined);
  if (!host) return false;
  return host === 'localhost' || isThisComputer(host);
}

export function tokenMatches(candidate: unknown, token: string): boolean {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
