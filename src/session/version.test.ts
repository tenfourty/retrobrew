import { describe, expect, it } from 'vitest';
import { unseal } from '../crypto/aead';
import { fromUtf8, type Bytes } from '../crypto/bytes';
import { fingerprint, generateSigningKeys, signerFrom } from '../crypto/sign';
import { encodeWire, sealEnvelope } from '../protocol/envelope';
import { newSid } from '../protocol/sid';
import { VERSION_MESSAGE } from '../protocol/version';
import { FakeScheduler } from '../test/fake-scheduler';
import { BOARD, TestRoom } from '../test/sessions';
import { settle } from '../test/settle';
import { waitFor } from '../test/wait';
import { VERSION_REPLY_MS } from './host';
import { HOST_OFFLINE_MS, NO_RELAYS_MS } from './participant';

async function run(scheduler: FakeScheduler, ms: number, step = 100): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    scheduler.advance(step);
    await settle();
  }
}

// A tab running another version: it says hello without pv and reads only bare-JSON frames.
async function otherVersionTab(room: TestRoom, id: string) {
  const signer = await signerFrom(await generateSigningKeys(false));
  const transport = room.relay.join(id);
  const replies: Array<Record<string, unknown>> = [];
  transport.onMessage((_from, data) => {
    void unseal(room.roomKey, data).then((plain) => {
      if (plain[0] === 0x7b) replies.push(JSON.parse(JSON.parse(fromUtf8(plain)).body));
    });
  });
  const hello = async () => transport.send('host', await encodeWire(room.roomKey, await sealEnvelope(signer, { t: 'hello', name: 'Old', peer: id }), 1));
  return { signer, transport, replies, hello, id: await fingerprint(signer.pub) };
}

describe('version handling on the host', () => {
  it('answers a hello without a version with a snapshot that names the version message', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const old = await otherVersionTab(room, 'old-tab');
    await run(scheduler, 1000);
    await old.hello();
    await waitFor(() => old.replies.length === 1);
    expect(old.replies[0]).toMatchObject({ t: 'snapshot', epoch: 1, you: old.id, host: 'host', state: { boardName: VERSION_MESSAGE, topics: [], timer: null } });
    expect((old.replies[0].state as { attendees: Record<string, unknown> }).attendees).toEqual({ [old.id]: { id: old.id, name: 'Old', role: 'guest' } });
    expect(host.current.attendees[old.id]).toBeUndefined();
    host.stop();
  });

  it('replies at most once per peer every 5 s, and only in a relay slot no bundle needs', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const old = await otherVersionTab(room, 'old-tab');
    await run(scheduler, 1000);
    for (let i = 0; i < 3; i++) await old.hello();
    await settle();
    expect(old.replies).toHaveLength(1);
    await run(scheduler, VERSION_REPLY_MS + 600);
    await old.hello();
    await waitFor(() => old.replies.length === 2);
    host.stop();
  });

  // A protocol 1 tab says hello every 5 s, the host's full refresh takes a relay slot every 5 s: a hello that keeps
  // landing just after a refresh must still be answered.
  it('answers a protocol 1 tab whose hellos keep landing just after a refresh', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const old = await otherVersionTab(room, 'old-tab');
    for (let i = 0; i < 6 && old.replies.length === 0; i++) {
      await run(scheduler, i === 0 ? 5200 : 5000);
      await old.hello();
      await settle();
    }
    await run(scheduler, 1000);
    expect(old.replies).toHaveLength(1);
    host.stop();
  });

  it('ignores commands and pings from a peer on another version', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const old = await otherVersionTab(room, 'old-tab');
    await run(scheduler, 1000);
    await old.hello();
    await waitFor(() => old.replies.length === 1);
    old.transport.send('host', await encodeWire(room.roomKey, await sealEnvelope(old.signer,
      { t: 'cmd', peer: 'old-tab', boardId: BOARD, clientSeq: 1, sid: newSid(Date.now()), epoch: 1, cmd: { type: 'addTopic', text: 'Sneaked in' } })));
    await settle();
    expect(host.current.topics).toEqual([]);
    host.stop();
  });

  it('gives a newer participant (a higher pv) the version reply too', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const newer = await otherVersionTab(room, 'newer-tab');
    await run(scheduler, 1000);
    newer.transport.send('host', await encodeWire(room.roomKey, await sealEnvelope(newer.signer,
      { t: 'hello', pv: 4, boardId: BOARD, name: 'Newer', peer: 'newer-tab' }), 1));
    await waitFor(() => newer.replies.length === 1);
    expect(newer.replies[0]).toMatchObject({ state: { boardId: BOARD, boardName: VERSION_MESSAGE, topics: [] } });
    host.stop();
  });
});

describe('version handling on the participant', () => {
  async function versionReplyTo(room: TestRoom, ann: { id: string }, boardName: string, from: string): Promise<Bytes> {
    return encodeWire(room.roomKey, await sealEnvelope(room.hostSigner,
      { t: 'snapshot', epoch: 99, seq: 0, you: ann.id, host: from, state: { boardName, topics: [], timer: null, attendees: {} } }), 1);
  }

  it('shows the reload message for a newer host, and a protocol 2 view clears it', async () => {
    const room = await TestRoom.create();
    const ann = await room.person('Ann');
    const oldHost = room.relay.join('old-host');
    await waitFor(() => oldHost.peers().includes('Ann'));
    oldHost.send('Ann', await versionReplyTo(room, ann, VERSION_MESSAGE, 'old-host'));
    await waitFor(() => ann.session.connection === 'versionMismatch');
    expect(ann.session.mismatch).toBe('reloadThisPage');
    room.host();
    await waitFor(() => ann.session.state !== null);
    expect(ann.session.mismatch).toBeNull();
    expect(ann.session.connection).toBe('connected');
  });

  it('says the facilitator should reload when the host is older', async () => {
    const room = await TestRoom.create();
    const ann = await room.person('Ann');
    const oldHost = room.relay.join('old-host');
    await waitFor(() => oldHost.peers().includes('Ann'));
    oldHost.send('Ann', await versionReplyTo(room, ann, 'Team', 'old-host'));
    await waitFor(() => ann.session.connection === 'versionMismatch');
    expect(ann.session.mismatch).toBe('askFacilitator');
  });

  it('ignores a version reply forwarded by another peer or meant for someone else', async () => {
    const room = await TestRoom.create();
    const ann = await room.person('Ann');
    const mallory = room.relay.join('mallory');
    await waitFor(() => mallory.peers().includes('Ann'));
    mallory.send('Ann', await versionReplyTo(room, ann, VERSION_MESSAGE, 'old-host'));
    mallory.send('Ann', await versionReplyTo(room, { id: 'someone-else' }, VERSION_MESSAGE, 'mallory'));
    await settle();
    expect(ann.session.mismatch).toBeNull();
  });
});

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

async function runUntil(scheduler: FakeScheduler, condition: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t < maxMs && !condition(); t += 100) await run(scheduler, 100);
  expect(condition()).toBe(true);
}

// A version reply signed by the host's key, as the peer `from`, for `you`.
async function versionReplyFrame(room: TestRoom, you: string, from: string, epoch: number, seq: number, boardName = VERSION_MESSAGE): Promise<Bytes> {
  return encodeWire(room.roomKey, await sealEnvelope(room.hostSigner,
    { t: 'snapshot', epoch, seq, you, host: from, state: { boardName, topics: [], timer: null, attendees: {} } }), 1);
}

describe('version replies under the send budget', () => {
  it('drops the version reply while a bundle has the relay slot, and sends it in a spare one', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const old = await otherVersionTab(room, 'old-tab');
    await run(scheduler, 1000);
    await host.local({ type: 'addTopic', text: 'Busy' }); // the change's bundle takes this relay slot
    await old.hello();
    await settle();
    expect(old.replies).toHaveLength(0);
    await run(scheduler, 600);
    await old.hello();
    await waitFor(() => old.replies.length === 1);
    host.stop();
  });

  it('carries no topics and nobody else’s data', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    await host.local({ type: 'addTopic', text: 'Secret topic' });
    const old = await otherVersionTab(room, 'old-tab');
    // An old tab says hello again until it hears back; the reply waits for a relay slot no bundle needs.
    for (let i = 0; i < 20 && old.replies.length === 0; i++) {
      await old.hello();
      await run(scheduler, 600);
    }
    expect(old.replies).toHaveLength(1);
    const text = JSON.stringify(old.replies[0]);
    expect(text).not.toContain('Secret topic');
    expect(text).not.toContain(ann.id);
    expect(text).not.toContain('Olu');
    expect(Object.keys((old.replies[0].state as { attendees: object }).attendees)).toEqual([old.id]);
    expect(host.presence().some((p) => p.peerId === 'old-tab')).toBe(false);
    expect(host.online()).not.toContain(old.id);
    ann.session.stopHeartbeat();
    host.stop();
   }, 20_000);
});

describe('version records are per peer and signer', () => {
  it('a forged protocol 1 hello naming Ann’s peer under Mallory’s key changes nothing for Ann', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    const mallory = await signerFrom(await generateSigningKeys(false));
    room.relay.deliver('Ann', 'host', await encodeWire(room.roomKey, await sealEnvelope(mallory, { t: 'hello', name: 'Mallory', peer: 'Ann' }), 1));
    room.relay.deliver('Ann', 'host', await encodeWire(room.roomKey, await sealEnvelope(mallory, { t: 'hello', pv: 1, boardId: BOARD, name: 'Mallory', peer: 'Ann' }), 1));
    await settle();
    // Ann's record is untouched: still out of probation, still direct.
    const annRecord = host.presence().find((p) => p.peerId === 'Ann' && p.participantId === ann.id);
    expect(annRecord?.status).toBe('direct');
    expect(host.presence().filter((p) => p.peerId === 'Ann').map((p) => p.participantId)).toEqual([ann.id]);
    // Her commands, pings and views go on.
    await ann.session.send({ type: 'addTopic', text: 'Ann’s' });
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    expect(ann.session.state!.topics.map((t) => t.text)).toEqual(['Ann’s']);
    const heardBefore = host.online().includes(ann.id);
    await ann.session.ping();
    await settle();
    expect(heardBefore && host.online().includes(ann.id)).toBe(true);
    expect(ann.session.mismatch).toBeNull();
    host.stop();
  });

  it('a replayed protocol 1 hello under Ann’s own key never downgrades her live record', async () => {
    const room = await TestRoom.create();
    const host = room.host();
    const ann = await room.person('Ann');
    await waitFor(() => joined(ann));
    room.relay.deliver('Ann', 'host', await encodeWire(room.roomKey, await sealEnvelope(ann.signer, { t: 'hello', name: 'Ann', peer: 'Ann' }), 1));
    await settle();
    await ann.session.send({ type: 'addTopic', text: 'Still mine' });
    await waitFor(() => ann.session.state!.acks[ann.session.sid] === 1);
    expect(host.current.topics.map((t) => t.text)).toEqual(['Still mine']);
    host.stop();
  });
});

describe('the mismatch on the participant', () => {
  it('stays through every other recompute, and only a newer protocol 2 view clears it', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    const fromHost: Bytes[] = [];
    room.direct.tap = room.relay.tap = (from, to, data) => { if (from === 'host' && to === 'Ann') fromHost.push(data); };
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    await run(scheduler, 1000);
    const oldView = fromHost[0];
    const reply = await versionReplyFrame(room, ann.id, 'host', 1, 1000);
    room.direct.lose = room.relay.lose = (from, _to, data) => from === 'host' && data !== reply && data !== oldView;
    // Settle first: a host view already delivered when the host was cut off may still be opening, and a newer protocol 2
    // view rightly clears the mismatch. Once Ann has decided the host is offline (20 s of fake time with nothing from
    // it), nothing from the host is left in flight, so only the version reply below can move her.
    await runUntil(scheduler, () => ann.session.connection === 'hostOffline');
    room.relay.deliver('host', 'Ann', reply);
    await waitFor(() => ann.session.connection === 'versionMismatch');
    expect(ann.session.mismatch).toBe('reloadThisPage');
    // Relays down, the host still offline, an old view replayed: none of them moves it.
    room.relay.health = [{ url: 'wss://relay.example', connected: false, refused: 0, notices: 0 }];
    await run(scheduler, NO_RELAYS_MS + 2000);
    expect(ann.session.connection).toBe('versionMismatch');
    await run(scheduler, HOST_OFFLINE_MS + 2000);
    room.direct.deliver('host', 'Ann', oldView);
    await settle();
    expect(ann.session.connection).toBe('versionMismatch');
    expect(ann.session.mismatch).toBe('reloadThisPage');
    // A newer protocol 2 view from the host clears it.
    room.relay.health = [];
    room.direct.lose = room.relay.lose = undefined;
    await host.local({ type: 'addTopic', text: 'Back' });
    await runUntil(scheduler, () => ann.session.mismatch === null);
    await runUntil(scheduler, () => ann.session.connection === 'connected');
    ann.session.stopHeartbeat();
    host.stop();
   }, 30_000);

  it('ignores a version reply older than the protocol 2 view it holds, and one replayed after it cleared', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler, epoch: 5 });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await runUntil(scheduler, () => joined(ann));
    room.relay.deliver('host', 'Ann', await versionReplyFrame(room, ann.id, 'host', 4, 1000));
    room.relay.deliver('host', 'Ann', await versionReplyFrame(room, ann.id, 'host', 5, 0));
    await settle();
    expect(ann.session.mismatch).toBeNull();
    const newer = await versionReplyFrame(room, ann.id, 'host', 5, 1000, 'Team');
    room.relay.deliver('host', 'Ann', newer);
    await waitFor(() => ann.session.mismatch === 'askFacilitator');
    await host.local({ type: 'addTopic', text: 'Clears it' });
    await runUntil(scheduler, () => ann.session.mismatch === null);
    room.relay.deliver('host', 'Ann', newer);
    await settle();
    expect(ann.session.mismatch).toBeNull();
    expect(ann.session.connection).toBe('connected');
    ann.session.stopHeartbeat();
    host.stop();
  });
});
