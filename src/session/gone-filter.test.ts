import { describe, expect, it } from 'vitest';
import { newSid } from '../protocol/sid';
import { GoneFilter, MAX_PEOPLE } from './gone-filter';

describe('GoneFilter', () => {
  it('never forgets a sid it was given, for that person only, with few false positives', () => {
    const filter = new GoneFilter();
    const added = Array.from({ length: 500 }, (_, i) => newSid(1_760_000_000_000 + i));
    for (const sid of added) filter.add('ann', sid);
    for (const sid of added) expect(filter.has('ann', sid)).toBe(true);
    const fresh = Array.from({ length: 2000 }, (_, i) => newSid(1_770_000_000_000 + i));
    expect(fresh.filter((sid) => filter.has('ann', sid)).length).toBeLessThan(40);
    expect(added.filter((sid) => filter.has('bob', sid))).toHaveLength(0);
  });

  it('keeps memory bounded past MAX_PEOPLE people without failing open', () => {
    const filter = new GoneFilter();
    const sid = newSid(1_760_000_000_000);
    for (let i = 0; i < MAX_PEOPLE + 50; i++) filter.add(`p${i}`, sid);
    expect(filter.size).toBe(MAX_PEOPLE);
    for (let i = 0; i < MAX_PEOPLE + 50; i++) expect(filter.has(`p${i}`, sid)).toBe(true);
  });
});
