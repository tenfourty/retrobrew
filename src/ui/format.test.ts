import { describe, expect, it } from 'vitest';
import { capAtCaret, capTopic, charactersLeftText, formatClock, overTopicLimit, topicLength } from './format';

describe('formatClock', () => {
  it('writes m:ss in both modes', () => {
    expect(formatClock(192)).toBe('3:12');
    expect(formatClock(1800)).toBe('30:00');
  });
  it('rounds to whole seconds and never goes below zero', () => {
    expect(formatClock(59.6)).toBe('1:00');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(-3)).toBe('0:00');
  });
});

describe('capTopic', () => {
  it('turns line breaks into spaces', () => {
    expect(capTopic(`one\ntwo\r\nthree${String.fromCharCode(0x2028)}four`)).toBe('one two three four');
  });
  it('stops at 280 code points, so an emoji counts as one', () => {
    expect(topicLength(capTopic('😀'.repeat(300)))).toBe(280);
    expect(capTopic('a'.repeat(279))).toHaveLength(279);
  });
});

describe('charactersLeftText', () => {
  it('is singular at one and never negative', () => {
    expect(charactersLeftText(240)).toBe('40 characters left');
    expect(charactersLeftText(279)).toBe('1 character left');
    expect(charactersLeftText(280)).toBe('0 characters left');
    expect(charactersLeftText(300)).toBe('0 characters left');
  });
});

describe('topics with surrogate pairs and line breaks', () => {
  it('counts code points, not UTF-16 units', () => {
    const mixed = 'a😀'.repeat(200);
    expect(mixed).toHaveLength(600);
    expect(topicLength(mixed)).toBe(400);
    expect(topicLength(capTopic(mixed))).toBe(280);
    expect(capTopic(mixed)).toBe('a😀'.repeat(140));
  });
  it('never splits a pair and counts a line break as one space', () => {
    expect(capTopic(`${'a'.repeat(279)}😀`)).toBe(`${'a'.repeat(279)}😀`);
    expect(capTopic(`${'a'.repeat(279)}😀😀`)).toBe(`${'a'.repeat(279)}😀`);
    expect(capTopic('a\nb')).toBe('a b');
  });
});

describe('capAtCaret', () => {
  const full = 'x'.repeat(280);
  it('keeps the existing tail when typing into the middle of a full field', () => {
    const next = `${'x'.repeat(100)}Y${'x'.repeat(180)}`;
    expect(capAtCaret(full, next, 101)).toEqual({ text: full, caret: 100 });
  });
  it('cuts only the overflow of a paste, and puts the caret after what stayed', () => {
    const previous = 'x'.repeat(270);
    const next = `abc${'P'.repeat(30)}${'x'.repeat(267)}`;
    const result = capAtCaret(previous, next, 33);
    expect(topicLength(result.text)).toBe(280);
    expect(result.text.endsWith('x'.repeat(267))).toBe(true);
    expect(result.caret).toBe(13);
  });
  it('leaves a short edit alone', () => {
    expect(capAtCaret('ab', 'a😀b', 3)).toEqual({ text: 'a😀b', caret: 3 });
  });
});

describe('overTopicLimit', () => {
  it('is true only when typed or pasted text is longer than a topic can be', () => {
    expect(overTopicLimit('a'.repeat(280))).toBe(false);
    expect(overTopicLimit('a'.repeat(281))).toBe(true);
  });
  it('counts code points, and a line break as one space', () => {
    expect(overTopicLimit('😀'.repeat(280))).toBe(false);
    expect(overTopicLimit(`${'a'.repeat(278)}\r\nb`)).toBe(false);
  });
});
