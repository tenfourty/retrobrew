import { describe, expect, it } from 'vitest';
import { timeUpWaiting, viewWhileHostAway } from './host-away';

describe('viewWhileHostAway', () => {
  it('keeps only the guest in the head count', () => {
    const view = { online: ['host', 'me', 'ann'], other: 1 };
    expect(viewWhileHostAway(view, 'me')).toEqual({ online: ['me'], other: 1 });
  });
  it('does not mutate the view and counts nobody for a guest not listed', () => {
    const view = { online: ['host', 'ann'] };
    expect(viewWhileHostAway(view, 'me').online).toEqual([]);
    expect(view.online).toEqual(['host', 'ann']);
  });
});

describe('timeUpWaiting', () => {
  const timer = { startedAt: 0, endsAt: 1, minuteMs: 60_000, round: 1 } as never;
  it('is true only with the host away, a timer, no open vote and no time left', () => {
    expect(timeUpWaiting(true, { timer, vote: null }, 0)).toBe(true);
    expect(timeUpWaiting(true, { timer, vote: null }, -2)).toBe(true);
    expect(timeUpWaiting(true, { timer, vote: null }, 3)).toBe(false);
    expect(timeUpWaiting(false, { timer, vote: null }, 0)).toBe(false);
    expect(timeUpWaiting(true, { timer: null, vote: null }, null)).toBe(false);
    expect(timeUpWaiting(true, { timer, vote: {} as never }, 0)).toBe(false);
  });
});
