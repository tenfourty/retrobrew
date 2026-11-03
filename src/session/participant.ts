import { ClockSync } from '../clock/clock';
import type { Bytes } from '../crypto/bytes';
import { fingerprint, type Signer } from '../crypto/sign';
import { MESSAGES } from '../engine/messages';
import { mergeView } from '../engine/redact';
import type { Command, PersonalView, SharedView, ViewState } from '../engine/types';
import { openBundle, openItem } from '../protocol/bundle';
import { decodeFrame, encodeWire, openEnvelope, sealEnvelope } from '../protocol/envelope';
import { parseVersionReply, parseToHost, parseToPeer, type Ping, type Snapshot, type ToHost } from '../protocol/messages';
import { newSid } from '../protocol/sid';
import { withViewDefaults } from '../protocol/view-defaults';
import { PROTOCOL_VERSION, VERSION_MESSAGE } from '../protocol/version';
import { toRoomTransport } from '../transport/room';
import type { Inbound, Path, RelayHealth, RoomTransport, SendOptions, Transport } from '../transport/types';
import { TokenBucket } from './budget';
import { outcomeBetween, type Outcome } from './outcome';
import { Outbox, type Outgoing } from './outbox';
import { every, realScheduler, type Scheduler } from './scheduler';

// What the meeting screens show about the connection (docs/product/mvp-screens.md, Connection states and banners).
// How long after a takePart() the host needs to handle the hello and a view to leave it: a refusal in a view built
// earlier than that is the one from before the retry.
export const RETRY_GRACE_MS = 2000;

export type Connection = 'connecting' | 'connected' | 'hostOffline' | 'noRelays' | 'versionMismatch';

// docs/product/sync-protocol.md, Pings, clocks and liveness, and Reconnecting.
export const PING_MS = 5000;
export const HOST_OFFLINE_MS = 20_000;
export const DIRECT_DOWN_MS = 15_000;
export const NO_RELAYS_MS = 10_000;
export const HELLO_BACKOFF_MS = [2000, 4000, 8000];
export const HELLO_EVERY_MS = 15_000;
export const ENDED_HELLO_MS = 45_000;
// After a lock or a freeze, the host gets this long to answer before it counts as offline, so a phone that
// unlocks never flashes "offline" while its hello is on the way (the board updates within 5 s of unlocking).
export const RESUME_GRACE_MS = 5000;
const CHECK_MS = 1000;
const MAX_PENDING_PINGS = 8;
// On the relay a newer hello replaces one still held by the transport: the host takes only the newest anyway.
const HELLO: SendOptions = { kind: 'hello', supersedes: ['hello'] };
// While the host's direct path is connected but not yet proven, a direct ping goes over it this often.
export const DIRECT_PROBE_MS = 2000;
// Commands on the relay: a burst of 4, then one every 400 ms, inside public relays' limits (a burst of 6, then 3 a
// second), with room left for pings and hellos.
export const RELAY_BURST = 4;
export const RELAY_REFILL_MS = 400;

export interface ParticipantOptions {
  transport: Transport | RoomTransport;
  roomKey: CryptoKey;
  signer: Signer;
  hostPub: string;
  // The meeting from the share link. Every hello and command names it.
  boardId: string;
  name: string;
  scheduler?: Scheduler;
  now?: () => number;
  onState?: (state: ViewState, you: string) => void;
  // clientSeq is the number sendSeq returned for the refused command.
  onReject?: (message: string, clientSeq: number) => void;
  onHostStatus?: (online: boolean) => void;
  // Called with every relay's state whenever it changes, for the connection details.
  onHealth?: (health: RelayHealth[]) => void;
  // Called when connection, mismatch, pendingFailed, staleTab or joinRefused changes.
  onStatus?: () => void;
  // The facilitator decided a time-up vote: a one-line outcome for a few seconds.
  onOutcome?: (outcome: Outcome) => void;
}

export class ParticipantSession {
  state: ViewState | null = null;
  you: string | null = null;
  connection: Connection = 'connecting';
  // A protocol 1 view arrived from the host. reloadThisPage: the host is newer ("This meeting was started with a
  // different version of Retrobrew. Reload this page."). askFacilitator: the host is older. While it is set,
  // `connection` is 'versionMismatch' whatever else happens; only a newer, accepted protocol 2 view clears it.
  mismatch: 'reloadThisPage' | 'askFacilitator' | null = null;
  // The host refused this tab: away too long (staleTab, "This page has been away too long. Reload it to carry on"), or
  // dropped for a newer tab of the same person (tooManyTabs). Either way the page must reload.
  staleTab = false;
  // The refusal the page shows for staleTab: that message, or tooManyTabs's.
  staleTabMessage: string | null = null;
  // The host refused this person's join (meetingFull, meetingFullSize, emptyName): the join form comes back with that
  // message, and takePart(name) tries again.
  joinRefused: string | null = null;
  // When this page started trying to reach the facilitator, for the connecting panel's 15 s and 60 s copy.
  readonly connectingSince: number;
  readonly clock = new ClockSync();
  private readonly transport: RoomTransport;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly outbox: Outbox<Command>;
  // One per page load. Its clientSeq starts at 1, and its creation time lets the host recognise a pruned tab.
  readonly sid: string;
  private readonly me: Promise<string>;
  private readonly shownRejects = new Set<number>();
  // t0 -> local time sent, for the direct pings still waiting for their pong. A pong counts once, and only for one of these.
  private readonly pendingPongs = new Map<number, number>();
  private lastT0 = Number.NEGATIVE_INFINITY;
  private pingCount = 0;
  private helloCount = 0;
  // The largest hostNow − receivedAt over the verified bundle headers accepted so far, used for a ping's or hello's `at`
  // before the clock has a reading of its own (a bundle without our entry never feeds the clock). Never feeds the clock.
  private headerLead = Number.NEGATIVE_INFINITY;
  private hostPeer: string | null = null;
  // The host's peer the last time one was known, so a resume can ask for the direct link to it back after the host was
  // judged offline in the lock.
  private lastHostPeer: string | null = null;
  // Set by every hello; the next view accepted from the host is answered with a ping at once.
  private pingAfterHello = false;
  private epoch = -1;
  private seq = -1;
  private hostNow = Number.NEGATIVE_INFINITY;
  // The newest protocol 1 view accepted, so a replayed one can't set the mismatch again once a view cleared it.
  private versionReply = { epoch: -1, seq: -1 };
  // This person's newest entry from a relay bundle, and the bundle's epoch and seq.
  private entry: { personal: PersonalView; epoch: number; seq: number } | null = null;
  // The last accepted, newer host view or answered pong. A replayed or duplicate view never moves these, so it
  // can't keep the host online.
  private lastHostMessageAt = Number.NEGATIVE_INFINITY;
  private lastDirectHostAt = Number.NEGATIVE_INFINITY;
  // When a host was bound whose direct connection was open. Neither side sends on an unproven direct path, so for
  // 15 s from then pings probe it: the first pong proves it.
  private directProbeFrom = Number.NEGATIVE_INFINITY;
  private readonly relayPings = new Map<number, number>(); // t0 -> local time sent, for echo latency
  private relaysDownSince: number | null = null;
  private healthBefore = '';
  // Local time the newest view was accepted.
  private lastViewAt = Number.NEGATIVE_INFINITY;
  // After takePart(): refusals in views built before this host time are the old one, not an answer to the new hello.
  private retryAfterHostTime: number | null = null;
  // The name hellos carry: the one from the join form, until takePart() changes it.
  private name: string;
  private helloStep = 0;
  private lastHelloAt = Number.NEGATIVE_INFINITY;
  private nextHelloAt: number;
  private nextPingAt = Number.NEGATIVE_INFINITY;
  // The hellos a full refresh without our entry prompts back off on their own schedule, and stop once refused.
  private soonStep = 0;
  private nextSoonAt = Number.NEGATIVE_INFINITY;
  private refused = false;
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  private lastSuspensionGraceAt = Number.NEGATIVE_INFINITY;
  private sending: Promise<void> = Promise.resolve();
  private nextProbeAt = Number.NEGATIVE_INFINITY;
  private readonly relayBudget: TokenBucket;
  private stopChecking?: () => void;

  constructor(private readonly o: ParticipantOptions) {
    this.transport = toRoomTransport(o.transport);
    this.scheduler = o.scheduler ?? realScheduler;
    this.now = o.now ?? (() => this.scheduler.now());
    this.name = o.name;
    this.sid = newSid(this.now());
    this.connectingSince = this.now();
    this.nextHelloAt = this.now() + HELLO_BACKOFF_MS[0];
    this.me = fingerprint(o.signer.pub);
    this.relayBudget = new TokenBucket(this.scheduler, RELAY_BURST, RELAY_REFILL_MS);
    this.outbox = new Outbox<Command>({
      scheduler: this.scheduler,
      send: (items, resend) => this.sendCommands(items, resend),
      onFailedChange: () => o.onStatus?.(),
      // A host that is online but slow (its views and pongs still come) keeps the resends going, with back-off.
      hostAlive: () => this.hostPeer !== null,
    });
    // Nothing is sent until a view lists us as an attendee, so a command made while the join is on its way can't
    // reach the host first and be refused (accept, below).
    this.outbox.hold();
    // The direct path rejoins once if the link to the host drops while the page is visible (see the transport).
    this.transport.follow?.(() => ({ host: this.hostPeer ?? this.lastHostPeer }));
    // A direct connection coming up may be the host's, so say hello. That holds even while another peer is bound as
    // host: a reloaded host's new peer can join before its old one is seen leaving, so it gets a hello of its own, on
    // that connection. Peers seen only on the relay are other people saying hello: answering each of them would
    // multiply hellos with every joiner, and the host makes itself known by its bundles.
    this.transport.onPeerJoin((peerId) => {
      if (peerId === this.hostPeer || this.transport.status(peerId) !== 'direct') return;
      if (this.hostPeer) void this.helloTo(peerId);
      else void this.hello();
    });
    // A peer leaving the transport (a relay's sweep after a freeze, a WebRTC drop) says nothing reliable about the
    // host: only HOST_OFFLINE_MS without a host message, with the resume grace, decides it is offline.
    this.transport.onInbound((m) => {
      this.receive(m).catch((err) => console.warn('Could not handle a message', err));
    });
    this.rehello();
  }

  get hostOnline(): boolean {
    return this.hostPeer !== null;
  }

  // The state of each relay, for the connection details.
  relayHealth(): RelayHealth[] {
    return this.transport.relayHealth();
  }

  // The outbox gave up (three resends with the host gone, or two minutes with a slow one): "Your last change didn't reach the facilitator." with Retry.
  get pendingFailed(): boolean {
    return this.outbox.failed;
  }

  // While the host is offline the board is read-only, so no new commands are made.
  async send(cmd: Command): Promise<boolean> {
    return (await this.sendSeq(cmd)) !== null;
  }

  // Like send, but resolves to the command's clientSeq, which onReject names if the host refuses it; null if nothing was sent.
  async sendSeq(cmd: Command): Promise<number | null> {
    if (!this.hostPeer) return null;
    const seq = this.outbox.add(cmd);
    await this.sending;
    return seq;
  }

  // Retry: resend from the oldest unacknowledged command and start the count again, and say a fresh hello with
  // the back-off reset (the connecting panel's Retry).
  retry(): void {
    if (this.outbox.failed) this.outbox.retry();
    this.rehello();
  }

  // On the direct path if it is proven, otherwise on the relay, asking for an echo to measure relay latency.
  async ping(): Promise<void> {
    const host = this.hostPeer;
    if (!host) return;
    const ping = this.nextPing();
    const t0 = ping.t0;
    try {
      const data = await this.seal(ping);
      // The host may have changed while sealing. The send time is taken after sealing, so it doesn't count in the
      // round trip.
      if (host !== this.hostPeer) return;
      const sentAt = this.now();
      if (this.directProven() || sentAt - this.directProbeFrom <= DIRECT_DOWN_MS) {
        this.pendingPongs.set(t0, sentAt);
        for (const old of [...this.pendingPongs.keys()].slice(0, -MAX_PENDING_PINGS)) this.pendingPongs.delete(old);
        if (await this.transport.sendVia(host, data, 'direct', { fallback: false })) return;
        this.pendingPongs.delete(t0);
        this.lastDirectHostAt = this.directProbeFrom = Number.NEGATIVE_INFINITY;
      }
      this.relayPings.set(t0, sentAt);
      for (const old of [...this.relayPings.keys()].slice(0, -MAX_PENDING_PINGS)) this.relayPings.delete(old);
      await this.transport.sendVia(host, data, 'relay', { echo: true });
    } catch (err) {
      console.warn('Could not ping', err);
    }
  }

  // "Take part" again after a refused join, perhaps under another name.
  takePart(name: string): void {
    this.name = name;
    // Now on the host's clock, from the newest host view and the time since it arrived, so a wrong clock estimate
    // can't hide a refusal for ever.
    this.retryAfterHostTime = Number.isFinite(this.hostNow) ? this.hostNow + (this.now() - this.lastViewAt) + RETRY_GRACE_MS : null;
    this.refused = false;
    this.soonStep = 0;
    this.nextSoonAt = Number.NEGATIVE_INFINITY;
    if (this.joinRefused !== null) {
      this.joinRefused = null;
      this.o.onStatus?.();
    }
    this.rehello();
  }

  // Say hello again now, and start the back-off again. Only the host answers.
  rehello(): void {
    this.helloStep = 0;
    this.nextHelloAt = this.now() + HELLO_BACKOFF_MS[0];
    void this.hello();
  }

  // The page became visible again (a phone unlocked, an app switch, a page restored from the back-forward cache):
  // reconnect and resubscribe the relays, have the direct path bring back its link to the host if that was lost (and
  // only that link: docs/product/sync-protocol.md, Direct path after a resume), say hello as a relay broadcast and
  // straight to the known host with the hello back-off started again, and treat the direct path as unproven until a
  // host message arrives over it.
  // The host gets the same one grace as a suspension spotted by the heartbeat, never a second: whichever of the two
  // comes first after a freeze takes it.
  resume(): void {
    this.transport.resume({ host: this.hostPeer ?? this.lastHostPeer });
    this.lastDirectHostAt = this.directProbeFrom = Number.NEGATIVE_INFINITY;
    this.grace(this.now());
    // A ping sent before the freeze would time a round trip with the freeze inside it; the grace's own ping is kept.
    for (const t0 of [...this.pendingPongs.keys()]) if (t0 < this.lastSuspensionGraceAt) this.pendingPongs.delete(t0);
    this.rehello();
  }

  // One grace for the host after this page was away: RESUME_GRACE_MS to be heard from, with a ping now. At most once
  // per HOST_OFFLINE_MS, and not again until the host has been heard since the last one, so a dead host is still
  // noticed. Never moves lastHostMessageAt back, and does nothing without a host. Returns whether it was given.
  private grace(now: number): boolean {
    const due = now - this.lastSuspensionGraceAt >= HOST_OFFLINE_MS && this.lastHostMessageAt > this.lastSuspensionGraceAt;
    if (!this.hostPeer || !due) return false;
    this.lastSuspensionGraceAt = now;
    this.lastHostMessageAt = Math.max(this.lastHostMessageAt, now - HOST_OFFLINE_MS + RESUME_GRACE_MS);
    this.nextPingAt = now;
    return true;
  }

  // Liveness, once a second: the host's offline threshold, pings, hellos with back-off, and the relays.
  startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastCheckAt = this.now();
    this.stopChecking = every(this.scheduler, CHECK_MS, () => this.check());
  }

  stopHeartbeat(): void {
    this.stopChecking?.();
    this.stopChecking = undefined;
    this.outbox.stop();
  }

  private check(): void {
    const now = this.now();
    // Ticks more than three seconds apart: this page was suspended (a frozen tab, a sleeping laptop), so its own
    // silence says nothing about the host. Give the host one ping period to answer, ping now, and decide next tick.
    // The grace comes at most once per 20 s, and not again until the host has been heard since the last one, so a
    // throttled tab ticking once a minute still notices a dead host by its second slow tick (see grace()).
    const suspended = now - this.lastCheckAt > 3 * CHECK_MS;
    this.lastCheckAt = now;
    if (!(suspended && this.grace(now)) && this.hostPeer && now - this.lastHostMessageAt > HOST_OFFLINE_MS) this.setHost(null);
    if (this.hostPeer) {
      // The direct path to the host came up after its first view (the usual order: relays are quicker than WebRTC).
      // A ping over it proves it: the host answers over the same path, and replies direct from then on. One failed
      // probe marks the path down (status turns 'relayed'), so probing stops until the direct connection drops and
      // returns or a direct message arrives.
      if (!this.directProven() && this.transport.status(this.hostPeer) === 'direct' && now >= this.nextProbeAt) {
        this.nextProbeAt = now + DIRECT_PROBE_MS;
        void this.probeDirect(this.hostPeer);
      }
      if (now >= this.nextPingAt) {
        this.nextPingAt = now + PING_MS;
        void this.ping();
      }
    } else if (now >= this.nextHelloAt) {
      void this.hello();
      this.helloStep += 1;
      const ended = this.state?.phase === 'ended';
      this.nextHelloAt = now + (ended ? ENDED_HELLO_MS : HELLO_BACKOFF_MS[this.helloStep] ?? HELLO_EVERY_MS);
    }
    const health = this.transport.relayHealth();
    const healthNow = JSON.stringify(health);
    if (healthNow !== this.healthBefore) {
      this.healthBefore = healthNow;
      this.o.onHealth?.(health);
    }
    const allDown = health.length > 0 && health.every((relay) => !relay.connected);
    this.relaysDownSince = allDown ? this.relaysDownSince ?? now : null;
    this.updateConnection();
  }

  // One ping over the direct path alone, never the relay: the host's pong, if it comes, proves the path.
  private async probeDirect(host: string): Promise<void> {
    try {
      const ping = this.nextPing();
      const t0 = ping.t0;
      const data = await this.seal(ping);
      if (host !== this.hostPeer) return;
      this.pendingPongs.set(t0, this.now());
      for (const old of [...this.pendingPongs.keys()].slice(0, -MAX_PENDING_PINGS)) this.pendingPongs.delete(old);
      if (!(await this.transport.sendVia(host, data, 'direct', { fallback: false }))) this.pendingPongs.delete(t0);
    } catch (err) {
      console.warn('Could not ping', err);
    }
  }

  // This page's estimate of the host's clock at local time `at`: the clock's, or before it has one, from the newest
  // verified bundle header, or else this page's own time.
  private hostEstimate(local: number): number {
    if (this.clock.hasEstimate) return this.clock.hostNow(local);
    return Number.isFinite(this.headerLead) ? local + this.headerLead : local;
  }

  // Each ping has its own t0 (never repeated, so a pong can't answer two) and the next count for this tab, so the host
  // accepts it once. `at` is this page's estimate of the host's clock.
  private nextPing(): Ping {
    const t0 = Math.max(this.now(), this.lastT0 + 1);
    this.lastT0 = t0;
    this.pingCount += 1;
    return { t: 'ping', boardId: this.o.boardId, sid: this.sid, n: this.pingCount, at: this.hostEstimate(t0), t0, peer: this.transport.selfId };
  }

  // The direct path counts only once a host message has arrived over it, and until 15 s pass without one.
  private directProven(): boolean {
    return this.now() - this.lastDirectHostAt <= DIRECT_DOWN_MS;
  }

  private updateConnection(): void {
    // A version mismatch holds against every recompute: only a newer protocol 2 view (accept) or a reload ends it.
    if (this.connection === 'versionMismatch') return;
    if (this.mismatch !== null) {
      this.connection = 'versionMismatch';
      this.o.onStatus?.();
      return;
    }
    const noRelays = this.relaysDownSince !== null && this.now() - this.relaysDownSince >= NO_RELAYS_MS;
    const next: Connection = noRelays ? 'noRelays' : this.hostPeer ? 'connected' : this.state ? 'hostOffline' : 'connecting';
    if (next === this.connection) return;
    this.connection = next;
    this.o.onStatus?.();
  }

  // The hello a full refresh without our entry prompts: never within 2 s of another hello, then backing off 2, 4, 8
  // and 15 s (45 s once the meeting has ended) until a view carries our entry. None once this tab has been refused
  // a join while not an attendee: saying hello again would only be refused again. An attendee refused a rename
  // keeps saying hello, so it binds again if its record expires.
  private helloSoon(): void {
    const now = this.now();
    if (this.refused && this.amAttendee()) this.refused = false;
    if (this.refused || now < this.nextSoonAt || now - this.lastHelloAt < HELLO_BACKOFF_MS[0]) return;
    void this.hello();
    const ended = this.state?.phase === 'ended';
    this.nextSoonAt = now + (ended ? ENDED_HELLO_MS : HELLO_BACKOFF_MS[this.soonStep] ?? HELLO_EVERY_MS);
    this.soonStep += 1;
  }

  // Whether the latest accepted view lists us as an attendee. Until it does, the page shows "connecting", not the board.
  get isAttendee(): boolean {
    return this.amAttendee();
  }

  private amAttendee(): boolean {
    return this.state !== null && this.you !== null && Object.hasOwn(this.state.attendees, this.you);
  }

  private helloMessage(): ToHost {
    // Each hello sealed has its own count, so a copy of an old one is never newer than a later one.
    this.helloCount += 1;
    const at = this.hostEstimate(this.now());
    return { t: 'hello', pv: PROTOCOL_VERSION, boardId: this.o.boardId, name: this.name, peer: this.transport.selfId, sid: this.sid, n: this.helloCount, at };
  }

  // One hello as a relay broadcast, whatever the transport's peer list says, and another straight to the known
  // host. Hellos are always in the protocol 1 layout, so a host of any version can read them.
  private async hello(): Promise<void> {
    this.lastHelloAt = this.now();
    // The host takes a hello's record on probation (shared view only) until a ping or command arrives. A ping sent
    // with the hello could reach the host before the record exists, so the ping answers the hello's reply instead:
    // probation lasts about one round trip.
    this.pingAfterHello = true;
    try {
      const data = await this.seal(this.helloMessage(), 1);
      this.transport.broadcastRelay(data, HELLO);
      if (this.hostPeer) await this.transport.sendVia(this.hostPeer, data, 'direct', { fallback: false });
      // Not knowing the host yet, try every direct connection: relays may be down, and only the host answers a hello.
      else for (const peerId of this.transport.peers()) if (this.transport.status(peerId) === 'direct') void this.transport.sendVia(peerId, data, 'direct', { fallback: false });
    } catch (err) {
      console.warn('Could not say hello', err);
    }
  }

  // A hello to one peer that may be the host, on its direct connection (the relay if that send fails). The host
  // ignores a repeat, and anyone else ignores it altogether.
  private async helloTo(peerId: string): Promise<void> {
    this.pingAfterHello = true;
    try {
      await this.transport.sendVia(peerId, await this.seal(this.helloMessage(), 1), 'direct', HELLO);
    } catch (err) {
      console.warn('Could not say hello', err);
    }
  }

  // A resend while the previous one is still queued (in the relay budget) is dropped: it would only add a second copy of
  // the same commands, which the host does not need yet, ahead of fresh ones. The next resend sends the whole pending set.
  private resendQueued = false;

  private sendCommands(items: Outgoing<Command>[], resend: boolean): void {
    if (resend) {
      if (this.resendQueued) return;
      this.resendQueued = true;
    }
    this.sending = this.sending.then(async () => {
      try {
        const host = this.hostPeer;
        if (!host) return;
        for (const item of items) {
          // Stop if the host changed while earlier commands waited: the outbox sends everything again to a new host.
          if (host !== this.hostPeer || !(await this.sendCommand(host, item))) return;
        }
      } finally {
        if (resend) this.resendQueued = false;
      }
    });
  }

  private setHost(peerId: string | null): void {
    if (peerId === this.hostPeer) return;
    this.hostPeer = peerId;
    if (peerId !== null) this.lastHostPeer = peerId;
    // A direct path proven to one host peer says nothing about another.
    this.lastDirectHostAt = this.directProbeFrom = this.nextProbeAt = Number.NEGATIVE_INFINITY;
    this.pendingPongs.clear();
    this.relayPings.clear();
    this.o.onHostStatus?.(peerId !== null);
    this.updateConnection();
  }

  private async receive(m: Inbound): Promise<void> {
    // When it arrived, before decrypting and verifying, for the clock.
    const receivedAt = this.now();
    if (m.echo) {
      await this.onEcho(m, receivedAt);
      return;
    }
    const frame = await decodeFrame(this.o.roomKey, m.data);
    if (frame?.kind === 'bundle') {
      await this.onBundle(m, frame.body, receivedAt);
      return;
    }
    if (frame?.kind !== 'envelope' || frame.env.pub !== this.o.hostPub) return;
    const opened = await openEnvelope(frame.env);
    if (opened && frame.pv === 1) {
      await this.onVersionReply(m, opened.message);
      return;
    }
    if (frame.pv !== 2) return;
    const msg = opened && parseToPeer(opened.message);
    if (!msg) return;
    if (msg.t === 'snapshot') {
      await this.onSnapshot(m, msg, receivedAt);
      return;
    }
    // A pong counts only from the host peer, over the direct path, for a ping we sent and haven't had answered.
    const sentAt = this.pendingPongs.get(msg.t0);
    if (m.from !== this.hostPeer || m.path !== 'direct' || sentAt === undefined) return;
    this.pendingPongs.delete(msg.t0);
    this.lastHostMessageAt = this.lastDirectHostAt = this.now();
    this.clock.addSample(sentAt, msg.t1, receivedAt);
  }

  // One of our own relay pings, back from a relay: its round trip is the relay latency.
  private async onEcho(m: Inbound, receivedAt: number): Promise<void> {
    const frame = await decodeFrame(this.o.roomKey, m.data);
    if (frame?.kind !== 'envelope' || frame.env.pub !== this.o.signer.pub) return;
    const opened = await openEnvelope(frame.env);
    const ping = opened && parseToHost(opened.message, frame.pv);
    if (!ping || ping.t !== 'ping') return;
    const sentAt = this.relayPings.get(ping.t0);
    if (sentAt === undefined) return;
    this.relayPings.delete(ping.t0);
    this.clock.addEcho(receivedAt - sentAt);
  }

  // A protocol 1 snapshot from the host's key, for us, from the peer it names: the host runs another version. Like any
  // view it must be newer than the last protocol 2 view accepted (it has no hostNow, so a tie is not newer), and newer
  // than the last protocol 1 view, so a replayed one never sets the mismatch over a newer view. It doesn't move the
  // protocol 2 epoch and seq: a host of another version numbers its sessions its own way.
  private async onVersionReply(m: Inbound, message: unknown): Promise<void> {
    const reply = parseVersionReply(message);
    if (!reply || reply.host !== m.from || reply.you !== (await this.me)) return;
    if (!this.newer(reply.epoch, reply.seq, Number.NEGATIVE_INFINITY)) return;
    const { epoch, seq } = this.versionReply;
    if (reply.epoch !== epoch ? reply.epoch < epoch : reply.seq <= seq) return;
    this.versionReply = { epoch: reply.epoch, seq: reply.seq };
    this.mismatch = reply.boardName === VERSION_MESSAGE ? 'reloadThisPage' : 'askFacilitator';
    this.updateConnection();
  }

  // A newer view from another host session (a new epoch, or another host peer) has a clock of its own, which may be
  // behind the old one's: what this page learned of the old clock is forgotten, and the newer view's replaces it.
  private newSessionClock(m: Inbound, epoch: number): void {
    if (this.epoch === -1) return;
    if (epoch === this.epoch && (this.hostPeer === null || m.from === this.hostPeer)) return;
    this.clock.reset();
    this.headerLead = Number.NEGATIVE_INFINITY;
    // The retry point was in the old host's time; the new session's refusals are not older than it.
    this.retryAfterHostTime = null;
  }

  private newer(epoch: number, seq: number, hostNow: number): boolean {
    if (epoch !== this.epoch) return epoch > this.epoch;
    return seq !== this.seq ? seq > this.seq : hostNow > this.hostNow;
  }

  private async onSnapshot(m: Inbound, msg: Snapshot, receivedAt: number): Promise<void> {
    // Only our own view of this meeting, straight from the peer it names as host, and newer than the last.
    if (msg.state.boardId !== this.o.boardId || msg.host !== m.from || msg.you !== (await this.me)) return;
    if (!this.newer(msg.epoch, msg.seq, msg.hostNow)) return;
    this.newSessionClock(m, msg.epoch);
    // Only a newer snapshot over the direct path, whose sender the transport vouches for, shows this page the host's
    // time (a relay frame's sender is not authenticated). It feeds `at` alone, like a bundle header, never the clock.
    if (m.path === 'direct') this.headerLead = Math.max(this.headerLead, msg.hostNow - receivedAt);
    this.accept(m, msg.epoch, msg.seq, msg.hostNow, msg.state, msg.you, true);
  }

  // docs/product/sync-protocol.md, Accepting views. The bundle needs a usable entry for us: one in this bundle,
  // or one we hold from this epoch that is no older than the last full refresh. An entry from before the last
  // refresh is never combined with a newer shared part.
  private async onBundle(m: Inbound, body: Bytes, receivedAt: number): Promise<void> {
    const opened = await openBundle(body, this.o.hostPub);
    if (!opened) return;
    const { message, items } = opened;
    if (message.boardId !== this.o.boardId || message.host !== m.from) return;
    if (!this.newer(message.epoch, message.seq, message.hostNow)) return;
    this.newSessionClock(m, message.epoch);
    this.headerLead = Math.max(this.headerLead, message.hostNow - receivedAt);
    const me = await this.me;
    let ours = false;
    for (const item of items) {
      const entry = await openItem(this.o.roomKey, this.o.hostPub, item, me, message);
      if (!entry || !isPersonal(entry)) continue;
      ours = true;
      // Opening is asynchronous: an older bundle can finish after a newer one, and must not replace its entry.
      const held = this.entry;
      if (!held || message.epoch > held.epoch || (message.epoch === held.epoch && message.seq >= held.seq)) {
        this.entry = { personal: entry, epoch: message.epoch, seq: message.seq };
      }
      break;
    }
    // A full refresh carries an item for everyone the host knows. Without one for us, the host doesn't know this page
    // yet (it started after us, or our hello was lost): say hello now rather than wait for the back-off.
    if (message.refreshSeq === message.seq && !ours) this.helloSoon();
    const entry = this.entry;
    if (!entry || entry.epoch !== message.epoch || entry.seq < message.refreshSeq) return;
    const shared = withViewDefaults(message.shared as Record<string, unknown>);
    if (!shared) return;
    const view = withViewDefaults(mergeView(shared as unknown as SharedView, entry.personal) as unknown as Record<string, unknown>);
    if (!view) return;
    // A newer view may have been accepted while the entry was being opened.
    if (!this.newer(message.epoch, message.seq, message.hostNow)) return;
    this.clock.addRelayView(message.hostNow, receivedAt);
    this.accept(m, message.epoch, message.seq, message.hostNow, view, me, ours);
  }

  // Only an accepted view can change which peer is the host, so replaying an old one can't hijack anyone.
  // ours: the view carries our own entry (a snapshot always does), so the host knows this tab.
  private accept(m: Inbound, epoch: number, seq: number, hostNow: number, view: ViewState, you: string, ours: boolean): void {
    const newEpoch = this.epoch !== -1 && epoch !== this.epoch;
    const newHost = m.from !== this.hostPeer;
    this.setHost(m.from);
    this.lastHostMessageAt = this.now();
    if (m.path === 'direct') this.lastDirectHostAt = this.now();
    else if (newHost && this.transport.status(m.from) === 'direct') this.directProbeFrom = this.now();
    // Hearing from the host resets the hello back-off, and a view with our entry resets the prompted hellos' too.
    this.helloStep = 0;
    this.nextHelloAt = this.now() + HELLO_BACKOFF_MS[0];
    const stale = this.retryAfterHostTime !== null && hostNow < this.retryAfterHostTime;
    if (ours) {
      this.soonStep = 0;
      this.nextSoonAt = Number.NEGATIVE_INFINITY;
      // A refusal ignored as older than the latest retry doesn't stop the prompted hellos: that hello may be lost.
      this.refused = typeof view.joinRefused === 'string' && !stale;
    }
    if (this.pingAfterHello) {
      this.pingAfterHello = false;
      void this.ping();
    }
    // An outcome line only for a view that directly follows the last one this page saw (the next change, or the same
    // one refreshed), so a page that was offline or locked while the vote was decided never shows it late.
    const follows = epoch === this.epoch && (seq === this.seq + 1 || (seq === this.seq && hostNow > this.hostNow));
    const outcome = follows ? outcomeBetween(this.state, view) : null;
    this.epoch = epoch;
    this.seq = seq;
    this.hostNow = hostNow;
    this.lastViewAt = this.now();
    this.state = view;
    this.you = you;
    // A newer protocol 2 view from the host: it and this page speak the same version. The only way out of a mismatch.
    if (this.mismatch !== null) {
      this.mismatch = null;
      this.connection = 'connecting';
    }
    // Commands wait for a view that lists us as an attendee; then everything pending goes, from the oldest. A new host
    // session: send everything unacknowledged again, sealed with the new epoch.
    if (!this.amAttendee()) this.outbox.hold();
    else if (this.outbox.isHeld) this.outbox.release();
    else if (newEpoch) this.outbox.resendNow();
    // A host we haven't spoken to yet learns our path and that we're here.
    if (newHost) void this.hello();
    // Own keys only, and only the shapes we expect, so a strange entry can't reach Object.prototype or the outbox.
    const ack: unknown = Object.hasOwn(view.acks, this.sid) ? view.acks[this.sid] : undefined;
    if (Number.isSafeInteger(ack)) this.outbox.ack(ack as number);
    const reject: unknown = Object.hasOwn(view.rejects, this.sid) ? view.rejects[this.sid] : undefined;
    if (typeof reject === 'object' && reject !== null && Number.isSafeInteger((reject as { clientSeq?: unknown }).clientSeq)) {
      const { clientSeq, key } = reject as { clientSeq: number; key: unknown };
      // notAttendee: the command reached the host before our join. It stays pending, held until a view lists us as
      // an attendee, and is then sent again; the host kept nothing of it, so it applies from clientSeq 1 as usual.
      if (key !== 'notAttendee' && !this.shownRejects.has(clientSeq)) {
        this.shownRejects.add(clientSeq);
        const message = typeof key === 'string' && Object.hasOwn(MESSAGES, key) ? (MESSAGES as Record<string, string>)[key] : MESSAGES.badCommand;
        this.o.onReject?.(message, clientSeq);
        if ((key === 'staleTab' || key === 'tooManyTabs') && !this.staleTab) {
          this.staleTab = true;
          this.staleTabMessage = message;
          this.o.onStatus?.();
        }
      }
    }
    // A view without our entry says nothing about a refusal: keep what was shown. Someone who is already an attendee
    // (a rename refused at the size cap) keeps the board: only a person who isn't one is sent back to the join form.
    // A view built before the host could have handled the latest takePart() may still carry the refusal that came
    // before it, so a refusal counts only once the host's clock for the view has passed that point and the grace.
    if (ours) {
      const refusal = typeof view.joinRefused === 'string' && !this.amAttendee() && !stale ? view.joinRefused : null;
      if (refusal !== this.joinRefused) {
        this.joinRefused = refusal;
        this.o.onStatus?.();
      }
    }
    if (outcome) this.o.onOutcome?.(outcome);
    this.updateConnection();
    this.o.onState?.(view, you);
  }

  private async seal(msg: ToHost, pv: 1 | 2 = 2): Promise<Bytes> {
    return encodeWire(this.o.roomKey, await sealEnvelope(this.o.signer, msg), pv);
  }

  // One command, direct once the direct path is proven; otherwise on the relay, to the host's peer, after its turn in
  // the relay budget. The wait can outlast an ack, a new epoch or a new host, so the command is checked, and sealed
  // with the current epoch, only after it. Returns false if the host changed (stop the queue). A failed send is
  // logged, never thrown, so the queue keeps going; the outbox resends anything unacked.
  private async sendCommand(host: string, item: Outgoing<Command>): Promise<boolean> {
    try {
      if (!this.directProven()) await this.relayBudget.take();
      if (host !== this.hostPeer) return false;
      // Acknowledged while it waited: nothing to send.
      if (item.clientSeq < (this.outbox.unacknowledged[0]?.clientSeq ?? Infinity)) return true;
      const msg: ToHost = { t: 'cmd', boardId: this.o.boardId, peer: this.transport.selfId, clientSeq: item.clientSeq, sid: this.sid, epoch: this.epoch, cmd: item.cmd };
      // Held by the relay transport, a command may be the only copy left once the outbox stops resending it (in the
      // window after its last resend, once failed, or while held), so it is lasting; a resend replaces its own held
      // copy, nothing else. Once acknowledged, or while a resend of it is still to come, its held copy may make way
      // for a fresh hello.
      const kind = `cmd ${this.sid} ${item.clientSeq}`;
      const acknowledged = () => !this.outbox.unacknowledged.some((pending) => pending.clientSeq === item.clientSeq);
      const expendable = () => acknowledged() || this.outbox.willResend(item.clientSeq);
      await this.transport.sendVia(host, await this.seal(msg), this.directProven() ? 'direct' : 'relay', { lasting: true, kind, supersedes: [kind], expendable });
    } catch (err) {
      console.warn('Could not send a message', err);
    }
    return true;
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

// The shape mergeView reads, so a strange entry is refused rather than throwing.
function isPersonal(x: Record<string, unknown>): x is Record<string, unknown> & PersonalView {
  return typeof x.you === 'string' && typeof x.role === 'string' && isRecord(x.mine) && typeof x.voted === 'boolean'
    && isRecord(x.acks) && isRecord(x.rejects) && (x.totals === undefined || isRecord(x.totals))
    && (x.joinRefused === undefined || typeof x.joinRefused === 'string');
}
