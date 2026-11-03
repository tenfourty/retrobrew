import { describe, expect, it } from 'vitest';
import { dialReading, votesLeftText } from './components';

describe('votesLeftText', () => {
  it('reads "{n} votes left", "1 vote left" and "No votes left"', () => {
    expect(votesLeftText(3)).toBe('3 votes left');
    expect(votesLeftText(2)).toBe('2 votes left');
    expect(votesLeftText(1)).toBe('1 vote left');
    expect(votesLeftText(0)).toBe('No votes left');
  });
});

describe('dialReading', () => {
  it('reads 0:00 at zero until the vote opens, then Time’s up, as the status strip does', () => {
    expect(dialReading(192, false)).toBe('3:12');
    expect(dialReading(0, false)).toBe('0:00');
    expect(dialReading(-0.3, false)).toBe('0:00');
    expect(dialReading(0, true)).toBe("Time's up");
  });
});
