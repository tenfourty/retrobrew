import type { Bytes } from '../crypto/bytes';
import { MAX_FRAME_BYTES } from './relay-frame';
import type { Inbound, MessageMeta, Path, PeerStatus, RelayHealth, ResumeFocus, RoomTransport, SendOptions, Transport } from './types';

// Two paths to every peer: direct when connected, otherwise the relay. The relay works from the first second,
// so nobody waits for WebRTC. Callers can choose the path (sendVia) or let it choose (send).
export class HybridTransport implements RoomTransport {
  readonly selfId: string;
  private messageCb?: (peerId: string, data: Bytes, meta?: MessageMeta) => void;
  private inboundCb?: (message: Inbound) => void;
  private joinCb?: (peerId: string) => void;
  private leaveCb?: (peerId: string) => void;
  private readonly known = new Set<string>();
  // Peers whose last direct send was rejected. They use the relay until a direct message arrives from them.
  private readonly directDown = new Set<string>();

  constructor(private readonly direct: Transport, private readonly relay: Transport, private readonly opts: { forceRelay?: boolean } = {}) {
    if (direct.selfId !== relay.selfId) throw new Error('Direct and relay transports must share a self ID');
    this.selfId = direct.selfId;
    direct.onMessage((peerId, data) => {
      this.directDown.delete(peerId);
      this.deliver({ from: peerId, data, path: 'direct', echo: false });
    });
    relay.onMessage((peerId, data, meta) => this.deliver({ from: peerId, data, path: 'relay', echo: meta?.echo === true }));
    // A peer that joins or leaves directly starts afresh: the mark of a rejected send must not outlive its connection.
    direct.onPeerJoin((peerId) => { this.directDown.delete(peerId); this.peerJoined(peerId); });
    direct.onPeerLeave((peerId) => { this.directDown.delete(peerId); this.peerLeft(peerId); });
    relay.onPeerJoin((peerId) => this.peerJoined(peerId));
    relay.onPeerLeave((peerId) => this.peerLeft(peerId));
  }

  status(peerId: string): PeerStatus {
    if (!this.opts.forceRelay && !this.directDown.has(peerId) && this.direct.status(peerId) === 'direct') return 'direct';
    return this.relay.status(peerId) === 'offline' ? 'offline' : 'relayed';
  }

  send(peerId: string, data: Bytes): void {
    this.sendVia(peerId, data, this.status(peerId) === 'direct' ? 'direct' : 'relay').catch(() => undefined);
  }

  async sendVia(peerId: string, data: Bytes, path: Path, opts: SendOptions = {}): Promise<Path | null> {
    // A send with no fallback is a probe: it ignores the mark, so a peer marked down can be tried again.
    const probe = opts.fallback === false && !this.opts.forceRelay && this.direct.status(peerId) === 'direct';
    if (path === 'direct' && (probe || this.status(peerId) === 'direct')) {
      try {
        await this.direct.send(peerId, data);
        this.directDown.delete(peerId); // The path is proven again.
        return 'direct';
      } catch {
        this.directDown.add(peerId); // Acknowledgements cover anything else that goes silently missing.
      }
    }
    if (path === 'direct' && opts.fallback === false) return null;
    await this.relay.send(peerId, data, { echo: opts.echo, kind: opts.kind, supersedes: opts.supersedes, lasting: opts.lasting, expendable: opts.expendable });
    return 'relay';
  }

  broadcast(data: Bytes): void {
    for (const peerId of this.peers()) this.send(peerId, data);
  }

  broadcastRelay(data: Bytes, opts?: SendOptions): void {
    this.relay.broadcast(data, opts);
  }

  peers(): string[] {
    return [...new Set([...this.direct.peers(), ...this.relay.peers()])];
  }

  directPeers(): string[] {
    return this.direct.peers();
  }

  relayHealth(): RelayHealth[] {
    return this.relay.relayHealth?.() ?? [];
  }

  resume(focus?: ResumeFocus): void {
    this.relay.resume?.();
    this.direct.resume?.(focus);
  }

  follow(focus: () => ResumeFocus): void {
    this.direct.follow?.(focus);
  }

  expectPeers(peers: () => string[]): void {
    this.direct.expectPeers?.(peers);
  }

  onMessage(cb: (peerId: string, data: Bytes, meta?: MessageMeta) => void): void { this.messageCb = cb; }
  onInbound(cb: (message: Inbound) => void): void { this.inboundCb = cb; }
  onPeerJoin(cb: (peerId: string) => void): void { this.joinCb = cb; }
  onPeerLeave(cb: (peerId: string) => void): void { this.leaveCb = cb; }

  leave(): void {
    this.direct.leave();
    this.relay.leave();
  }

  // Echoes go only to onInbound: callers of onMessage never asked for their own events.
  private deliver(message: Inbound): void {
    if (message.data.length > MAX_FRAME_BYTES) return; // too large to unseal: no honest peer sends one
    this.inboundCb?.(message);
    if (!message.echo) this.messageCb?.(message.from, message.data);
  }

  private peerJoined(peerId: string): void {
    if (this.known.has(peerId)) return;
    this.known.add(peerId);
    this.joinCb?.(peerId);
  }

  private peerLeft(peerId: string): void {
    const stillThere = this.direct.status(peerId) !== 'offline' || this.relay.status(peerId) !== 'offline';
    if (stillThere || !this.known.delete(peerId)) return;
    this.leaveCb?.(peerId);
  }
}
