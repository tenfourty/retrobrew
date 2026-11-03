import { changed, refuse } from './result';
import type { BoardState, ColumnId, Result } from './types';

// Moves every topic in one column to another, keeping its position.
function moveAll(state: BoardState, from: ColumnId, to: ColumnId): void {
  for (const t of state.topics) if (t.column === from) t.column = to;
}

export function startDiscussion(state: BoardState): Result {
  if (state.phase !== 'topics') return refuse('alreadyDiscussion');
  if (!state.topics.some((t) => t.column === 'ideas')) return refuse('noTopicsYet');
  const next = structuredClone(state);
  next.phase = 'discussion';
  moveAll(next, 'ideas', 'toDiscuss');
  return changed(next);
}

export function backToTopics(state: BoardState): Result {
  if (state.phase !== 'discussion') return refuse('alreadyTopics');
  if (state.topics.some((t) => t.column === 'discussing')) return refuse('finishFirst');
  const next = structuredClone(state);
  next.phase = 'topics';
  moveAll(next, 'toDiscuss', 'ideas');
  return changed(next);
}

// A topic still in Discussing is finished first, so it counts as discussed.
export function endMeeting(state: BoardState, now: number): Result {
  const next = structuredClone(state);
  const discussing = next.topics.find((t) => t.column === 'discussing');
  if (discussing) {
    discussing.column = 'discussed';
    next.discussedOrder.push(discussing.topicId);
  }
  next.timer = null;
  next.continueVote = null;
  next.endedAt = now;
  next.phase = 'ended';
  return changed(next);
}

// Always back to discussion, never to topics. Votes, discussedOrder and voteRound carry on.
export function reopenMeeting(state: BoardState): Result {
  if (state.phase !== 'ended') return refuse('notEnded');
  const next = structuredClone(state);
  next.phase = 'discussion';
  next.endedAt = null;
  moveAll(next, 'ideas', 'toDiscuss');
  return changed(next);
}
