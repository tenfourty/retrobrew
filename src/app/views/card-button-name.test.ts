import { describe, expect, it } from 'vitest';
import { cardButtonName } from './TopicItem';

describe('cardButtonName', () => {
  it('starts with the visible word and carries the topic', () => {
    expect(cardButtonName('Vote for', 'Pairing rotation')).toBe('Vote for Pairing rotation');
    expect(cardButtonName('Remove vote from', '  Hiring plan ')).toBe('Remove vote from Hiring plan');
  });
  it('cuts a long topic at 60 characters', () => {
    const name = cardButtonName('Edit', 'x'.repeat(100));
    expect(name).toBe(`Edit ${'x'.repeat(60)}…`);
  });
});
