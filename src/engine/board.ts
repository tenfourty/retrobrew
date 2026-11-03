import { MAX_BOARD_NAME, cutTo } from './limits';
import type { BoardState } from './types';

export function createBoard(o: { boardId: string; boardName: string; ownerId: string; ownerName: string; rehearsal?: boolean }): BoardState {
  return {
    boardId: o.boardId,
    // Capped at 80 characters, so the size cap's arithmetic holds.
    boardName: cutTo(o.boardName.trim(), MAX_BOARD_NAME),
    phase: 'topics',
    voteAllowance: 3,
    showVotes: true,
    topicIdSeed: 1,
    topics: [],
    attendees: { [o.ownerId]: { id: o.ownerId, name: o.ownerName, role: 'owner' } },
    timer: null,
    voteRound: 0,
    continueVote: null,
    timerSound: 'chime',
    rehearsal: o.rehearsal ?? false,
    endedAt: null,
    discussedOrder: [],
  };
}

// Owner and facilitator alike. Someone with no attendee entry is a guest.
export function isFacilitator(state: BoardState, id: string): boolean {
  const attendee = state.attendees[id];
  return attendee !== undefined && attendee.role !== 'guest';
}

export function votesUsedBy(state: BoardState, id: string): number {
  return state.topics.reduce((n, t) => n + t.voters.filter((v) => v === id).length, 0);
}

// The allowance minus every dot the person has on any topic, in any column.
export function votesLeft(state: BoardState, id: string): number {
  return Math.max(0, state.voteAllowance - votesUsedBy(state, id));
}
