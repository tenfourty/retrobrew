import { describe, expect, it } from 'vitest';
import type { RelayHealth } from '../transport/types';
import { exposeRelayHealth, type RelayHealthHook } from './e2e-hooks';

const health: RelayHealth[] = [{ url: 'ws://127.0.0.1:17777', connected: true, refused: 0, notices: 0, dropped: 0, held: 2, givenUp: false }];

describe('exposeRelayHealth', () => {
  it('lets the browser battery read every relay’s state from an e2e build, until the session stops', () => {
    const page: RelayHealthHook = {};
    const stop = exposeRelayHealth('e2e', () => health, page);
    expect(page.__rbRelayHealth?.()).toEqual(health);
    stop();
    expect(page.__rbRelayHealth).toBeUndefined();
  });

  it('exposes nothing in any other build', () => {
    const page: RelayHealthHook = {};
    exposeRelayHealth('production', () => health, page);
    exposeRelayHealth(undefined, () => health, page);
    expect(page).toEqual({});
  });

  it('leaves a newer session’s hook in place when an older one stops', () => {
    const page: RelayHealthHook = {};
    const stopOld = exposeRelayHealth('e2e', () => [], page);
    exposeRelayHealth('e2e', () => health, page);
    stopOld();
    expect(page.__rbRelayHealth?.()).toEqual(health);
  });
});
