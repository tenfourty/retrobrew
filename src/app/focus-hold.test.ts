import { describe, expect, it, vi } from 'vitest';
import { createFocusHold, FOCUS_HOLD_MS } from './focus-hold';

describe('createFocusHold', () => {
  it('counts focus at once and blur only after the hold', () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const hold = createFocusHold((f) => seen.push(f));
    hold.focus();
    hold.blur();
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(FOCUS_HOLD_MS - 1);
    expect(seen).toEqual([true]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([true, false]);
    vi.useRealTimers();
  });
  it('keeps the focus when it comes back within the hold', () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const hold = createFocusHold((f) => seen.push(f));
    hold.focus();
    hold.blur();
    vi.advanceTimersByTime(100);
    hold.focus();
    vi.advanceTimersByTime(FOCUS_HOLD_MS * 2);
    expect(seen).toEqual([true, true]);
    vi.useRealTimers();
  });
  it('reset drops the focus at once and cancels a pending blur', () => {
    vi.useFakeTimers();
    const seen: boolean[] = [];
    const hold = createFocusHold((f) => seen.push(f));
    hold.focus();
    hold.blur();
    hold.reset();
    expect(seen).toEqual([true, false]);
    vi.advanceTimersByTime(FOCUS_HOLD_MS * 2);
    expect(seen).toEqual([true, false]);
    vi.useRealTimers();
  });
});
