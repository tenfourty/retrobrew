import { describe, expect, it } from 'vitest';
import type { Bytes } from '../crypto/bytes';
import { generateSigningKeys, signerFrom } from '../crypto/sign';
import { encodeWire, sealEnvelope } from '../protocol/envelope';
import { PROTOCOL_VERSION } from '../protocol/version';
import { FakeScheduler } from '../test/fake-scheduler';
import { fresh } from '../test/hello';
import { BOARD, TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { JOIN_REFUSED_MAX, JOIN_REFUSED_MS, ONE_OFF_MAX, ONE_OFF_WINDOW_MS, REFUSED_HELLO_MS, type HostSession } from './host';
import { REFRESH_MS } from './pacer';

async function run(scheduler: FakeScheduler, ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    scheduler.advance(step);
    await settle(HEAVY_SETTLE_MS);
  }
}

// The host's in-memory list of refused joiners, which signers minted with the room key could otherwise grow.
const refusedCount = (host: unknown) => (host as { joinRefused: Map<string, unknown> }).joinRefused.size;

describe('the refused joiners the host remembers', () => {
  it('stay within a cap however many signers are refused, and are forgotten once their refusal is over', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    // An empty name is refused (emptyName), and a refused newcomer is never an attendee.
    const people = [];
    for (let i = 0; i < JOIN_REFUSED_MAX + 5; i++) {
      people.push(await room.person(`p${i}`, { name: '', scheduler, directPath: false }));
      await settle(HEAVY_SETTLE_MS); // one hello at a time, so the order they are refused in is the order they were made
    }
    await run(scheduler, 2000);
    expect(refusedCount(host)).toBe(JOIN_REFUSED_MAX);
    // The latest are kept and the oldest five are gone.
    const kept = new Set((host as unknown as { joinRefused: Map<string, unknown> }).joinRefused.keys());
    expect(people.slice(0, 5).some((p) => kept.has(p.id))).toBe(false);
    expect(people.slice(5).every((p) => kept.has(p.id))).toBe(true);
    expect(Object.keys(host.current.attendees)).toHaveLength(1);
    // The signers go away, so no hello renews a refusal.
    for (const p of people) { p.session.stopHeartbeat(); room.relay.drop(p.name); }
    await run(scheduler, 2 * JOIN_REFUSED_MS, 500);
    expect(refusedCount(host)).toBe(0);
    host.stop();
  }, 60_000);
});

// The same person saying hello again: each one is a new hello of the same tab, with the next count, as a page's
// repeated hellos are. (A copy of an earlier hello is refused as not newer.)
function again(room: TestRoom, scheduler: FakeScheduler, who: { signer: Parameters<typeof sealEnvelope>[0]; session: { sid: string } }, name: string) {
  let n = 1000;
  return async (): Promise<Bytes> => encodeWire(room.roomKey, await sealEnvelope(who.signer,
    { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name, peer: 'Late', ...fresh({ sid: who.session.sid, n: n++, at: scheduler.now() }) }), 1);
}

// A refused joiner (an empty name is refused with emptyName), who has said hello once and then goes quiet.
async function refusedJoiner(directPath: boolean) {
  const room = await TestRoom.create();
  const scheduler = new FakeScheduler(Date.now());
  const host = room.host('host', { scheduler });
  const hellos: Bytes[] = [];
  room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'Late' && to === 'host') hellos.push(data); };
  const late = await room.person('Late', { name: '   ', scheduler, directPath });
  for (let t = 0; t < 30_000 && late.session.state?.joinRefused !== 'emptyName'; t += 100) await run(scheduler, 100);
  expect(late.session.state?.joinRefused).toBe('emptyName');
  // It would otherwise say hello again, and be refused again, for another 30 s.
  late.session.stopHeartbeat();
  await run(scheduler, 1000);
  room.direct.tap = room.relay.tap = undefined;
  return { room, scheduler, host, late, hello: again(room, scheduler, late, '   ') };
}

const joinsRun = (host: HostSession) => {
  const internals = host as unknown as { run: (...args: unknown[]) => Promise<unknown> };
  const original = internals.run.bind(host);
  let count = 0;
  internals.run = (...args) => { count += 1; return original(...args); };
  return () => count;
};

describe('a refused joiner', () => {
  it.each([['the relay', false], ['the direct path', true]])('gets its refusal on %s, and is never online, in presence or an attendee', async (_path, directPath) => {
    const { host, late } = await refusedJoiner(directPath);
    expect(host.online()).not.toContain(late.id);
    expect(host.presence().map((p) => p.participantId)).not.toContain(late.id);
    expect(host.current.attendees[late.id]).toBeUndefined();
    host.stop();
  }, 60_000);

  it('keeps getting direct snapshots in each full refresh until its 30 s window closes, and none after', async () => {
    const { room, scheduler, host, late, hello } = await refusedJoiner(true);
    let direct = 0;
    room.direct.tap = (from, to) => { if (from === 'host' && to === 'Late') direct += 1; };
    // Its first hello went by the relay, before the direct path was up; the next one comes direct and is answered so.
    await run(scheduler, REFUSED_HELLO_MS);
    room.direct.deliver('Late', 'host', await hello());
    await run(scheduler, 100);
    direct = 0; // that answer is counted in the other test; here, only what the refreshes send
    await run(scheduler, 2 * REFRESH_MS);
    expect(direct).toBeGreaterThan(0);
    await run(scheduler, JOIN_REFUSED_MS + 1000, 500);
    direct = 0;
    await host.local({ type: 'setShowVotes', value: false });
    await run(scheduler, 3 * REFRESH_MS);
    expect(direct).toBe(0);
    expect(host.online()).not.toContain(late.id);
    host.stop();
  }, 60_000);

  it('is answered at most every 5 s for the same hello, without running the join again', async () => {
    const { room, scheduler, host, hello } = await refusedJoiner(true);
    const joins = joinsRun(host);
    let snapshots = 0;
    room.direct.tap = (from, to) => { if (from === 'host' && to === 'Late') snapshots += 1; };
    await run(scheduler, REFUSED_HELLO_MS); // the first answer is old enough to be answered again
    snapshots = 0;
    for (let i = 0; i < 5; i++) room.direct.deliver('Late', 'host', await hello());
    await settle(HEAVY_SETTLE_MS);
    // One answer, not one per hello, and none of them a join.
    expect(snapshots).toBe(1);
    expect(joins()).toBe(0);
    for (let i = 0; i < 5; i++) room.direct.deliver('Late', 'host', await hello());
    await settle(HEAVY_SETTLE_MS);
    expect(snapshots).toBe(1); // within 5 s of the last answer
    expect(joins()).toBe(0);
    host.stop();
  }, 60_000);

  it('is held to one direct snapshot per 5 s even once the 64-entry cap has forgotten it', async () => {
    const { room, scheduler, host, hello } = await refusedJoiner(true);
    const joins = joinsRun(host);
    const forget = () => (host as unknown as { joinRefused: Map<string, unknown> }).joinRefused.clear(); // evicted by the cap
    let snapshots = 0;
    room.direct.tap = (from, to) => { if (from === 'host' && to === 'Late') snapshots += 1; };
    forget();
    // The set-up's own refusal snapshot (or a refresh's) may be under 5 s old, which depends on when the joiner's first
    // hello got through. With the refusal forgotten no refresh sends to it, so after one window the limit is clear.
    await run(scheduler, ONE_OFF_WINDOW_MS);
    room.direct.deliver('Late', 'host', await hello());
    await run(scheduler, 100);
    expect(joins()).toBe(1); // forgotten, so it is a new refusal...
    expect(snapshots).toBe(1);
    forget();
    room.direct.deliver('Late', 'host', await hello());
    await run(scheduler, 100);
    expect(joins()).toBe(2);
    expect(snapshots).toBe(1); // ...but the one-off limit still holds its direct snapshot to one per 5 s
    host.stop();
  }, 60_000);

  it('runs the join once for hellos that arrive together before the first refusal', async () => {
    const { room, scheduler, host, hello } = await refusedJoiner(true);
    const joins = joinsRun(host);
    (host as unknown as { joinRefused: Map<string, unknown> }).joinRefused.clear();
    for (let i = 0; i < 5; i++) room.direct.deliver('Late', 'host', await hello());
    await run(scheduler, 100);
    expect(joins()).toBe(1);
    host.stop();
  }, 60_000);

  it('runs the join again after 5 s for a size refusal, which a smaller board can clear', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    let size = 1_000_000; // over the cap, so a join is refused with meetingFullSize
    const host = room.host('host', { scheduler, measure: () => size });
    const hellos: Bytes[] = [];
    room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'Late' && to === 'host') hellos.push(data); };
    const late = await room.person('Late', { scheduler, directPath: false });
    for (let t = 0; t < 30_000 && late.session.state?.joinRefused !== 'meetingFullSize'; t += 100) await run(scheduler, 100);
    expect(late.session.state?.joinRefused).toBe('meetingFullSize');
    late.session.stopHeartbeat();
    room.direct.tap = room.relay.tap = undefined;
    size = 0; // the board has shrunk
    const joins = joinsRun(host);
    const sayAgain = again(room, scheduler, late, 'Late');
    room.relay.deliver('Late', 'host', await sayAgain());
    await run(scheduler, 100);
    expect(joins()).toBe(0); // within 5 s: from memory
    expect(host.current.attendees[late.id]).toBeUndefined();
    await run(scheduler, REFUSED_HELLO_MS);
    room.relay.deliver('Late', 'host', await sayAgain());
    await run(scheduler, 100);
    expect(joins()).toBe(1);
    expect(host.current.attendees[late.id]).toBeDefined();
    host.stop();
  }, 60_000);

  it('keeps direct refusal snapshots inside the one-off cap however many signers are refused', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const peers = Array.from({ length: 12 }, (_, i) => `m${i}`);
    for (const peer of peers) {
      room.direct.join(peer);
      const signer = await signerFrom(await generateSigningKeys(false));
      const hello = await encodeWire(room.roomKey, await sealEnvelope(signer, { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: '', peer, ...fresh() }), 1);
      room.direct.deliver(peer, 'host', hello);
      await settle(HEAVY_SETTLE_MS);
    }
    await run(scheduler, 100);
    expect(refusedCount(host)).toBe(peers.length);
    let sent: string[] = [];
    room.direct.tap = (from, to) => { if (from === 'host' && peers.includes(to)) sent.push(to); };
    for (let refresh = 0; refresh < 4; refresh++) {
      sent = [];
      await run(scheduler, REFRESH_MS);
      // Exactly the cap, and to the newest refusals: m11 down to m7.
      expect(sent.sort()).toEqual(peers.slice(-ONE_OFF_MAX).sort());
    }
    host.stop();
  }, 60_000);
});
