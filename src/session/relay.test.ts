import { describe, expect, it } from 'vitest';
import { generateSecretKey } from 'nostr-tools';
import type { Bytes } from '../crypto/bytes';
import type { SendOptions } from '../transport/types';
import { createBoard } from '../engine/board';
import { openBundle } from '../protocol/bundle';
import { decodeFrame } from '../protocol/envelope';
import { RELAY_EVENT_MAX_BYTES } from '../engine/limits';
import { createSizeMeter, relayEventBytes, TOPIC_PLACEHOLDER } from '../protocol/size';
import { FakeScheduler } from '../test/fake-scheduler';
import { ADVERSARIAL_SEED, adversarialText } from '../test/fixtures';
import { mulberry32 } from '../test/mulberry32';
import { BOARD, TestRoom } from '../test/sessions';
import { settle } from '../test/settle';
import { waitFor } from '../test/wait';
import { measuredApply } from './measured';
import { MAX_RESENDS, RESEND_AFTER_MS } from './outbox';
import { REFRESH_MS, RELAY_GAP_MS } from './pacer';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

// Records every relay event the host publishes.
function recordRelay(room: TestRoom, id: string) {
  const transport = room.transport(id);
  const events: Array<{ data: Bytes; kind?: string; supersedes?: string[] }> = [];
  const broadcast = transport.broadcastRelay.bind(transport);
  transport.broadcastRelay = (data, opts) => {
    events.push({ data, kind: opts?.kind, supersedes: opts?.supersedes });
    broadcast(data, opts);
  };
  return { transport, events };
}

// The hostNow of each recorded bundle: the time the pacer sent it, on the host's clock.
async function sentAt(room: TestRoom, events: Array<{ data: Bytes }>): Promise<number[]> {
  return Promise.all(events.map(async (e) => {
    const frame = await decodeFrame(room.roomKey, e.data);
    if (frame?.kind !== 'bundle') throw new Error('not a bundle');
    return (await openBundle(frame.body, room.hostSigner.pub))!.message.hostNow;
  }));
}

// Lets the fake clock run in small steps while the real event loop does the cryptography.
async function run(scheduler: FakeScheduler, ms: number, step = 50): Promise<void> {
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

describe('relay bundles', () => {
  it('reaches a participant with no direct path, through bundles alone', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const kinds: string[] = [];
    room.relay.tap = (from, to, data) => {
      if (from === 'host' && to === 'Ann') void decodeFrame(room.roomKey, data).then((f) => kinds.push(f?.kind ?? 'none'));
    };
    const ann = await room.person('Ann', { directPath: false });
    await waitFor(() => joined(ann));
    await ann.session.send({ type: 'addTopic', text: 'Over the relay' });
    await waitFor(() => ann.session.state!.topics.length === 1);
    expect(host.current.topics[0].authorId).toBe(ann.id);
    expect(new Set(kinds)).toEqual(new Set(['bundle']));
    host.stop();
  });

  it('sends direct peers their snapshots directly, and still publishes every change as a bundle', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const { transport, events } = recordRelay(room, 'host');
    const host = room.host('host', { transport, scheduler });
    const direct: string[] = [];
    room.direct.tap = (from, to) => { if (from === 'host' && to === 'Ann') direct.push(to); };
    const ann = await room.person('Ann');
    await runUntil(scheduler, () => joined(ann));
    // Ann's reply path is direct once her first ping, sent on the join's reply, has come in over it.
    await waitFor(() => host.presence().some((p) => p.peerId === 'Ann' && p.status === 'direct'));
    const before = events.length;
    await host.local({ type: 'addTopic', text: 'Both ways' });
    await run(scheduler, RELAY_GAP_MS);
    await waitFor(() => ann.session.state!.topics.length === 1);
    expect(direct.length).toBeGreaterThan(0);
    await waitFor(() => events.length > before); // sealed and published after the direct snapshot
    host.stop();
  });

  it('keeps host relay events at least 500 ms apart through a burst, and loses no change', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const { transport, events } = recordRelay(room, 'host');
    const host = room.host('host', { transport, scheduler });
    const people = await Promise.all(['Ann', 'Bob', 'Cat'].map((name) => room.person(name, { directPath: false })));
    await runUntil(scheduler, () => people.every(joined));
    for (let i = 0; i < 4; i++) for (const p of people) await p.session.send({ type: 'addTopic', text: `${p.name} ${i}` });
    await run(scheduler, REFRESH_MS + 1000);
    await waitFor(() => people.every((p) => p.session.state!.topics.length === 12), 5000);
    expect(host.current.topics).toHaveLength(12);
    const times = await sentAt(room, events);
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(RELAY_GAP_MS);
    host.stop();
  });

  it('marks every bundle as superseded by a newer one, so the relay transport never queues stale ones', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const { transport, events } = recordRelay(room, 'host');
    const host = room.host('host', { transport, scheduler });
    await run(scheduler, REFRESH_MS + 100, 500);
    await waitFor(() => events.length >= 2);
    // The first bundle is a full refresh, which replaces any held bundle; a change bundle replaces only change bundles.
    expect(events[0]).toMatchObject({ kind: 'refresh', supersedes: ['change', 'refresh'] });
    for (const e of events) expect(e.supersedes).toEqual(e.kind === 'refresh' ? ['change', 'refresh'] : ['change']);
    host.stop();
  });

  it('marks a participant’s hellos as replacing older ones and its commands as lasting, each replacing only its own resend', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const transport = room.transport('Ann', false);
    const sent: Array<{ path: string; opts?: SendOptions; data: Bytes }> = [];
    const broadcast = transport.broadcastRelay.bind(transport);
    transport.broadcastRelay = (data, opts) => { sent.push({ path: 'relay broadcast', opts, data }); broadcast(data, opts); };
    const sendVia = transport.sendVia.bind(transport);
    transport.sendVia = (peerId, data, path, opts) => { sent.push({ path, opts, data }); return sendVia(peerId, data, path, opts); };
    const ann = await room.person('Ann', { directPath: false, transport, scheduler });
    await runUntil(scheduler, () => joined(ann));
    expect(sent.filter((s) => s.path === 'relay broadcast')[0]!.opts).toEqual({ kind: 'hello', supersedes: ['hello'] });
    room.relay.lose = (from) => from === 'Ann'; // nothing reaches the host, so the outbox resends
    await ann.session.send({ type: 'addTopic', text: 'One' });
    await ann.session.send({ type: 'addTopic', text: 'Two' });
    await run(scheduler, 4000);
    const commands = sent.filter((s) => s.opts?.lasting);
    const kinds = commands.map((s) => s.opts!.kind!);
    expect(new Set(kinds).size).toBe(2); // one kind per command, shared by its resends
    expect(kinds.length).toBeGreaterThan(2);
    for (const s of commands) expect(s.opts).toEqual({ lasting: true, kind: s.opts!.kind, supersedes: [s.opts!.kind], expendable: expect.any(Function) });
    // While a resend of a command is still to come, its held copy may make way for a fresh hello.
    expect(commands.every((s) => s.opts!.expendable!())).toBe(true);
    host.stop();
  });

  it('keeps a command lasting once the outbox has failed (two minutes with a live host), and lets it go once acknowledged', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const transport = room.transport('Ann', false);
    const sent: SendOptions[] = [];
    const sendVia = transport.sendVia.bind(transport);
    transport.sendVia = (peerId, data, path, opts) => { if (opts?.lasting) sent.push(opts); return sendVia(peerId, data, path, opts); };
    const ann = await room.person('Ann', { directPath: false, transport, scheduler });
    await runUntil(scheduler, () => joined(ann));
    room.relay.lose = (from) => from === 'Ann'; // nothing reaches the host, so the outbox resends, then gives up
    await ann.session.send({ type: 'addTopic', text: 'One' });
    await runUntil(scheduler, () => sent.length > 0);
    const expendable = sent[0].expendable!;
    expect(expendable()).toBe(true);
    // Past the third resend the next one is backed off (more than 3 s away), so the held copy may be the last: kept.
    await run(scheduler, MAX_RESENDS * RESEND_AFTER_MS + 500);
    expect(sent.length).toBe(1 + MAX_RESENDS);
    expect(ann.session.pendingFailed).toBe(false);
    expect(expendable()).toBe(false);
    // At the bound the outbox gives up: the held copy may be the last one.
    await runUntil(scheduler, () => ann.session.pendingFailed, 130_000);
    expect(expendable()).toBe(false);
    // Retry: resends are left again, and once the host acknowledges the command its held copy is pointless.
    room.relay.lose = () => false;
    ann.session.retry();
    expect(expendable()).toBe(true);
    await runUntil(scheduler, () => host.current.topics.length === 1 && ann.session.state!.topics.length === 1);
    // Long enough for the outbox to give up again had the host not acknowledged it: it did, so nothing is pending.
    await run(scheduler, (MAX_RESENDS + 1) * RESEND_AFTER_MS + 500);
    expect(ann.session.pendingFailed).toBe(false);
    expect(expendable()).toBe(true);
    host.stop();
  });

  it('publishes a full refresh every 5 s with nothing changing', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const { transport, events } = recordRelay(room, 'host');
    const host = room.host('host', { transport, scheduler });
    await run(scheduler, 4 * REFRESH_MS + 100, 500);
    await waitFor(() => events.length === 5);
    const times = await sentAt(room, events);
    expect(times.map((t) => t - times[0])).toEqual([0, 5000, 10000, 15000, 20000]);
    host.stop();
  });

  it('repairs a participant who missed a bundle, at the next refresh', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { directPath: false });
    await runUntil(scheduler, () => joined(ann));
    await host.local({ type: 'addTopic', text: 'Vote here' });
    await run(scheduler, 1000);
    await waitFor(() => ann.session.state!.topics.length === 1);
    // Ann's vote is applied, but the bundle that carries it is lost.
    room.relay.lose = (from, to) => from === 'host' && to === 'Ann';
    await ann.session.send({ type: 'addVote', topicId: 1 });
    await waitFor(() => host.current.topics[0].voters.length === 1);
    await run(scheduler, 1000);
    room.relay.lose = undefined;
    expect(ann.session.state!.topics[0].mine).toBe(0);
    await run(scheduler, REFRESH_MS);
    await waitFor(() => ann.session.state!.topics[0].mine === 1);
    host.stop();
  });

  it('never combines an entry from before the last refresh with a newer shared part', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { directPath: false });
    await runUntil(scheduler, () => joined(ann));
    // Ann misses a change and the full refresh after it...
    room.relay.lose = (from, to) => from === 'host' && to === 'Ann';
    await host.local({ type: 'addTopic', text: 'While away' });
    await run(scheduler, REFRESH_MS);
    room.relay.lose = undefined;
    // ...so the next change bundle, which leaves out her unchanged entry, can't be combined with the one she holds.
    await host.local({ type: 'addTopic', text: 'After the refresh' });
    await run(scheduler, 1000);
    await settle();
    expect(ann.session.state!.topics).toEqual([]);
    await run(scheduler, REFRESH_MS);
    await waitFor(() => ann.session.state!.topics.length === 2);
    host.stop();
  });

  it('accepts a later view with the same seq after the host clock steps back, because hostNow never does', async () => {
    const room = await TestRoom.create();
    let hostTime = Date.now();
    const host = room.host('host', { now: () => hostTime });
    const ann = await room.person('Ann');
    const bob = await room.person('Bob');
    await waitFor(() => joined(ann) && joined(bob));
    await settle(); // let the hellos that follow joining arrive first
    hostTime += 20_000; // nobody heard from for 20 s
    await ann.session.ping();
    await waitFor(() => ann.session.state!.online.length === 2);
    hostTime -= 15_000; // the host's clock steps back
    const seq = host.version.seq;
    bob.session.rehello(); // a hello that changes nothing: same seq, new presence
    await waitFor(() => ann.session.state!.online.includes(bob.id));
    expect(host.version.seq).toBe(seq);
    host.stop();
  });

  it('keeps every relay event under 48 KB on a board filled to the size cap, and a refused topic changes nothing', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const meter = await createSizeMeter();
    const random = mulberry32(ADVERSARIAL_SEED);
    let state = createBoard({ boardId: BOARD, boardName: adversarialText(random, 80), ownerId: room.hostId, ownerName: adversarialText(random, 60) });
    for (let i = 1; i < 15; i++) {
      const result = await measuredApply(state, `guest-${i}`, { type: 'join', name: adversarialText(random, 60) }, 0, meter.measure);
      if (!result.ok) throw new Error(result.key);
      state = result.state;
    }
    const { transport, events } = recordRelay(room, 'host');
    const host = room.host('host', { transport, scheduler, state, measure: meter.measure });
    let refused = false;
    while (!refused) {
      const before = { board: JSON.stringify(host.current), seq: host.version.seq };
      const result = await host.local({ type: 'addTopic', text: adversarialText(random, 280) });
      if (!result.ok) {
        expect(result.key).toBe('boardFull');
        expect(JSON.stringify(host.current)).toBe(before.board);
        expect(host.version.seq).toBe(before.seq);
        refused = true;
      }
      await run(scheduler, REFRESH_MS, 500);
    }
    const nostrKey = generateSecretKey();
    const sizes = events.map((e) => relayEventBytes(e.data, transport.selfId, TOPIC_PLACEHOLDER, nostrKey));
    expect(Math.max(...sizes)).toBeLessThan(RELAY_EVENT_MAX_BYTES);
    host.stop();
  }, 60_000);
});
