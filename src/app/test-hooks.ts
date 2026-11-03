import type { HostSignals, ParticipantSignals } from './banners';

// Browser tests force what is slow or impossible to reach on purpose: each banner's signal, and the hosting states.
// Only test builds (`vite build --mode e2e`) read the setting, from this tab's sessionStorage. The read sits inside
// `if (import.meta.env.MODE === 'e2e')`, a constant at build time, so any other build compiles it out and forced()
// returns nothing; `npm run check:assets` fails a build that still carries FORCE_KEY.
export interface Forced {
  participant?: Partial<ParticipantSignals>;
  host?: Partial<HostSignals>;
  hosting?: 'starting' | 'failed';
}

export const FORCE_KEY = 'rb-e2e-force';

export function parseForced(raw: string | null): Forced {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Forced) : {};
  } catch {
    return {};
  }
}

export function forced(): Forced {
  if (import.meta.env.MODE === 'e2e') {
    try {
      return parseForced(window.sessionStorage.getItem(FORCE_KEY));
    } catch {
      return {};
    }
  }
  return {};
}

// The error a forced failed start throws. It lives here, behind the mode check, so no other build carries its message.
export function forcedStartError(): Error | null {
  if (import.meta.env.MODE === 'e2e' && forced().hosting === 'failed') return new Error('A browser test stopped the meeting from starting');
  return null;
}
