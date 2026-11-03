import { describe, expect, it } from 'vitest';
import { fingerprint, generateSigningKeys, signerFrom } from '../crypto/sign';
import { createBoard } from '../engine/board';
import { MESSAGES } from '../engine/messages';
import { encodeWire, sealEnvelope } from '../protocol/envelope';
import { PROTOCOL_VERSION } from '../protocol/version';
import { FakeScheduler } from '../test/fake-scheduler';
import { fresh } from '../test/hello';
import { BOARD, TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import type { HostSession } from './host';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

async function stepUntil(scheduler: FakeScheduler, condition: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t < maxMs && !condition(); t += 100) {
    scheduler.advance(100);
    await settle(HEAVY_SETTLE_MS);
  }
  expect(condition()).toBe(true);
}

// Everything the host knows or allows comes from the verified signer, never from a relay frame's `from`. Each test
// forges Ann's peer ID on a message signed by someone else and checks that Ann's state doesn't move. The forged hello
// and presence of protocol 1 are in version.test.ts and spoofing.test.ts, the forged ping and command records in
// peers.test.ts.
describe('nothing comes from a peer ID', () => {
  it('a forged hello that is refused doesn’t refuse Ann or slow her own hellos', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const state = createBoard({ boardId: BOARD, boardName: 'Team', ownerId: room.hostId, ownerName: 'Olu' });
    for (let i = 1; i < 59; i++) state.attendees[`guest-${i}`] = { id: `guest-${i}`, name: `Guest ${i}`, role: 'guest' };
    room.saved = { state, tabs: {} };
    const host = room.host('host', { scheduler });
    const mallory = await signerFrom(await generateSigningKeys(false));
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    await stepUntil(scheduler, () => joined(ann));
    // The meeting is now full (60): Mallory's hello, sent as if from Ann's peer, is refused.
    room.relay.deliver('Ann', 'host', await encodeWire(room.roomKey, await sealEnvelope(mallory,
      { t: 'hello', pv: PROTOCOL_VERSION, boardId: BOARD, name: 'Mallory', peer: 'Ann', ...fresh() }), 1));
    const refused = (host as unknown as { joinRefused: Map<string, unknown> }).joinRefused;
    const malloryId = await fingerprint(mallory.pub);
    await stepUntil(scheduler, () => refused.has(malloryId));
    expect(refused.has(ann.id)).toBe(false);
    for (let i = 0; i < 20; i++) { scheduler.advance(100); await settle(HEAVY_SETTLE_MS); }
    expect(ann.session.joinRefused).toBeNull();
    ann.session.rehello();
    await ann.session.send({ type: 'addTopic', text: 'Still in' });
    await stepUntil(scheduler, () => host.current.topics.length === 1);
    expect(ann.session.joinRefused).toBeNull();
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);

  it('a forged command on Ann’s tab is the forger’s, so Ann’s acks, order and presence are untouched', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host: HostSession = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    const mallory = await room.person('Mallory', { scheduler });
    ann.session.startHeartbeat();
    mallory.session.startHeartbeat();
    await stepUntil(scheduler, () => joined(ann) && joined(mallory));
    room.relay.deliver('Ann', 'host', await encodeWire(room.roomKey, await sealEnvelope(mallory.signer,
      { t: 'cmd', peer: 'Ann', boardId: BOARD, clientSeq: 1, sid: ann.session.sid, epoch: 1, cmd: { type: 'addTopic', text: 'Forged' } })));
    await stepUntil(scheduler, () => host.current.topics.length === 1);
    expect(host.current.topics[0].authorId).toBe(mallory.id);
    await ann.session.send({ type: 'addTopic', text: 'Ann’s first' });
    await stepUntil(scheduler, () => ann.session.state?.acks[ann.session.sid] === 1);
    expect(host.current.topics.map((t) => t.text)).toEqual(['Forged', 'Ann’s first']);
    // Neither record moved: Ann's is still Ann's, on her own peer, and Mallory has none on Ann's.
    expect(host.presence().filter((p) => p.peerId === 'Ann').map((p) => p.participantId)).toEqual([ann.id]);
    expect(ann.session.you).toBe(ann.id);
    ann.session.stopHeartbeat();
    mallory.session.stopHeartbeat();
    host.stop();
  }, 60_000);

  it('no facilitator authority comes from a peer ID: a guest’s command from the host’s peer is still a guest’s', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const mallory = await room.person('Mallory', { scheduler });
    mallory.session.startHeartbeat();
    await stepUntil(scheduler, () => joined(mallory));
    await host.local({ type: 'addTopic', text: 'Pairing' });
    // Mallory's key, on a frame that claims to come from the host's own peer.
    room.relay.deliver('host', 'host', await encodeWire(room.roomKey, await sealEnvelope(mallory.signer,
      { t: 'cmd', peer: 'host', boardId: BOARD, clientSeq: 1, sid: mallory.session.sid, epoch: 1, cmd: { type: 'startDiscussion' } })));
    await stepUntil(scheduler, () => mallory.session.state?.rejects[mallory.session.sid]?.key === 'facilitatorOnly');
    expect(mallory.rejects).toContain(MESSAGES.facilitatorOnly);
    expect(host.current.phase).toBe('topics');
    mallory.session.stopHeartbeat();
    host.stop();
  }, 60_000);
});
