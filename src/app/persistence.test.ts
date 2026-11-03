import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardRecord, BoardStore } from '../store/board-store';
import { recordPersistence, storeNewMeeting } from './persistence';

const record = { boardId: 'board-0001' } as BoardRecord;

function memoryStore() {
  const puts: BoardRecord[] = [];
  const store = {
    put: async (r: BoardRecord) => { puts.push(r); },
    notePersistence: async (_id: string, note: 'granted' | 'refused') => { const r = { ...puts.at(-1)!, persistence: note }; puts.push(r); return r; },
  } as unknown as BoardStore;
  return { store, puts };
}

const stubPersist = (persist: unknown) => vi.stubGlobal('navigator', { storage: persist === undefined ? undefined : { persist } });

describe('recording whether the browser promised to keep a meeting', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('records granted, refused, a throw and a missing call', async () => {
    const cases: Array<[unknown, 'granted' | 'refused']> = [
      [async () => true, 'granted'], [async () => false, 'refused'], [async () => { throw new Error('no'); }, 'refused'], [undefined, 'refused'],
    ];
    for (const [persist, note] of cases) {
      stubPersist(persist);
      const { store, puts } = memoryStore();
      await store.put(record);
      expect((await recordPersistence(store, record)).persistence).toBe(note);
      expect(puts.map((p) => p.persistence)).toEqual([undefined, note]);
    }
  });

  it('saves a new meeting before the browser answers, then saves the note', async () => {
    let answer!: (granted: boolean) => void;
    stubPersist(() => new Promise<boolean>((resolve) => { answer = resolve; }));
    const { store, puts } = memoryStore();
    const done = storeNewMeeting(store, record);
    await vi.waitFor(() => expect(answer).toBeTypeOf('function'));
    // The prompt is still open: the meeting is already saved, with no note.
    expect(puts).toEqual([record]);
    answer(true);
    expect((await done).persistence).toBe('granted');
    expect(puts.map((p) => p.persistence)).toEqual([undefined, 'granted']);
  });
});
