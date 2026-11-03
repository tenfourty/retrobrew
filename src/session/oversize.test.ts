import { describe, expect, it, vi } from 'vitest';
import { FakeScheduler } from '../test/fake-scheduler';
import { TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { generateSecretKey } from 'nostr-tools';
import { relayEventBytes, TOPIC_PLACEHOLDER } from '../protocol/size';
import type { Bytes } from '../crypto/bytes';
import type { HostSession } from './host';
import { REFRESH_MS } from './pacer';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

// Runs the fake clock in small steps, while the real event loop does the cryptography.
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

// The onStatus calls that see host.oversize change, which is all the facilitator's view cares about.
function oversizeFlips(): { flips: boolean[]; onStatus: (host: HostSession) => () => void } {
  const flips: boolean[] = [];
  let last = false;
  return { flips, onStatus: (host) => () => { if (host.oversize !== last) { last = host.oversize; flips.push(last); } } };
}

describe('the relay ceiling', () => {
  it('sends a bundle over the limit anyway, says so once, counts every one, and refuses growth', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const seen = oversizeFlips();
    // A limit no bundle can meet.
    const host: HostSession = room.host('host', { scheduler, eventLimit: 10, onStatus: () => seen.onStatus(host)() });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    await runUntil(scheduler, () => joined(ann) && host.oversize);
    // The bundle went out regardless: Ann, who has only the relay, is a member.
    expect(host.oversizeCount).toBeGreaterThan(0);
    await run(scheduler, 2 * REFRESH_MS);
    // Every over-limit bundle is counted; the facilitator is told once, when it began.
    expect(host.oversizeCount).toBeGreaterThan(1);
    expect(seen.flips).toEqual([true]);
    expect(host.oversize).toBe(true);
    // Growth is refused as if the board were full; a change that doesn't grow it is allowed.
    expect(await host.local({ type: 'addTopic', text: 'More' })).toMatchObject({ ok: false, key: 'boardFull' });
    expect((await host.local({ type: 'setShowVotes', value: false })).ok).toBe(true);
    // A newcomer's join grows the meeting, so it is refused too, with the size refusal the host puts in their view.
    const bea = await room.person('Bea', { scheduler, directPath: false });
    const refusal = () => (host as unknown as { refusalOf: (personId: string) => string | undefined }).refusalOf(bea.id);
    await runUntil(scheduler, () => refusal() !== undefined);
    expect(refusal()).toBe('meetingFullSize');
    expect(Object.keys(host.current.attendees)).not.toContain(bea.id);
    host.stop();
    warn.mockRestore();
  }, 30_000);

  it('allows growth again only when a full refresh fits, and tells the facilitator', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const seen = oversizeFlips();
    const host: HostSession = room.host('host', { scheduler, eventLimit: 10, onStatus: () => seen.onStatus(host)() });
    const bundles: boolean[] = []; // full or not, for each bundle the pacer asks for
    const sendBundle = (host as unknown as { sendBundle: (full: boolean) => void }).sendBundle.bind(host);
    (host as unknown as { sendBundle: (full: boolean) => void }).sendBundle = (full) => { bundles.push(full); sendBundle(full); };
    const ann = await room.person('Ann', { scheduler, directPath: false });
    await runUntil(scheduler, () => joined(ann) && host.oversize);
    expect(seen.flips).toEqual([true]);
    // Just after a full refresh, so the next is 5 s away; its bundle has been sent while the limit was still small.
    const fulls = () => bundles.filter(Boolean).length;
    const before = fulls();
    await runUntil(scheduler, () => fulls() > before);
    await run(scheduler, 300);
    expect(host.oversize).toBe(true);
    // The limit is raised, as if the board had shrunk. A change bundle that fits does not clear the flag...
    (host as unknown as { o: { eventLimit: number } }).o.eventLimit = 1_000_000;
    const counted = host.oversizeCount;
    const changes = bundles.length;
    expect((await host.local({ type: 'setShowVotes', value: false })).ok).toBe(true);
    await run(scheduler, 1000);
    expect(bundles.slice(changes)).toEqual([false]);
    expect(host.oversize).toBe(true);
    expect((await host.local({ type: 'addTopic', text: 'Too soon' })).ok).toBe(false);
    // ...the next full refresh does.
    const fullsBefore = fulls();
    await runUntil(scheduler, () => fulls() > fullsBefore && !host.oversize, REFRESH_MS + 1000);
    expect(host.oversizeCount).toBe(counted);
    expect(seen.flips).toEqual([true, false]);
    expect((await host.local({ type: 'addTopic', text: 'More' })).ok).toBe(true);
    host.stop();
    warn.mockRestore();
  }, 30_000);

  it('leaves out only people whose every tab is on a healthy direct path', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const direct = () => (host as unknown as { directPeople: () => Set<string> }).directPeople();
    const ann = await room.person('Ann', { scheduler });
    await runUntil(scheduler, () => joined(ann) && direct().has(ann.id));
    // A second tab of Ann's whose direct path never connects: her entry must stay in the bundle for it.
    await room.person('Ann-2', { scheduler, signer: ann.signer, name: 'Ann', directPath: false });
    // A new tab is on probation (offline) until its first accepted ping or command, so wait for that.
    await runUntil(scheduler, () => host.presence().some((p) => p.peerId === 'Ann-2' && p.status === 'relayed'));
    expect(host.presence().find((p) => p.peerId === 'Ann-2')?.status).toBe('relayed');
    expect(host.presence().find((p) => p.peerId === 'Ann')?.status).toBe('direct');
    expect(direct().has(ann.id)).toBe(false);
    host.stop();
  }, 30_000);

  it('is never reached by an ordinary meeting', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler, directPath: false });
    await runUntil(scheduler, () => joined(ann));
    await host.local({ type: 'addTopic', text: 'Pairing' });
    await runUntil(scheduler, () => ann.session.state?.topics.length === 1);
    await run(scheduler, REFRESH_MS + 500);
    expect([host.oversize, host.oversizeCount]).toEqual([false, 0]);
    host.stop();
  }, 30_000);

  it('shows a relay-only newcomer why they were refused when a full refresh must drop the direct-path people’s entries', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const transport = room.transport('host');
    const key = generateSecretKey();
    const sizes: number[] = [];
    let lose = false; // the relay loses the bundle that carried the refusal, so only a full refresh can bring it
    const broadcast = transport.broadcastRelay.bind(transport);
    transport.broadcastRelay = (data) => { sizes.push(relayEventBytes(data, transport.selfId, TOPIC_PLACEHOLDER, key)); if (!lose) broadcast(data); };
    const host: HostSession = room.host('host', { scheduler, transport });
    const o = (host as unknown as { o: { eventLimit?: number } }).o;
    const fulls: boolean[] = [];
    const internals = host as unknown as { sendBundle: (full: boolean) => void };
    const sendBundle = internals.sendBundle.bind(host);
    internals.sendBundle = (full) => { fulls.push(full); sendBundle(full); };
    // Ann is on a healthy direct path, so the ceiling may drop her entry; Cy has only the relay.
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat(); // pings keep her direct path counted as healthy for the whole test
    const heavy = async (ms: number) => { for (let t = 0; t < ms; t += 100) { scheduler.advance(100); await settle(HEAVY_SETTLE_MS); } };
    const heavyUntil = async (condition: () => boolean, maxMs = 30_000) => {
      for (let t = 0; t < maxMs && !condition(); t += 100) await heavy(100);
      expect(condition()).toBe(true);
    };
    const direct = () => (host as unknown as { directPeople: () => Set<string> }).directPeople();
    await heavyUntil(() => joined(ann) && direct().has(ann.id));
    await heavy(REFRESH_MS + 500);
    const annOnly = Math.max(...sizes); // the largest event so far is a full refresh with Ann's entry alone
    const cyFrom = sizes.length;
    const cy = await room.person('Cy', { scheduler, directPath: false });
    cy.session.startHeartbeat();
    await heavyUntil(() => joined(cy));
    await heavy(REFRESH_MS + 500);
    const both = Math.max(...sizes.slice(cyFrom)); // a full refresh with both entries
    // One more entry costs `entry` bytes (measured, not assumed; at least the 95 bytes of nonce, tag, signature, type
    // byte and length before base64). The limit sits half an entry above the full refresh of Ann and Cy, so the
    // refresh with Bea's entry added cannot fit, while the one without Ann's (about the same size, as Bea's neutral
    // entry is within a few bytes of Ann's) does. The test needs those few bytes to stay under half an entry.
    const entry = both - annOnly;
    expect(entry).toBeGreaterThan(95);
    const limit = both + Math.floor(entry / 2);
    expect(both + entry).toBeGreaterThan(limit);
    // The signal is set by a real over-limit bundle: no bundle fits a limit of 10 bytes.
    o.eventLimit = 10;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await heavyUntil(() => host.oversize);
    // Then the limit returns to just above a full refresh of Ann and Cy. The signal stays set until a full refresh fits.
    // Wait for a full refresh, so the next is 5 s away and the newcomer is refused well before it.
    const seenFulls = fulls.filter(Boolean).length;
    await heavyUntil(() => fulls.filter(Boolean).length > seenFulls);
    await heavy(300);
    o.eventLimit = limit;
    const from = sizes.length;
    lose = true;
    const heard: Bytes[] = [];
    room.relay.tap = (f, to, data) => { if (f === 'host' && to === 'Bea' && !lose) heard.push(data); };
    expect(direct().has(ann.id)).toBe(true);
    const bea = await room.person('Bea', { scheduler, directPath: false });
    const refusal = () => (host as unknown as { refusalOf: (personId: string) => string | undefined }).refusalOf(bea.id);
    await heavyUntil(() => refusal() === 'meetingFullSize');
    expect(host.oversize).toBe(true);
    await heavy(1000);
    lose = false;
    expect(bea.session.joinRefused).toBeNull();
    await heavyUntil(() => bea.session.joinRefused === 'meetingFullSize', 2 * REFRESH_MS);
    expect(Object.keys(host.current.attendees)).not.toContain(bea.id);
    const whileRefused = sizes.slice(from);
    // Cy, who has only the relay, was not dropped to make room: the refresh that fit cleared the signal, and Cy
    // still gets views and acknowledgements.
    await heavyUntil(() => !host.oversize);
    expect(await host.local({ type: 'setShowVotes', value: false })).toMatchObject({ ok: true });
    await heavyUntil(() => cy.session.state?.showVotes === false);
    expect(await cy.session.send({ type: 'addTopic', text: 'After the ceiling' })).toBe(true);
    expect(cy.session.pendingFailed).toBe(false);
    // A copy of a bundle the joiner has already had, replayed, changes nothing.
    expect(heard.length).toBeGreaterThan(0);
    const before = JSON.stringify([bea.session.state, bea.session.joinRefused]);
    for (const data of [...heard]) room.relay.deliver('host', 'Bea', data);
    await heavy(300);
    expect(JSON.stringify([bea.session.state, bea.session.joinRefused])).toBe(before);
    // No relay event went over the ceiling while it was in force.
    expect(whileRefused.length).toBeGreaterThan(0);
    expect(Math.max(...whileRefused)).toBeLessThanOrEqual(limit);
    room.relay.tap = undefined;
    vi.restoreAllMocks();
    host.stop();
  }, 90_000);
});
