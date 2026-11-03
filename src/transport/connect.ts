import { selfId } from 'trystero';
import { toB64url } from '../crypto/bytes';
import { roomIdFor, type ShareLink } from '../link';
import { HybridTransport } from './hybrid';
import { NostrRelayTransport } from './nostr-relay';
import { createTrysteroTransport } from './trystero';
import type { PeerStatus, RoomTransport, Transport } from './types';

export interface RoomTransportFactories {
  direct(o: { relays: string[]; roomId: string; password: string }): Transport;
  relay(o: { relays: string[]; topic: string; selfId: string; heartbeatMs: number }): Transport;
}

const defaultFactories: RoomTransportFactories = {
  direct: createTrysteroTransport,
  relay: (o) => new NostrRelayTransport(o),
};

// heartbeat: false sends no relay frames of the transport's own. The sessions' hellos, pings and bundles
// announce each peer instead, so the host's relay output stays inside its send budget.
export async function createRoomTransport(
  link: ShareLink, relays: string[], opts: { forceRelay?: boolean; heartbeat?: boolean } = {}, factories: Partial<RoomTransportFactories> = {},
): Promise<RoomTransport> {
  const make = { ...defaultFactories, ...factories };
  const directOptions = { relays, roomId: await roomIdFor(link.roomKey, 'webrtc'), password: toB64url(link.roomKey) };
  const direct = directOrNone(() => make.direct(directOptions));
  const relay = make.relay({ relays, topic: await roomIdFor(link.roomKey, 'relay'), selfId: direct.selfId, heartbeatMs: opts.heartbeat === false ? 0 : 5000 });
  return new HybridTransport(direct, relay, { forceRelay: opts.forceRelay });
}

// Without WebRTC, or if Trystero throws, the meeting still works over the relays alone.
function directOrNone(create: () => Transport): Transport {
  try {
    return create();
  } catch (error) {
    console.warn('[retrobrew] direct connections are unavailable; using the relays only', error);
    return new NoDirectPath(selfId);
  }
}

// A direct path that never connects, so HybridTransport always uses the relay.
class NoDirectPath implements Transport {
  constructor(readonly selfId: string) {}
  send(): void {}
  broadcast(): void {}
  onMessage(): void {}
  onPeerJoin(): void {}
  onPeerLeave(): void {}
  status(): PeerStatus { return 'offline'; }
  peers(): string[] { return []; }
  leave(): void {}
}
