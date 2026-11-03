import { describe, expect, it } from 'vitest';
import { exposeDirectPeers, type DirectPeersHook } from './e2e-direct-peers';

describe('exposeDirectPeers', () => {
  it('exposes the reader until stopped, and a stop leaves a newer reader in place', () => {
    const page: DirectPeersHook = {};
    const stopFirst = exposeDirectPeers(() => ['a'], page);
    expect(page.__rbDirectPeers?.()).toEqual(['a']);
    const stopSecond = exposeDirectPeers(() => ['b'], page);
    stopFirst();
    expect(page.__rbDirectPeers?.()).toEqual(['b']);
    stopSecond();
    expect(page.__rbDirectPeers).toBeUndefined();
  });
});
