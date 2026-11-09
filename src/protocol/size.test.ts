import { describe, expect, it, vi } from 'vitest';
import { apply } from '../engine/apply';
import { createBoard } from '../engine/board';
import { REFRESH_CAP_BYTES, RELAY_EVENT_MAX_BYTES } from '../engine/limits';
import type { Attendee, BoardState, Timer, Command, PersonalView, Result, SharedView } from '../engine/types';
import { measuredApply } from '../session/measured';
import { ADVERSARIAL_SEED, adversarialText, realisticBoard, sentence } from '../test/fixtures';
import { mulberry32 } from '../test/mulberry32';
import { fingerprint, generateSigningKeys, signerFrom } from '../crypto/sign';
import { TABS_PER_VIEW } from '../session/tabs';
import { bundleWireBytes, ITEM_OVERHEAD, openBundle, openItem } from './bundle';
import { deflate } from './compress';
import { utf8 } from '../crypto/bytes';
import { unseal, generateRoomKey, importRoomKey } from '../crypto/aead';
import { generateSecretKey } from 'nostr-tools';
import {
  bundleRecipients, buildStandInRefresh, createSizeMeter, ITEM_SLACK_BYTES, largestPersonal, ODD_ENTRY_SLACK_BYTES, SAMPLED_ENTRIES, largestShared, MARGIN_BYTES, MARGIN_RATIO,
  PERSON_ID_CHARS, REFUSED_ENTRIES_MAX, relayEventBytes, relayEventBytesFor, StandIns, standInEventBytes, TOPIC_PLACEHOLDER, type SizeMeter,
} from './size';

// Every key of PersonalView and SharedView, checked against the types at compile time: adding a field to either
// type without adding it here fails the type check, and then the tests below make the meter cover it.
const PERSONAL_KEYS = ['you', 'role', 'mine', 'voted', 'totals', 'acks', 'rejects', 'joinRefused'] as const;
const SHARED_KEYS = ['boardId', 'boardName', 'phase', 'voteAllowance', 'showVotes', 'rehearsal', 'timerSound', 'endedAt',
  'discussedOrder', 'topics', 'attendees', 'online', 'timer', 'vote'] as const;
type Exhaustive<T, K extends readonly unknown[]> = Exclude<keyof T, K[number]> extends never ? true : false;
const personalKeysComplete: Exhaustive<PersonalView, typeof PERSONAL_KEYS> = true;
const sharedKeysComplete: Exhaustive<SharedView, typeof SHARED_KEYS> = true;

type Keys<T, K extends readonly unknown[]> = Exclude<keyof T, K[number]> extends never ? true : false;
const TOPIC_KEYS = ['topicId', 'text', 'column', 'position', 'authorId', 'votes'] as const;
const ATTENDEE_KEYS = ['id', 'name', 'role'] as const;
const TIMER_KEYS = ['topicId', 'startedAt', 'endsAt', 'round', 'minuteMs'] as const;
const VOTE_KEYS = ['topicId', 'round', 'turnout'] as const;
const topicKeysComplete: Keys<SharedView['topics'][number], typeof TOPIC_KEYS> = true;
const attendeeKeysComplete: Keys<Attendee, typeof ATTENDEE_KEYS> = true;
const timerKeysComplete: Keys<Timer, typeof TIMER_KEYS> = true;
const voteKeysComplete: Keys<NonNullable<SharedView['vote']>, typeof VOTE_KEYS> = true;

const NOW = 1_760_000_000_000;

async function must(meter: SizeMeter, state: BoardState, actor: string, cmd: Command): Promise<BoardState> {
  const result = await measuredApply(state, actor, cmd, NOW, meter.measure);
  if (!result.ok) throw new Error(result.key);
  return result.state;
}

describe('size meter', () => {
  it('measures the realistic fixture (30 topics, 15 people, every entry at its largest) under 16 KB', async () => {
    const meter = await createSizeMeter();
    const size = await meter.measure(realisticBoard());
    expect(size).toBeGreaterThan(5_000);
    expect(size).toBeLessThan(16_000);
  });

  it('grows with every attendee’s entry and every topic', async () => {
    const meter = await createSizeMeter();
    const board = realisticBoard();
    const fewer = structuredClone(board);
    const [lastGuest] = Object.keys(fewer.attendees).filter((id) => fewer.attendees[id].role === 'guest').slice(-1);
    delete fewer.attendees[lastGuest];
    expect(await meter.measure(fewer)).toBeLessThan(await meter.measure(board));
    expect(await meter.measure({ ...board, topics: board.topics.slice(1) })).toBeLessThan(await meter.measure(board));
  });

  it('adversarial topics: the cap refuses a topic before any full refresh passes 44 KB, and leaves the board unchanged', async () => {
    const meter = await createSizeMeter();
    const random = mulberry32(ADVERSARIAL_SEED);
    let state = createBoard({ boardId: 'adversarial-1', boardName: adversarialText(random, 80), ownerId: 'owner', ownerName: adversarialText(random, 60) });
    for (let i = 1; i < 15; i++) state = await must(meter, state, `guest-${i}`, { type: 'join', name: adversarialText(random, 60) });
    let accepted = 0;
    let refused: Result | null = null;
    while (!refused) {
      const before = JSON.stringify(state);
      const result = await measuredApply(state, 'owner', { type: 'addTopic', text: adversarialText(random, 280) }, NOW, meter.measure);
      if (!result.ok) {
        refused = result;
        expect(JSON.stringify(state)).toBe(before);
        break;
      }
      state = result.state;
      accepted += 1;
      const size = await meter.measure(state);
      expect(size).toBeLessThanOrEqual(REFRESH_CAP_BYTES);
      expect(size).toBeLessThan(RELAY_EVENT_MAX_BYTES);
    }
    expect(refused).toMatchObject({ ok: false, key: 'boardFull' });
    // The cap, not the 60-topic limit, is what stops this board.
    expect(accepted).toBeGreaterThanOrEqual(15);
    expect(accepted).toBeLessThan(60);
  }, 60_000);

  it('adversarial people: on a board of long topics, the cap refuses a join before any full refresh passes 44 KB', async () => {
    const meter = await createSizeMeter();
    const random = mulberry32(ADVERSARIAL_SEED + 1);
    let state = createBoard({ boardId: 'adversarial-2', boardName: adversarialText(random, 80), ownerId: 'owner', ownerName: adversarialText(random, 60) });
    for (let i = 0; i < 20; i++) state = await must(meter, state, 'owner', { type: 'addTopic', text: adversarialText(random, 280) });
    let refused: Result | null = null;
    for (let i = 1; i < 60 && !refused; i++) {
      const before = JSON.stringify(state);
      const result = await measuredApply(state, `guest-${i}`, { type: 'join', name: adversarialText(random, 60) }, NOW, meter.measure);
      if (!result.ok) {
        refused = result;
        expect(JSON.stringify(state)).toBe(before);
        break;
      }
      state = result.state;
      expect(await meter.measure(state)).toBeLessThanOrEqual(REFRESH_CAP_BYTES);
    }
    expect(refused).toMatchObject({ ok: false, key: 'meetingFullSize' });
    expect(Object.keys(state.attendees).length).toBeGreaterThan(5);
    expect(Object.keys(state.attendees).length).toBeLessThan(60);
  }, 60_000);

  it('adversarial people without topics: the cap stops joins of long four-byte names before 60, and never passes 44 KB', async () => {
    const meter = await createSizeMeter();
    const random = mulberry32(ADVERSARIAL_SEED + 2);
    let state = createBoard({ boardId: 'adversarial-3', boardName: adversarialText(random, 80), ownerId: 'owner', ownerName: adversarialText(random, 60) });
    let refused: Result | null = null;
    for (let i = 1; i < 60 && !refused; i++) {
      const before = JSON.stringify(state);
      const result = await measuredApply(state, `guest-${i}`, { type: 'join', name: adversarialText(random, 60) }, NOW, meter.measure);
      if (!result.ok) {
        refused = result;
        expect(JSON.stringify(state)).toBe(before);
        break;
      }
      state = result.state;
      expect(await meter.measure(state)).toBeLessThanOrEqual(REFRESH_CAP_BYTES);
    }
    expect(refused).toMatchObject({ ok: false, key: 'meetingFullSize' });
    expect(Object.keys(state.attendees).length).toBeLessThan(60);
  }, 60_000);

  it('with short test IDs (guest-3, not a live meeting\'s fingerprints) and short names, 60 people fit the cap, and the 61st join is refused for the limit', async () => {
    const meter = await createSizeMeter();
    let state = createBoard({ boardId: 'short-names', boardName: 'Team', ownerId: 'owner', ownerName: 'Owner' });
    for (let i = 1; i < 60; i++) state = await must(meter, state, `guest-${i}`, { type: 'join', name: `Guest${String(i).padStart(2, '0')}` });
    expect(Object.keys(state.attendees)).toHaveLength(60);
    expect(await meter.measure(state)).toBeLessThanOrEqual(REFRESH_CAP_BYTES);
    expect(await measuredApply(state, 'one-too-many', { type: 'join', name: 'Late' }, NOW, meter.measure)).toMatchObject({ ok: false, key: 'meetingFull' });
  }, 60_000);

  it('measures only changes the engine marks as growing', async () => {
    const meter: SizeMeter = { measure: async () => { throw new Error('should not be measured'); } };
    const state = createBoard({ boardId: 'b1', boardName: 'Team', ownerId: 'owner', ownerName: 'Olu' });
    expect((await measuredApply(state, 'owner', { type: 'setShowVotes', value: false }, NOW, meter.measure)).ok).toBe(true);
    expect((await measuredApply(state, 'owner', { type: 'join', name: 'Olu' }, NOW, meter.measure)).ok).toBe(true);
  });

  it('refuses growth when the measure fails, rather than failing the change', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const state = createBoard({ boardId: 'b1', boardName: 'Team', ownerId: 'owner', ownerName: 'Olu' });
    const result = await measuredApply(state, 'owner', { type: 'addTopic', text: 'Unmeasurable' }, NOW, async () => { throw new Error('no CompressionStream'); });
    expect(result).toMatchObject({ ok: false, key: 'boardFull' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('the largest entry and shared part', () => {
  const board = () => realisticBoard();

  it('give every field of an entry its largest form', () => {
    expect(personalKeysComplete && sharedKeysComplete).toBe(true);
    const entry = largestPersonal(board(), 'person-1');
    for (const key of PERSONAL_KEYS) expect(entry[key], key).toBeDefined();
    expect(entry.voted).toBe(false);
    expect(entry.role).toBe('facilitator');
    expect(Object.keys(entry.acks as object)).toHaveLength(TABS_PER_VIEW);
    expect(Object.keys(entry.rejects as object)).toHaveLength(TABS_PER_VIEW);
    expect(Object.values(entry.mine as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it('give every field of the shared part its largest form, whatever the phase or settings', () => {
    const shared = largestShared({ ...board(), phase: 'topics', showVotes: false, timer: null, continueVote: null });
    for (const key of SHARED_KEYS) {
      expect(shared[key], key).toBeDefined();
      expect(shared[key], key).not.toBeNull();
    }
    expect(topicKeysComplete && attendeeKeysComplete && timerKeysComplete && voteKeysComplete).toBe(true);
    for (const key of TOPIC_KEYS) expect(shared.topics[0][key], key).toBeDefined();
    for (const key of ATTENDEE_KEYS) expect(Object.values(shared.attendees)[0][key], key).toBeDefined();
    for (const key of TIMER_KEYS) expect(shared.timer![key], key).toBeDefined();
    for (const key of VOTE_KEYS) expect(shared.vote![key], key).toBeDefined();
    expect(shared.online).toHaveLength(15);
    expect(shared.discussedOrder).toHaveLength(30);
    expect(shared.topics.every((t) => t.votes === 15 * 10 && t.column === 'discussing')).toBe(true);
    expect(shared.phase).toBe('discussion');
  });

  it('measures the same board within a few bytes every time (only the random signatures vary)', async () => {
    const meter = await createSizeMeter();
    const sizes = await Promise.all([1, 2, 3, 4].map(() => meter.measure(board())));
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(32);
  });
});

describe('the stand-in refresh', () => {
  it('is a bundle every stand-in entry of which opens under the bundle’s host, epoch and seq', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const signer = await signerFrom(await generateSigningKeys(false));
    const state = realisticBoard();
    const wire = await buildStandInRefresh(state, signer, roomKey);
    const opened = await openBundle((await unseal(roomKey, wire)).slice(1), signer.pub);
    expect(opened).not.toBeNull();
    const { host, epoch, seq } = opened!.message;
    const ids = bundleRecipients(state, 'owner', []);
    let found = 0;
    for (const item of opened!.items) {
      for (const id of ids) if (await openItem(roomKey, signer.pub, item, id, { host, epoch, seq })) found += 1;
    }
    expect(found).toBe(ids.length);
    expect(opened!.items).toHaveLength(ids.length + REFUSED_ENTRIES_MAX);
  });
});

describe('bundleRecipients', () => {
  it('is every attendee but the host, and the latest refused joiners up to the limit', () => {
    const state = realisticBoard();
    const refused = ['s1', 's2', 's3', 's4', 'person-2'].map((personId, i) => ({ personId, until: i }));
    const recipients = bundleRecipients(state, 'owner', refused);
    expect(recipients).not.toContain('owner');
    expect(recipients.filter((id) => !state.attendees[id])).toEqual(['s4', 's3', 's2'].slice(0, REFUSED_ENTRIES_MAX));
    expect(recipients.filter((id) => id === 'person-2')).toHaveLength(1);
  });

  it('uses stand-in IDs as long as real ones', async () => {
    const id = await fingerprint((await signerFrom(await generateSigningKeys(false))).pub);
    expect(id).toHaveLength(PERSON_ID_CHARS);
  });
});

describe('adversarialText', () => {
  it('draws code points from the four ranges in turn, the same for a seed', () => {
    const text = adversarialText(mulberry32(ADVERSARIAL_SEED), 8);
    const points = [...text].map((c) => c.codePointAt(0)!);
    expect(points).toHaveLength(8);
    const inRange = (p: number, lo: number, hi: number) => p >= lo && p <= hi;
    points.forEach((p, i) => {
      const ranges = [[0x4e00, 0x9fff], [0x1f300, 0x1faff], [0x20000, 0x2a6df], [0x4e00, 0x9fff]];
      const [lo, hi] = ranges[i % 4];
      expect(inRange(p, lo, hi)).toBe(true);
    });
    expect(adversarialText(mulberry32(ADVERSARIAL_SEED), 8)).toBe(text);
  });
});

// The cheap meter (two deflates, fixed overheads) against the figure it replaces (the stand-in bundle built, signed
// and sealed for real, with other random stand-ins each time).
const FINGERPRINT_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('the cheap size meter', () => {
  const NOW_BOARD = () => realisticBoard();

  // Boards of every size: from one person to 60, from no topic to 60, plain, repetitive and incompressible text.
  function boards(): Array<{ label: string; state: BoardState }> {
    const out: Array<{ label: string; state: BoardState }> = [];
    const random = mulberry32(ADVERSARIAL_SEED + 9);
    const texts: Array<[string, (n: number) => string]> = [
      ['incompressible', (n) => adversarialText(random, n)],
      ['repetitive', (n) => 'word '.repeat(n).slice(0, n).trim() || 'x'],
      ['ascii random', (n) => Array.from({ length: n }, () => String.fromCharCode(33 + Math.floor(random() * 94))).join('')],
    ];
    for (const [name, text] of texts) {
      for (const [people, topics, topicLength, nameLength] of [[1, 60, 280, 60], [15, 30, 120, 20], [60, 0, 1, 60], [60, 20, 280, 60], [20, 60, 280, 60]]) {
        let state = createBoard({ boardId: `cheap-${name}-${people}-${topics}`, boardName: text(80), ownerId: 'owner', ownerName: text(nameLength) });
        for (let i = 1; i < people; i++) state = direct(state, new StandIns(ADVERSARIAL_SEED + i).text(FINGERPRINT_ALPHABET, 22), { type: 'join', name: text(nameLength) });
        for (let i = 0; i < topics; i++) state = direct(state, 'owner', { type: 'addTopic', text: text(topicLength) });
        out.push({ label: `${name} ${people} people ${topics} topics`, state });
      }
    }
    // Imported boards can hold IDs of any content and length (src/store/board-store.ts, MAX_ID).
    const random2 = mulberry32(ADVERSARIAL_SEED + 10);
    const randomId = (n: number) => Array.from({ length: n }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[Math.floor(random2() * 64)]).join('');
    for (const [label, first, others, count] of [
      ['long repetitive first ID, 250-character random others', 'a'.repeat(251), () => randomId(250), 44],
      ['mix of 22-character and long IDs', randomId(22), () => (random2() < 0.5 ? randomId(22) : randomId(250)), 40],
      ['1,280-character repetitive IDs', 'b'.repeat(1280), () => 'b'.repeat(1280), 12],
    ] as const) {
      let state = createBoard({ boardId: 'long-ids', boardName: 'Team', ownerId: 'owner', ownerName: 'Owner' });
      state = direct(state, first, { type: 'join', name: 'First' });
      for (let i = 1; i < count; i++) state = direct(state, others(), { type: 'join', name: `Guest${i}` });
      out.push({ label, state });
    }
    out.push({ label: 'realistic', state: NOW_BOARD() });
    return out;
  }

  // The engine's own apply, for building a board without the size cap.
  function direct(state: BoardState, actor: string, cmd: Command): BoardState {
    const result = apply(state, actor, cmd, NOW);
    if (!result.ok) throw new Error(result.key);
    return result.state;
  }

  it('lays a bundle out exactly as bundleWireBytes and relayEventBytesFor say', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const signer = await signerFrom(await generateSigningKeys(false));
    const nostrKey = generateSecretKey();
    for (const state of [realisticBoard(), boards()[0].state]) {
      const wire = await buildStandInRefresh(state, signer, roomKey);
      const body = (await unseal(roomKey, wire)).slice(1);
      const outerLength = new DataView(body.buffer, body.byteOffset).getUint32(0);
      const opened = await openBundle(body, signer.pub);
      expect(bundleWireBytes(outerLength, opened!.items.map((item) => item.length - ITEM_OVERHEAD))).toBe(wire.length);
      expect(relayEventBytesFor(wire.length, 'h'.repeat(20), TOPIC_PLACEHOLDER)).toBe(relayEventBytes(wire, 'h'.repeat(20), TOPIC_PLACEHOLDER, nostrKey));
    }
  }, 60_000);

  it('seals, signs and hashes nothing, and deflates the outer message and the sampled entries when every ID is a fingerprint, once more for any other ID', async () => {
    const meter = await createSizeMeter();
    const board = boards().find((b) => b.label.startsWith('ascii random 15'))!.state;
    const spies = (['sign', 'encrypt', 'digest'] as const).map((name) => vi.spyOn(crypto.subtle, name));
    const streams = vi.spyOn(globalThis, 'CompressionStream');
    await meter.measure(board);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(streams).toHaveBeenCalledTimes(1 + SAMPLED_ENTRIES);
    streams.mockClear();
    const odd = structuredClone(board);
    const [first] = Object.keys(odd.attendees).filter((id) => odd.attendees[id].role !== 'owner');
    odd.attendees[first] = { ...odd.attendees[first], id: 'person-1' };
    odd.attendees['person-1'] = odd.attendees[first];
    delete odd.attendees[first];
    await meter.measure(odd);
    expect(streams).toHaveBeenCalledTimes(2 + SAMPLED_ENTRIES);
    for (const spy of [...spies, streams]) spy.mockRestore();
  });

  it('the sampled maximum: SAMPLED_ENTRIES draws, each entry given the largest and ITEM_SLACK_BYTES, cover the sum of the board\'s own entries', async () => {
    const boardsToTry = [boards().find((b) => b.label.startsWith('incompressible 20 people'))!, boards().find((b) => b.label.startsWith('ascii random 15 people'))!, boards()[0]];
    const entry = async (state: BoardState, s: StandIns) => (await deflate(utf8(JSON.stringify(largestPersonal(state, s.text(FINGERPRINT_ALPHABET, 22), s))))).length;
    for (const { label, state } of boardsToTry) {
      const n = Math.max(bundleRecipients(state, 'owner', []).length, 3) + REFUSED_ENTRIES_MAX;
      let tightest = Infinity;
      let singleDrawWorst = Infinity;
      for (let trial = 1; trial <= 60; trial++) {
        const s = new StandIns(trial * 7919);
        const sampled: number[] = [];
        for (let k = 0; k < SAMPLED_ENTRIES; k++) sampled.push(await entry(state, s));
        let real = 0;
        for (let i = 0; i < n; i++) real += await entry(state, s);
        tightest = Math.min(tightest, n * (Math.max(...sampled) + ITEM_SLACK_BYTES) - real);
        singleDrawWorst = Math.min(singleDrawWorst, n * (sampled[0] + ITEM_SLACK_BYTES) - real);
      }
      console.info(`${label}: ${n} entries, smallest cover over 60 trials ${tightest} bytes (one draw alone: ${singleDrawWorst})`);
      expect(tightest, label).toBeGreaterThanOrEqual(0);
    }
  }, 120_000);

  it('odd-ID entries (plain IDs such as guest-3): the figure is never below the real sealed event, whatever the seeds', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const signer = await signerFrom(await generateSigningKeys(false));
    const nostrKey = generateSecretKey();
    let state = createBoard({ boardId: 'plain', boardName: 'Team', ownerId: 'owner', ownerName: 'Owner' });
    for (let i = 1; i < 60; i++) state = direct(state, `guest-${i}`, { type: 'join', name: `Attendee${String(i).padStart(2, '0')}` });
    let tightest = Infinity;
    for (let seed = 1; seed <= 40; seed++) {
      const real = relayEventBytes(await buildStandInRefresh(state, signer, roomKey, new StandIns(seed * 7_368_787)), 'h'.repeat(20), TOPIC_PLACEHOLDER, nostrKey);
      tightest = Math.min(tightest, (await standInEventBytes(state, new StandIns(seed * 2_750_159 + 3))) - real);
    }
    console.info(`plain IDs, 60 people: smallest raw cover over 40 seeds ${tightest} bytes`);
    expect(tightest).toBeGreaterThanOrEqual(0);
  }, 180_000);

  it('is never below the real, sealed stand-in refresh for many boards and random stand-ins, and costs no more than ODD_ENTRY_SLACK_BYTES an entry', async () => {
    const meter = await createSizeMeter();
    const roomKey = await importRoomKey(generateRoomKey());
    const signer = await signerFrom(await generateSigningKeys(false));
    const nostrKey = generateSecretKey();
    for (const { label, state } of boards()) {
      const reals: number[] = [];
      for (let seed = 1; seed <= 3; seed++) {
        const real = relayEventBytes(await buildStandInRefresh(state, signer, roomKey, new StandIns(seed * 104_729)), 'h'.repeat(20), TOPIC_PLACEHOLDER, nostrKey);
        reals.push(real);
        // Even before the margin, the cheap figure (with other random stand-ins) is no lower than the real one.
        expect(await standInEventBytes(state, new StandIns(seed * 15_485_863)), `${label}, seed ${seed}`).toBeGreaterThanOrEqual(real);
      }
      const old = Math.max(...reals) + Math.ceil(Math.max(...reals) * MARGIN_RATIO) + MARGIN_BYTES;
      const cheap = await meter.measure(state);
      expect(cheap, label).toBeGreaterThanOrEqual(old);
      // What the bound costs: the largest of the sampled entries over a typical one, a few bytes (in base64url) for each entry.
      const entries = bundleRecipients(state, 'owner', []).length + REFUSED_ENTRIES_MAX;
      console.info(`${label}: ${entries} entries, figure with real seals ${old}, cheap figure ${cheap} (+${cheap - old})`);
      expect(cheap - old, label).toBeLessThanOrEqual(Math.ceil((entries * ODD_ENTRY_SLACK_BYTES * 4) / 3) + 400);
    }
  }, 180_000);
});

// docs/product/sync-protocol.md, Size, "The measured arithmetic": the table's figures are the meter's bounds for these
// boards. The meter's random stand-ins move a figure by a few bytes, so each is pinned within 1 %, and the table's
// "over the cap" and "inside the cap" remarks are pinned exactly.
describe('the measured arithmetic table', () => {
  // A live person's ID is a 22-character fingerprint (random base64url); `plain` IDs such as "guest-3" compress far
  // better and are not what a live meeting has. The IDs here are drawn from a seeded generator, the same on every run.
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function fingerprintId(i: number): string {
    const random = mulberry32(0x5eed + i);
    return Array.from({ length: PERSON_ID_CHARS }, () => B64[Math.floor(random() * 64)]).join('');
  }
  type Ids = 'fingerprint' | 'plain';
  function board(people: number, name: (i: number) => string, topics: number, topic: (i: number) => string, ids: Ids = 'fingerprint'): BoardState {
    const id = (i: number) => (ids === 'fingerprint' ? fingerprintId(i) : i === 0 ? 'owner' : `guest-${i}`);
    let state = createBoard({ boardId: 'table', boardName: 'Team', ownerId: id(0), ownerName: name(0) });
    for (let i = 1; i < people; i++) {
      const joined = apply(state, id(i), { type: 'join', name: name(i) }, NOW);
      if (!joined.ok) throw new Error(joined.key);
      state = joined.state;
    }
    for (let i = 0; i < topics; i++) {
      const added = apply(state, id(0), { type: 'addTopic', text: topic(i) }, NOW);
      if (!added.ok) throw new Error(added.key);
      state = added.state;
    }
    return state;
  }
  const adversarial = (nameLength: number, topicLength: number) => {
    const random = mulberry32(ADVERSARIAL_SEED);
    return { name: () => adversarialText(random, nameLength), topic: () => adversarialText(random, topicLength) };
  };
  const ascii16 = (i: number) => `Attendee${String(i).padStart(8, '0')}`;
  const ascii10 = (i: number) => `Attendee${String(i).padStart(2, '0')}`;
  const english60 = (i: number) => sentence(i, 60);

  // Every board but the "plain IDs" row has live-style fingerprint IDs.
  const rows: Array<{ label: string; state: () => BoardState; bytes: number; fits: boolean }> = [
    { label: '60 attendees, 60-character adversarial names, no topics', bytes: 58_339, fits: false,
      state: () => { const a = adversarial(60, 1); return board(60, a.name, 0, a.topic); } },
    { label: '60 attendees, 16-character ASCII names, no topics', bytes: 44_786, fits: true,
      state: () => board(60, ascii16, 0, english60) },
    { label: '15 adversarial people, 10 adversarial topics of 280', bytes: 27_460, fits: true,
      state: () => { const a = adversarial(60, 280); return board(15, a.name, 10, a.topic); } },
    { label: '15 adversarial people, 20 topics', bytes: 37_040, fits: true,
      state: () => { const a = adversarial(60, 280); return board(15, a.name, 20, a.topic); } },
    { label: '30 adversarial people, 20 topics', bytes: 51_153, fits: false,
      state: () => { const a = adversarial(60, 280); return board(30, a.name, 20, a.topic); } },
    { label: '60 people with 10-character names, 60 topics of 60 characters', bytes: 48_168, fits: false,
      state: () => board(60, ascii10, 60, english60) },
    { label: '60 people with 10-character names, 60 topics of 60 characters, plain IDs (guest-3), not what a live meeting has', bytes: 47_003, fits: false,
      state: () => board(60, ascii10, 60, english60, 'plain') },
    { label: '60 people with 10-character names, no topics', bytes: 44_800, fits: true,
      state: () => board(60, ascii10, 0, english60) },
    { label: '58 people with 10-character names, no topics', bytes: 43_245, fits: true,
      state: () => board(58, ascii10, 0, english60) },
    { label: '55 people with 10-character names, 60 topics of 60 characters', bytes: 44_679, fits: true,
      state: () => board(55, ascii10, 60, english60) },
    { label: '56 people with 10-character names, 60 topics of 60 characters', bytes: 45_246, fits: false,
      state: () => board(56, ascii10, 60, english60) },
    { label: '53 people with 10-character names, 60 topics of 60 characters', bytes: 42_993, fits: true,
      state: () => board(53, ascii10, 60, english60) },
    { label: '54 people with 10-character names, 60 topics of 60 characters', bytes: 43_793, fits: true,
      state: () => board(54, ascii10, 60, english60) },
    { label: '50 people with 10-character names, 60 topics of 60 characters', bytes: 40_804, fits: true,
      state: () => board(50, ascii10, 60, english60) },
    { label: '30 people with 10-character names, 60 topics of 60 characters', bytes: 26_237, fits: true,
      state: () => board(30, ascii10, 60, english60) },
  ];

  // The meter's figure is an upper bound on the real sealed event for the table's boards too (live-style
  // fingerprint IDs, 60 people with 60 topics, adversarial text), whichever random stand-ins either side draws.
  it('is never below the real, sealed stand-in event for the table\'s boards, whatever the seeds', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const signer = await signerFrom(await generateSigningKeys(false));
    const nostrKey = generateSecretKey();
    const a = adversarial(60, 280);
    const boards: Array<[string, BoardState]> = [
      ['60 people, 60 topics, fingerprint IDs', board(60, ascii10, 60, english60)],
      ['60 people, no topics', board(60, ascii16, 0, english60)],
      ['54 people, 60 topics', board(54, ascii10, 60, english60)],
      ['30 adversarial people, 20 topics', board(30, a.name, 20, a.topic)],
    ];
    for (const [label, state] of boards) {
      for (let seed = 1; seed <= 6; seed++) {
        const real = relayEventBytes(await buildStandInRefresh(state, signer, roomKey, new StandIns(seed * 7_368_787)), 'h'.repeat(20), TOPIC_PLACEHOLDER, nostrKey);
        const figure = await standInEventBytes(state, new StandIns(seed * 2_750_159 + 3));
        expect(figure, `${label}, seed ${seed}`).toBeGreaterThanOrEqual(real);
      }
    }
  }, 180_000);

  for (const row of rows) {
    it(`${row.label}: about ${row.bytes} bytes, ${row.fits ? 'inside' : 'over'} the cap`, async () => {
      const size = await (await createSizeMeter()).measure(row.state());
      expect(Math.abs(size - row.bytes) / row.bytes).toBeLessThan(0.01);
      expect(size <= REFRESH_CAP_BYTES).toBe(row.fits);
    }, 60_000);
  }
});
