import type { Bytes } from '../crypto/bytes';
import { sharedView, splitView } from '../engine/redact';
import type { BoardState, PersonalView, SharedView, ViewContext } from '../engine/types';
import type { BundleFields } from '../protocol/bundle';
import { deliveryFor, type StaleTab, type TabTable } from './tabs';

// The parts of a relay bundle, built here for the host's sender and for the size tests alike, so the tests measure
// exactly what the host sends.

export interface BundleHeader {
  epoch: number;
  seq: number;
  refreshSeq: number;
  hostNow: number;
  host: string;
}

export type PersonalItem = PersonalView & { t: 'personal'; epoch: number; seq: number; host: string };

// What one person's entry carries beyond the board: acks and rejects for their latest tabs, and a refused join.
// listed is the host's in-memory note of tabs that resent a duplicate (sid -> time), which ranks the tabs listed.
export function entryContext(
  tabs: TabTable, personId: string, online: string[], stale?: StaleTab, joinRefused?: string, listed?: Record<string, number>,
): ViewContext {
  const { acks, rejects } = deliveryFor(tabs, personId, stale, listed);
  const ctx: ViewContext = { online, acks, rejects };
  if (joinRefused !== undefined) ctx.joinRefused = joinRefused;
  return ctx;
}

export function personalItem(state: BoardState, personId: string, ctx: ViewContext, header: BundleHeader): PersonalItem {
  const { personal } = splitView(state, personId, ctx);
  return { t: 'personal', epoch: header.epoch, seq: header.seq, host: header.host, ...personal };
}

// The entry for someone whose only peer records are probationary, or who was refused at the door: their role and
// a refused join, and nothing else of theirs (no dots, ballot, totals, acks or rejects). A hello can be an old one
// replayed, so it earns the shared view only, until an accepted ping or command.
export function neutralItem(state: BoardState, personId: string, header: BundleHeader, joinRefused?: string): PersonalItem {
  const role = Object.hasOwn(state.attendees, personId) ? state.attendees[personId].role : 'guest';
  const item: PersonalItem = {
    t: 'personal', epoch: header.epoch, seq: header.seq, host: header.host, you: personId, role, mine: {}, voted: false, acks: {}, rejects: {},
  };
  if (joinRefused !== undefined) item.joinRefused = joinRefused;
  return item;
}

export function bundleFields(state: BoardState, header: BundleHeader, online: string[]): BundleFields<SharedView> {
  return { ...header, boardId: state.boardId, shared: sharedView(state, { online }) };
}

// The last line of defence against a relay refusing a bundle as too large (docs/product/sync-protocol.md, Size): if
// the encoded event is over the limit, leave out what participants can recover without, in this order, until it
// fits: first every ack and reject but each person's newest tab's (older tabs' commands are resent after 3 s and
// acknowledged later); then the entries of people on a healthy direct path, who get a direct snapshot anyway, keeping
// the refused joiners' (the only place a relay-only joiner learns why); then the refused joiners' entries too. An
// attendee's entry is never left out to make room for a refused joiner's. `over` is true exactly when the last of
// those does not fit: the bundle with every entry but the direct-path people's then goes out regardless, refused
// joiners' entries included so that a relay that accepts it still carries the reason, and the host shows it and
// refuses growth. The size meter keeps boards well inside the limit, so this should never trim anything.
export async function fitBundle(
  personals: PersonalItem[], strangers: ReadonlySet<string>, direct: ReadonlySet<string>,
  encode: (personals: PersonalItem[]) => Promise<Bytes>, eventBytes: (wire: Bytes) => number, max: number,
): Promise<{ wire: Bytes; trimmed: number; over: boolean }> {
  const newestTabOnly = (p: PersonalItem): PersonalItem => {
    const [sid] = Object.keys(p.acks);
    return { ...p, acks: sid ? { [sid]: p.acks[sid] } : {}, rejects: sid && p.rejects[sid] ? { [sid]: p.rejects[sid] } : {} };
  };
  const newest = personals.map(newestTabOnly);
  const notDirect = newest.filter((p) => strangers.has(p.you) || !direct.has(p.you));
  const steps: PersonalItem[][] = [personals, newest, notDirect, notDirect.filter((p) => !strangers.has(p.you))];
  const wires: Bytes[] = [];
  for (const [trimmed, step] of steps.entries()) {
    wires.push(await encode(step));
    if (eventBytes(wires[trimmed]) <= max) return { wire: wires[trimmed], trimmed, over: false };
  }
  console.warn('A bundle is over the relay limit even after trimming');
  return { wire: wires[2], trimmed: steps.length - 1, over: true };
}
