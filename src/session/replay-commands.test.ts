import { describe, expect, it } from 'vitest';
import type { Bytes } from '../crypto/bytes';
import { decodeFrame, encodeWire, openEnvelope, sealEnvelope } from '../protocol/envelope';
import { newSid } from '../protocol/sid';
import { FakeScheduler } from '../test/fake-scheduler';
import { BOARD, TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { GAP_REFUSE_MS, ONLINE_MS, type HostSession } from './host';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

async function run(scheduler: FakeScheduler, ms: number, step = 500): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    scheduler.advance(step);
    await settle(HEAVY_SETTLE_MS);
  }
}

async function commandsIn(room: TestRoom, frames: Bytes[]): Promise<Bytes[]> {
  const out: Bytes[] = [];
  for (const data of frames) {
    const frame = await decodeFrame(room.roomKey, data);
    const opened = frame?.kind === 'envelope' ? await openEnvelope(frame.env) : null;
    if ((opened?.message as { t?: string } | undefined)?.t === 'cmd') out.push(data);
  }
  return out;
}

const internals = (host: HostSession) => host as unknown as {
  buffered: Map<string, unknown>;
  gapSince: Map<string, number>;
  stale: Map<string, { at: number; sid: string }>;
};

describe('commands that only reach a gap', () => {
  it('a held-back command delivered again keeps nobody online, and a refused gap stays closed', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    for (let i = 0; i < 300 && !joined(ann); i++) await run(scheduler, 100, 100);
    expect(joined(ann)).toBe(true);
    ann.session.stopHeartbeat();
    let replaying = false;
    room.relay.lose = (from) => from === 'Ann' && !replaying;
    await run(scheduler, ONLINE_MS + 2000, 1000);
    expect(host.online()).not.toContain(ann.id);
    // A tab the host has never seen whose first command is not 1: held back until its gap is refused.
    const lost = newSid(scheduler.now() + 1);
    const frame: Bytes = await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'Ann', boardId: BOARD, clientSeq: 3, sid: lost, epoch: 1, cmd: { type: 'addTopic', text: 'Held' } }));
    const send = async () => {
      replaying = true;
      room.relay.deliver('Ann', 'host', frame);
      replaying = false;
      await settle(HEAVY_SETTLE_MS);
    };
    const key = `${ann.id} ${lost}`;
    await send();
    expect(internals(host).gapSince.has(key)).toBe(true);
    await run(scheduler, GAP_REFUSE_MS + 1000, 1000);
    await send(); // the gap has outlived its resend cycles: refused
    expect(internals(host).gapSince.has(key)).toBe(false);
    const refusedAt = internals(host).stale.get(ann.id)?.at;
    expect(refusedAt).toBeDefined();
    await run(scheduler, ONLINE_MS + 5000, 1000);
    for (let i = 0; i < 4; i++) {
      await send();
      await run(scheduler, 3000, 1000);
    }
    expect(internals(host).gapSince.has(key)).toBe(false);
    expect(internals(host).buffered.has(key)).toBe(false);
    expect(internals(host).stale.get(ann.id)?.at).toBe(refusedAt); // the refusal is made once
    expect(host.online()).not.toContain(ann.id);
    expect(host.current.topics).toHaveLength(0);
    host.stop();
  }, 60_000);

  it('a refused old tab’s command delivered again does not set its refusal again', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    for (let i = 0; i < 300 && !joined(ann); i++) await run(scheduler, 100, 100);
    ann.session.stopHeartbeat();
    // The host's table says everything older than now is gone for this person.
    const sid = newSid(scheduler.now() - 1000);
    (host as unknown as { tabs: unknown }).tabs = { [ann.id]: { watermark: scheduler.now(), tabs: {}, emptySince: scheduler.now() } };
    const frame = await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'Ann', boardId: BOARD, clientSeq: 1, sid, epoch: 1, cmd: { type: 'addTopic', text: 'Old tab' } }));
    room.relay.lose = (from) => from === 'Ann';
    const send = async () => {
      room.relay.lose = undefined;
      room.relay.deliver('Ann', 'host', frame);
      room.relay.lose = (from) => from === 'Ann';
      await settle(HEAVY_SETTLE_MS);
    };
    await send();
    const first = internals(host).stale.get(ann.id);
    expect(first?.sid).toBe(sid);
    for (let i = 0; i < 3; i++) {
      await run(scheduler, 5000, 1000);
      await send();
    }
    expect(internals(host).stale.get(ann.id)?.at).toBe(first!.at);
    expect(host.current.topics).toHaveLength(0);
    host.stop();
  }, 60_000);

  it('a command that names another peer than the one it arrived from is dropped', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    for (let i = 0; i < 300 && !joined(ann); i++) await run(scheduler, 100, 100);
    ann.session.stopHeartbeat();
    room.relay.join('Bob');
    const frame = await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'Ann', boardId: BOARD, clientSeq: 1, sid: ann.session.sid, epoch: 1, cmd: { type: 'addTopic', text: 'Moved' } }));
    room.relay.lose = (from) => from === 'Ann';
    await run(scheduler, ONLINE_MS + 2000, 1000);
    room.relay.deliver('Bob', 'host', frame);
    await run(scheduler, 1000);
    expect(host.current.topics).toHaveLength(0);
    expect(host.online()).not.toContain(ann.id);
    room.relay.lose = undefined;
    room.relay.deliver('Ann', 'host', frame);
    await run(scheduler, 1000);
    expect(host.current.topics).toHaveLength(1);
    expect(host.online()).toContain(ann.id);
    host.stop();
  }, 60_000);

  it('copies of a duplicate command within the keep window do not refresh its listing note', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    for (let i = 0; i < 300 && !joined(ann); i++) await run(scheduler, 100, 100);
    const sent: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') sent.push(data); };
    await ann.session.send({ type: 'addTopic', text: 'Once' });
    await run(scheduler, 1000);
    room.relay.tap = undefined;
    ann.session.stopHeartbeat();
    const frames = await commandsIn(room, sent);
    expect(frames.length).toBeGreaterThan(0);
    room.relay.lose = (from) => from === 'Ann';
    const send = async () => {
      room.relay.lose = undefined;
      room.relay.deliver('Ann', 'host', frames[0]);
      room.relay.lose = (from) => from === 'Ann';
      await settle(HEAVY_SETTLE_MS);
    };
    const listed = (host as unknown as { listed: Map<string, number> }).listed;
    await send();
    const [first] = [...listed.values()];
    expect(first).toBeDefined();
    for (let i = 0; i < 3; i++) {
      await run(scheduler, 2000, 1000);
      await send();
    }
    expect([...listed.values()]).toEqual([first]);
    host.stop();
  }, 60_000);

  it('one signer’s many refusals do not make the host forget that another person’s tab was refused', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const refuse = host as unknown as { refuseTab(person: string, sid: string, seq: number, key: 'staleTab'): void; stale: Map<string, { at: number }> };
    const bobSid = newSid(scheduler.now());
    refuse.refuseTab('bob', bobSid, 1, 'staleTab');
    const bobAt = refuse.stale.get('bob')!.at;
    for (let i = 0; i < 1000; i++) refuse.refuseTab('mallory', newSid(scheduler.now() + i), 1, 'staleTab');
    scheduler.advance(5000);
    refuse.refuseTab('bob', bobSid, 1, 'staleTab'); // a copy: no new refusal
    expect(refuse.stale.get('bob')!.at).toBe(bobAt);
    host.stop();
  }, 60_000);
});
