import type { RateLimitProxy } from './rate-limit-proxy';
import type { TcpForward } from './tcp-forward';

export interface RunningRelay {
  proxy: RateLimitProxy;
  /** The podman relay's temporary config directory; absent for an external relay. */
  configDir?: string;
  /** The forward to an external relay; absent for the podman relay. */
  forward?: TcpForward;
}

// What global-setup.ts started, for global-teardown.ts to stop. Both run in Playwright's runner process,
// but each is loaded on its own, so this lives on globalThis rather than in module state.
const KEY = '__retrobrewE2ERelay';
const store = globalThis as unknown as Record<typeof KEY, RunningRelay | undefined>;

export function rememberRelay(relay: RunningRelay): void {
  store[KEY] = relay;
}

export function forgetRelay(): RunningRelay | undefined {
  const relay = store[KEY];
  store[KEY] = undefined;
  return relay;
}
