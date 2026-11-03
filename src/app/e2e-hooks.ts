import type { RelayHealth } from '../transport/types';

export interface RelayHealthHook {
  __rbRelayHealth?: () => RelayHealth[];
}

// Browser battery builds only (`vite build --mode e2e`): lets a failing test print each relay's state as this page sees
// it (connected, refused, notices, dropped, held, given up), since no view shows it. Returns the clean-up for stop().
// Call it only inside `if (import.meta.env.MODE === 'e2e')`, so other builds drop it; `npm run check:assets` fails a
// build that still carries the hook's name.
export function exposeRelayHealth(mode: string | undefined, read: () => RelayHealth[], page: RelayHealthHook = globalThis as RelayHealthHook): () => void {
  if (mode !== 'e2e') return () => undefined;
  page.__rbRelayHealth = read;
  return () => {
    if (page.__rbRelayHealth === read) delete page.__rbRelayHealth;
  };
}
