import { describe, expect, it } from 'vitest';
import type { ViewState } from '../engine/types';
import { outcomeBetween } from './outcome';

type Board = Pick<ViewState, 'vote' | 'timer' | 'topics'>;
const topic = (column: ViewState['topics'][number]['column']) => ({ topicId: 4, text: 'Pairing', column, position: 0, authorId: 'a', mine: 0 });
const voting: Board = {
  vote: { topicId: 4, round: 2, voted: true, turnout: { voted: 1, here: 2 } },
  timer: { topicId: 4, startedAt: 0, endsAt: 300_000, round: 2, minuteMs: 60_000 },
  topics: [topic('discussing')],
};

describe('outcomeBetween', () => {
  it('reads a new timer on the voted topic as keeping going, with its length in minutes', () => {
    const after: Board = { vote: null, timer: { topicId: 4, startedAt: 400_000, endsAt: 580_000, round: 3, minuteMs: 60_000 }, topics: [topic('discussing')] };
    expect(outcomeBetween(voting, after)).toEqual({ kind: 'extended', minutes: 3 });
    const rehearsal: Board = { ...after, timer: { topicId: 4, startedAt: 0, endsAt: 20_000, round: 3, minuteMs: 10_000 } };
    expect(outcomeBetween(voting, rehearsal)).toEqual({ kind: 'extended', minutes: 2 });
  });

  it('reads the voted topic reaching Discussed as moving on', () => {
    expect(outcomeBetween(voting, { vote: null, timer: null, topics: [topic('discussed')] })).toEqual({ kind: 'movedOn' });
  });

  it('gives no line for anything else: still voting, stopped, returned, or no vote before', () => {
    expect(outcomeBetween(voting, voting)).toBeNull();
    expect(outcomeBetween(voting, { vote: null, timer: null, topics: [topic('discussing')] })).toBeNull();
    expect(outcomeBetween(voting, { vote: null, timer: null, topics: [topic('toDiscuss')] })).toBeNull();
    expect(outcomeBetween(null, { vote: null, timer: null, topics: [topic('discussed')] })).toBeNull();
  });
});
