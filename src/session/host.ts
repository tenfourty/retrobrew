import { generateSecretKey } from 'nostr-tools';
import { fingerprint, type Signer } from '../crypto/sign';
import { openTimeUpVote } from '../engine/discussion';
import { boardOverLimits, MAX_ATTENDEES, RELAY_EVENT_MAX_BYTES, type Measure } from '../engine/limits';
import type { MessageKey } from '../engine/messages';
import { parseCommand } from '../engine/parse';
import { refuse } from '../engine/result';
import { mergeView, redactFor, sharedView } from '../engine/redact';
import type { BoardState, Command, Result, ViewContext, ViewState } from '../engine/types';
import { encodeBundle } from '../protocol/bundle';
import { decodeFrame, encodeWire, openEnvelope, sealEnvelope } from '../protocol/envelope';
import { parseToHost, versionReplyState, type CmdMessage, type Hello, type Ping, type ToPeer } from '../protocol/messages';
import { bundleRecipients, relayEventBytes, TOPIC_PLACEHOLDER, type Refusal } from '../protocol/size';
import { PROTOCOL_VERSION, VERSION_MESSAGE } from '../protocol/version';
import { toRoomTransport } from '../transport/room';
import type { Inbound, Path, PeerStatus, RelayHealth, RoomTransport, Transport } from '../transport/types';
import { measuredApply } from './measured';
import { outcomeBetween, type Outcome } from './outcome';
import type { Connection } from './participant';
import { Pacer, RELAY_GAP_MS } from './pacer';
import { bundleFields, entryContext, fitBundle, neutralItem, personalItem, type PersonalItem } from './refresh';
import { GoneFilter } from './gone-filter';
import { RESEND_AFTER_MS } from './outbox';
import { every, MonotonicClock, realScheduler, type Scheduler } from './scheduler';
import { FreshMemory } from './fresh';
import { PerPersonSet } from './per-person';
import { classify, MAX_TABLE_ENTRIES, MAX_TABS_PER_PERSON, parseTabTable, prune, recordOutcome, type StaleTab, type TabTable } from './tabs';

// What the host saves in one write: the board and the tab table (BoardRecord.state and BoardRecord.tabs).
export interface SavedBoard {
  state: BoardState;
  tabs: TabTable;
}

export interface HostOptions {
  transport: Transport | RoomTransport;
  roomKey: CryptoKey;
  signer: Signer;
  hostId: string;
  state: BoardState;
  epoch: number;
  // The saved tab table, so duplicates are still recognised after a host reload.
  tabs?: TabTable;
  scheduler?: Scheduler;
  // The host's clock for the board and views. Defaults to the scheduler's.
  now?: () => number;
  // Runs fn every ms and returns a cancel function. Injected so tests can drive the tick by hand.
  every?: (fn: () => void, ms: number) => () => void;
  // Measures a growing change's full refresh for the size cap: an upper bound from two real deflates and fixed overheads (src/protocol/size.ts).
  measure: Measure;
  // The largest relay event the host sends, never above RELAY_EVENT_MAX_BYTES. Tests make it small to reach the ceiling.
  eventLimit?: number;
  // Saves the board and tab table together. Views and acks go out only after it resolves.
  save?: (saved: SavedBoard) => Promise<void>;
  onChange?: (state: BoardState, version: { epoch: number; seq: number }) => void;
  // Called when the peer records change, and when someone drops out of `online`.
  onPresence?: () => void;
  // Called with every relay's state whenever it changes, for the connection details.
  onHealth?: (health: RelayHealth[]) => void;
  // Called when connection, saveFailed, overLimits or oversize changes.
  onStatus?: () => void;
  // The facilitator decided a time-up vote: everyone sees a one-line outcome for a few seconds.
  onOutcome?: (outcome: Outcome) => void;
}

export interface PresenceEntry {
  participantId: string;
  peerId: string;
  status: PeerStatus;
}

// What the host knows of one transport peer speaking for one signing key. A relay frame's `from` is only a claim,
// so a message signed by someone else that names the same peer gets a record of its own and never changes this one
// (docs/product/sync-protocol.md, Signed messages carry their context).
interface PeerRecord {
  peerId: string;
  personId: string;
  pv: number;
  lastPath: Path;
  lastHeardAt: number; // the bind (its age, for the 60 s expiry), then each accepted command or ping: presence
  lastDirectAt: number;
  boundAt: number;
  // Bound by a hello but not yet heard from by an accepted command or ping. A hello can be an old one replayed, so
  // binding alone never makes a record recent: probationary records go first when a signer has too many.
  probation: boolean;
  // A record with another pv is a version-reply record only: it gets the version reply, nothing else from it is
  // processed, and it is never in presence, `online` or a bundle. When it last got a reply.
  versionReplyAt?: number;
  // The timer of a refused version reply that will try once more.
  versionRetry?: unknown;
}

const TICK_MS = 1000;
// docs/product/sync-protocol.md, Offline thresholds and Joining.
export const ONLINE_MS = 15_000;
export const DIRECT_SILENCE_MS = 10_000;
export const JOIN_REFUSED_MS = 30_000;
// A ping counts only if its estimate of the host's clock is within this of it.
export const PING_FRESH_MS = 60_000;
// A refused joiner saying hello again with the same name gets its refusal again at most this often.
export const REFUSED_HELLO_MS = 5000;
// At most this many refused joiners are remembered at once, the latest kept: signers minted with the room key could
// otherwise grow the list for 30 s. A bundle carries only the latest few (REFUSED_ENTRIES_MAX); one that was dropped
// says hello again.
export const JOIN_REFUSED_MAX = 64;
export const NO_RELAYS_MS = 10_000;
const CHECK_MS = 1000;
// Peer records are bounded: one not heard from for 60 s goes at the next tick (every second), and a signer has at most
// eight, the least recently heard going first. A participant whose record went binds again with its next hello.
export const PEER_RECORD_TTL_MS = 60_000;
export const PEER_RECORDS_PER_SIGNER = 8;
// At most one version reply per peer record every 5 s.
export const VERSION_REPLY_MS = 5000;
// At most this many version-reply records (peers on another protocol version) are held at once across all signers,
// the oldest going first: signers minted with the room key could otherwise grow the table for 60 s. They never
// displace a protocol 2 record.
export const VERSION_RECORDS_MAX = 64;
// A gap in a tab's commands that the participant's resends haven't filled after three full resend cycles (its 3 s ones)
// never will be (the host's table is behind the participant's, after a restore or a lost save): the tab is refused with staleTab.
// Three cycles, so one or two lost resends on a lossy network don't end a tab.
export const GAP_REFUSE_MS = 3 * RESEND_AFTER_MS + 2000;
// How long a refused tab's reject, or a resent tab's listing note, stays in the views.
export const STALE_KEEP_MS = 5 * 60_000;
export const RESENT_KEEP_MS = 10_000;
// Replies the host sends because one message arrived, with nothing saved: a notAttendee refusal, a version reply, or
// a refused join's snapshot. Each kind has its own cap, ONE_OFF_MAX every ONE_OFF_WINDOW_MS, so a flood of one can't
// use up another's; at most one per kind, peer and signer in that window; and on the relay only in a slot no bundle
// needs. A reply to an attendee with a bound record doesn't count against the cap. One past that is dropped; its
// sender sends again.
export const ONE_OFF_WINDOW_MS = 5000;
export const ONE_OFF_MAX = 5;
interface RefusedJoin { key: MessageKey; until: number; name: string; peerId: string; path: Path; answeredAt: number }
type OneOffKind = 'notAttendee' | 'version' | 'joinRefused' | 'staleHello';

function everyInterval(fn: () => void, ms: number): () => void {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

export class HostSession {
  saveFailed = false;
  // The same union as a participant's, for the screens. The host is only ever 'connected', or 'noRelays' after 10 s
  // with no relay socket open: "Can't reach the meeting network. Check your connection."
  connection: Connection = 'connected';
  // A host applies its own changes, so they never wait on anyone: always false (saveFailed is its equivalent).
  readonly pendingFailed = false;
  // A saved or imported board that breaks a limit loads unchanged; growth is refused until it fits, and the
  // facilitator is told: "This meeting is bigger than Retrobrew's limits…".
  overLimits = false;
  // A bundle was still over the relay limit after trimming (src/session/refresh.ts, fitBundle): the facilitator sees a
  // banner (src/app/banners.ts), growth is refused until a full refresh fits again, and oversizeCount counts them for the connection details.
  oversize = false;
  oversizeCount = 0;
  private working: BoardState; // the latest board, saved or not
  private tabs: TabTable;
  private seq = 0;
  // The last saved board and tab table. Every view and ack is built from this, never from an unsaved change.
  private published: { state: BoardState; tabs: TabTable; seq: number };
  private readonly transport: RoomTransport;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private readonly hostClock: MonotonicClock;
  // The facilitator's countdown reads the host's clock from here, so it never runs backwards when the system clock does.
  hostNow(): number { return this.hostClock.next(); }
  // "peer person" -> record. Only an accepted hello creates a record; commands and pings refresh an existing one.
  private readonly peers = new Map<string, PeerRecord>();
  // What each signer's accepted pings and hellos counted up to (src/session/fresh.ts). Kept for as long as a copy could
  // still be fresh, not for as long as the signer has a record. Only a signer with a record can add a ping count.
  // The attendees' pool has no count cap of its own: it holds at most MAX_TABS_PER_PERSON per attendee, and an imported
  // board over the usual limit can have many more attendees than a meeting does. Strangers' pool: MAX_TABLE_ENTRIES.
  private readonly pings = new FreshMemory(PING_FRESH_MS, MAX_TABS_PER_PERSON, Infinity, MAX_TABLE_ENTRIES);
  private readonly hellos = new FreshMemory(PING_FRESH_MS, MAX_TABS_PER_PERSON, Infinity, MAX_TABLE_ENTRIES);
  private readonly heardFrom = new Map<string, number>(); // person -> last accepted command or ping from a known peer
  // Tabs whose gap was refused, and tab refusals already made ("key sid"): exact, and bounded per person so one signer
  // making many can't push out another's (src/session/per-person.ts).
  private readonly gapRefused = new PerPersonSet(4 * MAX_TABS_PER_PERSON, 10 * MAX_ATTENDEES);
  private readonly refusedOnce = new PerPersonSet(8 * MAX_TABS_PER_PERSON, 10 * MAX_ATTENDEES);
  private readonly stale = new Map<string, StaleTab>();
  private readonly buffered = new Map<string, Map<number, unknown>>(); // "person sid" -> clientSeq -> command
  // "person sid" -> when the tab last resent a duplicate. In memory only: it ranks which tabs a view lists, and
  // never touches the saved table.
  private readonly listed = new Map<string, number>();
  private readonly gapSince = new Map<string, number>(); // "person sid" -> when its first buffered command arrived
  // Every sid that has left the tab table this session, so none of its commands is ever applied again.
  private readonly gone = new GoneFilter();
  private readonly oneOffAt = new Map<string, number>(); // "kind peer person" -> when it last had a one-off reply
  // Each kind's capped one-off replies in the last ONE_OFF_WINDOW_MS.
  private readonly oneOffTimes = new Map<OneOffKind, number[]>();
  // People refused a join in the last 30 s, with the peer and path the refusal goes back on and when it last went. Not
  // attendees, so never heard, online or in presence. Always written through noteJoinRefused, which caps it.
  private readonly joinRefused = new Map<string, RefusedJoin>();
  private readonly pacer: Pacer;
  // Each person's entry as the last full refresh carried it. A change bundle carries only entries that differ.
  private lastFullEntries = new Map<string, string>();
  // People whose entry differed from the last full refresh in some bundle since it. Their entry stays in every
  // bundle until the next refresh, so one that changes back is never left out while a participant holds the
  // changed one.
  private changedSinceFull = new Set<string>();
  // People whose entry goes in the next bundle even if it hasn't changed (a repeated hello, a duplicate command).
  private readonly forced = new Set<string>();
  // Who gets a direct snapshot in the next flush: everyone after a change to the board or presence, otherwise
  // only the people whose own view changed.
  private directDirty: 'all' | Set<string> = new Set();
  private refreshSeq = 0;
  // Bundles are built in order and published one at a time, so a slow seal never puts an older one after a newer one.
  private bundles: Promise<void> = Promise.resolve();
  // Signs nothing: it only gives measured relay events their real length (src/session/refresh.ts, fitBundle).
  private readonly eventKey = generateSecretKey();
  private relaysDownSince: number | null = null;
  private healthBefore = '';
  private onlineBefore = '';
  private readonly stopChecking: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  private cancelTick?: () => void;
  private closed = false;

  constructor(private readonly o: HostOptions) {
    this.transport = toRoomTransport(o.transport);
    this.scheduler = o.scheduler ?? realScheduler;
    this.now = o.now ?? (() => this.scheduler.now());
    this.hostClock = new MonotonicClock(this.now);
    this.working = o.state;
    // A stored table came from IndexedDB, a file or a structured clone: check it, never trust it as it is.
    // Malformed or reserved keys are dropped; a table that is malformed elsewhere starts afresh.
    // It is also brought within the tab bounds (src/session/tabs.ts).
    this.tabs = prune(parseTabTable(o.tabs ?? {}, this.now()) ?? parseTabTable({}, this.now())!, this.now());
    this.published = { state: o.state, tabs: this.tabs, seq: 0 };
    this.transport.onInbound((m) => {
      this.receive(m).catch((err) => console.warn('Could not handle a message', err));
    });
    this.transport.onPeerLeave((peerId) => {
      let left = false;
      for (const [key, peer] of this.peers) if (peer.peerId === peerId) left = this.peers.delete(key) || left;
      if (left) o.onPresence?.();
    });
    // From now until stop(), the pacer sends everything: a full refresh straight away and every 5 s.
    this.pacer = new Pacer({
      scheduler: this.scheduler,
      sendDirect: (full) => this.sendDirect(full),
      sendBundle: (full) => this.sendBundle(full),
    });
    this.pacer.start();
    this.stopChecking = every(this.scheduler, CHECK_MS, () => this.check());
    void this.enqueue(() => this.checkLimits());
  }

  get current(): BoardState {
    return this.working;
  }

  get version(): { epoch: number; seq: number } {
    return { epoch: this.o.epoch, seq: this.seq };
  }

  // The host's own commands. They have no tab, so nothing to acknowledge.
  local(cmd: Command): Promise<Result> {
    return this.enqueue(async () => {
      const result = await this.run(this.o.hostId, cmd);
      if (result.ok && result.changed) await this.persist();
      return result;
    });
  }

  // Time up is a host tick, not a command, but it goes through the same path: seq goes up,
  // the board is saved and sent. It does nothing until a timer runs out, and opens each vote once.
  tick(now: number): Promise<Result> {
    return this.enqueue(async (): Promise<Result> => {
      this.expirePeers();
      const next = this.closed ? null : openTimeUpVote(this.working, now);
      if (!next) return { ok: true, state: this.working, changed: false };
      this.working = next;
      this.seq += 1;
      await this.persist();
      return { ok: true, state: next, changed: true };
    });
  }

  // Ticks once straight away, so a timer that ran out while the host was away opens its vote, then every second.
  startTicking(): void {
    this.cancelTick?.();
    this.cancelTick = (this.o.every ?? everyInterval)(() => this.safeTick(), TICK_MS);
    this.safeTick();
  }

  private safeTick(): void {
    this.tick(this.now()).catch((err) => console.warn('Tick failed', err));
  }

  // Stops the tick and everything the host sends.
  stop(): void {
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.pacer.stop();
    this.stopChecking();
    for (const peer of this.peers.values()) this.cancelVersionRetry(peer);
  }

  // Ends the session for good: anything queued or being measured is dropped, never committed, saved or sent.
  close(): void {
    this.closed = true;
    this.stop();
  }

  // The host's own tab became visible again: reconnect and resubscribe the relays, have the direct path bring back
  // any participant's link lost while the tab was hidden (with no focus: every link counts), send a full refresh, and
  // run the tick, so a timer that ran out while the phone was locked opens its vote. (The controller renews the wake
  // lock.)
  resume(): void {
    if (this.closed) return;
    this.transport.resume();
    this.pacer.refresh();
    this.safeTick();
  }

  // The connection banner's Retry: reconnect the relays and send a full refresh now.
  retry(): void {
    this.resume();
  }

  // Each relay, open or not, with its OK false and NOTICE counts, for the connection details.
  relayHealth(): RelayHealth[] {
    return this.transport.relayHealth();
  }

  // Once a second: tell the views when someone drops out of `online`, forget old refusals, resend notes and gaps,
  // and watch the relay sockets.
  private check(): void {
    const now = this.now();
    for (const [personId, s] of this.stale) {
      if (now - s.at <= STALE_KEEP_MS) continue;
      this.stale.delete(personId);
      this.changed(personId);
    }
    for (const [key, at] of this.listed) if (now - at > RESENT_KEEP_MS) this.listed.delete(key);
    for (const [personId, refused] of this.joinRefused) if (refused.until <= now) this.joinRefused.delete(personId);
    for (const [key, at] of this.oneOffAt) if (now - at >= ONE_OFF_WINDOW_MS) this.oneOffAt.delete(key);
    for (const [key, since] of this.gapSince) {
      if (now - since < GAP_REFUSE_MS) continue;
      // The participant stops resending after three cycles, so the refusal can't wait for another arrival.
      const buffer = this.buffered.get(key);
      this.gapSince.delete(key);
      this.buffered.delete(key);
      if (!buffer?.size) continue;
      const personId = key.slice(0, key.lastIndexOf(' '));
      this.gapRefused.add(personId, key.slice(personId.length + 1));
      this.refuseTab(personId, key.slice(personId.length + 1), Math.max(...buffer.keys()), 'staleTab');
    }
    const online = this.online().join(' ');
    if (online !== this.onlineBefore) {
      this.onlineBefore = online;
      this.o.onPresence?.();
    }
    const health = this.transport.relayHealth();
    const healthNow = JSON.stringify(health);
    if (healthNow !== this.healthBefore) {
      this.healthBefore = healthNow;
      this.o.onHealth?.(health);
    }
    const allDown = health.length > 0 && health.every((relay) => !relay.connected);
    this.relaysDownSince = allDown ? this.relaysDownSince ?? now : null;
    const next = this.relaysDownSince !== null && now - this.relaysDownSince >= NO_RELAYS_MS ? 'noRelays' : 'connected';
    if (next === this.connection) return;
    this.connection = next;
    this.o.onStatus?.();
  }

  // The host, and everyone heard from in the last 15 s.
  online(): string[] {
    const cutoff = this.now() - ONLINE_MS;
    const recent = [...this.heardFrom].filter(([, at]) => at >= cutoff).map(([id]) => id);
    return [...new Set([this.o.hostId, ...recent])];
  }

  presence(): PresenceEntry[] {
    return [...this.peers.values()].filter((peer) => peer.pv === PROTOCOL_VERSION).map((peer) => ({ participantId: peer.personId, peerId: peer.peerId, status: this.statusOf(peer) }));
  }

  private statusOf(peer: PeerRecord): PeerStatus {
    if (peer.probation || this.now() - peer.lastHeardAt > ONLINE_MS) return 'offline';
    return this.replyPath(peer) === 'direct' ? 'direct' : 'relayed';
  }

  // Direct only if the peer's last message came direct and the direct path carried one in the last 10 s.
  private replyPath(peer: PeerRecord | undefined): Path {
    return peer?.lastPath === 'direct' && this.now() - peer.lastDirectAt <= DIRECT_SILENCE_MS ? 'direct' : 'relay';
  }

  // Commands, ticks and saves run one at a time, in arrival order, because measuring and saving are asynchronous.
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async run(actor: string, cmd: Command): Promise<Result> {
    const unchanged: Result = { ok: true, state: this.working, changed: false };
    if (this.closed) return unchanged;
    // While bundles are over the relay limit, every growing change is refused, as if it measured over the cap.
    const measure = this.oversize ? () => Promise.resolve(Number.POSITIVE_INFINITY) : this.o.measure;
    const result = await measuredApply(this.working, actor, cmd, this.now(), measure);
    // Closed while measuring: drop the change, never commit, save or send it.
    if (this.closed) return unchanged;
    if (result.ok && result.changed) {
      this.working = result.state;
      this.seq += 1;
    }
    return result;
  }

  // Views carry the last saved board: save first, then publish. A failed save keeps the change in memory and sends
  // nothing built from it; the next change tries again, and once a save succeeds everything since goes out.
  private async persist(): Promise<void> {
    if (this.closed) return;
    this.pruneTabs();
    const pending = { state: this.working, tabs: this.tabs, seq: this.seq };
    try {
      await this.o.save?.({ state: pending.state, tabs: pending.tabs });
    } catch {
      this.setSaveFailed(true);
      return;
    }
    this.setSaveFailed(false);
    const boardChanged = pending.seq !== this.published.seq;
    const before = this.published.state;
    this.published = pending;
    if (boardChanged) {
      this.o.onChange?.(pending.state, this.version);
      // Only a change made while a time-up vote was open can decide one, so the board is redacted only then.
      if (before.continueVote) {
        const outcome = outcomeBetween(redactFor(before, this.o.hostId), redactFor(pending.state, this.o.hostId));
        if (outcome) this.o.onOutcome?.(outcome);
      }
    }
    // Commands can't take a board over a limit, so only a board that is over one needs checking again.
    if (boardChanged && this.overLimits) await this.checkLimits();
    this.changed();
  }

  private async checkLimits(): Promise<void> {
    if (this.closed) return;
    let over: boolean;
    try {
      over = boardOverLimits(this.working, await this.o.measure(this.working));
    } catch (err) {
      console.warn('Could not measure the board', err); // the notice stays as it was
      return;
    }
    if (over === this.overLimits || this.closed) return;
    this.overLimits = over;
    this.o.onStatus?.();
  }

  // Prunes the tab table, and forgets what memory holds for each pruned tab.
  private pruneTabs(): void {
    const before = this.tabs;
    this.tabs = prune(before, this.now());
    this.forgetGone(before);
  }

  // Forgets what memory holds for each tab that was in `before` but is no longer in the table (pruned, or dropped to
  // keep within the bounds): its buffered commands, its listing note and its gap.
  private forgetGone(before: TabTable): void {
    if (this.tabs === before) return;
    for (const [personId, person] of Object.entries(before)) {
      const kept = (Object.hasOwn(this.tabs, personId) ? this.tabs[personId].tabs : undefined) ?? {};
      for (const sid of Object.keys(person.tabs)) {
        if (Object.hasOwn(kept, sid)) continue;
        const key = `${personId} ${sid}`;
        this.buffered.delete(key);
        this.listed.delete(key);
        this.gapSince.delete(key);
        this.gone.add(personId, sid);
      }
    }
  }

  // Removes every record not heard from for PEER_RECORD_TTL_MS.
  private expirePeers(): void {
    const cutoff = this.now() - PEER_RECORD_TTL_MS;
    let removed = false;
    for (const [key, peer] of this.peers) if (peer.lastHeardAt < cutoff) removed = this.peers.delete(key) || removed;
    if (removed) this.o.onPresence?.();
    // What the ping and hello counts remember is dropped once a copy could no longer be fresh.
    this.pings.sweep(this.now());
    this.hellos.sweep(this.now());
  }

  private setSaveFailed(failed: boolean): void {
    if (failed === this.saveFailed) return;
    this.saveFailed = failed;
    this.o.onStatus?.();
  }

  private async receive(m: Inbound): Promise<void> {
    if (m.echo || this.closed) return;
    const frame = await decodeFrame(this.o.roomKey, m.data);
    if (frame?.kind !== 'envelope') return;
    const opened = await openEnvelope(frame.env);
    const msg = opened && parseToHost(opened.message, frame.pv);
    if (!opened || !msg) return;
    const personId = await fingerprint(opened.pub);
    if (msg.t === 'hello') {
      await this.onHello(m, personId, msg);
      return;
    }
    // A peer on another protocol version gets only the version reply; everything else from it is ignored. The record is
    // this peer and signer's own, so a forged hello under another key never stops anyone else's commands.
    if ((this.peers.get(`${m.from} ${personId}`)?.pv ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) return;
    if (msg.t === 'ping') {
      // The ping must come from the peer it names, for this meeting. Pings are answered only over the direct path.
      if (msg.peer !== m.from || msg.boardId !== this.working.boardId || !this.acceptPing(msg, personId)) return;
      if (!this.heard(m, personId)) return;
      if (m.path === 'direct') await this.sendTo(m.from, { t: 'pong', t0: msg.t0, t1: this.now() }, 'direct', false, this.peers.get(`${m.from} ${personId}`));
      return;
    }
    await this.onCommand(m, personId, msg);
  }

  // A ping counts once: only from a peer with a record for this signer, newer than the last accepted from that tab, and
  // within PING_FRESH_MS of the host's clock. All of it before anyone is marked heard, so a replay keeps nobody online.
  private acceptPing(msg: Ping, personId: string): boolean {
    const peer = this.peers.get(`${msg.peer} ${personId}`);
    if (!peer || peer.pv !== PROTOCOL_VERSION) return false;
    return this.pings.accept(personId, msg.sid, msg.n, msg.at, this.now(), Object.hasOwn(this.working.attendees, personId));
  }

  // A command or ping from a peer that has said hello as this person: they are online, and this is the path to
  // reply on. Returns false, changing nothing, if there is no record for this peer and signer: commands and pings
  // never create or rebind one.
  private heard(m: Inbound, personId: string): boolean {
    const peer = this.peers.get(`${m.from} ${personId}`);
    if (!peer || peer.pv !== PROTOCOL_VERSION) return false;
    const now = this.now();
    const wasOnline = !peer.probation && now - peer.lastHeardAt <= ONLINE_MS;
    peer.lastPath = m.path;
    peer.lastHeardAt = now;
    const leftProbation = peer.probation;
    peer.probation = false;
    if (m.path === 'direct') peer.lastDirectAt = now;
    const personWasOnline = (this.heardFrom.get(personId) ?? Number.NEGATIVE_INFINITY) >= now - ONLINE_MS;
    this.heardFrom.set(personId, now);
    if (!wasOnline) this.o.onPresence?.();
    // Someone came online: `online` changed, so a presence-only flush, with no save.
    if (!personWasOnline) this.changed();
    // Out of probation: the full view, with the person's own entry, in the next flush (direct and in the bundle).
    else if (leftProbation) this.changed(personId);
    return true;
  }

  // An accepted (fresh) join creates a probationary record for this peer and signer. A new record counts as heard only
  // once an accepted ping, or a command that applies, comes from it (heard), so a hello alone never makes anyone online,
  // and a repeat hello from the same pair changes nothing. The record's age starts here, for its expiry. Returns false if the signer already has
  // its full eight and none can go: then there is no record and no view, and the client tries again with its next hello.
  private bind(m: Inbound, personId: string): boolean {
    const key = `${m.from} ${personId}`;
    const before = this.peers.get(key);
    if (before?.pv === PROTOCOL_VERSION) return true;
    // A version-reply record for the same peer and signer is replaced: this hello is protocol 2.
    if (before) this.peers.delete(key);
    const now = this.now();
    if (!this.makeRoom(personId, now)) return false;
    this.peers.set(key, {
      peerId: m.from, personId, pv: PROTOCOL_VERSION, lastPath: m.path, lastHeardAt: now,
      lastDirectAt: m.path === 'direct' ? now : Number.NEGATIVE_INFINITY, boundAt: now, probation: true,
    });
    this.o.onPresence?.();
    return true;
  }

  // Makes room for one more version-reply record: the oldest goes if VERSION_RECORDS_MAX are held.
  private capVersionRecords(): void {
    let count = 0;
    let oldest: string | null = null;
    for (const [key, peer] of this.peers) {
      if (peer.pv === PROTOCOL_VERSION) continue;
      count += 1;
      if (oldest === null || peer.boundAt < this.peers.get(oldest)!.boundAt) oldest = key;
    }
    if (count >= VERSION_RECORDS_MAX && oldest !== null) this.peers.delete(oldest);
  }

  // Makes room for one more record for this signer, evicting one if it already has its full eight. False if none may go.
  private makeRoom(personId: string, now: number): boolean {
    const theirs = [...this.peers].filter(([, peer]) => peer.personId === personId);
    if (theirs.length < PEER_RECORDS_PER_SIGNER) return true;
    const victim = this.evictable(theirs, now);
    if (!victim) return false;
    this.peers.delete(victim);
    return true;
  }

  // Which of a signer's records makes way for a new one: the probationary record bound first; otherwise the record
  // heard from least recently, but never one heard from in the last ONLINE_MS, so replayed hellos can't push out a
  // live tab. Null if none may go.
  private evictable(theirs: Array<[string, PeerRecord]>, now: number): string | null {
    const probation = theirs.filter(([, peer]) => peer.probation).sort(([, a], [, b]) => a.boundAt - b.boundAt);
    if (probation.length) return probation[0][0];
    const quiet = theirs.filter(([, peer]) => now - peer.lastHeardAt > ONLINE_MS).sort(([, a], [, b]) => a.lastHeardAt - b.lastHeardAt);
    return quiet.length ? quiet[0][0] : null;
  }

  private async onHello(m: Inbound, personId: string, hello: Hello): Promise<void> {
    // The hello must come from the peer it names, so a copy replayed from elsewhere can't claim someone's view.
    if (hello.peer !== m.from) return;
    if (hello.pv !== PROTOCOL_VERSION) {
      // Protocol 1 hellos name no meeting; a later version's must name this one.
      if (hello.boardId === null || hello.boardId === this.working.boardId) await this.versionReply(m, personId, hello);
      return;
    }
    if (hello.boardId !== this.working.boardId) return;
    // A join or rename needs a fresh hello: the tab, a count newer than the last accepted from it, and the sender's idea
    // of the host's clock within PING_FRESH_MS. Anything else, a copy of an old hello included, changes nothing at
    // all: no join, no rename, no record.
    if (hello.sid === undefined || hello.n === undefined || hello.at === undefined) return;
    this.answerStaleClock(m, personId, hello.at);
    if (!this.hellos.accept(personId, hello.sid, hello.n, hello.at, this.now(), Object.hasOwn(this.working.attendees, personId))) return;
    if (this.answerRefusedAgain(m, personId, hello)) return;
    await this.enqueue(async () => {
      if (this.closed) return;
      // Hellos queued behind the first refusal check again, so duplicates sent at once run the join only once.
      if (this.answerRefusedAgain(m, personId, hello)) return;
      const result = await this.run(personId, { type: 'join', name: hello.name });
      if (!result.ok) {
        // A refused join has no tab to acknowledge, so the refusal travels in a view to the sender alone. A new
        // joiner refused gets no record: not online, not in presence, and no later views. Someone already an
        // attendee (a rename refused at the size cap, say) keeps their old name, their record and their views.
        this.noteJoinRefused(personId, result.key, hello.name, m);
        // The refusal goes in that person's bundle entry for 30 s (src/protocol/size.ts, bundleRecipients), and as a
        // direct snapshot if the hello came direct. A refused binding (all eight of their records live) still lets
        // the refusal itself through.
        if (Object.hasOwn(this.working.attendees, personId)) this.bind(m, personId);
        const peer = this.peers.get(`${m.from} ${personId}`);
        if ((!peer || peer.pv !== PROTOCOL_VERSION) && m.path === 'direct' && this.takeOneOff('joinRefused', m.from, personId, 'direct')) {
          void this.sendSnapshot(m.from, personId, 'direct');
        }
        this.changed(personId);
        return;
      }
      this.joinRefused.delete(personId);
      const bound = this.bind(m, personId);
      if (result.changed) await this.persist();
      else if (bound) this.changed(personId); // nothing changed: seq stays, and only the sender's entry goes out
    });
  }

  // A hello whose `at` is outside the freshness window is still ignored: no join, no count, no record. Over the direct
  // path (a peer id the transport vouches for, so a copy cannot arrive as someone else), and only if the sender has no
  // live record, the sender gets the shared view once, like a refused joiner, so its page learns the host's clock from
  // a snapshot and says hello again with a fresh `at`. A page whose relays are down has no other way to learn it.
  private answerStaleClock(m: Inbound, personId: string, at: number): void {
    if (m.path !== 'direct' || Math.abs(at - this.now()) <= PING_FRESH_MS) return;
    // A tab with a live record already has its views, and a neutral one would replace its own for a moment.
    if (this.peers.get(`${m.from} ${personId}`)?.pv === PROTOCOL_VERSION) return;
    if (this.takeOneOff('staleHello', m.from, personId, 'direct')) void this.sendSnapshot(m.from, personId, 'direct');
  }

  // The same refused hello again (same signer and name, refusal still live, not an attendee): no new join, and the
  // refusal goes again at most every REFUSED_HELLO_MS (a meetingFullSize refusal runs the join again after that),
  // on the path this hello came on. True if it was handled here.
  // An attendee's hello always runs, so a new tab still binds; one the 64-entry cap forgot runs as a new refusal,
  // and its snapshot is still held to one per 5 s by takeOneOff.
  private answerRefusedAgain(m: Inbound, personId: string, hello: Hello): boolean {
    const refused = this.joinRefused.get(personId);
    const now = this.now();
    if (!refused || refused.until <= now || refused.name !== hello.name || Object.hasOwn(this.working.attendees, personId)) return false;
    if (now - refused.answeredAt < REFUSED_HELLO_MS) return true;
    // A size refusal can clear when the board shrinks, so after 5 s the join runs again; the other refusals (an empty
    // name, a full meeting) can't, and are answered from memory.
    if (refused.key === 'meetingFullSize') return false;
    refused.peerId = m.from;
    refused.path = m.path;
    refused.answeredAt = now;
    if (m.path === 'direct' && this.takeOneOff('joinRefused', m.from, personId, 'direct')) void this.sendSnapshot(m.from, personId, 'direct');
    this.changed(personId);
    return true;
  }

  // docs/product/sync-protocol.md, Protocol version. A hello from another version gets a protocol 1 snapshot, which
  // code of any version accepts from its host: the host's epoch, the right `you` and `host`, and a minimal board whose
  // name tells the person to reload. No topics and nobody else's data: the only attendee is the sender, under the name
  // it sent. At most once per peer and signer every 5 s, and only in a relay slot no bundle needs (shed first).
  // The record is this peer and signer's own, within the signer's eight. A live protocol 2 record for the same pair is
  // never downgraded: a page's version can't change, so that hello is an old one replayed.
  private async versionReply(m: Inbound, personId: string, hello: Hello): Promise<void> {
    if (this.closed) return;
    const key = `${m.from} ${personId}`;
    const now = this.now();
    const before = this.peers.get(key);
    if (before?.pv === PROTOCOL_VERSION) return;
    if (before && before.pv === hello.pv && now - (before.versionReplyAt ?? Number.NEGATIVE_INFINITY) < VERSION_REPLY_MS) return;
    if (!before && !this.makeRoom(personId, now)) return;
    if (!before) this.capVersionRecords();
    const peer: PeerRecord = {
      peerId: m.from, personId, pv: hello.pv, lastPath: 'relay', lastHeardAt: now, lastDirectAt: Number.NEGATIVE_INFINITY,
      boundAt: before?.boundAt ?? now, probation: true, versionReplyAt: before?.versionReplyAt,
    };
    this.peers.set(key, peer);
    await this.sendVersionReply(peer, hello.name, true);
  }

  // A protocol 1 tab says hello every 5 s and the full refresh takes a relay slot every 5 s, so a hello can keep
  // arriving just after a refresh. A refused reply (no spare slot, or a one-off limit) tries once more a relay gap
  // later, through the same limits; refused again, it is dropped, not queued, and the peer's next hello tries again.
  private async sendVersionReply(peer: PeerRecord, name: string, mayRetry: boolean): Promise<void> {
    const { peerId, personId } = peer;
    if (this.closed || this.peers.get(`${peerId} ${personId}`) !== peer) return;
    if (!this.takeOneOff('version', peerId, personId, 'relay')) {
      if (!mayRetry || peer.versionRetry !== undefined) return;
      peer.versionRetry = this.scheduler.setTimeout(() => {
        peer.versionRetry = undefined;
        void this.sendVersionReply(peer, name, false);
      }, RELAY_GAP_MS);
      return;
    }
    peer.versionReplyAt = this.now();
    const reply = {
      t: 'snapshot', epoch: this.o.epoch, seq: this.published.seq, you: personId, host: this.transport.selfId,
      state: versionReplyState(this.working.boardId, VERSION_MESSAGE, personId, name),
    };
    try {
      const data = await encodeWire(this.o.roomKey, await sealEnvelope(this.o.signer, reply), 1);
      if (!this.closed) await this.transport.sendVia(peerId, data, 'relay');
    } catch (err) {
      console.warn('Could not send a version reply', err);
    }
  }

  private cancelVersionRetry(peer: PeerRecord): void {
    if (peer.versionRetry === undefined) return;
    this.scheduler.clearTimeout(peer.versionRetry);
    peer.versionRetry = undefined;
  }

  // docs/product/sync-protocol.md, Commands: strictly in clientSeq order per tab, acknowledged after the save.
  private async onCommand(m: Inbound, personId: string, msg: CmdMessage): Promise<void> {
    if (msg.boardId !== this.working.boardId) return; // another meeting: dropped without a trace
    // The command names the peer it was sent from, like a ping: a copy arriving under another peer ID is dropped.
    if (msg.peer !== m.from) return;
    if (msg.epoch !== this.o.epoch) return; // an earlier host session: the participant resends with this epoch
    // Every command goes through classify. A dropped one (a malformed sid, or beyond the reorder window) gets
    // nothing back: no ack, no reject, no view, and its sender isn't counted as heard from.
    const gone = (sid: string) => this.gone.has(personId, sid);
    if (classify(this.tabs, personId, msg.sid, msg.clientSeq, gone) === 'drop') return;
    // Attributed to the signing key whichever peer it came from. Only a command that applies counts as heard (below,
    // once it is known to be new); a duplicate, held-back, stale, evicted or refused one never marks anyone online.
    await this.enqueue(async () => {
      if (this.closed) return;
      // Someone who isn't an attendee never gets a tab entry, so minted signers can't fill the table. Their command is
      // refused in a one-off reply, saved nowhere.
      if (!Object.hasOwn(this.working.attendees, personId)) {
        this.refuseStranger(m, personId, msg);
        return;
      }
      const arrival = classify(this.tabs, personId, msg.sid, msg.clientSeq, gone);
      const key = `${personId} ${msg.sid}`;
      if (arrival === 'drop') return;
      if (arrival === 'full') {
        // The table is at its board-wide bound: the new tab is refused, and nobody else's makes way for it.
        this.refuseTab(personId, msg.sid, msg.clientSeq, 'tooManyTabs');
        return;
      }
      if (arrival === 'buffer') {
        // A tab whose gap was refused stays refused: arrivals past its gap are dropped until its missing command comes.
        if (this.gapRefused.has(personId, msg.sid)) return;
        // Open gaps are bounded like the table: one past the bounds is dropped, and its tab's resend tries again.
        if (!this.gapSince.has(key) && !this.roomForGap(personId)) return;
        const since = this.gapSince.get(key) ?? this.now();
        this.gapSince.set(key, since);
        if (this.now() - since < GAP_REFUSE_MS) {
          this.bufferFor(personId, msg.sid).set(msg.clientSeq, msg.cmd);
          return;
        }
        // The gap outlived three resend cycles: the participant keeps everything pending, so what's missing is lost to the host and can never be filled.
        // This covers an unknown sid whose first command isn't 1.
        this.buffered.delete(key);
        this.gapSince.delete(key);
        this.gapRefused.add(personId, msg.sid);
        this.refuseTab(personId, msg.sid, msg.clientSeq, 'staleTab');
        return;
      }
      if (arrival === 'stale' || arrival === 'evicted') {
        this.refuseTab(personId, msg.sid, msg.clientSeq, arrival === 'evicted' ? 'tooManyTabs' : 'staleTab');
        return;
      }
      if (arrival === 'duplicate') {
        // Not applied again, and not activity either (a replay mustn't keep a tab alive or decide which tab is
        // dropped): the saved table is left alone. The tab is noted as listed recently, so its ack is among the ones
        // the next view carries.
        // Once per RESENT_KEEP_MS: copies of it within the window add nothing, so they can't keep refreshing the note.
        if (!this.listed.has(key)) {
          this.listed.set(key, this.now());
          this.changed(personId);
        }
        return;
      }
      this.gapSince.delete(key);
      this.gapRefused.delete(personId, msg.sid); // its missing command came: the tab is live again
      this.refusedOnce.delete(personId, `staleTab ${msg.sid}`);
      this.refusedOnce.delete(personId, `tooManyTabs ${msg.sid}`);
      // The one arrival that counts as heard from: the tab's next command, applied now. Before the apply, so the view
      // that carries its ack already has this person out of probation.
      this.heard(m, personId);
      let clientSeq = msg.clientSeq;
      let raw: unknown = msg.cmd;
      const buffer = this.bufferFor(personId, msg.sid);
      this.stale.delete(personId); // a tab of theirs is live again, so the staleTab refusal has done its job
      for (;;) {
        await this.applyTabCommand(personId, msg.sid, clientSeq, raw);
        buffer.delete(clientSeq);
        if (!buffer.has(clientSeq + 1)) break;
        clientSeq += 1;
        raw = buffer.get(clientSeq);
      }
      await this.persist();
    });
  }

  // At most MAX_TABS_PER_PERSON open gaps per person, and MAX_TABLE_ENTRIES in all, so a flood of sids that
  // start above 1 can't grow the buffers without end.
  private roomForGap(personId: string): boolean {
    if (this.gapSince.size >= MAX_TABLE_ENTRIES) return false;
    let mine = 0;
    for (const key of this.gapSince.keys()) if (key.startsWith(`${personId} `)) mine += 1;
    return mine < MAX_TABS_PER_PERSON;
  }

  // A command from someone who isn't an attendee: a notAttendee reject straight back to the peer that sent it, in a
  // shared-only view. Nothing is saved or kept, and it is limited like every one-off reply (takeOneOff).
  private refuseStranger(m: Inbound, personId: string, msg: CmdMessage): void {
    if (!this.takeOneOff('notAttendee', m.from, personId, m.path)) return;
    const state = this.sharedOnly(personId);
    state.rejects = Object.assign(Object.create(null) as ViewState['rejects'], {
      [msg.sid]: { clientSeq: msg.clientSeq, key: 'notAttendee' },
    });
    void this.sendTo(m.from, {
      t: 'snapshot', epoch: this.o.epoch, seq: this.published.seq, hostNow: this.hostClock.next(), you: personId,
      host: this.transport.selfId, state,
    }, m.path, false);
  }

  // Whether a one-off reply of this kind to this peer and signer may go now (ONE_OFF_WINDOW_MS, ONE_OFF_MAX). On the
  // relay it also needs a spare pacer slot; a direct reply uses none of the relay's budget.
  private takeOneOff(kind: OneOffKind, peerId: string, personId: string, path: Path): boolean {
    const now = this.now();
    const capped = !this.isBoundAttendee(personId);
    const times = (this.oneOffTimes.get(kind) ?? []).filter((at) => now - at < ONE_OFF_WINDOW_MS);
    this.oneOffTimes.set(kind, times);
    if (capped && times.length >= ONE_OFF_MAX) return false;
    const key = `${kind} ${peerId} ${personId}`;
    if (now - (this.oneOffAt.get(key) ?? Number.NEGATIVE_INFINITY) < ONE_OFF_WINDOW_MS) return false;
    if (path !== 'direct' && !this.pacer.takeSpareSlot()) return false;
    if (capped) times.push(now);
    this.oneOffAt.set(key, now);
    return true;
  }

  // An attendee with a protocol 2 record bound to them: only an accepted hello makes one, so minted signers never are.
  private isBoundAttendee(personId: string): boolean {
    if (!Object.hasOwn(this.working.attendees, personId)) return false;
    for (const peer of this.peers.values()) if (peer.personId === personId && peer.pv === PROTOCOL_VERSION) return true;
    return false;
  }

  // The tab gets a reject it can show (staleTab or tooManyTabs) in that person's next views; nothing is applied.
  private refuseTab(personId: string, sid: string, clientSeq: number, key: StaleTab['key']): void {
    // Once per tab and reason: a copy of a refused command never sets the refusal again, which would take one of the
    // person's three ack slots in their views (and the set is bounded, the oldest going first).
    if (this.refusedOnce.has(personId, `${key} ${sid}`)) return;
    this.refusedOnce.add(personId, `${key} ${sid}`);
    this.stale.set(personId, { sid, clientSeq, at: this.now(), key });
    this.changed(personId);
  }

  private bufferFor(personId: string, sid: string): Map<number, unknown> {
    const key = `${personId} ${sid}`;
    let buffer = this.buffered.get(key);
    if (!buffer) {
      buffer = new Map();
      this.buffered.set(key, buffer);
    }
    return buffer;
  }

  // A command this host can't apply (unknown, malformed or a join) is refused with badCommand, not dropped,
  // so it moves the ack on like any refusal and can never block the tab.
  private async applyTabCommand(personId: string, sid: string, clientSeq: number, raw: unknown): Promise<void> {
    const cmd = parseCommand(raw);
    const result = !cmd || cmd.type === 'join' ? refuse('badCommand') : await this.run(personId, cmd);
    const before = this.tabs;
    this.tabs = recordOutcome(before, personId, sid, clientSeq, this.now(), result.ok ? undefined : result.key);
    // A new tab can drop another (src/session/tabs.ts, bounds): forget what memory holds for it.
    this.forgetGone(before);
  }

  private viewContext(personId: string): ViewContext {
    const listed = Object.create(null) as Record<string, number>;
    for (const [key, at] of this.listed) if (key.startsWith(`${personId} `)) listed[key.slice(personId.length + 1)] = at;
    return entryContext(this.published.tabs, personId, this.online(), this.stale.get(personId), this.refusalOf(personId), listed);
  }

  // Newest last, so every entry's expiry is no earlier than the one before it and the oldest goes first.
  private noteJoinRefused(personId: string, key: MessageKey, name: string, m: Inbound): void {
    this.joinRefused.delete(personId);
    const now = this.now();
    this.joinRefused.set(personId, { key, until: now + JOIN_REFUSED_MS, name, peerId: m.from, path: m.path, answeredAt: now });
    while (this.joinRefused.size > JOIN_REFUSED_MAX) this.joinRefused.delete(this.joinRefused.keys().next().value!);
  }

  private refusalOf(personId: string): MessageKey | undefined {
    const refused = this.joinRefused.get(personId);
    return refused && refused.until > this.now() ? refused.key : undefined;
  }

  // A view changed: everyone's (no person), or one person's. The pacer decides when it goes out.
  private changed(personId?: string): void {
    if (personId === undefined) this.directDirty = 'all';
    else {
      this.forced.add(personId);
      if (this.directDirty !== 'all') this.directDirty.add(personId);
    }
    this.pacer.change();
  }

  private refusedNow(): Refusal[] {
    const now = this.now();
    return [...this.joinRefused].filter(([, r]) => r.until > now).map(([personId, r]) => ({ personId, until: r.until }));
  }

  // Direct snapshots go only to protocol 2 records whose reply path is direct. A refresh sends one to every such
  // record; a change, to every record after a board or presence change, otherwise to the records of the people whose
  // own view changed. Everyone else is reached by the bundle. A refresh also tries a failed save again.
  private sendDirect(full: boolean): void {
    if (this.closed) return;
    if (full && this.saveFailed) void this.enqueue(() => this.persist());
    const dirty = this.directDirty;
    this.directDirty = new Set();
    for (const peer of this.peers.values()) {
      if (peer.pv !== PROTOCOL_VERSION || this.replyPath(peer) !== 'direct') continue;
      if (full || dirty === 'all' || dirty.has(peer.personId)) void this.sendSnapshot(peer.peerId, peer.personId, 'direct', peer);
    }
    // A refusal that came on the direct path goes back on it in every full refresh until its window closes, to a peer
    // with no record (a refused newcomer's hello binds none). Each send is a one-off reply, charged to the joinRefused
    // budget (takeOneOff), so a refresh sends at most ONE_OFF_MAX of them, the latest refusals first. Not on every
    // change: only a refresh, and the hello's own answer.
    if (!full) return;
    const now = this.now();
    for (const [personId, r] of [...this.joinRefused].reverse()) {
      if (r.path !== 'direct' || r.until <= now || this.peers.has(`${r.peerId} ${personId}`)) continue;
      if (this.takeOneOff('joinRefused', r.peerId, personId, 'direct')) void this.sendSnapshot(r.peerId, personId, 'direct');
    }
  }

  // People whose every protocol 2 record is out of probation and on a healthy direct path: each of their tabs gets a
  // direct snapshot, so the ceiling may leave their bundle entry out. One relay-only tab keeps the entry in.
  private directPeople(): Set<string> {
    const people = new Map<string, boolean>();
    for (const peer of this.peers.values()) {
      if (peer.pv !== PROTOCOL_VERSION) continue;
      people.set(peer.personId, (people.get(peer.personId) ?? true) && !peer.probation && this.replyPath(peer) === 'direct');
    }
    return new Set([...people].filter(([, direct]) => direct).map(([personId]) => personId));
  }

  // One relay event for everyone (docs/product/sync-protocol.md, The relay bundle): the viewer-neutral board once,
  // and a sealed entry for each person whose entry differs from the last full refresh. The recipients are the size
  // meter's own list (bundleRecipients), narrowed by the peer records: a person with a record out of probation gets
  // their own entry; one whose records are all probationary, or a refused joiner, gets a neutral entry (role and
  // refusal only), so a replayed hello earns no personal data; and an attendee with no record at all gets none.
  // Everything is built now, synchronously, from the last saved board; only sealing and publishing wait.
  private sendBundle(full: boolean): void {
    if (this.closed) return;
    const { state, seq } = this.published;
    const host = this.transport.selfId;
    if (full) {
      this.lastFullEntries = new Map();
      this.changedSinceFull = new Set();
      this.refreshSeq = seq;
    }
    const header = { epoch: this.o.epoch, seq, refreshSeq: this.refreshSeq, hostNow: this.hostClock.next(), host };
    const online = this.online();
    const refused = this.refusedNow();
    const strangers = new Set(refused.filter((r) => !Object.hasOwn(state.attendees, r.personId)).map((r) => r.personId));
    const personals: PersonalItem[] = [];
    for (const personId of bundleRecipients(state, this.o.hostId, refused)) {
      const records = [...this.peers.values()].filter((peer) => peer.personId === personId && peer.pv === PROTOCOL_VERSION);
      let item: PersonalItem;
      if (records.some((peer) => !peer.probation)) item = personalItem(state, personId, this.viewContext(personId), header);
      else if (records.length > 0 || strangers.has(personId)) item = neutralItem(state, personId, header, this.refusalOf(personId));
      else continue;
      // Only seq differs between bundles of one session when the entry itself hasn't changed.
      const entry = JSON.stringify({ ...item, seq: 0 });
      if (full) this.lastFullEntries.set(personId, entry);
      else if (this.lastFullEntries.get(personId) !== entry) this.changedSinceFull.add(personId);
      if (full || this.forced.has(personId) || this.changedSinceFull.has(personId)) personals.push(item);
    }
    this.forced.clear();
    // People on a healthy direct path get a direct snapshot anyway, so the ceiling may leave their entries out.
    const direct = this.directPeople();
    const fields = bundleFields(state, header, online);
    this.bundles = this.bundles.then(async () => {
      const { wire, over } = await fitBundle(
        personals, strangers, direct, (items) => encodeBundle(this.o.signer, this.o.roomKey, fields, items),
        (bytes) => relayEventBytes(bytes, host, TOPIC_PLACEHOLDER, this.eventKey), Math.min(this.o.eventLimit ?? RELAY_EVENT_MAX_BYTES, RELAY_EVENT_MAX_BYTES),
      );
      if (this.closed) return;
      this.transport.broadcastRelay(wire, full ? { kind: 'refresh', supersedes: ['change', 'refresh'] } : { kind: 'change', supersedes: ['change'] });
      if (over) this.oversizeCount += 1;
      // A full refresh that fits clears it; any bundle that doesn't fit sets it.
      if (over ? !this.oversize : this.oversize && full) {
        this.oversize = over;
        this.o.onStatus?.();
      }
    }).catch((err) => console.warn('Could not send a bundle', err));
  }

  // peer is the record the view goes to. Only a record out of probation gets the person's own entry (dots, ballot,
  // totals, acks and rejects); with no record, or one still in probation, the view is the shared one with a neutral
  // entry, since its hello may be an old one replayed. A live join refusal goes in either.
  private sendSnapshot(peerId: string, personId: string, path: Path, peer?: PeerRecord): Promise<void> {
    return this.sendTo(peerId, {
      t: 'snapshot', epoch: this.o.epoch, seq: this.published.seq, hostNow: this.hostClock.next(), you: personId,
      host: this.transport.selfId,
      state: peer && !peer.probation ? redactFor(this.published.state, personId, this.viewContext(personId)) : this.sharedOnly(personId),
    }, path, false, peer);
  }

  private sharedOnly(personId: string): ViewState {
    const state = this.published.state;
    const role = Object.hasOwn(state.attendees, personId) ? state.attendees[personId].role : 'guest';
    const view = mergeView(sharedView(state, { online: this.online() }), { you: personId, role, mine: {}, voted: false, acks: {}, rejects: {} });
    const refused = this.refusalOf(personId);
    if (refused !== undefined) view.joinRefused = refused;
    return view;
  }

  // A failed send is logged, never thrown: the change is already saved, and acks, resends and the refresh cover it.
  private async sendTo(peerId: string, msg: ToPeer, path: Path, fallback: boolean, peer?: PeerRecord): Promise<void> {
    let used: Path | null;
    try {
      const data = await encodeWire(this.o.roomKey, await sealEnvelope(this.o.signer, msg));
      used = await this.transport.sendVia(peerId, data, path, { fallback });
    } catch (err) {
      console.warn('Could not send a message', err);
      used = null;
    }
    // A rejected direct send marks the peer's direct path down, so it falls back to the relay.
    if (path === 'direct' && used !== 'direct' && peer) peer.lastDirectAt = Number.NEGATIVE_INFINITY;
  }
}
