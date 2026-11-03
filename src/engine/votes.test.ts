import { describe, expect, it } from 'vitest';
import { ANN, BOB, OWNER, board, must, refused, run, steps, withTopic } from '../test/engine-fixtures';
import { votesLeft } from './board';
import type { BoardState, ColumnId } from './types';

function moved(s: BoardState, topicId: number, column: ColumnId): BoardState {
  const next = structuredClone(s);
  next.topics.find((t) => t.topicId === topicId)!.column = column;
  return next;
}

// Topic #1 in Ideas and #2 in Discussed, with Bob's dots on both.
function spentOnDiscussed(): BoardState {
  const s = steps(withTopic(), [
    [ANN, { type: 'addTopic', text: 'Second' }],
    [BOB, { type: 'addVote', topicId: 1 }],
    [BOB, { type: 'addVote', topicId: 2 }],
    [BOB, { type: 'addVote', topicId: 2 }],
  ]);
  return moved(s, 2, 'discussed');
}

describe('addVote', () => {
  it('allows three dots, several on one topic, then refuses', () => {
    let s = withTopic();
    for (let i = 0; i < 3; i++) s = must(run(s, BOB, { type: 'addVote', topicId: 1 }));
    expect(s.topics[0].voters).toEqual([BOB, BOB, BOB]);
    expect(votesLeft(s, BOB)).toBe(0);
    expect(run(s, BOB, { type: 'addVote', topicId: 1 })).toEqual(refused('noVotesLeft'));
  });

  it('allows voting in To discuss', () => {
    expect(run(moved(withTopic(), 1, 'toDiscuss'), BOB, { type: 'addVote', topicId: 1 }).ok).toBe(true);
  });

  it('checks in order: exists, column, votes left', () => {
    const spent = steps(withTopic(), [[BOB, { type: 'addVote', topicId: 1 }], [BOB, { type: 'addVote', topicId: 1 }], [BOB, { type: 'addVote', topicId: 1 }]]);
    expect(run(spent, BOB, { type: 'addVote', topicId: 9 })).toEqual(refused('noSuchTopic'));
    expect(run(moved(spent, 1, 'discussing'), BOB, { type: 'addVote', topicId: 1 })).toEqual(refused('voteNotOpen'));
    expect(run(moved(spent, 1, 'discussed'), BOB, { type: 'addVote', topicId: 1 })).toEqual(refused('voteNotOpen'));
  });

  it('counts dots on discussed topics as spent', () => {
    expect(votesLeft(spentOnDiscussed(), BOB)).toBe(0);
  });
});

describe('removeVote', () => {
  it('returns a vote when you remove your own dot, and only your own', () => {
    let s = must(run(withTopic(), BOB, { type: 'addVote', topicId: 1 }));
    expect(run(s, ANN, { type: 'removeVote', topicId: 1 })).toEqual(refused('notYourVote'));
    s = must(run(s, BOB, { type: 'removeVote', topicId: 1 }));
    expect(votesLeft(s, BOB)).toBe(3);
  });

  it('removes one dot at a time', () => {
    const s = steps(withTopic(), [[BOB, { type: 'addVote', topicId: 1 }], [BOB, { type: 'addVote', topicId: 1 }], [BOB, { type: 'removeVote', topicId: 1 }]]);
    expect(s.topics[0].voters).toEqual([BOB]);
  });

  it('keeps dots on Discussing and Discussed topics locked', () => {
    const s = spentOnDiscussed();
    expect(run(s, BOB, { type: 'removeVote', topicId: 2 })).toEqual(refused('votesSpent'));
    expect(run(moved(s, 2, 'discussing'), BOB, { type: 'removeVote', topicId: 2 })).toEqual(refused('votesSpent'));
    expect(run(s, BOB, { type: 'removeVote', topicId: 9 })).toEqual(refused('noSuchTopic'));
    // The column is checked before whose dots they are.
    expect(run(s, ANN, { type: 'removeVote', topicId: 2 })).toEqual(refused('votesSpent'));
  });

  it('opens the dots again on a topic returned to To discuss', () => {
    const s = moved(spentOnDiscussed(), 2, 'toDiscuss');
    expect(votesLeft(must(run(s, BOB, { type: 'removeVote', topicId: 2 })), BOB)).toBe(1);
  });
});

describe('raiseAllowance', () => {
  it('raises the allowance for everyone', () => {
    const s = must(run(spentOnDiscussed(), OWNER, { type: 'raiseAllowance', votes: 5 }));
    expect(s.voteAllowance).toBe(5);
    expect(votesLeft(s, BOB)).toBe(2);
    expect(votesLeft(s, ANN)).toBe(5);
  });

  it('accepts only 3, 5, 8 or 10, and never lower', () => {
    expect(run(board(), OWNER, { type: 'raiseAllowance', votes: 4 })).toEqual(refused('badVoteAllowance'));
    expect(run(board(), OWNER, { type: 'raiseAllowance', votes: 3.5 })).toEqual(refused('badVoteAllowance'));
    const eight = must(run(board(), OWNER, { type: 'raiseAllowance', votes: 8 }));
    expect(run(eight, OWNER, { type: 'raiseAllowance', votes: 5 })).toEqual(refused('fewerVotes'));
  });

  it('accepts the same allowance again without changing the board', () => {
    const s = board();
    expect(run(s, OWNER, { type: 'raiseAllowance', votes: 3 })).toEqual({ ok: true, state: s, changed: false });
  });

  it('is for facilitators only', () => {
    expect(run(board(), ANN, { type: 'raiseAllowance', votes: 5 })).toEqual(refused('facilitatorOnly'));
  });
});

describe('clearVotes', () => {
  it('clears dots on Ideas and To discuss topics only, keeping the allowance', () => {
    const s = must(run(moved(spentOnDiscussed(), 1, 'toDiscuss'), OWNER, { type: 'clearVotes' }));
    expect(s.topics.find((t) => t.topicId === 1)!.voters).toEqual([]);
    expect(s.topics.find((t) => t.topicId === 2)!.voters).toEqual([BOB, BOB]);
    expect(votesLeft(s, BOB)).toBe(1);
    expect(s.voteAllowance).toBe(3);
  });

  it('keeps the dots on a topic in Discussing', () => {
    const s = must(run(moved(spentOnDiscussed(), 2, 'discussing'), OWNER, { type: 'clearVotes' }));
    expect(s.topics.find((t) => t.topicId === 2)!.voters).toEqual([BOB, BOB]);
    expect(s.topics.find((t) => t.topicId === 1)!.voters).toEqual([]);
  });

  it('is for facilitators only', () => {
    expect(run(withTopic(), BOB, { type: 'clearVotes' })).toEqual(refused('facilitatorOnly'));
  });
});

describe('setShowVotes', () => {
  it('only lets a facilitator change Show votes, which starts on', () => {
    expect(board().showVotes).toBe(true);
    expect(run(board(), ANN, { type: 'setShowVotes', value: false })).toEqual(refused('facilitatorOnly'));
    expect(must(run(board(), OWNER, { type: 'setShowVotes', value: false })).showVotes).toBe(false);
  });

  it('accepts the current value without changing the board', () => {
    const s = board();
    expect(run(s, OWNER, { type: 'setShowVotes', value: true })).toEqual({ ok: true, state: s, changed: false });
  });
});
