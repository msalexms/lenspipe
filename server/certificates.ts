import selfsigned from 'selfsigned';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NetworkSnapshot } from './network.js';

export interface CertificateFiles {
  key: string;
  cert: string;
  directory: string;
  generated: boolean;
}

const USB_HOTSPOT_SAN_IPS = Array.from({ length: 14 }, (_, index) => `172.20.10.${index + 1}`);
/** Bump when the certificate's shape changes, so existing installs regenerate it. */
const CERT_PROFILE = 2;

/**
 * The certificate is a CA (iOS only offers full trust for CA certificates), and users install it as a
 * trusted root. Name constraints limit what it can ever vouch for to `localhost` and private IPv4 ranges,
 * so even a leaked `local-key.pem` cannot be used to impersonate a public website.
 */
const PERMITTED_IP_RANGES: Array<[string, string]> = [
  ['127.0.0.0', '255.0.0.0'], ['10.0.0.0', '255.0.0.0'], ['172.16.0.0', '255.240.0.0'], ['192.168.0.0', '255.255.0.0'],
];

function der(tag: number, content: Buffer): Buffer {
  if (content.length > 0xffff) throw new Error('DER value too long');
  const length = content.length < 0x80 ? Buffer.from([content.length])
    : content.length < 0x100 ? Buffer.from([0x81, content.length])
      : Buffer.from([0x82, content.length >> 8, content.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

function nameConstraintsDer(): string {
  const ipBytes = (ip: string) => Buffer.from(ip.split('.').map(Number));
  const subtrees = [
    der(0x30, der(0x82, Buffer.from('localhost', 'ascii'))), // dNSName [2]
    ...PERMITTED_IP_RANGES.map(([ip, mask]) => der(0x30, der(0x87, Buffer.concat([ipBytes(ip), ipBytes(mask)])))), // iPAddress [7]
  ];
  // NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees }
  return der(0x30, der(0xa0, Buffer.concat(subtrees))).toString('binary');
}

async function readStoredSans(sansPath: string): Promise<Set<string> | null> {
  if (!existsSync(sansPath)) return null;
  try {
    const parsed = JSON.parse(await readFile(sansPath, 'utf8'));
    // Older installs stored a bare array: their certificate predates the name constraints.
    if (!parsed || parsed.profile !== CERT_PROFILE || !Array.isArray(parsed.addresses)) return null;
    return new Set(parsed.addresses.filter((item: unknown): item is string => typeof item === 'string'));
  } catch {
    return null;
  }
}

export async function ensureCertificate(network: NetworkSnapshot): Promise<CertificateFiles> {
  const directory = resolve(process.cwd(), 'certs');
  const keyPath = resolve(directory, 'local-key.pem');
  const certPath = resolve(directory, 'local-cert.pem');
  const sansPath = resolve(directory, 'local-sans.json');
  await mkdir(directory, { recursive: true });

  const activeAddresses = [...network.usb, ...network.wifi].map((endpoint) => endpoint.address);
  const uniqueAddresses = [...new Set(['127.0.0.1', ...USB_HOTSPOT_SAN_IPS, ...activeAddresses])].sort();
  const storedSans = existsSync(keyPath) && existsSync(certPath) ? await readStoredSans(sansPath) : null;
  const needsRegeneration = !storedSans || uniqueAddresses.some((ip) => !storedSans.has(ip));

  if (needsRegeneration) {
    const altNames = [
      { type: 2, value: 'localhost' },
      ...uniqueAddresses.map((ip) => ({ type: 7 as const, ip })),
    ];
    const pems = selfsigned.generate([{ name: 'commonName', value: 'LensPipe' }], {
      days: 825,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
        { id: '2.5.29.30', critical: true, value: nameConstraintsDer() },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true, cRLSign: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames },
      ],
    });
    await Promise.all([
      writeFile(keyPath, pems.private, { mode: 0o600 }),
      writeFile(certPath, pems.cert),
      writeFile(sansPath, JSON.stringify({ profile: CERT_PROFILE, addresses: uniqueAddresses }, null, 2)),
    ]);
    return { key: pems.private, cert: pems.cert, directory, generated: true };
  }

  const [key, cert] = await Promise.all([readFile(keyPath, 'utf8'), readFile(certPath, 'utf8')]);
  return { key, cert, directory, generated: false };
}
