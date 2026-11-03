import { describe, expect, it } from 'vitest';
import { encodeWire, sealEnvelope } from '../protocol/envelope';
import { BOARD, TestRoom } from '../test/sessions';
import { FakeScheduler } from '../test/fake-scheduler';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { sleep, waitFor } from '../test/wait';
import type { Outcome } from './outcome';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

// The host's pacer runs on a fake clock, so its flushes (150 ms coalescing, 500 ms between relay bundles) happen when the
// test advances it, not when a real timer fires, which a loaded machine can run before or after a step the test meant
// to come first. Participants' messages still cross on real time, so this steps the clock until the condition holds.
async function until(scheduler: FakeScheduler, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) {
    scheduler.advance(100);
    await settle(HEAVY_SETTLE_MS);
    if (!predicate()) await sleep(5);
  }
  expect(predicate()).toBe(true);
}

describe('outcomes', () => {
  it('tells the host and every participant how a time-up vote was decided', async () => {
    const room = await TestRoom.create();
    const atHost: Outcome[] = [];
    let now = Date.now();
    const scheduler = new FakeScheduler(now);
    const host = room.host('host', { now: () => now, scheduler, onOutcome: (o) => atHost.push(o) });
    const atAnn: Outcome[] = [];
    const ann = await room.person('Ann', { onOutcome: (o) => atAnn.push(o) });
    await until(scheduler, () => joined(ann));
    await host.local({ type: 'addTopic', text: 'Pairing' });
    await host.local({ type: 'startDiscussion' });
    await host.local({ type: 'discussTopic', topicId: 1, minutes: 1 });
    now += 60_000;
    await host.tick(now);
    await until(scheduler, () => ann.session.state?.vote !== null && ann.session.state?.vote !== undefined);
    await host.local({ type: 'extendTopic', topicId: 1, round: host.current.continueVote!.round, minutes: 2 });
    await until(scheduler, () => atAnn.length === 1);
    now += 120_000;
    await host.tick(now);
    await until(scheduler, () => ann.session.state?.vote?.round === host.current.continueVote?.round);
    await host.local({ type: 'finishTopic', topicId: 1 });
    await until(scheduler, () => atAnn.length === 2);
    expect(atAnn).toEqual([{ kind: 'extended', minutes: 2 }, { kind: 'movedOn' }]);
    expect(atHost).toEqual(atAnn);
    host.stop();
  });
  it('shows no late outcome line to a participant who reconnects long after the vote was decided', async () => {
    const room = await TestRoom.create();
    let now = Date.now();
    const scheduler = new FakeScheduler(now);
    const host = room.host('host', { now: () => now, scheduler });
    const atAnn: Outcome[] = [];
    const ann = await room.person('Ann', { onOutcome: (o) => atAnn.push(o) });
    await until(scheduler, () => joined(ann));
    await host.local({ type: 'addTopic', text: 'Pairing' });
    await host.local({ type: 'startDiscussion' });
    await host.local({ type: 'discussTopic', topicId: 1, minutes: 1 });
    now += 60_000;
    await host.tick(now);
    await until(scheduler, () => ann.session.state?.vote !== null && ann.session.state?.vote !== undefined);
    // Ann drops off; the vote is decided and the meeting carries on without her.
    room.direct.lose = room.relay.lose = (_from, to) => to === 'Ann';
    await host.local({ type: 'extendTopic', topicId: 1, round: host.current.continueVote!.round, minutes: 2 });
    await host.local({ type: 'addTopic', text: 'Later' });
    for (let i = 0; i < 20; i++) { scheduler.advance(500); await settle(HEAVY_SETTLE_MS); } // every send of those is lost
    room.direct.lose = room.relay.lose = undefined;
    await host.local({ type: 'addTopic', text: 'Even later' });
    await until(scheduler, () => ann.session.state?.topics.length === 3);
    expect(ann.session.state?.vote).toBeNull();
    expect(atAnn).toEqual([]);
    host.stop();
  });
});

describe('staleTab', () => {
  it('flags a tab the host refused as away too long', async () => {
    const room = await TestRoom.create();
    const ann = await room.person('Ann');
    room.host();
    await waitFor(() => joined(ann));
    const second = room.host('host-2', { epoch: 2, tabs: { [ann.id]: { watermark: Date.now(), tabs: {} } } });
    await waitFor(() => ann.session.state !== null);
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host-2'));
    // Ann's own tab is the stale one: a command under her sid, from before the watermark.
    raw.send('host-2', await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq: 1, sid: ann.session.sid, epoch: 2, cmd: { type: 'addTopic', text: 'Too late' } })));
    await waitFor(() => ann.session.staleTab);
    expect(second.current.topics).toEqual([]);
    second.stop();
  });
});
