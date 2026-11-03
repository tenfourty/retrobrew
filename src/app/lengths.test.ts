import { describe, expect, it } from 'vitest';
import { REAL_MINUTE_MS, REHEARSAL_MINUTE_MS } from '../engine/discussion';
import { TIMEBOX_MINUTES } from '../engine/types';
import { lengthLabel, lengthSentence, longDate, moreSentence, shortDate, timeboxLabel } from './lengths';

describe('timebox labels', () => {
  it('reads the nine timeboxes in minutes', () => {
    expect(TIMEBOX_MINUTES.map((m) => timeboxLabel(m, REAL_MINUTE_MS)))
      .toEqual(['1 min', '2 min', '3 min', '4 min', '5 min', '10 min', '15 min', '20 min', '30 min']);
  });

  it('reads them by their real length on a rehearsal board', () => {
    expect(TIMEBOX_MINUTES.map((m) => timeboxLabel(m, REHEARSAL_MINUTE_MS)))
      .toEqual(['10 s', '20 s', '30 s', '40 s', '50 s', '1 min 40 s', '2 min 30 s', '3 min 20 s', '5 min']);
  });

  it('rounds to whole seconds', () => {
    expect(lengthLabel(9_600)).toBe('10 s');
    expect(lengthLabel(0)).toBe('0 s');
  });
});

describe('sentences', () => {
  it('writes lengths in words', () => {
    expect(lengthSentence(60_000)).toBe('1 minute');
    expect(lengthSentence(180_000)).toBe('3 minutes');
    expect(lengthSentence(10_000)).toBe('10 seconds');
    expect(lengthSentence(1_000)).toBe('1 second');
    expect(lengthSentence(100_000)).toBe('1 minute and 40 seconds');
  });

  it('writes added time with "more"', () => {
    expect(moreSentence(60_000)).toBe('1 more minute');
    expect(moreSentence(180_000)).toBe('3 more minutes');
    expect(moreSentence(10_000)).toBe('10 more seconds');
    expect(moreSentence(30_000)).toBe('30 more seconds');
    expect(moreSentence(100_000)).toBe('1 minute and 40 more seconds');
  });
});

describe('dates', () => {
  it('writes short and long dates in local time', () => {
    const sixth = new Date(2026, 9, 6, 23, 30).getTime();
    expect(shortDate(sixth)).toBe('6 Oct 2026');
    expect(longDate(sixth)).toBe('6 October 2026');
    expect(shortDate(new Date(2026, 8, 30).getTime())).toBe('30 Sep 2026');
  });
});

describe('edges', () => {
  it('rounds to the nearest second across a minute', () => {
    expect(lengthLabel(59_500)).toBe('1 min');
    expect(lengthSentence(59_500)).toBe('1 minute');
  });

  it('reads negative and non-finite lengths as zero', () => {
    for (const bad of [-5_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(lengthLabel(bad)).toBe('0 s');
      expect(lengthSentence(bad)).toBe('0 seconds');
      expect(moreSentence(bad)).toBe('0 more seconds');
    }
  });

  it('writes rehearsal extensions of 1 to 5 minutes', () => {
    expect([1, 2, 3, 4, 5].map((m) => moreSentence(m * REHEARSAL_MINUTE_MS)))
      .toEqual(['10 more seconds', '20 more seconds', '30 more seconds', '40 more seconds', '50 more seconds']);
  });

  it('writes no date for an invalid time', () => {
    expect(shortDate(Number.NaN)).toBe('');
    expect(longDate(Number.NaN)).toBe('');
  });
});
