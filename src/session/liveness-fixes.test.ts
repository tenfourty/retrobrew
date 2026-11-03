import { describe, expect, it } from 'vitest';
import type { Bytes } from '../crypto/bytes';
import { decodeFrame, openEnvelope } from '../protocol/envelope';
import { FakeScheduler } from '../test/fake-scheduler';
import { TestRoom } from '../test/sessions';
import { settle } from '../test/settle';
import { HOST_OFFLINE_MS, RELAY_BURST, RELAY_REFILL_MS } from './participant';
import { MAX_RESEND_GAP_MS, MAX_WAIT_MS } from './outbox';

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

describe('liveness fixes', () => {
  it('does not send a queued command the host acknowledged while it waited for the relay budget', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    const frames: Bytes[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') frames.push(data); };
    // The first four commands are lost, so the host holds the rest back until the first resend fills the gap.
    room.relay.lose = (from) => from === 'Ann';
    for (let i = 0; i < 8; i++) void ann.session.send({ type: 'addTopic', text: `Topic ${i}` });
    await run(scheduler, 200);
    room.relay.lose = undefined;
    await runUntil(scheduler, () => host.current.topics.length === 8);
    await run(scheduler, 15_000);
    expect(host.current.topics.map((t) => t.text)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((i) => `Topic ${i}`));
    // Without the skip the first pass sends 8 and the resend 8 more, whatever was acknowledged meanwhile.
    let commands = 0;
    for (const data of frames) {
      const frame = await decodeFrame(room.roomKey, data);
      const opened = frame?.kind === 'envelope' ? await openEnvelope(frame.env) : null;
      if ((opened?.message as { t?: string } | undefined)?.t === 'cmd') commands += 1;
    }
    expect(commands).toBeLessThan(16);
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);

  it('keeps resending past 12 s while the host is heard, and acknowledges once it answers (the outbox is not given up on early)', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    room.relay.lose = (from, to) => from === 'Ann' && to === 'host'; // one-way: Ann still hears the host
    void ann.session.send({ type: 'addTopic', text: 'Slow' });
    await run(scheduler, 90_000);
    expect(ann.session.hostOnline).toBe(true);
    expect(ann.session.pendingFailed).toBe(false);
    room.relay.lose = undefined;
    await runUntil(scheduler, () => host.current.topics.length === 1 && ann.session.state!.acks[ann.session.sid] === 1);
    expect(ann.session.pendingFailed).toBe(false);
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);

  it('gives up on a host that goes silent: not before it is judged offline (20 s), and within one back-off gap after', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    host.stop();
    const start = scheduler.now();
    void ann.session.send({ type: 'addTopic', text: 'Nobody home' });
    await run(scheduler, HOST_OFFLINE_MS - 5000);
    expect(ann.session.pendingFailed).toBe(false);
    await runUntil(scheduler, () => ann.session.pendingFailed, 5000 + MAX_RESEND_GAP_MS + 5000);
    expect(ann.session.hostOnline).toBe(false);
    expect(scheduler.now() - start).toBeGreaterThanOrEqual(HOST_OFFLINE_MS - 5000);
    expect(scheduler.now() - start).toBeLessThan(HOST_OFFLINE_MS + MAX_RESEND_GAP_MS + 1000);
    expect(MAX_WAIT_MS).toBeGreaterThan(HOST_OFFLINE_MS + MAX_RESEND_GAP_MS);
    ann.session.stopHeartbeat();
  }, 60_000);

  it('proves a direct path that connects after the first view, and the host replies direct from then on', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: 'later' });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    expect(host.presence().find((p) => p.participantId === ann.id)?.status).toBe('relayed');
    room.direct.connect('Ann', 'host');
    await runUntil(scheduler, () => host.presence().find((p) => p.participantId === ann.id)?.status === 'direct', 10_000);
    let direct = 0;
    room.direct.tap = (from, to) => { if (from === 'host' && to === 'Ann') direct += 1; };
    await host.local({ type: 'addTopic', text: 'Straight to Ann' });
    await runUntil(scheduler, () => ann.session.state?.topics.length === 1, 10_000);
    expect(direct).toBeGreaterThan(0);
    ann.session.stopHeartbeat();
    host.stop();
  }, 30_000);

  it('never shows the host offline after a 40 s freeze, even when the transport reports the host left', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const statuses: boolean[] = [];
    const ann = await room.person('Ann', { scheduler, directPath: false, onHostStatus: (online) => statuses.push(online) });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    // The freeze: none of Ann's timers run for 40 s and nothing reaches her. Then her timers start late, the relay's
    // sweep says the host left, and the page becomes visible.
    ann.session.stopHeartbeat();
    room.relay.lose = (from, to) => from === 'host' && to === 'Ann';
    await run(scheduler, 40_000, 1000);
    room.relay.lose = undefined;
    ann.session.startHeartbeat();
    room.relay.announceLeave('Ann', 'host');
    ann.session.resume();
    await run(scheduler, 6000);
    expect(statuses).toEqual([true]);
    expect(ann.session.connection).toBe('connected');
    ann.session.stopHeartbeat();
    host.stop();
  }, 30_000);

  it('spreads a resend of many commands on the relay within the burst and refill', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    const sent: number[] = [];
    room.relay.tap = (from, to) => { if (from === 'Ann' && to === 'host') sent.push(scheduler.now()); };
    room.relay.lose = (from) => from === 'Ann';
    for (let i = 0; i < 12; i++) void ann.session.send({ type: 'addTopic', text: `Topic ${i}` });
    await run(scheduler, 2500);
    room.relay.lose = undefined;
    await runUntil(scheduler, () => host.current.topics.length === 12);
    await run(scheduler, 12_000);
    expect(sent.length).toBeGreaterThanOrEqual(12);
    // Every window of 1 s holds at most the burst plus what refills in it, pings and hellos included.
    for (const start of sent) {
      const inWindow = sent.filter((t) => t >= start && t < start + 1000).length;
      expect(inWindow).toBeLessThanOrEqual(RELAY_BURST + Math.ceil(1000 / RELAY_REFILL_MS) + 1);
    }
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);

  it('queues at most one resend of the pending commands at a time, so a fresh command is not stuck behind stale resends', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    const frames: { at: number; data: Bytes }[] = [];
    room.relay.tap = (from, to, data) => { if (from === 'Ann' && to === 'host') frames.push({ at: scheduler.now(), data }); };
    // Nothing reaches the host: 12 commands stay pending, and a resend of all 12 is due every 3 s, but the
    // pacer sends only 2.5 a second, so a resend takes 4.8 s to drain.
    room.relay.lose = (from) => from === 'Ann';
    for (let i = 0; i < 12; i++) void ann.session.send({ type: 'addTopic', text: `Topic ${i}` });
    await run(scheduler, 15_000);
    const before = frames.length;
    const addedAt = scheduler.now();
    void ann.session.send({ type: 'addTopic', text: 'Fresh' });
    await run(scheduler, 12_000);
    const seqs: { at: number; seq: number }[] = [];
    for (const { at, data } of frames.slice(before)) {
      const frame = await decodeFrame(room.roomKey, data);
      const opened = frame?.kind === 'envelope' ? await openEnvelope(frame.env) : null;
      const m = opened?.message as { t?: string; clientSeq?: number } | undefined;
      if (m?.t === 'cmd' && m.clientSeq !== undefined) seqs.push({ at, seq: m.clientSeq });
    }
    const fresh = seqs.find((s) => s.seq === 13);
    expect(fresh).toBeDefined();
    // Behind one resend at most (13 sends, 400 ms each), never behind a backlog of them (about 20 s by now).
    expect(fresh!.at - addedAt).toBeLessThanOrEqual(6000);
    ann.session.stopHeartbeat();
    host.stop();
  }, 90_000);
});
