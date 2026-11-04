import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardRecord, BoardStore, DeviceRecord } from '../store/board-store';
import type { Bytes } from '../crypto/bytes';

// Start-up that fails part way must close what it opened: every transport opened is left again, so "Try again"
// never piles up connections. The steps after the transport are made to fail one at a time.
const failAt = vi.hoisted(() => ({ step: '' as string, open: 0 }));

vi.mock('../transport/connect', () => ({
  createRoomTransport: vi.fn(async () => {
    failAt.open += 1;
    let left = false;
    return { leave: () => { if (!left) { left = true; failAt.open -= 1; } } };
  }),
}));
vi.mock('../protocol/size', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../protocol/size')>();
  return { ...actual, createSizeMeter: vi.fn(async () => { if (failAt.step === 'meter') throw new Error('meter'); return actual.createSizeMeter(); }) };
});
vi.mock('../crypto/aead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/aead')>();
  return { ...actual, importRoomKey: vi.fn(async (key: Bytes) => { if (failAt.step === 'roomKey') throw new Error('corrupt room key'); return actual.importRoomKey(key); }) };
});
vi.mock('../crypto/sign', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto/sign')>();
  return { ...actual, fingerprint: vi.fn(async (pub: string) => { if (failAt.step === 'fingerprint') throw new Error('fingerprint'); return actual.fingerprint(pub); }) };
});

const { createBoardRecord, startHosting } = await import('./host-controller');
const { startParticipating } = await import('./participant-controller');
const { parseShareLink } = await import('../link');
const { recordLink } = await import('./host-controller');
const { StartCancelled } = await import('./startup');

function memoryStore(): BoardStore {
  const boards = new Map<string, BoardRecord>();
  let device: DeviceRecord | undefined;
  return {
    get: async (id) => boards.get(id), put: async (r) => { boards.set(r.boardId, r); },
    notePersistence: async (id, note) => { const r = boards.get(id); if (r) boards.set(id, { ...r, persistence: note }); return boards.get(id); }, list: async () => [...boards.values()],
    listJoined: async () => [], putJoined: async () => undefined, removeJoined: async () => undefined,
    remove: async (id) => { boards.delete(id); }, getDevice: async () => device, putDevice: async (d) => { device = d; }, close: () => undefined,
  };
}

const callbacks = { onState: () => undefined, onReject: () => undefined, onHostStatus: () => undefined };

describe('start-up that fails part way', () => {
  let record: BoardRecord;
  beforeEach(async () => {
    vi.stubGlobal('location', { href: 'https://retrobrew.test/app/' });
    failAt.step = '';
    record = await createBoardRecord('Team', 'Olu', []);
    failAt.step = '';
    failAt.open = 0;
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it.each(['meter', 'roomKey', 'fingerprint'])('closes the host transport when the %s step fails', async (step) => {
    failAt.step = step;
    await expect(startHosting(record, memoryStore(), () => undefined)).rejects.toThrow();
    expect(failAt.open).toBe(0);
  });

  it('leaves nothing open after three failed tries', async () => {
    failAt.step = 'roomKey';
    const store = memoryStore();
    for (let i = 0; i < 3; i++) await expect(startHosting(record, store, () => undefined)).rejects.toThrow('corrupt room key');
    expect(failAt.open).toBe(0);
  });

  it('closes the participant transport when the room key is corrupt', async () => {
    failAt.step = 'roomKey';
    const link = parseShareLink(new URL(recordLink(record, 'https://retrobrew.test/app/')).hash)!;
    for (let i = 0; i < 3; i++) await expect(startParticipating(link, 'Ann', memoryStore(), callbacks)).rejects.toThrow('corrupt room key');
    expect(failAt.open).toBe(0);
  });

  it('reports a failure after the view went away as cancelled, with the transport closed', async () => {
    failAt.step = 'roomKey';
    const controller = new AbortController();
    const pending = startHosting(record, memoryStore(), () => undefined, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(StartCancelled);
    expect(failAt.open).toBe(0);
  });
});
