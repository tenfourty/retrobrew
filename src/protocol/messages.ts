import type { ViewState } from '../engine/types';
import { isSid } from './sid';
import { withViewDefaults } from './view-defaults';

// Every signed message names its context (sending peer, tab, epoch, recipient), so a copy replayed from
// elsewhere, sent to another meeting or held over from an earlier host session is rejected
// (docs/product/sync-protocol.md, Signed messages carry their context).

// pv is the sender's protocol version; a hello without one is protocol 1. boardId is null only in protocol 1.
// sid, n and at (like a ping's) are what a protocol 2 hello needs to be accepted: the tab, a count of its hellos from 1
// and the sender's estimate of the host's clock. Without them (protocol 1, or another version) a hello only gets the
// version reply.
export interface Hello { t: 'hello'; pv: number; boardId: string | null; name: string; peer: string; sid?: string; n?: number; at?: number }
// cmd stays unparsed here, so the host can refuse an unknown or malformed command with badCommand.
// peer is the sender's transport ID, checked against the frame it arrived in, like a ping's.
export interface CmdMessage { t: 'cmd'; boardId: string; peer: string; clientSeq: number; sid: string; epoch: number; cmd: unknown }
// sid and n (counting from 1 per tab) let the host accept each ping once; at is the sender's estimate of the host's
// clock, so the host can refuse a stale one. t0 is the sender's own clock, echoed in the pong.
export interface Ping { t: 'ping'; boardId: string; sid: string; n: number; at: number; t0: number; peer: string }
export type ToHost = Hello | CmdMessage | Ping;

export interface Snapshot { t: 'snapshot'; epoch: number; seq: number; hostNow: number; you: string; host: string; state: ViewState }
export interface Pong { t: 'pong'; t0: number; t1: number }
export type ToPeer = Snapshot | Pong;

// The version reply: a snapshot in wire layout 1, which every version reads, carrying a minimal board whose name says
// "reload this page" (or, from a host running another version, whatever it calls the board). Sent when a peer's hello
// is from a different protocol version.
export interface VersionReply { t: 'snapshot'; epoch: number; seq: number; you: string; host: string; boardName: string }

// The `state` of a version reply: a minimal board, which only needs a name and no topics.
export function versionReplyState(boardId: string, boardName: string, personId: string, name: string): Record<string, unknown> {
  return {
    boardId, boardName, phase: 'topics', topics: [], timer: null,
    attendees: { [personId]: { id: personId, name, role: 'guest' } },
  };
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string';

// pv is the layout the message arrived in. Protocol 1 frames carry only hellos that any host can read.
// A cmd needs a valid sid and a safe integer clientSeq of at least 1, so nothing malformed reaches the tab table.
export function parseToHost(x: unknown, pv: 1 | 2): ToHost | null {
  if (!isRecord(x)) return null;
  if (x.t === 'hello' && isStr(x.name) && isStr(x.peer)) {
    const hello: Hello = { t: 'hello', pv: Number.isInteger(x.pv) ? (x.pv as number) : 1, boardId: isStr(x.boardId) ? x.boardId : null, name: x.name, peer: x.peer };
    if (isSid(x.sid) && Number.isSafeInteger(x.n) && (x.n as number) >= 1 && isNum(x.at)) Object.assign(hello, { sid: x.sid, n: x.n as number, at: x.at });
    return hello;
  }
  if (pv !== 2) return null;
  if (x.t === 'ping' && isStr(x.boardId) && isSid(x.sid) && Number.isSafeInteger(x.n) && (x.n as number) >= 1 && isNum(x.at) && isNum(x.t0) && isStr(x.peer)) {
    return { t: 'ping', boardId: x.boardId, sid: x.sid, n: x.n as number, at: x.at, t0: x.t0, peer: x.peer };
  }
  if (x.t === 'cmd' && isStr(x.boardId) && isStr(x.peer) && Number.isSafeInteger(x.clientSeq) && (x.clientSeq as number) >= 1 && isSid(x.sid) && isNum(x.epoch)) {
    return { t: 'cmd', boardId: x.boardId, peer: x.peer, clientSeq: x.clientSeq as number, sid: x.sid, epoch: x.epoch, cmd: x.cmd };
  }
  return null;
}

// Host messages are signed by the host, so only their shape is checked here. Missing view fields get defaults.
export function parseToPeer(x: unknown): ToPeer | null {
  if (!isRecord(x)) return null;
  if (x.t === 'snapshot' && isNum(x.epoch) && isNum(x.seq) && isNum(x.hostNow) && isStr(x.you) && isStr(x.host)
    && isRecord(x.state) && isStr(x.state.boardId)) {
    const state = withViewDefaults(x.state);
    return state && { t: 'snapshot', epoch: x.epoch, seq: x.seq, hostNow: x.hostNow, you: x.you, host: x.host, state };
  }
  if (x.t === 'pong' && isNum(x.t0) && isNum(x.t1)) return { t: 'pong', t0: x.t0, t1: x.t1 };
  return null;
}

export function parseVersionReply(x: unknown): VersionReply | null {
  if (!isRecord(x) || x.t !== 'snapshot' || !isNum(x.epoch) || !isNum(x.seq) || !isStr(x.you) || !isStr(x.host)) return null;
  if (!isRecord(x.state) || !isStr(x.state.boardName) || !Array.isArray(x.state.topics)) return null;
  return { t: 'snapshot', epoch: x.epoch, seq: x.seq, you: x.you, host: x.host, boardName: x.state.boardName };
}
