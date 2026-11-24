import { X509Certificate } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  code?: string;
}

export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

export interface CertTrustStatus {
  trusted: boolean | null;
  supported: boolean;
  platform: string;
  fingerprint: string;
  certPath: string;
}

export interface CertTrustInstallResult {
  trusted: boolean;
  alreadyTrusted?: boolean;
  cancelled?: boolean;
  supported: boolean;
  message: string;
}

export interface CertTrustOptions {
  platform?: string;
  homeDir?: string;
  exec?: ExecFn;
  exists?: (path: string) => boolean;
  mkdirFn?: typeof mkdir;
}

/** Runs an OS certificate tool directly without a shell so user confirmation prompts remain visible. */
function execFileSafe(command: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { windowsHide: false, timeout: 60000 }, (error, stdout, stderr) => {
      const out = String(stdout ?? '');
      const errOut = String(stderr ?? '');
      if (!error) {
        resolvePromise({ exitCode: 0, stdout: out, stderr: errOut });
        return;
      }
      const err = error as NodeJS.ErrnoException & { code?: string | number };
      const stringCode = typeof err.code === 'string' ? err.code : undefined;
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      resolvePromise({ exitCode, stdout: out, stderr: errOut, code: stringCode });
    });
  });
}

export function certFingerprints(pem: string): { sha1: string; sha256: string } {
  const cert = new X509Certificate(pem);
  return {
    sha1: cert.fingerprint.replace(/:/g, '').toLowerCase(),
    sha256: cert.fingerprint256.replace(/:/g, '').toLowerCase(),
  };
}

const nssDb = (homeDir: string) => resolve(homeDir, '.pki', 'nssdb');

export async function checkCertificateTrust(
  certPath: string,
  certPem: string,
  options: CertTrustOptions = {},
): Promise<CertTrustStatus> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const exec = options.exec ?? execFileSafe;
  const { sha1 } = certFingerprints(certPem);
  const status = (trusted: boolean | null, supported = true): CertTrustStatus =>
    ({ trusted, supported, platform, fingerprint: sha1, certPath });
  const unsupported = status(null, false);

  if (platform === 'win32') {
    const userStore = await exec('certutil', ['-user', '-verifystore', 'Root', sha1]);
    if (userStore.exitCode === 0) return status(true);
    if (userStore.code === 'ENOENT') return unsupported;
    const machineStore = await exec('certutil', ['-verifystore', 'Root', sha1]);
    return status(machineStore.exitCode === 0);
  }

  if (platform === 'darwin') {
    const res = await exec('security', ['verify-cert', '-c', certPath]);
    return res.code === 'ENOENT' ? unsupported : status(res.exitCode === 0);
  }

  if (platform === 'linux') {
    const res = await exec('certutil', ['-d', `sql:${nssDb(homeDir)}`, '-L', '-n', 'LensPipe', '-a']);
    if (res.code === 'ENOENT') return unsupported;
    let trusted = false;
    if (res.exitCode === 0 && res.stdout.includes('BEGIN CERTIFICATE')) {
      try {
        trusted = certFingerprints(res.stdout).sha1 === sha1;
      } catch {
        trusted = false;
      }
    }
    return status(trusted);
  }

  return unsupported;
}

const MANUAL = 'Could not install certificate automatically. Use the manual command below.';
const NO_NSS_TOOLS = 'certutil (libnss3-tools / nss-tools) is unavailable; run the manual command below.';

export async function installCertificateTrust(
  certPath: string,
  certPem: string,
  options: CertTrustOptions = {},
): Promise<CertTrustInstallResult> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const exec = options.exec ?? execFileSafe;
  const exists = options.exists ?? existsSync;
  const mkdirFn = options.mkdirFn ?? mkdir;

  const unsupported = (message: string): CertTrustInstallResult => ({ trusted: false, supported: false, message });
  const cancelled = (message: string): CertTrustInstallResult => ({ trusted: false, cancelled: true, supported: true, message });
  /** After the OS tool ran: trusted now, or the manual fallback. */
  const verify = async (): Promise<CertTrustInstallResult> => (
    (await checkCertificateTrust(certPath, certPem, options)).trusted === true
      ? { trusted: true, supported: true, message: 'Certificate trusted. Restart OBS Studio if it is open.' }
      : { trusted: false, supported: true, message: MANUAL }
  );

  const status = await checkCertificateTrust(certPath, certPem, options);
  if (status.trusted === true) {
    return { trusted: true, alreadyTrusted: true, supported: true, message: 'Certificate is already trusted on this PC.' };
  }

  if (platform === 'win32') {
    const res = await exec('certutil', ['-user', '-addstore', 'Root', certPath]);
    if (res.code === 'ENOENT') return unsupported('certutil is unavailable; run the PowerShell command below.');
    const result = await verify();
    if (!result.trusted && (res.exitCode === 1223 || /cancel|0x800704c7|ERROR_CANCELLED/i.test(`${res.stderr}\n${res.stdout}`))) {
      return cancelled('Certificate confirmation was cancelled.');
    }
    return result;
  }

  if (platform === 'darwin') {
    const res = await exec('osascript', [
      '-e', 'on run argv',
      '-e', 'do shell script "security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain " & quoted form of (item 1 of argv) with administrator privileges',
      '-e', 'end run',
      certPath,
    ]);
    if (res.code === 'ENOENT') return unsupported('osascript is unavailable; run the Terminal command below.');
    if (/cancel|-128/i.test(`${res.stderr}\n${res.stdout}`)) return cancelled('Administrator prompt was cancelled.');
    return verify();
  }

  if (platform === 'linux') {
    const nssdb = nssDb(homeDir);
    await mkdirFn(nssdb, { recursive: true });
    if (!exists(resolve(nssdb, 'cert9.db'))) {
      const initRes = await exec('certutil', ['-d', `sql:${nssdb}`, '-N', '--empty-password']);
      if (initRes.code === 'ENOENT') return unsupported(NO_NSS_TOOLS);
    }
    const addRes = await exec('certutil', ['-d', `sql:${nssdb}`, '-A', '-t', 'C,,', '-n', 'LensPipe', '-i', certPath]);
    if (addRes.code === 'ENOENT') return unsupported(NO_NSS_TOOLS);
    return verify();
  }

  return unsupported('Automatic certificate trust is not supported on this OS.');
}
