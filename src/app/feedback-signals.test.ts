import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TroubleLatch } from '../feedback/trouble';
import { applyConnection } from './feedback-signals';

describe('applyConnection', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('raises a lost network only after the delay, and not if it comes back first', () => {
    const latch = new TroubleLatch();
    applyConnection(latch, false, true, 30_000);
    vi.advanceTimersByTime(29_999);
    expect(latch.has('connection')).toBe(false);
    applyConnection(latch, false, false, 30_000);
    vi.advanceTimersByTime(5_000);
    expect(latch.has('connection')).toBe(false);
    applyConnection(latch, false, true, 30_000);
    vi.advanceTimersByTime(30_000);
    expect(latch.has('connection')).toBe(true);
  });

  it('raises at once for the connecting stage, even while a delay is pending', () => {
    const latch = new TroubleLatch();
    applyConnection(latch, false, true, 30_000);
    applyConnection(latch, true, true, 30_000);
    expect(latch.has('connection')).toBe(true);
    applyConnection(latch, false, false, 30_000);
    expect(latch.has('connection')).toBe(false);
  });
});
