import type { Bytes } from '../crypto/bytes';

export type PeerStatus = 'direct' | 'relayed' | 'offline';
export type Path = 'direct' | 'relay';

export interface SendOptions {
  // Relay only: ask for this event back from the relay, to measure relay latency (a relay ping).
  echo?: boolean;
  // Direct only: false means a rejected direct send is not resent on the relay. The host uses it for
  // snapshots and pongs, because its relay output must stay inside its budget and bundles reach the peer anyway.
  fallback?: boolean;
  // Relay only, for events that a newer one makes pointless while a relay is down or out of budget (the host's bundles:
  // each carries the latest state whole). `kind` names this event; `supersedes` lists the kinds of held events it replaces,
  // so the relay transport keeps only the newer. A change bundle replaces change bundles; a full refresh replaces both.
  kind?: string;
  supersedes?: string[];
  // Relay only: an event whose held copy may be the only one left (a participant's command, once its outbox has given
  // up resending). When more wait than the transport holds, others are dropped first, and resume() keeps it while it
  // drops the held events a fresh one replaces (hellos, heartbeats, bundles).
  lasting?: boolean;
  // Relay only, with lasting: whether its held copy may go after all, because it is no longer needed (the host has
  // acknowledged the command) or the sender will send it again (its outbox has a resend of it still to come). While it
  // is, the held copy may make way for a fresh event (a hello) when the queue is full, like any event that is not lasting.
  expendable?: () => boolean;
}

export interface MessageMeta {
  // Our own relay event, handed back because we asked for an echo.
  echo?: boolean;
}

export interface RelayHealth {
  url: string;
  connected: boolean;
  refused: number; // OK false replies
  notices: number; // NOTICE replies
  dropped?: number; // events dropped from the hold queue, because more waited than it holds or the relay was given up on
  held?: number; // events waiting for this relay now (it is down or out of budget)
  givenUp?: boolean; // down so long that nothing is held for it until it is back
}

// What a resume should bring back on the direct path. A participant needs only its link to the host, so it names the
// host's peer (null while it knows none); the host passes no focus, and every direct peer counts.
export interface ResumeFocus {
  host: string | null;
}

// A room of peers over one path. Each on* call replaces the previous callback.
export interface Transport {
  readonly selfId: string;
  // A direct transport returns a promise that rejects when the send fails.
  send(peerId: string, data: Bytes, opts?: SendOptions): void | Promise<void>;
  broadcast(data: Bytes, opts?: SendOptions): void;
  onMessage(cb: (peerId: string, data: Bytes, meta?: MessageMeta) => void): void;
  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  status(peerId: string): PeerStatus;
  peers(): string[];
  leave(): void;
  relayHealth?(): RelayHealth[];
  resume?(focus?: ResumeFocus): void;
  // A participant tells the direct path whose link it cares about at all times, not only at a resume.
  follow?(focus: () => ResumeFocus): void;
  // The facilitator tells the direct path which participants have just joined it, so a resume can
  // tell a link the lock cut off before the direct room listed it.
  expectPeers?(peers: () => string[]): void;
}

export interface Inbound {
  from: string;
  data: Bytes;
  path: Path;
  echo: boolean;
}

// Both paths together. The sessions choose the path of every message (docs/product/sync-protocol.md, Reply paths).
export interface RoomTransport extends Transport {
  // Resolves with the path actually used: a rejected direct send goes by relay instead, unless
  // opts.fallback is false, when it resolves with null.
  sendVia(peerId: string, data: Bytes, path: Path, opts?: SendOptions): Promise<Path | null>;
  broadcastRelay(data: Bytes, opts?: SendOptions): void;
  onInbound(cb: (message: Inbound) => void): void;
  relayHealth(): RelayHealth[];
  resume(focus?: ResumeFocus): void;
  follow?(focus: () => ResumeFocus): void;
  expectPeers?(peers: () => string[]): void;
  // The peers of the direct path alone, as its room reports them (none while it rejoins).
  directPeers?(): string[];
}
