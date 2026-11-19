import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';

export type Transport = 'USB' | 'Wi-Fi' | 'Local' | 'Unknown';

export interface NetworkEndpoint {
  name: string;
  address: string;
  netmask?: string;
  transport: 'USB' | 'Wi-Fi';
  url: string;
  /** Windows network profile of the interface (Public/Private/DomainAuthenticated), when known. */
  networkCategory?: string;
  /**
   * Set when Windows Firewall will most likely block the phone: the interface is on the Public profile
   * and no "Camera Link" allow rule exists. Holds the PowerShell (admin) command that fixes it.
   */
  firewallFix?: string;
  /**
   * USB only: the adapter is up but the iPhone at the other end doesn't answer (ARP fails). Happens when
   * iOS stops serving Personal Hotspot over the cable while Windows still shows the link as connected.
   */
  linkDown?: boolean;
}

export interface NetworkSnapshot {
  usb: NetworkEndpoint[];
  wifi: NetworkEndpoint[];
  updatedAt: number;
}

const USB_PATTERN = /apple|iphone|ipad|usb|remote ndis|rndis/i;
const WIFI_NAME_PATTERN = /wi-?fi|wlan|wireless|airport/i;
const HOTSPOT_IP_PATTERN = /^172\.20\.1[01]\./;
const PRIVATE_PATTERNS = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
export const FIREWALL_RULE_NAME = 'Camera Link (local sender)';
const PROFILE_RECHECK_MS = 15_000;
const LINK_DOWN_RECHECK_MS = 5_000;
/** Reads network profiles, whether our firewall rule exists, and whether each USB gateway answers ARP. */
function profileQuery(gateways: string[]): string {
  const list = gateways.filter((ip) => /^[\d.]+$/.test(ip)).map((ip) => `'${ip}'`).join(',');
  return [
    '$p = @(Get-NetConnectionProfile | ForEach-Object { @{ alias = $_.InterfaceAlias; category = [string]$_.NetworkCategory } });',
    `$r = @(Get-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' }).Count -gt 0;`,
    // A ping forces an ARP resolution; the neighbor state then tells whether the iPhone is really there.
    `$n = @(foreach ($ip in @(${list})) { ping -n 1 -w 800 $ip | Out-Null; @{ ip = $ip; state = [string](Get-NetNeighbor -IPAddress $ip -ErrorAction SilentlyContinue | Select-Object -First 1).State } });`,
    '@{ profiles = $p; rule = $r; neighbors = $n } | ConvertTo-Json -Compress -Depth 3',
  ].join(' ');
}

/** First host of the subnet: the iPhone's own address on its hotspot network (172.20.10.1). */
function gatewayFor(address: string, netmask?: string): string {
  const cidr = subnetCidr(address, netmask).split('/')[0].split('.').map(Number);
  cidr[3] += 1;
  return cidr.join('.');
}

function isInet4(family: string | number): boolean {
  return family === 'IPv4' || family === 4;
}

export function ipv4Prefix(address: string): string {
  return address.split('.').slice(0, 3).join('.');
}

function ipToInt(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

export function ipv4InSubnet(remoteIp: string, endpointIp: string, netmask?: string): boolean {
  if (!netmask) return ipv4Prefix(remoteIp) === ipv4Prefix(endpointIp);
  const remoteInt = ipToInt(remoteIp);
  const endpointInt = ipToInt(endpointIp);
  const maskInt = ipToInt(netmask);
  if (remoteInt === null || endpointInt === null || maskInt === null) {
    return ipv4Prefix(remoteIp) === ipv4Prefix(endpointIp);
  }
  return ((remoteInt & maskInt) >>> 0) === ((endpointInt & maskInt) >>> 0);
}

/** `172.20.10.13` + `255.255.255.240` -> `172.20.10.0/28`. */
export function subnetCidr(address: string, netmask?: string): string {
  const addressInt = ipToInt(address);
  const maskInt = netmask ? ipToInt(netmask) : null;
  if (addressInt === null || maskInt === null) return `${ipv4Prefix(address)}.0/24`;
  const network = (addressInt & maskInt) >>> 0;
  const bits = maskInt.toString(2).replace(/0/g, '').length;
  return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join('.')}/${bits}`;
}

export class NetworkScanner extends EventEmitter {
  private current: NetworkSnapshot = { usb: [], wifi: [], updatedAt: Date.now() };
  private timer?: NodeJS.Timeout;
  private profiles = new Map<string, string>();
  private hasFirewallRule = false;
  private profileCheckedAt = 0;
  private checkingProfiles = false;
  private knownInterfaces = '';
  private unreachableGateways = new Set<string>();
  /** While a sender is streaming the firewall/link probes aren't needed; don't spend CPU on them. */
  private senderConnected = false;

  constructor(private port: number, private readonly pollMs = 3000) {
    super();
  }

  setSenderConnected(connected: boolean): void {
    if (this.senderConnected === connected) return;
    this.senderConnected = connected;
    // Once a sender is connected the USB link and firewall are evidently fine.
    if (connected && this.unreachableGateways.size) {
      this.unreachableGateways.clear();
      this.scan();
    }
  }

  setPort(port: number): void {
    if (this.port === port) return;
    this.port = port;
    this.scan();
  }

  get snapshot(): NetworkSnapshot {
    return this.current;
  }

  start(): NetworkSnapshot {
    this.scan();
    this.timer = setInterval(() => this.scan(), this.pollMs);
    this.timer.unref();
    return this.current;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  scan(): NetworkSnapshot {
    const usb: NetworkEndpoint[] = [];
    const wifi: NetworkEndpoint[] = [];
    const seen = new Set<string>();

    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const info of addresses ?? []) {
        if (!isInet4(info.family) || info.internal || !info.address) continue;
        const isUsbName = USB_PATTERN.test(name);
        const isHotspotAddress = HOTSPOT_IP_PATTERN.test(info.address);
        const isUsb = isUsbName || (isHotspotAddress && !WIFI_NAME_PATTERN.test(name));
        const isUsbLinkLocal = isUsbName && /^169\.254\./.test(info.address);
        const isPrivate = PRIVATE_PATTERNS.some((pattern) => pattern.test(info.address));
        if (!isUsb && !isPrivate && !isUsbLinkLocal) continue;
        const transport = isUsb || isUsbLinkLocal ? 'USB' : 'Wi-Fi';
        const key = `${transport}:${info.address}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const endpoint: NetworkEndpoint = {
          name,
          address: info.address,
          netmask: info.netmask || undefined,
          transport,
          url: `https://${info.address}:${this.port}`,
        };
        const category = this.profiles.get(name);
        if (category) endpoint.networkCategory = category;
        if (transport === 'USB' && this.unreachableGateways.has(gatewayFor(info.address, info.netmask))) endpoint.linkDown = true;
        if (category === 'Public' && !this.hasFirewallRule) {
          endpoint.firewallFix = `New-NetFirewallRule -DisplayName '${FIREWALL_RULE_NAME}' -Direction Inbound -Action Allow `
            + `-Protocol TCP -LocalPort ${this.port} -RemoteAddress ${subnetCidr(info.address, info.netmask)} -Profile Public`;
        }
        (transport === 'USB' ? usb : wifi).push(endpoint);
      }
    }

    const interfaces = [...usb, ...wifi].map((endpoint) => endpoint.name).sort().join('|');
    this.refreshProfiles(interfaces !== this.knownInterfaces, usb);
    this.knownInterfaces = interfaces;

    const previous = JSON.stringify({ usb: this.current.usb, wifi: this.current.wifi });
    const next = JSON.stringify({ usb, wifi });
    this.current = { usb, wifi, updatedAt: Date.now() };
    if (previous !== next) this.emit('change', this.current);
    return this.current;
  }

  /**
   * Windows only: reads each interface's network profile. A new iPhone USB network usually lands on the
   * Public profile, where the firewall rule created by the "allow Node.js" prompt (Private only) does not apply.
   */
  private refreshProfiles(force: boolean, usb: NetworkEndpoint[]): void {
    if (process.platform !== 'win32' || this.checkingProfiles) return;
    if (this.senderConnected && !force) return;
    const interval = this.unreachableGateways.size ? LINK_DOWN_RECHECK_MS : PROFILE_RECHECK_MS;
    if (!force && Date.now() - this.profileCheckedAt < interval) return;
    this.checkingProfiles = true;
    const gateways = usb.filter((endpoint) => !/^169\.254\./.test(endpoint.address))
      .map((endpoint) => gatewayFor(endpoint.address, endpoint.netmask));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', profileQuery(gateways)], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      this.checkingProfiles = false;
      this.profileCheckedAt = Date.now();
      if (error) return;
      try {
        type Entry<T> = T | T[] | undefined;
        const asList = <T>(value: Entry<T>): T[] => (Array.isArray(value) ? value : value ? [value] : []);
        const result = JSON.parse(stdout) as {
          profiles?: Entry<{ alias: string; category: string }>;
          rule?: boolean;
          neighbors?: Entry<{ ip: string; state: string }>;
        };
        const next = new Map(asList(result.profiles).map((entry) => [entry.alias, entry.category]));
        const unreachable = new Set(asList(result.neighbors)
          .filter((entry) => entry.state === 'Incomplete' || entry.state === 'Unreachable' || !entry.state)
          .map((entry) => entry.ip));
        const changed = JSON.stringify([...next]) !== JSON.stringify([...this.profiles])
          || Boolean(result.rule) !== this.hasFirewallRule
          || [...unreachable].sort().join() !== [...this.unreachableGateways].sort().join();
        this.profiles = next;
        this.hasFirewallRule = Boolean(result.rule);
        this.unreachableGateways = unreachable;
        if (changed) this.scan();
      } catch {
        // Unexpected output: keep the previous state, the next poll retries.
      }
    });
  }

  classifyRemoteAddress(rawAddress?: string): Transport {
    const address = rawAddress?.replace(/^::ffff:/, '');
    if (!address) return 'Unknown';
    if (address === '127.0.0.1' || address === '::1') return 'Local';
    if (this.current.usb.some((endpoint) => ipv4InSubnet(address, endpoint.address, endpoint.netmask))) return 'USB';
    if (this.current.wifi.some((endpoint) => ipv4InSubnet(address, endpoint.address, endpoint.netmask))) return 'Wi-Fi';
    if (HOTSPOT_IP_PATTERN.test(address)) return 'USB';
    if (PRIVATE_PATTERNS.some((pattern) => pattern.test(address))) return 'Wi-Fi';
    return 'Unknown';
  }
}
