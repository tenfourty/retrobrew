import { describe, expect, it } from 'vitest';
import { generateSigningKeys, signerFrom } from '../crypto/sign';
import { encodeWire, sealEnvelope } from '../protocol/envelope';
import { FakeScheduler } from '../test/fake-scheduler';
import { BOARD, TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';
import { VERSION_RECORDS_MAX, type HostSession } from './host';

const joined = (p: { session: { state: { attendees: Record<string, unknown> } | null }; id: string }) =>
  p.session.state?.attendees[p.id] !== undefined;

const recordCount = (host: HostSession): number => (host as unknown as { peers: Map<string, unknown> }).peers.size;

// Runs the fake clock in steps while the real event loop does the cryptography.
async function stepUntil(scheduler: FakeScheduler, condition: () => boolean, maxMs = 30_000): Promise<void> {
  for (let t = 0; t < maxMs && !condition(); t += 100) {
    scheduler.advance(100);
    await settle(HEAVY_SETTLE_MS);
  }
  expect(condition()).toBe(true);
}

// A relay frame's `from` is only a claim (docs/product/sync-protocol.md, Signed messages carry their context). The
// forged protocol 1 hello (and one-entry-per-peer presence) is covered in version.test.ts, the forged hello and
// command in peers.test.ts.
describe('a relay frame’s `from` is only a claim', () => {
  it('a ping signed by another attendee, claiming to be Ann’s peer, doesn’t take over Ann’s view', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    const mallory = await room.person('Mallory', { scheduler });
    ann.session.startHeartbeat();
    mallory.session.startHeartbeat();
    await stepUntil(scheduler, () => joined(ann) && joined(mallory));
    const ping = await encodeWire(room.roomKey, await sealEnvelope(mallory.signer, { t: 'ping', boardId: BOARD, sid: ann.session.sid, n: 1000, at: scheduler.now(), t0: 1, peer: 'Ann' }));
    room.relay.deliver('Ann', 'host', ping);
    await settle(HEAVY_SETTLE_MS);
    await host.local({ type: 'addTopic', text: 'For everyone' });
    await stepUntil(scheduler, () => ann.session.state?.topics.length === 1);
    expect(ann.session.you).toBe(ann.id);
    const annRecords = host.presence().filter((p) => p.peerId === 'Ann');
    expect(annRecords.map((p) => p.participantId)).toEqual([ann.id]);
    expect(annRecords[0].status).toBe('direct');
    ann.session.stopHeartbeat();
    mallory.session.stopHeartbeat();
    host.stop();
  });

  it('keeps the records of protocol 1 hellos from minted signers within a cap', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    ann.session.startHeartbeat();
    for (let i = 0; i < 100 && !joined(ann); i++) { scheduler.advance(100); await settle(HEAVY_SETTLE_MS); }
    expect(joined(ann)).toBe(true);
    const before = recordCount(host);
    for (let i = 0; i < VERSION_RECORDS_MAX * 3; i++) {
      const signer = await signerFrom(await generateSigningKeys(false));
      room.relay.join(`minted-${i}`); // a frame is delivered only from a peer on the network
      room.relay.deliver(`minted-${i}`, 'host', await encodeWire(room.roomKey, await sealEnvelope(signer, { t: 'hello', name: 'M', peer: `minted-${i}` }), 1));
      await settle(HEAVY_SETTLE_MS);
    }
    expect(recordCount(host) - before).toBeLessThanOrEqual(VERSION_RECORDS_MAX);
    // Ann's own record is never what makes room.
    expect(host.presence().find((p) => p.participantId === ann.id)).toBeDefined();
    ann.session.stopHeartbeat();
    host.stop();
  }, 60_000);
});
