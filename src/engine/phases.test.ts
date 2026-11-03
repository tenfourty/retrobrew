import { describe, expect, it } from 'vitest';
import { ANN, BOB, NOW, OWNER, board, brokenInvariants, must, refused, run, steps } from '../test/engine-fixtures';
import type { BoardState } from './types';

// Two Ideas topics (#1 then #2, so #2 is first) with a dot from Bob on #1.
function twoTopics(): BoardState {
  return steps(board(), [
    [ANN, { type: 'addTopic', text: 'One' }],
    [BOB, { type: 'addTopic', text: 'Two' }],
    [BOB, { type: 'addVote', topicId: 1 }],
  ]);
}

const started = () => must(run(twoTopics(), OWNER, { type: 'startDiscussion' }));

// #1 in Discussing, set up by hand so these tests don't depend on the discussion commands.
function withDiscussing(): BoardState {
  const s = structuredClone(started());
  s.topics.find((t) => t.topicId === 1)!.column = 'discussing';
  s.voteRound = 1;
  s.timer = { topicId: 1, startedAt: NOW, endsAt: NOW + 60_000, round: 1, minuteMs: 60_000 };
  s.continueVote = { topicId: 1, round: 1, voters: [BOB], totals: { extend: 0, none: 0, end: 1 } };
  return s;
}

describe('startDiscussion', () => {
  it('moves every Ideas topic to To discuss, keeping position and dots', () => {
    const before = twoTopics();
    const s = started();
    expect(s.phase).toBe('discussion');
    expect(s.topics.map((t) => [t.column, t.position])).toEqual(before.topics.map((t) => ['toDiscuss', t.position]));
    expect(s.topics[0].voters).toEqual([BOB]);
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('needs the topics phase and at least one Ideas topic', () => {
    expect(run(started(), OWNER, { type: 'startDiscussion' })).toEqual(refused('alreadyDiscussion'));
    expect(run(board(), OWNER, { type: 'startDiscussion' })).toEqual(refused('noTopicsYet'));
  });

  it('is for facilitators only', () => {
    expect(run(twoTopics(), ANN, { type: 'startDiscussion' })).toEqual(refused('facilitatorOnly'));
  });
});

describe('backToTopics', () => {
  it('moves To discuss topics back to Ideas and leaves Discussed topics alone', () => {
    const discussed = structuredClone(started());
    discussed.topics[1].column = 'discussed';
    discussed.discussedOrder = [2];
    const s = must(run(discussed, OWNER, { type: 'backToTopics' }));
    expect(s.phase).toBe('topics');
    expect(s.topics.map((t) => t.column)).toEqual(['ideas', 'discussed']);
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('is refused in the topics phase, and while a topic is being discussed', () => {
    expect(run(twoTopics(), OWNER, { type: 'backToTopics' })).toEqual(refused('alreadyTopics'));
    expect(run(withDiscussing(), OWNER, { type: 'backToTopics' })).toEqual(refused('finishFirst'));
  });
});

describe('endMeeting', () => {
  it('finishes the topic in Discussing, clears the timer and vote, and records the time', () => {
    const s = must(run(withDiscussing(), OWNER, { type: 'endMeeting' }, NOW + 5000));
    expect(s.phase).toBe('ended');
    expect(s.endedAt).toBe(NOW + 5000);
    expect(s.topics.find((t) => t.topicId === 1)!.column).toBe('discussed');
    expect(s.discussedOrder).toEqual([1]);
    expect(s.timer).toBeNull();
    expect(s.continueVote).toBeNull();
  });

  it('is allowed from the topics phase too', () => {
    expect(must(run(twoTopics(), OWNER, { type: 'endMeeting' })).phase).toBe('ended');
  });

  it('leaves an ended meeting read-only except for join and reopen', () => {
    const s = must(run(started(), OWNER, { type: 'endMeeting' }));
    expect(run(s, OWNER, { type: 'endMeeting' })).toEqual(refused('ended'));
    expect(run(s, OWNER, { type: 'startDiscussion' })).toEqual(refused('ended'));
    expect(run(s, BOB, { type: 'removeVote', topicId: 1 })).toEqual(refused('ended'));
  });
});

describe('reopenMeeting', () => {
  it('returns to discussion with votes, discussedOrder and voteRound carried on', () => {
    const ended = must(run(withDiscussing(), OWNER, { type: 'endMeeting' }));
    const s = must(run(ended, OWNER, { type: 'reopenMeeting' }));
    expect(s.phase).toBe('discussion');
    expect(s.endedAt).toBeNull();
    expect(s.discussedOrder).toEqual([1]);
    expect(s.voteRound).toBe(1);
    expect(s.topics.find((t) => t.topicId === 1)!.voters).toEqual([BOB]);
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('moves Ideas topics to To discuss when the meeting ended from the topics phase', () => {
    const ended = must(run(twoTopics(), OWNER, { type: 'endMeeting' }));
    const s = must(run(ended, OWNER, { type: 'reopenMeeting' }));
    expect(s.topics.every((t) => t.column === 'toDiscuss')).toBe(true);
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('needs an ended meeting, and a facilitator', () => {
    expect(run(started(), OWNER, { type: 'reopenMeeting' })).toEqual(refused('notEnded'));
    const ended = must(run(started(), OWNER, { type: 'endMeeting' }));
    expect(run(ended, ANN, { type: 'reopenMeeting' })).toEqual(refused('facilitatorOnly'));
  });
});

describe('topics and votes across phases', () => {
  it('keeps every dot where it is when the phase changes', () => {
    const s = steps(twoTopics(), [[OWNER, { type: 'startDiscussion' }], [OWNER, { type: 'backToTopics' }]]);
    expect(s.topics.find((t) => t.topicId === 1)!.voters).toEqual([BOB]);
  });
});
