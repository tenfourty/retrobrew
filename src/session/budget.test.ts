import { describe, expect, it } from 'vitest';
import { FakeScheduler } from '../test/fake-scheduler';
import { settle } from '../test/settle';
import { TokenBucket } from './budget';

describe('TokenBucket', () => {
  it('lets a burst through at once, then one event per refill, in order', async () => {
    const scheduler = new FakeScheduler(0);
    const bucket = new TokenBucket(scheduler, 4, 400);
    const sent: Array<[number, number]> = [];
    for (let i = 0; i < 10; i++) void bucket.take().then(() => sent.push([i, scheduler.now()]));
    await settle();
    expect(sent.map(([, at]) => at)).toEqual([0, 0, 0, 0]);
    for (let t = 0; t < 3000; t += 100) {
      scheduler.advance(100);
      await settle();
    }
    expect(sent.map(([i]) => i)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(sent.map(([, at]) => at)).toEqual([0, 0, 0, 0, 400, 800, 1200, 1600, 2000, 2400]);
  });

  it('does not hand back a token early after an idle stretch', async () => {
    const scheduler = new FakeScheduler(0);
    const bucket = new TokenBucket(scheduler, 2, 500);
    scheduler.advance(10_000);
    await bucket.take();
    await bucket.take();
    const at: number[] = [];
    void bucket.take().then(() => at.push(scheduler.now()));
    await settle();
    scheduler.advance(499);
    await settle();
    expect(at).toEqual([]);
    scheduler.advance(1);
    await settle();
    expect(at).toEqual([10_500]);
  });

  it('fills up again while idle, never beyond its capacity', async () => {
    const scheduler = new FakeScheduler(0);
    const bucket = new TokenBucket(scheduler, 2, 500);
    await bucket.take();
    await bucket.take();
    scheduler.advance(10_000);
    const at: number[] = [];
    for (let i = 0; i < 3; i++) void bucket.take().then(() => at.push(scheduler.now()));
    await settle();
    expect(at).toEqual([10_000, 10_000]);
  });
});
