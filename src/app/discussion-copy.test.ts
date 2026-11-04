import { describe, expect, it } from 'vitest';
import { toDiscussEmpty } from './discussion-copy';

describe('toDiscussEmpty', () => {
  it('tells the facilitator they can go back to topics', () => {
    expect(toDiscussEmpty(true)).toBe('Every topic has been discussed. Add another, or go back to topics to collect more.');
  });
  it('does not tell a guest to do what only the facilitator can', () => {
    const text = toDiscussEmpty(false);
    expect(text).not.toMatch(/(or|^) go back to topics/i);
    expect(text).toBe('Every topic has been discussed. Add another, or ask the facilitator to go back to topics to collect more.');
  });
});
