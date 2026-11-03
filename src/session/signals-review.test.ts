import { describe, expect, it } from 'vitest';
import { createBoard } from '../engine/board';
import type { RelayHealth } from '../transport/types';
import { FakeScheduler } from '../test/fake-scheduler';
import { BOARD, TestRoom } from '../test/sessions';
import { settle } from '../test/settle';

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

describe('signals for the meeting screens', () => {
  it('tells a refused joiner why, and lets them take part again under another name', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const state = createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' });
    room.saved = { state, tabs: {} };
    const host = room.host('host', { scheduler });
    const nobody = await room.person('Nameless', { scheduler, name: '   ' });
    nobody.session.startHeartbeat();
    await runUntil(scheduler, () => nobody.session.joinRefused === 'emptyName');
    expect(joined(nobody)).toBe(false);
    nobody.session.takePart('Nadia');
    expect(nobody.session.joinRefused).toBeNull();
    // Not yet an attendee: the page shows "connecting", not a board that would hold input in the outbox.
    expect(nobody.session.state).not.toBeNull();
    expect(nobody.session.isAttendee).toBe(false);
    await runUntil(scheduler, () => joined(nobody));
    expect(nobody.session.joinRefused).toBeNull();
    expect(nobody.session.isAttendee).toBe(true);
    expect(host.current.attendees[nobody.id].name).toBe('Nadia');
    nobody.session.stopHeartbeat();
    host.stop();
  });

  it('keeps the board, the name and the views for an attendee whose rename was refused', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    let full = false;
    const host = room.host('host', { scheduler, measure: () => (full ? 1e9 : 0) });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    full = true;
    ann.session.takePart('Annabelle, with a much longer name');
    // The host did refuse, and put the refusal in Ann's entry...
    await runUntil(scheduler, () => ann.session.state?.joinRefused === 'meetingFullSize');
    await run(scheduler, 6000);
    // ...but Ann is an attendee: no join form, her name and her views stay.
    expect(ann.session.joinRefused).toBeNull();
    expect(ann.session.state?.attendees[ann.id].name).toBe('Ann');
    expect(host.current.attendees[ann.id].name).toBe('Ann');
    expect(ann.session.connection).toBe('connected');
    ann.session.stopHeartbeat();
    host.stop();
  });

  it('ignores a refusal in a view built before a retry, so the join form does not flash back', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const nobody = await room.person('Nobody', { scheduler, name: '   ' });
    nobody.session.startHeartbeat();
    await runUntil(scheduler, () => nobody.session.joinRefused === 'emptyName');
    // Everything the host sends now takes 4 s to arrive. The retry is made the moment a view is in flight.
    let inFlight = 0;
    for (const net of [room.direct, room.relay]) {
      net.scheduler = scheduler;
      net.delay = (from) => (from === 'host' ? 4000 : 0);
      net.tap = (from, to) => { if (from === 'host' && to === 'Nobody') inFlight += 1; };
    }
    for (let t = 0; t < 30_000 && inFlight === 0; t += 100) await run(scheduler, 100);
    expect(inFlight).toBeGreaterThan(0);
    nobody.session.takePart('  ');
    expect(nobody.session.joinRefused).toBeNull();
    // The view that was in flight arrives, still carrying the refusal from before the retry.
    await run(scheduler, 4500);
    expect(nobody.session.joinRefused).toBeNull();
    // A view built after the host handled the retry brings the (new) refusal.
    for (const net of [room.direct, room.relay]) net.delay = undefined;
    await runUntil(scheduler, () => nobody.session.joinRefused === 'emptyName');
    nobody.session.stopHeartbeat();
    host.stop();
  });

  it('does not count a refusal ignored as stale as a refusal, so prompted hellos go on if the retry hello was lost', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const nobody = await room.person('Nobody', { scheduler, name: '   ' });
    nobody.session.startHeartbeat();
    await runUntil(scheduler, () => nobody.session.joinRefused === 'emptyName');
    const prompting = () => !(nobody.session as unknown as { refused: boolean }).refused;
    expect(prompting()).toBe(false);
    // A view is in flight (4 s) when the retry is made, and the retry's own hello is lost.
    let inFlight = 0;
    for (const net of [room.direct, room.relay]) {
      net.scheduler = scheduler;
      net.delay = (from) => (from === 'host' ? 4000 : 0);
      net.tap = (from, to) => { if (from === 'host' && to === 'Nobody') inFlight += 1; };
      net.lose = (from) => from === 'Nobody';
    }
    for (let t = 0; t < 30_000 && inFlight === 0; t += 100) await run(scheduler, 100);
    nobody.session.takePart('Nadia');
    expect(prompting()).toBe(true);
    await run(scheduler, 4500);
    // The old refusal did arrive (it is in the view), was ignored, and prompted hellos may still go.
    expect(nobody.session.state?.joinRefused).toBe('emptyName');
    expect(nobody.session.joinRefused).toBeNull();
    expect(prompting()).toBe(true);
    nobody.session.stopHeartbeat();
    host.stop();
  });

  it('reports relay health as it changes, on both sides', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const atHost: RelayHealth[][] = [];
    const atAnn: RelayHealth[][] = [];
    room.relay.health = [{ url: 'wss://a', connected: true, refused: 0, notices: 0 }];
    const host = room.host('host', { scheduler, onHealth: (h) => atHost.push(h) });
    const ann = await room.person('Ann', { scheduler, onHealth: (h) => atAnn.push(h) });
    ann.session.startHeartbeat();
    await run(scheduler, 2000);
    expect(atHost.map((h) => h[0].connected)).toEqual([true]);
    room.relay.health = [{ url: 'wss://a', connected: false, refused: 2, notices: 0 }];
    await run(scheduler, 2000);
    // An unchanged state is not reported again.
    await run(scheduler, 2000);
    expect(atHost.map((h) => h[0].connected)).toEqual([true, false]);
    expect(atAnn.map((h) => h[0].refused)).toEqual([0, 2]);
    expect(host.pendingFailed).toBe(false);
    expect(host.connection).toBe('connected');
    ann.session.stopHeartbeat();
    host.stop();
  });
});
