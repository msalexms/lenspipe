import assert from 'node:assert/strict';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isLocalRequest, isThisComputer, loadPairingToken, tokenMatches } from '../server/pairing';

const dir = await mkdtemp(join(os.tmpdir(), 'pairing-'));
try {
  const token = await loadPairingToken(dir);
  assert.match(token, /^[\w-]{24}$/, 'token is 18 random bytes in base64url');
  assert.equal(await loadPairingToken(dir), token, 'token persists across restarts');
  assert.equal((await readFile(join(dir, 'pairing-token'), 'utf8')).trim(), token);

  assert.ok(tokenMatches(token, token));
  assert.ok(!tokenMatches(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), token), 'one wrong character');
  assert.ok(!tokenMatches(token.slice(1), token), 'shorter key');
  assert.ok(!tokenMatches(undefined, token) && !tokenMatches(['x'], token), 'missing or repeated ?k=');

  assert.ok(isThisComputer('127.0.0.1') && isThisComputer('::1') && isThisComputer('::ffff:127.0.0.1'), 'loopback');
  const own = Object.values(os.networkInterfaces()).flat().find((info) => info && info.family === 'IPv4' && !info.internal);
  if (own) assert.ok(isThisComputer(own.address), 'this PC\'s own LAN address (OBS using the LAN URL)');
  assert.ok(!isThisComputer('203.0.113.9') && !isThisComputer(undefined), 'other devices');
  // Local requests: from this PC *and* addressed to it, with no proxy headers.
  assert.ok(isLocalRequest('127.0.0.1', { host: 'localhost:8443' }), 'studio at https://localhost');
  assert.ok(isLocalRequest('::1', { host: '[::1]:8443' }), 'IPv6 loopback');
  if (own) assert.ok(isLocalRequest(own.address, { host: `${own.address}:8443` }), 'OBS on this PC via the LAN URL');
  // A tunnel or port forwarder on this PC relays outside requests from 127.0.0.1: they must not be trusted.
  assert.ok(!isLocalRequest('127.0.0.1', { host: 'abc123.ngrok-free.app' }), 'tunnel keeps its public host name');
  assert.ok(!isLocalRequest('127.0.0.1', { host: 'localhost:8443', 'x-forwarded-for': '198.51.100.7' }), 'proxy headers');
  assert.ok(!isLocalRequest('127.0.0.1', { host: 'localhost:8443', forwarded: 'for=198.51.100.7' }), 'RFC 7239 Forwarded');
  assert.ok(!isLocalRequest('127.0.0.1', {}), 'no Host header');
  assert.ok(!isLocalRequest('203.0.113.9', { host: 'localhost:8443' }), 'another device cannot claim localhost');
  console.log('Pairing test passed: persistent key, constant-time match, and only requests made on this PC (not relayed by a tunnel) skip the key.');
} finally {
  await rm(dir, { recursive: true, force: true });
}
