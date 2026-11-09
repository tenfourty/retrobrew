import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_REGION_CLEAR_MS } from './announce';
import { createSpeaker, SPEAK_DELAY_MS } from './speaker';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function setup() {
  const region = { textContent: '' as string | null };
  const placed: unknown[] = [];
  const speaker = createSpeaker(() => region, (r) => { placed.push(r); });
  return { region, placed, speaker };
}

describe('the live region speaker', () => {
  it('speaks on the next tick, placing the region first', () => {
    const { region, placed, speaker } = setup();
    speaker.announce('Discussion started');
    expect(region.textContent).toBe('');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    expect(region.textContent).toBe('Discussion started');
    expect(placed).toEqual([region]);
  });

  it('reads announcements made together as one', () => {
    const { region, speaker } = setup();
    speaker.announce('Discussion started');
    speaker.announce('Now discussing #1: Hiring');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    expect(region.textContent).toBe('Discussion started Now discussing #1: Hiring');
  });

  it('empties the region 8 s after it spoke', () => {
    const { region, speaker } = setup();
    speaker.announce('The facilitator is back.');
    vi.advanceTimersByTime(SPEAK_DELAY_MS + LIVE_REGION_CLEAR_MS - 1);
    expect(region.textContent).toBe('The facilitator is back.');
    vi.advanceTimersByTime(1);
    expect(region.textContent).toBe('');
  });

  it('lets a second announcement at 7 s cancel the first emptying', () => {
    const { region, speaker } = setup();
    speaker.announce('first');
    vi.advanceTimersByTime(SPEAK_DELAY_MS + 7000);
    speaker.announce('second');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    expect(region.textContent).toBe('second');
    // The first emptying would have fallen at 8 s after the first speech, 1 s from here.
    vi.advanceTimersByTime(LIVE_REGION_CLEAR_MS - 1);
    expect(region.textContent).toBe('second');
    vi.advanceTimersByTime(1);
    expect(region.textContent).toBe('');
  });

  it('cancels the emptying and any speech not yet made when disposed', () => {
    const { region, speaker } = setup();
    speaker.announce('spoken');
    vi.advanceTimersByTime(SPEAK_DELAY_MS);
    speaker.dispose();
    region.textContent = 'untouched';
    vi.advanceTimersByTime(LIVE_REGION_CLEAR_MS * 2);
    expect(region.textContent).toBe('untouched');

    speaker.announce('never said');
    speaker.dispose();
    region.textContent = '';
    vi.advanceTimersByTime(SPEAK_DELAY_MS * 2);
    expect(region.textContent).toBe('');
  });
});
