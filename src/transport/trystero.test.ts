import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTrysteroTransport } from './trystero';

afterEach(() => { vi.unstubAllGlobals(); });

const options = { relays: ['wss://a.example'], roomId: 'room', password: 'pw' };

describe('createTrysteroTransport', () => {
  it('keeps the signalling sockets joinRoom opened before it threw, for the page\'s next join', () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const existing = { close: vi.fn() };
    const sockets: Record<string, { close(): void }> = { 'wss://old.example': existing };
    const opened = { close: vi.fn() };
    const lib = {
      getRelaySockets: () => sockets,
      joinRoom: (() => { sockets['wss://a.example'] = opened; throw new Error('boom'); }) as never,
    };
    expect(() => createTrysteroTransport(options, lib)).toThrow('boom');
    expect(opened.close).not.toHaveBeenCalled();
    expect(existing.close).not.toHaveBeenCalled();
  });

  it('returns the send promise, so a failed direct send can be caught', async () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const room = {
      makeAction: () => ({ send: () => Promise.reject(new Error('channel closed')), onMessage: null }),
      getPeers: () => ({}),
      leave: async () => undefined,
    };
    const lib = { getRelaySockets: () => ({}), joinRoom: (() => room) as never };
    const t = createTrysteroTransport(options, lib);
    await expect(t.send('peer', new Uint8Array(1))).rejects.toThrow('channel closed');
  });
});

describe('createTrysteroTransport cleanup', () => {
  it('stops a closed socket from reconnecting through its close handler', () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const reopened = vi.fn();
    const socket: { onclose: (() => void) | null; close(): void } = {
      onclose: () => reopened(),
      close() { this.onclose?.(); },
    };
    const sockets: Record<string, typeof socket> = {};
    const lib = {
      getRelaySockets: () => sockets,
      joinRoom: (() => { sockets['wss://a.example'] = socket; throw new Error('boom'); }) as never,
    };
    expect(() => createTrysteroTransport(options, lib)).toThrow('boom');
    expect(reopened).not.toHaveBeenCalled();
  });

  it('leaves the room if makeAction throws after joinRoom succeeded', () => {
    vi.stubGlobal('RTCPeerConnection', class {});
    const leave = vi.fn(async () => undefined);
    const room = { makeAction: () => { throw new Error('no action'); }, getPeers: () => ({}), leave };
    const lib = { getRelaySockets: () => ({}), joinRoom: (() => room) as never };
    expect(() => createTrysteroTransport(options, lib)).toThrow('no action');
    expect(leave).toHaveBeenCalledOnce();
  });
});

// A Trystero room with peer connections the test controls. Peers find each other through the room's signalling
// clients, so a peer can connect only while at least one of them has an open socket, and only until the room is left.
class FakeConnection extends EventTarget {
  connectionState: RTCPeerConnectionState = 'connected';
  close = vi.fn(() => { this.connectionState = 'closed'; });
}

// The page's shared connections, one per peer: like Trystero's shared peers, a connection outlives the room it formed
// in, and a room joined later is given each one that is not stale (closed or failed) and whose peer is in that room.
// Like Trystero 0.25.4, the new room runs its own handshake over the connection's data channel (room.mjs onPeer,
// handshake.mjs) and lists the peer, and reports it joined, only once that is done (room.mjs onActivate, getPeers): the
// fake makes a connected one active at once and keeps any other pending and unlisted (in Trystero a disconnected one that recovers within the 10 s handshake timeout
// would become active; no test needs that, so the fake does not model it). Trystero reports a peer
// gone only if it was active (room.mjs exitPeer), so a pending one closing reports nothing.
type SharedConnections = Map<string, FakeConnection>;
// Trystero closed the connection after it stayed disconnected (the fake's event): every room using it reports the
// peer gone.
const TRYSTERO_CLOSED = 'trystero-closed';
const isStale = (connection: FakeConnection) => connection.connectionState === 'closed' || connection.connectionState === 'failed';

// How long Trystero lets a disconnected connection recover before it closes it (peer.mjs).
const DISCONNECTED_CLOSE_MS = 5000;

// How long Trystero's leave() takes: it tells the peers, then waits 99 ms before it lets the room go (room.mjs).
const LEAVE_MS = 100;
// How long a participant waits for a host that left its room with the connection still up to come back (trystero.ts).
const HOST_LINK_GRACE_MS = 8000;
// How long after a rejoin a link it lost may stay missing before the page rejoins once more (trystero.ts).
const LINK_VERIFY_MS = 10_000;
// How long after that rejoin a link still missing makes the page rejoin for the last time (trystero.ts): past Trystero's
// 23.333 s answering TTL.
const LINK_FINAL_MS = 26_000;
// How soon after entering its room a hidden page may have had its host's connection cut off (trystero.ts).
const HOST_JOIN_WINDOW_MS = 30_000;
// How long such a page must stay hidden before its resume rejoins for a host not yet listed (trystero.ts).
const HOST_JOIN_MIN_HIDDEN_MS = 2000;

function fakeRoom(signalling: () => boolean = () => true, shared: SharedConnections = new Map()) {
  const peers: Record<string, FakeConnection> = {};
  const action = { send: vi.fn(async () => undefined), onMessage: null as null | ((data: unknown, meta: { peerId: string }) => void) };
  let joinHandler: null | ((id: string) => void) = null;
  const room = {
    peers,
    action,
    // Like Trystero, setting the handler reports the peers already in the room.
    get onPeerJoin() { return joinHandler; },
    set onPeerJoin(handler: null | ((id: string) => void)) {
      joinHandler = handler;
      if (handler) for (const id of Object.keys(peers)) handler(id);
    },
    onPeerLeave: null as null | ((id: string) => void),
    makeAction: () => action,
    getPeers: () => ({ ...peers }),
    leave: vi.fn(() => new Promise<undefined>((resolve) => { setTimeout(() => resolve(undefined), LEAVE_MS); })),
    // The room is gone once a leave() has resolved; one that failed leaves it in place.
    isLeft: () => room.leave.mock.settledResults.some((result) => result.type === 'fulfilled'),
    // Trystero drops a peer when its connection reports closed; the fake does the same.
    connect(id: string): FakeConnection {
      if (room.isLeft()) throw new Error(`this room was left, so ${id} cannot join it`);
      if (!signalling()) throw new Error(`no open signalling socket for this room, so ${id} cannot find it`);
      const connection = new FakeConnection();
      shared.set(id, connection);
      room.attach(id, connection);
      room.onPeerJoin?.(id);
      return connection;
    },
    // The room uses the connection for the peer (one it formed, or a shared one it was joined with).
    attach(id: string, connection: FakeConnection): void {
      connection.addEventListener('connectionstatechange', () => {
        if (connection.connectionState === 'closed' && peers[id] === connection) room.drop(id);
      });
      connection.addEventListener(TRYSTERO_CLOSED, () => {
        if (peers[id] !== connection) return;
        delete peers[id];
        room.onPeerLeave?.(id);
      });
      peers[id] = connection;
    },
    // The page's shared connections this room was given that never finished its handshake: Trystero does not list them.
    pending: {} as Record<string, FakeConnection>,
    // The room is given a shared connection as it is joined: active if it is connected, else pending until it closes.
    carry(id: string, connection: FakeConnection): void {
      if (connection.connectionState === 'connected') {
        room.attach(id, connection);
        return;
      }
      room.pending[id] = connection;
      const forget = () => { if (room.pending[id] === connection) delete room.pending[id]; };
      connection.addEventListener('connectionstatechange', () => { if (isStale(connection)) forget(); });
      connection.addEventListener(TRYSTERO_CLOSED, forget);
    },
    // The connection is lost (a lock, ICE failing): Trystero reports the peer gone once its connection is down.
    drop(id: string): void {
      const connection = peers[id];
      if (!connection) return;
      if (connection.connectionState === 'connected') connection.connectionState = 'failed';
      delete peers[id];
      room.onPeerLeave?.(id);
    },
    // ICE loses the connection for now (a short lock, a Wi-Fi blip): it may recover, and if it is still disconnected
    // after DISCONNECTED_CLOSE_MS, Trystero closes it and reports the peer gone, the connection still reading
    // disconnected.
    // The connection is shared, so every room using it then reports the peer gone, the one it formed in or not.
    disconnects(id: string): FakeConnection {
      const connection = peers[id]!;
      connection.connectionState = 'disconnected';
      setTimeout(() => {
        if (connection.connectionState !== 'disconnected') return;
        if (shared.get(id) === connection) shared.delete(id);
        connection.dispatchEvent(new Event(TRYSTERO_CLOSED));
      }, DISCONNECTED_CLOSE_MS);
      return connection;
    },
    // The peer leaves the room (its page leaves the meeting or rejoins, or closes the connection, as closing its tab
    // does): Trystero reports it gone while this side's connection still reads connected. The peer is in no room of
    // this page's now, so no room joined later gets its connection.
    // With keepsConnection the page's shared connection to the peer stays, as Trystero's does until it fails:
    // a room joined later is given it, and runs its handshake over it, if it is not stale.
    departs(id: string, { keepsConnection = false } = {}): void {
      if (!peers[id]) return;
      if (!keepsConnection && shared.get(id) === peers[id]) shared.delete(id);
      delete peers[id];
      room.onPeerLeave?.(id);
    },
  };
  return room;
}

type FakeSocket = { url: string; open: boolean; readonly readyState: number; onclose: (() => void) | null; close: ReturnType<typeof vi.fn<() => void>> };

// Trystero's wait before it opens a socket again, at most 53 s (makeSocket's retry timer).
const RETRY_MS = 50_000;

// Like Trystero in a page, it keeps one signalling client per relay URL for the life of the page, whatever room or
// transport asked for it: joining through a URL whose socket was closed for good gets that dead client back. Like
// Trystero's strategy, it sets up clients only for a join made while no room is open or being left, and every room
// joined meanwhile uses those, whatever URLs it is given; a join of a room ID still open or being left gets that room.
// Like Trystero's makeSocket, a socket that closes runs its close handler, which opens a new socket for the URL after
// RETRY_MS. A socket to an unreachable relay closes as soon as it opens.
function fakeLib() {
  const rooms: ReturnType<typeof fakeRoom>[] = [];
  // The URLs each join asked for.
  const urls: string[][] = [];
  const sockets: Record<string, FakeSocket> = {};
  const made: FakeSocket[] = [];
  const unreachable = new Set<string>();
  const occupied = new Map<string, ReturnType<typeof fakeRoom>>();
  let initUrls: string[] = [];
  // Trystero's didInit with no room to reset it: set by a join that threw after init, cleared when a room is left.
  let stuckInit = false;
  const shared: SharedConnections = new Map();
  const open = (url: string): void => {
    const socket: FakeSocket = {
      url,
      open: true,
      get readyState() { return this.open ? 1 : 3; },
      onclose: () => { setTimeout(() => open(url), RETRY_MS); },
      close: vi.fn(() => {
        if (!socket.open) return;
        socket.open = false;
        socket.onclose?.();
      }),
    };
    sockets[url] = socket;
    made.push(socket);
    if (unreachable.has(url)) {
      socket.open = false;
      socket.onclose?.();
    }
  };
  const fake = {
    rooms,
    urls,
    sockets,
    unreachable,
    // While set, a join throws before there is a room. With true it throws after setting up its clients but before they
    // count as set up, so the next join sets up clients again. With 'afterInit' it throws after Trystero marks them set
    // up (its didInit), as a throw while making the offer pool's first connection does: until a room is left, every join
    // is given those clients, whatever URLs it asks for (see enter in trystero.ts).
    failJoins: false as boolean | 'afterInit',
    lib: {
      getRelaySockets: () => sockets,
      joinRoom: ((config: { relayConfig: { urls: string[] } }, roomId: string) => {
        urls.push(config.relayConfig.urls);
        // Like Trystero's onSelfLeave: leaving the last active room resets didInit.
        let leftOne = false;
        for (const [id, room] of occupied) if (room.isLeft()) { occupied.delete(id); leftOne = true; }
        if (leftOne && occupied.size === 0) stuckInit = false;
        const existing = occupied.get(roomId);
        if (existing) return existing;
        if (occupied.size === 0 && !stuckInit) {
          initUrls = config.relayConfig.urls;
          for (const url of initUrls) if (!sockets[url]) open(url);
          if (fake.failJoins === 'afterInit') stuckInit = true;
        }
        if (fake.failJoins) throw new Error('join failed');
        const roomUrls = initUrls;
        const room = fakeRoom(() => roomUrls.some((url) => sockets[url]!.open), shared);
        // Like Trystero, the new room is given the page's shared connections that are not stale.
        for (const [id, connection] of shared) if (!isStale(connection)) room.carry(id, connection);
        occupied.set(roomId, room);
        rooms.push(room);
        return room;
      }) as never,
    },
    // The relay ends the socket, as one does while a phone is locked: Trystero's close handler will open another.
    relayCloses(url: string): void {
      const socket = sockets[url]!;
      socket.open = false;
      socket.onclose?.();
    },
    // An old client opens a socket again, as one waiting for the browser to come back online does.
    reopens: (url: string): void => open(url),
    openSockets: (): string[] => made.filter((socket) => socket.open).map((socket) => socket.url).sort(),
  };
  return fake;
}

// The page's visibility, which the test turns.
function fakePage(hidden = false) {
  let cb: ((hidden: boolean) => void) | undefined;
  const page = {
    isHidden: hidden,
    hidden: () => page.isHidden,
    watch: (fn: (hidden: boolean) => void) => { cb = fn; return () => { cb = undefined; }; },
    hide: () => { page.isHidden = true; cb?.(true); },
    show: () => { page.isHidden = false; cb?.(false); },
  };
  return page;
}

function setUp(relays = ['wss://a.example'], { hidden = false } = {}) {
  const fake = fakeLib();
  const page = fakePage(hidden);
  const t = createTrysteroTransport({ ...options, relays }, fake.lib, page);
  const joins: string[] = [];
  const leaves: string[] = [];
  t.onPeerJoin((id) => joins.push(id));
  t.onPeerLeave((id) => leaves.push(id));
  return { ...fake, fake, page, t, joins, leaves };
}

describe('createTrysteroTransport resume', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', class {});
  });
  afterEach(() => { vi.useRealTimers(); });

  it('does nothing when every direct connection is still up', async () => {
    const { rooms, t, page, openSockets, urls } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(rooms).toHaveLength(1);
    expect(rooms[0]!.leave).not.toHaveBeenCalled();
    expect(openSockets()).toEqual(['wss://a.example']);
    expect(urls).toHaveLength(1);
    expect(t.status('alice')).toBe('direct');
  });

  it('rejoins after a connection closed while the page was frozen, so the peers connect again', async () => {
    const { rooms, t, page, sockets, urls, joins, leaves } = setUp();
    const got: string[] = [];
    t.onMessage((id, data) => got.push(`${id}:${data.length}`));
    const dead = rooms[0]!.connect('alice');
    rooms[0]!.connect('bob');
    page.hide();
    // A connection closed locally fires no connectionstatechange, so Trystero still lists it.
    dead.connectionState = 'closed';
    page.show();
    t.resume!();
    // Trystero is told the connection is closed, so its leave() does not send on the dead channel.
    expect(dead.close).toHaveBeenCalled();
    expect(t.peers()).toEqual([]);
    expect(t.status('bob')).toBe('offline');
    expect(leaves.sort()).toEqual(['alice', 'bob']);
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(rooms[0]!.leave).toHaveBeenCalledOnce();
    // Each peer is reported gone once, whichever way it went.
    expect(leaves).toHaveLength(2);
    // The old signalling socket is closed for good (no reconnecting handler), and the new room gets fresh clients:
    // Trystero's announcement back-off belongs to the old ones.
    expect(sockets['wss://a.example']!.close).toHaveBeenCalledOnce();
    expect(sockets['wss://a.example']!.onclose).toBeNull();
    expect(rooms).toHaveLength(2);
    expect(urls).toEqual([['wss://a.example'], ['wss://a.example/?rejoin=1']]);
    const room = rooms[1]!;
    room.connect('alice');
    // Bob's healthy connection is shared, so the new room gets it, as Trystero's does; Alice's closed one is not.
    expect(joins).toEqual(['alice', 'bob', 'bob', 'alice']);
    expect(t.status('alice')).toBe('direct');
    room.action.onMessage?.(new Uint8Array(3), { peerId: 'alice' });
    expect(got).toEqual(['alice:3']);
    await t.send('alice', new Uint8Array(1));
    expect(room.action.send).toHaveBeenCalledOnce();
  });

  it('rejoins on resume after a direct peer left while the page was hidden', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    rooms[0]!.drop('alice');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('counts a leave reported after the page was hidden and before it is shown again, as a frozen page reports one', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    rooms[0]!.drop('alice');
    // The resume runs inside the event that shows the page, before the transport hears of it.
    t.resume!();
    page.show();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('does not rejoin for a direct peer that left while the page was visible, at the next tab switch or after it', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    rooms[0]!.connect('bob');
    rooms[0]!.drop('alice');
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
    expect(t.status('bob')).toBe('direct');
  });

  it('does not rejoin for a peer that left while hidden but is connected again by the resume', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    rooms[0]!.drop('alice');
    rooms[0]!.connect('alice');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
  });

  it('does not rejoin when it has no direct connection and lost none', async () => {
    const { rooms, t, page } = setUp();
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rooms).toHaveLength(1);
  });

  it('as a participant, rejoins only for its link to the host', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('host');
    rooms[0]!.connect('bob').connectionState = 'closed';
    rooms[0]!.connect('carol');
    page.hide();
    rooms[0]!.drop('carol');
    page.show();
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
    page.hide();
    rooms[0]!.drop('host');
    page.show();
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  // a lock in the first instants after the connection formed, before Trystero listed the host. The room has
  // no peer at the resume, so nothing is down and nothing was lost; the watch could never fire and nothing retried.
  it('as a participant, rejoins on resuming from hidden when the host never joined its room, and retries while it is missing', async () => {
    const { rooms, t, page } = setUp();
    t.follow!(() => ({ host: 'host' }));
    page.hide();
    await vi.advanceTimersByTimeAsync(HOST_JOIN_MIN_HIDDEN_MS);
    page.show();
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(rooms).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS + LEAVE_MS);
    expect(rooms).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(LINK_FINAL_MS + LEAVE_MS);
    expect(rooms).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(rooms).toHaveLength(4);
  });

  it('as a participant, does not rejoin for a host not yet listed when the page was hidden only briefly', async () => {
    const { rooms, t, page } = setUp();
    t.follow!(() => ({ host: 'host' }));
    for (let flip = 0; flip < 3; flip++) {
      page.hide();
      await vi.advanceTimersByTimeAsync(HOST_JOIN_MIN_HIDDEN_MS - 1);
      page.show();
      t.resume!({ host: 'host' });
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
    }
    await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS + LINK_FINAL_MS + LEAVE_MS * 2);
    expect(rooms).toHaveLength(1);
  });

  it('as a participant, does not retry once the host is back after the resume\'s rejoin', async () => {
    const { rooms, t, page } = setUp();
    t.follow!(() => ({ host: 'host' }));
    page.hide();
    await vi.advanceTimersByTimeAsync(HOST_JOIN_MIN_HIDDEN_MS);
    page.show();
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    rooms[1]!.connect('host');
    await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS + LINK_FINAL_MS + LEAVE_MS * 2);
    expect(rooms).toHaveLength(2);
  });

  it('as a participant, does not rejoin on resuming while it knows no host, or when the page was not hidden', async () => {
    const { rooms, t, page } = setUp();
    page.hide();
    page.show();
    t.resume!({ host: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
  });

  it('as a participant, rejoins when its connection to the host is found dead, and not while it knows no host', async () => {
    const { rooms, t, page } = setUp();
    const host = rooms[0]!.connect('host');
    page.hide();
    host.connectionState = 'closed';
    page.show();
    t.resume!({ host: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('rejoins once if a direct connection drops within 30 s of resuming from hidden, and not after', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(rooms).toHaveLength(1);
    // A real lock ends the connection by ICE timeout, some seconds after the page is back.
    rooms[0]!.drop('alice');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
    rooms[1]!.connect('alice');
    rooms[1]!.drop('alice');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('leaves a connection that drops more than 30 s after resuming to Trystero', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(31_000);
    rooms[0]!.drop('alice');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
  });

  it('leaves a connection disconnected at the resume to recover: no rejoin, and the connection is not closed', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    const bob = rooms[0]!.connect('bob');
    page.hide();
    rooms[0]!.disconnects('bob');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(2000);
    bob.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(40_000);
    expect(rooms).toHaveLength(1);
    expect(bob.close).not.toHaveBeenCalled();
    expect(t.status('bob')).toBe('direct');
  });

  it('as a participant, leaves its link to the host disconnected at the resume to recover', async () => {
    const { rooms, t, page } = setUp();
    const host = rooms[0]!.connect('host');
    page.hide();
    rooms[0]!.disconnects('host');
    page.show();
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(2000);
    host.connectionState = 'connected';
    await vi.advanceTimersByTimeAsync(40_000);
    expect(rooms).toHaveLength(1);
  });

  it('rejoins once when Trystero closes a connection disconnected at the resume, within the watch', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    rooms[0]!.disconnects('alice');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DISCONNECTED_CLOSE_MS);
    expect(rooms).toHaveLength(2);
    // Alice is not back 10 s after that rejoin, so it is tried once more, and 26 s after that for the last time.
    await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS + LEAVE_MS);
    expect(rooms).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(LINK_FINAL_MS + LEAVE_MS);
    expect(rooms).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rooms).toHaveLength(4);
  });

  it('rejoining, closes only the connections that are down, not one that is disconnected', async () => {
    const { rooms, t, page } = setUp();
    const alice = rooms[0]!.connect('alice');
    const bob = rooms[0]!.connect('bob');
    page.hide();
    alice.connectionState = 'closed';
    rooms[0]!.disconnects('bob');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(rooms).toHaveLength(2);
    expect(alice.close).toHaveBeenCalled();
    expect(bob.close).not.toHaveBeenCalled();
  });

  it('after a rejoin for one lost link, a link only disconnected at the resume that Trystero then closes comes back with the one more rejoin', async () => {
    const { rooms, t, page, leaves } = setUp();
    const alice = rooms[0]!.connect('alice');
    rooms[0]!.connect('bob');
    page.hide();
    alice.connectionState = 'closed';
    rooms[0]!.disconnects('bob');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(rooms).toHaveLength(2);
    // The new room is given Bob's shared connection, but it is disconnected, so the room's handshake over it never
    // finishes: the room does not list Bob.
    expect(Object.keys(rooms[1]!.pending)).toEqual(['bob']);
    expect(rooms[1]!.getPeers()).toEqual({});
    expect(t.status('bob')).toBe('offline');
    // Trystero closes it 5 s after it disconnected and reports nothing, as Bob was never active in the new room; the
    // rejoin watches nothing after it, so without the one more rejoin Bob's link would wait for the minute's
    // announcement.
    await vi.advanceTimersByTimeAsync(DISCONNECTED_CLOSE_MS);
    expect(rooms[1]!.pending).toEqual({});
    expect(rooms).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS + LEAVE_MS);
    expect(rooms).toHaveLength(3);
    rooms[2]!.connect('bob');
    expect(t.status('bob')).toBe('direct');
    expect(leaves.sort()).toEqual(['alice', 'bob']);
  });

  // the host's page rejoined while a participant was visible; the host closed its end of the link, but the
  // participant's old connection still read live, so Trystero ignored the host's announcements, then closed it about 5 s
  // later, after they had stopped. Only the participant can bring the link back in seconds, by rejoining itself.
  describe('as a visible participant whose link to the host goes down', () => {
    it('rejoins once its link to the host is closed, so the host is announced to again', async () => {
      const { rooms, t, joins } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      rooms[0]!.connect('bob');
      rooms[0]!.disconnects('host');
      await vi.advanceTimersByTimeAsync(DISCONNECTED_CLOSE_MS - 1);
      expect(rooms).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(rooms).toHaveLength(2);
      rooms[1]!.connect('host');
      expect(t.status('host')).toBe('direct');
      expect(joins.filter((id) => id === 'host')).toHaveLength(2);
    });

    it('does not rejoin for a host that left the room with its connection still up and is back within the grace, as when its page rejoins', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      rooms[0]!.departs('host');
      await vi.advanceTimersByTimeAsync(HOST_LINK_GRACE_MS - 1000);
      rooms[0]!.connect('host');
      await vi.advanceTimersByTimeAsync(HOST_LINK_GRACE_MS * 2);
      expect(rooms).toHaveLength(1);
    });

    // the host's end is closed, Trystero reports the host gone while this side's connection still
    // reads connected (it is not closed until ICE gives up), and the host's announcements came and went meanwhile.
    it('rejoins once the host has stayed out of the room for the grace, though the connection still reads connected', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      rooms[0]!.departs('host');
      await vi.advanceTimersByTimeAsync(HOST_LINK_GRACE_MS - 1);
      expect(rooms).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1 + LEAVE_MS);
      expect(rooms).toHaveLength(2);
    });

    // the host's page locked, so the participant's room reported the host gone, and by the time the participant
    // rejoins (the grace has passed) its connection to the host is disconnected, not yet failed. Trystero keeps that
    // shared connection and gives it to the new room, whose handshake over it never finishes, and it then ignores the
    // host's announcements, so the link did not come back for a minute.
    it('rejoining closes the connection of a peer its room reported gone, so the new room is not given a dead link', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      const link = rooms[0]!.connect('host');
      rooms[0]!.departs('host', { keepsConnection: true });
      link.connectionState = 'disconnected';
      await vi.advanceTimersByTimeAsync(HOST_LINK_GRACE_MS + LEAVE_MS);
      expect(rooms).toHaveLength(2);
      expect(link.close).toHaveBeenCalled();
      expect(rooms[1]!.pending).toEqual({});
      rooms[1]!.connect('host');
      expect(t.status('host')).toBe('direct');
    });

    it('does not close the connection of a peer that left its room and came back with it before the rejoin', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      const link = rooms[0]!.connect('host');
      rooms[0]!.departs('host', { keepsConnection: true });
      rooms[0]!.attach('host', link);
      rooms[0]!.onPeerJoin?.('host');
      rooms[0]!.connect('bob').connectionState = 'closed';
      t.resume!({ host: 'host' });
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(link.close).not.toHaveBeenCalled();
    });

    // the other page's old room, still leaving, made or answered an offer as the page rejoined, and that
    // half-made connection blocks the new room's announcements for as long as it lasts, longer than the test waits.
    it('rejoins once more if the host has not come back 10 s after its rejoin', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(rooms).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS - 1);
      expect(rooms).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1 + LEAVE_MS);
      expect(rooms).toHaveLength(3);
      rooms[2]!.connect('host');
      expect(t.status('host')).toBe('direct');
    });

    // the other page's half-made connection blocks announcements for up to 23.333 s, so a retry 10 s on can be
    // ignored, whichever page holds it; the last retry is past that.
    it('rejoins a last time LINK_FINAL_MS after the retry if the host is still missing, then no more', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS + LINK_VERIFY_MS + LEAVE_MS);
      expect(rooms).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(LINK_FINAL_MS - 1);
      expect(rooms).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1 + LEAVE_MS);
      expect(rooms).toHaveLength(4);
      rooms[3]!.connect('host');
      expect(t.status('host')).toBe('direct');
      await vi.advanceTimersByTimeAsync(300_000);
      expect(rooms).toHaveLength(4);
    });

    it('does not make the last rejoin if the host came back after the retry', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS + LINK_VERIFY_MS + LEAVE_MS);
      rooms[2]!.connect('host');
      await vi.advanceTimersByTimeAsync(LINK_FINAL_MS * 2);
      expect(rooms).toHaveLength(3);
    });

    // The host cares about every peer: a participant that reloaded or left for good is not a link to wait for.
    it('does not rejoin again for a peer that left with its connection down', async () => {
      const { rooms, t } = setUp();
      rooms[0]!.connect('alice');
      const gone = rooms[0]!.connect('bob');
      rooms[0]!.departs('bob', { keepsConnection: true });
      gone.connectionState = 'failed';
      rooms[0]!.connect('carol');
      t.resume!(undefined);
      rooms[0]!.connect('dave').connectionState = 'closed';
      t.resume!(undefined);
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(rooms).toHaveLength(2);
      rooms[1]!.connect('alice');
      rooms[1]!.connect('carol');
      rooms[1]!.connect('dave');
      await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS * 3);
      expect(rooms).toHaveLength(2);
    });

    it('forgets a peer that has been gone for minutes', async () => {
      const { rooms, t } = setUp();
      rooms[0]!.connect('alice');
      const gone = rooms[0]!.connect('bob');
      rooms[0]!.departs('bob', { keepsConnection: true });
      gone.connectionState = 'disconnected';
      await vi.advanceTimersByTimeAsync(180_000);
      rooms[0]!.connect('dave').connectionState = 'closed';
      t.resume!(undefined);
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(rooms).toHaveLength(2);
      rooms[1]!.connect('alice');
      rooms[1]!.connect('dave');
      await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS * 3);
      expect(rooms).toHaveLength(2);
      expect(gone.close).not.toHaveBeenCalled();
    });

    it('leaves a peer that left a moment ago with its connection still up for its new room to take back', async () => {
      const { rooms, t } = setUp();
      const link = rooms[0]!.connect('bob');
      rooms[0]!.departs('bob', { keepsConnection: true });
      await vi.advanceTimersByTimeAsync(1000);
      rooms[0]!.connect('dave').connectionState = 'closed';
      t.resume!(undefined);
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(link.close).not.toHaveBeenCalled();

      const later = setUp();
      const old = later.rooms[0]!.connect('bob');
      later.rooms[0]!.departs('bob', { keepsConnection: true });
      await vi.advanceTimersByTimeAsync(6000);
      later.rooms[0]!.connect('dave').connectionState = 'closed';
      later.t.resume!(undefined);
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(old.close).toHaveBeenCalled();
    });

    it('arms no retry if the meeting is left while the rejoin is under way', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      rooms[0]!.drop('host');
      const before = vi.getTimerCount();
      t.leave();
      await vi.advanceTimersByTimeAsync(LEAVE_MS * 3);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
    });

    it('rejoins for a missing link once only, and not if the link is back, the page hidden or the meeting left', async () => {
      const once = setUp();
      once.t.follow!(() => ({ host: 'host' }));
      once.rooms[0]!.connect('host');
      once.rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS + LINK_VERIFY_MS + LEAVE_MS + LINK_FINAL_MS + LEAVE_MS + 120_000);
      expect(once.rooms).toHaveLength(4);

      const back = setUp();
      back.t.follow!(() => ({ host: 'host' }));
      back.rooms[0]!.connect('host');
      back.rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      back.rooms[1]!.connect('host');
      back.rooms[1]!.drop('host');
      await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS * 2);
      expect(back.rooms).toHaveLength(2);

      const hidden = setUp();
      hidden.t.follow!(() => ({ host: 'host' }));
      hidden.rooms[0]!.connect('host');
      hidden.rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      hidden.page.hide();
      await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS * 2);
      expect(hidden.rooms).toHaveLength(2);

      const gone = setUp();
      gone.t.follow!(() => ({ host: 'host' }));
      gone.rooms[0]!.connect('host');
      gone.rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      gone.t.leave();
      await vi.advanceTimersByTimeAsync(LINK_VERIFY_MS * 2);
      expect(gone.rooms).toHaveLength(2);
    });

    it('does not rejoin after the grace if the page was hidden, or the meeting left, meanwhile', async () => {
      const first = setUp();
      first.t.follow!(() => ({ host: 'host' }));
      first.rooms[0]!.connect('host');
      first.rooms[0]!.departs('host');
      first.page.hide();
      await vi.advanceTimersByTimeAsync(HOST_LINK_GRACE_MS * 2);
      expect(first.rooms).toHaveLength(1);

      const second = setUp();
      second.t.follow!(() => ({ host: 'host' }));
      second.rooms[0]!.connect('host');
      second.rooms[0]!.departs('host');
      second.t.leave();
      await vi.advanceTimersByTimeAsync(HOST_LINK_GRACE_MS * 2);
      expect(second.rooms).toHaveLength(1);
    });

    it('does not rejoin for another participant\'s link, nor while the page is hidden, nor while it knows no host', async () => {
      const { rooms, t, page } = setUp();
      let host: string | null = null;
      t.follow!(() => ({ host }));
      rooms[0]!.connect('bob');
      rooms[0]!.drop('bob');
      rooms[0]!.connect('host');
      rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS * 2);
      expect(rooms).toHaveLength(1);
      host = 'host';
      rooms[0]!.connect('bob');
      rooms[0]!.drop('bob');
      page.hide();
      rooms[0]!.connect('host');
      rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS * 2);
      expect(rooms).toHaveLength(1);
    });

    it('does not rejoin within a minute of a rejoin of any kind: a resume\'s rejoin starts the floor too', async () => {
      const { rooms, t, page } = setUp();
      t.follow!(() => ({ host: 'host' }));
      const link = rooms[0]!.connect('host');
      page.hide();
      link.connectionState = 'closed';
      page.show();
      t.resume!({ host: 'host' });
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(rooms).toHaveLength(2);
      rooms[1]!.connect('host');
      rooms[1]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS * 2);
      expect(rooms).toHaveLength(2);
    });

    it('does not rejoin for a host link that drops after the meeting was left', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      t.leave();
      rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS * 2);
      expect(rooms).toHaveLength(1);
    });

    it('rejoins at most once a minute, and a page that never follows a host (the facilitator) does not rejoin', async () => {
      const { rooms, t } = setUp();
      t.follow!(() => ({ host: 'host' }));
      rooms[0]!.connect('host');
      rooms[0]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(rooms).toHaveLength(2);
      rooms[1]!.connect('host');
      rooms[1]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS * 2);
      expect(rooms).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(60_000);
      rooms[1]!.connect('host');
      rooms[1]!.drop('host');
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
      expect(rooms).toHaveLength(3);

      const facilitator = setUp();
      facilitator.rooms[0]!.connect('alice');
      facilitator.rooms[0]!.drop('alice');
      await vi.advanceTimersByTimeAsync(LEAVE_MS * 2);
      expect(facilitator.rooms).toHaveLength(1);
    });
  });

  it('warns that a room Trystero could not leave when the meeting was left keeps announcing until the page reloads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rooms, t } = setUp();
    rooms[0]!.leave.mockRejectedValue(new Error('send on a closed channel'));
    t.leave();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms[0]!.leave).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/keeps announcing on the relays until the page reloads/), expect.any(Error));
    warn.mockRestore();
  });

  it('watches after a resume only if the page was hidden: the Retry button resumes a visible page', async () => {
    const { rooms, t } = setUp();
    rooms[0]!.connect('alice');
    t.resume!();
    rooms[0]!.drop('alice');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
  });

  it('as a participant, watches only its link to the host after a resume', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('host');
    rooms[0]!.connect('bob');
    page.hide();
    page.show();
    t.resume!({ host: 'host' });
    rooms[0]!.drop('bob');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
    rooms[0]!.drop('host');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('ignores what the old room reports once it is rejoining: no leave reported twice, and no second rejoin', async () => {
    const { rooms, t, page, leaves, joins } = setUp();
    rooms[0]!.connect('alice').connectionState = 'closed';
    rooms[0]!.connect('bob');
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(rooms).toHaveLength(2);
    // The new room has Bob's shared connection. The old room's late reports: Trystero's leave() finishes its own
    // clean-up after the new room is up.
    expect(Object.keys(rooms[1]!.getPeers())).toEqual(['bob']);
    rooms[0]!.onPeerLeave?.('bob');
    rooms[0]!.onPeerJoin?.('carol');
    rooms[0]!.action.onMessage?.(new Uint8Array(1), { peerId: 'bob' });
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
    expect(leaves.sort()).toEqual(['alice', 'bob']);
    expect(joins).toEqual(['alice', 'bob', 'bob']);
    expect(t.status('bob')).toBe('direct');
  });

  it('marks the relay URLs afresh on each rejoin, and closes the sockets of the clients it is done with', async () => {
    const { rooms, t, page, urls, openSockets } = setUp(['wss://a.example', 'wss://b.example/v2']);
    for (let n = 0; n < 2; n += 1) {
      rooms[n]!.connect('alice').connectionState = 'closed';
      page.hide();
      page.show();
      t.resume!();
      await vi.advanceTimersByTimeAsync(LEAVE_MS);
    }
    expect(rooms).toHaveLength(3);
    expect(urls).toEqual([
      ['wss://a.example', 'wss://b.example/v2'],
      ['wss://a.example/?rejoin=1', 'wss://b.example/v2?rejoin=1'],
      ['wss://a.example/?rejoin=2', 'wss://b.example/v2?rejoin=2'],
    ]);
    expect(openSockets()).toEqual(['wss://a.example/?rejoin=2', 'wss://b.example/v2?rejoin=2']);
  });

  it('closes the sockets the old clients open again after a rejoin, for as long as their retry timers can run', async () => {
    const { rooms, t, page, relayCloses, openSockets } = setUp(['wss://a.example', 'wss://b.example']);
    rooms[0]!.connect('alice');
    page.hide();
    // The relays end the page's sockets in the lock; Trystero's retry timers will open new ones.
    relayCloses('wss://a.example');
    relayCloses('wss://b.example');
    rooms[0]!.drop('alice');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(rooms).toHaveLength(2);
    rooms[1]!.connect('alice');
    // Both retries fire some time after the rejoin, and each socket they open is closed soon after.
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openSockets()).toEqual(['wss://a.example/?rejoin=1', 'wss://b.example/?rejoin=1']);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(openSockets()).toEqual(['wss://a.example/?rejoin=1', 'wss://b.example/?rejoin=1']);
  });

  it('does not join again if the meeting was left while rejoining', async () => {
    const { rooms, t, page } = setUp();
    let finishLeaving = () => {};
    rooms[0]!.leave.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishLeaving = () => resolve(undefined); }));
    rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    t.leave();
    finishLeaving();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
  });

  it('if Trystero cannot leave the room, closes every connection and tries once more', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.leave.mockRejectedValueOnce(new Error('send on a closed channel'));
    rooms[0]!.connect('alice').connectionState = 'closed';
    const bob = rooms[0]!.connect('bob');
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(bob.close).toHaveBeenCalled();
    expect(rooms[0]!.leave).toHaveBeenCalledTimes(2);
    expect(rooms).toHaveLength(2);
  });

  it('stays in the old room, still working, if Trystero cannot leave it twice', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rooms, t, page, joins, leaves } = setUp();
    rooms[0]!.leave.mockRejectedValue(new Error('send on a closed channel'));
    rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(rooms).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/carrying on in it/), expect.any(Error));
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/keeps announcing/), expect.anything());
    rooms[0]!.connect('alice');
    expect(t.status('alice')).toBe('direct');
    rooms[0]!.drop('alice');
    expect(joins).toEqual(['alice', 'alice']);
    expect(leaves).toEqual(['alice', 'alice']);
    warn.mockRestore();
  });

  it('survives a rejoin whose join throws: it keeps what that join opened for the next resume, which tries again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake, rooms, t, page, openSockets } = setUp();
    fake.failJoins = true;
    rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(warn).toHaveBeenCalled();
    expect(t.peers()).toEqual([]);
    await expect(t.send('alice', new Uint8Array(1))).rejects.toThrow();
    // Trystero may keep these clients for the next join, so they stay open and the next join asks for them.
    expect(openSockets()).toEqual(['wss://a.example/?rejoin=1']);
    fake.failJoins = false;
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
    rooms[1]!.connect('alice');
    expect(t.status('alice')).toBe('direct');
    expect(openSockets()).toEqual(['wss://a.example/?rejoin=1']);
    warn.mockRestore();
  });

  it('gets the direct path back after a join that threw once Trystero had set its clients up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake, rooms, t, page, openSockets } = setUp();
    fake.failJoins = 'afterInit';
    rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.peers()).toEqual([]);
    fake.failJoins = false;
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
    // Trystero gave the new room the clients the failed join set up, so they must still be open.
    expect(openSockets().length).toBeGreaterThan(0);
    rooms[1]!.connect('alice');
    expect(t.status('alice')).toBe('direct');
    warn.mockRestore();
  });

  it('gives the page\'s next transport the clients a failed rejoin kept, after the first was left', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake, rooms, t, page, openSockets } = setUp();
    fake.failJoins = 'afterInit';
    rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    t.leave();
    await vi.advanceTimersByTimeAsync(1000);
    fake.failJoins = false;
    const second = createTrysteroTransport(options, fake.lib, fakePage());
    expect(rooms).toHaveLength(2);
    expect(openSockets().length).toBeGreaterThan(0);
    rooms[1]!.connect('bob');
    expect(second.status('bob')).toBe('direct');
    warn.mockRestore();
  });

  it('ignores a failed join of another transport while the first still had its room, once that room rejoins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { fake, rooms, t, page, openSockets } = setUp();
    // The second transport's join throws while the first has a room: Trystero is not stuck, as its init already succeeded.
    fake.failJoins = true;
    expect(() => createTrysteroTransport({ ...options, roomId: 'other' }, fake.lib, fakePage())).toThrow('join failed');
    fake.failJoins = false;
    // The first rejoins: its plain URLs are retired and swept once its old room is left.
    rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(3000);
    expect(rooms).toHaveLength(2);
    expect(openSockets()).not.toContain('wss://a.example');
    expect(openSockets().length).toBeGreaterThan(0);
    rooms[1]!.connect('alice');
    expect(t.status('alice')).toBe('direct');
    warn.mockRestore();
  });

  it('gives the page\'s next transport the clients a failed first join kept', () => {
    const fake = fakeLib();
    fake.failJoins = 'afterInit';
    expect(() => createTrysteroTransport(options, fake.lib, fakePage())).toThrow('join failed');
    fake.failJoins = false;
    const second = createTrysteroTransport(options, fake.lib, fakePage());
    expect(fake.rooms).toHaveLength(1);
    expect(fake.openSockets().length).toBeGreaterThan(0);
    fake.rooms[0]!.connect('bob');
    expect(second.status('bob')).toBe('direct');
  });

  it('survives a rejoin whose new room refuses the message channel', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { lib, rooms, t, page } = setUp();
    const joinRoom = lib.joinRoom as unknown as (config: unknown, roomId: string) => ReturnType<typeof fakeRoom>;
    lib.joinRoom = ((config: unknown, roomId: string) => {
      const room = joinRoom(config, roomId);
      if (rooms.length === 2) room.makeAction = () => { throw new Error('no action'); };
      return room;
    }) as never;
    rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms[1]!.leave).toHaveBeenCalled();
    expect(t.peers()).toEqual([]);
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(3);
    rooms[2]!.connect('alice');
    expect(t.status('alice')).toBe('direct');
    warn.mockRestore();
  });

  it('rejoins for a peer that left while the page was hidden with its connection still reading connected, as when its page closes the connection', async () => {
    const { rooms, t, page, leaves } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    // Its tab closed or reloaded, or it left the meeting or rejoined: this side cannot tell which.
    rooms[0]!.departs('alice');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
    expect(leaves).toEqual(['alice']);
  });

  it('as a participant, rejoins when the host it had a link to when the page was hidden is gone, however that was reported', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('host');
    page.hide();
    // The host's tab reloaded while this phone was locked: the connection still reads connected.
    rooms[0]!.departs('host');
    page.show();
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('as a participant, rejoins when the host has a new peer ID and the link it had when the page was hidden is gone', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('host');
    page.hide();
    rooms[0]!.departs('host');
    page.show();
    // The session heard of the reloaded host's new peer before the resume.
    t.resume!({ host: 'host-2' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('as a participant without a direct link to the host for a while, does not rejoin when it lost nothing in the lock', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('bob');
    await vi.advanceTimersByTimeAsync(HOST_JOIN_WINDOW_MS);
    page.hide();
    page.show();
    t.resume!({ host: 'host' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
  });

  it('does not rejoin when, within 30 s of resuming, a peer leaves the room on purpose: another page rejoining sets off no rejoin here', async () => {
    const { rooms, t, page } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(5000);
    rooms[0]!.departs('alice');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(1);
    // A link that goes down in the same window still does.
    rooms[0]!.connect('alice');
    rooms[0]!.drop('alice');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('started in a hidden page, counts a link lost before the page is first shown', async () => {
    const { rooms, t, page } = setUp(['wss://a.example'], { hidden: true });
    rooms[0]!.connect('alice');
    rooms[0]!.drop('alice');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('started in a hidden page, watches after the first resume', async () => {
    const { rooms, t, page } = setUp(['wss://a.example'], { hidden: true });
    rooms[0]!.connect('alice');
    page.show();
    t.resume!();
    rooms[0]!.drop('alice');
    await vi.advanceTimersByTimeAsync(1000);
    expect(rooms).toHaveLength(2);
  });

  it('keeps closing an old client\'s sockets while its retries go on, for up to 3 minutes', async () => {
    const { rooms, t, page, relayCloses, openSockets, unreachable } = setUp();
    rooms[0]!.connect('alice');
    page.hide();
    relayCloses('wss://a.example');
    rooms[0]!.drop('alice');
    // The relay cannot be reached for a while, so the old client's first retry fails and starts another.
    unreachable.add('wss://a.example');
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(rooms).toHaveLength(2);
    rooms[1]!.connect('alice');
    await vi.advanceTimersByTimeAsync(RETRY_MS + 10_000);
    unreachable.delete('wss://a.example');
    // The second retry opens a socket 100 s after the rejoin, past the first 65 s of sweeping.
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(openSockets()).toEqual(['wss://a.example/?rejoin=1']);
  });

  it('after leaving the meeting while a Trystero leave failed twice, reports nothing from the old room', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { rooms, t, page, joins } = setUp();
    const got: string[] = [];
    t.onMessage((id) => got.push(id));
    let failLeaving = () => {};
    rooms[0]!.leave.mockImplementationOnce(() => Promise.reject(new Error('send on a closed channel')));
    rooms[0]!.leave.mockImplementationOnce(() => new Promise<undefined>((_, reject) => { failLeaving = () => reject(new Error('send on a closed channel')); }));
    rooms[0]!.leave.mockRejectedValue(new Error('send on a closed channel'));
    rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    t.leave();
    failLeaving();
    await vi.advanceTimersByTimeAsync(1000);
    rooms[0]!.onPeerJoin?.('bob');
    rooms[0]!.action.onMessage?.(new Uint8Array(1), { peerId: 'bob' });
    expect(joins).toEqual(['alice']);
    expect(got).toEqual([]);
    expect(rooms).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/keeps announcing on the relays until the page reloads/), expect.any(Error));
    warn.mockRestore();
  });
});

// Trystero keeps its signalling clients for the life of the page, so what one transport did to them is what the
// page's next transport (another meeting from Home, taking a meeting back, a second link) gets.
describe('createTrysteroTransport in a page with other transports', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('RTCPeerConnection', class {});
  });
  afterEach(() => { vi.useRealTimers(); });

  const rejoinOnce = async (fake: ReturnType<typeof fakeLib>, page: ReturnType<typeof fakePage>, t: ReturnType<typeof createTrysteroTransport>, room: number) => {
    fake.rooms[room]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    t.resume!();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    // Alice is back in the new room, so the page does not rejoin again for her (LINK_VERIFY_MS).
    fake.rooms[fake.rooms.length - 1]!.connect('alice');
  };

  it('a transport that starts after another rejoined joins through fresh clients, and its peers connect', async () => {
    const fake = fakeLib();
    const page = fakePage();
    const first = createTrysteroTransport(options, fake.lib, page);
    await rejoinOnce(fake, page, first, 0);
    first.leave();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    const second = createTrysteroTransport(options, fake.lib, fakePage());
    await vi.advanceTimersByTimeAsync(200_000);
    fake.rooms[2]!.connect('bob');
    expect(second.status('bob')).toBe('direct');
    expect(fake.urls).toEqual([['wss://a.example'], ['wss://a.example/?rejoin=1'], ['wss://a.example/?rejoin=2']]);
    expect(fake.openSockets()).toEqual(['wss://a.example/?rejoin=2']);
  });

  // The board view remounts on a hash change, so the next meeting's transport can start within the 100 ms Trystero
  // takes to leave the last one's room.
  it('a transport for another meeting that starts while a rejoined one is still leaving joins through the clients Trystero still has, and its peers connect', async () => {
    const fake = fakeLib();
    const page = fakePage();
    const first = createTrysteroTransport(options, fake.lib, page);
    await rejoinOnce(fake, page, first, 0);
    first.leave();
    const second = createTrysteroTransport({ ...options, roomId: 'other' }, fake.lib, fakePage());
    await vi.advanceTimersByTimeAsync(200_000);
    fake.rooms[2]!.connect('bob');
    expect(second.status('bob')).toBe('direct');
    // Once it leaves, those clients are closed, and the next transport joins through fresh ones.
    second.leave();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(fake.openSockets()).toEqual([]);
    createTrysteroTransport(options, fake.lib, fakePage());
    fake.rooms[3]!.connect('carol');
    expect(fake.openSockets()).toEqual([fake.urls[3]![0]]);
  });

  it('a transport for the same meeting that starts while a rejoined one is still leaving it joins once that leave is done', async () => {
    const fake = fakeLib();
    const page = fakePage();
    const first = createTrysteroTransport(options, fake.lib, page);
    await rejoinOnce(fake, page, first, 0);
    first.leave();
    const second = createTrysteroTransport(options, fake.lib, fakePage());
    await vi.advanceTimersByTimeAsync(200_000);
    expect(fake.rooms).toHaveLength(3);
    fake.rooms[2]!.connect('bob');
    expect(second.status('bob')).toBe('direct');
    expect(fake.openSockets()).toEqual(['wss://a.example/?rejoin=2']);
  });

  it('a transport for another meeting joins through the clients of a room Trystero could not leave, which stay open', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fake = fakeLib();
    const page = fakePage();
    const first = createTrysteroTransport(options, fake.lib, page);
    fake.rooms[0]!.leave.mockRejectedValue(new Error('send on a closed channel'));
    fake.rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    first.resume!();
    first.leave();
    await vi.advanceTimersByTimeAsync(1000);
    const second = createTrysteroTransport({ ...options, roomId: 'other' }, fake.lib, fakePage());
    await vi.advanceTimersByTimeAsync(200_000);
    fake.rooms[1]!.connect('bob');
    expect(second.status('bob')).toBe('direct');
    warn.mockRestore();
  });

  it('a transport that leaves while its rejoin is leaving the old room leaves the next one fresh clients', async () => {
    const fake = fakeLib();
    const page = fakePage();
    const first = createTrysteroTransport(options, fake.lib, page);
    let finishLeaving = () => {};
    fake.rooms[0]!.leave.mockImplementationOnce(() => new Promise<undefined>((resolve) => { finishLeaving = () => resolve(undefined); }));
    fake.rooms[0]!.connect('alice').connectionState = 'closed';
    page.hide();
    page.show();
    first.resume!();
    first.leave();
    finishLeaving();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    const second = createTrysteroTransport(options, fake.lib, fakePage());
    await vi.advanceTimersByTimeAsync(200_000);
    fake.rooms[1]!.connect('bob');
    expect(second.status('bob')).toBe('direct');
  });

  it('a rejoin does not close the clients another transport in the page is still using', async () => {
    const fake = fakeLib();
    const page = fakePage();
    const first = createTrysteroTransport(options, fake.lib, page);
    const second = createTrysteroTransport({ ...options, roomId: 'other' }, fake.lib, fakePage());
    await rejoinOnce(fake, page, first, 0);
    // While another room is open, Trystero gives the new room the clients it already has.
    expect(fake.urls).toEqual([['wss://a.example'], ['wss://a.example'], ['wss://a.example']]);
    await vi.advanceTimersByTimeAsync(200_000);
    fake.rooms[1]!.connect('bob');
    expect(second.status('bob')).toBe('direct');
    fake.rooms[2]!.connect('carol');
    expect(first.status('carol')).toBe('direct');
    // Once no transport uses them, they are closed, and no transport joins through them again.
    first.leave();
    second.leave();
    await vi.advanceTimersByTimeAsync(LEAVE_MS);
    expect(fake.openSockets()).toEqual([]);
    createTrysteroTransport(options, fake.lib, fakePage());
    expect(fake.urls[3]).toEqual(['wss://a.example/?rejoin=1']);
    expect(fake.openSockets()).toEqual(['wss://a.example/?rejoin=1']);
  });

  it('closes the sockets old clients open when the browser comes back online, after the sweep has stopped', async () => {
    const listeners: Array<() => void> = [];
    vi.stubGlobal('addEventListener', (type: string, listener: () => void) => { if (type === 'online') listeners.push(listener); });
    const fake = fakeLib();
    const page = fakePage();
    const first = createTrysteroTransport(options, fake.lib, page);
    await rejoinOnce(fake, page, first, 0);
    await vi.advanceTimersByTimeAsync(600_000);
    // The old client was waiting for the browser to come back online.
    fake.reopens('wss://a.example');
    for (const listener of listeners) listener();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.openSockets()).toEqual(['wss://a.example/?rejoin=1']);
  });
});
