import { SimplePool, generateSecretKey, utils, type Event, type Filter } from 'nostr-tools';
import { RELAY_EVENT_KIND } from '../config';
import { fromB64url, toB64url, type Bytes } from '../crypto/bytes';
import { MAX_FRAME_BYTES, relayEvent, type RelayFrame } from './relay-frame';
import type { MessageMeta, PeerStatus, RelayHealth, SendOptions, Transport } from './types';

// The parts of nostr-tools' SimplePool this transport uses, so tests can pass a fake.
export interface RelayPool {
  subscribe(relays: string[], filter: Filter, params: { onevent(event: Event): void; onclose?(reasons: unknown): void; alreadyHaveEvent?(id: string): boolean }): { close(): void };
  publish(relays: string[], event: Event): Promise<string>[];
  listConnectionStatus(): Map<string, boolean>;
  ensureRelay(url: string): Promise<{ onnotice: (msg: string) => void }>;
  close(relays: string[]): void;
}

export interface NostrRelayOptions {
  relays: string[];
  topic: string;
  selfId: string;
  // 0 sends no heartbeat frames: the host's bundles are its heartbeat, and nothing may bypass its budget.
  heartbeatMs?: number;
  peerTimeoutMs?: number;
  pool?: RelayPool;
  // A monotonic clock in ms for the send budget. Wall-clock steps (NTP, a phone waking) must not silence a relay.
  now?: () => number;
}

// An event waiting for its relay: signed when it was published, with its frame to sign again if it goes out in a later
// second. It has a kind, the kinds a newer event of this one makes pointless (a host bundle carries the latest state
// whole), whether it is lasting (SendOptions.lasting), and whether it may go after all (SendOptions.expendable).
// One held item is shared by every relay that holds it, so an event signed again for a later second is signed once.
interface Held { event: Event; frame: RelayFrame; kind?: string; supersedes: string[]; lasting: boolean; expendable?: () => boolean }

const HEARTBEAT = { kind: 'heartbeat', supersedes: ['heartbeat'] };

const MAX_SEEN = 2000;
// How often the transport checks its sockets, and its back-off for reconnecting a relay and resubscribing.
export const RELAY_CHECK_MS = 5000;
export const RECONNECT_BACKOFF_MS = [5000, 10_000, 20_000, 30_000];
export const RESUBSCRIBE_BACKOFF_MS = [1000, 2000, 4000, 8000, 15_000, 30_000];
// What one relay connection is sent, whatever the callers do: a burst of 5, then one event every 350 ms, inside public
// relays' limits (a burst of 6, then 3 a second) and a little faster than the participant's own pacer (a burst of 4,
// then one every 400 ms), so the transport has room for the pings and hellos that pacer doesn't count. The callers pace
// their own commands and bundles; this keeps what they and the heartbeat, pings and hellos add together, and a backlog
// that waited for a connection, inside the limit.
export const SEND_BURST = 5;
export const SEND_REFILL_MS = 350;
// Events held for a relay that is down or out of budget; when more arrive, the oldest that is not lasting, or is lasting
// but expendable (a command the host has acknowledged, or that its outbox will still resend), goes first (the oldest
// lasting one if every one is kept). Resends and refreshes cover what is lost, and every drop is counted (RelayHealth.dropped).
export const HELD_EVENTS_MAX = 20;
// How often events held for a down relay look for it to be back (the connection the transport asked for also sends
// them the moment it opens).
export const HELD_DOWN_CHECK_MS = 1000;
// A relay that has been down this long (longer than the longest reconnect back-off, twice) is given up on for holding:
// its queue is emptied and nothing more is held for it until it is back, so a relay that is dead for good costs nothing.
export const GIVE_UP_AFTER_MS = 60_000;
// nostr-tools gives up on a connection attempt after 3 s. A pool entry that is not connected is closed and replaced only
// when the attempt we last started is older than this; closing one still connecting leaves its timeout to forget the
// replacement and a socket open outside the pool.
const CONNECT_TIMEOUT_MS = 4000;

// A relay's OK false reason starts with a machine-readable prefix ("rate-limited: …", "blocked: …"). Timeouts and
// closed sockets also reject a publish, but they aren't refusals.
const isRefusal = (reason: unknown): boolean => reason instanceof Error && /^[a-z-]+: /.test(reason.message);

// Every message goes to all relays; duplicates are dropped by event ID.
// A throwaway Nostr key per page load keeps sessions unlinkable.
export class NostrRelayTransport implements Transport {
  readonly selfId: string;
  private readonly pool: RelayPool;
  private readonly secretKey = generateSecretKey();
  private readonly seen = new Set<string>();
  private readonly lastSeen = new Map<string, number>();
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private readonly refused = new Map<string, number>();
  private readonly notices = new Map<string, number>();
  // One subscription per relay, each with its own close handling and back-off: the pool's own close callback fires
  // only once every relay's subscription has closed, so a single relay losing its subscription would go unnoticed.
  private readonly subs = new Map<string, { close(): void }>();
  private readonly resubscribes = new Map<string, { step: number; timer: ReturnType<typeof setTimeout> | null }>();
  // nostr-tools gives up on a relay whose first connection fails (or errors before it ever reconnected) and closes
  // its subscription: publishing reconnects it, so it looks healthy, but nothing would arrive. So the transport
  // reconnects relays itself and subscribes again whenever a relay comes back or the subscription closes.
  private readonly wasConnected = new Map<string, boolean>();
  // Per relay connection: the send budget (tokens, and when it was last topped up), and the events held back because
  // the relay is down or out of budget. nostr-tools sends everything published to a relay that is still connecting
  // the moment it connects, so without this a relay that comes back late is hit with a whole backlog at once.
  private readonly budgets = new Map<string, { tokens: number; at: number }>();
  private readonly held = new Map<string, Held[]>();
  private readonly dropped = new Map<string, number>();
  private readonly seenUp = new Set<string>();
  private readonly heldTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly downSince = new Map<string, number>();
  private readonly attemptAt = new Map<string, number>();
  private readonly givenUp = new Set<string>();
  private readonly reconnects = new Map<string, { at: number; step: number }>();
  private closed = false;
  private messageCb?: (peerId: string, data: Bytes, meta?: MessageMeta) => void;
  private joinCb?: (peerId: string) => void;
  private leaveCb?: (peerId: string) => void;

  constructor(private readonly o: NostrRelayOptions) {
    this.selfId = o.selfId;
    // Sockets reconnect by themselves, and pings notice a socket that died while the page was frozen.
    this.pool = o.pool ?? new SimplePool({ enablePing: true, enableReconnect: true });
    this.subscribe();
    const heartbeatMs = o.heartbeatMs ?? 5000;
    const timeoutMs = o.peerTimeoutMs ?? 15000;
    if (heartbeatMs > 0) {
      this.publish({ from: this.selfId }, HEARTBEAT);
      this.timers.push(setInterval(() => this.publish({ from: this.selfId }, HEARTBEAT), heartbeatMs));
    }
    this.timers.push(setInterval(() => this.sweep(timeoutMs), 5000));
    this.timers.push(setInterval(() => this.watchRelays(), RELAY_CHECK_MS));
  }

  send(peerId: string, data: Bytes, opts: SendOptions = {}): void {
    this.publish({ from: this.selfId, to: peerId, d: toB64url(data), ...(opts.echo ? { e: 1 as const } : {}) }, opts);
  }
  broadcast(data: Bytes, opts: SendOptions = {}): void {
    this.publish({ from: this.selfId, d: toB64url(data) }, opts);
  }
  onMessage(cb: (peerId: string, data: Bytes, meta?: MessageMeta) => void): void { this.messageCb = cb; }
  onPeerJoin(cb: (peerId: string) => void): void { this.joinCb = cb; }
  onPeerLeave(cb: (peerId: string) => void): void { this.leaveCb = cb; }
  status(peerId: string): PeerStatus {
    return this.lastSeen.has(peerId) ? 'relayed' : 'offline';
  }
  peers(): string[] { return [...this.lastSeen.keys()]; }

  relayHealth(): RelayHealth[] {
    const status = this.pool.listConnectionStatus();
    return this.o.relays.map((url) => ({
      url,
      connected: status.get(utils.normalizeURL(url)) === true,
      refused: this.refused.get(url) ?? 0,
      dropped: this.dropped.get(url) ?? 0,
      notices: this.notices.get(url) ?? 0,
      held: this.held.get(url)?.length ?? 0,
      givenUp: this.givenUp.has(url),
    }));
  }

  // After a lock or a freeze: a socket may look open but be dead (half-open), so close every relay connection, then
  // connect and subscribe again from scratch. Every relay is held for again (one given up on while the page was locked
  // included), and the held events a fresh one replaces are dropped (the page says hello again, the host sends a full
  // refresh, heartbeats go on), so they don't delay the new ones; lasting events (commands) are kept.
  resume(): void {
    if (this.closed) return;
    this.closeSubs();
    this.pool.close(this.o.relays);
    this.wasConnected.clear();
    this.reconnects.clear();
    this.downSince.clear();
    this.givenUp.clear();
    for (const [url, queue] of this.held) this.held.set(url, queue.filter((h) => h.lasting));
    this.subscribe();
  }

  leave(): void {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    for (const timer of this.heldTimers.values()) clearTimeout(timer);
    this.heldTimers.clear();
    this.held.clear();
    this.closeSubs();
    this.pool.close(this.o.relays);
    this.lastSeen.clear();
  }

  private closeSubs(): void {
    for (const state of this.resubscribes.values()) if (state.timer !== null) clearTimeout(state.timer);
    this.resubscribes.clear();
    for (const sub of this.subs.values()) sub.close();
    this.subs.clear();
  }

  // Subscribe to one relay again now: duplicates of events already seen are dropped by ID.
  private resubscribe(url: string): void {
    if (this.closed) return;
    const state = this.resubscribes.get(url);
    if (state?.timer != null) clearTimeout(state.timer);
    if (state) state.timer = null;
    this.subs.get(url)?.close();
    this.subscribeTo(url);
  }

  // A relay's subscription closed without us closing it (it errored, or sent CLOSED): subscribe to it again, backing
  // off while it keeps closing. A subscription that stayed up for the longest back-off starts the back-off over.
  private relayClosed(url: string, startedAt: number): void {
    if (this.closed) return;
    const state = this.resubscribes.get(url) ?? { step: 0, timer: null };
    this.resubscribes.set(url, state);
    if (state.timer !== null) return;
    const longest = RESUBSCRIBE_BACKOFF_MS[RESUBSCRIBE_BACKOFF_MS.length - 1];
    if (Date.now() - startedAt >= longest) state.step = 0;
    const wait = RESUBSCRIBE_BACKOFF_MS[Math.min(state.step, RESUBSCRIBE_BACKOFF_MS.length - 1)];
    state.step += 1;
    state.timer = setTimeout(() => {
      state.timer = null;
      this.resubscribe(url);
    }, wait);
  }

  // Every RELAY_CHECK_MS: reconnect relays that are down, with back-off, and subscribe again to one that is back.
  private watchRelays(): void {
    const status = this.pool.listConnectionStatus();
    for (const url of this.o.relays) {
      const up = status.get(utils.normalizeURL(url)) === true;
      const back = up && this.wasConnected.get(url) === false;
      this.wasConnected.set(url, up);
      if (up) {
        this.markUp(url);
        this.reconnects.delete(url);
        if (back) this.resubscribe(url);
        continue;
      }
      this.reconnectIfDue(url);
    }
  }

  // Reconnect a relay that is down, if its back-off allows. A relay that was up and has dropped is closed first: nostr-tools
  // keeps reconnecting an entry it lists by itself, and connecting it again from here would leave two sockets for one.
  // An entry that never connected, or whose attempt is younger than the library's own timeout, is still connecting:
  // closing it would let its timeout later forget the replacement, so ensureRelay joins the attempt instead.
  private reconnectIfDue(url: string): void {
    const now = this.clock();
    const next = this.reconnects.get(url) ?? { at: now, step: 0 };
    // A clock that stepped back must not hold a relay off for longer than the back-off's longest wait.
    if (now < next.at && next.at - now <= RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]) return;
    this.reconnects.set(url, { at: now + RECONNECT_BACKOFF_MS[Math.min(next.step, RECONNECT_BACKOFF_MS.length - 1)], step: next.step + 1 });
    const listed = this.pool.listConnectionStatus().has(utils.normalizeURL(url));
    const attempt = this.attemptAt.get(url);
    const connecting = attempt !== undefined && now >= attempt && now - attempt < CONNECT_TIMEOUT_MS;
    if (listed && this.seenUp.has(url) && !connecting) this.pool.close([url]);
    if (!connecting) this.attemptAt.set(url, now);
    this.pool.ensureRelay(url).catch(() => undefined);
  }

  private subscribe(): void {
    for (const url of this.o.relays) this.subscribeTo(url);
  }

  private subscribeTo(url: string): void {
    if (this.closed) return;
    // Subscribing connects a relay that isn't: that is an attempt in progress, which reconnectIfDue must not close.
    if (this.pool.listConnectionStatus().get(utils.normalizeURL(url)) !== true) this.attemptAt.set(url, this.clock());
    // Only a close the pool starts counts: one we start (or one that arrives late, after we moved on) is ignored.
    let live = true;
    let poolClosed = false;
    const startedAt = Date.now();
    const pooled = this.pool.subscribe([url], { kinds: [RELAY_EVENT_KIND], '#t': [this.o.topic] }, {
      onevent: (event: Event) => this.receive(event),
      // The pool has dropped events it already had before parsing and checking their signatures.
      alreadyHaveEvent: (id: string) => this.seen.has(id),
      onclose: () => {
        if (!live) return;
        poolClosed = true;
        this.relayClosed(url, startedAt);
      },
    });
    // Closing a subscription the pool already closed would still lower the relay's operation count, so a live relay
    // could idle-close under its replacement.
    this.subs.set(url, { close: () => { live = false; if (!poolClosed) pooled.close(); } });
    this.pool.ensureRelay(url).then((relay) => {
      relay.onnotice = () => this.notices.set(url, (this.notices.get(url) ?? 0) + 1);
      // Connected: what waits for it goes now, not at its next wake.
      if (live) this.sendHeld(url);
    }, () => undefined);
  }

  private clock(): number {
    return (this.o.now ?? (() => performance.now()))();
  }

  private publish(frame: RelayFrame, opts: SendOptions = {}): void {
    if (this.closed) return;
    const now = this.clock();
    const status = this.pool.listConnectionStatus();
    // Signed once: a relay that gets it at once and one that holds it must get the same event.
    const event = relayEvent(frame, this.o.topic, this.secretKey);
    const item: Held = { event, frame, kind: opts.kind, supersedes: opts.supersedes ?? [], lasting: opts.lasting === true, expendable: opts.expendable };
    let pingCopy: Held | undefined;
    const ready: string[] = [];
    for (const url of this.o.relays) {
      if (this.takeSlot(url, status, now)) ready.push(url);
      // A relay ping is never held: its round trip would time the wait, not the relay. A copy that asks for no echo is
      // held in its place, so the host still hears from this page (it ends a new record's probation); a newer one
      // replaces it.
      else this.hold(url, opts.echo ? (pingCopy ??= this.plainPing(frame)) : item, now, this.isDown(url, status));
    }
    if (ready.length) this.publishTo(ready, event);
    for (const url of this.o.relays) this.scheduleHeld(url);
  }

  private plainPing(frame: RelayFrame): Held {
    const plain: RelayFrame = { ...frame };
    delete plain.e;
    return { event: relayEvent(plain, this.o.topic, this.secretKey), frame: plain, kind: 'ping', supersedes: ['ping'], lasting: false };
  }

  private publishTo(relays: string[], event: Event): void {
    this.pool.publish(relays, event).forEach((attempt, i) => {
      attempt.catch((reason: unknown) => {
        const url = relays[i];
        if (isRefusal(reason)) this.refused.set(url, (this.refused.get(url) ?? 0) + 1);
      });
    });
  }

  // Whether this relay's socket is down: closed, or gone from the pool after it was up. A relay we have never seen up
  // is not (the page is still starting, and publishing connects it); one that has been up and is not now is.
  private isDown(url: string, status: Map<string, boolean>): boolean {
    const up = status.get(utils.normalizeURL(url));
    if (up === true) this.markUp(url);
    return up === false || (up === undefined && this.seenUp.has(url));
  }

  // The relay is up: it has been seen up, and it is held for again if it had been given up on.
  private markUp(url: string): void {
    this.seenUp.add(url);
    this.downSince.delete(url);
    this.givenUp.delete(url);
  }

  // Whether this relay may be sent an event now, taking a token if so. Not while its socket is down, nor while earlier
  // events wait, nor with no tokens.
  private takeSlot(url: string, status: Map<string, boolean>, now: number): boolean {
    if ((this.held.get(url)?.length ?? 0) > 0 || this.isDown(url, status)) return false;
    return this.takeToken(url, now);
  }

  private tokens(url: string, now: number): { tokens: number; at: number } {
    const budget = this.budgets.get(url) ?? { tokens: SEND_BURST, at: now };
    // A clock that steps back adds nothing, takes nothing away, and is the new starting point.
    budget.tokens = Math.min(SEND_BURST, budget.tokens + Math.max(0, now - budget.at) / SEND_REFILL_MS);
    budget.at = now;
    this.budgets.set(url, budget);
    return budget;
  }

  private takeToken(url: string, now: number): boolean {
    const budget = this.tokens(url, now);
    if (budget.tokens < 1) return false;
    budget.tokens -= 1;
    return true;
  }

  private hold(url: string, item: Held, now: number, down: boolean): void {
    // A relay that has been down for good is not held for: one warning, and what would have waited is counted as dropped.
    if (down && !this.downSince.has(url)) this.downSince.set(url, now);
    const since = this.downSince.get(url);
    if (down && (this.givenUp.has(url) || (since !== undefined && now - since >= GIVE_UP_AFTER_MS))) {
      if (!this.givenUp.has(url)) {
        this.givenUp.add(url);
        console.warn(`Relay transport stopped holding events for ${url}: it has been down for ${GIVE_UP_AFTER_MS / 1000} s`);
        this.dropped.set(url, (this.dropped.get(url) ?? 0) + (this.held.get(url)?.length ?? 0));
        this.held.set(url, []);
      }
      this.dropped.set(url, (this.dropped.get(url) ?? 0) + 1);
      return;
    }
    // A newer event makes held ones of the kinds it supersedes pointless: it takes the place of the first of them and
    // the rest go, so a resent command stays ahead of later commands and a fresh hello ahead of what followed the old one.
    // With none to replace it goes to the back.
    const replaces = (h: Held) => h.kind !== undefined && item.supersedes.includes(h.kind);
    const held = this.held.get(url) ?? [];
    const first = held.findIndex(replaces);
    const queue = first === -1 ? [...held, item] : held.flatMap((h, i) => (i === first ? [item] : replaces(h) ? [] : [h]));
    // A lasting event goes before a fresh one only while it is expendable: so a hello may displace the oldest command
    // the host has acknowledged or the outbox will still resend, never one whose held copy may be the last.
    const droppable = (h: Held) => !h.lasting || h.expendable?.() === true;
    while (queue.length > HELD_EVENTS_MAX) {
      const oldest = queue.findIndex(droppable);
      queue.splice(oldest === -1 ? 0 : oldest, 1);
      const total = (this.dropped.get(url) ?? 0) + 1;
      this.dropped.set(url, total);
      // The first drop and every tenth after it, so a long outage doesn't flood the console.
      if (total % 10 === 1) console.warn(`Relay transport dropped held events for ${url} (${total} so far)`);
    }
    this.held.set(url, queue);
  }

  // Wakes this relay's held events when the next can go: when a token is back for a relay that is up, or after a second
  // for one that is down. Each relay has its own wake, so a down relay never delays an up one. Nothing is scheduled
  // when nothing waits, and a relay's wake is never set twice.
  private scheduleHeld(url: string): void {
    if (this.closed || (this.held.get(url)?.length ?? 0) === 0) return;
    const now = this.clock();
    const wait = this.isDown(url, this.pool.listConnectionStatus()) ? HELD_DOWN_CHECK_MS : Math.max(10, Math.ceil((1 - this.tokens(url, now).tokens) * SEND_REFILL_MS));
    if (this.heldTimers.has(url)) return;
    this.heldTimers.set(url, setTimeout(() => {
      this.heldTimers.delete(url);
      this.sendHeld(url);
    }, wait));
  }

  private sendHeld(url: string): void {
    if (this.closed) return;
    const now = this.clock();
    const queue = this.held.get(url) ?? [];
    if (queue.length === 0) return;
    // Publishing used to reconnect a relay; holding events must not leave it to the 5 s check. The same back-off applies.
    if (this.isDown(url, this.pool.listConnectionStatus())) {
      this.reconnectIfDue(url);
    } else {
      while (queue.length > 0 && this.takeToken(url, now)) {
        const held = queue.shift()!;
        // Held into a later second, it is signed again: a subscription nostr-tools reconnected by itself asks only for
        // events after the newest it had, by the second. The held item is shared, so every relay that sends it within
        // one second sends the same event, signed once.
        if (held.event.created_at < Math.floor(Date.now() / 1000)) held.event = relayEvent(held.frame, this.o.topic, this.secretKey);
        this.publishTo([url], held.event);
      }
    }
    this.scheduleHeld(url);
  }

  private receive(event: Event): void {
    if (this.closed) return;
    if (typeof event.content !== 'string' || event.content.length > MAX_FRAME_BYTES) return; // too large to parse
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value!);
    let frame: RelayFrame;
    try {
      frame = JSON.parse(event.content) as RelayFrame;
    } catch {
      return;
    }
    if (typeof frame.from !== 'string') return;
    if (frame.from === this.selfId) {
      // Our own event, back from a relay. Only a ping that asked for it is wanted, to measure relay latency.
      if (frame.e === 1) this.deliver(frame.from, frame.d, { echo: true });
      return;
    }
    const isNew = !this.lastSeen.has(frame.from);
    this.lastSeen.set(frame.from, Date.now());
    if (isNew) this.joinCb?.(frame.from);
    if (frame.to !== undefined && frame.to !== this.selfId) return;
    this.deliver(frame.from, frame.d);
  }

  private deliver(from: string, d: unknown, meta?: MessageMeta): void {
    if (typeof d !== 'string') return;
    let data: Bytes;
    try {
      data = fromB64url(d);
    } catch {
      return; // Not base64url: ignore.
    }
    this.messageCb?.(from, data, meta);
  }

  private sweep(timeoutMs: number): void {
    const cutoff = Date.now() - timeoutMs;
    for (const [peerId, seenAt] of this.lastSeen) {
      if (seenAt >= cutoff) continue;
      this.lastSeen.delete(peerId);
      this.leaveCb?.(peerId);
    }
  }
}
