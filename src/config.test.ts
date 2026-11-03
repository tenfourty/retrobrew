import { describe, expect, it } from 'vitest';
import { DEFAULT_RELAYS, PUBLIC_RELAYS, relaysFor } from './config';

describe('relays', () => {
  it('uses the public relays when VITE_RELAYS is unset', () => {
    expect(DEFAULT_RELAYS).toEqual([
      'wss://relay.primal.net',
      'wss://nostr.mom',
      'wss://relay.snort.social',
      'wss://relay.nostr.net',
    ]);
    expect(relaysFor({ MODE: 'e2e' })).toBe(PUBLIC_RELAYS);
    expect(relaysFor({ MODE: 'e2e', VITE_RELAYS: '' })).toBe(PUBLIC_RELAYS);
    expect(relaysFor({ MODE: 'e2e', VITE_RELAYS: ' , ' })).toBe(PUBLIC_RELAYS);
    expect(relaysFor(undefined)).toBe(PUBLIC_RELAYS);
  });

  it('ignores VITE_RELAYS outside the e2e mode', () => {
    expect(relaysFor({ MODE: 'production', VITE_RELAYS: 'ws://127.0.0.1:17777' })).toBe(PUBLIC_RELAYS);
    expect(relaysFor({ MODE: 'development', VITE_RELAYS: 'ws://127.0.0.1:17777' })).toBe(PUBLIC_RELAYS);
    expect(relaysFor({ VITE_RELAYS: 'ws://127.0.0.1:17777' })).toBe(PUBLIC_RELAYS);
  });

  it('reads a comma-separated list in the e2e mode', () => {
    expect(relaysFor({ MODE: 'e2e', VITE_RELAYS: 'ws://127.0.0.1:17777' })).toEqual(['ws://127.0.0.1:17777']);
    expect(relaysFor({ MODE: 'e2e', VITE_RELAYS: ' ws://127.0.0.1:17777 , wss://relay.example/ ,' }))
      .toEqual(['ws://127.0.0.1:17777', 'wss://relay.example/']);
  });

  it('refuses entries that are not WebSocket URLs', () => {
    expect(() => relaysFor({ MODE: 'e2e', VITE_RELAYS: 'ws://127.0.0.1:17777,127.0.0.1:17778' }))
      .toThrow('VITE_RELAYS entries must be ws:// or wss:// URLs: 127.0.0.1:17778');
    expect(() => relaysFor({ MODE: 'e2e', VITE_RELAYS: 'https://relay.example' })).toThrow('https://relay.example');
  });
});
