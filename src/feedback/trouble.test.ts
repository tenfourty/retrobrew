import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_DELAY_MS, TroubleLatch } from './trouble';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('TroubleLatch', () => {
  it('starts calm', () => {
    expect(new TroubleLatch().current()).toBeNull();
  });

  it('raises start-up and save trouble at once, and clears them when the condition ends', () => {
    for (const source of ['startup', 'save'] as const) {
      const latch = new TroubleLatch();
      latch.set(source, true);
      expect(latch.current()).toEqual({ source, forSeconds: 0 });
      vi.advanceTimersByTime(12_400);
      expect(latch.current()).toEqual({ source, forSeconds: 12 });
      latch.set(source, false);
      expect(latch.current()).toBeNull();
    }
  });

  it('raises connection trouble only after the delay, and not at all if the connection comes back first', () => {
    const latch = new TroubleLatch();
    latch.set('connection', true, CONNECTION_DELAY_MS);
    vi.advanceTimersByTime(CONNECTION_DELAY_MS - 1);
    expect(latch.current()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(latch.current()).toEqual({ source: 'connection', forSeconds: 0 });
    latch.set('connection', false);
    expect(latch.current()).toBeNull();

    latch.set('connection', true, CONNECTION_DELAY_MS);
    vi.advanceTimersByTime(CONNECTION_DELAY_MS - 5000);
    latch.set('connection', false);
    vi.advanceTimersByTime(60_000);
    expect(latch.current()).toBeNull();
  });

  it('does not restart the delay when the same condition is reported again', () => {
    const latch = new TroubleLatch();
    latch.set('connection', true, CONNECTION_DELAY_MS);
    vi.advanceTimersByTime(20_000);
    latch.set('connection', true, CONNECTION_DELAY_MS);
    vi.advanceTimersByTime(10_000);
    expect(latch.current()).not.toBeNull();
    latch.set('connection', true, CONNECTION_DELAY_MS);
    vi.advanceTimersByTime(5000);
    expect(latch.current()).toEqual({ source: 'connection', forSeconds: 5 });
  });

  it('keeps an error until the page reloads or the person sends feedback', () => {
    const latch = new TroubleLatch();
    latch.raise('error');
    vi.advanceTimersByTime(3_600_000);
    expect(latch.current()).toEqual({ source: 'error', forSeconds: 3600 });
    latch.clear('error');
    expect(latch.current()).toBeNull();
  });

  it('reports the most specific source when several are on, and the next one when it ends', () => {
    const latch = new TroubleLatch();
    latch.raise('error');
    vi.advanceTimersByTime(10_000);
    latch.set('save', true);
    expect(latch.current()).toEqual({ source: 'save', forSeconds: 0 });
    latch.set('startup', true);
    expect(latch.current()?.source).toBe('startup');
    latch.set('startup', false);
    latch.set('save', false);
    expect(latch.current()).toEqual({ source: 'error', forSeconds: 10 });
  });

  it('caps forSeconds at a day', () => {
    const latch = new TroubleLatch();
    latch.raise('error');
    vi.advanceTimersByTime(3 * 86_400_000);
    expect(latch.current()?.forSeconds).toBe(86_400);
  });

  it('tells listeners when the trouble starts or ends, once each, and lets one go', () => {
    const latch = new TroubleLatch();
    const seen: Array<string | null> = [];
    const stop = latch.subscribe(() => seen.push(latch.current()?.source ?? null));
    latch.set('save', true);
    latch.set('save', true);
    latch.set('save', false);
    latch.set('save', false);
    expect(seen).toEqual(['save', null]);
    stop();
    latch.raise('error');
    expect(seen).toHaveLength(2);
  });

  it('cancels a pending delay on dispose', () => {
    const latch = new TroubleLatch();
    latch.set('connection', true, CONNECTION_DELAY_MS);
    latch.dispose();
    vi.advanceTimersByTime(CONNECTION_DELAY_MS * 2);
    expect(latch.current()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says whether one source is on now, and not while its delay is still running (has)', () => {
    const latch = new TroubleLatch();
    latch.set('connection', true, CONNECTION_DELAY_MS);
    expect(latch.has('connection')).toBe(false);
    vi.advanceTimersByTime(CONNECTION_DELAY_MS);
    expect(latch.has('connection')).toBe(true);
    expect(latch.has('error')).toBe(false);
    latch.clear('connection');
    expect(latch.has('connection')).toBe(false);
    latch.dispose();
  });
});
