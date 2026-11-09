import type { Bytes } from '../crypto/bytes';
import type { Scheduler } from '../session/scheduler';
import type { MessageMeta, PeerStatus, RelayHealth, ResumeFocus, SendOptions, Transport } from './types';

// An in-process room for tests. Delivery is asynchronous, like a real network.
export class MemoryNetwork {
  tap?: (from: string, to: string, data: Bytes) => void;
  // Test hooks: losing a delivery (return true), a delay for each delivery run on `scheduler`, failing every
  // send, and the relays' health.
  lose?: (from: string, to: string, data: Bytes) => boolean;
  delay?: (from: string, to: string) => number;
  scheduler?: Scheduler;
  failSends = false;
  health: RelayHealth[] = [];
  private readonly nodes = new Map<string, MemoryTransport>();

  constructor(readonly kind: Exclude<PeerStatus, 'offline'> = 'direct') {}

  // connect: false joins without connecting to anyone, as a WebRTC peer whose connections come later (connect()).
  join(selfId: string, { connect = true }: { connect?: boolean } = {}): MemoryTransport {
    if (this.nodes.has(selfId)) throw new Error(`${selfId} has already joined`);
    const node = new MemoryTransport(selfId, this);
    const others = [...this.nodes.values()];
    this.nodes.set(selfId, node);
    if (!connect) return node;
    queueMicrotask(() => {
      for (const other of others) {
        if (!this.nodes.has(other.selfId) || !this.nodes.has(selfId)) continue;
        other.peerJoined(selfId);
        node.peerJoined(other.selfId);
      }
    });
    return node;
  }

  // A connection between two joined peers comes up now.
  connect(a: string, b: string): void {
    const [x, y] = [this.nodes.get(a), this.nodes.get(b)];
    if (!x || !y) throw new Error(`${a} and ${b} must both have joined`);
    x.peerJoined(b);
    y.peerJoined(a);
  }

  // The transport tells `selfId` that `peerId` left (a relay's sweep, a dropped connection), though `peerId` is still
  // in the room: its messages still arrive, and `connect` brings it back.
  announceLeave(selfId: string, peerId: string): void {
    this.nodes.get(selfId)?.peerLeft(peerId);
  }

  drop(selfId: string): void {
    if (!this.nodes.delete(selfId)) return;
    for (const other of this.nodes.values()) other.peerLeft(selfId);
  }

  deliver(from: string, to: string, data: Bytes, meta?: MessageMeta): void {
    const target = this.nodes.get(to);
    if (!target || !this.nodes.has(from)) return;
    this.tap?.(from, to, data);
    if (this.lose?.(from, to, data)) return;
    const copy = data.slice();
    const run = () => { if (this.nodes.get(to) === target) target.receive(from, copy, meta); };
    if (this.delay && this.scheduler) this.scheduler.setTimeout(run, this.delay(from, to));
    else queueMicrotask(run);
  }
}

export class MemoryTransport implements Transport {
  resumed = 0;
  // The focus of each resume, in order.
  readonly resumeFocus: Array<ResumeFocus | undefined> = [];
  private messageCb?: (peerId: string, data: Bytes, meta?: MessageMeta) => void;
  private joinCb?: (peerId: string) => void;
  private leaveCb?: (peerId: string) => void;
  private readonly connected = new Set<string>();

  constructor(readonly selfId: string, private readonly network: MemoryNetwork) {}

  send(peerId: string, data: Bytes, opts: SendOptions = {}): void | Promise<void> {
    if (this.network.failSends) return Promise.reject(new Error('send failed'));
    if (this.connected.has(peerId)) this.network.deliver(this.selfId, peerId, data);
    if (opts.echo) this.network.deliver(this.selfId, this.selfId, data, { echo: true });
  }
  broadcast(data: Bytes): void {
    for (const peerId of this.connected) void Promise.resolve(this.send(peerId, data)).catch(() => undefined);
  }
  onMessage(cb: (peerId: string, data: Bytes, meta?: MessageMeta) => void): void { this.messageCb = cb; }
  onPeerJoin(cb: (peerId: string) => void): void { this.joinCb = cb; }
  onPeerLeave(cb: (peerId: string) => void): void { this.leaveCb = cb; }
  status(peerId: string): PeerStatus {
    return this.connected.has(peerId) ? this.network.kind : 'offline';
  }
  peers(): string[] { return [...this.connected]; }
  relayHealth(): RelayHealth[] { return this.network.health; }
  resume(focus?: ResumeFocus): void {
    this.resumed += 1;
    this.resumeFocus.push(focus);
  }
  // The focus a page follows, as it names it.
  followed?: () => ResumeFocus;
  follow(focus: () => ResumeFocus): void {
    this.followed = focus;
  }
  // The peers a facilitator expects, as it names them.
  expected?: () => string[];
  expectPeers(peers: () => string[]): void {
    this.expected = peers;
  }
  leave(): void {
    this.network.drop(this.selfId);
    this.connected.clear();
  }

  peerJoined(peerId: string): void {
    if (this.connected.has(peerId)) return;
    this.connected.add(peerId);
    this.joinCb?.(peerId);
  }
  peerLeft(peerId: string): void {
    if (this.connected.delete(peerId)) this.leaveCb?.(peerId);
  }
  receive(from: string, data: Bytes, meta?: MessageMeta): void {
    this.messageCb?.(from, data, meta);
  }
}
