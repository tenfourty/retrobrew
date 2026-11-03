import { MESSAGES } from '../engine/messages';
import type { ShareLink } from '../link';
import type { KeyValueStore } from './handoff';

// The device remembers, per meeting, that it has joined and under which name, so a reload or the link opened again
// skips the join screen and rejoins silently (docs/product/mvp-screens.md, The join screen, Coming back).

function local(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const key = (boardId: string) => `rb-joined:${boardId}`;

// A meeting is its board ID and its facilitator's key. The name is stored with the key it was given to, so a link
// that reuses a board ID under another facilitator's key never rejoins silently: it shows the join form.
type Meeting = Pick<ShareLink, 'boardId' | 'hostPub'>;

export function joinedName(meeting: Meeting, store: KeyValueStore | null = local()): string | null {
  try {
    const parsed: unknown = JSON.parse(store?.getItem(key(meeting.boardId)) ?? 'null');
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { hostPub, name } = parsed as { hostPub?: unknown; name?: unknown };
    return hostPub === meeting.hostPub && typeof name === 'string' && name !== '' ? name : null;
  } catch {
    return null;
  }
}

// The device keeps the 20 most recent meetings; the order lives in one extra key, oldest first.
export const JOINED_LIMIT = 20;
const ORDER_KEY = 'rb-joined-order';

function readOrder(store: KeyValueStore): string[] {
  try {
    const parsed: unknown = JSON.parse(store.getItem(ORDER_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberJoined(meeting: Meeting, name: string, store: KeyValueStore | null = local()): void {
  const { boardId, hostPub } = meeting;
  try {
    if (!store) return;
    store.setItem(key(boardId), JSON.stringify({ hostPub, name }));
    const order = [...readOrder(store).filter((id) => id !== boardId), boardId];
    for (const dropped of order.splice(0, Math.max(0, order.length - JOINED_LIMIT))) store.removeItem(key(dropped));
    store.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // Without storage the join screen simply shows again next time.
  }
}

export function forgetJoined(boardId: string, store: KeyValueStore | null = local()): void {
  try {
    if (!store) return;
    store.removeItem(key(boardId));
    store.setItem(ORDER_KEY, JSON.stringify(readOrder(store).filter((id) => id !== boardId)));
  } catch {
    // Nothing to forget.
  }
}

// A join the host refused (ParticipantSession.joinRefused, a message key) sends the person back to the join form
// with the refusal in words.
export function joinRefusalText(joinRefused: string | null): string | null {
  if (joinRefused === null) return null;
  return Object.hasOwn(MESSAGES, joinRefused) ? (MESSAGES as Record<string, string>)[joinRefused] : MESSAGES.badCommand;
}
