import { importRoomKey } from '../crypto/aead';
import { DEFAULT_RELAYS } from '../config';
import type { ShareLink } from '../link';
import type { Outcome } from '../session/outcome';
import { ParticipantSession } from '../session/participant';
import type { BoardStore } from '../store/board-store';
import { createRoomTransport } from '../transport/connect';
import { exposeRelayHealth } from './e2e-hooks';
import { onPageVisible } from './browser';
import { getDeviceSigner, rememberName } from './identity';
import { Startup } from './startup';

export interface ParticipantHandle {
  session: ParticipantSession;
  stop(): void;
}

export interface ParticipantCallbacks {
  onState(): void;
  onReject(message: string, clientSeq: number): void;
  onHostStatus(online: boolean): void;
  // connection, mismatch, pendingFailed or staleTab changed.
  onStatus?(): void;
  onOutcome?(outcome: Outcome): void;
}

// Joins a meeting from its share link. If `signal` aborts before start-up finishes (the view went away), everything
// opened so far is closed and the promise rejects with StartCancelled.
export async function startParticipating(
  link: ShareLink, name: string, store: BoardStore, cb: ParticipantCallbacks, signal: AbortSignal = new AbortController().signal,
): Promise<ParticipantHandle> {
  const startup = new Startup(signal);
  const { signer } = await startup.step(getDeviceSigner(store));
  await startup.step(rememberName(store, name));
  const transport = await startup.step(createRoomTransport(link, DEFAULT_RELAYS, { heartbeat: false }), (t) => t.leave());
  const roomKey = await startup.step(importRoomKey(link.roomKey));
  // Everything from here on is synchronous, so start-up can't be cancelled half way through it: the session, its
  // heartbeat and the page listeners all start together, after the last step, and stop() closes them.
  const session = new ParticipantSession({
    transport, signer, name, hostPub: link.hostPub, boardId: link.boardId, roomKey,
    onState: cb.onState, onReject: cb.onReject, onHostStatus: cb.onHostStatus, onStatus: cb.onStatus, onOutcome: cb.onOutcome,
  });
  session.startHeartbeat();
  // Phones drop connections when locked: reconnect and say hello as soon as the page is back.
  const stopVisible = onPageVisible(() => session.resume());
  // Browser-battery builds only: the condition is a constant at build time, so any other build drops the hook.
  let stopHook: () => void = () => undefined;
  if (import.meta.env.MODE === 'e2e') stopHook = exposeRelayHealth(import.meta.env.MODE, () => session.relayHealth());
  return {
    session,
    stop: () => {
      session.stopHeartbeat();
      stopVisible();
      stopHook();
      transport.leave();
    },
  };
}
