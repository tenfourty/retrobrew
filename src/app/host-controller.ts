import { generateRoomKey, importRoomKey } from '../crypto/aead';
import { fromB64url, toB64url } from '../crypto/bytes';
import { exportKeyPair, fingerprint, generateSigningKeys, importKeyPair, signerFrom } from '../crypto/sign';
import { createBoard } from '../engine/board';
import { buildShareLink, newBoardId, parseShareLink, type ShareLink } from '../link';
import { createSizeMeter } from '../protocol/size';
import { HostSession } from '../session/host';
import type { Outcome } from '../session/outcome';
import { nextEpoch, type BoardRecord, type BoardStore } from '../store/board-store';
import { createRoomTransport } from '../transport/connect';
import type { RelayHealth } from '../transport/types';
import { exposeRelayHealth } from './e2e-hooks';
import { onPageVisible, warnBeforeLeaving } from './browser';
import { exposeDirectPeers } from './e2e-direct-peers';
import { Startup } from './startup';
import { ScreenWakeLock } from './wake-lock';

export interface HostHandle {
  session: HostSession;
  record(): BoardRecord;
  // Banner 6: navigator.storage.persist() didn't promise to keep this meeting when it was created.
  persistenceRefused(): boolean;
  stop(): void;
}

export async function createBoardRecord(boardName: string, ownerName: string, relays: string[], rehearsal = false): Promise<BoardRecord> {
  const pair = await generateSigningKeys(true);
  const signer = await signerFrom(pair);
  const boardId = newBoardId();
  return {
    boardId, roomKey: toB64url(generateRoomKey()), hostPub: signer.pub, hostKeys: await exportKeyPair(pair),
    epoch: 0, relays, updatedAt: Date.now(),
    state: createBoard({ boardId, boardName, ownerId: await fingerprint(signer.pub), ownerName, rehearsal }),
  };
}

export function recordLink(record: BoardRecord, base: string): string {
  return buildShareLink(base, { boardId: record.boardId, roomKey: fromB64url(record.roomKey), hostPub: record.hostPub });
}

// Starts hosting a board in this tab. If `signal` aborts before start-up finishes (the view went away), everything
// opened so far is closed and the promise rejects with StartCancelled.
export async function startHosting(
  record: BoardRecord, store: BoardStore, onUpdate: () => void,
  opts: { signal?: AbortSignal; onOutcome?: (outcome: Outcome) => void; onHealth?: (health: RelayHealth[]) => void } = {},
): Promise<HostHandle> {
  if (!record.hostKeys.privateKey) throw new Error('This board has no host key in this browser');
  const startup = new Startup(opts.signal ?? new AbortController().signal);
  const pair = await startup.step(importKeyPair({ publicKey: record.hostKeys.publicKey, privateKey: record.hostKeys.privateKey }));
  const signer = await startup.step(signerFrom(pair));
  // The new epoch is saved before anything is sent.
  let current: BoardRecord = { ...record, epoch: nextEpoch(record.epoch, Date.now()), updatedAt: Date.now() };
  await startup.step(store.put(current));
  const link = parseShareLink(new URL(recordLink(current, location.href)).hash) as ShareLink;
  const transport = await startup.step(createRoomTransport(link, current.relays, { heartbeat: false }), (t) => t.leave());
  const meter = await startup.step(createSizeMeter());
  const roomKey = await startup.step(importRoomKey(fromB64url(current.roomKey)));
  const hostId = await startup.step(fingerprint(signer.pub));
  // Everything from here on is synchronous, so start-up can't be cancelled half way through it: the session, its
  // tick, the wake lock and the page listeners all start together, after the last step, and stop() closes them.
  const session = new HostSession({
    transport, signer, epoch: current.epoch, state: current.state, tabs: current.tabs, roomKey, hostId,
    // The size cap, measured by the size meter (src/protocol/size.ts).
    measure: meter.measure,
    // The board and the tab table go in one write; the session sends views and acks only after it resolves.
    save: async ({ state, tabs }) => {
      const next = { ...current, state, tabs, updatedAt: Date.now() };
      await store.put(next);
      current = next;
    },
    onChange: onUpdate,
    onPresence: onUpdate,
    onStatus: onUpdate,
    onOutcome: opts.onOutcome,
    onHealth: opts.onHealth,
  });
  session.startTicking();
  const wakeLock = new ScreenWakeLock();
  void wakeLock.acquire();
  // Back from a lock, an app switch or the back-forward cache: reconnect, send a full refresh and tick.
  const stopResume = onPageVisible(() => session.resume());
  // The wake lock is asked for again every time the page is back, even within the resume's debounce, unless it is
  // still held: the browser lets it go whenever the page is hidden, however briefly.
  const stopRenew = onPageVisible(() => { if (!wakeLock.held) void wakeLock.renew(); }, { minGapMs: 0 });
  const releaseWarn = warnBeforeLeaving();
  // Browser-battery builds only: the condition is a constant at build time, so any other build drops the hook.
  let stopDirectPeersHook: () => void = () => undefined;
  if (import.meta.env.MODE === 'e2e') stopDirectPeersHook = exposeDirectPeers(() => transport.directPeers?.() ?? []);
  let stopHook: () => void = () => undefined;
  if (import.meta.env.MODE === 'e2e') stopHook = exposeRelayHealth(import.meta.env.MODE, () => session.relayHealth());
  return {
    session,
    record: () => current,
    persistenceRefused: () => current.persistence === 'refused',
    stop: () => {
      session.close();
      stopResume();
      stopRenew();
      wakeLock.release();
      releaseWarn();
      stopDirectPeersHook();
      stopHook();
      transport.leave();
    },
  };
}
