import { describe, expect, it } from 'vitest';
import { PerPersonSet } from './per-person';

describe('PerPersonSet', () => {
  it('drops a person’s own oldest entry first, so one person can never push out another’s', () => {
    const set = new PerPersonSet(3, 100);
    set.add('bob', 'b1');
    for (let i = 0; i < 50; i++) set.add('mallory', `m${i}`);
    expect(set.has('bob', 'b1')).toBe(true);
    expect(set.has('mallory', 'm49')).toBe(true);
    expect(set.has('mallory', 'm46')).toBe(false);
    expect(set.size).toBe(4);
  });

  it('is bounded in people too, the longest unused going first', () => {
    const set = new PerPersonSet(2, 3);
    for (const p of ['a', 'b', 'c', 'd']) set.add(p, 'x');
    expect(set.has('a', 'x')).toBe(false);
    expect(set.has('d', 'x')).toBe(true);
  });

  it('forgets an entry on delete', () => {
    const set = new PerPersonSet(2, 3);
    set.add('a', 'x');
    set.delete('a', 'x');
    expect(set.has('a', 'x')).toBe(false);
    expect(set.size).toBe(0);
  });
});
