import { MAX_ATTENDEES, MAX_NAME, cutTo, utf8Bytes } from './limits';
import { changed, growing, refuse, unchanged } from './result';
import type { BoardState, CommandOf, Result } from './types';

// Joining again from the same device keeps the person's identity, votes and topics, and only updates the name.
export function join(state: BoardState, actor: string, cmd: CommandOf<'join'>): Result {
  const name = cutTo(cmd.name.trim(), MAX_NAME);
  if (!name) return refuse('emptyName');
  const existing = state.attendees[actor];
  if (!existing && Object.keys(state.attendees).length >= MAX_ATTENDEES) return refuse('meetingFull');
  if (existing?.name === name) return unchanged(state);
  const next = structuredClone(state);
  next.attendees[actor] = existing ? { ...existing, name } : { id: actor, name, role: 'guest' };
  // Only a new person or a longer name can grow the board past the size cap.
  const grows = !existing || utf8Bytes(name) > utf8Bytes(existing.name);
  return grows ? growing(next, 'meetingFullSize') : changed(next);
}
