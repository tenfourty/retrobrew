import { SimplePool, useWebSocketImplementation } from 'nostr-tools/pool';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { utf8 } from '../crypto/bytes';
import { NostrRelayTransport } from './nostr-relay';

// The real nostr-tools pool over a WebSocket whose handshake takes a set time, to count the sockets a slow connection
// leaves open. The pool's own connection timeout, reconnects and close handling are what is under test, so a fake pool
// cannot stand in.
const sockets: SlowSocket[] = [];
let handshakeMs = 1500;

class SlowSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = SlowSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  private opener: ReturnType<typeof setTimeout>;

  constructor(readonly url: string) {
    sockets.push(this);
    this.opener = setTimeout(() => {
      if (this.readyState !== SlowSocket.CONNECTING) return;
      this.readyState = SlowSocket.OPEN;
      this.onopen?.();
    }, handshakeMs);
  }

  send(): void { /* a relay that says nothing */ }

  close(): void {
    clearTimeout(this.opener);
    this.readyState = SlowSocket.CLOSED;
    queueMicrotask(() => this.onclose?.());
  }
}

const openSockets = () => sockets.filter((s) => s.readyState !== SlowSocket.CLOSED).length;

describe('NostrRelayTransport over the real pool and a slow handshake', () => {
  const made: NostrRelayTransport[] = [];
  afterEach(() => {
    for (const t of made.splice(0)) t.leave();
    sockets.length = 0;
    vi.useRealTimers();
  });

  for (const slow of [800, 1500, 2500]) {
    it(`leaves exactly one socket open for a relay whose handshake takes ${slow} ms, and none after leave()`, async () => {
      vi.useFakeTimers();
      handshakeMs = slow;
      useWebSocketImplementation(SlowSocket);
      const pool = new SimplePool({ enablePing: false, enableReconnect: true });
      const t = new NostrRelayTransport({ relays: ['wss://slow.example'], topic: 'topic', selfId: 'me', heartbeatMs: 5000, pool, now: () => Date.now() });
      made.push(t);
      t.broadcast(utf8('hello')); // held or sent while the handshake runs
      for (let elapsed = 0; elapsed < 40_000; elapsed += 250) await vi.advanceTimersByTimeAsync(250);
      expect(t.relayHealth()[0]!.connected).toBe(true);
      expect(sockets).toHaveLength(1); // no second attempt was made
      expect(openSockets()).toBe(1);
      t.leave();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(openSockets()).toBe(0);
    });
  }
});

describe('NostrRelayTransport over the real pool: resume while the new handshake is slow', () => {
  afterEach(() => {
    sockets.length = 0;
    vi.useRealTimers();
  });

  it('opens one new socket for a relay it had seen up, closes none still connecting, and leaves none orphaned', async () => {
    vi.useFakeTimers();
    handshakeMs = 1500;
    useWebSocketImplementation(SlowSocket);
    const pool = new SimplePool({ enablePing: false, enableReconnect: true });
    const t = new NostrRelayTransport({ relays: ['wss://slow.example'], topic: 'topic', selfId: 'me', heartbeatMs: 5000, pool, now: () => Date.now() });
    try {
      for (let elapsed = 0; elapsed < 5000; elapsed += 250) await vi.advanceTimersByTimeAsync(250);
      t.broadcast(utf8('while up')); // seen up
      expect(sockets).toHaveLength(1);
      t.resume(); // after a lock: the old socket is closed and a new one starts its slow handshake
      t.broadcast(utf8('hello')); // held while it connects
      for (let elapsed = 0; elapsed < 40_000; elapsed += 250) await vi.advanceTimersByTimeAsync(250);
      expect(t.relayHealth()[0]!.connected).toBe(true);
      expect(sockets).toHaveLength(2);
      expect(openSockets()).toBe(1);
    } finally {
      t.leave();
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openSockets()).toBe(0);
  });
});
