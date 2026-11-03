import { describe, expect, it } from 'vitest';
import { createBoard } from './board';
import { migrateBoard } from './migrate';
import type { BoardState, ColumnId, Topic } from './types';

const NOW = 10_000_000;
const HOUR = 60 * 60_000;

function topic(topicId: number, column: ColumnId, position: number): Topic {
  return { topicId, text: `Topic ${topicId}`, column, position, authorId: 'o', voters: [] };
}

// A board as the walking skeleton saved it: none of the MVP fields, and a timer with no round.
function skeletonBoard(topics: Topic[], timer: { topicId: number; startedAt: number; endsAt: number } | null = null): BoardState {
  return {
    boardId: 'b', boardName: 'Old', voteAllowance: 3, showVotes: true, topicIdSeed: 10,
    topics, attendees: { o: { id: 'o', name: 'Olu', role: 'owner' } }, timer,
  } as unknown as BoardState;
}

describe('createBoard', () => {
  it('starts in the topics phase with every MVP field', () => {
    const s = createBoard({ boardId: 'b', boardName: 'Team', ownerId: 'o', ownerName: 'Olu' });
    expect(s).toMatchObject({
      phase: 'topics', voteRound: 0, continueVote: null, timerSound: 'chime', rehearsal: false, endedAt: null, discussedOrder: [],
    });
  });
  it('marks a rehearsal board only when asked', () => {
    expect(createBoard({ boardId: 'b', boardName: 'T', ownerId: 'o', ownerName: 'O', rehearsal: true }).rehearsal).toBe(true);
  });
});

describe('migrateBoard', () => {
  it('fills in defaults and derives the topics phase when every topic is in Ideas', () => {
    const s = migrateBoard(skeletonBoard([topic(1, 'ideas', 0)]), NOW);
    expect(s).toMatchObject({
      phase: 'topics', voteRound: 0, continueVote: null, timerSound: 'chime', rehearsal: false, endedAt: null, discussedOrder: [],
    });
    expect(s.topics[0].column).toBe('ideas');
  });

  it('derives the discussion phase and moves Ideas topics to To discuss, keeping their position', () => {
    const s = migrateBoard(skeletonBoard([topic(1, 'ideas', -1), topic(2, 'discussing', 0)]), NOW);
    expect(s.phase).toBe('discussion');
    expect(s.topics.find((t) => t.topicId === 1)).toMatchObject({ column: 'toDiscuss', position: -1 });
  });

  it('repairs a board in the topics phase that holds a topic in Discussing', () => {
    const board = createBoard({ boardId: 'b', boardName: 'T', ownerId: 'o', ownerName: 'O' });
    board.topics = [topic(1, 'ideas', 0), topic(2, 'discussing', 1)];
    board.voteRound = 1;
    board.timer = { topicId: 2, startedAt: NOW, endsAt: NOW + 60_000, round: 1, minuteMs: 60_000 };
    const s = migrateBoard(board, NOW);
    expect(s.phase).toBe('discussion');
    expect(s.topics.map((t) => t.column)).toEqual(['toDiscuss', 'discussing']);
    expect(s.timer).toEqual(board.timer);
  });

  it('moves stray Ideas topics of a board in the discussion phase to To discuss', () => {
    const board = createBoard({ boardId: 'b', boardName: 'T', ownerId: 'o', ownerName: 'O' });
    board.phase = 'discussion';
    board.topics = [topic(1, 'ideas', 0)];
    expect(migrateBoard(board, NOW).topics[0].column).toBe('toDiscuss');
  });

  it('lists Discussed topics by position, then topicId', () => {
    const s = migrateBoard(skeletonBoard([topic(5, 'discussed', 2), topic(3, 'discussed', 1), topic(4, 'discussed', 1)]), NOW);
    expect(s.discussedOrder).toEqual([3, 4, 5]);
  });

  it('gives a timer with no round the next round and real minutes', () => {
    const s = migrateBoard(skeletonBoard([topic(1, 'discussing', 0)], { topicId: 1, startedAt: NOW, endsAt: NOW + 60_000 }), NOW);
    expect(s.timer).toEqual({ topicId: 1, startedAt: NOW, endsAt: NOW + 60_000, round: 1, minuteMs: 60_000 });
    expect(s.voteRound).toBe(1);
  });

  it('clears a timer that ran out more than an hour ago, leaving the topic in Discussing', () => {
    const s = migrateBoard(skeletonBoard([topic(1, 'discussing', 0)], { topicId: 1, startedAt: 0, endsAt: NOW - HOUR - 1 }), NOW);
    expect(s.timer).toBeNull();
    expect(s.topics[0].column).toBe('discussing');
  });

  it('keeps a timer that ran out within the hour, so the first tick can open its vote', () => {
    const s = migrateBoard(skeletonBoard([topic(1, 'discussing', 0)], { topicId: 1, startedAt: 0, endsAt: NOW - HOUR }), NOW);
    expect(s.timer?.endsAt).toBe(NOW - HOUR);
  });

  it('drops a time-up vote whose timer is gone', () => {
    const board = createBoard({ boardId: 'b', boardName: 'T', ownerId: 'o', ownerName: 'O' });
    board.phase = 'discussion';
    board.topics = [topic(1, 'discussing', 0)];
    board.voteRound = 2;
    board.timer = { topicId: 1, startedAt: 0, endsAt: NOW - 2 * HOUR, round: 2, minuteMs: 60_000 };
    board.continueVote = { topicId: 1, round: 2, voters: ['o'], totals: { extend: 1, none: 0, end: 0 } };
    const s = migrateBoard(board, NOW);
    expect(s.timer).toBeNull();
    expect(s.continueVote).toBeNull();
    expect(s.voteRound).toBe(2);
  });

  it('never lets voteRound fall below the timer or the vote it keeps, even when the timer is stale', () => {
    const mk = () => {
      const b = createBoard({ boardId: 'b', boardName: 'T', ownerId: 'o', ownerName: 'O' });
      b.phase = 'discussion';
      b.topics = [topic(1, 'discussing', 0)];
      return b;
    };
    const live = mk();
    live.voteRound = 0;
    live.timer = { topicId: 1, startedAt: NOW - 1000, endsAt: NOW + 60_000, round: 3, minuteMs: 60_000 };
    expect(migrateBoard(live, NOW).voteRound).toBe(3);
    const voted = mk();
    voted.voteRound = 1;
    voted.timer = { topicId: 1, startedAt: NOW - 120_000, endsAt: NOW - 60_000, round: 5, minuteMs: 60_000 };
    voted.continueVote = { topicId: 1, round: 5, voters: [], totals: { extend: 0, none: 0, end: 0 } };
    expect(migrateBoard(voted, NOW).voteRound).toBe(5);
    const stale = mk();
    stale.voteRound = 1;
    stale.timer = { topicId: 1, startedAt: 0, endsAt: NOW - 2 * HOUR, round: 4, minuteMs: 60_000 };
    expect(migrateBoard(stale, NOW).voteRound).toBe(4);
  });

  it.each([
    ['round', { topicId: 1, round: 3 }],
    ['card', { topicId: 2, round: 4 }],
  ])('drops a time-up vote whose %s does not match its timer', (_name, vote) => {
    const board = createBoard({ boardId: 'b', boardName: 'T', ownerId: 'o', ownerName: 'O' });
    board.phase = 'discussion';
    board.topics = [topic(1, 'discussing', 0)];
    board.voteRound = 4;
    board.timer = { topicId: 1, startedAt: NOW - 120_000, endsAt: NOW - 60_000, round: 4, minuteMs: 60_000 };
    board.continueVote = { ...vote, voters: ['o'], totals: { extend: 1, none: 0, end: 0 } };
    const s = migrateBoard(board, NOW);
    expect(s.continueVote).toBeNull();
    expect(s.timer).not.toBeNull();
  });

  it('keeps an open time-up vote with its voters and totals', () => {
    const board = createBoard({ boardId: 'b', boardName: 'T', ownerId: 'o', ownerName: 'O' });
    board.phase = 'discussion';
    board.topics = [topic(1, 'discussing', 0)];
    board.voteRound = 4;
    board.timer = { topicId: 1, startedAt: NOW - 120_000, endsAt: NOW - 60_000, round: 4, minuteMs: 60_000 };
    board.continueVote = { topicId: 1, round: 4, voters: ['o'], totals: { extend: 0, none: 0, end: 1 } };
    expect(migrateBoard(board, NOW)).toEqual(board);
  });

  it('changes nothing when run again on its own output', () => {
    const once = migrateBoard(skeletonBoard([topic(1, 'ideas', 0), topic(2, 'discussing', 1)],
      { topicId: 2, startedAt: NOW, endsAt: NOW + 60_000 }), NOW);
    expect(migrateBoard(once, NOW)).toEqual(once);
  });

  it('never cuts or drops anything, even on a board over the limits', () => {
    const long = 'x'.repeat(2000);
    const old = skeletonBoard(Array.from({ length: 70 }, (_, i) => ({ ...topic(i + 1, 'ideas', -i), text: long })));
    const s = migrateBoard(old, NOW);
    expect(s.topics).toHaveLength(70);
    expect(s.topics.every((t) => t.text === long)).toBe(true);
  });

  it('does not change the board it is given', () => {
    const old = skeletonBoard([topic(1, 'ideas', 0), topic(2, 'discussing', 1)]);
    const before = JSON.stringify(old);
    migrateBoard(old, NOW);
    expect(JSON.stringify(old)).toBe(before);
  });
});
