import type { Bytes } from '../crypto/bytes';
import type { Inbound, Path, RoomTransport, SendOptions, Transport } from './types';

// Lets a one-path transport (a MemoryTransport in tests) stand in for both paths. Its path is reported by its
// status: a 'direct' network is the direct path, anything else the relay.
export function toRoomTransport(t: Transport | RoomTransport): RoomTransport {
  if ('sendVia' in t) return t;
  const pathTo = (peerId: string): Path => (t.status(peerId) === 'direct' ? 'direct' : 'relay');
  return {
    selfId: t.selfId,
    send: (peerId, data, opts) => t.send(peerId, data, opts),
    broadcast: (data) => t.broadcast(data),
    onMessage: (cb) => t.onMessage(cb),
    onPeerJoin: (cb) => t.onPeerJoin(cb),
    onPeerLeave: (cb) => t.onPeerLeave(cb),
    status: (peerId) => t.status(peerId),
    peers: () => t.peers(),
    leave: () => t.leave(),
    async sendVia(peerId: string, data: Bytes, _path: Path, opts: SendOptions = {}): Promise<Path | null> {
      try {
        await t.send(peerId, data, { echo: opts.echo });
      } catch {
        return null;
      }
      return pathTo(peerId);
    },
    broadcastRelay: (data, opts) => t.broadcast(data, opts),
    onInbound: (cb: (message: Inbound) => void) => t.onMessage((from, data, meta) => cb({
      from, data, path: meta?.echo ? 'relay' : pathTo(from), echo: meta?.echo === true,
    })),
    relayHealth: () => t.relayHealth?.() ?? [],
    resume: (focus) => t.resume?.(focus),
    follow: (focus) => t.follow?.(focus),
  };
}
