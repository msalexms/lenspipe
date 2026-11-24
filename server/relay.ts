import { performance } from 'node:perf_hooks';
import type { WebSocket, RawData } from 'ws';
import { encodeControl, PACKET } from './wire.js';
import type { NetworkScanner, NetworkSnapshot, Transport } from './network.js';

interface Client {
  id: number;
  socket: WebSocket;
  role: 'sender' | 'receiver';
  remoteAddress?: string;
  transport: Transport;
  rttMs: number | null;
  pendingPing: { id: number; sentAt: number } | null;
  pendingNativePing: { sentAt: number } | null;
  telemetry: Record<string, unknown>;
  /** 'sender', 'control' or 'obs', for per-receiver diagnostics. */
  label: string;
  /** Receiver-only: skip video until the next keyframe (fresh join or after congestion). */
  awaitingKeyframe: boolean;
  /** Receiver-only: whether this client wants video frames relayed (false while control preview is paused). */
  videoEnabled: boolean;
  /** Sender only: every byte received on this connection, acknowledged back for flow control. */
  receivedBytes: number;
  /** Sender only: when the last coalesced ack left, and the byte count it covered. */
  lastAckAt: number;
  lastAckedBytes: number;
  videoStarted: boolean;
  relayDroppedFrames: number;
}

const VIDEO_CONFIG_TYPES = new Set<number>([PACKET.VIDEO_CONFIG, PACKET.AUDIO_CONFIG]);
const VIDEO_TYPES = new Set<number>([PACKET.VIDEO_KEYFRAME, PACKET.VIDEO_DELTA]);
const MEDIA_TYPES = new Set<number>([...VIDEO_TYPES, PACKET.AUDIO_CHUNK]);
const ALLOWED_TYPES = new Set<number>([...VIDEO_CONFIG_TYPES, ...MEDIA_TYPES, PACKET.CONTROL]);
const STALE_PING_MS = 10_000;
/**
 * A receiver may queue at most this much video in the server before its deltas are skipped. It is
 * time-based: a fixed byte cap (previously 8 MiB) meant ~600 ms of hidden delay at 110 Mbps.
 */
const RECEIVER_MAX_QUEUE_MS = 200;
const RECEIVER_MIN_HIGH_WATER_BYTES = 1.5 * 1024 * 1024;
const KEYFRAME_REQUEST_GAP_MS = 500;
/**
 * Flow-control acknowledgements are coalesced to at most one per interval. One ack per media packet
 * (about 110/s at 1080p60 + 48 kHz audio) spends a JSON encode, two Buffer allocations and a ws
 * frame per camera frame; the sender only needs the cumulative count often enough that its ~250 ms
 * backlog bound stays accurate, and `tick()` flushes the tail within 1 s when the stream goes idle.
 */
const ACK_COALESCE_MS = 25;

export class StreamRelay {
  private sender?: Client;
  private readonly receivers = new Set<Client>();
  private latestVideoConfig?: Buffer;
  private latestAudioConfig?: Buffer;
  private nextClientId = 1;
  private nextPingId = 1;
  private interval?: NodeJS.Timeout;
  private streamBytes = 0;
  private lastThroughputAt = performance.now();
  private throughputMbps = 0;
  private lastKeyframeRequestAt = 0;

  constructor(private readonly network: NetworkScanner) {}

  private readonly onNetworkChange = (snapshot: NetworkSnapshot) => {
    this.refreshSenderTransport();
    this.broadcastControl({ type: 'network', network: snapshot });
  };

  start(): void {
    this.interval = setInterval(() => this.tick(), 1000);
    this.interval.unref();
    this.network.on('change', this.onNetworkChange);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    this.network.off('change', this.onNetworkChange);
  }

  accept(socket: WebSocket, role: 'sender' | 'receiver', remoteAddress?: string, label: string = role): void {
    const client: Client = {
      id: this.nextClientId++,
      socket,
      role,
      remoteAddress,
      transport: this.network.classifyRemoteAddress(remoteAddress),
      rttMs: null,
      pendingPing: null,
      pendingNativePing: null,
      telemetry: {},
      label,
      awaitingKeyframe: true,
      videoEnabled: true,
      receivedBytes: 0,
      lastAckAt: 0,
      lastAckedBytes: 0,
      videoStarted: false,
      relayDroppedFrames: 0,
    };

    if (role === 'sender') {
      const previous = this.sender;
      this.sender = client;
      this.network.setSenderConnected(true);
      if (previous && previous.socket.readyState === previous.socket.OPEN) {
        previous.socket.close(1000, 'Replaced by a new sender');
      }
    } else {
      this.receivers.add(client);
    }

    this.sendControl(client, {
      type: 'hello',
      role,
      clientId: client.id,
      transport: client.transport,
      network: this.network.snapshot,
    });

    if (role === 'receiver') {
      if (this.latestVideoConfig) this.sendBuffer(client, this.latestVideoConfig);
      if (this.latestAudioConfig) this.sendBuffer(client, this.latestAudioConfig);
      this.sendControl(client, { type: 'stream-state', online: this.isSenderOnline(), transport: this.sender?.transport ?? 'Unknown' });
      this.sendToSender({ type: 'command', command: 'force-keyframe' });
      this.sendToSender({ type: 'command', command: 'request-state' });
    } else {
      this.broadcastControl({ type: 'stream-state', online: true, transport: client.transport });
    }

    socket.on('message', (data: RawData, isBinary: boolean) => {
      const packet = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (!isBinary || packet.length < 1 || !ALLOWED_TYPES.has(packet[0])) return;
      if (role === 'sender') this.handleSenderPacket(client, packet);
      else this.handleReceiverPacket(client, packet);
    });

    socket.on('pong', () => {
      if (client.pendingNativePing) {
        client.rttMs = Math.max(0, performance.now() - client.pendingNativePing.sentAt);
        client.pendingNativePing = null;
      }
    });

    socket.on('close', () => {
      if (role === 'sender' && this.sender === client) {
        this.sender = undefined;
        this.network.setSenderConnected(false);
        this.broadcastControl({ type: 'stream-state', online: false, transport: 'Unknown' });
      }
      if (role === 'receiver') this.receivers.delete(client);
    });
    socket.on('error', () => socket.close());
  }

  private handleSenderPacket(client: Client, packet: Buffer): void {
    client.receivedBytes += packet.byteLength;
    if (client !== this.sender) return;
    const type = packet[0];
    // Acknowledge media so the iPhone can bound its in-flight data (its own bufferedAmount is
    // unreliable). Coalesced: see ACK_COALESCE_MS.
    if (type !== PACKET.CONTROL) {
      const now = performance.now();
      if (now - client.lastAckAt >= ACK_COALESCE_MS) {
        client.lastAckAt = now;
        client.lastAckedBytes = client.receivedBytes;
        this.sendControl(client, { type: 'ack', bytes: client.receivedBytes });
      }
    }
    if (type === PACKET.CONTROL) {
      const message = this.parseControl(packet);
      if (!message) return;
      if (message.type === 'pong') {
        this.acceptPong(client, message);
        return;
      }
      client.telemetry = { ...client.telemetry, ...message };
      if (message.type === 'sender-state' || message.type === 'sender-telemetry' || message.type === 'sender-focus' || message.type === 'sender-notice') {
        this.broadcastControl({ ...message, transport: client.transport });
      }
      return;
    }

    if (VIDEO_CONFIG_TYPES.has(type)) {
      if (type === PACKET.VIDEO_CONFIG) this.latestVideoConfig = packet;
      else this.latestAudioConfig = packet;
    }
    if (MEDIA_TYPES.has(type)) this.streamBytes += packet.byteLength;

    // The exact same Buffer is relayed to every receiver: no decode/re-encode or packet copy.
    if (VIDEO_TYPES.has(type)) {
      for (const receiver of this.receivers) this.relayVideo(receiver, packet, type === PACKET.VIDEO_KEYFRAME);
    } else {
      for (const receiver of this.receivers) this.sendBuffer(receiver, packet);
    }
  }

  /**
   * Per-receiver backpressure: a slow or throttled receiver (e.g. a background tab) must not make Node
   * queue video without bound, which would add ever-growing latency. Deltas are skipped until the queue
   * drains and resume only at a keyframe, so the decoder never sees a broken reference chain.
   */
  private relayVideo(receiver: Client, packet: Buffer, keyframe: boolean): void {
    if (!receiver.videoEnabled || receiver.socket.readyState !== receiver.socket.OPEN) return;
    const highWater = Math.max(RECEIVER_MIN_HIGH_WATER_BYTES, ((this.throughputMbps * 1_000_000) / 8) * (RECEIVER_MAX_QUEUE_MS / 1000));
    const congested = receiver.socket.bufferedAmount > highWater;
    if (congested || (receiver.awaitingKeyframe && !keyframe)) {
      if (receiver.videoStarted) receiver.relayDroppedFrames++;
      if (congested) receiver.awaitingKeyframe = true;
      this.requestKeyframe();
      return;
    }
    receiver.awaitingKeyframe = false;
    receiver.videoStarted = true;
    receiver.socket.send(packet, { binary: true });
  }

  private requestKeyframe(): void {
    const now = performance.now();
    if (now - this.lastKeyframeRequestAt < KEYFRAME_REQUEST_GAP_MS) return;
    this.lastKeyframeRequestAt = now;
    this.sendToSender({ type: 'command', command: 'force-keyframe' });
  }

  private handleReceiverPacket(client: Client, packet: Buffer): void {
    if (packet[0] !== PACKET.CONTROL) return;
    const message = this.parseControl(packet);
    if (!message) return;
    if (message.type === 'pong') {
      this.acceptPong(client, message);
      return;
    }
    if (message.type === 'command') {
      this.sendToSender(message);
      return;
    }
    if (message.type === 'video-subscription') {
      const enabled = message.enabled !== false;
      if (enabled === client.videoEnabled) return;
      client.videoEnabled = enabled;
      client.awaitingKeyframe = true;
      if (enabled && this.isSenderOnline()) this.requestKeyframe();
      return;
    }
    if (message.type === 'receiver-telemetry') {
      client.telemetry = { ...client.telemetry, ...message };
    }
  }

  private parseControl(packet: Buffer): Record<string, unknown> | undefined {
    if (packet.length > 65536) return undefined;
    try {
      const value = JSON.parse(packet.subarray(1).toString('utf8'));
      return value && typeof value.type === 'string' ? value : undefined;
    } catch {
      return undefined;
    }
  }

  private acceptPong(client: Client, message: Record<string, unknown>): void {
    if (client.pendingPing && message.id === client.pendingPing.id) {
      client.rttMs = Math.max(0, performance.now() - client.pendingPing.sentAt);
      client.pendingPing = null;
    }
  }

  private refreshSenderTransport(): void {
    if (!this.sender) return;
    const nextTransport = this.network.classifyRemoteAddress(this.sender.remoteAddress);
    if (nextTransport !== this.sender.transport) {
      this.sender.transport = nextTransport;
      this.sendControl(this.sender, { type: 'transport', transport: nextTransport });
    }
  }

  private tick(): void {
    const now = performance.now();
    this.refreshSenderTransport();
    this.ping(this.sender, now);
    // Flush a coalesced ack so a sender that just went idle never carries stale unacked bytes.
    const sender = this.sender;
    if (sender && sender.socket.readyState === sender.socket.OPEN && sender.receivedBytes > sender.lastAckedBytes) {
      sender.lastAckAt = now;
      sender.lastAckedBytes = sender.receivedBytes;
      this.sendControl(sender, { type: 'ack', bytes: sender.receivedBytes });
    }
    for (const receiver of this.receivers) this.ping(receiver, now);

    const elapsed = Math.max(1, now - this.lastThroughputAt);
    this.throughputMbps = (this.streamBytes * 8 * 1000) / elapsed / 1_000_000;
    this.streamBytes = 0;
    this.lastThroughputAt = now;

    const receivers = [...this.receivers];
    const maxNumber = (key: string): number => Math.max(0, ...receivers.map((client) => Number(client.telemetry[key]) || 0));
    this.broadcastControl({
      type: 'telemetry',
      online: this.isSenderOnline(),
      transport: this.sender?.transport ?? 'Unknown',
      throughputMbps: this.throughputMbps,
      rttMs: this.effectiveRtt(this.sender, now),
      decodedFrames: maxNumber('decodedFrames'),
      droppedFrames: maxNumber('droppedFrames')
        + Math.max(0, ...receivers.map((client) => client.relayDroppedFrames))
        + (Number(this.sender?.telemetry.droppedFrames) || 0),
      receiverFps: maxNumber('fps'),
      // Video skipped because a receiver's socket was backed up (slow/throttled tab or OBS).
      relayDroppedFrames: Math.max(0, ...receivers.map((client) => client.relayDroppedFrames)),
      // Per-receiver view of the PC side: video waiting in the server for that tab, and what the tab reports.
      receivers: receivers.map((client) => ({
        id: client.id,
        label: client.label,
        videoEnabled: client.videoEnabled,
        queuedMs: this.throughputMbps > 0 ? Math.round((client.socket.bufferedAmount * 8) / (this.throughputMbps * 1000)) : 0,
        fps: Number(client.telemetry.fps) || 0,
        decoderQueue: Number(client.telemetry.decoderQueue) || 0,
        pipelineMs: Number(client.telemetry.pipelineMs) || 0,
        pipelineMaxMs: Number(client.telemetry.pipelineMaxMs) || 0,
        relayDroppedFrames: client.relayDroppedFrames,
      })),
    });
  }

  private ping(client?: Client, now = performance.now()): void {
    if (!client || client.socket.readyState !== client.socket.OPEN) return;
    if (client.pendingPing && now - client.pendingPing.sentAt > STALE_PING_MS) {
      client.pendingPing = null;
    }
    if (!client.pendingPing) {
      const id = this.nextPingId++;
      client.pendingPing = { id, sentAt: now };
      this.sendControl(client, { type: 'ping', id });
    }
    if (client.pendingNativePing && now - client.pendingNativePing.sentAt > STALE_PING_MS) {
      client.pendingNativePing = null;
    }
    if (!client.pendingNativePing) {
      client.pendingNativePing = { sentAt: now };
      try {
        client.socket.ping();
      } catch {
        client.pendingNativePing = null;
      }
    }
  }

  /** Last RTT, but never less than the age of an unanswered ping: a stalled link must not look healthy. */
  private effectiveRtt(client: Client | undefined, now: number): number | null {
    if (!client) return null;
    const pendingAge = client.pendingPing ? now - client.pendingPing.sentAt : 0;
    if (client.rttMs == null) return pendingAge > 1000 ? pendingAge : null;
    return Math.max(client.rttMs, pendingAge);
  }

  private isSenderOnline(): boolean {
    return Boolean(this.sender && this.sender.socket.readyState === this.sender.socket.OPEN);
  }

  private sendToSender(message: Record<string, unknown>): void {
    if (this.sender) this.sendControl(this.sender, message);
  }

  private broadcastControl(message: Record<string, unknown>): void {
    const packet = encodeControl(message);
    for (const receiver of this.receivers) this.sendBuffer(receiver, packet);
  }

  private sendControl(client: Client, message: Record<string, unknown>): void {
    this.sendBuffer(client, encodeControl(message));
  }

  private sendBuffer(client: Client, packet: Buffer): void {
    if (client.socket.readyState === client.socket.OPEN) client.socket.send(packet, { binary: true });
  }
}
