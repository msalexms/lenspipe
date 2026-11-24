import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import selfsigned from 'selfsigned';
import { certFingerprints, checkCertificateTrust, installCertificateTrust, type ExecFn } from '../server/cert-trust.js';

const certA = selfsigned.generate([{ name: 'commonName', value: 'LensPipe Test A' }], {
  days: 1,
  keySize: 2048,
  algorithm: 'sha256',
}).cert;
const certB = selfsigned.generate([{ name: 'commonName', value: 'LensPipe Test B' }], {
  days: 1,
  keySize: 2048,
  algorithm: 'sha256',
}).cert;

const fpA = certFingerprints(certA);
assert.match(fpA.sha1, /^[0-9a-f]{40}$/, 'SHA-1 fingerprint must be 40 lowercase hex chars');
assert.match(fpA.sha256, /^[0-9a-f]{64}$/, 'SHA-256 fingerprint must be 64 lowercase hex chars');

const certPath = resolve('/tmp/LensPipe/certs/local-cert.pem');
const homeDir = resolve('/home/tester');

// Windows: user store hit short-circuits before machine store.
{
  const calls: Array<[string, string[]]> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, args]);
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  const status = await checkCertificateTrust(certPath, certA, { platform: 'win32', exec });
  assert.equal(status.trusted, true);
  assert.equal(status.supported, true);
  assert.deepEqual(calls, [['certutil', ['-user', '-verifystore', 'Root', fpA.sha1]]]);
}

// Windows: machine store fallback.
{
  const calls: Array<[string, string[]]> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, args]);
    return { exitCode: args[0] === '-user' ? 1 : 0, stdout: '', stderr: '' };
  };
  const status = await checkCertificateTrust(certPath, certA, { platform: 'win32', exec });
  assert.equal(status.trusted, true);
  assert.equal(calls.length, 2);
}

// Windows: install already trusted skips -addstore.
{
  const calls: Array<[string, string[]]> = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push([cmd, args]);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const res = await installCertificateTrust(certPath, certA, { platform: 'win32', exec });
  assert.equal(res.trusted, true);
  assert.equal(res.alreadyTrusted, true);
  assert.equal(calls.length, 1);
}

// Windows: install succeeds after user confirmation.
{
  let added = false;
  const exec: ExecFn = async (_cmd, args) => {
    if (args.includes('-addstore')) {
      added = true;
      return { exitCode: 0, stdout: 'Certificate added', stderr: '' };
    }
    return { exitCode: added ? 0 : 1, stdout: '', stderr: '' };
  };
  const res = await installCertificateTrust(certPath, certA, { platform: 'win32', exec });
  assert.equal(res.trusted, true);
  assert.equal(res.alreadyTrusted, undefined);
  assert.equal(res.supported, true);
}

// Windows: user cancels confirmation dialog (exit 1223).
{
  const exec: ExecFn = async (_cmd, args) => {
    if (args.includes('-addstore')) return { exitCode: 1223, stdout: '', stderr: 'The operation was canceled by the user.' };
    return { exitCode: 1, stdout: '', stderr: '' };
  };
  const res = await installCertificateTrust(certPath, certA, { platform: 'win32', exec });
  assert.equal(res.trusted, false);
  assert.equal(res.cancelled, true);
  assert.equal(res.supported, true);
}

// Windows: certutil missing (ENOENT).
{
  const exec: ExecFn = async () => ({ exitCode: 1, stdout: '', stderr: '', code: 'ENOENT' });
  const status = await checkCertificateTrust(certPath, certA, { platform: 'win32', exec });
  assert.equal(status.trusted, null);
  assert.equal(status.supported, false);
  const res = await installCertificateTrust(certPath, certA, { platform: 'win32', exec });
  assert.equal(res.trusted, false);
  assert.equal(res.supported, false);
}

// macOS: verify-cert ok/fail, safe argv passing to osascript, and cancel (-128).
{
  const statusOk = await checkCertificateTrust(certPath, certA, {
    platform: 'darwin',
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  });
  assert.equal(statusOk.trusted, true);

  let verified = false;
  let capturedArgs: string[] = [];
  const maliciousPath = "/tmp/bad'; touch /tmp/pwned; '/local-cert.pem";
  const res = await installCertificateTrust(maliciousPath, certA, {
    platform: 'darwin',
    exec: async (cmd, args) => {
      if (cmd === 'osascript') {
        capturedArgs = args;
        verified = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      return { exitCode: verified ? 0 : 1, stdout: '', stderr: '' };
    },
  });
  assert.equal(res.trusted, true);
  assert.equal(capturedArgs[capturedArgs.length - 1], maliciousPath, 'certPath must travel as separate osascript argv');
  assert.ok(!capturedArgs.slice(0, -1).join(' ').includes(maliciousPath), 'certPath must never be interpolated into AppleScript source');

  const cancelRes = await installCertificateTrust(certPath, certA, {
    platform: 'darwin',
    exec: async (cmd) => (cmd === 'osascript'
      ? { exitCode: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' }
      : { exitCode: 1, stdout: '', stderr: '' }),
  });
  assert.equal(cancelRes.trusted, false);
  assert.equal(cancelRes.cancelled, true);
}

// Linux: NSS fingerprint match, mismatch, DB init + import, and ENOENT.
{
  const match = await checkCertificateTrust(certPath, certA, {
    platform: 'linux',
    homeDir,
    exec: async () => ({ exitCode: 0, stdout: certA, stderr: '' }),
  });
  assert.equal(match.trusted, true);

  const mismatch = await checkCertificateTrust(certPath, certA, {
    platform: 'linux',
    homeDir,
    exec: async () => ({ exitCode: 0, stdout: certB, stderr: '' }),
  });
  assert.equal(mismatch.trusted, false);

  const calls: Array<[string, string[]]> = [];
  let installed = false;
  const installLinux = await installCertificateTrust(certPath, certA, {
    platform: 'linux',
    homeDir,
    exists: () => false,
    mkdirFn: (async () => undefined) as unknown as typeof import('node:fs/promises').mkdir,
    exec: async (cmd, args) => {
      calls.push([cmd, args]);
      if (args.includes('-A')) {
        installed = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (args.includes('-N')) return { exitCode: 0, stdout: '', stderr: '' };
      return { exitCode: installed ? 0 : 1, stdout: installed ? certA : '', stderr: '' };
    },
  });
  assert.equal(installLinux.trusted, true);
  assert.ok(calls.some(([, args]) => args.includes('-N') && args.includes('--empty-password')), 'should initialize NSS DB when cert9.db is absent');
  assert.ok(calls.some(([, args]) => args.includes('-A') && args.includes('C,,')), 'should import cert into NSS DB');

  const missingLinux = await installCertificateTrust(certPath, certA, {
    platform: 'linux',
    homeDir,
    exists: () => false,
    mkdirFn: (async () => undefined) as unknown as typeof import('node:fs/promises').mkdir,
    exec: async () => ({ exitCode: 1, stdout: '', stderr: '', code: 'ENOENT' }),
  });
  assert.equal(missingLinux.trusted, false);
  assert.equal(missingLinux.supported, false);
}

console.log('Cert-trust test passed: fingerprint checks, Windows/macOS/Linux trust verification, cancellation, ENOENT, and argv safety verified.');
