import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../test/mulberry32';
import { ClockSync, remainingMs, sampleFrom } from './clock';

describe('clock offset', () => {
  it('estimates offset from one round trip', () => {
    // Sent at local 1000, host stamped 6050, received at local 1100.
    expect(sampleFrom(1000, 6050, 1100)).toEqual({ offset: 5000, rtt: 100 });
  });

  it('is zero until the first sample', () => {
    const sync = new ClockSync();
    expect(sync.offset).toBe(0);
    expect(sync.hostNow(123)).toBe(123);
  });

  it('trusts the sample with the shortest round trip', () => {
    const sync = new ClockSync();
    sync.addSample(0, 5400, 800);     // rtt 800, offset 5000
    sync.addSample(1000, 6020, 1040); // rtt 40, offset 5000
    sync.addSample(2000, 7300, 2200); // rtt 200, offset 5200
    expect(sync.offset).toBe(5000);
    expect(sync.hostNow(10_000)).toBe(15_000);
  });

  it('keeps only the last 8 samples', () => {
    const sync = new ClockSync();
    sync.addSample(0, 100, 0); // rtt 0, offset 100: the best sample, soon evicted
    for (let i = 1; i <= 8; i++) sync.addSample(i * 1000, i * 1000 + 60, i * 1000 + 20); // offset 50, rtt 20
    expect(sync.offset).toBe(50);
  });
});

describe('remainingMs', () => {
  it('counts down to zero and never below', () => {
    expect(remainingMs(10_000, 4_000)).toBe(6_000);
    expect(remainingMs(10_000, 12_000)).toBe(0);
  });
});

describe('relay clock estimate', () => {
  it('uses the largest hostNow − receivedAt plus half the smallest echo', () => {
    const sync = new ClockSync();
    sync.addRelayView(10_300, 3_000); // lead 7300
    sync.addRelayView(10_900, 3_500); // lead 7400: the least delayed
    sync.addEcho(400);
    sync.addEcho(200);
    expect(sync.offsetAt(4_000)).toBe(7_400 + 100);
  });

  it('keeps only the last 8 bundles and the last 8 echoes', () => {
    const sync = new ClockSync();
    sync.addRelayView(99_000, 0); // a lead of 99 s, soon evicted
    sync.addEcho(0);
    for (let i = 1; i <= 8; i++) {
      sync.addRelayView(i * 1000 + 5000, i * 1000);
      sync.addEcho(100);
    }
    expect(sync.offsetAt(10_000)).toBe(5_050);
  });

  it('prefers the direct estimate while a pong is under 30 s old, then falls back to the relay', () => {
    const sync = new ClockSync();
    sync.addRelayView(8_000, 1_000);
    sync.addSample(1_000, 6_050, 1_100); // direct offset 5000, received at 1100
    expect(sync.offsetAt(31_100)).toBe(5_000);
    expect(sync.offsetAt(31_101)).toBe(7_000);
    expect(sync.offset).toBe(5_000);
  });

  it('is within 500 ms after four bundles and four echoes, with each relay event delayed 50–600 ms', () => {
    const random = mulberry32(20261006);
    const delay = () => 50 + random() * 550;
    const trueOffset = 7_000;
    const sync = new ClockSync();
    let local = 100_000;
    for (let i = 0; i < 4; i++) {
      const sentAtHost = local + trueOffset;
      sync.addRelayView(sentAtHost, local + delay());
      sync.addEcho(delay());
      local += 5_000;
    }
    expect(Math.abs(sync.offsetAt(local) - trueOffset)).toBeLessThan(500);
  });
});

describe('clock inputs that are not usable', () => {
  const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  it('ignores non-finite or backwards pongs', () => {
    const sync = new ClockSync();
    sync.addSample(1_000, 6_050, 1_100);
    const before = sync.offsetAt(1_100);
    for (const x of bad) {
      sync.addSample(x, 6_050, 1_100);
      sync.addSample(1_000, x, 1_100);
      sync.addSample(1_000, 6_050, x);
    }
    sync.addSample(2_000, 7_000, 1_900); // negative rtt
    expect(sync.offsetAt(1_100)).toBe(before);
    expect(Number.isFinite(sync.offset)).toBe(true);
  });

  it('ignores non-finite relay views', () => {
    const sync = new ClockSync();
    sync.addRelayView(8_000, 1_000);
    for (const x of bad) {
      sync.addRelayView(x, 1_000);
      sync.addRelayView(8_000, x);
    }
    expect(sync.offsetAt(2_000)).toBe(7_000);
  });

  it('ignores non-finite or negative echoes', () => {
    const sync = new ClockSync();
    sync.addRelayView(8_000, 1_000);
    sync.addEcho(200);
    for (const x of [...bad, -5]) sync.addEcho(x);
    expect(sync.offsetAt(2_000)).toBe(7_100);
  });

  it('does not let a garbage pong make the direct path fresh', () => {
    const sync = new ClockSync();
    sync.addRelayView(8_000, 1_000);
    sync.addSample(1_000, 6_050, 1_100);
    sync.addSample(Number.NaN, 1, 100_000);
    sync.addSample(5, 6, 100_000 - 200_000);
    expect(sync.offsetAt(31_101)).toBe(7_000);
  });
});

describe('reset', () => {
  it('forgets every reading, so a new host session starts from none', () => {
    const sync = new ClockSync();
    sync.addRelayView(10_000, 1_000);
    sync.addEcho(100);
    sync.addSample(1_000, 6_050, 1_100);
    expect(sync.hasEstimate).toBe(true);
    sync.reset();
    expect(sync.hasEstimate).toBe(false);
    expect(sync.offsetAt(5_000)).toBe(0);
  });
});
