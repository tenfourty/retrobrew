import { finalizeEvent, type Event } from 'nostr-tools';
import { RELAY_EVENT_KIND } from '../config';
import { RELAY_EVENT_MAX_BYTES } from '../engine/limits';

// The most bytes any message may have, on either path, before anything unseals or parses it: no relay event or
// direct snapshot the host sends is larger (docs/product/sync-protocol.md, Size).
export const MAX_FRAME_BYTES = RELAY_EVENT_MAX_BYTES;

// The content of every relay event (docs/product/sync-protocol.md, Paths): the sender's transport ID, the
// intended peer (none for a broadcast), the sealed message in base64url, and e: 1 for a ping to be echoed.
export interface RelayFrame {
  from: string;
  to?: string;
  d?: string;
  e?: 1;
}

// The one serialiser for relay events, used to publish them and to measure them (src/protocol/size.ts).
export function relayEvent(frame: RelayFrame, topic: string, secretKey: Uint8Array): Event {
  return finalizeEvent({
    kind: RELAY_EVENT_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', topic]], content: JSON.stringify(frame),
  }, secretKey);
}
