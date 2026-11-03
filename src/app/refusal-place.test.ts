import { describe, expect, it } from 'vitest';
import { refusalPlace } from './refusal-place';

describe('refusalPlace', () => {
  it('keeps the place the refused command was sent from', () => {
    expect(refusalPlace('add', [1, 2])).toBe('add');
    expect(refusalPlace('card:2', [1, 2])).toBe('card:2');
    expect(refusalPlace('top', [])).toBe('top');
  });
  it('is the top when no place was recorded', () => {
    expect(refusalPlace(undefined, [1])).toBe('top');
  });
  it('is the top for a card that is gone from the board', () => {
    expect(refusalPlace('card:3', [1, 2])).toBe('top');
  });
});
