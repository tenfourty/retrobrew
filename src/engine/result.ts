import { MESSAGES, type MessageKey } from './messages';
import type { BoardState, Result, SizeKey } from './types';

export const refuse = (key: MessageKey): Result => ({ ok: false, key, message: MESSAGES[key] });
export const changed = (state: BoardState): Result => ({ ok: true, state, changed: true });
// Accepted, but the board is as it was, so its version (seq) stays put.
export const unchanged = (state: BoardState): Result => ({ ok: true, state, changed: false });
// Accepted, if the host's size measurement of the new state fits under the cap.
export const growing = (state: BoardState, key: SizeKey): Result => ({ ok: true, state, changed: true, grows: key });
