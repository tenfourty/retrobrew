import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from './handoff';
import { lastTimebox, rememberTimebox } from './prefs';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value; },
    removeItem: (key) => { delete data[key]; },
  };
}

// docs/product/mvp-screens.md, the timebox picker: the last timebox this device used is preselected, starting at 5 minutes.
describe('the last timebox', () => {
  it('starts at 5 minutes on a device that has not started a timer', () => {
    expect(lastTimebox(memoryStore())).toBe(5);
  });

  it('is the last one this device started, and is kept in the device’s own storage', () => {
    const store = memoryStore();
    rememberTimebox(20, store);
    expect(lastTimebox(store)).toBe(20);
    rememberTimebox(1, store);
    expect(lastTimebox(store)).toBe(1);
    expect(store.data).toEqual({ 'rb-timebox': '1' });
  });

  it('falls back to 5 minutes for a stored length that is not one of the timeboxes', () => {
    expect(lastTimebox(memoryStore({ 'rb-timebox': '7' }))).toBe(5);
    expect(lastTimebox(memoryStore({ 'rb-timebox': 'soon' }))).toBe(5);
  });

  it('is 5 minutes when storage is blocked, and remembering then loses only the preference', () => {
    const blocked: KeyValueStore = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(lastTimebox(blocked)).toBe(5);
    expect(() => rememberTimebox(10, blocked)).not.toThrow();
  });
});
