import { describe, expect, it } from 'vitest';
import { FakeScheduler } from '../test/fake-scheduler';
import { mulberry32 } from '../test/mulberry32';
import { every, MonotonicClock } from './scheduler';

describe('FakeScheduler', () => {
  it('runs due timers in time order as the clock advances, and not before', () => {
    const s = new FakeScheduler(0);
    const ran: string[] = [];
    s.setTimeout(() => ran.push(`b@${s.now()}`), 200);
    s.setTimeout(() => ran.push(`a@${s.now()}`), 100);
    const c = s.setTimeout(() => ran.push('c'), 150);
    s.clearTimeout(c);
    s.advance(99);
    expect(ran).toEqual([]);
    s.advance(200);
    expect(ran).toEqual(['a@100', 'b@200']);
    expect(s.now()).toBe(299);
    expect(s.pending()).toBe(0);
  });

  it('runs timers that a timer schedules within the same advance', () => {
    const s = new FakeScheduler(0);
    const ran: number[] = [];
    s.setTimeout(() => { ran.push(s.now()); s.setTimeout(() => ran.push(s.now()), 50); }, 50);
    s.advance(100);
    expect(ran).toEqual([50, 100]);
  });

  it('repeats with every() until cancelled', () => {
    const s = new FakeScheduler(0);
    let n = 0;
    const stop = every(s, 5000, () => { n += 1; });
    s.advance(15_000);
    expect(n).toBe(3);
    stop();
    s.advance(15_000);
    expect(n).toBe(3);
  });
});

describe('MonotonicClock', () => {
  it('follows the clock and never goes back, even when the system clock steps back', () => {
    let t = 10_000;
    const clock = new MonotonicClock(() => t);
    expect(clock.next()).toBe(10_000);
    expect(clock.next()).toBe(10_001);
    t = 5_000;
    expect(clock.next()).toBe(10_002);
    t = 20_000;
    expect(clock.next()).toBe(20_000);
  });
});

describe('mulberry32', () => {
  it('is deterministic for a seed and stays in [0, 1)', () => {
    const a = mulberry32(20261006);
    const b = mulberry32(20261006);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});
