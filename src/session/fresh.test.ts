import { describe, expect, it } from 'vitest';
import { FreshMemory } from './fresh';

const FRESH = 60_000;
const memory = (tabs = 5, members = 100, others = 100) => new FreshMemory(FRESH, tabs, members, others);

describe('FreshMemory', () => {
  it('accepts a count once, only if higher than the last, and only if `at` is fresh', () => {
    const m = memory();
    expect(m.accept('ann', 'tab', 1, 1000, 1000)).toBe(true);
    expect(m.accept('ann', 'tab', 1, 1000, 1000)).toBe(false);
    expect(m.accept('ann', 'tab', 0, 1000, 1000)).toBe(false);
    expect(m.accept('ann', 'tab', 2, 1000 - FRESH - 1, 1000)).toBe(false);
    expect(m.accept('ann', 'tab', 2, 1000 + FRESH + 1, 1000)).toBe(false);
    expect(m.accept('ann', 'tab', 2, 1000 + FRESH, 1000)).toBe(true);
    expect(m.accept('ann', 'other', 1, 1000, 1000)).toBe(true);
    expect(m.accept('bob', 'tab', 1, 1000, 1000)).toBe(true);
  });

  it('keeps a count exactly as long as a copy of the message could still be fresh, with no gap at the boundary', () => {
    const m = memory();
    m.accept('ann', 'tab', 5, 1000, 1000);
    m.sweep(1000 + FRESH);
    expect(m.size).toBe(1);
    // The last moment a copy is fresh by its `at`, it is still refused as a repeat.
    expect(m.accept('ann', 'tab', 5, 1000, 1000 + FRESH)).toBe(false);
    m.sweep(1000 + FRESH + 1);
    expect(m.size).toBe(0);
    expect(m.signers()).toEqual([]);
    expect(m.accept('ann', 'tab', 5, 1000, 1000 + FRESH + 1)).toBe(false); // refused by its `at` instead
  });

  it('never shortens an entry: a newer count with an earlier expiry leaves the older copy refused as long as it could be fresh', () => {
    const m = memory();
    // The page's first hellos use its own clock, 30 s ahead of the host; later ones use the host's time.
    expect(m.accept('ann', 'tab', 1, 1000 + 30_000, 1000)).toBe(true);
    expect(m.accept('ann', 'tab', 2, 1000, 1000)).toBe(true);
    const later = 1000 + 30_000 + FRESH; // the older copy is still fresh here; the newer entry alone would be gone
    m.sweep(later);
    expect(m.accept('ann', 'tab', 1, 1000 + 30_000, later)).toBe(false);
  });

  it('is bounded per signer and for attendees, and a flood of others never displaces an attendee', () => {
    const m = memory(3, 5, 4);
    for (let i = 0; i < 6; i++) m.accept('ann', `tab${i}`, 1, 1000, 1000);
    expect(m.tabs('ann')).toEqual(['tab3', 'tab4', 'tab5']);
    for (let i = 0; i < 50; i++) m.accept(`minted${i}`, 'tab', 1, 1000, 1000, false);
    expect(m.otherSize).toBe(4); // full: the rest were refused, none evicted
    expect(m.tabs('ann')).toEqual(['tab3', 'tab4', 'tab5']);
    expect(m.accept('ann', 'tab5', 1, 1000, 1000)).toBe(false);
    expect(m.accept('minted0', 'tab', 1, 1000, 1000, false)).toBe(false); // still remembered
    expect(m.accept('late', 'tab', 1, 1000, 1000, false)).toBe(false); // a genuine newcomer waits for entries to expire
    m.sweep(1000 + FRESH + 1);
    expect(m.accept('late', 'tab', 1, 1000 + FRESH + 1, 1000 + FRESH + 1, false)).toBe(true);
  });

  it('keeps the counts a signer made before it joined', () => {
    const m = memory();
    m.accept('ann', 'tab', 1, 1000, 1000, false);
    expect(m.accept('ann', 'tab', 1, 1000, 1000, true)).toBe(false);
    expect(m.accept('ann', 'tab', 2, 1000, 1000, true)).toBe(true);
    expect(m.otherSize).toBe(0);
    expect(m.accept('ann', 'tab', 1, 1000, 1000, true)).toBe(false);
  });
});
