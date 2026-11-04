import { describe, expect, it } from 'vitest';
import type { Bytes } from '../crypto/bytes';
import { generateSigningKeys, signerFrom } from '../crypto/sign';
import { apply } from '../engine/apply';
import { createBoard } from '../engine/board';
import type { BoardState, Command } from '../engine/types';
import { openBundle, openItem } from '../protocol/bundle';
import { decodeFrame, encodeWire, sealEnvelope } from '../protocol/envelope';
import { newSid, sidCreatedAt } from '../protocol/sid';
import { PROTOCOL_VERSION } from '../protocol/version';
import { FakeScheduler } from '../test/fake-scheduler';
import { fresh } from '../test/hello';
import { BOARD, TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { waitFor } from '../test/wait';
import { PEER_RECORD_TTL_MS, PEER_RECORDS_PER_SIGNER, type HostSession } from './host';
import { PRUNE_AFTER_MS, recordOutcome } from './tabs';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

// Runs the fake clock in small steps, while the real event loop does the cryptography.
async function step(scheduler: FakeScheduler, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 100) {
    scheduler.advance(Math.min(100, ms - t));
    await settle(HEAVY_SETTLE_MS);
  }
}

async function stepUntil(scheduler: FakeScheduler, condition: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t < maxMs && !condition(); t += 100) await step(scheduler, 100);
  expect(condition()).toBe(true);
}

// Waits for the ping a tab sends on its hello's reply to end its record's probation, and for the pong and full view
// that answer it, so none of them lands later.
async function settled(host: HostSession, peer: string, personId: string): Promise<void> {
  await waitFor(() => (host as unknown as { peers: Map<string, { probation: boolean }> }).peers.get(`${peer} ${personId}`)?.probation === false);
  await settle(HEAVY_SETTLE_MS);
}

// The `you` of every snapshot in these frames.
async function viewsFor(room: TestRoom, frames: Bytes[]): Promise<string[]> {
  const out: string[] = [];
  for (const data of frames) {
    const frame = await decodeFrame(room.roomKey, data);
    if (frame?.kind !== 'envelope') continue;
    const msg = JSON.parse(frame.env.body) as { t: string; you?: string };
    if (msg.t === 'snapshot') out.push(msg.you!);
  }
  return out;
}

// Every relay bundle in these frames, and the entry it carries for personId, if any. Bundles are relay broadcasts, so
// every peer on the relay receives them; what matters is whose entries they carry.
async function bundleEntries(room: TestRoom, frames: Bytes[], personId: string): Promise<{ bundles: number; entries: Array<Record<string, unknown>> }> {
  let bundles = 0;
  const entries: Array<Record<string, unknown>> = [];
  for (const data of frames) {
    const frame = await decodeFrame(room.roomKey, data);
    if (frame?.kind !== 'bundle') continue;
    const opened = await openBundle(frame.body, room.hostSigner.pub);
    if (!opened) continue;
    bundles += 1;
    for (const item of opened.items) {
      const entry = await openItem(room.roomKey, room.hostSigner.pub, item, personId, opened.message);
      if (entry) entries.push(entry);
    }
  }
  return { bundles, entries };
}

// A personal entry with none of the person's own data: no dots, ballot, totals, acks or rejects.
function expectNeutral(entry: Record<string, unknown>): void {
  expect(entry.mine).toEqual({});
  expect(entry.voted).toBe(false);
  expect(entry.totals).toBeUndefined();
  expect(entry.acks).toEqual({});
  expect(entry.rejects).toEqual({});
}

// Frames the host sends to one transport peer, on either path.
function framesTo(room: TestRoom, peer: string): Bytes[] {
  const frames: Bytes[] = [];
  const tap = (from: string, to: string, data: Bytes) => { if (from === 'host' && to === peer) frames.push(data); };
  room.direct.tap = room.relay.tap = tap;
  return frames;
}

describe('peer records are keyed by transport peer and signing key', () => {
  it('binds nothing for a command replayed from another peer, and sends that peer no view', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    const bob = await room.person('Bob');
    await waitFor(() => joined(ann) && joined(bob));
    const fromAnn: Bytes[] = [];
    room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') fromAnn.push(data); };
    await ann.session.send({ type: 'addTopic', text: 'Ann’s' });
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    const captured = fromAnn[fromAnn.length - 1];
    const toBob = framesTo(room, 'Bob');
    const mallory = room.direct.join('mallory');
    await waitFor(() => mallory.peers().includes('host'));
    const toMallory = framesTo(room, 'mallory');
    room.direct.tap = room.relay.tap = (from, to, data) => {
      if (from === 'host' && to === 'Bob') toBob.push(data);
      if (from === 'host' && to === 'mallory') toMallory.push(data);
    };
    // Replayed from Bob's own peer, and from a peer that never said hello.
    room.direct.deliver('Bob', 'host', captured);
    mallory.send('host', captured);
    await settle(HEAVY_SETTLE_MS);
    await host.local({ type: 'setShowVotes', value: false });
    await waitFor(() => ann.session.state!.showVotes === false && bob.session.state!.showVotes === false);
    await settle(HEAVY_SETTLE_MS);
    expect(await viewsFor(room, toBob)).not.toContain(ann.id);
    expect(toMallory).toEqual([]);
    expect(host.presence().filter((p) => p.participantId === ann.id).map((p) => p.peerId)).toEqual(['Ann']);
    expect(host.presence().some((p) => p.peerId === 'mallory')).toBe(false);
  });

  it('keeps the real peer’s record when someone else forges its relay `from`', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const mallory = await signerFrom(await generateSigningKeys(false));
    const forged = async (msg: unknown, pv: 1 | 2) => encodeWire(room.roomKey, await sealEnvelope(mallory, msg), pv);
    // Mallory claims to be the transport peer 'Ann', with her own key.
    room.relay.deliver('Ann', 'host', await forged({ t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Mallory', peer: 'Ann', ...fresh() }, 1));
    room.relay.deliver('Ann', 'host', await forged({ t: 'cmd', peer: 'Ann', boardId: BOARD, clientSeq: 1, sid: newSid(Date.now()), epoch: 1, cmd: { type: 'addTopic', text: 'Forged' } }, 2));
    room.relay.deliver('Ann', 'host', await forged({ t: 'ping', boardId: BOARD, sid: ann.session.sid, n: 1000, at: Date.now(), t0: 1, peer: 'Ann' }, 2));
    await waitFor(() => host.current.topics.length === 1);
    const annRecords = host.presence().filter((p) => p.peerId === 'Ann');
    expect(annRecords.map((p) => p.participantId)).toContain(ann.id);
    expect(annRecords.find((p) => p.participantId === ann.id)!.status).toBe('direct');
    // Ann still gets her own view of each change.
    await ann.session.send({ type: 'addTopic', text: 'Ann’s' });
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    expect(ann.session.you).toBe(ann.id);
    expect(ann.session.state!.topics.map((t) => t.text)).toEqual(['Forged', 'Ann’s']);
  });
});

describe('presence', () => {
  it('does not keep someone online by replaying their hello; a ping does', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    const host = room.host('host', { now: () => clock });
    const fromAnn: Bytes[] = [];
    room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') fromAnn.push(data); };
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    await settle(HEAVY_SETTLE_MS); // let the ping that follows the join's reply land too
    expect(host.online()).toContain(ann.id);
    const hello = fromAnn[0]; // the first frame is the hello
    clock += 16_000;
    expect(host.online()).not.toContain(ann.id);
    room.direct.deliver('Ann', 'host', hello);
    room.relay.deliver('Ann', 'host', hello);
    await settle(HEAVY_SETTLE_MS);
    expect(host.online()).not.toContain(ann.id);
    expect(host.presence().find((p) => p.participantId === ann.id)?.status).toBe('offline');
    await ann.session.ping();
    await waitFor(() => host.online().includes(ann.id));
  });

  it('ignores a ping that names another meeting, as it does a hello or a command', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    await stepUntil(scheduler, () => joined(ann));
    await step(scheduler, 1000); // the ping that follows the join's reply lands too
    ann.session.stopHeartbeat(); // no pings of her own from here
    await step(scheduler, 16_000);
    expect(host.online()).not.toContain(ann.id);
    const ping = async (boardId: string) =>
      encodeWire(room.roomKey, await sealEnvelope(ann.signer, { t: 'ping', boardId, sid: ann.session.sid, n: 1000, at: scheduler.now(), t0: 1, peer: 'Ann' }), 2);
    room.direct.deliver('Ann', 'host', await ping('another-meeting'));
    await step(scheduler, 100);
    expect(host.online()).not.toContain(ann.id);
    room.direct.deliver('Ann', 'host', await ping(BOARD));
    await step(scheduler, 100);
    expect(host.online()).toContain(ann.id);
  });

  it('does not count a refused joiner as online or present, and sends them only the refusal', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const toNobody = framesTo(room, 'Nobody');
    const nobody = await room.person('Nobody', { name: '   ', scheduler });
    for (let t = 0; t < 30_000 && nobody.session.state?.joinRefused !== 'emptyName'; t += 100) {
      scheduler.advance(100);
      await settle(HEAVY_SETTLE_MS);
    }
    expect(nobody.session.state?.joinRefused).toBe('emptyName');
    expect(host.online()).not.toContain(nobody.id);
    expect(host.presence()).toEqual([]);
    const before = toNobody.length;
    await host.local({ type: 'addTopic', text: 'After the refusal' });
    // Past the next relay slot, on the fake clock, so a bundle has gone out whatever the machine's speed.
    for (let t = 0; t < 700; t += 100) {
      scheduler.advance(100);
      await settle(HEAVY_SETTLE_MS);
    }
    const later = toNobody.slice(before);
    // No snapshot, and in the bundles every relay peer receives, nothing for them but the refusal.
    expect(await viewsFor(room, later)).toEqual([]);
    const { bundles, entries } = await bundleEntries(room, later, nobody.id);
    expect(bundles).toBeGreaterThan(0);
    expect(entries.length).toBeGreaterThan(0); // the refusal provably travels in the bundle
    for (const entry of entries) {
      expectNeutral(entry);
      expect(entry.joinRefused).toBe('emptyName');
    }
  });
});

describe('duplicates', () => {
  it('leaves lastCommandAt and the saved record alone when an old command is replayed', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    let saves = 0;
    const host = room.host('host', { now: () => clock, save: async (saved) => { saves += 1; room.saved = structuredClone(saved); } });
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const fromAnn: Bytes[] = [];
    room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') fromAnn.push(data); };
    await ann.session.send({ type: 'addTopic', text: 'Once' });
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    const sid = ann.session.sid;
    const savedBefore = structuredClone(room.saved);
    const savesBefore = saves;
    const lastCommandAt = room.saved!.tabs[ann.id].tabs[sid].lastCommandAt;
    clock += 60_000;
    room.direct.deliver('Ann', 'host', fromAnn[fromAnn.length - 1]);
    await settle(HEAVY_SETTLE_MS);
    expect(saves).toBe(savesBefore);
    expect(room.saved).toEqual(savedBefore);
    // The next save carries the same lastCommandAt: nothing in memory moved either.
    await host.local({ type: 'setShowVotes', value: false });
    expect(room.saved!.tabs[ann.id].tabs[sid].lastCommandAt).toBe(lastCommandAt);
    expect(host.current.topics).toHaveLength(1);
  });

  it('still lists a resending tab in the person’s next view', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    const host = room.host('host', { now: () => clock });
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'));
    const cmd = async (sid: string, clientSeq: number) => encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq, sid, epoch: 1, cmd: { type: 'addTopic', text: sid } }));
    const old = newSid(clock);
    raw.send('host', await cmd(old, 1));
    // The host stamps each tab with its clock when it applies the command, so each is applied before the clock moves.
    await waitFor(() => host.current.topics.length === 1);
    // Three newer tabs push the old one out of the three listed.
    for (let i = 0; i < 3; i++) {
      clock += 1000;
      raw.send('host', await cmd(newSid(clock), 1));
      await waitFor(() => host.current.topics.length === i + 2);
    }
    await waitFor(() => host.current.topics.length === 4 && ann.session.state!.topics.length === 4);
    expect(Object.keys(ann.session.state!.acks)).toHaveLength(3);
    expect(ann.session.state!.acks[old]).toBeUndefined();
    clock += 1000;
    raw.send('host', await cmd(old, 1));
    await waitFor(() => ann.session.state!.acks[old] === 1);
  });
});

describe('housekeeping', () => {
  const internals = (host: HostSession) => host as unknown as { buffered: Map<string, Map<number, unknown>>; stale: Map<string, unknown> };

  it('forgets buffered commands of a pruned tab', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    const host = room.host('host', { now: () => clock });
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'));
    const sid = newSid(clock);
    const cmd = async (clientSeq: number) => encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq, sid, epoch: 1, cmd: { type: 'addTopic', text: `n${clientSeq}` } }));
    raw.send('host', await cmd(1));
    await waitFor(() => host.current.topics.length === 1);
    raw.send('host', await cmd(3)); // waits for a 2 that never comes
    await waitFor(() => internals(host).buffered.get(`${ann.id} ${sid}`)?.size === 1);
    clock += PRUNE_AFTER_MS + 1;
    await host.local({ type: 'setShowVotes', value: false });
    expect(internals(host).buffered.has(`${ann.id} ${sid}`)).toBe(false);
  });

  it('clears a person’s staleTab refusal once one of their tabs applies a command', async () => {
    const room = await TestRoom.create();
    const ann = await room.person('Ann');
    ann.session.stopHeartbeat();
    // Ann's live tab's creation time: the watermark is just before it however long making her took, so only the
    // older tab below counts as pruned.
    const now = sidCreatedAt(ann.session.sid)!;
    room.saved = {
      state: (await import('../engine/board')).createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' }),
      tabs: { [ann.id]: { watermark: now - 5, tabs: {} } },
    };
    room.saved.state.attendees[ann.id] = { id: ann.id, name: 'Ann', role: 'guest' };
    const host = room.host('host-2');
    await waitFor(() => joined(ann));
    await settled(host, 'Ann', ann.id);
    const pruned = newSid(now - 10);
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host-2'));
    raw.send('host-2', await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq: 1, sid: pruned, epoch: 1, cmd: { type: 'addTopic', text: 'Too late' } })));
    await waitFor(() => ann.session.state!.rejects[pruned]?.key === 'staleTab');
    await ann.session.send({ type: 'addTopic', text: 'From a live tab' });
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    expect(ann.session.state!.rejects[pruned]).toBeUndefined();
    expect(internals(host).stale.has(ann.id)).toBe(false);
  });
});

describe('an attendee whose join is refused', () => {
  it('keeps their record, old name and views when a longer rename is refused at the size cap', async () => {
    const room = await TestRoom.create();
    // Over the cap once anyone's name is longer than five characters.
    const host = room.host('host', { measure: (state) => (Object.values(state.attendees).some((a) => a.name.length > 5) ? 45_057 : 0) });
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const tab2 = await room.person('Ann-tab-2', { signer: ann.signer, name: 'Annabelle' });
    await waitFor(() => tab2.session.state?.joinRefused === 'meetingFullSize');
    expect(host.current.attendees[ann.id].name).toBe('Ann');
    expect(host.presence().some((p) => p.peerId === 'Ann-tab-2' && p.participantId === ann.id)).toBe(true);
    await host.local({ type: 'addTopic', text: 'Still here' });
    await waitFor(() => tab2.session.state?.topics.length === 1);
  });
});

describe('bounded peer records', () => {
  it('keeps at most eight records per signer, however many peer IDs one key says hello from', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const mallory = await signerFrom(await generateSigningKeys(false));
    const malloryId = (await import('../crypto/sign')).fingerprint(mallory.pub);
    for (let i = 0; i < 50; i++) {
      const peer = `p${i}`;
      room.relay.join(peer);
      room.relay.deliver(peer, 'host', await encodeWire(room.roomKey,
        await sealEnvelope(mallory, { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Mallory', peer, ...fresh() }), 1));
    }
    const id = await malloryId;
    await waitFor(() => host.presence().some((p) => p.peerId === 'p49'));
    await settle(HEAVY_SETTLE_MS);
    expect(PEER_RECORDS_PER_SIGNER).toBe(8);
    const records = host.presence().filter((p) => p.participantId === id);
    expect(records.length).toBe(PEER_RECORDS_PER_SIGNER);
    expect(records.map((p) => p.peerId)).toContain('p49');
  });

  it('removes a record not heard from for 60 s, and the participant binds again with its next hello', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { now: () => clock, scheduler });
    const ann = await room.person('Ann', { scheduler });
    await stepUntil(scheduler, () => joined(ann));
    await settled(host, 'Ann', ann.id);
    expect(PEER_RECORD_TTL_MS).toBe(60_000);
    clock += PEER_RECORD_TTL_MS - 1;
    await host.tick(clock);
    expect(host.presence().map((p) => p.participantId)).toContain(ann.id);
    clock += 2;
    await host.tick(clock);
    expect(host.presence()).toEqual([]);
    const toAnn = framesTo(room, 'Ann');
    await host.local({ type: 'addTopic', text: 'Missed' });
    await step(scheduler, 700); // past the next relay slot, so a bundle has gone out
    // No snapshot, and no entry for Ann in the bundles. (The shared part reaches every relay peer, and an entry Ann
    // holds from since the last full refresh still combines with it, as the protocol allows.)
    expect(await viewsFor(room, toAnn)).toEqual([]);
    const { bundles, entries } = await bundleEntries(room, toAnn, ann.id);
    expect(bundles).toBeGreaterThan(0);
    expect(entries).toEqual([]);
    ann.session.rehello();
    await stepUntil(scheduler, () => host.presence().some((p) => p.participantId === ann.id));
    await host.local({ type: 'addTopic', text: 'Seen' });
    await stepUntil(scheduler, () => ann.session.state!.topics.length === 2);
  });
});

describe('probationary peer records', () => {
  async function setupKey(room: TestRoom) {
    const signer = await signerFrom(await generateSigningKeys(false));
    const id = await (await import('../crypto/sign')).fingerprint(signer.pub);
    const joinedPeers = new Set<string>();
    const sids = new Map<string, string>(); // a tab of its own for each transport peer
    const counts = new Map<string, number>();
    const deliver = async (peer: string, msg: unknown, pv: 1 | 2) => {
      if (!joinedPeers.has(peer)) { room.relay.join(peer); joinedPeers.add(peer); }
      room.relay.deliver(peer, 'host', await encodeWire(room.roomKey, await sealEnvelope(signer, msg), pv));
    };
    return {
      signer, id,
      hello: (peer: string) => deliver(peer, { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Mallory', peer, ...fresh() }, 1),
      ping: (peer: string) => {
        if (!sids.has(peer)) sids.set(peer, newSid(Date.now()));
        const n = (counts.get(peer) ?? 0) + 1;
        counts.set(peer, n);
        return deliver(peer, { t: 'ping', boardId: BOARD, sid: sids.get(peer), n, at: Date.now(), t0: 1, peer }, 2);
      },
    };
  }
  const peersOf = (host: HostSession, id: string) => host.presence().filter((p) => p.participantId === id).map((p) => p.peerId).sort();
  const internals = (host: HostSession) => host as unknown as { peers: Map<string, { lastHeardAt: number; probation: boolean }> };

  it('never evicts a live record for replays of the victim’s old hellos, and the victim keeps getting views', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    const host = room.host('host', { now: () => clock });
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    await ann.session.ping();
    await waitFor(() => internals(host).peers.get(`Ann ${ann.id}`)?.probation === false);
    for (let i = 0; i < 20; i++) {
      // Four replays a second, faster than the victim's 5 s pings.
      clock += 250;
      if (i % 20 === 0) await ann.session.ping();
      const peer = `old${i}`;
      room.relay.join(peer);
      room.relay.deliver(peer, 'host', await encodeWire(room.roomKey,
        await sealEnvelope(ann.signer, { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Ann', peer, ...fresh() }), 1));
      await waitFor(() => host.presence().some((p) => p.peerId === peer) || peersOf(host, ann.id).length === PEER_RECORDS_PER_SIGNER);
      await settle(HEAVY_SETTLE_MS);
      expect(peersOf(host, ann.id)).toContain('Ann');
    }
    expect(peersOf(host, ann.id).length).toBeLessThanOrEqual(PEER_RECORDS_PER_SIGNER);
    await host.local({ type: 'addTopic', text: 'Still yours' });
    await waitFor(() => ann.session.state!.topics.length === 1);
  });

  it('evicts a probationary record before any heard one', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    const host = room.host('host', { now: () => clock });
    const m = await setupKey(room);
    for (let i = 0; i < 7; i++) {
      await m.hello(`p${i}`);
      await waitFor(() => peersOf(host, m.id).includes(`p${i}`));
      await m.ping(`p${i}`);
      await waitFor(() => internals(host).peers.get(`p${i} ${m.id}`)?.probation === false);
    }
    clock += 20_000; // every heard record is now evictable by age
    await m.hello('p7'); // probationary: bound, never heard
    await waitFor(() => peersOf(host, m.id).includes('p7'));
    clock += 1000;
    await m.hello('p8');
    await waitFor(() => peersOf(host, m.id).includes('p8'));
    expect(peersOf(host, m.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p8']);
  });

  it('refuses a ninth binding when all eight were heard from in the last 15 s', async () => {
    const room = await TestRoom.create();
    const clock = Date.now();
    const host = room.host('host', { now: () => clock });
    const m = await setupKey(room);
    for (let i = 0; i < 8; i++) {
      await m.hello(`p${i}`);
      await waitFor(() => peersOf(host, m.id).includes(`p${i}`));
      await m.ping(`p${i}`);
      await waitFor(() => internals(host).peers.get(`p${i} ${m.id}`)?.probation === false);
    }
    const toP8 = framesTo(room, 'p8');
    await m.hello('p8');
    await settle(HEAVY_SETTLE_MS);
    expect(peersOf(host, m.id)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    // No view of its own: bundles are relay broadcasts, so p8 receives those like every relay peer.
    expect(await viewsFor(room, toP8)).toEqual([]);
  });

  it('expires a probationary record that never pings at 60 s from its binding', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    const host = room.host('host', { now: () => clock });
    const m = await setupKey(room);
    await m.hello('p0');
    await waitFor(() => peersOf(host, m.id).includes('p0'));
    expect(internals(host).peers.get(`p0 ${m.id}`)?.probation).toBe(true);
    clock += PEER_RECORD_TTL_MS - 1;
    await host.tick(clock);
    expect(peersOf(host, m.id)).toEqual(['p0']);
    clock += 2;
    await host.tick(clock);
    expect(peersOf(host, m.id)).toEqual([]);
  });
});

describe('probationary records see only the shared view', () => {
  // Every snapshot in these frames, as the participant would read it.
  async function snapshots(room: TestRoom, frames: Bytes[]) {
    const out: Array<{ you: string; state: { topics: Array<{ mine: number }>; vote: { voted: boolean; totals?: unknown } | null; acks: object; rejects: object } }> = [];
    for (const data of frames) {
      const frame = await decodeFrame(room.roomKey, data);
      if (frame?.kind !== 'envelope') continue;
      const msg = JSON.parse(frame.env.body);
      if (msg.t === 'snapshot') out.push(msg);
    }
    return out;
  }

  async function annWithADot(room: TestRoom, host: HostSession, scheduler?: FakeScheduler) {
    const ann = await room.person('Ann', { scheduler });
    if (scheduler) await stepUntil(scheduler, () => joined(ann));
    else await waitFor(() => joined(ann));
    await host.local({ type: 'addTopic', text: 'Dotted' });
    await ann.session.send({ type: 'addVote', topicId: 1 });
    const voted = () => ann.session.state!.topics[0]?.mine === 1 && ann.session.state!.acks[ann.session.sid] === 1;
    if (scheduler) await stepUntil(scheduler, voted);
    else await waitFor(voted);
    return ann;
  }

  it('sends a replayed hello’s peer no personal data, on the join reply or any flush', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await annWithADot(room, host, scheduler);
    const toGhost = framesTo(room, 'ghost');
    // An old hello of Ann's, from an earlier page load whose peer was 'ghost'. It arrives direct, so the host's
    // views to that record are direct snapshots (a relay-only record is reached by bundles: see the next test).
    room.direct.join('ghost');
    await settle(HEAVY_SETTLE_MS);
    room.direct.deliver('ghost', 'host', await encodeWire(room.roomKey,
      await sealEnvelope(ann.signer, { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Ann', peer: 'ghost', ...fresh() }), 1));
    await stepUntil(scheduler, () => toGhost.length > 0);
    // Spaced past the 150 ms coalescing window, so each is a flush of its own.
    await step(scheduler, 200);
    await host.local({ type: 'setShowVotes', value: false });
    await step(scheduler, 200);
    await host.local({ type: 'addTopic', text: 'Another' });
    await step(scheduler, 200);
    const views = await snapshots(room, toGhost);
    expect(views.length).toBeGreaterThanOrEqual(3);
    for (const view of views) {
      expect(view.state.topics.every((t) => t.mine === 0)).toBe(true);
      expect(view.state.acks).toEqual({});
      expect(view.state.rejects).toEqual({});
      expect(view.state.vote?.totals).toBeUndefined();
    }
  });

  it('gives a person whose only record is probationary a neutral bundle entry, and their own after a ping', async () => {
    const room = await TestRoom.create();
    const signer = await signerFrom(await generateSigningKeys(false));
    const id = await (await import('../crypto/sign')).fingerprint(signer.pub);
    // Saved before this host session: Ann is an attendee with a dot on topic 1 and an acknowledged tab.
    const now = Date.now();
    let state: BoardState = createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' });
    const run = (actor: string, cmd: Command) => {
      const result = apply(state, actor, cmd, now);
      if (!result.ok) throw new Error(result.key);
      state = result.state;
    };
    run(id, { type: 'join', name: 'Ann' });
    run(room.hostId, { type: 'addTopic', text: 'Dotted' });
    run(id, { type: 'addVote', topicId: 1 });
    const sid = newSid(now);
    room.saved = { state, tabs: recordOutcome({}, id, sid, 1, now) };
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const toP0 = framesTo(room, 'p0');
    room.relay.join('p0');
    await settle(HEAVY_SETTLE_MS);
    // A hello over the relay alone: a probationary record whose views can only be bundles.
    room.relay.deliver('p0', 'host', await encodeWire(room.roomKey, await sealEnvelope(signer, { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Ann', peer: 'p0', ...fresh() }), 1));
    await waitFor(() => host.presence().some((p) => p.peerId === 'p0'));
    await step(scheduler, 700); // the join reply, in the next relay slot
    await host.local({ type: 'addTopic', text: 'Another' });
    await step(scheduler, 700);
    const probation = await bundleEntries(room, toP0, id);
    expect(probation.entries.length).toBeGreaterThan(0);
    for (const entry of probation.entries) expectNeutral(entry);
    const before = toP0.length;
    room.relay.deliver('p0', 'host', await encodeWire(room.roomKey, await sealEnvelope(signer, { t: 'ping', boardId: BOARD, sid, n: 1, at: Date.now(), t0: 1, peer: 'p0' }), 2));
    await waitFor(() => (host as unknown as { peers: Map<string, { probation: boolean }> }).peers.get(`p0 ${id}`)?.probation === false);
    await step(scheduler, 700);
    const heard = await bundleEntries(room, toP0.slice(before), id);
    expect(heard.entries.length).toBeGreaterThan(0);
    expect(heard.entries[0]).toMatchObject({ mine: { 1: 1 }, acks: { [sid]: 1 } });
  });

  it('gives a genuine new tab its personal view right after its first ping', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await annWithADot(room, host);
    const tab2 = await room.person('Ann-tab-2', { signer: ann.signer, name: 'Ann' });
    await waitFor(() => tab2.session.state?.topics[0]?.mine === 1);
    expect(tab2.session.state!.acks[ann.session.sid]).toBe(1);
  });

  it('lets a genuine new tab through a trickle of replayed hellos, two a second', async () => {
    const room = await TestRoom.create();
    let clock = Date.now();
    const host = room.host('host', { now: () => clock });
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    await ann.session.ping();
    let n = 0;
    const replay = async () => {
      clock += 500;
      const peer = `old${n++}`;
      room.relay.join(peer);
      room.relay.deliver(peer, 'host', await encodeWire(room.roomKey,
        await sealEnvelope(ann.signer, { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Ann', peer, ...fresh() }), 1));
      await waitFor(() => host.presence().some((p) => p.peerId === peer));
    };
    for (let i = 0; i < 7; i++) await replay(); // every spare slot is taken
    const tab2 = await room.person('Ann-tab-2', { signer: ann.signer, name: 'Ann' });
    await waitFor(() => tab2.session.state !== null);
    for (let i = 0; i < 12; i++) await replay();
    expect(host.presence().some((p) => p.peerId === 'Ann-tab-2')).toBe(true);
    await host.local({ type: 'addTopic', text: 'Still reaching tab 2' });
    await waitFor(() => tab2.session.state!.topics.length === 1);
  });
});
