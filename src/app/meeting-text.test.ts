import { describe, expect, it } from 'vitest';
import type { ColumnId, TopicView } from '../engine/types';
import { finalLists, meetingAsText } from './meeting-text';

const topic = (topicId: number, text: string, column: ColumnId, votes: number | undefined, position = 0): TopicView =>
  ({ topicId, text, column, position, authorId: 'a', votes, mine: 0 });

const ended = new Date(2026, 9, 6, 18, 0).getTime();
const board = {
  boardName: 'Team Lean Coffee',
  rehearsal: false,
  endedAt: ended,
  discussedOrder: [3, 1],
  topics: [
    topic(1, 'Release notes', 'discussed', 2),
    topic(2, 'Pairing rotation', 'toDiscuss', 0, 1),
    topic(3, 'On-call fatigue', 'discussed', 4),
    topic(4, 'Hiring plan', 'toDiscuss', 1, 2),
    topic(5, 'Trunk-based development', 'toDiscuss', 1, 0),
  ],
};

describe('meetingAsText', () => {
  it('writes the name, the date, then discussed topics in order and the rest by votes', () => {
    expect(meetingAsText(board, 0)).toBe([
      'Team Lean Coffee',
      '6 October 2026',
      '',
      'Discussed',
      '1. On-call fatigue (4 votes)',
      '2. Release notes (2 votes)',
      '',
      'Not discussed',
      '- Trunk-based development (1 vote)',
      '- Hiring plan (1 vote)',
      '- Pairing rotation (0 votes)',
      '',
    ].join('\n'));
  });

  it('marks a rehearsal board and leaves out an empty Not discussed', () => {
    const text = meetingAsText({ ...board, rehearsal: true, topics: board.topics.filter((t) => t.column === 'discussed') }, 0);
    expect(text.split('\n').slice(0, 2)).toEqual(['Team Lean Coffee', '6 October 2026 · Rehearsal']);
    expect(text).not.toContain('Not discussed');
    expect(text.endsWith('(2 votes)\n')).toBe(true);
  });

  it('says None when nothing was discussed, and dates an open meeting today', () => {
    const today = new Date(2026, 9, 7, 9, 0).getTime();
    const text = meetingAsText({ ...board, endedAt: null, discussedOrder: [], topics: [topic(7, 'Coffee', 'ideas', 0)] }, today);
    expect(text).toBe('Team Lean Coffee\n7 October 2026\n\nDiscussed\nNone\n\nNot discussed\n- Coffee (0 votes)\n');
  });

  it('lists a topic still in Discussing last under Discussed', () => {
    const open = { ...board, endedAt: null, topics: [...board.topics, topic(6, 'Retro format', 'discussing', 3)] };
    expect(finalLists(open).discussed.map((t) => t.topicId)).toEqual([3, 1, 6]);
    expect(meetingAsText(open, ended)).toContain('3. Retro format (3 votes)\n');
  });
});

describe('hidden counts and ordering', () => {
  it('writes no count where the rules hide it, and never the viewer\'s own dots', () => {
    const hidden = { ...board, endedAt: null, discussedOrder: [], topics: [topic(1, 'Secret', 'ideas', undefined), { ...topic(2, 'Mine', 'ideas', undefined), mine: 2 }] };
    expect(meetingAsText(hidden, ended)).toBe('Team Lean Coffee\n6 October 2026\n\nDiscussed\nNone\n\nNot discussed\n- Secret\n- Mine\n');
  });

  it('breaks vote ties by position, then topic number', () => {
    const tied = { ...board, topics: [topic(9, 'C', 'ideas', 1, 5), topic(8, 'B', 'ideas', 1, 5), topic(7, 'A', 'ideas', 1, 2), topic(6, 'Z', 'ideas', 3, 9)] };
    expect(finalLists({ ...tied, discussedOrder: [] }).notDiscussed.map((t) => t.topicId)).toEqual([6, 7, 8, 9]);
  });

  it('puts a Discussed topic missing from discussedOrder last', () => {
    const lost = { ...board, discussedOrder: [3], topics: [topic(1, 'Lost', 'discussed', 2), topic(3, 'Listed', 'discussed', 4)] };
    expect(finalLists(lost).discussed.map((t) => t.topicId)).toEqual([3, 1]);
  });
});
