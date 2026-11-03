import { describe, expect, it } from 'vitest';
import { ANN, BOB, NOW, OWNER, board, brokenInvariants, must, refused, run, steps } from '../test/engine-fixtures';
import { openTimeUpVote } from './discussion';
import type { BoardState } from './types';

const FIVE_MIN = 5 * 60_000;

// #1 in Discussing on a 5-minute timer (round 1).
function discussing(o: { rehearsal?: boolean; realMinutes?: boolean } = {}): BoardState {
  return steps(board({ rehearsal: o.rehearsal }), [
    [ANN, { type: 'addTopic', text: 'One' }],
    [OWNER, { type: 'startDiscussion' }],
    [OWNER, { type: 'discussTopic', topicId: 1, minutes: 5, realMinutes: o.realMinutes }],
  ]);
}

function timeUp(o: { rehearsal?: boolean; realMinutes?: boolean } = {}): BoardState {
  const s = discussing(o);
  return openTimeUpVote(s, s.timer!.endsAt)!;
}

describe('openTimeUpVote', () => {
  it('does nothing before the timer runs out', () => {
    expect(openTimeUpVote(discussing(), NOW + FIVE_MIN - 1)).toBeNull();
  });

  it('opens an empty vote for the timer’s topic and round once now reaches endsAt, keeping the timer at 0:00', () => {
    const s = openTimeUpVote(discussing(), NOW + FIVE_MIN)!;
    expect(s.continueVote).toEqual({ topicId: 1, round: 1, voters: [], totals: { extend: 0, none: 0, end: 0 } });
    expect(s.timer).toEqual(discussing().timer);
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('does nothing once the vote for that round is open, or with no timer', () => {
    expect(openTimeUpVote(timeUp(), NOW + FIVE_MIN + 60_000)).toBeNull();
    expect(openTimeUpVote(board(), NOW)).toBeNull();
  });

  it('does not change the board it is given', () => {
    const s = discussing();
    const before = JSON.stringify(s);
    openTimeUpVote(s, NOW + FIVE_MIN);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('voteToContinue', () => {
  it('counts one ballot per person, the facilitator included, and keeps only who voted and the totals', () => {
    const s = steps(timeUp(), [
      [ANN, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'extend' }],
      [BOB, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'end' }],
      [OWNER, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'end' }],
    ]);
    expect(s.continueVote).toEqual({ topicId: 1, round: 1, voters: [ANN, BOB, OWNER], totals: { extend: 1, none: 0, end: 2 } });
    expect(Object.keys(s.continueVote!).sort()).toEqual(['round', 'topicId', 'totals', 'voters']);
  });

  it('refuses a second ballot, even with a different choice', () => {
    const s = must(run(timeUp(), ANN, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'extend' }));
    expect(run(s, ANN, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'end' })).toEqual(refused('alreadyVoted'));
  });

  it('checks in order: the open vote, the choice, then whether you voted', () => {
    const voted = must(run(timeUp(), ANN, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'none' }));
    expect(run(discussing(), ANN, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'nope' })).toEqual(refused('voteClosed'));
    expect(run(voted, ANN, { type: 'voteToContinue', topicId: 2, round: 1, choice: 'none' })).toEqual(refused('voteClosed'));
    expect(run(voted, ANN, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'nope' })).toEqual(refused('badChoice'));
  });

  it('never counts a ballot meant for an earlier round', () => {
    const extended = steps(timeUp(), [[OWNER, { type: 'extendTopic', topicId: 1, round: 1, minutes: 3 }]]);
    const again = openTimeUpVote(extended, extended.timer!.endsAt)!;
    expect(again.continueVote!.round).toBe(2);
    expect(run(again, ANN, { type: 'voteToContinue', topicId: 1, round: 1, choice: 'extend' })).toEqual(refused('voteClosed'));
    expect(run(again, ANN, { type: 'voteToContinue', topicId: 1, round: 2, choice: 'extend' }).ok).toBe(true);
  });

  it('needs the sender to have joined', () => {
    expect(run(timeUp(), 'stranger', { type: 'voteToContinue', topicId: 1, round: 1, choice: 'end' })).toEqual(refused('notAttendee'));
  });
});

describe('extendTopic', () => {
  it('starts a fresh timer with the next round and closes the vote', () => {
    const s = must(run(timeUp(), OWNER, { type: 'extendTopic', topicId: 1, round: 1, minutes: 3 }, NOW + FIVE_MIN + 2000));
    expect(s.timer).toEqual({ topicId: 1, startedAt: NOW + FIVE_MIN + 2000, endsAt: NOW + FIVE_MIN + 2000 + 180_000, round: 2, minuteMs: 60_000 });
    expect(s.continueVote).toBeNull();
    expect(s.voteRound).toBe(2);
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('accepts 1 to 5 minutes only, for the open vote only', () => {
    expect(run(timeUp(), OWNER, { type: 'extendTopic', topicId: 1, round: 1, minutes: 6 })).toEqual(refused('badExtension'));
    expect(run(timeUp(), OWNER, { type: 'extendTopic', topicId: 1, round: 1, minutes: 0 })).toEqual(refused('badExtension'));
    expect(run(timeUp(), OWNER, { type: 'extendTopic', topicId: 1, round: 2, minutes: 3 })).toEqual(refused('voteClosed'));
    expect(run(discussing(), OWNER, { type: 'extendTopic', topicId: 1, round: 1, minutes: 3 })).toEqual(refused('voteClosed'));
    // The open vote is checked before the length.
    expect(run(discussing(), OWNER, { type: 'extendTopic', topicId: 1, round: 1, minutes: 9 })).toEqual(refused('voteClosed'));
  });

  it('uses the same minute length as the timer it replaces', () => {
    expect(must(run(timeUp({ rehearsal: true }), OWNER, { type: 'extendTopic', topicId: 1, round: 1, minutes: 3 })).timer!.minuteMs).toBe(10_000);
    const real = timeUp({ rehearsal: true, realMinutes: true });
    expect(must(run(real, OWNER, { type: 'extendTopic', topicId: 1, round: 1, minutes: 3 })).timer!.minuteMs).toBe(60_000);
  });

  it('is for facilitators only', () => {
    expect(run(timeUp(), ANN, { type: 'extendTopic', topicId: 1, round: 1, minutes: 3 })).toEqual(refused('facilitatorOnly'));
  });
});

describe('voteRound', () => {
  it('only goes up through stop, restart, time up, extend, finish, end and reopen', () => {
    let s = discussing();
    const rounds = [s.voteRound];
    const record = (next: BoardState) => { s = next; rounds.push(s.voteRound); };
    record(must(run(s, OWNER, { type: 'stopTimer', topicId: 1 })));
    record(must(run(s, OWNER, { type: 'restartTimer', topicId: 1, minutes: 1 })));
    record(openTimeUpVote(s, s.timer!.endsAt)!);
    record(must(run(s, OWNER, { type: 'extendTopic', topicId: 1, round: 2, minutes: 2 })));
    record(must(run(s, OWNER, { type: 'finishTopic', topicId: 1 })));
    record(must(run(s, OWNER, { type: 'endMeeting' })));
    record(must(run(s, OWNER, { type: 'reopenMeeting' })));
    record(must(run(must(run(s, ANN, { type: 'addTopic', text: 'Next' })), OWNER, { type: 'discussTopic', topicId: 2, minutes: 5 })));
    expect(rounds).toEqual([1, 1, 2, 2, 3, 3, 3, 3, 4]);
  });
});

describe('the facilitator decides', () => {
  it('closes the vote whichever way they choose', () => {
    for (const cmd of [
      { type: 'finishTopic', topicId: 1 },
      { type: 'stopTimer', topicId: 1 },
      { type: 'restartTimer', topicId: 1, minutes: 5 },
      { type: 'returnTopic', topicId: 1 },
      { type: 'extendTopic', topicId: 1, round: 1, minutes: 1 },
    ] as const) {
      const s = must(run(timeUp(), OWNER, cmd));
      expect(s.continueVote).toBeNull();
      expect(brokenInvariants(s)).toEqual([]);
    }
  });
});
