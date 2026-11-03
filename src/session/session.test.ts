import { newSid } from '../protocol/sid';
import { describe, expect, it, vi } from 'vitest';
import { generateRoomKey, importRoomKey } from '../crypto/aead';
import type { Bytes } from '../crypto/bytes';
import { fingerprint, generateSigningKeys, signerFrom } from '../crypto/sign';
import { createBoard } from '../engine/board';
import { MESSAGES } from '../engine/messages';
import { migrateBoard } from '../engine/migrate';
import type { BoardState } from '../engine/types';
import { openBundle, openItem } from '../protocol/bundle';
import { decodeFrame, decodeWire, encodeWire, sealEnvelope } from '../protocol/envelope';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { FakeScheduler } from '../test/fake-scheduler';
import { sleep, waitFor } from '../test/wait';
import { MemoryNetwork } from '../transport/memory';
import { HostSession, type SavedBoard } from './host';
import { ParticipantSession } from './participant';

// Steps the fake clock in 100 ms slices, letting the cryptography finish after each, until the condition holds; fails
// after maxMs of fake time. Never waits on real time.
async function until(fake: FakeScheduler, cond: () => boolean, maxMs = 60_000): Promise<void> {
  await settle(HEAVY_SETTLE_MS);
  for (let t = 0; t < maxMs && !cond(); t += 100) {
    fake.advance(100);
    await settle(HEAVY_SETTLE_MS);
  }
  if (!cond()) throw new Error('condition not reached on the fake clock');
}

// For a host with no network to speak of: lets the tracked work finish, without moving any clock.
async function settleUntil(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await settle(HEAVY_SETTLE_MS);
  if (!cond()) throw new Error('condition not reached');
}

// These tests don't exercise the size cap; src/protocol/size.test.ts does.
const noSizeCap = () => 0;

// With `fake`, the hosts and participants run on that clock (which `advance` moves) and the waits step it, so nothing
// races a real timer: the tests that need it use the fake clock, the rest keep real time.
async function setup(names: string[] = ['Ann', 'Bob'], hostSkewMs = 0, fake?: FakeScheduler) {
  const net = new MemoryNetwork();
  const roomKey = await importRoomKey(generateRoomKey());
  const hostSigner = await signerFrom(await generateSigningKeys(true));
  const hostId = await fingerprint(hostSigner.pub);
  let clock = 1_000_000;
  const now = fake ? () => fake.now() : () => clock;
  const scheduling = fake ? { scheduler: fake } : {};
  const waitUntil = fake ? (cond: () => boolean) => until(fake, cond) : (cond: () => boolean) => waitFor(cond);
  let saved: SavedBoard | null = null;
  const host = new HostSession({
    transport: net.join('host'), roomKey, signer: hostSigner, hostId, epoch: 1, now: () => now() + hostSkewMs, ...scheduling,
    save: async (board) => { saved = structuredClone(board); }, measure: noSizeCap,
    state: createBoard({ boardId: 'b1', boardName: 'Team', ownerId: hostId, ownerName: 'Olu' }),
  });
  const people = await Promise.all(names.map(async (name) => {
    const signer = await signerFrom(await generateSigningKeys(false));
    const rejects: string[] = [];
    const rejectSeqs: number[] = [];
    const transport = net.join(name);
    const session = new ParticipantSession({
      transport, roomKey, signer, hostPub: hostSigner.pub, boardId: 'b1', name, now, ...scheduling,
      onReject: (m, seq) => { rejects.push(m); rejectSeqs.push(seq); },
    });
    return { name, signer, transport, session, rejects, rejectSeqs, id: await fingerprint(signer.pub) };
  }));
  for (const p of people) await waitUntil(() => p.session.state?.attendees[p.id] !== undefined);
  // Each tab pings as soon as its hello is answered, which ends its record's probation and brings its full view.
  // Let those land too, so no test sees them arrive late.
  const records = () => [...(host as unknown as { peers: Map<string, { probation: boolean }> }).peers.values()];
  await waitUntil(() => records().length === people.length && records().every((r) => !r.probation));
  if (fake) await settle(HEAVY_SETTLE_MS); else await sleep(20);
  return { net, roomKey, host, hostSigner, hostId, people, now, advance: (ms: number) => { if (fake) fake.advance(ms); else clock += ms; }, waitUntil, lastSave: () => saved, scheduling };
}

describe('sessions', () => {
  it('lets participants join and receive their own identity', async () => {
    const { people, host } = await setup();
    const [ann] = people;
    expect(ann.session.you).toBe(ann.id);
    expect(host.current.attendees[ann.id]).toEqual({ id: ann.id, name: 'Ann', role: 'guest' });
  });

  it('applies a participant command and shares the result with everyone', async () => {
    const { people, host } = await setup();
    const [ann, bob] = people;
    await ann.session.send({ type: 'addTopic', text: 'Trunk-based development' });
    await waitFor(() => bob.session.state!.topics.length === 1);
    expect(host.current.topics[0].authorId).toBe(ann.id);
  });

  it('names the command a rejection answers, by the number sendSeq returned', async () => {
    const { people, host } = await setup();
    const [ann] = people;
    await host.local({ type: 'addTopic', text: 'x' });
    const seqs: Array<number | null> = [];
    for (let i = 0; i < 4; i++) seqs.push(await ann.session.sendSeq({ type: 'addVote', topicId: 1 }));
    await waitFor(() => ann.rejects.length === 1);
    expect(seqs.every((n) => n !== null)).toBe(true);
    expect(ann.rejectSeqs).toEqual([seqs[3]]);
  });

  it('sends rule rejections back to the sender only', async () => {
    const { people, host } = await setup();
    const [ann, bob] = people;
    await host.local({ type: 'addTopic', text: 'x' });
    for (let i = 0; i < 4; i++) await ann.session.send({ type: 'addVote', topicId: 1 });
    await waitFor(() => ann.rejects.length === 1);
    expect(ann.rejects).toEqual([MESSAGES.noVotesLeft]);
    expect(bob.rejects).toEqual([]);
    expect(host.current.topics[0].voters).toHaveLength(3);
  });

  it('ignores snapshots signed by anyone but the host', async () => {
    const { net, roomKey, people } = await setup(['Ann']);
    const [ann] = people;
    const mallory = net.join('mallory');
    await waitFor(() => mallory.peers().includes('Ann'));
    const forger = await signerFrom(await generateSigningKeys(false));
    const fake = { t: 'snapshot', epoch: 99, seq: 99, you: ann.id, state: { ...ann.session.state!, boardName: 'Hacked' } };
    mallory.send('Ann', await encodeWire(roomKey, await sealEnvelope(forger, fake)));
    await sleep(50);
    expect(ann.session.state!.boardName).toBe('Team');
  });

  it('ignores a stale host snapshot and keeps talking to the real host', async () => {
    const { net, roomKey, hostSigner, people, host } = await setup(['Ann']);
    const [ann] = people;
    const stale = { t: 'snapshot', epoch: 1, seq: 0, you: ann.id, state: { ...ann.session.state!, topics: [] } };
    await host.local({ type: 'addTopic', text: 'kept' });
    await waitFor(() => ann.session.state!.topics.length === 1);
    const replayer = net.join('replayer');
    await waitFor(() => replayer.peers().includes('Ann'));
    replayer.send('Ann', await encodeWire(roomKey, await sealEnvelope(hostSigner, stale)));
    await sleep(50);
    expect(ann.session.state!.topics).toHaveLength(1);
    await ann.session.send({ type: 'addTopic', text: 'still reaches host' });
    await waitFor(() => host.current.topics.length === 2);
  });

  it('drops a replayed command', async () => {
    const { net, people, host } = await setup(['Ann']);
    const [ann] = people;
    const frames: Bytes[] = [];
    net.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') frames.push(data); };
    await ann.session.send({ type: 'addTopic', text: 'once' });
    await waitFor(() => host.current.topics.length === 1);
    const mallory = net.join('mallory');
    await waitFor(() => mallory.peers().includes('host'));
    mallory.send('host', frames[frames.length - 1]);
    await sleep(50);
    expect(host.current.topics).toHaveLength(1);
  });

  it('never sends hidden votes to other participants', async () => {
    const { net, roomKey, people, host, hostSigner, hostId } = await setup();
    const [ann, bob] = people;
    await host.local({ type: 'addTopic', text: 'x' });
    await host.local({ type: 'setShowVotes', value: false });
    const toAnn: Bytes[] = [];
    net.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') toAnn.push(data); };
    await bob.session.send({ type: 'addVote', topicId: 1 });
    await waitFor(() => host.current.topics[0].voters.length === 1);
    await waitFor(() => toAnn.length > 0 && ann.session.state!.topics.length === 1);
    expect(ann.session.state!.topics[0]).toMatchObject({ mine: 0 });
    expect(ann.session.state!.topics[0].votes).toBeUndefined();
    await waitFor(() => bob.session.state!.topics[0]?.mine === 1);
    expect(bob.session.state!.topics[0].votes).toBeUndefined();
    const opened = await Promise.all(toAnn.map((d) => decodeWire(roomKey, d)));
    expect(opened.some((e) => e?.body.includes('voters'))).toBe(false);
    // The relay bundles reach Ann too: neither their shared part nor any entry lists who voted.
    await sleep(700); // past the next relay slot, so the bundle after Bob's vote has gone out
    const ids = [ann.id, bob.id, hostId];
    let bundles = 0;
    for (const data of toAnn) {
      const frame = await decodeFrame(roomKey, data);
      if (frame?.kind !== 'bundle') continue;
      const bundle = await openBundle(frame.body, hostSigner.pub);
      expect(bundle).not.toBeNull();
      bundles += 1;
      const shared = JSON.stringify(bundle!.message.shared);
      expect(shared).not.toContain('voters');
      expect(shared).not.toContain('"voters"');
      for (const item of bundle!.items) {
        for (const you of ids) {
          const entry = await openItem(roomKey, hostSigner.pub, item, you, bundle!.message);
          if (!entry) continue;
          const { you: own, ...rest } = entry;
          const body = JSON.stringify(rest);
          expect(body).not.toContain('voters');
          expect(body).not.toContain('"voters"');
          // An entry names only its own person: no other attendee's ID, so no voter identities.
          for (const other of ids) if (other !== own) expect(body).not.toContain(other);
        }
      }
    }
    expect(bundles).toBeGreaterThan(0);
  });

  it('keeps the host online when it only leaves the transport: 20 s without a message makes it offline', async () => {
    const { net, people } = await setup(['Ann']);
    const [ann] = people;
    net.drop('host');
    await settle();
    // The 20 s rule itself is in liveness.test.ts, on a fake clock.
    expect(ann.session.hostOnline).toBe(true);
    expect(ann.session.connection).toBe('connected');
  });

  it('estimates the host clock from a ping', async () => {
    const { people } = await setup(['Ann'], 5000);
    const [ann] = people;
    await ann.session.ping();
    await waitFor(() => ann.session.clock.offset !== 0);
    expect(ann.session.clock.offset).toBe(5000);
  });

  it("reads the facilitator's countdown from the host clock, which never runs backwards", async () => {
    const { host, advance } = await setup(['Ann']);
    const before = host.hostNow();
    advance(-10_000);
    expect(host.hostNow()).toBeGreaterThan(before);
    advance(20_000);
    expect(host.hostNow()).toBeGreaterThan(before + 9_000);
  });

  it('lists who is connected and how', async () => {
    const { people, host } = await setup(['Ann']);
    expect(host.presence()).toEqual([{ participantId: people[0].id, peerId: 'Ann', status: 'direct' }]);
  });

  it('does not send a participant’s view to someone replaying their hello', async () => {
    const { net, roomKey, people, host } = await setup(['Ann']);
    const [ann] = people;
    const hellos: Bytes[] = [];
    net.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') hellos.push(data); };
    ann.session.rehello();
    await waitFor(() => hellos.length > 0);
    const mallory = net.join('mallory');
    const toMallory: Bytes[] = [];
    mallory.onMessage((_p, data) => toMallory.push(data));
    await waitFor(() => mallory.peers().includes('host'));
    mallory.send('host', hellos[0]);
    await sleep(50);
    await host.local({ type: 'addTopic', text: 'after replay' });
    await sleep(50);
    const opened = await Promise.all(toMallory.map((d) => decodeWire(roomKey, d)));
    expect(opened.filter((e) => e && JSON.parse(e.body).you === ann.id)).toEqual([]);
  });

  it('drops a command captured before the host reloaded', async () => {
    const { net, roomKey, hostSigner, hostId, people, host, waitUntil, scheduling } = await setup(['Ann'], 0, new FakeScheduler(1_000_000));
    const [ann] = people;
    const frames: Bytes[] = [];
    net.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') frames.push(data); };
    await host.local({ type: 'addTopic', text: 'x' });
    await ann.session.send({ type: 'addVote', topicId: 1 });
    await waitUntil(() => host.current.topics[0].voters.length === 1);
    // Wait for Ann's ack too: an unacknowledged command is resent to the next host session.
    await waitUntil(() => ann.session.state?.acks[ann.session.sid] === 1);
    const captured = frames[frames.length - 1];
    net.drop('host');
    const second = new HostSession({ transport: net.join('host-2'), roomKey, signer: hostSigner, hostId, epoch: 2, state: host.current, measure: noSizeCap, ...scheduling });
    await waitUntil(() => second.presence().length === 1);
    const mallory = net.join('mallory');
    await waitUntil(() => mallory.peers().includes('host-2'));
    mallory.send('host-2', captured);
    await settle();
    expect(second.current.topics[0].voters).toHaveLength(1);
  }, 30_000);

  it('ignores a fresh snapshot forwarded by another participant', async () => {
    const { roomKey, hostSigner, people, host } = await setup(['Ann', 'Bob']);
    const [ann, bob] = people;
    const forged = async (you: string) => encodeWire(roomKey, await sealEnvelope(hostSigner,
      { t: 'snapshot', epoch: 1, seq: 999, you, host: 'host', state: { ...ann.session.state!, boardName: 'Forwarded' } }));
    bob.transport.send('Ann', await forged(bob.id));
    bob.transport.send('Ann', await forged(ann.id));
    await sleep(50);
    expect(ann.session.you).toBe(ann.id);
    expect(ann.session.state!.boardName).toBe('Team');
    await ann.session.send({ type: 'addTopic', text: 'still reaches host' });
    await waitFor(() => host.current.topics.length === 1);
  });

  it('applies commands that arrive out of order, once each, in clientSeq order', async () => {
    const { net, roomKey, people, host } = await setup(['Ann']);
    const [ann] = people;
    const raw = net.join('raw');
    await waitFor(() => raw.peers().includes('host'));
    const sid = newSid(Date.now());
    const cmd = async (clientSeq: number, text: string) => encodeWire(roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'raw', boardId: 'b1', clientSeq, sid, epoch: 1, cmd: { type: 'addTopic', text } }));
    const second = await cmd(2, 'second');
    raw.send('host', second);
    raw.send('host', await cmd(1, 'first'));
    raw.send('host', second);
    await waitFor(() => host.current.topics.length === 2);
    await sleep(50);
    expect(host.current.topics.map((t) => [t.topicId, t.text])).toEqual([[1, 'first'], [2, 'second']]);
  });

  it('refuses a command it does not know with badCommand, and still applies the next one', async () => {
    const { roomKey, people, host } = await setup(['Ann']);
    const [ann] = people;
    const cmd = async (clientSeq: number, inner: unknown) => encodeWire(roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'Ann', boardId: 'b1', clientSeq, sid: ann.session.sid, epoch: 1, cmd: inner }));
    ann.transport.send('host', await cmd(1, { type: 'dropTables' }));
    ann.transport.send('host', await cmd(2, { type: 'join', name: 'Sneaky' }));
    await waitFor(() => ann.session.state!.rejects[ann.session.sid]?.clientSeq === 2);
    expect(ann.session.state!.rejects[ann.session.sid]).toEqual({ clientSeq: 2, key: 'badCommand' });
    expect(ann.rejects).toContain(MESSAGES.badCommand);
    ann.transport.send('host', await cmd(3, { type: 'addTopic', text: 'after' }));
    await waitFor(() => host.current.topics.length === 1);
    expect(host.current.attendees[ann.id].name).toBe('Ann');
  });

  it('answers a hello that changes nothing without changing seq, and only to its sender', async () => {
    const { net, roomKey, people, host } = await setup(['Ann', 'Bob']);
    const [ann, bob] = people;
    await sleep(300); // let the flushes from joining go out first
    const seq = host.version.seq;
    const toBob: Bytes[] = [];
    const toAnn: Bytes[] = [];
    net.tap = (from, to, data) => {
      if (from === 'host' && to === 'Bob') toBob.push(data);
      if (from === 'host' && to === 'Ann') toAnn.push(data);
    };
    ann.session.rehello();
    await waitFor(() => toAnn.length > 0);
    await sleep(50);
    expect(host.version.seq).toBe(seq);
    // Bob still gets the relay bundles, which go to everyone, and pongs to his own pings, but no snapshot of his own.
    const snapshotsToBob = (await Promise.all(toBob.map((d) => decodeWire(roomKey, d))))
      .filter((e) => e && JSON.parse(e.body).t === 'snapshot');
    expect(snapshotsToBob).toEqual([]);
    expect(bob.session.state).not.toBeNull();
  });

  it('accepts commands from two tabs on the same device', async () => {
    const { net, roomKey, hostSigner, people, host, now } = await setup(['Ann']);
    const [ann] = people;
    const secondTab = new ParticipantSession({ transport: net.join('Ann-tab-2'), roomKey, signer: ann.signer, hostPub: hostSigner.pub, boardId: 'b1', name: 'Ann', now });
    await waitFor(() => secondTab.state !== null);
    await ann.session.send({ type: 'addTopic', text: 'from tab 1' });
    await secondTab.send({ type: 'addTopic', text: 'from tab 2' });
    await waitFor(() => host.current.topics.length === 2);
  });
});

describe('time up', () => {
  // A scheduler the test drives by hand.
  function manualScheduler() {
    const jobs: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
    return {
      jobs,
      every: (fn: () => void, ms: number) => {
        const job = { fn, ms, cancelled: false };
        jobs.push(job);
        return () => { job.cancelled = true; };
      },
      fire: () => { for (const job of jobs) if (!job.cancelled) job.fn(); },
    };
  }

  async function discussing(names = ['Ann', 'Bob']) {
    const ctx = await setup(names, 0, new FakeScheduler(1_000_000));
    await ctx.host.local({ type: 'addTopic', text: 'Pairing' });
    await ctx.host.local({ type: 'startDiscussion' });
    await ctx.host.local({ type: 'discussTopic', topicId: 1, minutes: 5 });
    return ctx;
  }

  it('opens the vote through the same path as a command once the timer runs out, and only once', async () => {
    const { host, people, advance, now, waitUntil } = await discussing();
    const [ann] = people;
    const seq = host.version.seq;
    await host.tick(now() + 5 * 60_000 - 1);
    expect(host.version.seq).toBe(seq);
    advance(5 * 60_000);
    // Everyone is heard from again on the test's clock, so they count as here (heard from in the last 15 s).
    for (const p of people) await p.session.ping();
    await waitUntil(() => host.online().length === 3);
    await host.tick(now());
    expect(host.version.seq).toBe(seq + 1);
    expect(host.current.continueVote).toEqual({ topicId: 1, round: 1, voters: [], totals: { extend: 0, none: 0, end: 0 } });
    await waitUntil(() => ann.session.state?.vote !== null);
    expect(ann.session.state!.vote).toEqual({ topicId: 1, round: 1, voted: false, turnout: { voted: 0, here: 3 } });
    await host.tick(now() + 1000);
    expect(host.version.seq).toBe(seq + 1);
  }, 30_000);

  it('ticks once straight away and then every second, until stopped', async () => {
    const { host } = await discussing(['Ann']);
    const scheduler = manualScheduler();
    const ticking = new HostSession({
      transport: new MemoryNetwork().join('solo'), roomKey: await importRoomKey(generateRoomKey()),
      signer: await signerFrom(await generateSigningKeys(true)), hostId: 'solo', epoch: 1,
      state: host.current, now: () => 1_000_000 + 5 * 60_000, every: scheduler.every, measure: noSizeCap,
    });
    ticking.startTicking();
    expect(scheduler.jobs.map((j) => j.ms)).toEqual([1000]);
    await settleUntil(() => ticking.current.continueVote !== null);
    expect(ticking.version.seq).toBe(1);
    scheduler.fire();
    await settle();
    expect(ticking.version.seq).toBe(1);
    ticking.stop();
    expect(scheduler.jobs[0].cancelled).toBe(true);
  }, 30_000);

  it('keeps a time-up vote open across a host reload: same totals, each ballot once', async () => {
    const { net, roomKey, hostSigner, hostId, people, host, advance, now, lastSave, waitUntil, scheduling } = await discussing();
    const [ann, bob] = people;
    advance(5 * 60_000);
    // Real participants ping every 5 s; on the test's clock they must be heard from again, or the host drops
    // their peer records (silent for 60 s) at the next tick.
    for (const p of people) await p.session.ping();
    await waitUntil(() => host.online().length === 3);
    await host.tick(now());
    await waitUntil(() => ann.session.state?.vote?.round === 1);
    await ann.session.send({ type: 'voteToContinue', topicId: 1, round: 1, choice: 'end' });
    await waitUntil(() => host.current.continueVote?.voters.length === 1);
    // Wait for Ann's ack too: an unacknowledged ballot is resent to the next host session.
    await waitUntil(() => ann.session.state?.acks[ann.session.sid] === 1);
    // Let the old host's last views land first, so none of them arrives after the reload.
    await waitUntil(() => ann.session.state?.vote?.voted === true && bob.session.state?.vote?.turnout.voted === 1);
    // What the facilitator's browser saved, read back the way the store reads it.
    const saved = migrateBoard(JSON.parse(JSON.stringify(host.current)) as BoardState, now());

    net.drop('host'); // the facilitator reloads
    const second = new HostSession({ transport: net.join('host-2'), roomKey, signer: hostSigner, hostId, epoch: 2, state: saved, tabs: lastSave()!.tabs, now, measure: noSizeCap, ...scheduling });
    // Both accept the new host session's view (a higher epoch) and say hello to it.
    await waitUntil(() => second.presence().length === 2);
    await second.tick(now());
    expect(second.version.seq).toBe(0);
    expect(second.current.continueVote).toEqual({ topicId: 1, round: 1, voters: [ann.id], totals: { extend: 0, none: 0, end: 1 } });

    await ann.session.send({ type: 'voteToContinue', topicId: 1, round: 1, choice: 'extend' });
    await waitUntil(() => ann.rejects.length === 1);
    expect(ann.rejects).toEqual([MESSAGES.alreadyVoted]);
    await bob.session.send({ type: 'voteToContinue', topicId: 1, round: 1, choice: 'extend' });
    await waitUntil(() => second.current.continueVote?.voters.length === 2);
    expect(second.current.continueVote!.totals).toEqual({ extend: 1, none: 0, end: 1 });
    await waitUntil(() => ann.session.state?.vote?.totals?.extend === 1);
    expect(ann.session.state!.vote).toMatchObject({ voted: true, turnout: { voted: 2 } });
  }, 30_000);

  it('opens the vote of a timer that ran out while the host was away, at the first tick after it resumes', async () => {
    const { host, now } = await discussing(['Ann']);
    const away = migrateBoard(JSON.parse(JSON.stringify(host.current)) as BoardState, now() + 30 * 60_000);
    expect(away.continueVote).toBeNull();
    const scheduler = manualScheduler();
    const resumed = new HostSession({
      transport: new MemoryNetwork().join('resumed'), roomKey: await importRoomKey(generateRoomKey()),
      signer: await signerFrom(await generateSigningKeys(true)), hostId: 'resumed', epoch: 2,
      state: away, now: () => now() + 30 * 60_000, every: scheduler.every, measure: noSizeCap,
    });
    resumed.startTicking();
    await settleUntil(() => resumed.current.continueVote !== null);
    expect(resumed.current.continueVote!.round).toBe(1);
    resumed.stop();
  }, 30_000);
});

describe('the size cap', () => {
  async function soloHost(measure: (state: BoardState) => number | Promise<number>) {
    const signer = await signerFrom(await generateSigningKeys(true));
    const hostId = await fingerprint(signer.pub);
    const saved: BoardState[] = [];
    const host = new HostSession({
      transport: new MemoryNetwork().join('host'), roomKey: await importRoomKey(generateRoomKey()), signer, hostId, epoch: 1,
      state: createBoard({ boardId: 'b1', boardName: 'Team', ownerId: hostId, ownerName: 'Olu' }), measure,
      onChange: (state) => saved.push(state),
    });
    return { host, saved };
  }

  it('refuses a growing change the measure puts over 44 KB, and nothing else', async () => {
    const { host } = await soloHost(() => 45_057);
    expect(await host.local({ type: 'addTopic', text: 'Too big' })).toEqual({ ok: false, key: 'boardFull', message: MESSAGES.boardFull });
    expect(host.version.seq).toBe(0);
    expect(host.current.topics).toEqual([]);
    expect((await host.local({ type: 'setShowVotes', value: false })).ok).toBe(true);
  });

  it('accepts a growing change at exactly the cap', async () => {
    const { host } = await soloHost(() => 45_056);
    expect((await host.local({ type: 'addTopic', text: 'Just fits' })).ok).toBe(true);
  });

  it('waits for an async measure, one change at a time, in the order they arrived', async () => {
    const measured: string[][] = [];
    const { host, saved } = await soloHost(async (state) => {
      measured.push(state.topics.map((t) => t.text));
      await sleep(20);
      return state.topics.length > 2 ? 45_057 : 100;
    });
    const results = await Promise.all([
      host.local({ type: 'addTopic', text: 'First' }),
      host.local({ type: 'addTopic', text: 'Second' }),
      host.local({ type: 'addTopic', text: 'Third' }),
    ]);
    expect(results.map((r) => (r.ok ? 'ok' : r.key))).toEqual(['ok', 'ok', 'boardFull']);
    // The first measurement is the empty board as it loads, for the over-limits notice.
    expect(measured).toEqual([[], ['First'], ['First', 'Second'], ['First', 'Second', 'Third']]);
    expect(saved.map((s) => s.topics.length)).toEqual([1, 2]);
    expect(host.version.seq).toBe(2);
  });

  it.each([
    ['throws', () => { throw new Error('boom'); }],
    ['rejects asynchronously', async () => { await sleep(5); throw new Error('boom'); }],
  ])('refuses with the size message when the measure %s, and keeps working', async (_name, measure) => {
    let fail = true;
    const { host } = await soloHost((state) => (fail ? measure() : 100));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await host.local({ type: 'addTopic', text: 'Nope' })).toEqual({ ok: false, key: 'boardFull', message: MESSAGES.boardFull });
    expect(host.version.seq).toBe(0);
    expect(host.current.topics).toEqual([]);
    fail = false;
    expect((await host.local({ type: 'addTopic', text: 'Fine' })).ok).toBe(true);
    expect(host.current.topics).toHaveLength(1);
    warn.mockRestore();
  });

  it('runs the tick in the same queue, after a change still being measured', async () => {
    const { host, saved } = await soloHost(async () => { await sleep(20); return 100; });
    await host.local({ type: 'addTopic', text: 'Pairing' });
    await host.local({ type: 'startDiscussion' });
    await host.local({ type: 'discussTopic', topicId: 1, minutes: 5 });
    const endsAt = host.current.timer!.endsAt;
    const adding = host.local({ type: 'addTopic', text: 'Late idea' });
    const ticking = host.tick(endsAt);
    await Promise.all([adding, ticking]);
    expect(saved.slice(-2).map((s) => [s.topics.length, s.continueVote !== null])).toEqual([[2, false], [2, true]]);
  });
});

describe('closing and failing sends', () => {
  async function host1(extra: Partial<ConstructorParameters<typeof HostSession>[0]> = {}) {
    const signer = await signerFrom(await generateSigningKeys(true));
    const hostId = await fingerprint(signer.pub);
    const saved: BoardState[] = [];
    const host = new HostSession({
      transport: new MemoryNetwork().join('host'), roomKey: await importRoomKey(generateRoomKey()), signer, hostId, epoch: 1,
      state: createBoard({ boardId: 'b1', boardName: 'Team', ownerId: hostId, ownerName: 'Olu' }),
      onChange: (state) => saved.push(state), measure: noSizeCap, ...extra,
    });
    return { host, saved };
  }

  it('never commits, saves or broadcasts a change queued before close()', async () => {
    const { host, saved } = await host1({ measure: async () => { await sleep(20); return 100; } });
    const queued = [host.local({ type: 'addTopic', text: 'In flight' }), host.local({ type: 'addTopic', text: 'Waiting' })];
    host.close();
    await Promise.all(queued);
    expect(saved).toEqual([]);
    expect(host.version.seq).toBe(0);
    expect(host.current.topics).toEqual([]);
    await host.local({ type: 'setShowVotes', value: false });
    expect(saved).toEqual([]);
  });

  it('keeps the committed result when a send fails afterwards', async () => {
    const net = new MemoryNetwork();
    const roomKey = await importRoomKey(generateRoomKey());
    const signer = await signerFrom(await generateSigningKeys(true));
    const hostId = await fingerprint(signer.pub);
    const transport = net.join('host');
    let failing = false;
    const real = transport.send.bind(transport);
    transport.send = (peerId, data) => { if (failing) throw new Error('relay down'); real(peerId, data); };
    const host = new HostSession({
      transport, roomKey, signer, hostId, epoch: 1, measure: noSizeCap,
      state: createBoard({ boardId: 'b1', boardName: 'Team', ownerId: hostId, ownerName: 'Olu' }),
    });
    const pSigner = await signerFrom(await generateSigningKeys(false));
    const ann = new ParticipantSession({ transport: net.join('Ann'), roomKey, signer: pSigner, hostPub: signer.pub, boardId: 'b1', name: 'Ann', onReject: () => undefined });
    await waitFor(() => ann.state !== undefined && ann.state !== null);
    failing = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await host.local({ type: 'addTopic', text: 'Committed anyway' });
    expect(result.ok).toBe(true);
    expect(host.current.topics).toHaveLength(1);
    expect(host.version.seq).toBeGreaterThan(0);
    // A failed send is not an error in protocol 2: acks, resends and the 5 s refresh cover it.
    warn.mockRestore();
  });
});
