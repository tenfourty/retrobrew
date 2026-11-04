import { describe, expect, it } from 'vitest';
import { ANN, BOB, NOW, OWNER, board, brokenInvariants, must, refused, run, steps } from '../test/engine-fixtures';
import { timeboxMs } from './discussion';
import { SOUND_IDS, TIMEBOX_MINUTES, type BoardState, type Command } from './types';

// In discussion with #1 and #2 in To discuss and Bob's dot on #1.
function started(o: { rehearsal?: boolean } = {}): BoardState {
  return steps(board(o), [
    [ANN, { type: 'addTopic', text: 'One' }],
    [BOB, { type: 'addTopic', text: 'Two' }],
    [BOB, { type: 'addVote', topicId: 1 }],
    [OWNER, { type: 'startDiscussion' }],
  ]);
}

const discussing = (o: { rehearsal?: boolean } = {}) => must(run(started(o), OWNER, { type: 'discussTopic', topicId: 1, minutes: 5 }));

// A time-up vote open on #1's timer, set up by hand so these tests don't depend on the tick.
function withOpenVote(): BoardState {
  const s = structuredClone(discussing());
  s.continueVote = { topicId: 1, round: s.timer!.round, voters: [BOB], totals: { extend: 1, none: 0, end: 0 } };
  return s;
}

const column = (s: BoardState, topicId: number) => s.topics.find((t) => t.topicId === topicId)!.column;

describe('discussTopic', () => {
  it('moves the topic to Discussing and starts a timer on the host clock with the next round', () => {
    const s = discussing();
    expect(column(s, 1)).toBe('discussing');
    expect(s.timer).toEqual({ topicId: 1, startedAt: NOW, endsAt: NOW + 5 * 60_000, round: 1, minuteMs: 60_000 });
    expect(s.voteRound).toBe(1);
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('accepts every timebox', () => {
    for (const minutes of TIMEBOX_MINUTES) {
      expect(must(run(started(), OWNER, { type: 'discussTopic', topicId: 2, minutes })).timer!.endsAt).toBe(NOW + minutes * 60_000);
    }
  });

  it('checks in order: phase, timebox, exists, To discuss, one at a time', () => {
    const topics = steps(board(), [[ANN, { type: 'addTopic', text: 'One' }]]);
    expect(run(topics, OWNER, { type: 'discussTopic', topicId: 1, minutes: 7 })).toEqual(refused('notDiscussion'));
    expect(run(started(), OWNER, { type: 'discussTopic', topicId: 9, minutes: 7 })).toEqual(refused('badTimebox'));
    expect(run(started(), OWNER, { type: 'discussTopic', topicId: 9, minutes: 5 })).toEqual(refused('noSuchTopic'));
    const finished = must(run(discussing(), OWNER, { type: 'finishTopic', topicId: 1 }));
    expect(run(finished, OWNER, { type: 'discussTopic', topicId: 1, minutes: 5 })).toEqual(refused('notInToDiscuss'));
    expect(run(discussing(), OWNER, { type: 'discussTopic', topicId: 1, minutes: 5 })).toEqual(refused('notInToDiscuss'));
    expect(run(discussing(), OWNER, { type: 'discussTopic', topicId: 2, minutes: 5 })).toEqual(refused('oneAtATime'));
  });

  it('lets the facilitator pick any topic in To discuss, not only the top-voted one', () => {
    expect(column(must(run(started(), OWNER, { type: 'discussTopic', topicId: 2, minutes: 5 })), 2)).toBe('discussing');
  });

  it('is for facilitators only', () => {
    expect(run(started(), ANN, { type: 'discussTopic', topicId: 1, minutes: 5 })).toEqual(refused('facilitatorOnly'));
  });
});

describe('minute length', () => {
  it('is 60,000 ms on a normal board', () => {
    expect(timeboxMs(board(), 5)).toBe(300_000);
    expect(timeboxMs(board(), 30, true)).toBe(1_800_000);
  });

  it('is 10 seconds on a rehearsal board, unless the timer uses real minutes', () => {
    const rehearsal = board({ rehearsal: true });
    expect(timeboxMs(rehearsal, 5)).toBe(50_000);
    expect(timeboxMs(rehearsal, 5, true)).toBe(300_000);
  });

  it('shortens the timer on a rehearsal board', () => {
    expect(discussing({ rehearsal: true }).timer).toMatchObject({ endsAt: NOW + 50_000, minuteMs: 10_000 });
  });

  it('runs real minutes on a rehearsal board when asked, and changes nothing elsewhere', () => {
    const real = must(run(started({ rehearsal: true }), OWNER, { type: 'discussTopic', topicId: 1, minutes: 2, realMinutes: true }));
    expect(real.timer).toMatchObject({ endsAt: NOW + 120_000, minuteMs: 60_000 });
    const normal = must(run(started(), OWNER, { type: 'discussTopic', topicId: 1, minutes: 2, realMinutes: true }));
    expect(normal.timer).toMatchObject({ endsAt: NOW + 120_000, minuteMs: 60_000 });
  });
});

describe('stopTimer', () => {
  it('clears the timer and any vote, leaving the topic in Discussing, untimed', () => {
    const s = must(run(withOpenVote(), OWNER, { type: 'stopTimer', topicId: 1 }));
    expect(s.timer).toBeNull();
    expect(s.continueVote).toBeNull();
    expect(column(s, 1)).toBe('discussing');
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('needs the topic in Discussing and a timer to stop', () => {
    expect(run(discussing(), OWNER, { type: 'stopTimer', topicId: 2 })).toEqual(refused('notBeingDiscussed'));
    const untimed = must(run(discussing(), OWNER, { type: 'stopTimer', topicId: 1 }));
    expect(run(untimed, OWNER, { type: 'stopTimer', topicId: 1 })).toEqual(refused('noTimer'));
  });
});

describe('restartTimer', () => {
  it('starts a fresh timer with the next round, from timed, untimed or out of time, and closes any vote', () => {
    const fromVote = must(run(withOpenVote(), OWNER, { type: 'restartTimer', topicId: 1, minutes: 10 }, NOW + 400_000));
    expect(fromVote.timer).toEqual({ topicId: 1, startedAt: NOW + 400_000, endsAt: NOW + 1_000_000, round: 2, minuteMs: 60_000 });
    expect(fromVote.continueVote).toBeNull();
    const untimed = must(run(discussing(), OWNER, { type: 'stopTimer', topicId: 1 }));
    expect(must(run(untimed, OWNER, { type: 'restartTimer', topicId: 1, minutes: 1 })).timer!.round).toBe(2);
  });

  it('needs the topic in Discussing and a timebox', () => {
    expect(run(discussing(), OWNER, { type: 'restartTimer', topicId: 2, minutes: 5 })).toEqual(refused('notBeingDiscussed'));
    expect(run(discussing(), OWNER, { type: 'restartTimer', topicId: 1, minutes: 6 })).toEqual(refused('badTimebox'));
  });

  it('takes its minute length from its own realMinutes flag', () => {
    const s = must(run(discussing({ rehearsal: true }), OWNER, { type: 'restartTimer', topicId: 1, minutes: 1, realMinutes: true }));
    expect(s.timer!.minuteMs).toBe(60_000);
  });
});

describe('returnTopic', () => {
  it('moves the topic back to To discuss with its dots, clearing the timer and vote', () => {
    const s = must(run(withOpenVote(), OWNER, { type: 'returnTopic', topicId: 1 }));
    expect(column(s, 1)).toBe('toDiscuss');
    expect(s.topics.find((t) => t.topicId === 1)!.voters).toEqual([BOB]);
    expect(s.timer).toBeNull();
    expect(s.continueVote).toBeNull();
    expect(brokenInvariants(s)).toEqual([]);
    expect(must(run(s, OWNER, { type: 'discussTopic', topicId: 1, minutes: 5 })).timer!.round).toBe(2);
  });

  it('needs the topic in Discussing', () => {
    expect(run(started(), OWNER, { type: 'returnTopic', topicId: 1 })).toEqual(refused('notBeingDiscussed'));
  });
});

describe('finishTopic', () => {
  it('moves the topic to Discussed, appends it to discussedOrder and clears the timer and vote', () => {
    const s = must(run(withOpenVote(), OWNER, { type: 'finishTopic', topicId: 1 }));
    expect(column(s, 1)).toBe('discussed');
    expect(s.discussedOrder).toEqual([1]);
    expect(s.timer).toBeNull();
    expect(s.continueVote).toBeNull();
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('is allowed before time is up, and records the order topics were finished in', () => {
    const s = steps(started(), [
      [OWNER, { type: 'discussTopic', topicId: 2, minutes: 5 }],
      [OWNER, { type: 'finishTopic', topicId: 2 }],
      [OWNER, { type: 'discussTopic', topicId: 1, minutes: 5 }],
      [OWNER, { type: 'finishTopic', topicId: 1 }],
    ]);
    expect(s.discussedOrder).toEqual([2, 1]);
  });

  it('needs the topic in Discussing', () => {
    expect(run(discussing(), OWNER, { type: 'finishTopic', topicId: 2 })).toEqual(refused('notBeingDiscussed'));
  });
});

describe('undoMoveOn', () => {
  const movedOn = () => must(run(withOpenVote(), OWNER, { type: 'finishTopic', topicId: 1 }));

  it('puts the topic back in Discussing with its expired timer and the time-up vote as it was', () => {
    const before = withOpenVote();
    const s = must(run(movedOn(), OWNER, { type: 'undoMoveOn', topicId: 1 }));
    expect(column(s, 1)).toBe('discussing');
    expect(s.discussedOrder).toEqual([]);
    expect(s.timer).toEqual(before.timer);
    expect(s.continueVote).toEqual(before.continueVote);
    expect(brokenInvariants(s)).toEqual([]);
  });

  it('can be used once', () => {
    const s = must(run(movedOn(), OWNER, { type: 'undoMoveOn', topicId: 1 }));
    expect(run(s, OWNER, { type: 'undoMoveOn', topicId: 1 })).toEqual(refused('nothingToUndo'));
  });

  it('is for the facilitator only', () => {
    expect(run(movedOn(), ANN, { type: 'undoMoveOn', topicId: 1 })).toEqual(refused('facilitatorOnly'));
  });

  it('is refused when the topic was finished with no time-up vote open', () => {
    const s = must(run(discussing(), OWNER, { type: 'finishTopic', topicId: 1 }));
    expect(run(s, OWNER, { type: 'undoMoveOn', topicId: 1 })).toEqual(refused('nothingToUndo'));
  });

  it('is refused once another topic is being discussed', () => {
    const s = must(run(movedOn(), OWNER, { type: 'discussTopic', topicId: 2, minutes: 5 }));
    expect(run(s, OWNER, { type: 'undoMoveOn', topicId: 1 })).toEqual(refused('nothingToUndo'));
  });

  it('is refused for another topic', () => {
    expect(run(movedOn(), OWNER, { type: 'undoMoveOn', topicId: 2 })).toEqual(refused('nothingToUndo'));
  });
});

describe('rounds', () => {
  it('only ever go up, across every kind of new timer', () => {
    const rounds: number[] = [];
    let s = started();
    const cmds: Command[] = [
      { type: 'discussTopic', topicId: 1, minutes: 5 },
      { type: 'restartTimer', topicId: 1, minutes: 5 },
      { type: 'returnTopic', topicId: 1 },
      { type: 'discussTopic', topicId: 1, minutes: 5 },
      { type: 'finishTopic', topicId: 1 },
      { type: 'discussTopic', topicId: 2, minutes: 5 },
    ];
    for (const cmd of cmds) {
      s = must(run(s, OWNER, cmd));
      if (s.timer) rounds.push(s.timer.round);
    }
    expect(rounds).toEqual([1, 2, 3, 4]);
    expect(s.voteRound).toBe(4);
  });
});

describe('setTimerSound', () => {
  it('accepts each sound ID and refuses anything else', () => {
    for (const sound of SOUND_IDS) expect(must(run(board(), OWNER, { type: 'setTimerSound', sound })).timerSound).toBe(sound);
    expect(run(board(), OWNER, { type: 'setTimerSound', sound: 'airhorn' })).toEqual(refused('badSound'));
  });

  it('is for facilitators only', () => {
    expect(run(board(), ANN, { type: 'setTimerSound', sound: 'bell' })).toEqual(refused('facilitatorOnly'));
  });
});
