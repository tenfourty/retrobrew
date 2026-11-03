import { generateSecretKey } from 'nostr-tools';
import { describe, expect, it } from 'vitest';
import { generateRoomKey, importRoomKey } from '../crypto/aead';
import { toB64url, type Bytes } from '../crypto/bytes';
import { generateSigningKeys, signerFrom, type Signer } from '../crypto/sign';
import { apply } from '../engine/apply';
import { createBoard } from '../engine/board';
import { REFRESH_CAP_BYTES, RELAY_EVENT_MAX_BYTES } from '../engine/limits';
import { MESSAGES } from '../engine/messages';
import { CHOICES, SOUND_IDS, TIMEBOX_MINUTES, VOTE_ALLOWANCES, type BoardState, type Command } from '../engine/types';
import { encodeBundle } from '../protocol/bundle';
import { newSid } from '../protocol/sid';
import { bundleRecipients, createSizeMeter, relayEventBytes, type Refusal, type SizeMeter } from '../protocol/size';
import { adversarialText } from '../test/fixtures';
import { mulberry32 } from '../test/mulberry32';
import { measuredApply } from './measured';
import { bundleFields, entryContext, fitBundle, personalItem } from './refresh';
import { recordOutcome, type StaleTab, type TabTable } from './tabs';

// The size meter's promise, checked against what the host really sends: for random boards reached by random
// commands, with random tabs, rejects, refused joiners and people online, the real full-refresh relay event is never
// larger than the meter's figure, and never larger than the cap once a growing command was accepted.

const KEYS = Object.keys(MESSAGES);
const NOW = 1_760_000_000_000;
const randomId = (random: () => number, length: number) =>
  toB64url(Uint8Array.from({ length: Math.ceil((length * 3) / 4) }, () => Math.floor(random() * 256))).slice(0, length);

interface World {
  state: BoardState;
  owner: string;
  people: string[];
  tabs: TabTable;
  sids: Map<string, string[]>;
  stale: Map<string, StaleTab>;
  refused: Array<Refusal & { key: string }>;
  now: number;
}

interface Kit {
  signer: Signer;
  roomKey: CryptoKey;
  nostrKey: Uint8Array;
  host: string;
  topic: string;
}

// The relay event the host would publish for a full refresh of this world, built by the sender's own code.
async function realRefreshBytes(world: World, kit: Kit, online: string[], random: () => number): Promise<number> {
  const header = {
    epoch: world.now, seq: Math.floor(random() * 1e6), refreshSeq: Math.floor(random() * 1e6), hostNow: world.now, host: kit.host,
  };
  const live = world.refused.filter((r) => r.until > world.now);
  const personals = bundleRecipients(world.state, world.owner, live).map((personId) => {
    const joinRefused = live.find((r) => r.personId === personId)?.key;
    return personalItem(world.state, personId, entryContext(world.tabs, personId, online, world.stale.get(personId), joinRefused), header);
  });
  const fields = bundleFields(world.state, header, online);
  const strangers = new Set(live.map((r) => r.personId));
  const eventBytes = (wire: Bytes) => relayEventBytes(wire, kit.host, kit.topic, kit.nostrKey);
  // Through the sender's ceiling, which a board the meter admitted never reaches: nothing is trimmed.
  const { wire, trimmed, over } = await fitBundle(personals, strangers, new Set(), (items) => encodeBundle(kit.signer, kit.roomKey, fields, items), eventBytes, RELAY_EVENT_MAX_BYTES);
  expect([trimmed, over]).toEqual([0, false]);
  return eventBytes(wire);
}

function randomCommand(world: World, random: () => number, text: (n: number) => string): { actor: string; cmd: Command } {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)];
  const topics = world.state.topics;
  const topicId = topics.length ? pick(topics).topicId : 1;
  const actor = random() < 0.3 ? world.owner : pick(world.people);
  const round = world.state.continueVote?.round ?? 1;
  const roll = random();
  if (roll < 0.12) return { actor: randomId(random, 22), cmd: { type: 'join', name: text(1 + Math.floor(random() * 60)) } };
  if (roll < 0.3) return { actor, cmd: { type: 'addTopic', text: text(1 + Math.floor(random() * 280)) } };
  if (roll < 0.36) return { actor, cmd: { type: 'editTopic', topicId, text: text(1 + Math.floor(random() * 280)) } };
  const others: Command[] = [
    { type: 'addVote', topicId }, { type: 'addVote', topicId }, { type: 'removeVote', topicId },
    { type: 'deleteTopic', topicId }, { type: 'raiseAllowance', votes: pick(VOTE_ALLOWANCES) }, { type: 'clearVotes' },
    { type: 'setShowVotes', value: random() < 0.5 }, { type: 'startDiscussion' }, { type: 'backToTopics' },
    { type: 'endMeeting' }, { type: 'reopenMeeting' }, { type: 'discussTopic', topicId, minutes: pick(TIMEBOX_MINUTES) },
    { type: 'stopTimer', topicId }, { type: 'restartTimer', topicId, minutes: pick(TIMEBOX_MINUTES) },
    { type: 'returnTopic', topicId }, { type: 'finishTopic', topicId },
    { type: 'voteToContinue', topicId, round, choice: pick(CHOICES) }, { type: 'extendTopic', topicId, round, minutes: 1 + Math.floor(random() * 5) },
    { type: 'setTimerSound', sound: pick(SOUND_IDS) },
  ];
  return { actor, cmd: pick(others) };
}

// The session-side context a command leaves behind: an ack or reject on one of up to six tabs, a stale tab, or a
// stranger refused at the door.
function touchContext(world: World, actor: string, ok: boolean, key: string | undefined, random: () => number): void {
  if (!world.state.attendees[actor]) {
    world.refused.push({ personId: actor, until: world.now + 30_000, key: key ?? 'meetingFull' });
    return;
  }
  const sids = world.sids.get(actor) ?? [];
  if (sids.length < 6 && random() < 0.4) sids.push(newSid(world.now - Math.floor(random() * 1e9)));
  world.sids.set(actor, sids);
  if (!sids.length) return;
  const sid = sids[Math.floor(random() * sids.length)];
  const clientSeq = 1 + Math.floor(random() * 1e9);
  world.tabs = recordOutcome(world.tabs, actor, sid, clientSeq, world.now, ok ? undefined : (key ?? KEYS[Math.floor(random() * KEYS.length)]));
  if (random() < 0.05) world.stale.set(actor, { sid: newSid(1), clientSeq: 1 + Math.floor(random() * 1e9), at: world.now, key: random() < 0.5 ? 'staleTab' : 'tooManyTabs' });
}

async function run(seed: number, steps: number, adversarial: boolean, meter: SizeMeter, kit: Kit): Promise<number> {
  const random = mulberry32(seed);
  const text = adversarial ? (n: number) => adversarialText(random, n) : (n: number) => 'word '.repeat(n).slice(0, n).trim() || 'x';
  const owner = randomId(random, 22);
  const world: World = {
    state: createBoard({ boardId: `property-${seed}`, boardName: text(80), ownerId: owner, ownerName: text(60) }),
    owner, people: [], tabs: {}, sids: new Map(), stale: new Map(), refused: [], now: NOW,
  };
  let checked = 0;
  for (let step = 0; step < steps; step++) {
    world.now += Math.floor(random() * 20_000);
    const { actor, cmd } = randomCommand(world, random, text);
    const before = world.state;
    const unmeasured = apply(before, actor, cmd, world.now);
    const result = await measuredApply(before, actor, cmd, world.now, meter.measure);
    if (result.ok && result.changed) {
      world.state = result.state;
      if (cmd.type === 'join' && !world.people.includes(actor) && actor !== owner) world.people.push(actor);
    }
    touchContext(world, actor, result.ok, result.ok ? undefined : result.key, random);
    const online = Object.keys(world.state.attendees).filter(() => random() < 0.8);
    const real = await realRefreshBytes(world, kit, online, random);
    const bound = await meter.measure(world.state);
    expect(real, `step ${step}: ${cmd.type}`).toBeLessThanOrEqual(bound);
    expect(real).toBeLessThan(RELAY_EVENT_MAX_BYTES);
    // A growing change the meter accepted fits the cap for real.
    if (unmeasured.ok && unmeasured.grows && result.ok) expect(real).toBeLessThanOrEqual(REFRESH_CAP_BYTES);
    // A change the meter didn't measure stays inside the figure measured before it, so the last check still holds.
    if (unmeasured.ok && unmeasured.changed && !unmeasured.grows) expect(real).toBeLessThanOrEqual(await meter.measure(before));
    checked += 1;
  }
  return checked;
}

describe('the size meter against the real sender', () => {
  it.each([1, 2, 3])('is never below a real full refresh on a random English board (seed %i)', async (seed) => {
    const meter = await createSizeMeter();
    const kit: Kit = {
      signer: await signerFrom(await generateSigningKeys(false)), roomKey: await importRoomKey(generateRoomKey()),
      nostrKey: generateSecretKey(), host: 'h'.repeat(20), topic: 'f'.repeat(32),
    };
    expect(await run(seed, 250, false, meter, kit)).toBe(250);
  }, 120_000);

  it.each([20261006, 7])('is never below a real full refresh on a random adversarial board that reaches the cap (seed %i)', async (seed) => {
    const meter = await createSizeMeter();
    const kit: Kit = {
      signer: await signerFrom(await generateSigningKeys(false)), roomKey: await importRoomKey(generateRoomKey()),
      nostrKey: generateSecretKey(), host: 'h'.repeat(20), topic: 'f'.repeat(32),
    };
    expect(await run(seed, 250, true, meter, kit)).toBe(250);
  }, 120_000);
});
