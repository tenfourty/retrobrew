import type { BoardState } from './types';

// The hard caps of docs/product/lean-coffee-rules.md, Limits.
export const MAX_ATTENDEES = 60;
export const MAX_NAME = 60;
export const MAX_BOARD_NAME = 80;

// Characters are Unicode code points, so an emoji counts as one.
export function codePoints(text: string): number {
  return [...text].length;
}

export function cutTo(text: string, max: number): string {
  return [...text].slice(0, max).join('');
}

export const MAX_TOPIC = 280;
export const MAX_TOPICS = 60;

// Topics are always one line: line breaks become spaces, then the text is trimmed.
export function cleanTopic(raw: string): string {
  return raw.replace(/\r\n|[\r\n\u2028\u2029]/g, ' ').trim();
}

// The size caps, in bytes, with 1 KB = 1,024 bytes. Sub-plan 3 imports these rather than defining its own.
// A relay event stays under 48 KB; a full refresh, with every personal entry, stays at or under 44 KB.
export const RELAY_EVENT_MAX_BYTES = 49_152;
export const REFRESH_CAP_BYTES = 45_056;

// Measures the full-refresh relay event a board would produce, in bytes. The real one is async
// (deflate, seal, sign), so the host awaits it.
export type Measure = (state: BoardState) => number | Promise<number>;

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

// For the facilitator's notice: a saved or imported board can break the limits. It loads unchanged
// and runs as normal, but growth is refused until it fits. refreshBytes is the board's measured size.
export function boardOverLimits(state: BoardState, refreshBytes: number): boolean {
  const attendees = Object.values(state.attendees);
  return state.topics.length > MAX_TOPICS
    || attendees.length > MAX_ATTENDEES
    || state.topics.some((t) => codePoints(t.text) > MAX_TOPIC)
    || attendees.some((a) => codePoints(a.name) > MAX_NAME)
    || codePoints(state.boardName) > MAX_BOARD_NAME
    || refreshBytes > REFRESH_CAP_BYTES;
}
