import { describe, expect, it } from 'vitest';
import { parseFeedbackHash } from './feedback-arrival';

describe('parseFeedbackHash', () => {
  it('reads #feedback with and without the page it came from', () => {
    expect(parseFeedbackHash('#feedback')).toEqual({ from: null });
    expect(parseFeedbackHash('#feedback=landing')).toEqual({ from: 'landing' });
    expect(parseFeedbackHash('#feedback=guide')).toEqual({ from: 'guide' });
  });

  it('leaves every other fragment alone', () => {
    for (const hash of ['', '#', '#start', '#start&rehearsal', '#b=abc&k=def&h=ghi', '#feedback=other', '#feedback=landing&b=x', '#feedback2', '#Feedback', '#x=feedback']) {
      expect(parseFeedbackHash(hash), hash).toBeNull();
    }
  });
});
