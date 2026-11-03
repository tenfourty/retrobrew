import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { generateRoomKey, importRoomKey } from '../crypto/aead';
import { fromB64url, toB64url } from '../crypto/bytes';
import { exportKeyPair, fingerprint, generateSigningKeys, importKeyPair, signerFrom } from '../crypto/sign';
import { createBoard } from '../engine/board';
import { HostSession } from '../session/host';
import { ParticipantSession } from '../session/participant';
import { FakeScheduler } from '../test/fake-scheduler';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { waitFor } from '../test/wait';
import { MemoryNetwork } from '../transport/memory';
import { newSid } from '../protocol/sid';
import { exportBoard, importBoard, mergeImported, nextEpoch, openStore, OlderVersionError, readBoardFile, saveImportedBoard, validateBoardState, type BoardRecord } from './board-store';

// These tests don't exercise the size cap; src/protocol/size.test.ts does.
const noSizeCap = () => 0;

let dbCount = 0;
const freshStore = () => openStore(`test-${++dbCount}`);

async function newRecord(): Promise<BoardRecord> {
  const pair = await generateSigningKeys(true);
  const signer = await signerFrom(pair);
  const hostId = await fingerprint(signer.pub);
  const boardId = `board-${dbCount}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    boardId, roomKey: toB64url(generateRoomKey()), hostPub: signer.pub,
    hostKeys: await exportKeyPair(pair), epoch: 0, relays: ['wss://relay.example'], updatedAt: 0,
    state: createBoard({ boardId, boardName: 'Team', ownerId: hostId, ownerName: 'Olu' }),
  };
}

describe('board store', () => {
  it('saves, lists and removes boards', async () => {
    const store = await freshStore();
    const record = await newRecord();
    await store.put(record);
    expect((await store.get(record.boardId))?.state.boardName).toBe('Team');
    expect(await store.list()).toHaveLength(1);
    await store.remove(record.boardId);
    expect(await store.get(record.boardId)).toBeUndefined();
    store.close();
  });

  it('checks a stored tab table when it is read: __proto__ and malformed keys are dropped', async () => {
    const store = await freshStore();
    const record = await newRecord();
    const sid = newSid(1_760_000_000_000);
    const tabs = JSON.parse(`{"__proto__":{"watermark":0,"tabs":{}},"ann":{"watermark":0,"tabs":{"${sid}":{"ack":2,"lastCommandAt":5},"bad-sid":{"ack":1,"lastCommandAt":5}}}}`);
    await store.put({ ...record, tabs });
    const read = (await store.get(record.boardId))!;
    expect(Object.keys(read.tabs!)).toEqual(['ann']);
    expect(Object.keys(read.tabs!.ann.tabs)).toEqual([sid]);
    expect(read.tabs!.ann.tabs[sid].ack).toBe(2);
    // A table malformed beyond its keys is left out, so the host starts with an empty one.
    await store.put({ ...record, tabs: { ann: { watermark: 'x', tabs: {} } } as never });
    expect((await store.get(record.boardId))!.tabs).toBeUndefined();
    store.close();
  });
});

describe('export and import', () => {
  it('round-trips a board with its host key', async () => {
    const record = await newRecord();
    const restored = importBoard(exportBoard(record, true));
    expect(restored).toEqual(record);
    const pair = await importKeyPair({ publicKey: restored.hostKeys.publicKey, privateKey: restored.hostKeys.privateKey! });
    expect((await signerFrom(pair)).pub).toBe(record.hostPub);
  });

  it('leaves every key out of a plain export', async () => {
    const record = await newRecord();
    const json = exportBoard(record, false);
    expect(json).not.toContain('"d"');
    expect(json).not.toContain(record.roomKey);
    expect(() => importBoard(json)).toThrow('This file has no keys, so this browser can’t run the board');
  });

  it('brings an imported board up to date', async () => {
    const record = await newRecord();
    const { phase: _phase, ...skeleton } = record.state;
    const restored = importBoard(exportBoard({ ...record, state: skeleton as BoardRecord['state'] }, true));
    expect(restored.state.phase).toBe('topics');
  });

  // Infinity and NaN reach a file as null (JSON has neither), and 1e300 is a number but not a safe integer. Each loads
  // with epoch 0, so the host's next epoch is the clock and every bundle header it sends is a valid count.
  it.each([['Infinity', 'null'], ['NaN', 'null'], ['1e300', '1e300'], ['-5', '-5'], ['1.5', '1.5'], ['"7"', '"7"']])(
    'loads an import whose epoch is %s as epoch 0, and its host is joinable', async (_name, written) => {
      const record = await newRecord();
      const json = exportBoard(record, true).replace('"epoch": 0', `"epoch": ${written}`);
      expect(json).toContain(`"epoch": ${written}`);
      const restored = importBoard(json);
      expect(restored.epoch).toBe(0);
      const epoch = nextEpoch(restored.epoch, Date.now());
      expect(Number.isSafeInteger(epoch)).toBe(true);
      const net = new MemoryNetwork();
      const roomKey = await importRoomKey(fromB64url(restored.roomKey));
      const hostSigner = await signerFrom(await importKeyPair(restored.hostKeys as { publicKey: JsonWebKey; privateKey: JsonWebKey }));
      const host = new HostSession({ transport: net.join('host'), roomKey, signer: hostSigner, hostId: await fingerprint(hostSigner.pub),
        epoch, state: restored.state, measure: noSizeCap });
      const ann = new ParticipantSession({ transport: net.join('ann'), roomKey, signer: await signerFrom(await generateSigningKeys(false)),
        hostPub: hostSigner.pub, boardId: restored.state.boardId, name: 'Ann' });
      await waitFor(() => ann.state !== null); // only a bundle or snapshot whose header passes isCount is accepted
      host.close();
    });

  it('refuses files that are not Retrobrew boards', () => {
    expect(() => importBoard('{"format":"other"}')).toThrow('This file is not a Retrobrew board');
    expect(() => importBoard('not json')).toThrow('This file is not a Retrobrew board');
  });
});

describe('importing over a hosted meeting', () => {
  it('refuses to overwrite a meeting another tab is hosting, so its saved tabs stay current', async () => {
    const store = await freshStore();
    const record = await newRecord();
    const sid = newSid(1_760_000_000_000);
    const live = { ...record, tabs: { ann: { watermark: 0, tabs: { [sid]: { ack: 5, lastCommandAt: 9 } } } } };
    await store.put(live);
    const older = { ...record, tabs: { ann: { watermark: 0, tabs: { [sid]: { ack: 2, lastCommandAt: 3 } } } } };
    await expect(saveImportedBoard(store, older, async () => true)).rejects.toThrow('This meeting is open in another tab');
    expect((await store.get(record.boardId))!.tabs!.ann.tabs[sid].ack).toBe(5);
    await saveImportedBoard(store, older, async () => false);
    expect((await store.get(record.boardId))!.tabs!.ann.tabs[sid].ack).toBe(2);
    store.close();
  });
});

// Steps the fake clock in 100 ms slices, letting the cryptography finish after each, until the condition holds.
async function until(fake: FakeScheduler, cond: () => boolean, maxMs = 60_000): Promise<void> {
  await settle(HEAVY_SETTLE_MS);
  for (let t = 0; t < maxMs && !cond(); t += 100) {
    fake.advance(100);
    await settle(HEAVY_SETTLE_MS);
  }
  if (!cond()) throw new Error('condition not reached on the fake clock');
}

describe('host resume', () => {
  it('resumes after a host reload with the same timer', async () => {
    const store = await freshStore();
    const record = await newRecord();
    const net = new MemoryNetwork();
    const roomKey = await importRoomKey(fromB64url(record.roomKey));
    const hostSigner = await signerFrom(await importKeyPair(record.hostKeys as { publicKey: JsonWebKey; privateKey: JsonWebKey }));
    const hostId = await fingerprint(hostSigner.pub);
    const fake = new FakeScheduler(Date.now());
    const persist = (r: BoardRecord) => (state: BoardRecord['state'], v: { epoch: number }) =>
      void store.put({ ...r, state, epoch: v.epoch, updatedAt: Date.now() });

    const first = new HostSession({ transport: net.join('host-1'), roomKey, signer: hostSigner, hostId, epoch: 1,
      state: record.state, onChange: persist(record), measure: noSizeCap, scheduler: fake });
    const annSigner = await signerFrom(await generateSigningKeys(false));
    const ann = new ParticipantSession({ transport: net.join('ann'), roomKey, signer: annSigner, hostPub: hostSigner.pub, boardId: record.state.boardId, name: 'Ann', scheduler: fake });
    await until(fake, () => ann.state !== null);
    await first.local({ type: 'addTopic', text: 'Keep me' });
    await first.local({ type: 'startDiscussion' });
    await first.local({ type: 'discussTopic', topicId: 1, minutes: 5 });
    await until(fake, () => ann.state?.timer !== null && ann.state?.timer !== undefined);
    const endsAt = ann.state!.timer!.endsAt;

    net.drop('host-1'); // the facilitator's tab closes

    const saved = (await store.get(record.boardId))!;
    expect(saved.epoch).toBe(1);
    const second = new HostSession({ transport: net.join('host-2'), roomKey, signer: hostSigner, hostId,
      epoch: saved.epoch + 1, state: saved.state, measure: noSizeCap, scheduler: fake });
    await until(fake, () => second.presence().length === 1);
    expect(ann.state!.topics[0].text).toBe('Keep me');
    expect(ann.state!.timer!.endsAt).toBe(endsAt);
    // Dots on a topic in Discussing are locked, so the new host proves itself with a new topic.
    expect(await ann.send({ type: 'addTopic', text: 'After the reload' })).toBe(true);
    await until(fake, () => second.current.topics.length === 2);
    store.close();
  }, 30_000);

  it('brings a board saved before the MVP up to date when it is read', async () => {
    const store = await freshStore();
    const record = await newRecord();
    const { phase: _phase, voteRound: _round, discussedOrder: _order, ...skeleton } = record.state;
    skeleton.topics = [{ topicId: 1, text: 'Old', column: 'discussing', position: 0, authorId: 'o', voters: [] }];
    await store.put({ ...record, state: skeleton as BoardRecord['state'] });
    expect((await store.get(record.boardId))?.state).toMatchObject({ phase: 'discussion', voteRound: 0, discussedOrder: [] });
    expect((await store.list())[0].state.phase).toBe('discussion');
    store.close();
  });
});

const topic = (topicId: number, extra: Record<string, unknown> = {}) =>
  ({ topicId, text: 'x', column: 'ideas', position: topicId, authorId: 'a', voters: [], ...extra });

describe('import validation', () => {
  const backup = async (change: (board: Record<string, unknown>) => void) => {
    const record = await newRecord();
    const file = JSON.parse(exportBoard(record, true)) as { board: Record<string, unknown> };
    change(file.board);
    return JSON.stringify(file);
  };
  const state = (board: Record<string, unknown>) => board.state as Record<string, unknown>;

  it('accepts a board saved before the MVP fields existed, and one with them', async () => {
    const old = await backup((b) => {
      for (const key of ['phase', 'voteRound', 'continueVote', 'timerSound', 'endedAt', 'discussedOrder', 'rehearsal']) delete state(b)[key];
    });
    expect(importBoard(old).state.topics).toEqual([]);
    const withFields = await backup((b) => {
      Object.assign(state(b), {
        topics: [topic(1)], topicIdSeed: 2,
        phase: 'discussion', voteRound: 2, timerSound: 'bell', endedAt: null, discussedOrder: [1], rehearsal: true,
        continueVote: { topicId: 1, round: 2, voters: ['x'], totals: { extend: 1, none: 0, end: 0 } },
        timer: { topicId: 1, startedAt: Date.now(), endsAt: Date.now() + 20_000, round: 2, minuteMs: 10_000 },
      });
    });
    expect(importBoard(withFields).state.timer).toMatchObject({ round: 2, minuteMs: 10_000 });
  });

  it('refuses a malformed state, field by field', async () => {
    const breakages: Array<(s: Record<string, unknown>) => void> = [
      (s) => { s.topics = [{ topicId: 'one' }]; },
      (s) => { s.topics = [{ topicId: 1, text: 'x', column: 'colNowhere', position: 0, authorId: 'a', voters: [] }]; },
      (s) => { s.attendees = { a: { id: 'a', name: 'Ann', role: 'king' } }; },
      (s) => { s.attendees = { a: { id: 'b', name: 'Ann', role: 'guest' } }; },
      (s) => { s.timer = { topicId: 1 }; },
      (s) => { s.phase = 'lunch'; },
      (s) => { s.voteRound = -1; },
      (s) => { s.continueVote = { topicId: 1, round: 1, voters: 'everyone', totals: {} }; },
      (s) => { s.discussedOrder = ['1']; },
      (s) => { s.rehearsal = 'yes'; },
      (s) => { s.timerSound = 'kazoo'; },
      (s) => { s.voteAllowance = 0; },
      (s) => { delete s.boardName; },
      (s) => { s.boardId = 'some-other-board'; },
    ];
    for (const breakage of breakages) {
      const json = await backup((b) => breakage(state(b)));
      expect(() => importBoard(json)).toThrow('This file is not a Retrobrew board');
    }
  });

  it('refuses a bad room key, host key, relay list, board ID or tab table', async () => {
    const breakages: Array<(b: Record<string, unknown>) => void> = [
      (b) => { b.roomKey = 'c2hvcnQ'; },
      (b) => { b.hostPub = 'c2hvcnQ'; },
      (b) => { b.relays = [42]; },
      (b) => { b.relays = ['https://not-a-relay.example']; },
      (b) => { b.boardId = 'bad guid!'; },
      (b) => { b.tabs = { ann: { watermark: 'x', tabs: {} } }; },
    ];
    for (const breakage of breakages) {
      const json = await backup(breakage);
      expect(() => importBoard(json)).toThrow('This file is not a Retrobrew board');
    }
  });

  it('loads a board with a bad epoch as epoch 0 rather than refusing it', async () => {
    for (const epoch of [-5, 1.5, null, '7']) {
      expect(importBoard(await backup((b) => { b.epoch = epoch; }))).toMatchObject({ epoch: 0 });
    }
  });

  it('keeps the tab table in a backup and leaves it out of a plain export', async () => {
    const record = { ...(await newRecord()), tabs: { ann: { watermark: 0, tabs: { [newSid(1_760_000_000_000)]: { ack: 2, lastCommandAt: 5 } } } } };
    expect(importBoard(exportBoard(record, true)).tabs).toEqual(record.tabs);
    expect(JSON.parse(exportBoard(record, false)).board.tabs).toBeUndefined();
  });

  it('never lowers the stored epoch when a board is imported again', async () => {
    const record = await newRecord();
    const existing = { ...record, epoch: 1_760_000_000_000 };
    expect(mergeImported(existing, { ...record, epoch: 3 }).epoch).toBe(1_760_000_000_000);
    expect(mergeImported(undefined, { ...record, epoch: 3 }).epoch).toBe(3);
    expect(mergeImported({ ...record, epoch: 2 }, { ...record, epoch: 9 }).epoch).toBe(9);
  });

  it('validateBoardState accepts the boards the engine makes', async () => {
    expect(validateBoardState((await newRecord()).state)).toBe(true);
    expect(validateBoardState(null)).toBe(false);
  });

  it('refuses duplicate card IDs', async () => {
    const json = await backup((b) => { Object.assign(state(b), { topics: [topic(1), topic(1)], topicIdSeed: 2 }); });
    expect(() => importBoard(json)).toThrow('This file is not a Retrobrew board');
  });

  it('repairs the card-ID seed, dangling timer and vote, and the finished order', async () => {
    const json = await backup((b) => {
      Object.assign(state(b), {
        topics: [topic(1), topic(5)], topicIdSeed: 3, discussedOrder: [5, 9, 5, 1],
        timer: { topicId: 7, startedAt: 1, endsAt: 2 },
        continueVote: { topicId: 8, round: 1, voters: [], totals: { extend: 0, none: 0, end: 0 } },
      });
    });
    const s = importBoard(json).state;
    expect(s.topicIdSeed).toBe(6);
    expect(s.timer).toBeNull();
    expect(s.continueVote).toBeNull();
    expect(s.discussedOrder).toEqual([5, 1]);
  });

  it('refuses reserved or mismatched attendee keys', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const json = await backup((b) => {
        state(b).attendees = JSON.parse(`{"${key}":{"id":"${key}","name":"Ann","role":"guest"}}`);
      });
      expect(() => importBoard(json)).toThrow('This file is not a Retrobrew board');
    }
  });

  it('refuses a file over 5 MB and anything past ten times the caps, but loads an over-cap board', async () => {
    const padded = await backup((b) => { b.padding = 'x'.repeat(5 * 1024 * 1024); });
    expect(() => importBoard(padded)).toThrow('This file is too big to be a Retrobrew board');
    const many = (n: number) => Array.from({ length: n }, (_, i) => topic(i + 1));
    const over = await backup((b) => { Object.assign(state(b), { topics: many(61), topicIdSeed: 62 }); });
    expect(importBoard(over).state.topics).toHaveLength(61);
    const base = await backup(() => {});
    const mutate = (json: string, change: (s: Record<string, unknown>) => void) => {
      const file = JSON.parse(json) as { board: Record<string, unknown> };
      change(state(file.board));
      return file;
    };
    for (const change of [
      (s: Record<string, unknown>) => { Object.assign(s, { topics: many(601), topicIdSeed: 602 }); },
      (s: Record<string, unknown>) => { s.attendees = Object.fromEntries(Array.from({ length: 601 }, (_, i) => [`p${i}`, { id: `p${i}`, name: 'A', role: 'guest' }])); },
      (s: Record<string, unknown>) => { Object.assign(s, { topics: [topic(1, { text: 'x'.repeat(2801) })], topicIdSeed: 2 }); },
      (s: Record<string, unknown>) => { s.boardName = 'x'.repeat(801); },
      (s: Record<string, unknown>) => { Object.assign(s, { topics: [topic(1, { voters: Array(6001).fill('a') })], topicIdSeed: 2 }); },
    ]) {
      expect(() => importBoard(JSON.stringify(mutate(base, change)))).toThrow('This file is not a Retrobrew board');
    }
    const relays = await backup((b) => { b.relays = Array(81).fill('wss://r.example'); });
    expect(() => importBoard(relays)).toThrow('This file is not a Retrobrew board');
  });

  it('bounds the vote allowance and uses safe integers', async () => {
    for (const change of [{ voteAllowance: 11 }, { topicIdSeed: 2 ** 60 }, { topics: [topic(2 ** 60)], topicIdSeed: 2 }, { topics: [topic(Number.MAX_SAFE_INTEGER - 1)], topicIdSeed: 2 }]) {
      const json = await backup((b) => { Object.assign(state(b), change); });
      expect(() => importBoard(json)).toThrow('This file is not a Retrobrew board');
    }
  });

  it('refuses host keys that cannot be imported', async () => {
    const json = await backup((b) => { (b.hostKeys as { privateKey: unknown }).privateKey = { kty: 'EC', crv: 'P-256', d: 'x', x: 'y', y: 'z' }; });
    await expect(readBoardFile(json)).rejects.toThrow('This file is not a Retrobrew board');
    await expect(readBoardFile(exportBoard(await newRecord(), true))).resolves.toBeTruthy();
  });

  it('saving an import keeps a newer stored epoch, read under the hosted check', async () => {
    const store = await freshStore();
    const record = await newRecord();
    await store.put({ ...record, epoch: 1_760_000_000_000 });
    const saved = await saveImportedBoard(store, { ...record, epoch: 3 }, async () => false);
    expect(saved.epoch).toBe(1_760_000_000_000);
    expect((await store.get(record.boardId))!.epoch).toBe(1_760_000_000_000);
    // A newer epoch written while the hosted check is pending is still seen.
    const racing = await saveImportedBoard(store, { ...record, epoch: 3 }, async () => {
      await store.put({ ...record, epoch: 2_000_000_000_000 });
      return false;
    });
    expect(racing.epoch).toBe(2_000_000_000_000);
    store.close();
  });
});

describe('import validation after review', () => {
  const backup = async (change: (board: Record<string, unknown>) => void) => {
    const record = await newRecord();
    const file = JSON.parse(exportBoard(record, true)) as { board: Record<string, unknown> };
    change(file.board);
    return JSON.stringify(file);
  };

  it('refuses a board whose state names another meeting, or an unknown timer sound', async () => {
    await expect(backup((b) => { (b.state as Record<string, unknown>).boardId = 'someone-else'; }).then(importBoard)).rejects.toThrow('not a Retrobrew board');
    await expect(backup((b) => { (b.state as Record<string, unknown>).timerSound = 'airhorn'; }).then(importBoard)).rejects.toThrow('not a Retrobrew board');
  });

  it('drops the persistence note of the browser that made the file, on export and on import', async () => {
    const record = { ...(await newRecord()), persistence: 'granted' as const };
    expect(JSON.parse(exportBoard(record, true)).board.persistence).toBeUndefined();
    expect(JSON.parse(exportBoard(record, false)).board.persistence).toBeUndefined();
    for (const note of ['granted', 'refused', 'maybe']) {
      expect(importBoard(await backup((b) => { b.persistence = note; })).persistence).toBeUndefined();
    }
  });

  it('keeps the tab table as parsed within today’s bounds', async () => {
    const tabs = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [newSid(1_760_000_000_000 + i), { ack: 1, lastCommandAt: 1_760_000_000_000 + i }]));
    const imported = importBoard(await backup((b) => { b.tabs = { ann: { watermark: 0, tabs } }; }));
    expect(Object.keys(imported.tabs!.ann.tabs)).toHaveLength(5);
  });
});

describe('noting persistence', () => {
  it('changes only the note: a host’s state written since the meeting was saved survives', async () => {
    const store = await freshStore();
    const record = await newRecord();
    await store.put(record);
    // While the browser's prompt was open, another tab started hosting and saved a newer state and epoch.
    const hosted = { ...record, epoch: 9, updatedAt: 5, state: { ...record.state, boardName: 'Renamed by the host' } };
    await store.put(hosted);
    const noted = await store.notePersistence(record.boardId, 'granted');
    expect(noted).toMatchObject({ persistence: 'granted', epoch: 9, state: { boardName: 'Renamed by the host' } });
    expect(await store.get(record.boardId)).toMatchObject({ persistence: 'granted', epoch: 9, updatedAt: 5, state: { boardName: 'Renamed by the host' } });
    expect(await store.notePersistence('no-such-board', 'refused')).toBeUndefined();
    store.close();
  });
});

// What Retrobrew saved before protocol 3 renamed its fields. It can no longer be read: only its shape matters here.
describe('boards saved before protocol 3', () => {
  it('drops the boards of a version 1 database when it upgrades, and keeps working', async () => {
    const name = `test-old-${++dbCount}`;
    const v1 = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('boards', { keyPath: 'key' });
        db.createObjectStore('device', { keyPath: 'id' });
      },
    });
    await v1.put('boards', { key: 'old-board', state: {} });
    await v1.put('device', { id: 'device', name: 'Olu' });
    v1.close();
    const store = await openStore(name);
    expect(await store.list()).toEqual([]);
    expect(await store.get('old-board')).toBeUndefined();
    expect((await store.getDevice())?.name).toBe('Olu');
    const record = await newRecord();
    await store.put(record);
    expect((await store.get(record.boardId))?.boardId).toBe(record.boardId);
    store.close();
  });

  it('refuses a version 1 backup file, saying it was made by an older version and to start a new meeting', async () => {
    const file = JSON.stringify({ format: 'retrobrew-board', version: 1, board: { roomKey: 'k' } });
    expect(() => importBoard(file)).toThrow(OlderVersionError);
    expect(() => importBoard(file)).toThrow('made by an older version of Retrobrew');
    expect(() => importBoard(file)).toThrow('start a new meeting');
    await expect(readBoardFile(file)).rejects.toThrow(OlderVersionError);
  });

  it('writes version 2 files and reads them back', async () => {
    const record = await newRecord();
    const file = exportBoard(record, true);
    expect(JSON.parse(file).version).toBe(2);
    expect(importBoard(file).boardId).toBe(record.boardId);
  });

  it('refuses an unknown file version as not a board', async () => {
    const record = await newRecord();
    expect(() => importBoard(exportBoard(record, true).replace('"version": 2', '"version": 3'))).toThrow('This file is not a Retrobrew board');
  });
});
