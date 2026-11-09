import { describe, expect, it } from 'vitest';
import { dialReading, initialsOf, votesLeftText } from './components';

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

describe('initialsOf', () => {
  it('takes the first letter of up to two words, in capitals', () => {
    expect(initialsOf('Ana')).toBe('A');
    expect(initialsOf('ana maria')).toBe('AM');
    expect(initialsOf('Ana Maria Lopez')).toBe('AM');
  });
  it('skips words that start with a bracket or other punctuation', () => {
    expect(initialsOf('Fran (facilitator)')).toBe('F');
    expect(initialsOf('(Fran) Lopez')).toBe('L');
    expect(initialsOf('- Fran')).toBe('F');
  });
  it('keeps accented letters, non-Latin letters and digits', () => {
    expect(initialsOf('Élodie Çelik')).toBe('ÉÇ');
    expect(initialsOf('李 小龍')).toBe('李小');
    expect(initialsOf('R2 D2')).toBe('RD');
    expect(initialsOf('7 of 9')).toBe('7O');
  });
  it('falls back to a question mark when no word starts with a letter or digit', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('🙂')).toBe('?');
    expect(initialsOf('🙂 (!)')).toBe('?');
  });
  it('keeps one character when uppercasing would expand it, and skips marks and joined emoji', () => {
    expect(initialsOf('ß x')).toBe('SX');
    expect(initialsOf('é x')).toBe('ÉX');
    expect(initialsOf('\u0301a')).toBe('?');
    expect(initialsOf('👩‍💻 Ana')).toBe('A');
  });
  it('keeps a whole character when a word starts with an astral letter', () => {
    expect(initialsOf('𝒜da')).toBe('𝒜');
  });
});
