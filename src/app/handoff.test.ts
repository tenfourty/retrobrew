import { describe, expect, it } from 'vitest';
import { markJustCreated, takeJustCreated, type KeyValueStore } from './handoff';

function memory(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

describe('handoff from the create form to the host view', () => {
  it('opens the share step once per created meeting', () => {
    const store = memory();
    markJustCreated('board-a', store);
    expect(takeJustCreated('board-b', store)).toBe(false);
    expect(takeJustCreated('board-a', store)).toBe(true);
    expect(takeJustCreated('board-a', store)).toBe(false);
  });

  it('does nothing without storage', () => {
    markJustCreated('board-a', null);
    expect(takeJustCreated('board-a', null)).toBe(false);
  });
});
