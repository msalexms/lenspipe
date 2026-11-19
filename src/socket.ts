import { encodeControl, type ControlMessage } from './protocol';
import { pairingToken, PAIRING_REQUIRED_CLOSE_CODE } from './pairing';

export class BinarySocket extends EventTarget {
  private ws?: WebSocket;
  private reconnectTimer?: number;
  private stopped = false;
  /** Bytes handed to this connection, and bytes the server confirmed receiving (`ack` messages). */
  private sentTotal = 0;
  private ackedTotal = 0;

  constructor(private readonly path: string) {
    super();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get bufferedAmount(): number {
    return this.ws?.bufferedAmount || 0;
  }

  /**
   * Data sent but not yet confirmed by the server. Unlike `bufferedAmount` (which Safari decrements as soon
   * as data reaches its network process, not the wire) this measures the real end-to-end backlog.
   */
  get unackedBytes(): number {
    return Math.max(0, this.sentTotal - this.ackedTotal);
  }

  get ackedBytes(): number {
    return this.ackedTotal;
  }

  acknowledge(totalBytes: number): void {
    if (Number.isFinite(totalBytes) && totalBytes > this.ackedTotal) this.ackedTotal = Math.min(totalBytes, this.sentTotal);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = pairingToken();
    const query = token ? `?k=${encodeURIComponent(token)}` : '';
    const ws = new WebSocket(`${protocol}//${location.host}${this.path}${query}`);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    this.dispatchEvent(new CustomEvent('status', { detail: 'connecting' }));
    ws.addEventListener('open', () => {
      // Byte accounting is per connection, matching the server's per-connection counter.
      this.sentTotal = 0;
      this.ackedTotal = 0;
      this.dispatchEvent(new Event('open'));
      this.dispatchEvent(new CustomEvent('status', { detail: 'online' }));
    });
    ws.addEventListener('message', (event) => {
      // A replaced connection may still deliver late packets (acks, commands) that belong to it alone.
      if (this.ws !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        this.dispatchEvent(new CustomEvent('packet', { detail: event.data }));
      }
    });
    ws.addEventListener('close', (event) => {
      if (this.ws === ws) this.dispatchEvent(new CustomEvent('status', { detail: 'offline' }));
      if (event.code === PAIRING_REQUIRED_CLOSE_CODE) {
        // Retrying cannot help: the page needs the pairing key from the PC's QR code / OBS URL.
        this.stopped = true;
        this.dispatchEvent(new Event('pairing-required'));
        return;
      }
      if (!this.stopped) {
        this.reconnectTimer = window.setTimeout(() => this.connect(), 800);
      }
    });
    ws.addEventListener('error', () => ws.close());
  }

  send(packet: ArrayBuffer): boolean {
    if (!this.isOpen) return false;
    this.ws!.send(packet);
    this.sentTotal += packet.byteLength;
    return true;
  }

  sendControl(type: string, payload: Record<string, unknown> = {}): boolean {
    const message: ControlMessage = { type, ...payload };
    return this.send(encodeControl(message));
  }

  async waitUntilOpen(): Promise<void> {
    if (this.isOpen) return;
    await new Promise<void>((resolve) => this.addEventListener('open', () => resolve(), { once: true }));
  }

  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
