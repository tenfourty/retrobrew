import { TIMEBOX_MINUTES } from '../engine/types';
import type { KeyValueStore } from './handoff';

// Per-device choices, kept in this browser for every meeting and never sent anywhere
// (docs/product/mvp-screens.md, Open choices made 2 and 6, and Timer sound).

function local(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const TIMEBOX_KEY = 'rb-timebox';
const EXTENSION_KEY = 'rb-extension';
const SOUND_KEY = 'rb-sound';

function readNumber(store: KeyValueStore | null, key: string, allowed: readonly number[], fallback: number): number {
  let stored: string | null | undefined;
  try {
    stored = store?.getItem(key);
  } catch {
    stored = null;
  }
  const value = Number(stored);
  return allowed.includes(value) ? value : fallback;
}

function write(store: KeyValueStore | null, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {
    // A full or blocked storage only loses the preference.
  }
}

// The last timebox this device used, starting at 5 minutes.
export function lastTimebox(store = local()): number {
  return readNumber(store, TIMEBOX_KEY, TIMEBOX_MINUTES, 5);
}
export function rememberTimebox(minutes: number, store = local()): void {
  write(store, TIMEBOX_KEY, String(minutes));
}

export const EXTENSIONS = [1, 2, 3, 4, 5] as const;

// The last extension this device used, starting at 3 minutes.
export function lastExtension(store = local()): number {
  return readNumber(store, EXTENSION_KEY, EXTENSIONS, 3);
}
export function rememberExtension(minutes: number, store = local()): void {
  write(store, EXTENSION_KEY, String(minutes));
}

// "Play the timer sound on this device": on by default for the facilitator, off for participants, until this device
// says otherwise.
export function soundOn(facilitator: boolean, store = local()): boolean {
  let stored: string | null | undefined;
  try {
    stored = store?.getItem(SOUND_KEY);
  } catch {
    stored = null;
  }
  if (stored === 'on') return true;
  if (stored === 'off') return false;
  return facilitator;
}
export function setSoundOn(on: boolean, store = local()): void {
  write(store, SOUND_KEY, on ? 'on' : 'off');
}
