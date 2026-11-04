import { describe, expect, it } from 'vitest';
import { encodeWire, sealEnvelope } from '../protocol/envelope';
import { FakeScheduler } from '../test/fake-scheduler';
import { TestRoom } from '../test/sessions';
import { HEAVY_SETTLE_MS, settle } from '../test/settle';

async function run(scheduler: FakeScheduler, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 500) {
    scheduler.advance(500);
    await settle(HEAVY_SETTLE_MS);
  }
}

// A backup restored in another browser makes a second page that signs with the same host key. Each page notices the
// other's views and bundles (docs/product/sync-protocol.md, Two facilitator pages).
describe('a second page hosting the same meeting', () => {
  it('is noticed by both pages, and forgotten once it has been silent for a while', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const first = room.host('first', { scheduler, epoch: 1 });
    await run(scheduler, 6000);
    expect(first.otherBrowser).toBe(false);
    const second = room.host('second', { scheduler, epoch: 2 });
    await run(scheduler, 12_000);
    expect(first.otherBrowser).toBe(true);
    expect(second.otherBrowser).toBe(true);
    second.stop();
    await run(scheduler, 100_000);
    expect(first.otherBrowser).toBe(false);
    first.stop();
  }, 60_000);

  it('ignores a replayed snapshot of an earlier page load, but counts one that keeps coming', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('later', { scheduler, epoch: 5 });
    room.relay.join('previous-load');
    await run(scheduler, 2000);
    const old = async () => encodeWire(room.roomKey, await sealEnvelope(room.hostSigner, { t: 'snapshot', epoch: 3, seq: 9, host: 'previous-load' }));
    // A relay replays what it kept in one burst.
    for (let i = 0; i < 3; i++) room.relay.deliver('previous-load', 'later', await old());
    await run(scheduler, 2000);
    expect(host.otherBrowser).toBe(false);
    // The same host ID heard again 5 s on is live.
    await run(scheduler, 4000);
    room.relay.deliver('previous-load', 'later', await old());
    await run(scheduler, 1000);
    expect(host.otherBrowser).toBe(true);
    host.stop();
  }, 60_000);

  it('is not seen by a host alone in its room', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    const host = room.host('host', { scheduler });
    await run(scheduler, 20_000);
    expect(host.otherBrowser).toBe(false);
    host.stop();
  }, 60_000);
});
