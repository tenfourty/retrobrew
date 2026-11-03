import { describe, expect, it } from 'vitest';
import { unseal } from '../crypto/aead';
import { fromUtf8, type Bytes } from '../crypto/bytes';
import { fingerprint, generateSigningKeys, signerFrom, type Signer } from '../crypto/sign';
import { createBoard } from '../engine/board';
import { MESSAGES } from '../engine/messages';
import { decodeFrame, encodeWire, sealEnvelope } from '../protocol/envelope';
import { newSid, sidCreatedAt } from '../protocol/sid';
import { PROTOCOL_VERSION } from '../protocol/version';
import type { MemoryNetwork } from '../transport/memory';
import { FakeScheduler } from '../test/fake-scheduler';
import { fresh } from '../test/hello';
import { BOARD, TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { sleep, waitFor } from '../test/wait';
import { GAP_REFUSE_MS, ONE_OFF_MAX, STALE_KEEP_MS, type HostSession } from './host';
import { RESEND_AFTER_MS } from './outbox';
import { COALESCE_MS, RELAY_GAP_MS } from './pacer';
import { MAX_TABS_PER_PERSON, PRUNE_AFTER_MS, type TabTable } from './tabs';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

// Runs the fake clock in small steps, while the real event loop does the cryptography, until the condition holds.
async function runUntil(scheduler: FakeScheduler, condition: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t < maxMs && !condition(); t += 100) {
    scheduler.advance(100);
    await settle(HEAVY_SETTLE_MS);
  }
  expect(condition()).toBe(true);
}

describe('tab bounds in a meeting', () => {
  it('drops a person’s least recently active tab when a sixth opens, and tells that tab to reload', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const first = await room.person('Ann');
    await waitFor(() => joined(first), 10_000);
    await first.session.send({ type: 'addTopic', text: 'From the first tab' });
    await waitFor(() => host.current.topics.length === 1, 10_000);
    // Five more tabs of the same person, each sending one command.
    for (let i = 0; i < MAX_TABS_PER_PERSON; i++) {
      const tab = await room.person(`Ann-tab-${i}`, { signer: first.signer, name: 'Ann' });
      await waitFor(() => joined(tab), 10_000);
      await tab.session.send({ type: 'addVote', topicId: 1 });
      await waitFor(() => tab.session.state?.acks[tab.session.sid] === 1, 10_000);
      tab.session.stopHeartbeat();
    }
    expect(Object.keys(room.saved!.tabs[first.id].tabs)).not.toContain(first.session.sid);
    // The dropped tab sends again: refused with tooManyTabs, which it shows, and nothing is applied.
    await first.session.send({ type: 'addTopic', text: 'After being dropped' });
    await waitFor(() => first.rejects.includes(MESSAGES.tooManyTabs), 10_000);
    expect(first.session.staleTab).toBe(true);
    expect(host.current.topics).toHaveLength(1);
    host.stop();
  }, 30_000);

  it('refuses a tab whose gap can never be filled (a backup older than its acks) with staleTab, rather than hanging', async () => {
    const room = await TestRoom.create();
    const first = room.host('host-1');
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann), 10_000);
    await ann.session.send({ type: 'addTopic', text: 'One' });
    await waitFor(() => ann.session.state?.acks[ann.session.sid] === 1, 10_000);
    const backup = structuredClone(room.saved!);
    await ann.session.send({ type: 'addTopic', text: 'Two' });
    await waitFor(() => ann.session.state?.acks[ann.session.sid] === 2, 10_000);
    // The facilitator restores the backup taken after the first command: the host's table says ack 1, Ann's tab is at 2.
    first.stop();
    room.direct.drop('host-1');
    room.relay.drop('host-1');
    room.saved = backup;
    const restored = room.host('host-2', { epoch: 2 });
    await waitFor(() => ann.session.state?.acks[ann.session.sid] === 1, 10_000);
    await ann.session.send({ type: 'addTopic', text: 'Three' });
    await waitFor(() => ann.session.staleTab, GAP_REFUSE_MS + 6000);
    expect(ann.rejects).toContain(MESSAGES.staleTab);
    expect(restored.current.topics.map((t) => t.text)).toEqual(['One']);
    restored.stop();
  }, 40_000);

  it('refuses an unknown tab whose first command isn’t 1 once a resend cycle passes, and forgets its buffer', async () => {
    const room = await TestRoom.create();
    // The host's own tick (it refuses an old gap by itself) runs only when this test advances the fake clock, so
    // which of the tick or a late arrival refuses the gap can't depend on how fast the machine is.
    const scheduler = new FakeScheduler(Date.now());
    const ann = await room.person('Ann', { scheduler });
    const host = room.host('host', { scheduler });
    await runUntil(scheduler, () => joined(ann));
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'), 10_000);
    const lost = newSid(scheduler.now() + 1); // newer than any watermark: the host's table simply never had it
    const internals = host as unknown as { buffered: Map<string, Map<number, unknown>>; gapSince: Map<string, number> };
    raw.send('host', await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq: 3, sid: lost, epoch: 1, cmd: { type: 'addTopic', text: 'Lost' } })));
    await runUntil(scheduler, () => internals.buffered.get(`${ann.id} ${lost}`)?.size === 1);
    expect(ann.session.state?.rejects[lost]).toBeUndefined();
    // A resend cycle and more passes, and the host's tick refuses the gap.
    await runUntil(scheduler, () => ann.session.state?.rejects[lost]?.key === 'staleTab', GAP_REFUSE_MS + 5000);
    expect(internals.buffered.has(`${ann.id} ${lost}`)).toBe(false);
    expect(internals.gapSince.has(`${ann.id} ${lost}`)).toBe(false);
    expect(host.current.topics).toHaveLength(0);
    host.stop();
  }, 60_000);

  it('keeps open gaps within the bounds when a person floods sids that start above 1', async () => {
    const room = await TestRoom.create();
    const ann = await room.person('Ann');
    const host = room.host();
    await waitFor(() => joined(ann), 10_000);
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'), 10_000);
    const internals = host as unknown as { buffered: Map<string, unknown>; gapSince: Map<string, number> };
    const base = sidCreatedAt(ann.session.sid)!;
    for (let i = 0; i < 3 * MAX_TABS_PER_PERSON; i++) {
      raw.send('host', await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
        { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq: 2, sid: newSid(base + 1 + i), epoch: 1, cmd: { type: 'addTopic', text: `Flood ${i}` } })));
    }
    await waitFor(() => internals.gapSince.size === MAX_TABS_PER_PERSON, 10_000);
    await settle(HEAVY_SETTLE_MS);
    expect(internals.gapSince.size).toBe(MAX_TABS_PER_PERSON);
    expect(internals.buffered.size).toBeLessThanOrEqual(MAX_TABS_PER_PERSON);
    host.stop();
  }, 30_000);

  it('forgets a refused tab’s reject after a while, so the map can’t grow without end', async () => {
    const room = await TestRoom.create();
    const ann = await room.person('Ann');
    // Ann's watermark sits just before her live tab, so an older sid of hers is refused with staleTab.
    let now = sidCreatedAt(ann.session.sid)!;
    room.saved = {
      state: createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' }),
      tabs: { [ann.id]: { watermark: now - 5, tabs: {} } },
    };
    room.saved.state.attendees[ann.id] = { id: ann.id, name: 'Ann', role: 'guest' };
    const host = room.host('host', { now: () => now });
    await waitFor(() => joined(ann), 10_000);
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'), 10_000);
    const old = newSid(now - 10);
    raw.send('host', await encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq: 1, sid: old, epoch: 1, cmd: { type: 'addTopic', text: 'Old' } })));
    await waitFor(() => ann.session.state?.rejects[old]?.key === 'staleTab', 10_000);
    now += STALE_KEEP_MS + 2000;
    await waitFor(() => !(host as unknown as { stale: Map<string, unknown> }).stale.has(ann.id), 5000);
    await waitFor(() => ann.session.state?.rejects[old] === undefined, 15_000);
    expect(host.current.topics).toHaveLength(0);
    host.stop();
  }, 30_000);
});

// An attendee with no session of their own: commands are sent raw, so a test can capture and replay them.
async function seededAnn(room: TestRoom): Promise<{ signer: Signer; id: string }> {
  const signer = await signerFrom(await generateSigningKeys(false));
  const id = await fingerprint(signer.pub);
  room.saved = { state: createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' }), tabs: {} };
  room.saved.state.attendees[id] = { id, name: 'Ann', role: 'guest' };
  return { signer, id };
}

const command = async (room: TestRoom, signer: Signer, sid: string, clientSeq: number, text: string): Promise<Bytes> =>
  encodeWire(room.roomKey, await sealEnvelope(signer, { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq, sid, epoch: 1, cmd: { type: 'addTopic', text } }));

const internals = (host: HostSession) => host as unknown as {
  tabs: TabTable; stale: Map<string, { sid: string; clientSeq: number; key: string }>; buffered: Map<string, Map<number, unknown>>;
};

describe('tab bounds against a room-key holder', () => {
  it('never gives a stranger a tab entry: a flood of minted signers can’t push out an attendee’s live tab', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann), 10_000);
    await ann.session.send({ type: 'addTopic', text: 'Mine' });
    await waitFor(() => ann.session.state?.acks[ann.session.sid] === 1, 10_000);
    const raw = room.direct.join('raw');
    const frames: Bytes[] = [];
    raw.onMessage((_from, data) => { frames.push(data); });
    await waitFor(() => raw.peers().includes('host'), 10_000);
    const sent: string[] = [];
    for (let i = 0; i < 70; i++) {
      const signer = await signerFrom(await generateSigningKeys(false));
      for (let t = 0; t < MAX_TABS_PER_PERSON; t++) {
        const sid = newSid(Date.now() + t);
        sent.push(sid);
        raw.send('host', await command(room, signer, sid, 1, 'Spam'));
      }
    }
    type Reply = { t: string; state: { rejects: Record<string, { key: string }> } };
    const replies = async (): Promise<Reply[]> => {
      const out: Reply[] = [];
      for (const data of frames) {
        const frame = await decodeFrame(room.roomKey, data);
        if (frame?.kind !== 'envelope') continue;
        const msg = JSON.parse(frame.env.body) as Reply;
        if (msg.t === 'snapshot' && Object.keys(msg.state.rejects).length) out.push(msg);
      }
      return out;
    };
    let found: Reply[] = [];
    for (let tries = 0; tries < 50 && !found.length; tries++) { await sleep(100); found = await replies(); }
    await settle(HEAVY_SETTLE_MS);
    expect(Object.keys(internals(host).tabs)).toEqual([ann.id]);
    expect(Object.keys(room.saved!.tabs)).toEqual([ann.id]);
    expect(Object.keys(room.saved!.tabs[ann.id].tabs)).toEqual([ann.session.sid]);
    expect(host.current.topics).toHaveLength(1);
    // Each refusal went straight back to the sender, as notAttendee.
    expect(found.length).toBeGreaterThan(0);
    const [sid] = Object.keys(found[0].state.rejects);
    expect(sent).toContain(sid);
    expect(found[0].state.rejects[sid].key).toBe('notAttendee');
    host.stop();
  }, 60_000);

  it('refuses a captured command replayed after its person’s entry was forgotten', async () => {
    const room = await TestRoom.create();
    const ann = await seededAnn(room);
    let now = Date.now();
    const host = room.host('host', { now: () => now });
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'), 10_000);
    const captured = await command(room, ann.signer, newSid(now), 1, 'Once');
    raw.send('host', captured);
    await waitFor(() => host.current.topics.length === 1, 10_000);
    now += PRUNE_AFTER_MS + 1;
    await host.local({ type: 'addTopic', text: 'A day later' }); // the save prunes Ann's tab
    expect(Object.keys(internals(host).tabs[ann.id].tabs)).toHaveLength(0);
    now += PRUNE_AFTER_MS + 1;
    await host.local({ type: 'addTopic', text: 'Two days later' }); // and now forgets Ann, watermark and all
    expect(internals(host).tabs[ann.id]).toBeUndefined();
    raw.send('host', captured);
    await waitFor(() => internals(host).stale.get(ann.id)?.key === 'staleTab', 10_000);
    expect(host.current.topics.map((t) => t.text)).toEqual(['Once', 'A day later', 'Two days later']);
    host.stop();
  }, 30_000);

  it('refuses a replay from a tab dropped more than ten drops ago, from a device whose clock runs fast', async () => {
    const room = await TestRoom.create();
    const ann = await seededAnn(room);
    const host = room.host();
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'), 10_000);
    const ahead = Date.now() + 3_600_000;
    let first: Bytes | null = null;
    for (let i = 0; i < 17; i++) {
      const wire = await command(room, ann.signer, newSid(ahead + i), 1, `Tab ${i}`);
      first ??= wire;
      raw.send('host', wire);
      await waitFor(() => host.current.topics.length === i + 1, 10_000);
    }
    expect(internals(host).tabs[ann.id].evicted).toHaveLength(10);
    raw.send('host', first!);
    await waitFor(() => internals(host).stale.get(ann.id)?.key === 'staleTab', 10_000);
    expect(host.current.topics).toHaveLength(17);
    host.stop();
  }, 30_000);

  it('survives a lost resend, and still refuses a gap that never fills, after three resend cycles', async () => {
    const room = await TestRoom.create();
    const ann = await seededAnn(room);
    let now = Date.now();
    const host = room.host('host', { now: () => now });
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'), 10_000);
    const sid = newSid(now);
    raw.send('host', await command(room, ann.signer, sid, 1, 'One'));
    await waitFor(() => host.current.topics.length === 1, 10_000);
    // Command 2 is lost, and so is its first resend: one cycle and more passes with 3 waiting.
    raw.send('host', await command(room, ann.signer, sid, 3, 'Three'));
    await waitFor(() => internals(host).buffered.get(`${ann.id} ${sid}`)?.size === 1, 10_000);
    now += RESEND_AFTER_MS + 2500;
    await sleep(1500);
    expect(internals(host).stale.has(ann.id)).toBe(false);
    raw.send('host', await command(room, ann.signer, sid, 2, 'Two'));
    await waitFor(() => host.current.topics.length === 3, 10_000);
    // Command 4 never comes: three cycles later the tab is refused, with nothing more needing to arrive.
    raw.send('host', await command(room, ann.signer, sid, 5, 'Five'));
    await waitFor(() => internals(host).buffered.get(`${ann.id} ${sid}`)?.size === 1, 10_000);
    now += GAP_REFUSE_MS;
    await waitFor(() => internals(host).stale.get(ann.id)?.key === 'staleTab', 5000);
    expect(internals(host).stale.get(ann.id)).toMatchObject({ sid, clientSeq: 5 });
    expect(internals(host).buffered.has(`${ann.id} ${sid}`)).toBe(false);
    expect(host.current.topics).toHaveLength(3);
    host.stop();
  }, 30_000);
});

describe('a newcomer’s first command', () => {
  it('waits for the join: a command made before the join lands is applied after it, with no refusal and no reload', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    // Ann's frames to the host are held back, so the test picks the order they arrive in.
    let holding = true;
    const held: Array<{ net: MemoryNetwork; data: Bytes }> = [];
    for (const net of [room.direct, room.relay]) {
      net.lose = (from, to, data) => {
        if (!holding || from !== 'Ann' || to !== 'host') return false;
        held.push({ net, data });
        return true;
      };
    }
    const ann = await room.person('Ann');
    await waitFor(() => held.length > 0, 10_000); // her hello
    // A view that doesn't list her yet (the shared view anyone not yet joined gets) makes the host known to the page.
    await (host as unknown as { sendSnapshot(peer: string, personId: string, path: string): Promise<void> }).sendSnapshot('Ann', ann.id, 'direct');
    await waitFor(() => ann.session.hostOnline, 10_000);
    expect(ann.session.state?.attendees[ann.id]).toBeUndefined();
    await ann.session.send({ type: 'addTopic', text: 'At once' });
    await settle(HEAVY_SETTLE_MS);
    holding = false;
    // Whatever command the page sent reaches the host before its hello, so before the join is applied.
    const kinds = await Promise.all(held.map(async ({ data }) => {
      const frame = await decodeFrame(room.roomKey, data);
      return frame?.kind === 'envelope' ? (JSON.parse(frame.env.body) as { t: string }).t : '';
    }));
    const order = held.map((h, i) => ({ ...h, t: kinds[i] })).sort((a, b) => Number(a.t !== 'cmd') - Number(b.t !== 'cmd'));
    for (const { net, data, t } of order) {
      net.deliver('Ann', 'host', data);
      if (t === 'cmd') await settle(HEAVY_SETTLE_MS); // handled, and refused, before the hello arrives
    }
    await waitFor(() => host.current.topics.length === 1, 10_000);
    await waitFor(() => ann.session.state?.acks[ann.session.sid] === 1, 10_000);
    expect(host.current.topics[0].text).toBe('At once');
    expect(ann.rejects).toEqual([]);
    expect(ann.session.staleTab).toBe(false);
    expect(ann.session.pendingFailed).toBe(false);
    host.stop();
  }, 30_000);

  it('never applies a command from someone whose join was refused', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const nobody = await room.person('');
    await waitFor(() => nobody.session.state?.joinRefused === 'emptyName', 10_000);
    await nobody.session.send({ type: 'addTopic', text: 'Sneaked in' });
    await sleep(RESEND_AFTER_MS + 1000);
    expect(host.current.topics).toHaveLength(0);
    expect(Object.hasOwn(internals(host).tabs, nobody.id)).toBe(false);
    expect(nobody.session.staleTab).toBe(false);
    host.stop();
  }, 30_000);
});

describe('one-off replies', () => {
  type Reply = { t: string; state: { rejects: Record<string, { key: string }> } };
  async function refusals(room: TestRoom, frames: Bytes[]): Promise<Reply[]> {
    const out: Reply[] = [];
    for (const data of frames) {
      const frame = await decodeFrame(room.roomKey, data);
      if (frame?.kind !== 'envelope') continue;
      const msg = JSON.parse(frame.env.body) as Reply;
      if (msg.t === 'snapshot' && Object.values(msg.state.rejects).some((r) => r.key === 'notAttendee')) out.push(msg);
    }
    return out;
  }

  async function flood(room: TestRoom, signers: number, perSigner: number): Promise<Bytes[]> {
    const wires: Bytes[] = [];
    for (let i = 0; i < signers; i++) {
      const signer = await signerFrom(await generateSigningKeys(false));
      for (let t = 0; t < perSigner; t++) wires.push(await command(room, signer, newSid(Date.now() + t), 1, 'Spam'));
    }
    return wires;
  }

  it('answers 500 strangers’ commands from 100 signers with at most ONE_OFF_MAX refusals, and real views aren’t held up', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { directPath: false, scheduler }); // bundles only
    await runUntil(scheduler, () => joined(ann));
    const wires = await flood(room, 100, 5);
    const direct = room.direct.join('raw');
    const relay = room.relay.join('raw');
    const frames: Bytes[] = [];
    direct.onMessage((_from, data) => { frames.push(data); });
    relay.onMessage((_from, data) => { frames.push(data); });
    await waitFor(() => direct.peers().includes('host') && relay.peers().includes('host'), 10_000);
    wires.forEach((wire, i) => (i % 2 ? direct : relay).send('host', wire));
    // The clock is fake and stands still while the 500 signatures are checked, so however slow the machine is, the
    // refusals have been sent (and have taken what relay slots they take) before the real change below.
    await settle(HEAVY_SETTLE_MS);
    // What matters is that refusals taking relay slots don't hold up the bundle: it must reach Ann within one relay
    // slot (and the coalescing window) of fake time.
    await host.local({ type: 'addTopic', text: 'Real' });
    let waited = 0;
    while (ann.session.state?.topics.length !== 1 && waited < 1500) {
      scheduler.advance(50);
      waited += 50;
      await settle(HEAVY_SETTLE_MS);
    }
    expect(ann.session.state?.topics).toHaveLength(1);
    expect(waited).toBeLessThanOrEqual(COALESCE_MS + RELAY_GAP_MS + 50);
    scheduler.advance(1500);
    await settle(HEAVY_SETTLE_MS);
    expect((await refusals(room, frames)).length).toBeLessThanOrEqual(ONE_OFF_MAX);
    expect(host.current.topics).toHaveLength(1);
    host.stop();
  }, 60_000);

  it('still refuses a single stranger’s command within 5 s', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const [wire] = await flood(room, 1, 1);
    const raw = room.direct.join('raw');
    const frames: Bytes[] = [];
    raw.onMessage((_from, data) => { frames.push(data); });
    await waitFor(() => raw.peers().includes('host'), 10_000);
    raw.send('host', wire);
    let found: Reply[] = [];
    // Five seconds of fake time, in steps of 100 ms.
    for (let tries = 0; tries < 50 && !found.length; tries++) {
      scheduler.advance(100);
      await settle(HEAVY_SETTLE_MS);
      found = await refusals(room, frames);
    }
    expect(found).toHaveLength(1);
    host.stop();
  }, 30_000);
});

describe('a notAttendee refusal', () => {
  it('leaves the command pending, shows nothing, and the command is applied once it reaches the host', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann), 10_000);
    // Ann's command is lost on the way, and a notAttendee refusal for it reaches her (as from a host that hadn't
    // applied her join yet).
    let losing = true;
    for (const net of [room.direct, room.relay]) net.lose = (from, to) => losing && from === 'Ann' && to === 'host';
    await ann.session.send({ type: 'addTopic', text: 'Pending' });
    (host as unknown as { refuseStranger(m: unknown, personId: string, msg: unknown): void })
      .refuseStranger({ from: 'Ann', path: 'direct' }, ann.id, { sid: ann.session.sid, clientSeq: 1 });
    await waitFor(() => ann.session.state?.rejects[ann.session.sid]?.key === 'notAttendee', 10_000);
    losing = false;
    await waitFor(() => host.current.topics.length === 1, 10_000); // the resend, from clientSeq 1
    await waitFor(() => ann.session.state?.acks[ann.session.sid] === 1, 10_000);
    expect(ann.rejects).toEqual([]);
    expect(ann.session.staleTab).toBe(false);
    host.stop();
  }, 30_000);
});

describe('one-off reply caps, kept apart by kind', () => {
  // A tab running protocol 1: it says hello without pv and reads only bare-JSON frames.
  async function oldTab(room: TestRoom, id: string) {
    const signer = await signerFrom(await generateSigningKeys(false));
    const transport = room.relay.join(id);
    const replies: Array<Record<string, unknown>> = [];
    transport.onMessage((_from, data) => {
      void unseal(room.roomKey, data).then((plain) => {
        if (plain[0] === 0x7b) replies.push(JSON.parse(JSON.parse(fromUtf8(plain)).body));
      });
    });
    const hello = async () => transport.send('host', await encodeWire(room.roomKey, await sealEnvelope(signer, { t: 'hello', name: 'Old', peer: id }), 1));
    await waitFor(() => transport.peers().includes('host'), 10_000);
    return { replies, hello };
  }

  // A peer on the direct path whose hellos (from any signer) ask to join with an empty name, so they are refused.
  async function refusedJoiner(room: TestRoom, id: string) {
    const transport = room.direct.join(id);
    const frames: Bytes[] = [];
    transport.onMessage((_from, data) => { frames.push(data); });
    await waitFor(() => transport.peers().includes('host'), 10_000);
    const hello = async (signer: Signer) => transport.send('host', await encodeWire(room.roomKey, await sealEnvelope(signer,
      { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: '', peer: id, ...fresh() })));
    const refusals = async (): Promise<number> => {
      let n = 0;
      for (const data of frames) {
        const frame = await decodeFrame(room.roomKey, data);
        if (frame?.kind !== 'envelope') continue;
        const msg = JSON.parse(frame.env.body) as { t: string; state?: { joinRefused?: string } };
        if (msg.t === 'snapshot' && msg.state?.joinRefused === 'emptyName') n += 1;
      }
      return n;
    };
    return { hello, refusals };
  }

  const minted = async (n: number) => Promise.all(Array.from({ length: n }, async () => signerFrom(await generateSigningKeys(false))));

  async function strangerFlood(room: TestRoom, signers: number, perSigner: number): Promise<Bytes[]> {
    const wires: Bytes[] = [];
    for (const signer of await minted(signers)) {
      for (let t = 0; t < perSigner; t++) wires.push(await command(room, signer, newSid(Date.now() + t), 1, 'Spam'));
    }
    return wires;
  }

  it('a flood of strangers’ commands never stops a version reply or a refused joiner’s snapshot', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const wires = await strangerFlood(room, 100, 5);
    const direct = room.direct.join('raw');
    const relay = room.relay.join('raw');
    await waitFor(() => direct.peers().includes('host') && relay.peers().includes('host'), 10_000);
    const old = await oldTab(room, 'old-tab');
    const joiner = await refusedJoiner(room, 'joiner');
    const [joinerSigner] = await minted(1);
    wires.forEach((wire, i) => (i % 2 ? direct : relay).send('host', wire));
    // Each says hello again every second of fake time, as a real page would, until answered; five seconds at most.
    // The flood's signatures are checked while the clock stands still, so a slow machine can't run it out.
    for (let second = 0; second < 5 && (old.replies.length === 0 || await joiner.refusals() === 0); second++) {
      if (old.replies.length === 0) await old.hello();
      if (await joiner.refusals() === 0) await joiner.hello(joinerSigner);
      await settle(HEAVY_SETTLE_MS);
      scheduler.advance(1000);
      await settle(HEAVY_SETTLE_MS);
    }
    expect(old.replies.length).toBeGreaterThan(0);
    expect(await joiner.refusals()).toBeGreaterThan(0);
    host.stop();
  }, 60_000);

  it('holds the version-reply cap under a flood of protocol 1 hellos', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const tabs = await Promise.all(Array.from({ length: 40 }, (_, i) => oldTab(room, `old-${i}`)));
    // Each says hello every 500 ms, so spare relay slots alone would allow about nine replies in the window.
    for (let i = 0; i < 9; i++) {
      await Promise.all(tabs.map((tab) => tab.hello()));
      await settle(HEAVY_SETTLE_MS);
      scheduler.advance(500);
      await settle(HEAVY_SETTLE_MS);
    }
    const replies = tabs.reduce((n, tab) => n + tab.replies.length, 0);
    expect(replies).toBeGreaterThan(0);
    expect(replies).toBeLessThanOrEqual(ONE_OFF_MAX);
    host.stop();
  }, 60_000);

  it('holds the refused-join cap under a flood of refused hellos', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const joiner = await refusedJoiner(room, 'joiner');
    for (const signer of await minted(40)) await joiner.hello(signer);
    await settle(HEAVY_SETTLE_MS);
    for (let t = 0; t < 2000; t += 100) {
      scheduler.advance(100);
      await settle(HEAVY_SETTLE_MS);
    }
    expect(await joiner.refusals()).toBeLessThanOrEqual(ONE_OFF_MAX);
    expect(await joiner.refusals()).toBeGreaterThan(0);
    host.stop();
  }, 60_000);
});
