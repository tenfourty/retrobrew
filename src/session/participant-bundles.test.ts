import { describe, expect, it, vi } from 'vitest';
import { createBoard } from '../engine/board';
import { sharedView } from '../engine/redact';
import { encodeBundle } from '../protocol/bundle';
import { BOARD, TestRoom } from '../test/sessions';
import { sleep, waitFor } from '../test/wait';

// openItem, with a gate the test holds shut for one bundle's seq, so that bundle finishes opening last.
const gate = vi.hoisted(() => ({ seq: -1, waiting: false, open: () => undefined as void, shut: Promise.resolve() }));
vi.mock('../protocol/bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../protocol/bundle')>();
  return {
    ...actual,
    openItem: async (...args: Parameters<typeof actual.openItem>) => {
      const result = await actual.openItem(...args);
      if (args[4].seq === gate.seq) {
        gate.waiting = true;
        await gate.shut;
      }
      return result;
    },
  };
});

describe('accepting bundles', () => {
  it('keeps a newer bundle’s entry when an older bundle finishes opening after it', async () => {
    gate.seq = 4;
    gate.shut = new Promise<void>((resolve) => { gate.open = resolve; });
    const room = await TestRoom.create();
    const ann = await room.person('Ann', { directPath: false });
    ann.session.stopHeartbeat();
    room.relay.join('host');
    await sleep(10);
    const state = createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' });
    state.attendees[ann.id] = { id: ann.id, name: 'Ann', role: 'guest' };
    const entry = (seq: number) => ({ t: 'personal', epoch: 1, seq, host: 'host', you: ann.id, role: 'guest', mine: {}, voted: false, acks: {}, rejects: {} });
    const bundle = (seq: number, refreshSeq: number, hostNow: number, personals: Array<{ you: string }>) => encodeBundle(
      room.hostSigner, room.roomKey,
      { epoch: 1, seq, refreshSeq, hostNow, host: 'host', boardId: BOARD, shared: sharedView(state, { online: [] }) }, personals,
    );
    const hostNow = () => (ann.session as unknown as { hostNow: number }).hostNow;
    // The older bundle is still opening Ann's entry when the newer one arrives and is accepted.
    room.relay.deliver('host', 'Ann', await bundle(4, 4, 1000, [entry(4)]));
    await waitFor(() => gate.waiting);
    room.relay.deliver('host', 'Ann', await bundle(5, 5, 2000, [entry(5)]));
    await waitFor(() => hostNow() === 2000);
    gate.open();
    await sleep(50);
    // A bundle with no entry for Ann is usable only with the entry from seq 5, its last full refresh.
    room.relay.deliver('host', 'Ann', await bundle(5, 5, 3000, []));
    await waitFor(() => hostNow() === 3000, 2000);
    expect(ann.session.state!.boardName).toBe('Team');
  });
});
