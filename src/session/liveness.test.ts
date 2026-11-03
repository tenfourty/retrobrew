import { describe, expect, it } from 'vitest';
import type { Bytes } from '../crypto/bytes';
import { decodeFrame } from '../protocol/envelope';
import { FakeScheduler } from '../test/fake-scheduler';
import { mulberry32 } from '../test/mulberry32';
import { TestRoom } from '../test/sessions';
import { settle } from '../test/settle';
import { waitFor } from '../test/wait';
import { NO_RELAYS_MS as HOST_NO_RELAYS_MS, PEER_RECORD_TTL_MS } from './host';
import { DIRECT_DOWN_MS, ENDED_HELLO_MS, HOST_OFFLINE_MS, NO_RELAYS_MS } from './participant';

// How many of these frames are hellos (always in the protocol 1 layout; nothing else is).
async function helloCount(room: TestRoom, frames: Bytes[]): Promise<number> {
  let n = 0;
  for (const data of frames) {
    const frame = await decodeFrame(room.roomKey, data);
    if (frame?.kind === 'envelope' && frame.pv === 1) n += 1;
  }
  return n;
}

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

// Lets the fake clock run in small steps while the real event loop does the cryptography.
async function run(scheduler: FakeScheduler, ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    scheduler.advance(step);
    await settle();
  }
}

// Runs the fake clock until the condition holds, or fails after maxMs of fake time.
async function runUntil(scheduler: FakeScheduler, condition: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t < maxMs && !condition(); t += 100) await run(scheduler, 100);
  expect(condition()).toBe(true);
}

describe('participant liveness', () => {
  it('decides the host is offline after 20 s with no host message on any path, and back when it hears again', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const statuses: boolean[] = [];
    const ann = await room.person('Ann', { scheduler, onHostStatus: (online) => statuses.push(online) });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    expect(ann.session.connection).toBe('connected');
    room.direct.lose = room.relay.lose = (from) => from === 'host';
    await settle(); // let anything already received finish arriving, on the fake clock's current time
    await run(scheduler, HOST_OFFLINE_MS - 1000);
    expect(ann.session.hostOnline).toBe(true);
    await run(scheduler, 3000);
    expect(ann.session.hostOnline).toBe(false);
    expect(ann.session.connection).toBe('hostOffline');
    // Read-only while the host is offline.
    expect(await ann.session.send({ type: 'addTopic', text: 'x' })).toBe(false);
    room.direct.lose = room.relay.lose = undefined;
    await runUntil(scheduler, () => ann.session.connection === 'connected');
    expect(statuses).toEqual([true, false, true]);
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('doesn’t count a replayed host view as hearing from the host', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    // Keep a copy of the host's latest view on each path, then cut the host off and replay only those copies.
    const captured: Bytes[] = [];
    room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') captured.push(data); };
    await run(scheduler, 6000);
    room.direct.tap = room.relay.tap = undefined;
    expect(captured.length).toBeGreaterThan(0);
    const replays = new Set<Bytes>(captured.slice(-4));
    room.direct.lose = room.relay.lose = (from, _to, data) => from === 'host' && !replays.has(data);
    await settle();
    for (let t = 0; t < HOST_OFFLINE_MS + 3000; t += 1000) {
      for (const data of replays) {
        room.direct.deliver('host', 'Ann', data);
        room.relay.deliver('host', 'Ann', data);
      }
      await run(scheduler, 1000);
    }
    expect(ann.session.hostOnline).toBe(false);
    expect(ann.session.connection).toBe('hostOffline');
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('says hello to a new host that joins while the old host’s peer is still there', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const first = room.host('host-1', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    await settle(); // let the hello that answers the first view finish going out
    // The facilitator reloads: the old page is gone but its peer hasn't been seen leaving. The new host's relay
    // events are lost, so only a hello on the direct path can bring Ann its views before the 20 s timeout.
    first.stop();
    const hellos: number[] = [];
    const startedAt = scheduler.now();
    room.direct.tap = room.relay.tap = (from, to) => { if (from === 'Ann' && to === 'host-2') hellos.push(scheduler.now()); };
    room.relay.lose = (from) => from === 'host-2';
    const second = room.host('host-2', { scheduler, epoch: 2 });
    await run(scheduler, 1000);
    await waitFor(() => hellos.length > 0);
    expect(hellos[0] - startedAt).toBeLessThanOrEqual(1000);
    await second.local({ type: 'addTopic', text: 'After the reload' });
    await runUntil(scheduler, () => ann.session.state?.topics.length === 1, 3000);
    ann.session.stopHeartbeat();
    second.stop();
  });

  it('falls back to the relay after 15 s without a host message on the direct path, pinging with an echo', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    const pingsOnRelay: number[] = [];
    room.relay.tap = (from, to) => { if (from === 'Ann' && to === 'Ann') pingsOnRelay.push(scheduler.now()); }; // echoes come back to Ann
    room.direct.lose = (from) => from === 'host';
    await run(scheduler, DIRECT_DOWN_MS + 6000);
    expect(pingsOnRelay.length).toBeGreaterThan(0);
    expect(ann.session.hostOnline).toBe(true);
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('says hello after 2, 4 and 8 s, then every 15 s, until it has a host', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(0);
    const listener = room.relay.join('listener');
    const hellos: number[] = [];
    // Delivery happens once the hello is sealed, a moment after it was sent, so round down to the second.
    room.relay.tap = (from, to) => { if (from === 'Ann' && to === 'listener') hellos.push(Math.floor(scheduler.now() / 1000) * 1000); };
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await run(scheduler, 45_000);
    await waitFor(() => hellos.filter((t) => t >= 1000).length >= 5);
    expect(hellos.filter((t) => t >= 1000)).toEqual([2000, 6000, 14_000, 29_000, 44_000]);
    expect(listener.peers()).toContain('Ann');
    ann.session.stopHeartbeat();
  });

  it('doesn’t answer other people’s hellos on the relay, so hellos don’t multiply as people join', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(0);
    room.relay.join('listener');
    let hellos = 0;
    room.relay.tap = (from, to) => { if (from === 'Ann' && to === 'listener') hellos += 1; };
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    for (const name of ['Bob', 'Cid', 'Dee', 'Eve']) await room.person(name, { scheduler, directPath: false });
    await run(scheduler, 1500);
    await settle();
    expect(hellos).toBe(1);
    ann.session.stopHeartbeat();
  });

  it('says hello as soon as a full refresh shows the host doesn’t know it, rather than waiting for the back-off', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(0);
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    // The back-off's hellos went out at 2, 6 and 14 s; the next is due at 29 s.
    await run(scheduler, 20_000);
    const host = room.host('host', { scheduler });
    const startedAt = scheduler.now();
    await runUntil(scheduler, () => joined(ann), 8000);
    expect(scheduler.now() - startedAt).toBeLessThan(6500);
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('after the meeting has ended, keeps the ended view and says hello every 45 s', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    await host.local({ type: 'endMeeting' });
    await run(scheduler, 1000);
    await waitFor(() => ann.session.state!.phase === 'ended');
    host.stop();
    room.direct.drop('host');
    room.relay.drop('host');
    const listener = room.relay.join('listener');
    await waitFor(() => listener.peers().includes('Ann'));
    await settle();
    let hellos = 0;
    room.relay.tap = (from, to) => { if (from === 'Ann' && to === 'listener') hellos += 1; };
    await run(scheduler, 3 * ENDED_HELLO_MS);
    // One every 45 s: three in 135 s, plus up to two already due when the host went. Every 15 s would be nine.
    // Sealing is asynchronous, so the last one may still be on its way.
    await waitFor(() => hellos >= 3);
    await settle();
    expect(hellos).toBeLessThanOrEqual(5);
    expect(ann.session.state!.phase).toBe('ended');
    ann.session.stopHeartbeat();
  }, 20_000);

  it('doesn’t call the host offline after the page itself was frozen, and still notices a silent host after', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    let frozenFor = 0;
    const statuses: boolean[] = [];
    const ann = await room.person('Ann', { scheduler, now: () => scheduler.now() + frozenFor, onHostStatus: (online) => statuses.push(online) });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    await run(scheduler, 2000);
    // The tab was suspended for 40 s: no timer ran, and its clock jumped on resuming.
    frozenFor += 40_000;
    await run(scheduler, 1000);
    expect(ann.session.hostOnline).toBe(true);
    expect(ann.session.connection).toBe('connected');
    expect(await ann.session.send({ type: 'addTopic', text: 'After the freeze' })).toBe(true);
    await runUntil(scheduler, () => host.current.topics.length === 1, 5000);
    expect(statuses).toEqual([true]);
    // A host that then goes silent for 20 s is still noticed.
    room.direct.lose = room.relay.lose = (from) => from === 'host';
    await settle();
    await run(scheduler, HOST_OFFLINE_MS + 2000);
    expect(ann.session.connection).toBe('hostOffline');
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('grants the suspension grace once, so a throttled tab ticking once a minute still notices a dead host', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    let frozenFor = 0;
    const ann = await room.person('Ann', { scheduler, now: () => scheduler.now() + frozenFor });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    await run(scheduler, 2000);
    host.stop();
    room.direct.lose = room.relay.lose = (from) => from === 'host';
    await settle();
    // A hidden tab: its timers are throttled to one tick a minute.
    for (let slowTicks = 0; slowTicks < 2 && ann.session.connection !== 'hostOffline'; slowTicks++) {
      frozenFor += 59_000;
      await run(scheduler, 1000);
    }
    expect(ann.session.connection).toBe('hostOffline');
    ann.session.stopHeartbeat();
  });

  it('lets an attendee refused a rename say hello again once its record has expired, and get views again', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    // Over the cap once anyone's name is longer than five characters.
    const host = room.host('host', { scheduler, measure: (state) => (Object.values(state.attendees).some((a) => a.name.length > 5) ? 45_057 : 0) });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    await runUntil(scheduler, () => joined(ann));
    const tab2 = await room.person('Ann-tab-2', { scheduler, signer: ann.signer, name: 'Annabelle', directPath: false });
    await runUntil(scheduler, () => tab2.session.state?.joinRefused === 'meetingFullSize');
    await settle();
    // The tab hears nothing from the host until its record has expired (a laptop lid closed, say).
    room.relay.lose = (from, to) => from === 'host' && to === 'Ann-tab-2';
    await run(scheduler, PEER_RECORD_TTL_MS + 2000, 500);
    await host.tick(scheduler.now());
    expect(host.presence().some((p) => p.peerId === 'Ann-tab-2')).toBe(false);
    room.relay.lose = undefined;
    // Still listed as an attendee, so the refusal doesn't stop its hellos: it binds again within the back-off.
    await runUntil(scheduler, () => host.presence().some((p) => p.peerId === 'Ann-tab-2'), 20_000);
    await host.local({ type: 'addTopic', text: 'Back again' });
    await runUntil(scheduler, () => tab2.session.state?.topics.length === 1, 5000);
    ann.session.stopHeartbeat();
    tab2.session.stopHeartbeat();
    host.stop();
  });

  it('keeps versionMismatch once it is reported, whatever else happens', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    ann.session.connection = 'versionMismatch';
    await host.local({ type: 'addTopic', text: 'Still mismatched' });
    room.relay.health = [{ url: 'wss://relay.example', connected: false, refused: 0, notices: 0 }];
    await run(scheduler, NO_RELAYS_MS + 2000);
    room.direct.lose = room.relay.lose = (from) => from === 'host';
    await run(scheduler, HOST_OFFLINE_MS + 2000);
    expect(ann.session.connection).toBe('versionMismatch');
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('backs off the hellos a refresh prompts when the host doesn’t bind this tab, rather than one per refresh', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const frames: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') frames.push(data); };
    room.relay.lose = (from, to) => from === 'Ann' && to === 'host'; // the host never hears Ann
    const ann = await room.person('Ann', { scheduler, directPath: false });
    await run(scheduler, 60_000, 250);
    await settle();
    // One hello on loading, then prompted ones 2, 4, 8 and 15 s apart at the soonest: at most seven in a minute.
    // One per 5 s refresh would be thirteen.
    const hellos = await helloCount(room, frames);
    expect(hellos).toBeGreaterThan(1);
    expect(hellos).toBeLessThanOrEqual(7);
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('stops the hellos a refresh prompts once this tab has been refused', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const frames: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Nobody' && to === 'host') frames.push(data); };
    const nobody = await room.person('Nobody', { scheduler, name: '   ', directPath: false });
    await runUntil(scheduler, () => nobody.session.state?.joinRefused === 'emptyName');
    await run(scheduler, 5000);
    await settle();
    const before = frames.length;
    // The refusal leaves the bundles after 30 s; a refused tab doesn't say hello again to be refused again.
    await run(scheduler, 60_000, 250);
    await settle();
    expect(await helloCount(room, frames.slice(before))).toBe(0);
    nobody.session.stopHeartbeat();
    host.stop();
  });

  it('reports noRelays after 10 s with no relay socket open, on both sides', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    room.relay.health = [{ url: 'wss://relay.example', connected: false, refused: 0, notices: 0 }];
    await run(scheduler, NO_RELAYS_MS - 2000);
    expect(ann.session.connection).toBe('connected');
    await run(scheduler, 3000);
    expect(ann.session.connection).toBe('noRelays');
    expect(host.connection).toBe('noRelays');
    expect(HOST_NO_RELAYS_MS).toBe(NO_RELAYS_MS);
    room.relay.health = [{ url: 'wss://relay.example', connected: true, refused: 3, notices: 1 }];
    await run(scheduler, 2000);
    expect(ann.session.connection).toBe('connected');
    expect(host.connection).toBe('connected');
    expect(host.relayHealth()).toEqual([{ url: 'wss://relay.example', connected: true, refused: 3, notices: 1 }]);
    ann.session.stopHeartbeat();
    host.stop();
  });
});

describe('host presence', () => {
  it('takes someone out of online after 15 s without a hello, command or ping', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    await runUntil(scheduler, () => joined(ann));
    // Let the ping that answers the hello's reply, and the views it brings, finish: the last thing Ann sends.
    for (let i = 0; i < 10; i++) {
      await run(scheduler, 100);
      await settle();
    }
    expect(host.online()).toContain(ann.id);
    await run(scheduler, 16_000, 1000);
    expect(host.online()).not.toContain(ann.id);
    expect(host.presence()[0].status).toBe('offline');
    host.stop();
  });
});

describe('the clock offset', () => {
  // The host's clock runs 7 s ahead of the participant's (docs/product/sync-protocol.md, Testable bound).
  const SKEW = 7000;

  it('is within 500 ms on the relay path after four bundles and four echoes, with each event delayed 50–600 ms', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const randoms = new Map<string, () => number>();
    room.relay.scheduler = scheduler;
    room.relay.delay = (from) => {
      if (!randoms.has(from)) randoms.set(from, mulberry32(from.length * 7919 + 20261006));
      return 50 + randoms.get(from)!() * 550;
    };
    const host = room.host('host', { scheduler, now: () => scheduler.now() + SKEW });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await run(scheduler, 22_000, 10);
    await waitFor(() => joined(ann));
    expect(Math.abs(ann.session.clock.offsetAt(scheduler.now()) - SKEW)).toBeLessThan(500);
    ann.session.stopHeartbeat();
    host.stop();
  }, 30_000);

  it('is within 100 ms on the direct path, with each message delayed 5–100 ms', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const random = mulberry32(20261006);
    room.direct.scheduler = scheduler;
    room.direct.delay = () => 5 + random() * 95;
    const host = room.host('host', { scheduler, now: () => scheduler.now() + SKEW });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await run(scheduler, 22_000, 5);
    await waitFor(() => joined(ann));
    expect(Math.abs(ann.session.clock.offsetAt(scheduler.now()) - SKEW)).toBeLessThan(100);
    ann.session.stopHeartbeat();
    host.stop();
  }, 30_000);
});
