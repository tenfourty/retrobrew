import { describe, expect, it } from 'vitest';
import { createBoard } from './board';
import { mergeView, redactFor, splitView, viewVotesLeft } from './redact';
import type { BoardState, ColumnId, Topic, ViewContext } from './types';

const OWNER = 'owner-id';
const ANN = 'ann-id';
const BOB = 'bob-id';
const STRANGER = 'stranger-id';
const VIEWERS = [OWNER, ANN, BOB, STRANGER];

function topic(topicId: number, column: ColumnId, voters: string[]): Topic {
  return { topicId, text: `Topic ${topicId}`, column, position: -topicId, authorId: ANN, voters: voters };
}

function base(): BoardState {
  const s = createBoard({ boardId: 'b', boardName: 'Team', ownerId: OWNER, ownerName: 'Olu' });
  s.attendees[ANN] = { id: ANN, name: 'Ann', role: 'guest' };
  s.attendees[BOB] = { id: BOB, name: 'Bob', role: 'guest' };
  s.topicIdSeed = 4;
  return s;
}

// Small, deterministic boards, one per situation the view rules distinguish.
const FIXTURES: Record<string, () => BoardState> = {
  'topics, Show votes on': () => {
    const s = base();
    s.topics = [topic(1, 'ideas', [ANN, BOB, ANN]), topic(2, 'ideas', [BOB])];
    return s;
  },
  'topics, Show votes off, after a discussion': () => {
    const s = base();
    s.showVotes = false;
    s.attendees[BOB].role = 'facilitator';
    s.topics = [topic(1, 'ideas', [ANN, BOB, ANN]), topic(2, 'ideas', [BOB]), topic(3, 'discussed', [OWNER, BOB])];
    s.discussedOrder = [3];
    s.voteRound = 1;
    return s;
  },
  'discussion, Show votes off, timer running': () => {
    const s = base();
    s.phase = 'discussion';
    s.showVotes = false;
    s.topics = [topic(1, 'toDiscuss', [ANN, BOB]), topic(2, 'discussing', [BOB, ANN])];
    s.voteRound = 3;
    s.timer = { topicId: 2, startedAt: 1000, endsAt: 61_000, round: 3, minuteMs: 60_000 };
    return s;
  },
  'discussion, time-up vote open': () => {
    const s = base();
    s.phase = 'discussion';
    s.topics = [topic(1, 'toDiscuss', [ANN]), topic(2, 'discussing', [BOB])];
    s.voteRound = 3;
    s.timer = { topicId: 2, startedAt: 1000, endsAt: 61_000, round: 3, minuteMs: 60_000 };
    s.continueVote = { topicId: 2, round: 3, voters: [ANN, OWNER], totals: { extend: 1, none: 0, end: 1 } };
    return s;
  },
  'ended from the topics phase, Show votes off': () => {
    const s = base();
    s.phase = 'ended';
    s.showVotes = false;
    s.endedAt = 99_000;
    s.topics = [topic(1, 'ideas', [ANN, BOB]), topic(2, 'ideas', [])];
    return s;
  },
  'ended': () => {
    const s = base();
    s.phase = 'ended';
    s.showVotes = false;
    s.endedAt = 99_000;
    s.topics = [topic(1, 'toDiscuss', [ANN]), topic(2, 'discussed', [BOB, BOB])];
    s.discussedOrder = [2];
    return s;
  },
};

const CTX: Record<string, ViewContext> = {
  [OWNER]: { online: [OWNER, ANN] },
  [ANN]: { online: [OWNER, ANN], acks: { 'tab-1': 4 }, rejects: { 'tab-1': { clientSeq: 4, key: 'noVotesLeft' } } },
  [BOB]: { online: [OWNER, ANN] },
  [STRANGER]: { online: [OWNER, ANN], joinRefused: 'meetingFull' },
};

describe('redactFor', () => {
  it('sends each topic’s count and the viewer’s own dots, never voter IDs', () => {
    const view = redactFor(FIXTURES['topics, Show votes on'](), ANN);
    expect(view.topics.find((t) => t.topicId === 1)).toMatchObject({ votes: 3, mine: 2 });
    expect(view.topics.find((t) => t.topicId === 2)).toMatchObject({ votes: 1, mine: 0 });
    expect(JSON.stringify(view)).not.toContain('voters');
    expect(JSON.stringify(view.topics)).not.toContain(BOB);
  });

  it('hides Ideas counts from everyone, the facilitator included, when Show votes is off in the topics phase', () => {
    const s = FIXTURES['topics, Show votes off, after a discussion']();
    for (const viewer of VIEWERS) {
      const view = redactFor(s, viewer);
      expect(view.topics.find((t) => t.topicId === 1)!.votes).toBeUndefined();
      expect(view.topics.find((t) => t.topicId === 2)!.votes).toBeUndefined();
      expect('votes' in view.topics.find((t) => t.topicId === 1)!).toBe(false);
    }
    expect(redactFor(s, ANN).topics.find((t) => t.topicId === 1)!.mine).toBe(2);
  });

  it('keeps counts on Discussed topics visible with Show votes off', () => {
    const view = redactFor(FIXTURES['topics, Show votes off, after a discussion'](), ANN);
    expect(view.topics.find((t) => t.topicId === 3)!.votes).toBe(2);
  });

  it('sends counts to everyone once discussion starts, and after the end, whatever Show votes says', () => {
    for (const name of ['discussion, Show votes off, timer running', 'ended', 'ended from the topics phase, Show votes off']) {
      const view = redactFor(FIXTURES[name](), BOB);
      expect(view.topics.every((t) => typeof t.votes === 'number')).toBe(true);
    }
  });

  it('gives the time-up vote’s turnout to everyone, and the totals only to facilitators and people who voted', () => {
    const s = FIXTURES['discussion, time-up vote open']();
    const online = { online: [OWNER] };
    expect(redactFor(s, BOB, online).vote).toEqual({ topicId: 2, round: 3, voted: false, turnout: { voted: 2, here: 2 } });
    expect(redactFor(s, ANN, online).vote).toEqual({
      topicId: 2, round: 3, voted: true, turnout: { voted: 2, here: 2 }, totals: { extend: 1, none: 0, end: 1 },
    });
    expect(redactFor(s, OWNER, online).vote?.totals).toEqual({ extend: 1, none: 0, end: 1 });
  });

  it('counts only online attendees as here, raised to the number who voted', () => {
    const s = FIXTURES['discussion, time-up vote open']();
    expect(redactFor(s, BOB, { online: [OWNER, ANN, BOB, 'not-an-attendee'] }).vote?.turnout).toEqual({ voted: 2, here: 3 });
    expect(redactFor(s, BOB, { online: [] }).vote?.turnout).toEqual({ voted: 2, here: 2 });
    const ctx = { online: [OWNER, 'not-an-attendee', ANN] };
    expect(redactFor(s, BOB, ctx).online).toEqual([OWNER, ANN]);
    expect(splitView(s, BOB, ctx).shared.online).toEqual([OWNER, ANN]);
  });

  it('never sends the voters list, voteRound or topicIdSeed', () => {
    for (const make of Object.values(FIXTURES)) {
      for (const viewer of VIEWERS) {
        const json = JSON.stringify(redactFor(make(), viewer, CTX[viewer]));
        expect(json).not.toContain('"voters"');
        expect(json).not.toContain('"voteRound"');
        expect(json).not.toContain('"topicIdSeed"');
        expect(json).not.toContain('"continueVote"');
      }
    }
  });

  it('gives a facilitator the totals without voting, and no hidden counts', () => {
    const s = FIXTURES['discussion, time-up vote open']();
    s.attendees[BOB].role = 'facilitator';
    expect(redactFor(s, BOB).vote).toMatchObject({ voted: false, totals: { extend: 1, none: 0, end: 1 } });
    const hidden = FIXTURES['topics, Show votes off, after a discussion']();
    expect(redactFor(hidden, BOB).topics.find((t) => t.topicId === 1)!.votes).toBeUndefined();
  });

  it('treats someone with no attendee entry as a guest', () => {
    const s = FIXTURES['discussion, time-up vote open']();
    const view = redactFor(s, STRANGER);
    expect(view.role).toBe('guest');
    expect(view.vote?.totals).toBeUndefined();
  });

  it('always returns a new object that shares nothing with the host’s state', () => {
    const s = FIXTURES['discussion, time-up vote open']();
    const before = JSON.stringify(s);
    const view = redactFor(s, OWNER, CTX[OWNER]);
    view.attendees[ANN].name = 'Changed';
    view.timer!.endsAt = 0;
    view.discussedOrder.push(42);
    view.topics[0].text = 'Changed';
    view.vote!.totals!.end = 99;
    expect(JSON.stringify(s)).toBe(before);
    const on = FIXTURES['topics, Show votes on']();
    const first = redactFor(on, ANN);
    const second = redactFor(on, ANN);
    expect(second).not.toBe(first);
    expect(second.topics).not.toBe(first.topics);
    expect(second.attendees).not.toBe(first.attendees);
    expect(second).toEqual(first);
  });

  it('carries the viewer’s acks, rejects and a refused join from the session', () => {
    const s = FIXTURES['topics, Show votes on']();
    expect(redactFor(s, ANN, CTX[ANN])).toMatchObject({ acks: { 'tab-1': 4 }, rejects: { 'tab-1': { clientSeq: 4, key: 'noVotesLeft' } } });
    expect(redactFor(s, STRANGER, CTX[STRANGER]).joinRefused).toBe('meetingFull');
    expect('joinRefused' in redactFor(s, ANN)).toBe(false);
  });

  it('counts votes left from the viewer’s own dots in every column', () => {
    expect(viewVotesLeft(redactFor(FIXTURES['discussion, Show votes off, timer running'](), ANN))).toBe(1);
  });
});

describe('splitView and mergeView', () => {
  for (const [name, make] of Object.entries(FIXTURES)) {
    it(`rebuild exactly the view redactFor builds, for every viewer: ${name}`, () => {
      const s = make();
      for (const viewer of VIEWERS) {
        const { shared, personal } = splitView(s, viewer, CTX[viewer]);
        expect(mergeView(shared, personal)).toStrictEqual(redactFor(s, viewer, CTX[viewer]));
        // The parts travel as JSON, so the rebuilt view must survive that too.
        const travelled = mergeView(JSON.parse(JSON.stringify(shared)), JSON.parse(JSON.stringify(personal)));
        expect(travelled).toStrictEqual(JSON.parse(JSON.stringify(redactFor(s, viewer, CTX[viewer]))));
      }
    });

    it(`share one viewer-neutral part and keep other people out of each entry: ${name}`, () => {
      const s = make();
      const shared = VIEWERS.map((viewer) => JSON.stringify(splitView(s, viewer, CTX[viewer]).shared));
      expect(new Set(shared).size).toBe(1);
      for (const viewer of VIEWERS) {
        const parts = splitView(s, viewer, CTX[viewer]).personal;
        expect(Object.keys(parts).sort()).toEqual(
          ['acks', 'mine', 'rejects', 'role', 'voted', 'you', ...('totals' in parts ? ['totals'] : []), ...('joinRefused' in parts ? ['joinRefused'] : [])].sort());
        const personal = JSON.stringify(parts);
        for (const other of VIEWERS) if (other !== viewer) expect(personal).not.toContain(other);
      }
    });
  }

  it('does not change the host’s state', () => {
    const s = FIXTURES['discussion, time-up vote open']();
    const before = JSON.stringify(s);
    const { shared, personal } = splitView(s, ANN, CTX[ANN]);
    mergeView(shared, personal).topics[0].text = 'Changed';
    shared.attendees[ANN].name = 'Changed';
    expect(JSON.stringify(s)).toBe(before);
  });
});
