import { describe, expect, it } from 'vitest';
import { isSid, newSid, sidCreatedAt } from './sid';

describe('tab IDs', () => {
  it('embed their creation time in base 36, then 9 random bytes', () => {
    const sid = newSid(1_760_000_000_000);
    expect(sid).toMatch(/^[0-9a-z]+\.[A-Za-z0-9_-]{12}$/);
    expect(sid.split('.')[0]).toBe((1_760_000_000_000).toString(36));
    expect(sidCreatedAt(sid)).toBe(1_760_000_000_000);
    expect(newSid(1)).not.toBe(newSid(1));
  });

  it('reject anything else', () => {
    for (const bad of ['', 'abc', 'mg3k1x2a.', 'mg3k1x2a.short', 'MG3K.Q2x1Y2tlZEJy', 'mg3k1x2a.Q2x1Y2tlZEJy.x', 42, null]) {
      expect(isSid(bad)).toBe(false);
    }
    expect(isSid('mg3k1x2a.Q2x1Y2tlZEJy')).toBe(true);
  });
});
