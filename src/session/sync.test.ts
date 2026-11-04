import { describe, expect, it } from 'vitest';
import { unseal } from '../crypto/aead';
import { fromUtf8, type Bytes } from '../crypto/bytes';
import { createBoard } from '../engine/board';
import { encodeWire, sealEnvelope } from '../protocol/envelope';
import { newSid } from '../protocol/sid';
import { FakeScheduler } from '../test/fake-scheduler';
import { BOARD, TestRoom } from '../test/sessions';
import { sleep, waitFor } from '../test/wait';
import { settle } from '../test/settle';
import { PROTOCOL_VERSION } from '../protocol/version';
import { RESEND_AFTER_MS, MAX_WAIT_MS } from './outbox';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

describe('protocol 2 hellos and commands', () => {
  it('sends hellos in the protocol 1 layout, naming the protocol version and the meeting', async () => {
    const room = await TestRoom.create();
    const firstFrames: Bytes[] = [];
    const tap = (from: string, to: string, data: Bytes) => { if (from === 'Ann' && to === 'host') firstFrames.push(data); };
    room.direct.tap = tap;
    room.relay.tap = tap;
    room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const hello = JSON.parse(fromUtf8(await unseal(room.roomKey, firstFrames[0])));
    expect(JSON.parse(hello.body)).toMatchObject({ t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Ann' });
  });

  it('ignores a hello for another meeting', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann', { boardId: 'another-meeting' });
    await sleep(100);
    expect(host.current.attendees[ann.id]).toBeUndefined();
  });

  it('numbers each tab’s commands from 1 and acknowledges them in the person’s view', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    await ann.session.send({ type: 'addTopic', text: 'First' });
    await ann.session.send({ type: 'addTopic', text: 'Second' });
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 2);
    expect(host.current.topics.map((t) => t.text)).toEqual(['First', 'Second']);
  });

  it('applies a duplicate once, and a command for another meeting not at all', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'));
    const sid = newSid(Date.now());
    const cmd = async (boardId: string, clientSeq: number, text: string) => encodeWire(room.roomKey, await sealEnvelope(ann.signer,
      { t: 'cmd', peer: 'raw', boardId, clientSeq, sid, epoch: 1, cmd: { type: 'addTopic', text } }));
    raw.send('host', await cmd('another-meeting', 1, 'Elsewhere'));
    const once = await cmd(BOARD, 1, 'Once');
    raw.send('host', once);
    raw.send('host', once);
    await waitFor(() => host.current.topics.length === 1);
    await sleep(50);
    expect(host.current.topics.map((t) => t.text)).toEqual(['Once']);
  });

  it('refuses a tab older than the person’s watermark with staleTab, and applies nothing from it', async () => {
    const room = await TestRoom.create();
    const ann0 = await room.person('Ann-old');
    const now = Date.now();
    const pruned = newSid(now - 10);
    room.saved = {
      state: createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' }),
      tabs: { [ann0.id]: { watermark: now - 5, tabs: {} } },
    };
    room.saved.state.attendees[ann0.id] = { id: ann0.id, name: 'Ann', role: 'guest' };
    ann0.session.stopHeartbeat();
    const host = room.host('host-2');
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host-2'));
    raw.send('host-2', await encodeWire(room.roomKey, await sealEnvelope(ann0.signer,
      { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq: 4, sid: pruned, epoch: 1, cmd: { type: 'addTopic', text: 'Too late' } })));
    await waitFor(() => ann0.session.state?.rejects[pruned]?.key === 'staleTab');
    expect(host.current.topics).toEqual([]);
    expect(ann0.session.state!.acks[pruned]).toBeUndefined();
  });
});

describe('acks after the save', () => {
  it('sends no view or ack built from a change until its save has resolved', async () => {
    const room = await TestRoom.create();
    let release!: () => void;
    let hold = false;
    const host = room.host('host', {
      save: async (saved) => {
        if (hold) await new Promise<void>((resolve) => { release = resolve; });
        room.saved = structuredClone(saved);
      },
    });
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    hold = true;
    await ann.session.send({ type: 'addTopic', text: 'Held' });
    await waitFor(() => host.current.topics.length === 1);
    await sleep(50);
    expect(ann.session.state!.topics).toEqual([]);
    expect(ann.session.state!.acks[ann.session.sid]).toBeUndefined();
    release();
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    expect(ann.session.state!.topics.map((t) => t.text)).toEqual(['Held']);
  });

  it('keeps a change whose save failed in memory, sends nothing from it, and sends it with the next good save', async () => {
    const room = await TestRoom.create();
    let fail = false;
    const host = room.host('host', {
      save: async (saved) => {
        if (fail) throw new Error('quota exceeded');
        room.saved = structuredClone(saved);
      },
    });
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    fail = true;
    await host.local({ type: 'addTopic', text: 'Unsaved' });
    expect(host.saveFailed).toBe(true);
    await sleep(50);
    expect(ann.session.state!.topics).toEqual([]);
    fail = false;
    await host.local({ type: 'addTopic', text: 'Saved' });
    expect(host.saveFailed).toBe(false);
    await waitFor(() => ann.session.state!.topics.length === 2);
  });

  it('acknowledges every tab of a person in each of their views', async () => {
    const room = await TestRoom.create();
    room.host();
    const tab1 = await room.person('Ann');
    const tab2 = await room.person('Ann-tab-2', { signer: tab1.signer, name: 'Ann' });
    await waitFor(() => joined(tab1) && tab2.session.state !== null);
    await tab1.session.send({ type: 'addTopic', text: 'From tab 1' });
    await tab2.session.send({ type: 'addTopic', text: 'From tab 2' });
    await waitFor(() => tab1.session.state!.acks[tab2.session.sid] === 1 && tab1.session.state!.acks[tab1.session.sid] === 1);
  });
});

describe('retries', () => {
  it('resends an unacknowledged command after 3 s and applies it once', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host();
    const ann = await room.person('Ann', { scheduler });
    await waitFor(() => joined(ann));
    room.direct.lose = room.relay.lose = (from, to) => from === 'Ann' && to === 'host';
    await ann.session.send({ type: 'addTopic', text: 'Eventually' });
    await sleep(50);
    expect(host.current.topics).toEqual([]);
    room.direct.lose = room.relay.lose = undefined;
    scheduler.advance(RESEND_AFTER_MS);
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    expect(host.current.topics.map((t) => t.text)).toEqual(['Eventually']);
  });

  it('keeps resending to a host that is alive but slow, and the command lands after more than a minute without failing', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host();
    const ann = await room.person('Ann', { scheduler });
    await waitFor(() => joined(ann));
    room.direct.lose = room.relay.lose = (from, to) => from === 'Ann' && to === 'host';
    await ann.session.send({ type: 'addTopic', text: 'Slow' });
    for (let i = 0; i < 25; i++) { // 75 s: far past the old 12 s
      scheduler.advance(RESEND_AFTER_MS);
      await settle();
      expect(ann.session.pendingFailed).toBe(false);
    }
    room.direct.lose = room.relay.lose = undefined;
    scheduler.advance(MAX_WAIT_MS / 4);
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    expect(ann.session.pendingFailed).toBe(false);
    expect(host.current.topics.map((t) => t.text)).toEqual(['Slow']);
  });

  it('gives up after two minutes without an ack from a live host, and Retry sends again from the oldest', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host();
    let statusChanges = 0;
    const ann = await room.person('Ann', { scheduler, onStatus: () => { statusChanges += 1; } });
    await waitFor(() => joined(ann));
    room.direct.lose = room.relay.lose = (from, to) => from === 'Ann' && to === 'host';
    await ann.session.send({ type: 'addTopic', text: 'One' });
    await ann.session.send({ type: 'addTopic', text: 'Two' });
    // The host stays known alive here, so the outbox backs off but keeps resending until two minutes have passed.
    for (let i = 0; i < MAX_WAIT_MS / RESEND_AFTER_MS + 2; i++) {
      scheduler.advance(RESEND_AFTER_MS);
      await settle();
    }
    expect(ann.session.pendingFailed).toBe(true);
    expect(statusChanges).toBeGreaterThan(0);
    room.direct.lose = room.relay.lose = undefined;
    ann.session.retry();
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 2);
    expect(ann.session.pendingFailed).toBe(false);
    expect(host.current.topics.map((t) => t.text)).toEqual(['One', 'Two']);
  });

  it('applies a command resent across a host reload once', async () => {
    const room = await TestRoom.create();
    const first = room.host('host-1');
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    // The command reaches the host, but its ack never reaches Ann.
    room.direct.lose = room.relay.lose = (from, to) => from === 'host-1' && to === 'Ann';
    await ann.session.send({ type: 'addTopic', text: 'Exactly once' });
    await waitFor(() => room.saved?.state.topics.length === 1);
    first.stop();
    room.direct.drop('host-1');
    room.relay.drop('host-1');
    room.direct.lose = room.relay.lose = undefined;
    const second = room.host('host-2', { epoch: 2 });
    await waitFor(() => ann.session.state?.acks[ann.session.sid] === 1, 5000);
    expect(second.current.topics.map((t) => t.text)).toEqual(['Exactly once']);
  });
});

describe('commands the host drops', () => {
  it('sends nothing back for a dropped command, and nothing about it appears in a later view', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host'));
    const toRaw: Bytes[] = [];
    room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'host' && to === 'raw') toRaw.push(data); };
    const farAhead = newSid(Date.now());
    const send = async (msg: Record<string, unknown>) => raw.send('host', await encodeWire(room.roomKey, await sealEnvelope(ann.signer, msg)));
    // A malformed sid, and a valid sid whose clientSeq is beyond the reorder window: both are dropped.
    await send({ t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq: 1, sid: 'tab-a', epoch: 1, cmd: { type: 'addTopic', text: 'Malformed' } });
    await send({ t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq: 1000, sid: farAhead, epoch: 1, cmd: { type: 'addTopic', text: 'Too far' } });
    await sleep(100);
    // A later change sends Ann a new view.
    await ann.session.send({ type: 'addTopic', text: 'Later' });
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    await sleep(50);
    expect(toRaw).toEqual([]);
    expect(host.current.topics.map((t) => t.text)).toEqual(['Later']);
    const view = ann.session.state!;
    for (const key of ['tab-a', farAhead]) {
      expect(Object.hasOwn(view.acks, key)).toBe(false);
      expect(Object.hasOwn(view.rejects, key)).toBe(false);
    }
    expect(JSON.stringify(view)).not.toContain('tab-a');
    expect(JSON.stringify(view)).not.toContain(farAhead);
  });
});

describe('loading a saved tab table', () => {
  it('drops __proto__ and malformed keys from a stored tab table, and keeps the rest', async () => {
    const room = await TestRoom.create();
    const ann0 = await room.person('Ann');
    ann0.session.stopHeartbeat();
    const now = Date.now();
    const sid = newSid(now);
    // As read back from storage or a file: an own __proto__ key, a malformed sid and a malformed person ID.
    const stored = JSON.parse(JSON.stringify({
      [ann0.id]: { watermark: 0, tabs: { [sid]: { ack: 1, lastCommandAt: now }, 'not-a-sid': { ack: 9, lastCommandAt: now } } },
      '': { watermark: 0, tabs: {} },
    }).replace('{', '{"__proto__":{"watermark":0,"tabs":{}},'));
    expect(Object.hasOwn(stored, '__proto__')).toBe(true);
    room.saved = { state: createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' }), tabs: stored };
    room.saved.state.attendees[ann0.id] = { id: ann0.id, name: 'Ann', role: 'guest' };
    const host = room.host('host-2');
    const raw = room.direct.join('raw');
    await waitFor(() => raw.peers().includes('host-2'));
    const cmd = async (clientSeq: number, text: string) => encodeWire(room.roomKey, await sealEnvelope(ann0.signer,
      { t: 'cmd', peer: 'raw', boardId: BOARD, clientSeq, sid, epoch: 1, cmd: { type: 'addTopic', text } }));
    // clientSeq 1 is a duplicate of the stored ack; clientSeq 2 is applied.
    raw.send('host-2', await cmd(1, 'Duplicate'));
    raw.send('host-2', await cmd(2, 'Applied'));
    await waitFor(() => host.current.topics.length === 1);
    await waitFor(() => room.saved?.tabs[ann0.id]?.tabs[sid]?.ack === 2);
    expect(host.current.topics.map((t) => t.text)).toEqual(['Applied']);
    const tabs = room.saved!.tabs;
    expect(Object.keys(tabs)).toEqual([ann0.id]);
    expect(Object.keys(tabs[ann0.id].tabs)).toEqual([sid]);
    expect(({} as Record<string, unknown>).watermark).toBeUndefined();
  });
});
