import type { Event, Filter } from 'nostr-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromUtf8, utf8 } from '../crypto/bytes';
import { SimplePool } from 'nostr-tools';
import { GIVE_UP_AFTER_MS, HELD_EVENTS_MAX, NostrRelayTransport, RECONNECT_BACKOFF_MS, RELAY_CHECK_MS, RESUBSCRIBE_BACKOFF_MS, SEND_BURST, SEND_REFILL_MS, type RelayPool } from './nostr-relay';
import { MAX_FRAME_BYTES } from './relay-frame';

const A = 'wss://a.example';
const B = 'wss://b.example';

class FakePool implements RelayPool {
  onevent?: (event: Event) => void;
  readonly published: Event[] = [];
  readonly publishedTo: Array<{ relay: string; at: number }> = [];
  readonly publishedEvents: Event[] = [];
  readonly status = new Map<string, boolean>();
  readonly relays = new Map<string, { onnotice: (msg: string) => void }>();
  subscriptions = 0;
  closedSubscriptions = 0;
  publishResult: (url: string) => Promise<string> = () => Promise.resolve('');

  readonly onclose = new Map<string, () => void>(); // the latest subscription's close callback, by relay
  ensured: string[] = [];
  closedRelays = 0;
  closeCalls = 0; // every call to a subscription's close()
  readonly parsed: string[] = [];
  subscribe(relays: string[], _filter: Filter, params: { onevent(event: Event): void; onclose?(): void; alreadyHaveEvent?(id: string): boolean }): { close(): void } {
    this.subscriptions += 1;
    // Like the real pool, an event the transport already has is dropped before it is parsed.
    this.onevent = (event) => { if (!params.alreadyHaveEvent?.(event.id)) { this.parsed.push(event.id); params.onevent(event); } };
    this.onclose.set(relays[0], () => params.onclose?.());
    // Like the real pool, a subscription we close reports it a moment later.
    return { close: () => { this.closeCalls += 1; this.closedSubscriptions += 1; queueMicrotask(() => params.onclose?.()); } };
  }
  publish(relays: string[], event: Event): Promise<string>[] {
    this.published.push(event);
    for (const relay of relays) { this.publishedTo.push({ relay, at: Date.now() }); this.publishedEvents.push(event); }
    return relays.map((url) => this.publishResult(url));
  }
  listConnectionStatus(): Map<string, boolean> { return this.status; }
  // While set, a connection the transport asks for is not made until the test resolves it.
  ensureGate: Promise<void> | null = null;
  async ensureRelay(url: string): Promise<{ onnotice: (msg: string) => void }> {
    this.ensured.push(url);
    if (this.ensureGate) await this.ensureGate;
    let relay = this.relays.get(url);
    if (!relay) {
      relay = { onnotice: () => undefined };
      this.relays.set(url, relay);
    }
    return relay;
  }
  close(): void { this.closedRelays += 1; }
}

// The send budget's clock follows the (fake) system time unless a test steps it by hand.
let clock: () => number = () => Date.now();
const open: NostrRelayTransport[] = [];
function transport(pool: FakePool, heartbeatMs = 0): NostrRelayTransport {
  const t = new NostrRelayTransport({ relays: [A, B], topic: 'topic', selfId: 'me', heartbeatMs, pool, now: clock });
  open.push(t);
  return t;
}
afterEach(() => { clock = () => Date.now(); for (const t of open.splice(0)) t.leave(); });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('NostrRelayTransport', () => {
  it('sends no heartbeat frames when heartbeatMs is 0', () => {
    const pool = new FakePool();
    transport(pool);
    expect(pool.published).toEqual([]);
    transport(new FakePool(), 5000);
  });

  it('marks a relay ping with e: 1 and hands only that one back, as an echo', () => {
    const pool = new FakePool();
    const t = transport(pool);
    const got: Array<[string, string, boolean]> = [];
    t.onMessage((from, data, meta) => got.push([from, fromUtf8(data), meta?.echo === true]));
    t.send('host', utf8('ping'), { echo: true });
    t.send('host', utf8('cmd'));
    expect(JSON.parse(pool.published[0].content)).toMatchObject({ from: 'me', to: 'host', e: 1 });
    expect(JSON.parse(pool.published[1].content).e).toBeUndefined();
    for (const event of pool.published) pool.onevent!(event);
    expect(got).toEqual([['me', 'ping', true]]);
  });

  it('counts OK false and NOTICE replies per relay, and reports which sockets are open', async () => {
    const pool = new FakePool();
    pool.status.set('wss://a.example/', true);
    pool.publishResult = (url) => Promise.reject(url === A ? new Error('rate-limited: slow down') : new Error('publish timed out'));
    const t = transport(pool);
    t.broadcast(utf8('x'));
    t.broadcast(utf8('y'));
    await settle();
    (await pool.ensureRelay(B)).onnotice('too many subscriptions');
    expect(t.relayHealth()).toEqual([
      { url: A, connected: true, refused: 2, dropped: 0, notices: 0, held: 0, givenUp: false },
      { url: B, connected: false, refused: 0, dropped: 0, notices: 1, held: 0, givenUp: false },
    ]);
  });

  it('ignores an event whose content is over MAX_FRAME_BYTES, without parsing it', () => {
    const pool = new FakePool();
    const t = transport(pool);
    const got: string[] = [];
    t.onMessage((from) => got.push(from));
    const event = (content: string, id: string) => ({ id, content, kind: 1, tags: [], pubkey: '', created_at: 0, sig: '' }) as Event;
    pool.onevent!(event(JSON.stringify({ from: 'big', d: 'A'.repeat(MAX_FRAME_BYTES) }), '1'));
    pool.onevent!(event(JSON.stringify({ from: 'small', d: 'AAAA' }), '2'));
    expect(got).toEqual(['small']);
  });

  it('closes every relay connection on resume, then connects and subscribes again', () => {
    const pool = new FakePool();
    const t = transport(pool);
    t.resume();
    expect(pool.closedRelays).toBe(1);
    expect(pool.subscriptions).toBe(4); // one per relay, twice
    expect(pool.closedSubscriptions).toBe(2);
  });

  // vi's fake timers also fake Date.now, so the transport's timers and its clock move together.
  describe('reconnecting', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('subscribes again, with back-off, when a relay closes its subscription by itself', async () => {
      vi.useFakeTimers();
      const pool = new FakePool();
      transport(pool);
      pool.onclose.get(A)!();
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]);
      expect(pool.subscriptions).toBe(3);
      pool.onclose.get(A)!();
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]);
      expect(pool.subscriptions).toBe(3);
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[1] - RESUBSCRIBE_BACKOFF_MS[0]);
      expect(pool.subscriptions).toBe(4);
    });

    it('reconnects a relay that is down, backing off, and subscribes to it again once it is back', async () => {
      vi.useFakeTimers();
      const pool = new FakePool();
      transport(pool);
      pool.status.set('wss://a.example/', true);
      pool.ensured.length = 0;
      await vi.advanceTimersByTimeAsync(RELAY_CHECK_MS);
      expect(pool.ensured).toEqual([B]);
      await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS[0]);
      expect(pool.ensured).toEqual([B, B]);
      await vi.advanceTimersByTimeAsync(RELAY_CHECK_MS);
      expect(pool.ensured).toEqual([B, B]); // backing off: the next try is RECONNECT_BACKOFF_MS[1] after the last
      await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS[1] - RELAY_CHECK_MS);
      expect(pool.ensured).toEqual([B, B, B]);
      const before = pool.subscriptions;
      pool.status.set('wss://b.example/', true);
      await vi.advanceTimersByTimeAsync(RELAY_CHECK_MS);
      expect(pool.subscriptions).toBe(before + 1); // only B's subscription is replaced
      expect(pool.closedSubscriptions).toBe(1);
    });

    it('subscribes again to a relay that lost its subscription and was rebuilt between two checks', async () => {
      vi.useFakeTimers();
      const pool = new FakePool();
      transport(pool);
      pool.status.set('wss://a.example/', true);
      pool.status.set('wss://b.example/', true);
      await vi.advanceTimersByTimeAsync(RELAY_CHECK_MS);
      const before = pool.subscriptions;
      // B errors: the pool drops it and closes our subscription on it, but every relay's subscription has not
      // closed, so the pool never says so. A publish rebuilds B before the next check, so it is never seen down.
      pool.onclose.get(B)!();
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]);
      expect(pool.subscriptions).toBe(before + 1);
    });

    it('ignores a close it started itself, even when it is reported late, and after resume', async () => {
      vi.useFakeTimers();
      const pool = new FakePool();
      const t = transport(pool);
      pool.onclose.get(A)!(); // by itself: a retry is pending
      t.resume(); // starts afresh; the old subscriptions' late close reports must start no retry
      expect(pool.subscriptions).toBe(4);
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0] * 10);
      expect(pool.subscriptions).toBe(4);
    });

    it('does not close a subscription the pool already closed when it subscribes again', async () => {
      vi.useFakeTimers();
      const pool = new FakePool();
      transport(pool);
      pool.onclose.get(A)!(); // the pool closed A's subscription (a CLOSED on an open socket)
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]);
      expect(pool.subscriptions).toBe(3);
      expect(pool.closeCalls).toBe(0); // a second close would lower the live relay's operation count
    });

    it('lets the pool drop an event it already has, before it is parsed', () => {
      const pool = new FakePool();
      const t = transport(pool);
      const got: string[] = [];
      t.onMessage((from) => got.push(from));
      const event = { id: 'dup', content: JSON.stringify({ from: 'x', d: 'AAAA' }), kind: 1, tags: [], pubkey: '', created_at: 0, sig: '' } as Event;
      pool.onevent!(event);
      pool.onevent!(event);
      expect(pool.parsed).toEqual(['dup']);
      expect(got).toEqual(['x']);
    });

    it('stops every timer on leave: no retry, no reconnect', async () => {
      vi.useFakeTimers();
      const pool = new FakePool();
      const t = transport(pool);
      pool.onclose.get(A)!();
      t.leave();
      pool.ensured.length = 0;
      const subscriptions = pool.subscriptions;
      await vi.advanceTimersByTimeAsync(RECONNECT_BACKOFF_MS[3] * 4);
      expect(pool.subscriptions).toBe(subscriptions);
      expect(pool.ensured).toEqual([]);
    });

    it('starts the back-off over after a subscription that stayed up, and handles an event only once', async () => {
      vi.useFakeTimers();
      const pool = new FakePool();
      const t = transport(pool);
      const got: string[] = [];
      t.onMessage((from) => got.push(from));
      pool.onclose.get(A)!();
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]);
      const event = { id: '1', content: JSON.stringify({ from: 'x', d: 'AAAA' }), kind: 1, tags: [], pubkey: '', created_at: 0, sig: '' } as Event;
      pool.onevent!(event);
      pool.onevent!(event); // the same event again from the new subscription
      expect(got).toEqual(['x']);
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[RESUBSCRIBE_BACKOFF_MS.length - 1]);
      pool.onclose.get(A)!();
      await vi.advanceTimersByTimeAsync(RESUBSCRIBE_BACKOFF_MS[0]);
      expect(pool.subscriptions).toBe(4);
    });
  });
});

describe('NostrRelayTransport after leave', () => {
  it('opens nothing and publishes nothing on resume or send', () => {
    const pool = new FakePool();
    const t = transport(pool);
    t.leave();
    const subscriptions = pool.subscriptions;
    t.resume();
    t.send('host', utf8('x'));
    t.broadcast(utf8('y'));
    expect(pool.subscriptions).toBe(subscriptions);
    expect(pool.published).toEqual([]);
  });

});

describe('NostrRelayTransport send budget per relay (a late connection is not hit with a backlog)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const B_KEY = 'wss://b.example/';
  const payload = (event: Event) => Buffer.from((JSON.parse(event.content) as { d: string }).d, 'base64url').toString();
  // The events published to one relay, in order, with the time each went out.
  const sentTo = (pool: FakePool, relay: string) => pool.publishedTo.map((p, i) => ({ ...p, event: pool.publishedEvents[i] })).filter((p) => p.relay === relay);
  const countTo = (pool: FakePool, relay: string) => pool.publishedTo.filter((p) => p.relay === relay).length;
  const timersWhenIdle = () => vi.getTimerCount();

  it('holds events for a relay that is down and sends them, paced, once it is back; the other relay is unaffected', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set('wss://a.example/', true);
    pool.status.set(B_KEY, false);
    const t = transport(pool);
    for (let i = 0; i < 12; i++) t.send('host', utf8(`m${i}`));
    expect(countTo(pool, A)).toBe(SEND_BURST); // the connected relay is held to its burst too
    expect(countTo(pool, B)).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(countTo(pool, B)).toBe(0); // still down: nothing leaks
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(1000);
    // Back: at most a burst at once however long it waited, then no faster than one per refill.
    const times = sentTo(pool, B).map((p) => p.at);
    expect(times.filter((at) => at === times[0])).toHaveLength(SEND_BURST);
    vi.advanceTimersByTime(10_000);
    expect(countTo(pool, B)).toBe(12);
    expect(countTo(pool, A)).toBe(12);
  });

  it('never sends a relay more than the budget allows in any window', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const t = transport(pool);
    for (let i = 0; i < SEND_BURST + HELD_EVENTS_MAX; i++) t.broadcast(utf8(`m${i}`));
    vi.advanceTimersByTime(30_000);
    const times = sentTo(pool, A).map((p) => p.at);
    expect(times).toHaveLength(SEND_BURST + HELD_EVENTS_MAX);
    // The relay's real constraint: in any window of W ms, at most a burst plus one per refill.
    for (let i = 0; i < times.length; i++) {
      for (let j = i; j < times.length; j++) {
        const window = times[j] - times[i];
        expect(j - i + 1, `events from ${times[i]} to ${times[j]}`).toBeLessThanOrEqual(SEND_BURST + Math.floor(window / SEND_REFILL_MS));
      }
    }
  });

  it('keeps the newest events, in order, and counts what it drops', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set(B_KEY, false);
    pool.status.set('wss://a.example/', true);
    const t = transport(pool);
    const total = HELD_EVENTS_MAX + 10;
    for (let i = 0; i < total; i++) t.broadcast(utf8(`m${i}`));
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(60_000);
    expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(Array.from({ length: HELD_EVENTS_MAX }, (_, i) => `m${i + 10}`));
    expect(t.relayHealth().find((h) => h.url === B)!.dropped).toBe(10);
  });

  it('lets a newer event that supersedes a held one replace it, and keeps the rest in order', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set(B_KEY, false);
    const t = transport(pool);
    t.broadcast(utf8('bundle 1'), { kind: 'bundle', supersedes: ['bundle'] });
    t.send('host', utf8('command 1'));
    t.broadcast(utf8('bundle 2'), { kind: 'bundle', supersedes: ['bundle'] });
    t.send('host', utf8('command 2'));
    t.broadcast(utf8('bundle 3'), { kind: 'bundle', supersedes: ['bundle'] });
    expect(t.relayHealth().find((h) => h.url === B)!.held).toBe(3);
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(5000);
    // The newest bundle takes the place of the first it replaced; the commands keep their order.
    expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(['bundle 3', 'command 1', 'command 2']);
    expect(t.relayHealth().find((h) => h.url === B)!.dropped).toBe(0); // replaced, not dropped
  });

  it('signs a held event when it goes out, so it carries the time it was sent', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00Z'));
    const pool = new FakePool();
    pool.status.set(B_KEY, false);
    const t = transport(pool);
    t.broadcast(utf8('late'));
    vi.setSystemTime(new Date('2026-10-20T10:00:30Z'));
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(2000);
    const event = sentTo(pool, B)[0].event;
    expect(event.created_at).toBeGreaterThanOrEqual(Math.floor(Date.parse('2026-10-20T10:00:30Z') / 1000));
  });

  it('is not silenced by the clock stepping back', () => {
    vi.useFakeTimers();
    let now = 100_000;
    clock = () => now;
    const pool = new FakePool();
    const t = transport(pool);
    for (let i = 0; i < SEND_BURST; i++) t.broadcast(utf8(`a${i}`)); // the burst is spent
    now = 40_000; // a minute back
    t.broadcast(utf8('held'));
    expect(countTo(pool, A)).toBe(SEND_BURST);
    now += SEND_REFILL_MS * 2; // two refills after the step
    vi.advanceTimersByTime(2000); // the poll runs
    expect(countTo(pool, A)).toBe(SEND_BURST + 1);
  });

  it('asks a down relay to reconnect, closing the pool’s own entry first, and backs off like the 5 s check', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set(B_KEY, true);
    const t = transport(pool);
    t.broadcast(utf8('while up')); // the relay is seen up
    pool.status.set(B_KEY, false); // and drops: nostr-tools is reconnecting it on its own timer
    t.broadcast(utf8('x'));
    pool.ensured = [];
    pool.closedRelays = 0;
    vi.advanceTimersByTime(60_000);
    const attempts = pool.ensured.filter((u) => u === B).length;
    expect(attempts).toBeGreaterThanOrEqual(1);
    expect(attempts).toBeLessThanOrEqual(1 + RECONNECT_BACKOFF_MS.filter((ms, i) => RECONNECT_BACKOFF_MS.slice(0, i + 1).reduce((a, b) => a + b, 0) <= 60_000).length);
    expect(pool.closedRelays).toBeGreaterThanOrEqual(1); // the dropped entry was closed before connecting again
  });

  it('does not close a pool entry that is still connecting: it only asks for the connection', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set(B_KEY, false); // listed, never connected: the first attempt is in progress
    const t = transport(pool);
    t.broadcast(utf8('hello'));
    vi.advanceTimersByTime(2500); // inside the library's own 3 s timeout
    expect(pool.closedRelays).toBe(0);
    expect(pool.ensured).toContain(B);
  });

  it('does not reconnect a relay that is up while its events wait for budget', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set('wss://a.example/', true);
    const t = transport(pool);
    pool.ensured = [];
    for (let i = 0; i < SEND_BURST + 5; i++) t.broadcast(utf8(`m${i}`));
    vi.advanceTimersByTime(10_000);
    expect(pool.ensured).not.toContain(A);
  });

  it('stops its timer when nothing waits, and leave() clears what waits', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set(B_KEY, false);
    const t = transport(pool);
    const base = timersWhenIdle(); // the sweep and relay-check intervals
    for (let i = 0; i < 3; i++) t.broadcast(utf8(`m${i}`));
    expect(timersWhenIdle()).toBe(base + 1);
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(5000);
    expect(countTo(pool, B)).toBe(3);
    expect(timersWhenIdle()).toBe(base); // drained: no poll left
    pool.status.set(B_KEY, false);
    for (let i = 0; i < 3; i++) t.broadcast(utf8(`n${i}`));
    t.leave();
    expect(timersWhenIdle()).toBe(0);
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(10_000);
    expect(countTo(pool, B)).toBe(3); // the held ones never go out after leave
  });

  it('treats a relay that was up and has left the pool as down, so a backlog is not flushed on its reconnect', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set(B_KEY, true);
    const t = transport(pool);
    t.broadcast(utf8('while up'));
    pool.status.delete(B_KEY); // the pool dropped the closed socket
    for (let i = 0; i < 12; i++) t.broadcast(utf8(`m${i}`));
    expect(countTo(pool, B)).toBe(1);
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(1000);
    expect(sentTo(pool, B).filter((p) => p.at === sentTo(pool, B)[1].at)).toHaveLength(SEND_BURST);
  });

  it('keeps a held full refresh when a change bundle follows, and lets a full refresh replace both', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set(B_KEY, false);
    const t = transport(pool);
    const change = { kind: 'change', supersedes: ['change'] };
    const refresh = { kind: 'refresh', supersedes: ['change', 'refresh'] };
    t.broadcast(utf8('refresh 1'), refresh);
    t.broadcast(utf8('change 2'), change);
    t.broadcast(utf8('change 3'), change);
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(3000);
    expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(['refresh 1', 'change 3']);
    pool.status.set(B_KEY, false);
    t.broadcast(utf8('change 4'), change);
    t.broadcast(utf8('refresh 5'), refresh);
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(3000);
    expect(sentTo(pool, B).map((p) => payload(p.event)).slice(2)).toEqual(['refresh 5']);
  });

  it('sends a frame held into a later second signed again, and every relay that held it the same event', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00.900Z'));
    const pool = new FakePool();
    pool.status.set('wss://a.example/', true);
    pool.status.set(B_KEY, true);
    const t = transport(pool);
    for (let i = 0; i < SEND_BURST; i++) t.broadcast(utf8(`m${i}`)); // both relays' bursts are spent
    t.broadcast(utf8('held'));
    vi.advanceTimersByTime(SEND_REFILL_MS + 50); // into the next second
    const toA = sentTo(pool, A).find((p) => payload(p.event) === 'held')!;
    const toB = sentTo(pool, B).find((p) => payload(p.event) === 'held')!;
    // A subscription nostr-tools reconnected asks only for events after the newest it had, by the second.
    expect(toA.event.created_at).toBe(Math.floor(Date.parse('2026-10-20T10:00:01Z') / 1000));
    expect(toB.event.id).toBe(toA.event.id);
  });

  it('keeps the event it signed for a frame held within the same second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T10:00:00.100Z'));
    const pool = new FakePool();
    pool.status.set('wss://a.example/', true);
    const t = transport(pool);
    for (let i = 0; i < SEND_BURST; i++) t.broadcast(utf8(`m${i}`));
    t.broadcast(utf8('held'));
    vi.advanceTimersByTime(SEND_REFILL_MS + 50);
    const held = sentTo(pool, A).find((p) => payload(p.event) === 'held')!;
    expect(held.event.created_at).toBe(Math.floor(Date.parse('2026-10-20T10:00:00Z') / 1000));
  });

  it('wakes each relay on its own: a down relay does not delay an up relay waiting for budget', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set('wss://a.example/', true);
    pool.status.set(B_KEY, false);
    const t = transport(pool);
    // B's wake (1 s) is set first by an event that only B holds... then A runs out of budget.
    for (let i = 0; i < SEND_BURST + 1; i++) t.broadcast(utf8(`m${i}`));
    const sixth = SEND_BURST + 1;
    expect(countTo(pool, A)).toBe(SEND_BURST);
    vi.advanceTimersByTime(SEND_REFILL_MS + 20);
    expect(countTo(pool, A)).toBe(sixth); // not after B's second
  });

  it('gives up holding for a relay that has been down a long time: one warning, a bounded queue, and it resumes when the relay is back', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pool = new FakePool();
      pool.status.set(B_KEY, false);
      const t = transport(pool);
      t.broadcast(utf8('first'));
      vi.advanceTimersByTime(GIVE_UP_AFTER_MS + 1000);
      for (let i = 0; i < 100; i++) t.broadcast(utf8(`later${i}`));
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.filter((m) => m.includes('stopped holding'))).toHaveLength(1);
      expect(messages.filter((m) => m.includes('dropped held events') && m.includes(B))).toEqual([]);
      expect(t.relayHealth().find((h) => h.url === B)!.dropped).toBeGreaterThanOrEqual(100);
      expect(t.relayHealth().find((h) => h.url === B)).toMatchObject({ held: 0, givenUp: true });
      pool.status.set(B_KEY, true);
      vi.advanceTimersByTime(1000);
      expect(countTo(pool, B)).toBe(0); // nothing was kept for it
      t.broadcast(utf8('back'));
      expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(['back']);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores events that arrive after leave()', () => {
    const pool = new FakePool();
    const t = transport(pool);
    const got: string[] = [];
    t.onMessage((from) => got.push(from));
    t.leave();
    pool.onevent?.({ id: 'x'.repeat(64), pubkey: 'p', created_at: 1, kind: 20333, tags: [], content: JSON.stringify({ from: 'other', d: 'AA' }), sig: 's' } as Event);
    expect(got).toEqual([]);
  });
});

describe('NostrRelayTransport held events after a lock, and what it never holds', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const B_KEY = 'wss://b.example/';
  const payload = (event: Event) => Buffer.from((JSON.parse(event.content) as { d?: string }).d ?? '', 'base64url').toString();
  const sentTo = (pool: FakePool, relay: string) => pool.publishedTo.map((p, i) => ({ ...p, event: pool.publishedEvents[i] })).filter((p) => p.relay === relay);
  const health = (t: NostrRelayTransport) => t.relayHealth().find((h) => h.url === B)!;
  // B was up, then dropped: what is published for it now is held.
  function droppedB(pool: FakePool, t: NostrRelayTransport): void {
    pool.status.set(B_KEY, true);
    t.broadcast(utf8('while up'));
    pool.status.set(B_KEY, false);
  }

  it('holds for a relay again after resume, even one given up on while the page was locked', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pool = new FakePool();
    const t = transport(pool);
    droppedB(pool, t);
    t.broadcast(utf8('before the lock'));
    vi.advanceTimersByTime(GIVE_UP_AFTER_MS + 5000); // locked, no network
    t.broadcast(utf8('given up'));
    expect(health(t).givenUp).toBe(true);
    t.resume(); // unlocked: still connecting
    t.broadcast(utf8('hello'));
    expect(health(t)).toMatchObject({ held: 1, givenUp: false });
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(2000);
    expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(['while up', 'hello']);
  });

  it('holds again for a relay given up on once the socket check has seen it back', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pool = new FakePool();
    const t = transport(pool);
    droppedB(pool, t);
    t.broadcast(utf8('x'));
    vi.advanceTimersByTime(GIVE_UP_AFTER_MS + 5000);
    t.broadcast(utf8('given up'));
    pool.status.set(B_KEY, true); // back, with nothing published while it is
    vi.advanceTimersByTime(RELAY_CHECK_MS);
    pool.status.set(B_KEY, false); // and a short drop
    t.broadcast(utf8('during the drop'));
    expect(health(t)).toMatchObject({ held: 1, givenUp: false });
  });

  it('drops held events a resume makes stale, but keeps commands, so the fresh hello is not stuck behind them', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const t = transport(pool);
    droppedB(pool, t);
    t.send('host', utf8('command 1'), { lasting: true });
    for (let i = 0; i < 10; i++) t.broadcast(utf8(`stale ${i}`));
    t.broadcast(utf8('old hello'), { kind: 'hello', supersedes: ['hello'] });
    t.send('host', utf8('command 2'), { lasting: true });
    t.resume();
    t.broadcast(utf8('new hello'), { kind: 'hello', supersedes: ['hello'] });
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(3000);
    expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(['while up', 'command 1', 'command 2', 'new hello']);
  });

  it('when more wait than it holds, drops events that are not commands first', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pool = new FakePool();
    const t = transport(pool);
    droppedB(pool, t);
    for (let i = 0; i < HELD_EVENTS_MAX - 5; i++) t.send('host', utf8(`command ${i}`), { lasting: true });
    for (let i = 0; i < 10; i++) t.broadcast(utf8(`other ${i}`)); // the oldest 5 of these go, not the commands before them
    for (let i = HELD_EVENTS_MAX - 5; i < HELD_EVENTS_MAX; i++) t.send('host', utf8(`command ${i}`), { lasting: true });
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(30_000);
    expect(sentTo(pool, B).map((p) => payload(p.event)).slice(1)).toEqual(Array.from({ length: HELD_EVENTS_MAX }, (_, i) => `command ${i}`));
    expect(health(t).dropped).toBe(10);
  });

  it('lets a resent command replace its held copy in place, ahead of later commands', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const t = transport(pool);
    droppedB(pool, t);
    const cmd = (n: number) => ({ lasting: true, kind: `cmd ${n}`, supersedes: [`cmd ${n}`] });
    t.send('host', utf8('command 1'), cmd(1));
    t.send('host', utf8('command 2'), cmd(2));
    t.send('host', utf8('command 1 again'), cmd(1));
    expect(health(t).held).toBe(2);
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(3000);
    expect(sentTo(pool, B).map((p) => payload(p.event)).slice(1)).toEqual(['command 1 again', 'command 2']);
  });

  it('holds only the newest heartbeat', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set(B_KEY, true);
    const t = transport(pool, 1000);
    pool.status.set(B_KEY, false);
    vi.advanceTimersByTime(10_000);
    expect(health(t).held).toBe(1);
  });

  it('never holds a relay ping: it holds a plain copy instead, so presence still reaches the host and no echo times the wait', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set('wss://a.example/', true);
    const t = transport(pool);
    droppedB(pool, t);
    t.send('host', utf8('ping 1'), { echo: true });
    t.send('host', utf8('ping 2'), { echo: true });
    expect(health(t).held).toBe(1); // the newer ping's copy replaces the older
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(3000);
    const toB = sentTo(pool, B);
    expect(toB.map((p) => payload(p.event))).toEqual(['while up', 'ping 2']);
    expect(JSON.parse(toB[1].event.content)).toEqual({ from: 'me', to: 'host', d: expect.any(String) }); // no e: 1
    expect(sentTo(pool, A).map((p) => (JSON.parse(p.event.content) as { e?: number }).e)).toEqual([undefined, 1, 1]);
  });

  it('lets a held command keep its place: the held ping copy replaces only another ping copy', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const t = transport(pool);
    droppedB(pool, t);
    t.send('host', utf8('command'), { lasting: true, kind: 'cmd 1', supersedes: ['cmd 1'] });
    t.send('host', utf8('ping'), { echo: true });
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(3000);
    expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(['while up', 'command', 'ping']);
  });

  it('signs an event held into a later second once, and every relay sending it in that second sends the same event', () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    pool.status.set('wss://a.example/', true);
    pool.status.set(B_KEY, true);
    const t = transport(pool);
    t.broadcast(utf8('while up'));
    pool.status.set('wss://a.example/', false);
    pool.status.set(B_KEY, false);
    t.broadcast(utf8('held'));
    const signedAt = sentTo(pool, A).length; // nothing yet: both relays hold it
    expect(signedAt).toBe(1);
    vi.advanceTimersByTime(2500);
    pool.status.set('wss://a.example/', true);
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(1000);
    const [toA, toB] = [sentTo(pool, A)[1].event, sentTo(pool, B)[1].event];
    expect(payload(toA)).toBe('held');
    expect(toA.created_at).toBe(toB.created_at);
    expect(toA.sig).toBe(toB.sig);
  });

  it('lets a fresh hello displace the oldest held command only while it is expendable', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pool = new FakePool();
    const t = transport(pool);
    droppedB(pool, t);
    let expendable = false;
    for (let i = 0; i < HELD_EVENTS_MAX; i++) {
      t.send('host', utf8(`command ${i}`), { lasting: true, kind: `cmd ${i}`, supersedes: [`cmd ${i}`], expendable: () => i === 0 && expendable });
    }
    t.broadcast(utf8('hello 1'), { kind: 'hello', supersedes: ['hello'] }); // no command is expendable: the hello goes
    expect(health(t)).toMatchObject({ held: HELD_EVENTS_MAX, dropped: 1 });
    expendable = true;
    t.broadcast(utf8('hello 2'), { kind: 'hello', supersedes: ['hello'] }); // command 0 is expendable (acknowledged, or to be resent): it goes
    expect(health(t)).toMatchObject({ held: HELD_EVENTS_MAX, dropped: 2 });
    pool.status.set(B_KEY, true);
    vi.advanceTimersByTime(30_000);
    const commands = Array.from({ length: HELD_EVENTS_MAX - 1 }, (_, i) => `command ${i + 1}`);
    expect(sentTo(pool, B).map((p) => payload(p.event)).slice(1)).toEqual([...commands, 'hello 2']);
  });

  it('sends what waits for a relay as soon as the connection it asked for opens, not at the next wake', async () => {
    vi.useFakeTimers();
    const pool = new FakePool();
    const t = transport(pool);
    droppedB(pool, t);
    let open!: () => void;
    pool.ensureGate = new Promise((resolve) => { open = resolve; });
    t.resume();
    t.broadcast(utf8('hello'));
    await vi.advanceTimersByTimeAsync(200);
    expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(['while up']);
    pool.status.set(B_KEY, true);
    open();
    await vi.advanceTimersByTimeAsync(0);
    expect(sentTo(pool, B).map((p) => payload(p.event))).toEqual(['while up', 'hello']);
  });
});
