import { describe, expect, it } from 'vitest';
import type { Bytes } from '../crypto/bytes';
import { generateSigningKeys, signerFrom } from '../crypto/sign';
import { createBoard } from '../engine/board';
import { decodeFrame, encodeWire, openEnvelope, sealEnvelope } from '../protocol/envelope';
import { PROTOCOL_VERSION } from '../protocol/version';
import { fresh } from '../test/hello';
import { FakeScheduler } from '../test/fake-scheduler';
import { BOARD, TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { PING_FRESH_MS, type HostSession } from './host';
import { MAX_TABLE_ENTRIES, MAX_TABS_PER_PERSON } from './tabs';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

async function run(scheduler: FakeScheduler, ms: number, step = 250): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    scheduler.advance(step);
    await settle(HEAVY_SETTLE_MS);
  }
}

async function until(scheduler: FakeScheduler, condition: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t < maxMs && !condition(); t += 100) await run(scheduler, 100, 100);
  expect(condition()).toBe(true);
}

async function helloesIn(room: TestRoom, frames: Bytes[]): Promise<Bytes[]> {
  const out: Bytes[] = [];
  for (const data of frames) {
    const frame = await decodeFrame(room.roomKey, data);
    const opened = frame?.kind === 'envelope' ? await openEnvelope(frame.env) : null;
    if ((opened?.message as { t?: string } | undefined)?.t === 'hello') out.push(data);
  }
  return out;
}

const attendees = (host: HostSession) => (host as unknown as { working: { attendees: Record<string, { name: string }> } }).working.attendees;

describe('a hello needs to be fresh', () => {
  it('a copy of an old hello neither undoes a rename nor, later, anything else', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const sent: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') sent.push(data); };
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann));
    const old = await helloesIn(room, sent);
    expect(old.length).toBeGreaterThan(0);
    room.relay.tap = undefined;
    ann.session.takePart('Annie');
    await until(scheduler, () => attendees(host)[ann.id]?.name === 'Annie');
    ann.session.stopHeartbeat();
    room.relay.lose = (from) => from === 'Ann';
    let replaying = false;
    room.relay.lose = (from) => from === 'Ann' && !replaying;
    const replay = async () => {
      replaying = true;
      for (const data of old) room.relay.deliver('Ann', 'host', data);
      replaying = false;
      await settle(HEAVY_SETTLE_MS);
    };
    await replay();
    expect(attendees(host)[ann.id].name).toBe('Annie');
    await run(scheduler, PING_FRESH_MS + 2000, 1000);
    await replay();
    expect(attendees(host)[ann.id].name).toBe('Annie');
    host.stop();
  }, 60_000);

  it('a copy of a refused joiner’s hello does not admit them once there is room', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const state = createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' });
    for (let i = 1; i < 60; i++) state.attendees[`guest-${i}`] = { id: `guest-${i}`, name: `Guest ${i}`, role: 'guest' };
    room.saved = { state, tabs: {} };
    const host = room.host('host', { scheduler });
    const sent: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Late' && to === 'host') sent.push(data); };
    const late = await room.person('Late', { scheduler, directPath: false });
    late.session.startHeartbeat();
    await until(scheduler, () => late.session.joinRefused !== null);
    late.session.stopHeartbeat();
    room.relay.tap = undefined;
    const old = await helloesIn(room, sent);
    expect(old.length).toBeGreaterThan(0);
    delete attendees(host)['guest-1']; // a seat opens
    room.relay.lose = (from) => from === 'Late';
    const replay = async () => {
      room.relay.lose = undefined;
      for (const data of old) room.relay.deliver('Late', 'host', data);
      room.relay.lose = (from) => from === 'Late';
      await run(scheduler, 500);
    };
    await replay();
    expect(attendees(host)[late.id]).toBeUndefined();
    await run(scheduler, PING_FRESH_MS + 2000, 1000);
    await replay();
    expect(attendees(host)[late.id]).toBeUndefined();
    host.stop();
  }, 60_000);

  it('a protocol 2 hello without its tab, count and clock changes nothing', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const signer = await signerFrom(await generateSigningKeys(false));
    room.relay.join('Newcomer');
    room.relay.deliver('Newcomer', 'host', await encodeWire(room.roomKey, await sealEnvelope(signer,
      { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Newcomer', peer: 'Newcomer' }), 1));
    await run(scheduler, 500);
    expect(Object.keys(attendees(host))).toHaveLength(1);
    expect(host.presence()).toEqual([]);
    host.stop();
  }, 60_000);

  it('a joiner whose clock is two minutes out still joins over the relay, once the host’s bundles show it the time', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false, now: () => scheduler.now() + 120_000 });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann), 60_000);
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);

  it('a flood of minted signers never pushes an attendee’s hello count out, so its old hello is still refused', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const state = createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' });
    for (let i = 1; i < 59; i++) state.attendees[`guest-${i}`] = { id: `guest-${i}`, name: `Guest ${i}`, role: 'guest' };
    room.saved = { state, tabs: {} };
    const host = room.host('host', { scheduler });
    const sent: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') sent.push(data); };
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann));
    const old = await helloesIn(room, sent);
    room.relay.tap = undefined;
    ann.session.takePart('Annie');
    await until(scheduler, () => attendees(host)[ann.id]?.name === 'Annie');
    ann.session.stopHeartbeat();
    // The meeting is full, so every minted signer is a stranger: they fill their own pool and nothing else.
    const signers = MAX_TABLE_ENTRIES / MAX_TABS_PER_PERSON + 5;
    for (let i = 0; i < signers; i++) {
      const signer = await signerFrom(await generateSigningKeys(false));
      room.relay.join(`minted-${i}`);
      for (let t = 0; t < MAX_TABS_PER_PERSON; t++) {
        room.relay.deliver(`minted-${i}`, 'host', await encodeWire(room.roomKey, await sealEnvelope(signer,
          { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'M', peer: `minted-${i}`, ...fresh({ at: scheduler.now() }) }), 1));
      }
      await settle(HEAVY_SETTLE_MS);
    }
    for (const data of old) room.relay.deliver('Ann', 'host', data);
    await run(scheduler, 500);
    expect(attendees(host)[ann.id].name).toBe('Annie');
    host.stop();
  }, 120_000);

  it('a new host session whose clock is behind the old one’s is joined, not refused', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const first = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann));
    await run(scheduler, 6000); // a few bundles, so the page has a clock reading from the old host
    first.close();
    room.relay.drop('host');
    // The facilitator's board is reopened on a device whose clock is five minutes behind.
    const second = room.host('host2', { scheduler, epoch: 2, now: () => scheduler.now() - 300_000 });
    await until(scheduler, () => second.online().includes(ann.id), 60_000);
    ann.session.stopHeartbeat();
    second.stop();
  }, 60_000);

  it('after Take part, a refusal from a new host session whose clock is behind is not hidden as old', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const first = room.host('host', { scheduler });
    const nobody = await room.person('Nobody', { name: '   ', scheduler, directPath: false });
    nobody.session.startHeartbeat();
    await until(scheduler, () => nobody.session.joinRefused === 'emptyName');
    nobody.session.takePart('   '); // the retry point is now in the first host's time
    first.close();
    room.relay.drop('host');
    const second = room.host('host2', { scheduler, epoch: 2, now: () => scheduler.now() - 300_000 });
    nobody.session.takePart('   ');
    await until(scheduler, () => nobody.session.joinRefused === 'emptyName', 60_000);
    nobody.session.stopHeartbeat();
    second.stop();
  }, 60_000);

  it('keeps an attendee’s count in a board with more attendees than a meeting allows', async () => {
    const room = await TestRoom.create();
    const host = room.host('host');
    const hellos = (host as unknown as { hellos: { accept(p: string, s: string, n: number, at: number, now: number, member: boolean): boolean } }).hellos;
    const now = Date.now();
    const sid = (i: number) => `tab-${i}`;
    for (let p = 0; p < 80; p++) for (let t = 0; t < MAX_TABS_PER_PERSON; t++) hellos.accept(`attendee-${p}`, sid(t), 1, now, now, true);
    // 400 counts held, more than the 300 a full meeting needs: the first is still remembered.
    expect(hellos.accept('attendee-0', sid(0), 1, now, now, true)).toBe(false);
    host.stop();
  });
});

describe('a joiner whose clock is far out, with the relays down', () => {
  const lead = (p: { session: unknown }) => (p.session as unknown as { headerLead: number }).headerLead;

  it('is admitted over the direct path alone', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    room.relay.lose = () => true;
    const ann = await room.person('Ann', { scheduler, now: () => scheduler.now() + 5 * 60_000 });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann), 60_000);
    expect(attendees(host)[ann.id]).toBeDefined();
    ann.session.stopHeartbeat();
    host.stop();
  }, 90_000);

  it('a replayed snapshot, whichever path it comes on, neither moves the page’s reading of the host’s time nor keeps a gone host online', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    room.relay.lose = () => true;
    const captured: Bytes[] = [];
    room.direct.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') captured.push(data); };
    const ann = await room.person('Ann', { scheduler, now: () => scheduler.now() + 5 * 60_000 });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann), 60_000);
    await run(scheduler, 6000);
    room.direct.tap = undefined;
    expect(captured.length).toBeGreaterThan(0);
    // The host goes quiet; the page's own clock then runs on, so a replayed snapshot would be received much later.
    let replaying = false;
    room.direct.lose = (from) => from === 'host' && !replaying;
    await run(scheduler, 1000);
    const before = lead(ann);
    expect(Number.isFinite(before)).toBe(true);
    for (let t = 0; t < 30_000; t += 2000) {
      replaying = true;
      for (const data of captured) {
        room.direct.deliver('host', 'Ann', data);
        room.relay.deliver('host', 'Ann', data);
      }
      replaying = false;
      await run(scheduler, 2000);
    }
    expect(lead(ann)).toBe(before);
    expect(ann.session.hostOnline).toBe(false);
    ann.session.stopHeartbeat();
    host.stop();
  }, 90_000);

  it('a stale hello is answered once over the direct path, never over the relay, and creates no record', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    room.relay.join('Eve');
    room.direct.join('Eve');
    const replies: Array<'direct' | 'relay'> = [];
    room.direct.tap = (from, to) => { if (from === 'host' && to === 'Eve') replies.push('direct'); };
    // The host's bundles go to everyone on the relay; a reply to Eve would be a signed envelope.
    const envelopes: Promise<boolean>[] = [];
    room.relay.tap = (from, to, data) => {
      if (from === 'host' && to === 'Eve') envelopes.push(decodeFrame(room.roomKey, data).then((frame) => frame?.kind === 'envelope'));
    };
    const signer = await signerFrom(await generateSigningKeys(false));
    const stale = async (n: number) => encodeWire(room.roomKey, await sealEnvelope(signer,
      { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Eve', peer: 'Eve', ...fresh({ at: scheduler.now() + 5 * 60_000, n }) }), 1);
    room.relay.deliver('Eve', 'host', await stale(1));
    await run(scheduler, 500);
    expect(await Promise.all(envelopes)).not.toContain(true);
    expect(replies).toEqual([]);
    room.direct.deliver('Eve', 'host', await stale(2));
    room.direct.deliver('Eve', 'host', await stale(3));
    await run(scheduler, 500);
    expect(replies).toEqual(['direct']);
    expect(Object.keys(attendees(host))).toEqual([room.hostId]);
    host.stop();
  }, 60_000);

  it('only a newer snapshot from the host over the direct path feeds the reading, even when a replay would raise it', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    let replaying = false;
    room.relay.lose = () => !replaying;
    let skew = 5 * 60_000;
    const ann = await room.person('Ann', { scheduler, now: () => scheduler.now() + skew });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann), 60_000);
    const old: Bytes[] = [];
    room.direct.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') old.push(data); };
    await run(scheduler, 6000);
    ann.session.stopHeartbeat();
    // The host's later snapshots are lost on the way: they are newer than anything the page has accepted.
    room.direct.lose = (from) => from === 'host' && !replaying;
    const seen = old.length;
    await host.local({ type: 'addTopic', text: 'Later' });
    await run(scheduler, 6000);
    room.direct.tap = undefined;
    const newer = old.slice(seen);
    expect(newer.length).toBeGreaterThan(0);
    const before = lead(ann);
    // The page's clock steps back ten minutes, so anything it took in now would raise the reading by ten minutes.
    skew -= 10 * 60_000;
    room.direct.join('Eve');
    room.direct.connect('Eve', 'Ann');
    replaying = true;
    for (const data of old.slice(0, seen)) room.direct.deliver('host', 'Ann', data); // not newer
    for (const data of newer) room.direct.deliver('Eve', 'Ann', data); // newer, but not from the host peer
    for (const data of newer) room.relay.deliver('host', 'Ann', data); // newer, but by relay
    replaying = false;
    await settle(HEAVY_SETTLE_MS);
    expect(lead(ann)).toBe(before);
    host.stop();
  }, 90_000);

  it('a newer snapshot from the host over the direct path does raise the reading', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    let replaying = false;
    room.relay.lose = () => !replaying;
    let skew = 5 * 60_000;
    const ann = await room.person('Ann', { scheduler, now: () => scheduler.now() + skew });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann), 60_000);
    const old: Bytes[] = [];
    room.direct.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') old.push(data); };
    await run(scheduler, 6000);
    ann.session.stopHeartbeat();
    // The host's later snapshots are lost on the way: they are newer than anything the page has accepted.
    room.direct.lose = (from) => from === 'host' && !replaying;
    const seen = old.length;
    await host.local({ type: 'addTopic', text: 'Later' });
    await run(scheduler, 6000);
    room.direct.tap = undefined;
    const newer = old.slice(seen);
    expect(newer.length).toBeGreaterThan(0);
    const before = lead(ann);
    // The page's clock steps back ten minutes, so anything it took in now would raise the reading by ten minutes.
    skew -= 10 * 60_000;
    replaying = true;
    for (const data of newer) room.direct.deliver('host', 'Ann', data);
    replaying = false;
    await settle(HEAVY_SETTLE_MS);
    expect(lead(ann)).toBeGreaterThan(before + 5 * 60_000);
    host.stop();
  }, 90_000);

  it('a page with a correct clock also joins with the relays down', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    room.relay.lose = () => true;
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann), 60_000);
    ann.session.stopHeartbeat();
    host.stop();
  }, 90_000);

  it('a stale hello from a tab with a live record is not answered with a neutral view', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await until(scheduler, () => joined(ann));
    await run(scheduler, 3000);
    const sent: Bytes[] = [];
    room.direct.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') sent.push(data); };
    room.direct.lose = (from) => from === 'host';
    const hello = await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Ann', peer: 'Ann', ...fresh({ at: scheduler.now() + 5 * 60_000, n: 99 }) }), 1);
    room.direct.deliver('Ann', 'host', hello);
    await settle(HEAVY_SETTLE_MS);
    const snapshots: unknown[] = [];
    for (const data of sent) {
      const frame = await decodeFrame(room.roomKey, data);
      const opened = frame?.kind === 'envelope' ? await openEnvelope(frame.env) : null;
      if ((opened?.message as { t?: string } | undefined)?.t === 'snapshot') snapshots.push(opened);
    }
    expect(snapshots).toEqual([]);
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);
});
