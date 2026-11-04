import { getRelaySockets, joinRoom, selfId } from 'trystero';
import { STUN_SERVERS } from '../config';
import type { Bytes } from '../crypto/bytes';
import { withRestartableOffers } from './restart-offer';
import type { PeerStatus, ResumeFocus, Transport } from './types';

interface Closable {
  close(): void;
  onclose?: unknown;
  readonly readyState?: number;
}

// WebSocket.CLOSED, which Node has no WebSocket to name.
const SOCKET_CLOSED = 3;

// Trystero reconnects a socket from its close handler, so remove the handler before closing.
function closeSocket(socket: Closable): void {
  try { socket.onclose = null; } catch { /* read-only */ }
  socket.close();
}

// The parts of Trystero used here, so tests can pass fakes.
export interface TrysteroLib {
  joinRoom: typeof joinRoom;
  getRelaySockets(): Record<string, Closable>;
}

const trystero: TrysteroLib = { joinRoom, getRelaySockets: () => getRelaySockets() as Record<string, Closable> };

// The page's visibility: hidden says whether the page is hidden now; watch calls cb with true when the page turns
// hidden and false when it turns visible, until the function it returns is called.
export interface PageVisibility {
  hidden(): boolean;
  watch(cb: (hidden: boolean) => void): () => void;
}

const documentVisibility: PageVisibility = {
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  watch(cb) {
    if (typeof document === 'undefined') return () => undefined;
    const onChange = () => cb(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  },
};

// After a resume from hidden, a direct connection that drops within this time is treated as lost in the lock: a real
// lock ends a connection by ICE timeout, some seconds after the page is back.
const RESUME_WATCH_MS = 30_000;

// A participant whose link to the host drops while it is visible rejoins for it at most this often.
const HOST_LINK_REJOIN_GAP_MS = 60_000;

// A host reported gone while this side's connection to it still reads connected has either rejoined with its connection
// kept (its new room takes it back within seconds) or closed its end, which a participant sees as ICE gives up, 5 to
// 6 s on. The participant waits this long for it to be back before rejoining.
const HOST_LINK_GRACE_MS = 8000;

// After a rejoin, a link it lost that is still missing this long after the rejoin finished makes the page rejoin once
// more, and if it is still missing LINK_FINAL_MS after that rejoin, once more again; no rejoin after those is
// followed by another. Another page's old room, still leaving as this one rejoined, can make or answer an offer that
// its leave then abandons; Trystero ignores the new room's announcements while it holds that half-made connection,
// 23.333 s at most (answeringTtlMs), so the rejoin's fresh announcements bring nothing until it expires.
const LINK_VERIFY_MS = 10_000;
// The last of those rejoins comes this long after the one before it finished: past that 23.333 s, so whichever page
// holds the half-made connection has dropped it, and the fresh announcements are answered.
const LINK_FINAL_MS = 26_000;

// A peer its room reported gone is closed at the next rejoin if its connection is not connected, or if the peer has been
// gone this long (a connection that still reads connected after that is not coming back with the peer's new room).
const DEPARTED_RECENT_MS = 5000;
// A peer gone this long is forgotten: Trystero's shared connection to it is stale by then (123 s idle at most).
const DEPARTED_MAX_MS = 120_000;

// After a room is left, the sockets of the signalling clients no room will use again are closed again this often, for
// at least this long. Trystero gives such a client no way to stop it from outside: a retry timer its socket's earlier
// close started opens a new socket later (makeSocket in @trystero-p2p/core: at most 53 s each time, and a new socket
// that fails starts the next, so a chain can run for about 100 s). So each time the sweep finds a socket it has not
// closed yet, or one not closed yet, it carries on for SWEEP_FOR_MS more, up to SWEEP_CAP_MS after it started. A client
// that waited for the browser to come back online opens its socket once it is, so going online starts the sweep again.
const SWEEP_EVERY_MS = 5_000;
const SWEEP_FOR_MS = 65_000;
const SWEEP_CAP_MS = 180_000;

// What the page's transports share about Trystero's signalling clients. Trystero keeps one client per relay URL for the
// life of the page. It sets clients up only for a join made while it has no room (a room counts until its leave()
// resolves, and one it could not leave counts for good), and gives every room joined meanwhile those clients, whatever
// URLs it was asked for: so while the page has a room, every room it has uses those clients. A client whose socket was
// swept never connects again, so a URL a rejoin has finished with is retired: no join asks for it again, and once no
// room uses it, the sweep closes its socket.
interface PageSignalling {
  retired: Set<string>;
  // The page's rooms, and the URLs of the clients Trystero set up for them.
  rooms: number;
  clients: string[];
  // The URLs of the last join that threw while the page had no room, until a join succeeds (see enter). Page-wide, so
  // the page's next transport asks for them too, taking them in place of its own relays: that is right because the relay
  // list is the same for the whole page (src/config.ts). A successful join clears it for every transport, which is safe:
  // any enter() with rooms == 0 asked for these URLs, and with rooms > 0 used page.clients.
  failed: string[] | null;
  rejoins: number;
  // The leave in progress of each room ID: Trystero answers a join of a room it is still leaving with that room.
  leaving: Map<string, Promise<boolean>>;
  closed: WeakSet<Closable>;
  sweepStartedAt: number;
  sweepUntil: number;
  sweepTimer: ReturnType<typeof setInterval> | undefined;
}

// One record per Trystero (the real one is the page's; each test's fake is a page of its own).
const pages = new WeakMap<TrysteroLib, PageSignalling>();

function pageSignalling(lib: TrysteroLib): PageSignalling {
  let page = pages.get(lib);
  if (page) return page;
  const created: PageSignalling = {
    retired: new Set(), rooms: 0, clients: [], failed: null, rejoins: 0, leaving: new Map(),
    closed: new WeakSet(), sweepStartedAt: 0, sweepUntil: 0, sweepTimer: undefined,
  };
  pages.set(lib, created);
  globalThis.addEventListener?.('online', () => { if (created.retired.size > 0) sweepForAWhile(lib, created); });
  return created;
}

// The relay URLs a join asks for: while the page has a room, those of the clients Trystero will use anyway; otherwise
// the room's own, unless one of them is retired, then a set marked afresh.
function relaysToJoin(page: PageSignalling, relays: string[]): string[] {
  if (page.rooms > 0) return page.clients;
  if (page.failed) return page.failed;
  if (relays.every((url) => !page.retired.has(url))) return relays;
  return relaysForJoin(relays, ++page.rejoins);
}


// Closes the socket of every retired client no room uses, each socket once. Returns whether any old client is still
// active: it had a socket the sweep had not closed before, or one that is not closed yet.
function sweep(lib: TrysteroLib, page: PageSignalling): boolean {
  let active = false;
  for (const [url, socket] of Object.entries(lib.getRelaySockets())) {
    if (!page.retired.has(url) || (page.rooms > 0 && page.clients.includes(url))) continue;
    if (!page.closed.has(socket)) {
      page.closed.add(socket);
      closeSocket(socket);
      active = true;
    } else if (socket.readyState !== undefined && socket.readyState !== SOCKET_CLOSED) {
      active = true;
    }
  }
  return active;
}

// Sweeps now, then every SWEEP_EVERY_MS for SWEEP_FOR_MS, longer while old clients are active (see SWEEP_FOR_MS).
function sweepForAWhile(lib: TrysteroLib, page: PageSignalling): void {
  sweep(lib, page);
  page.sweepStartedAt = Date.now();
  page.sweepUntil = page.sweepStartedAt + SWEEP_FOR_MS;
  page.sweepTimer ??= setInterval(() => {
    const now = Date.now();
    if (sweep(lib, page)) page.sweepUntil = Math.max(page.sweepUntil, Math.min(now + SWEEP_FOR_MS, page.sweepStartedAt + SWEEP_CAP_MS));
    if (now < page.sweepUntil) return;
    clearInterval(page.sweepTimer);
    page.sweepTimer = undefined;
  }, SWEEP_EVERY_MS);
}

// The relay URLs for the nth join of the room. Trystero keeps one signalling client per URL, and with it a back-off
// that stops announcements for a minute or more after one found the socket closed (as on a resume), which nothing
// clears. A rejoin therefore marks the URLs (`?rejoin=n`), which relays ignore, so Trystero makes fresh clients.
function relaysForJoin(relays: string[], n: number): string[] {
  return relays.map((relay) => {
    const url = new URL(relay);
    url.searchParams.set('rejoin', String(n));
    return url.toString();
  });
}

const clearTimer = (timer: ReturnType<typeof setTimeout> | undefined): undefined => {
  clearTimeout(timer);
  return undefined;
};

type Room = ReturnType<typeof joinRoom>;
const makeMessageAction = (r: Room) => r.makeAction<Uint8Array>('m');
type Channel = ReturnType<typeof makeMessageAction>;

// Direct WebRTC data channels. Trystero uses the Nostr relays only for the handshake,
// which it encrypts with `password` (the room key).
// Trystero forms a connection when a peer announces itself on the relays, which it does a few times on joining and
// then once a minute. It can announce again when a connection drops (reannounceOnDisconnect), but every direct link is
// one of its shared connections, whose close handler does not ask for that, so in practice it does not. So when a
// resume finds a link it cares about lost in the lock, this transport leaves the room and joins it again: the fresh
// announcements bring the peers back within seconds instead of a minute. A participant cares only about its link to
// the host, the host about every link (docs/product/sync-protocol.md, Direct path after a resume).
export function createTrysteroTransport(
  o: { relays: string[]; roomId: string; password: string }, lib: TrysteroLib = trystero, page: PageVisibility = documentVisibility,
): Transport {
  // Check first: Trystero would open its signalling sockets before failing on the missing constructor.
  if (typeof globalThis.RTCPeerConnection !== 'function') throw new Error('This browser has no WebRTC');
  const signalling = pageSignalling(lib);
  // The room in use, its message channel and the relay URLs of its clients; none while there is no room.
  let joined: { room: Room; channel: Channel; relays: string[] } | null = null;
  const toBytes = (data: unknown): Bytes =>
    data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer);

  let messageCb: ((peerId: string, data: Bytes) => void) | undefined;
  let joinCb: ((peerId: string) => void) | undefined;
  let leaveCb: ((peerId: string) => void) | undefined;
  let left = false;
  // A rejoin is under way, or the first join waits for a leave of the same room to finish: no room to report.
  let rejoining = false;
  // The page is hidden: from the last visibility change that hid it until it is shown again (a frozen page hears of
  // its closed connections only as it thaws, just before it is shown).
  let away = page.hidden();
  // The page has been hidden since the last resume (or since the transport started), so the next resume watches for
  // connections that drop soon after.
  let hiddenSinceResume = away;
  // The direct peers in the room when the page was last hidden, and those that joined while it was: any of them not
  // connected at the next resume was lost in the lock, however its loss was reported.
  const linkedWhileAway = new Set<string>();
  // Until `until`, a link the focus cares about going down makes the transport rejoin (once).
  let watch: { until: number; focus: ResumeFocus | undefined } | null = null;
  // A participant's way to name the host it cares about, set by `follow`; the facilitator's page has none.
  let followed: (() => ResumeFocus) | undefined;
  let hostLinkRejoinedAt = Number.NEGATIVE_INFINITY;
  // The connection of each peer this room reported gone and has not reported back, as it was when the peer joined.
  // Trystero keeps such a connection as a shared one (for 2 minutes, or until it fails) and gives it to the next room,
  // which runs its handshake over it and ignores the peer's announcements meanwhile: a link to a peer that left when
  // its page locked is disconnected, not yet failed, when this page rejoins. A rejoin closes them.
  const departed = new Map<string, { connection: RTCPeerConnection; at: number }>();
  // The peers a rejoin reported gone, and those back in the room since it finished: a link still missing after
  // LINK_VERIFY_MS is tried once more.
  let lost = new Set<string>();
  const backSinceRejoin = new Set<string>();
  let verifyTimer: ReturnType<typeof setTimeout> | undefined;

  // A participant cares about its link to the host alone; the host (no focus) about every link.
  const caresAbout = (focus: ResumeFocus | undefined, peerId: string) => focus === undefined || focus.host === peerId;
  // A connection is down once it has failed or closed. A disconnected one is not: ICE may recover it, and Trystero
  // gives it 5 s to, then closes it and reports the peer gone, which the watch after a resume counts.
  const isDown = (connection: RTCPeerConnection | undefined) =>
    connection === undefined || connection.connectionState === 'failed' || connection.connectionState === 'closed';
  const connected = () => (rejoining || !joined ? [] : Object.keys(joined.room.getPeers()));

  const stopWatchingPage = page.watch((hidden) => {
    away = hidden;
    if (!hidden) return;
    hiddenSinceResume = true;
    for (const peerId of connected()) linkedWhileAway.add(peerId);
  });

  // Each direct peer's connection, as it was when the peer joined: Trystero has dropped it from the room by the time it
  // reports the peer leaving.
  const links = new Map<string, RTCPeerConnection>();
  const peerJoined = (r: Room, peerId: string) => {
    const connection = r.getPeers()[peerId];
    if (connection) links.set(peerId, connection);
    if (departed.get(peerId)?.connection === connection) departed.delete(peerId);
    backSinceRejoin.add(peerId);
    if (away) linkedWhileAway.add(peerId);
    joinCb?.(peerId);
  };
  const rejoinForHostLink = () => {
    if (left || away || Date.now() - hostLinkRejoinedAt < HOST_LINK_REJOIN_GAP_MS) return;
    rejoin();
  };
  const peerLeft = (peerId: string) => {
    const link = links.get(peerId);
    links.delete(peerId);
    if (link) departed.set(peerId, { connection: link, at: Date.now() });
    leaveCb?.(peerId);
    if (!watch || Date.now() >= watch.until || !caresAbout(watch.focus, peerId)) {
      // The host closed its end of the link and rejoined: a participant that never noticed keeps the old connection
      // open for a while, and Trystero ignores announcements from a peer it still holds a live connection to, so the
      // link would wait for the minute's announcement. Only a participant's link to the host counts, only while the
      // page is visible, and not within a minute of any rejoin. A connection that is down rejoins at once; one that
      // still reads connected (a host whose page rejoined keeps it; one that closed its end shows it only later, and
      // Trystero has reported the host gone already) rejoins if the host is not back in the room after a grace period.
      if (followed?.().host === peerId) {
        if (link?.connectionState !== 'connected') rejoinForHostLink();
        else setTimeout(() => { if (!connected().includes(peerId)) rejoinForHostLink(); }, HOST_LINK_GRACE_MS);
      }
      return;
    }
    // In the watch, a peer whose connection is still up most likely left the room on purpose (its page rejoined, say):
    // rejoining for it could set that page off again.
    if (link?.connectionState !== 'connected') rejoin();
  };
  // Trystero reports the room's peers to an onPeerJoin handler as it is set, as well as each later one.
  const wire = (r: Room, ch: Channel) => {
    ch.onMessage = (data: unknown, meta: { peerId: string }) => messageCb?.(meta.peerId, toBytes(data));
    r.onPeerLeave = peerLeft;
    r.onPeerJoin = (peerId) => peerJoined(r, peerId);
  };
  // A room being left reports nothing more: its peers are reported gone once, by the rejoin, and its late reports
  // must not count against the room that replaces it.
  const unwire = (r: Room, ch: Channel) => {
    ch.onMessage = () => undefined;
    r.onPeerJoin = () => undefined;
    r.onPeerLeave = () => undefined;
  };

  // Tells Trystero that each of these connections is closed, after closing it: a connection closed without events (a
  // local close) is still listed, and leave() would throw sending on its dead channel.
  const closeConnections = (r: Room, which: (connection: RTCPeerConnection) => boolean) => {
    for (const connection of Object.values(r.getPeers())) {
      if (!which(connection)) continue;
      connection.close();
      connection.dispatchEvent(new Event('connectionstatechange'));
    }
  };

  // Leaves the room, closing the connections that are down first. If Trystero's leave() fails all the same, it
  // closes every connection and tries once more. Resolves with whether the room was left, and the error if not.
  const leaveRoom = async (r: Room): Promise<{ wasLeft: boolean; error?: unknown }> => {
    closeConnections(r, isDown);
    try {
      await r.leave();
      return { wasLeft: true };
    } catch {
      closeConnections(r, () => true);
    }
    try {
      await r.leave();
      return { wasLeft: true };
    } catch (error) {
      return { wasLeft: false, error };
    }
  };

  // Leaves a room, and once Trystero has, stops counting it for the page and closes the sockets of the retired clients
  // no room uses now. A room Trystero could not leave stays counted: a rejoin carries on in it, but one the meeting has
  // left (or never used) keeps announcing on the relays until the page reloads. Resolves with whether it was left.
  const exit = (r: Room): Promise<boolean> => {
    const leaving: Promise<boolean> = leaveRoom(r).then(({ wasLeft, error }) => {
      if (signalling.leaving.get(o.roomId) === leaving) signalling.leaving.delete(o.roomId);
      if (wasLeft) {
        signalling.rooms -= 1;
        if (sweep(lib, signalling)) sweepForAWhile(lib, signalling);
      } else if (left || joined?.room !== r) {
        console.warn('[retrobrew] could not leave the direct room; it keeps announcing on the relays until the page reloads', error);
      } else {
        console.warn('[retrobrew] could not leave the direct room; carrying on in it, and reloading the page brings the direct path back', error);
      }
      return wasLeft;
    });
    signalling.leaving.set(o.roomId, leaving);
    return leaving;
  };

  // Joins the room and counts it for the page. Throws if Trystero does. Whether the clients that join set up are then
  // marked set up (Trystero's didInit) depends on where it threw, and from outside there is no telling: a throw while
  // setting them up leaves them unmarked, one after (making its offer pool's first connection, say) leaves them marked
  // with no room, and until a room is left Trystero gives every join those clients, whatever URLs it asks for.
  // So the clients are kept, not closed or retired, and recorded page-wide (`signalling.failed`): the next
  // join, by this transport or by the page's next one (Retry, a new meeting), asks for the same URLs, is given these
  // clients if Trystero kept them, and makes them again over the same sockets if not. A join that has a room clears the
  // record. Deliberate trade-offs: the kept sockets stay open, with no timeout, until a later join uses them or the page
  // goes; and a throw after Trystero subscribed this room to the relays (strategy.mjs:222) leaves a ghost room announcing
  // on them, which only a later room's leave ends (theoretical: such a throw would most likely recur at every join).
  const enter = () => {
    const relays = relaysToJoin(signalling, o.relays);
    let room: Room;
    try {
      room = lib.joinRoom(
        { appId: 'retrobrew', password: o.password, relayConfig: { urls: relays }, rtcConfig: { iceServers: STUN_SERVERS }, rtcPolyfill: withRestartableOffers(globalThis.RTCPeerConnection) },
        o.roomId,
        { onJoinError: (details) => console.warn('[retrobrew] direct connection failed', details) },
      );
    } catch (error) {
      // Only with no room: a live room means Trystero's init already succeeded, so it cannot be stuck, and the record
      // would outlive that room and name clients its exit may retire and sweep.
      if (signalling.rooms === 0) signalling.failed = relays;
      throw error;
    }
    signalling.failed = null;
    signalling.rooms += 1;
    signalling.clients = relays;
    let channel: Channel;
    try {
      channel = makeMessageAction(room);
    } catch (error) {
      void exit(room);
      throw error;
    }
    joined = { room, channel, relays };
    wire(room, channel);
  };

  // Joins once any leave of this room in the page is done. If Trystero throws, the transport has no room until the next
  // resume.
  const joinAgain = async () => {
    await signalling.leaving.get(o.roomId);
    if (left) return;
    try {
      enter();
    } catch (error) {
      console.warn('[retrobrew] could not join the direct room; the next resume tries again', error);
    }
  };

  // A link the rejoin gave up that is still missing: rejoin once more, stage 1 after LINK_VERIFY_MS, stage 2 (the last)
  // after LINK_FINAL_MS more. Not while the page is hidden.
  function verifyLinks(stage: 1 | 2): void {
    verifyTimer = undefined;
    if (left || away || rejoining) return;
    const focus = followed?.();
    const missing = [...lost].some((peerId) => caresAbout(focus, peerId) && !backSinceRejoin.has(peerId) && !connected().includes(peerId));
    if (missing) rejoin(stage);
  }

  function rejoin(stage: 0 | 1 | 2 = 0): void {
    if (left || rejoining) return;
    rejoining = true;
    // Every rejoin starts the floor under a participant's rejoin for a visible host link.
    hostLinkRejoinedAt = Date.now();
    watch = null;
    verifyTimer = clearTimer(verifyTimer);
    // The links this rejoin gives up: the room's peers, and those it reported gone whose connections Trystero still holds.
    // A departed peer whose connection is down, or that has been gone long, is not a link to wait for: it most likely
    // reloaded or left for good, and would make every rejoin of the host be followed by another. A participant's host
    // is the exception: it is the one link it cares about, and a locked host's link is often failed by now.
    const now = Date.now();
    const host = followed?.().host;
    const waitingFor = [...departed].filter(([peerId, { connection, at }]) => now - at < DEPARTED_MAX_MS && (peerId === host || !isDown(connection)));
    // A retry keeps the links still missing from the rejoins before it: the room it leaves is the one that lacked them.
    lost = new Set([...(stage === 0 ? [] : lost), ...Object.keys(joined?.room.getPeers() ?? {}), ...waitingFor.map(([peerId]) => peerId)]);
    backSinceRejoin.clear();
    // One still connected and gone a moment is most likely a peer whose page rejoined: its new room takes the connection back.
    for (const [, { connection, at }] of waitingFor) {
      if (connection.connectionState === 'connected' && now - at < DEPARTED_RECENT_MS) continue;
      connection.close();
      connection.dispatchEvent(new Event('connectionstatechange'));
    }
    departed.clear();
    const old = joined;
    if (old) {
      // No join asks for these clients again; their sockets may be half-open after a lock anyway.
      for (const url of old.relays) signalling.retired.add(url);
      unwire(old.room, old.channel);
      // Trystero's leave() reports no peer leaving, so report each one now: peers() is empty until the new room is up.
      links.clear();
      for (const peerId of Object.keys(old.room.getPeers())) leaveCb?.(peerId);
    }
    void (async () => {
      if (old && !(await exit(old.room)) && !left) {
        // Still in the old room: carry on in it. Setting the handlers reports its peers again.
        rejoining = false;
        wire(old.room, old.channel);
        return;
      }
      joined = null;
      await joinAgain();
      rejoining = false;
      if (left || stage === 2) return;
      verifyTimer = stage === 0 ? setTimeout(() => verifyLinks(1), LINK_VERIFY_MS) : setTimeout(() => verifyLinks(2), LINK_FINAL_MS);
    })();
  }

  if (signalling.leaving.has(o.roomId)) {
    rejoining = true;
    void joinAgain().then(() => { rejoining = false; });
  } else {
    enter();
  }

  return {
    selfId,
    // The promise rejects if the data channel refuses the message; HybridTransport then uses the relay.
    send: (peerId, data) => (joined ? joined.channel.send(data, { target: peerId }) : Promise.reject(new Error('Not in the direct room'))),
    broadcast: (data) => void joined?.channel.send(data).catch(() => undefined),
    onMessage: (cb) => { messageCb = cb; },
    onPeerJoin: (cb) => { joinCb = cb; },
    onPeerLeave: (cb) => { leaveCb = cb; },
    status: (peerId): PeerStatus => (connected().includes(peerId) ? 'direct' : 'offline'),
    peers: connected,
    follow: (focus) => { followed = focus; },
    // Rejoin if a link the focus cares about is down now, or if one that was in the room while the page was hidden is
    // down or gone now (for a participant, while its link to the host is down: the lost link may be the host's under
    // its old peer ID), or if a rejoin left no room. Otherwise, after the page was hidden, watch for such a link that
    // drops soon after: a disconnected one is left to the watch. A rejoin watches nothing after it, but a link it
    // lost that is still missing later is tried again by verifyLinks.
    resume: (focus) => {
      if (left || rejoining) return;
      const wasHidden = hiddenSinceResume;
      hiddenSinceResume = false;
      const linked = [...linkedWhileAway];
      linkedWhileAway.clear();
      if (!joined) {
        rejoin();
        return;
      }
      const connections = joined.room.getPeers();
      const down = (peerId: string) => isDown(connections[peerId]);
      const dead = Object.keys(connections).some((peerId) => caresAbout(focus, peerId) && down(peerId));
      const lostInLock = linked.some(down) && (focus === undefined || (focus.host !== null && down(focus.host)));
      if (dead || lostInLock) rejoin();
      // A resume of a page that was not hidden (the Retry button) watches nothing.
      else if (wasHidden) watch = { until: Date.now() + RESUME_WATCH_MS, focus };
    },
    // Leaves the room. Clients on the room's own relay URLs stay for the page's next transport, unless a rejoin retired
    // them; clients on marked URLs are retired now, since no join asks for a marked URL twice. A rejoin or a first join
    // under way finishes the leave itself.
    leave: () => {
      left = true;
      verifyTimer = clearTimer(verifyTimer);
      stopWatchingPage();
      if (rejoining || !joined) return;
      const { room, relays } = joined;
      joined = null;
      for (const url of relays) if (!o.relays.includes(url)) signalling.retired.add(url);
      void exit(room);
    },
  };
}
