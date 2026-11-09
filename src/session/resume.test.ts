import { describe, expect, it } from 'vitest';
import { unseal } from '../crypto/aead';
import { fromUtf8, type Bytes } from '../crypto/bytes';
import { createBoard } from '../engine/board';
import { nextEpoch } from '../store/board-store';
import { FakeScheduler } from '../test/fake-scheduler';
import { BOARD, TestRoom } from '../test/sessions';
import { HybridTransport } from '../transport/hybrid';
import { settle } from '../test/settle';
import { waitFor } from '../test/wait';
import type { Connection } from './participant';
import { REFRESH_MS } from './pacer';
import { PROTOCOL_VERSION } from '../protocol/version';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

async function run(scheduler: FakeScheduler, ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    scheduler.advance(step);
    await settle();
  }
}

async function runUntil(scheduler: FakeScheduler, condition: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t < maxMs && !condition(); t += 100) await run(scheduler, 100);
  expect(condition()).toBe(true);
}

describe('participant resume', () => {
  it('says hello on the relay and straight to the host, and treats the direct path as unproven', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    await settle();
    const sent: Array<{ path: string; body: string }> = [];
    const tap = (path: string) => (from: string, to: string, data: Bytes) => {
      if (from !== 'Ann' || to !== 'host') return;
      void unseal(room.roomKey, data).then((plain) => {
        if (plain[0] === 0x7b) sent.push({ path, body: JSON.parse(JSON.parse(fromUtf8(plain)).body).t });
      });
    };
    room.direct.tap = tap('direct');
    room.relay.tap = tap('relay');
    ann.session.resume();
    await waitFor(() => sent.length === 2);
    expect(sent.map((s) => `${s.path}:${s.body}`).sort()).toEqual(['direct:hello', 'relay:hello']);
    host.stop();
  });

  it('shows no offline state after a 60 s freeze, and is up to date within 5 s', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    let frozenFor = 0; // the participant's clock jumps by this much, as a frozen page's does
    const host = room.host('host', { scheduler });
    const connections: Connection[] = [];
    const ann = await room.person('Ann', {
      scheduler, now: () => scheduler.now() + frozenFor,
      onStatus: () => connections.push(ann.session.connection),
    });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    // While Ann's page is frozen the host carries on, and nothing reaches her.
    room.direct.lose = room.relay.lose = (_from, to) => to === 'Ann';
    await host.local({ type: 'addTopic', text: 'Added while locked' });
    frozenFor = 60_000;
    room.direct.lose = room.relay.lose = undefined;
    connections.length = 0;
    // Her timers may run before the visibility event, so run them first.
    await run(scheduler, 1000);
    ann.session.resume();
    await runUntil(scheduler, () => ann.session.state!.topics.length === 1, 5000);
    expect(connections).not.toContain('hostOffline');
    expect(ann.session.connection).toBe('connected');
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('still decides the host is offline when it doesn’t answer within 5 s of the resume', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    let frozenFor = 0;
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, now: () => scheduler.now() + frozenFor });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    host.stop();
    room.direct.lose = room.relay.lose = (from) => from === 'host';
    await settle(); // let anything already received finish arriving before the clock jumps
    frozenFor = 60_000;
    ann.session.resume();
    await run(scheduler, 4000);
    expect(ann.session.connection).toBe('connected');
    await run(scheduler, 3000);
    expect(ann.session.connection).toBe('hostOffline');
    ann.session.stopHeartbeat();
  });
});

describe('participant resume and the direct path', () => {
  it('asks the direct path to bring back the link to the host it last knew, even once that host is offline', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const direct = room.direct.join('Ann');
    const transport = new HybridTransport(direct, room.relay.join('Ann'));
    const ann = await room.person('Ann', { scheduler, transport });
    ann.session.resume();
    // No host known yet: nothing for the direct path to bring back.
    expect(direct.resumeFocus).toEqual([{ host: null }]);
    const host = room.host('host', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    ann.session.resume();
    expect(direct.resumeFocus.at(-1)).toEqual({ host: 'host' });
    host.stop();
    room.direct.lose = room.relay.lose = (from) => from === 'host';
    await runUntil(scheduler, () => ann.session.connection === 'hostOffline');
    ann.session.resume();
    expect(direct.resumeFocus.at(-1)).toEqual({ host: 'host' });
    ann.session.stopHeartbeat();
  });

  it('tells the direct path at all times which host it follows, so a link lost while visible can be brought back', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const direct = room.direct.join('Ann');
    const ann = await room.person('Ann', { scheduler, transport: new HybridTransport(direct, room.relay.join('Ann')) });
    expect(direct.followed?.()).toEqual({ host: null });
    const host = room.host('host', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    expect(direct.followed?.()).toEqual({ host: 'host' });
    host.stop();
    ann.session.stopHeartbeat();
  });

  it('as the host, names the participants that joined in the last 30 s to the direct path, and only those', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const hostDirect = room.direct.join('host');
    const host = room.host('host', { scheduler, transport: new HybridTransport(hostDirect, room.relay.join('host')) });
    expect(hostDirect.expected?.()).toEqual([]);
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    expect(hostDirect.expected?.()).toEqual(['Ann']);
    // Heard from all the time since, but bound long ago: a participant with no direct path is not one to wait for.
    await run(scheduler, 31_000);
    expect(hostDirect.expected?.()).toEqual([]);
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('as the host, names a participant still on probation, but not one speaking another protocol version', async () => {
    const room = await TestRoom.create();
    const hostDirect = room.direct.join('host');
    const host = room.host('host', { transport: new HybridTransport(hostDirect, room.relay.join('host')) });
    const record = (peerId: string, over: object) => ({
      peerId, personId: peerId, pv: PROTOCOL_VERSION, lastPath: 'relay', lastHeardAt: Date.now(), lastDirectAt: Number.NEGATIVE_INFINITY,
      boundAt: Date.now(), probation: false, ...over,
    });
    const peers = (host as unknown as { peers: Map<string, unknown> }).peers;
    peers.set('a a', record('a', {}));
    peers.set('b b', record('b', { probation: true }));
    peers.set('c c', record('c', { pv: PROTOCOL_VERSION - 1 }));
    expect(hostDirect.expected?.()).toEqual(['a', 'b']);
    host.stop();
  });
});

describe('participant resume and pending pings', () => {
  type Internals = { pendingPongs: Map<number, number>; lastSuspensionGraceAt: number; lastDirectHostAt: number };

  it('forgets pings sent before the grace, and keeps the one the grace just sent', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    let frozenFor = 0;
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, now: () => scheduler.now() + frozenFor });
    const inner = ann.session as unknown as Internals;
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann) && inner.lastDirectHostAt > Number.NEGATIVE_INFINITY);
    // Pongs stop arriving, so every ping from here on stays pending.
    room.direct.lose = (from, to) => from === 'host' && to === 'Ann';
    const before = inner.pendingPongs.size;
    await runUntil(scheduler, () => inner.pendingPongs.size > before);
    const old = [...inner.pendingPongs.keys()];
    // A short freeze, so the direct path is still proven and the grace's ping goes direct.
    frozenFor = 5000;
    await runUntil(scheduler, () => inner.lastSuspensionGraceAt > Number.NEGATIVE_INFINITY);
    const grace = inner.lastSuspensionGraceAt;
    await waitFor(() => inner.pendingPongs.has(grace));
    ann.session.resume();
    expect(inner.pendingPongs.has(grace)).toBe(true);
    for (const t0 of old) expect(inner.pendingPongs.has(t0)).toBe(false);
    ann.session.stopHeartbeat();
    host.stop();
  });
});

describe('host resume', () => {
  it('resubscribes, sends a full refresh at once, and runs the tick', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    let lockedFor = 0; // the host's clock jumps by this much while its phone is locked
    const relay = room.relay.join('host');
    const direct = room.direct.join('host');
    const transport = new HybridTransport(direct, relay);
    let bundles = 0;
    const broadcast = transport.broadcastRelay.bind(transport);
    transport.broadcastRelay = (data) => { bundles += 1; broadcast(data); };
    const host = room.host('host', { transport, scheduler, now: () => scheduler.now() + lockedFor });
    await host.local({ type: 'addTopic', text: 'Pairing' });
    await host.local({ type: 'startDiscussion' });
    await host.local({ type: 'discussTopic', topicId: 1, minutes: 1 });
    await run(scheduler, 1000);
    // The phone was locked through the end of the timebox, so no tick ran.
    lockedFor = 61_000;
    const before = bundles;
    host.resume();
    await waitFor(() => host.current.continueVote !== null);
    expect(host.current.continueVote!.topicId).toBe(1);
    expect(relay.resumed).toBe(1);
    // The host's direct links to every participant count, so it names no focus.
    expect(direct.resumeFocus).toEqual([undefined]);
    await waitFor(() => bundles > before);
    host.stop();
  });

  it('sends its bundle at once on a resume right after its overdue refresh ran, not 500 ms later', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const relay = room.relay.join('host');
    const direct = room.direct.join('host');
    const transport = new HybridTransport(direct, relay);
    const bundleTimes: number[] = [];
    const broadcast = transport.broadcastRelay.bind(transport);
    transport.broadcastRelay = (data) => { bundleTimes.push(scheduler.now()); broadcast(data); };
    const host = room.host('host', { transport, scheduler });
    await run(scheduler, REFRESH_MS);
    // A frozen page's timers run just before its visibility event; the refresh they sent went to a dead socket.
    const resumedAt = scheduler.now();
    bundleTimes.length = 0;
    host.resume();
    await settle();
    expect(bundleTimes).toEqual([resumedAt]);
    host.stop();
  });

  it('tries a failed save again at the next refresh, and sends the change once it is saved', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    let fail = true;
    const host = room.host('host', {
      scheduler,
      save: async (saved) => {
        if (fail) throw new Error('quota exceeded');
        room.saved = structuredClone(saved);
      },
    });
    await host.local({ type: 'addTopic', text: 'Kept in memory' });
    expect(host.saveFailed).toBe(true);
    fail = false;
    await run(scheduler, REFRESH_MS + 500);
    await waitFor(() => !host.saveFailed);
    expect(room.saved?.state.topics.map((t) => t.text)).toEqual(['Kept in memory']);
    host.stop();
  });

  it('reports a board over the limits until it fits again', async () => {
    const room = await TestRoom.create();
    const state = createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' });
    for (let i = 1; i <= 61; i++) {
      state.topics.push({ topicId: i, text: `Topic ${i}`, column: 'ideas', position: -i, authorId: room.hostId, voters: [] });
    }
    state.topicIdSeed = 62;
    let statusChanges = 0;
    const host = room.host('host', { state, onStatus: () => { statusChanges += 1; } });
    await waitFor(() => host.overLimits);
    expect((await host.local({ type: 'addTopic', text: 'One more' })).ok).toBe(false);
    await host.local({ type: 'deleteTopic', topicId: 61 });
    await waitFor(() => !host.overLimits);
    expect(statusChanges).toBe(2);
    host.stop();
  });
});

describe('epochs', () => {
  it('resume as max(saved epoch + 1, now), so a lost or older saved epoch is still beaten', () => {
    expect(nextEpoch(4, 1_760_000_000_000)).toBe(1_760_000_000_000);
    expect(nextEpoch(1_760_000_000_500, 1_760_000_000_000)).toBe(1_760_000_000_501);
  });

  it('treat a saved epoch that is not a safe count as 0, so the next one is the clock', () => {
    const now = 1_760_000_000_000;
    for (const bad of [Infinity, NaN, 1e300, -5, 1.5, Number.MAX_SAFE_INTEGER]) expect(nextEpoch(bad, now)).toBe(now);
  });
});
