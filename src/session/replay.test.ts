import { describe, expect, it } from 'vitest';
import type { Bytes } from '../crypto/bytes';
import { decodeFrame, encodeWire, openEnvelope, sealEnvelope } from '../protocol/envelope';
import { FakeScheduler } from '../test/fake-scheduler';
import { BOARD, TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { generateSigningKeys, signerFrom } from '../crypto/sign';
import { newSid } from '../protocol/sid';
import { FreshMemory } from './fresh';
import { ONLINE_MS, PEER_RECORD_TTL_MS, PING_FRESH_MS, type HostSession } from './host';
import { HOST_OFFLINE_MS } from './participant';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

// Runs the fake clock in steps while the real event loop does the cryptography.
async function run(scheduler: FakeScheduler, ms: number, step = 250): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    scheduler.advance(step);
    await settle(HEAVY_SETTLE_MS);
  }
}

async function meeting(directPath = true) {
  const room = await TestRoom.create();
  const scheduler = new FakeScheduler(Date.now());
  const host = room.host('host', { scheduler });
  const ann = await room.person('Ann', { scheduler, directPath });
  ann.session.startHeartbeat();
  for (let i = 0; i < 300 && !joined(ann); i++) await run(scheduler, 100, 100);
  expect(joined(ann)).toBe(true);
  return { room, scheduler, host, ann };
}

// The pings in a list of captured frames, as the host would read them.
async function pingsIn(room: TestRoom, frames: Bytes[]) {
  const out: Array<{ data: Bytes; n: number; sid: string; t0: number }> = [];
  for (const data of frames) {
    const frame = await decodeFrame(room.roomKey, data);
    const opened = frame?.kind === 'envelope' ? await openEnvelope(frame.env) : null;
    const message = opened?.message as { t?: string; n?: number; sid?: string; t0?: number } | undefined;
    if (message?.t === 'ping') out.push({ data, n: message.n!, sid: message.sid!, t0: message.t0! });
  }
  return out;
}

describe('replayed messages', () => {
  it('replayed host bundles, snapshots and pongs never keep the host online once it has gone, or move the clock', async () => {
    const { room, scheduler, host, ann } = await meeting();
    const captured: Array<['direct' | 'relay', Bytes]> = [];
    room.direct.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') captured.push(['direct', data]); };
    room.relay.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') captured.push(['relay', data]); };
    await host.local({ type: 'addTopic', text: 'Seen' });
    await run(scheduler, 12_000);
    room.direct.tap = room.relay.tap = undefined;
    expect(captured.some(([path]) => path === 'direct')).toBe(true);
    expect(captured.some(([path]) => path === 'relay')).toBe(true);
    // The host goes quiet: nothing it sends arrives any more, except what someone replays.
    let replaying = false;
    room.direct.lose = room.relay.lose = (from) => from === 'host' && !replaying;
    await run(scheduler, 1000); // anything already in flight lands
    const offset = ann.session.clock.offset;
    for (let t = 0; t < HOST_OFFLINE_MS + 10_000; t += 2000) {
      replaying = true;
      for (const [path, data] of captured) (path === 'direct' ? room.direct : room.relay).deliver('host', 'Ann', data);
      replaying = false;
      await run(scheduler, 2000);
    }
    expect(ann.session.hostOnline).toBe(false);
    expect(ann.session.clock.offset).toBe(offset);
    expect(ann.session.state!.topics.map((t) => t.text)).toEqual(['Seen']);
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);

  it('a replayed older bundle changes neither the view nor the clock offset', async () => {
    const { room, scheduler, host, ann } = await meeting(false);
    const bundles: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') bundles.push(data); };
    await run(scheduler, 6000);
    await host.local({ type: 'addTopic', text: 'Newer' });
    await run(scheduler, 6000);
    room.relay.tap = undefined;
    const old = bundles[0];
    expect((await decodeFrame(room.roomKey, old))?.kind).toBe('bundle');
    // Time passes with the host quiet, so a replayed bundle would be received much later than it was made: if its clock
    // reading counted, eight replays would push every genuine reading out of the window.
    room.relay.lose = (from) => from === 'host';
    await run(scheduler, 30_000);
    ann.session.stopHeartbeat();
    await run(scheduler, 1000);
    const offset = ann.session.clock.offset;
    room.relay.lose = undefined;
    for (let i = 0; i < 10; i++) room.relay.deliver('host', 'Ann', old);
    await settle(HEAVY_SETTLE_MS);
    expect(ann.session.clock.offset).toBe(offset);
    expect(ann.session.state!.topics.map((t) => t.text)).toEqual(['Newer']);
    host.stop();
  }, 60_000);

  it('a replayed ping keeps nobody online, and a stale one is refused', async () => {
    const { room, scheduler, host, ann } = await meeting(false);
    const sent: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') sent.push(data); };
    await run(scheduler, 11_000);
    room.relay.tap = undefined;
    const pings = await pingsIn(room, sent);
    expect(pings.length).toBeGreaterThan(1);
    expect(pings.map((p) => p.n)).toEqual(pings.map((_, i) => pings[0].n + i));
    expect(new Set(pings.map((p) => p.sid))).toEqual(new Set([ann.session.sid]));
    // Ann goes quiet; her old pings are replayed every 5 s.
    ann.session.stopHeartbeat();
    let replaying = false;
    room.relay.lose = (from) => from === 'Ann' && !replaying;
    await run(scheduler, 500);
    for (let t = 0; t < ONLINE_MS + 10_000; t += 5000) {
      replaying = true;
      for (const { data } of pings) room.relay.deliver('Ann', 'host', data);
      replaying = false;
      await run(scheduler, 5000);
    }
    expect(host.online()).not.toContain(ann.id);
    const fresh = async (n: number, at: number) => encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'ping', boardId: BOARD, sid: ann.session.sid, n, at, t0: 1, peer: 'Ann' }));
    // A new ping whose idea of the host's clock is two minutes out is refused too, in either direction.
    for (const [n, at] of [[1000, scheduler.now() - 2 * PING_FRESH_MS], [1001, scheduler.now() + 2 * PING_FRESH_MS]]) {
      replaying = true;
      room.relay.deliver('Ann', 'host', await fresh(n, at));
      replaying = false;
      await run(scheduler, 500);
      expect(host.online()).not.toContain(ann.id);
    }
    // The same kind of ping, newer and fresh, is accepted: the refusals above were for the replay and the stale clock.
    replaying = true;
    room.relay.deliver('Ann', 'host', await fresh(1002, scheduler.now()));
    replaying = false;
    await run(scheduler, 500);
    expect(host.online()).toContain(ann.id);
    host.stop();
  }, 60_000);

  it('each ping has its own t0 and the tab’s next count, even in one millisecond', async () => {
    const { room, scheduler, host, ann } = await meeting();
    const sent: Bytes[] = [];
    room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') sent.push(data); };
    ann.session.stopHeartbeat();
    await run(scheduler, 500);
    sent.length = 0;
    await ann.session.ping();
    await ann.session.ping();
    await ann.session.ping();
    await settle(HEAVY_SETTLE_MS);
    const pings = await pingsIn(room, sent);
    expect(pings).toHaveLength(3);
    expect(new Set(pings.map((p) => p.t0)).size).toBe(3);
    expect(pings.map((p) => p.n)).toEqual([pings[0].n, pings[0].n + 1, pings[0].n + 2]);
    expect(pings[0].n).toBeGreaterThan(0);
    host.stop();
  }, 60_000);

  it('still accepts the direct probe that proves a path coming up late: its pings count up on the tab’s own sid', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: 'later' });
    ann.session.startHeartbeat();
    for (let i = 0; i < 300 && !joined(ann); i++) await run(scheduler, 100, 100);
    const sent: Bytes[] = [];
    room.direct.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') sent.push(data); };
    room.direct.connect('Ann', 'host');
    for (let i = 0; i < 100 && host.presence().find((p) => p.participantId === ann.id)?.status !== 'direct'; i++) await run(scheduler, 100, 100);
    expect(host.presence().find((p) => p.participantId === ann.id)?.status).toBe('direct');
    await run(scheduler, 7000); // a probe every 2 s until the first pong
    const pings = await pingsIn(room, sent);
    expect(pings.length).toBeGreaterThan(0);
    expect(new Set(pings.map((p) => p.sid))).toEqual(new Set([ann.session.sid]));
    for (let i = 1; i < pings.length; i++) expect(pings[i].n).toBeGreaterThan(pings[i - 1].n);
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);
});

// A hello alone makes a record, never presence: the person is online only once a ping or command is accepted.
// The hellos among captured frames.
async function helloesIn(room: TestRoom, frames: Bytes[]): Promise<Bytes[]> {
  const out: Bytes[] = [];
  for (const data of frames) {
    const frame = await decodeFrame(room.roomKey, data);
    const opened = frame?.kind === 'envelope' ? await openEnvelope(frame.env) : null;
    if ((opened?.message as { t?: string } | undefined)?.t === 'hello') out.push(data);
  }
  return out;
}

describe('a hello alone never makes anyone online', () => {
  it('a genuine join is online once its first ping is accepted', async () => {
    const { host, ann } = await meeting();
    expect(host.online()).toContain(ann.id);
    expect(host.presence().find((p) => p.participantId === ann.id)?.status).not.toBe('offline');
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);

  it('a copy of an old hello after the record expired makes no record and leaves the person offline', async () => {
    const { room, scheduler, host, ann } = await meeting(false);
    const hellos: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') hellos.push(data); };
    ann.session.rehello();
    await run(scheduler, 1000);
    room.relay.tap = undefined;
    const kept = await helloesIn(room, hellos);
    expect(kept.length).toBeGreaterThan(0);
    ann.session.stopHeartbeat();
    room.relay.lose = (from) => from === 'Ann';
    await run(scheduler, PEER_RECORD_TTL_MS + ONLINE_MS + 5000, 1000);
    await host.tick(scheduler.now()); // room.host() starts no timer of its own, so expiry runs on this tick
    expect(host.presence().some((p) => p.participantId === ann.id)).toBe(false);
    expect(host.online()).not.toContain(ann.id);
    room.relay.lose = undefined;
    for (const data of kept) room.relay.deliver('Ann', 'host', data);
    await run(scheduler, 1000);
    // A copy of an old hello changes nothing at all: no record, and so no presence and no reply limit lifted.
    expect(host.presence().some((p) => p.participantId === ann.id)).toBe(false);
    expect(host.online()).not.toContain(ann.id);
    host.stop();
  }, 60_000);

  it('a repeated hello after the host restarted leaves the person offline', async () => {
    const { room, scheduler, host, ann } = await meeting(false);
    const hellos: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') hellos.push(data); };
    ann.session.rehello();
    await run(scheduler, 1000);
    room.relay.tap = undefined;
    ann.session.stopHeartbeat();
    const kept = await helloesIn(room, hellos);
    expect(kept.length).toBeGreaterThan(0);
    host.close();
    await run(scheduler, 500);
    const second = room.host('host2', { scheduler, epoch: 2 });
    // Ann's own page would answer the new host with pings; only the replayed hellos reach it here.
    let replaying = false;
    room.relay.lose = (from) => from === 'Ann' && !replaying;
    replaying = true;
    for (const data of kept) room.relay.deliver('Ann', 'host2', data);
    replaying = false;
    await run(scheduler, 1000);
    expect(second.presence().some((p) => p.participantId === ann.id)).toBe(true);
    expect(second.online()).not.toContain(ann.id);
    second.stop();
  }, 60_000);
});

describe('a replayed command keeps nobody online', () => {
  it('an old command delivered again is not heard from, and a new one is', async () => {
    const { room, scheduler, host, ann } = await meeting(false);
    const sent: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') sent.push(data); };
    await ann.session.send({ type: 'addTopic', text: 'Once' });
    await run(scheduler, 1000);
    room.relay.tap = undefined;
    const commands: Bytes[] = [];
    for (const data of sent) {
      const frame = await decodeFrame(room.roomKey, data);
      const opened = frame?.kind === 'envelope' ? await openEnvelope(frame.env) : null;
      if ((opened?.message as { t?: string } | undefined)?.t === 'cmd') commands.push(data);
    }
    expect(commands.length).toBeGreaterThan(0);
    expect(host.current.topics).toHaveLength(1);
    ann.session.stopHeartbeat();
    let replaying = false;
    room.relay.lose = (from) => from === 'Ann' && !replaying;
    await run(scheduler, ONLINE_MS + 2000, 1000);
    expect(host.online()).not.toContain(ann.id);
    for (let t = 0; t < ONLINE_MS + 10_000; t += 5000) {
      replaying = true;
      for (const data of commands) room.relay.deliver('Ann', 'host', data);
      replaying = false;
      await run(scheduler, 5000);
      expect(host.online()).not.toContain(ann.id);
    }
    expect(host.current.topics).toHaveLength(1);
    // A genuine new command from the same tab is heard.
    replaying = true;
    room.relay.deliver('Ann', 'host', await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'Ann', boardId: BOARD, clientSeq: 2, sid: ann.session.sid, epoch: 1, cmd: { type: 'addTopic', text: 'Twice' } })));
    replaying = false;
    await run(scheduler, 1000);
    expect(host.current.topics).toHaveLength(2);
    expect(host.online()).toContain(ann.id);
    host.stop();
  }, 60_000);
});

describe('what the host remembers about pings', () => {
  const internals = (host: HostSession) => host as unknown as { pings: FreshMemory };

  it('keeps at most five tabs per signer, nothing for a signer with no record, and keeps a count until a copy could no longer be fresh', async () => {
    const { room, scheduler, host, ann } = await meeting(false);
    const seen = internals(host).pings;
    ann.session.stopHeartbeat();
    const send = async (signer: typeof ann.signer, sid: string, n: number, ahead = 0) => {
      room.relay.deliver('Ann', 'host', await encodeWire(room.roomKey, await sealEnvelope(signer,
        { t: 'ping', boardId: BOARD, sid, n, at: scheduler.now() + ahead, t0: 1, peer: 'Ann' })));
      await settle(HEAVY_SETTLE_MS);
    };
    const sids = Array.from({ length: 8 }, () => newSid(scheduler.now()));
    for (const sid of sids) await send(ann.signer, sid, 1);
    expect(seen.tabs(ann.id)).toEqual(sids.slice(-5));
    // A signer with no record adds nothing.
    for (let i = 0; i < 5; i++) await send(await signerFrom(await generateSigningKeys(false)), newSid(scheduler.now()), 1);
    expect(seen.signers()).toEqual([ann.id]);
    // A ping that runs ahead of the host's clock stays fresh longer than the person's record lasts.
    await send(ann.signer, newSid(scheduler.now()), 1, 50_000);
    const last = seen.tabs(ann.id).at(-1)!;
    // The record expires; that count stays until a copy of the ping could no longer be fresh, then the tick drops it.
    room.relay.lose = (from) => from === 'Ann';
    await run(scheduler, PEER_RECORD_TTL_MS + 2000, 1000);
    await host.tick(scheduler.now());
    expect(host.presence().some((p) => p.participantId === ann.id)).toBe(false);
    expect(seen.tabs(ann.id)).toEqual([last]);
    await run(scheduler, PING_FRESH_MS, 1000);
    await host.tick(scheduler.now());
    expect(seen.signers()).toEqual([]);
    host.stop();
  }, 60_000);
});
