import { toB64url, utf8, type Bytes } from '../crypto/bytes';
import type { Signer } from '../crypto/sign';
import { MESSAGES } from '../engine/messages';
import { sharedView } from '../engine/redact';
import { SOUND_IDS, VOTE_ALLOWANCES, type BoardState, type ColumnId, type PersonalView, type Phase, type Role, type SharedView } from '../engine/types';
import { TABS_PER_VIEW } from '../session/tabs';
import { RELAY_EVENT_KIND } from '../config';
import { relayEvent } from '../transport/relay-frame';
import { bundleWireBytes, encodeBundle, ITEM_OVERHEAD } from './bundle';
import { deflate } from './compress';

// docs/product/sync-protocol.md, Size. The caps themselves, REFRESH_CAP_BYTES (44 KB) and RELAY_EVENT_MAX_BYTES
// (48 KB), live in src/engine/limits.ts.
//
// The meter measures, for a board, a full refresh at least as large as any the host can send for that board or for
// any board a command reaches without being measured: commands the engine doesn't mark as growing only shorten text
// or move values within the bounds used below. Every field takes its largest value; IDs, sids and numbers are random
// stand-ins at their longest, because deflate shrinks repeated text and real IDs are random; and a margin covers
// what compression can still vary. It deflates the stand-in bundle's outer message and one stand-in entry for real,
// and takes every other length from fixed overheads (signatures, IVs, tags, framing, base64url, the event's fields),
// so it seals, signs and hashes nothing (docs/product/sync-protocol.md, Size). The host's sender also enforces RELAY_EVENT_MAX_BYTES on every refresh itself
// (src/session/refresh.ts), so even a board the meter misjudged never produces an event a relay refuses.

// A Trystero transport ID is 20 characters, a room topic 32 hex digits (16 bytes of SHA-256), and a person's ID
// 22 base64url characters (a 16-byte fingerprint). Signatures, keys and IVs have fixed lengths.
export const TRANSPORT_ID_CHARS = 20;
export const TOPIC_CHARS = 32;
export const PERSON_ID_CHARS = 22;
// A room topic for tests that measure real events.
export const TOPIC_PLACEHOLDER = '0'.repeat(TOPIC_CHARS);
// A sid at its longest: 11 base-36 digits, a dot and 12 base64url characters (src/protocol/sid.ts).
// A person's ID as a live joiner has it.
const FINGERPRINT = /^[A-Za-z0-9_-]{22}$/;
const SID_TIME_CHARS = 11;
const SID_RANDOM_CHARS = 12;
// The margin added to each measurement.
export const MARGIN_RATIO = 0.02;
export const MARGIN_BYTES = 256;
// What every entry is allowed beyond the deflated size of the one measured for it. Entries with a fingerprint for
// an ID differ only in the random sids and numbers of their acks and rejects, which move a deflated entry by a few
// bytes (size.test.ts measures the spread). Entries also differ in the person's ID, which can be any length in an
// imported board: those are deflated on their own (standInEventBytes).
export const ITEM_SLACK_BYTES = 24;
// Deflate never expands its input by more than a zlib header and trailer plus 5 bytes per stored block; entries are
// far below one block, so this caps the slack where an entry is nearly incompressible.
const STORED_BLOCK_OVERHEAD = 11;
// What a signed envelope and a bundle's fixed-length strings take, in base64url characters.
const PUBLIC_KEY_CHARS = 87; // 65 raw bytes
const ECDSA_SIGNATURE_CHARS = 86; // 64 raw bytes
const ITEMS_HASH_CHARS = 43; // SHA-256
// A Nostr event's id and pubkey are 64 hex digits, its signature 128.
const EVENT_ID_CHARS = 64;
const EVENT_SIG_CHARS = 128;

const longest = <T extends string>(xs: readonly T[]): T => xs.reduce((a, b) => (b.length > a.length ? b : a));
const LONGEST_KEY = longest(Object.keys(MESSAGES));
const LONGEST_ROLE = longest<Role>(['owner', 'facilitator', 'guest']);
const LONGEST_PHASE = longest<Phase>(['topics', 'discussion', 'ended']);
const LONGEST_COLUMN = longest<ColumnId>(['ideas', 'toDiscuss', 'discussing', 'discussed']);
const MOST_VOTES = Math.max(...VOTE_ALLOWANCES);
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const HEX = '0123456789abcdef';
const DIGITS = '0123456789';

// At most this many people whose join was just refused get an entry in a bundle (the latest refusals). The host and
// the meter both use it, so a crowd of strangers can't push a refresh past the cap.
export const REFUSED_ENTRIES_MAX = 3;

export interface Refusal {
  personId: string;
  until: number;
}

// Who gets a personal entry in a bundle: every attendee but the host (the owner, whose ID is the host's), and the
// latest REFUSED_ENTRIES_MAX refused joiners. The host's sender uses exactly this list.
export function bundleRecipients(state: BoardState, hostId: string, refused: readonly Refusal[]): string[] {
  const attendees = Object.keys(state.attendees).filter((id) => id !== hostId);
  const strangers = refused
    .filter((r) => state.attendees[r.personId] === undefined && r.personId !== hostId)
    .sort((a, b) => b.until - a.until)
    .slice(0, REFUSED_ENTRIES_MAX)
    .map((r) => r.personId);
  return [...attendees, ...strangers];
}

// Random-looking stand-ins, the same sequence on every measurement so the meter is a function of the board.
export class StandIns {
  constructor(private seed = 0x2f6b1d) {}

  text(alphabet: string, length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) {
      this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
      out += alphabet[(this.seed >>> 8) % alphabet.length];
    }
    return out;
  }

  // A number with as many digits as Number.MAX_SAFE_INTEGER (16) that JSON writes in full.
  number(): number {
    return Number(`8${this.text(DIGITS, 15)}`);
  }

  sid(): string {
    return `${this.text(B36, SID_TIME_CHARS)}.${this.text(B64URL, SID_RANDOM_CHARS)}`;
  }
}

// measure is an arrow function, so it can be passed around on its own as a Measure.
export interface SizeMeter {
  measure: (state: BoardState) => Promise<number>;
}

// The shared part at its largest for this board: everyone online, every count shown and as large as the allowance
// allows, every topic in the longest column and discussed, the longest phase and sound, a timer and a vote with the
// longest numbers, and an end time. Commands that aren't measured can reach any of these, in any phase.
export function largestShared(state: BoardState, s: StandIns = new StandIns()): SharedView {
  const people = Object.keys(state.attendees).length;
  const lastCard = Math.max(0, ...state.topics.map((t) => t.topicId));
  const worst: BoardState = {
    ...state,
    phase: LONGEST_PHASE,
    voteAllowance: MOST_VOTES,
    showVotes: true,
    timerSound: longest(SOUND_IDS),
    endedAt: s.number(),
    discussedOrder: state.topics.map((t) => t.topicId),
    topics: state.topics.map((t) => ({ ...t, column: LONGEST_COLUMN, voters: [] })),
    timer: { topicId: lastCard, startedAt: s.number(), endsAt: s.number(), round: s.number(), minuteMs: s.number() },
    continueVote: { topicId: lastCard, round: s.number(), voters: Object.keys(state.attendees), totals: { extend: people, none: people, end: people } },
  };
  const shared = sharedView(worst, { online: Object.keys(state.attendees) });
  // Each person has at most the largest allowance of dots, so no topic can show more.
  for (const t of shared.topics) t.votes = people * MOST_VOTES;
  return shared;
}

// One person's entry at its largest: the largest allowance of dots on different topics, the longest role, a vote
// with totals, TABS_PER_VIEW acks and rejects with the longest sids, numbers and message key, and a refused join.
// Every field of PersonalView is present (size.test.ts checks), so no entry the host sends can be larger.
export function largestPersonal(
  state: BoardState, you: string, s: StandIns = new StandIns(), bundle?: { host: string; epoch: number; seq: number },
): Record<string, unknown> {
  const people = Object.keys(state.attendees).length;
  const ids = state.topics.map((t) => t.topicId).sort((a, b) => b - a).slice(0, MOST_VOTES);
  const mine: Record<string, number> = {};
  ids.forEach((id, i) => {
    mine[String(id)] = Math.floor(MOST_VOTES / ids.length) + (i < MOST_VOTES % ids.length ? 1 : 0);
  });
  const acks: Record<string, number> = {};
  const rejects: Record<string, { clientSeq: number; key: string }> = {};
  for (let i = 0; i < TABS_PER_VIEW; i++) {
    const sid = s.sid();
    acks[sid] = s.number();
    rejects[sid] = { clientSeq: s.number(), key: LONGEST_KEY };
  }
  const personal: Required<PersonalView> = {
    you, role: LONGEST_ROLE, mine, voted: false, totals: { extend: people, none: people, end: people }, acks, rejects,
    joinRefused: LONGEST_KEY,
  };
  // openItem accepts an entry only if its host, epoch and seq are the bundle's, so a stand-in entry carries them.
  const { host, epoch, seq } = bundle ?? { host: s.text(B64URL, TRANSPORT_ID_CHARS), epoch: s.number(), seq: s.number() };
  return { t: 'personal', epoch, seq, host, ...personal };
}

// The byte length of the final Nostr event JSON that would carry these sealed bytes.
export function relayEventBytes(wire: Bytes, from: string, topic: string, secretKey: Uint8Array): number {
  return utf8(JSON.stringify(relayEvent({ from, d: toB64url(wire) }, topic, secretKey))).length;
}

// The same length for sealed bytes of a given size, without signing: the event's fields are fixed-length strings
// and numbers around the frame, so a placeholder of each length serialises to as many bytes. Equal to
// relayEventBytes (size.test.ts checks).
export function relayEventBytesFor(wireBytes: number, from: string, topic: string): number {
  const frame = { from, d: 'A'.repeat(Math.ceil((wireBytes * 4) / 3)) };
  const event = {
    kind: RELAY_EVENT_KIND, created_at: Math.floor(Date.now() / 1000), tags: [['t', topic]], content: JSON.stringify(frame),
    pubkey: '0'.repeat(EVENT_ID_CHARS), id: '0'.repeat(EVENT_ID_CHARS), sig: '0'.repeat(EVENT_SIG_CHARS),
  };
  return utf8(JSON.stringify(event)).length;
}

// The stand-in bundle's parts: the fields of its outer message and every entry's personal message.
function standInBundle(state: BoardState, s: StandIns) {
  const owner = Object.values(state.attendees).find((a) => a.role === 'owner')?.id ?? '';
  // Attendee IDs are the real ones; refused joiners get random IDs of a fingerprint's length.
  const strangers = Array.from({ length: REFUSED_ENTRIES_MAX }, (_, i) => ({ personId: s.text(B64URL, PERSON_ID_CHARS), until: i }));
  const bundle = { host: s.text(B64URL, TRANSPORT_ID_CHARS), epoch: s.number(), seq: s.number() };
  const personals = bundleRecipients(state, owner, strangers).map((id) => largestPersonal(state, id, s, bundle) as { you: string });
  const fields = { ...bundle, refreshSeq: s.number(), hostNow: s.number(), boardId: state.boardId, shared: largestShared(state, s) };
  return { fields, personals };
}

// The sealed full refresh the meter's figure stands for, built for real: the largest bundle for this board, signed
// and sealed. The meter itself no longer builds it; tests compare the meter with it.
export async function buildStandInRefresh(state: BoardState, signer: Signer, roomKey: CryptoKey, s: StandIns = new StandIns()): Promise<Bytes> {
  const { fields, personals } = standInBundle(state, s);
  return encodeBundle(signer, roomKey, fields, personals);
}

// The meter's figure before its margin: the length of the event that carries the stand-in bundle, from the real
// deflated length of the outer message and of one entry, plus ITEM_SLACK_BYTES for each entry (never more than a
// stored block would take), and fixed overheads for the rest. The measured entry names a random 22-character person,
// so it stands for every entry whose person is one (every live joiner is: an ID is a fingerprint); an entry whose
// person's ID is any other (an imported board can hold IDs of any content and length) is deflated for real, on its own.
export async function standInEventBytes(state: BoardState, s: StandIns = new StandIns()): Promise<number> {
  const { fields, personals } = standInBundle(state, s);
  const outerMessage = { t: 'bundle', ...fields, items: personals.length, itemsHash: s.text(B64URL, ITEMS_HASH_CHARS) };
  const envelope = { v: 1, pub: s.text(B64URL, PUBLIC_KEY_CHARS), body: JSON.stringify(outerMessage), sig: s.text(B64URL, ECDSA_SIGNATURE_CHARS) };
  const bodies = personals.map((personal) => utf8(JSON.stringify(personal)));
  const template = utf8(JSON.stringify({ ...personals[0], you: s.text(B64URL, PERSON_ID_CHARS) }));
  const odd = personals.map((personal) => !FINGERPRINT.test(personal.you));
  const [outer, entry, ...own] = await Promise.all([
    deflate(utf8(JSON.stringify(envelope))), deflate(template), ...bodies.filter((_, i) => odd[i]).map((body) => deflate(body)),
  ]);
  let next = 0;
  const entries = bodies.map((body, i) => {
    const deflated = odd[i] ? own[next++].length : entry.length;
    return Math.min(deflated + ITEM_SLACK_BYTES, body.length + STORED_BLOCK_OVERHEAD);
  });
  return relayEventBytesFor(bundleWireBytes(outer.length, entries), s.text(B64URL, TRANSPORT_ID_CHARS), s.text(HEX, TOPIC_CHARS));
}

// Upper bounds the full refresh with fixed overheads and two real deflates (see the header). It needs no keys.
export async function createSizeMeter(): Promise<SizeMeter> {
  return {
    measure: async (state) => {
      const bytes = await standInEventBytes(state);
      return bytes + Math.ceil(bytes * MARGIN_RATIO) + MARGIN_BYTES;
    },
  };
}
