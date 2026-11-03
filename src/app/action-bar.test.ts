import { describe, expect, it } from 'vitest';
import type { ColumnId, TopicView, ViewState } from '../engine/types';
import { barRow, phoneBar, wideBar, type BarRow } from './action-bar';

type Board = Pick<ViewState, 'phase' | 'topics' | 'timer' | 'vote' | 'discussedOrder'>;
const topic = (topicId: number, column: ColumnId, votes = 0): TopicView => ({ topicId, text: `Topic ${topicId}`, column, position: topicId, authorId: 'a', votes, mine: 0 });
const timer = { topicId: 2, startedAt: 0, endsAt: 10_000, round: 1, minuteMs: 10_000 };
const board = (o: Partial<Board>): Board => ({ phase: 'topics', topics: [], timer: null, vote: null, discussedOrder: [], ...o });
const labels = (row: BarRow) => [row.primary.label, ...row.secondaries.map((a) => a.label)];

describe('barRow', () => {
  it('follows the state table, first match first', () => {
    expect(labels(barRow(board({ phase: 'ended', topics: [topic(1, 'discussed')] })))).toEqual(['Copy as text', 'Reopen meeting', 'Back up meeting file', 'Facilitator']);
    const discussing = [topic(1, 'toDiscuss'), topic(2, 'discussing')];
    expect(labels(barRow(board({ phase: 'discussion', topics: discussing, timer, vote: { topicId: 2, round: 1, voted: false, turnout: { voted: 0, here: 2 } } }))))
      .toEqual(['Decide', 'Stop timer', 'Facilitator']);
    expect(labels(barRow(board({ phase: 'discussion', topics: discussing, timer })))).toEqual(['Finish topic', 'Stop timer', 'Return topic', 'Facilitator']);
    expect(labels(barRow(board({ phase: 'discussion', topics: discussing })))).toEqual(['Finish topic', 'Start timer', 'Return topic', 'Facilitator']);
    expect(labels(barRow(board({ phase: 'discussion', topics: [topic(1, 'toDiscuss', 1), topic(4, 'toDiscuss', 3)] })))).toEqual(['Discuss #4', 'Facilitator']);
    expect(labels(barRow(board({ phase: 'discussion', topics: [topic(1, 'discussed')] })))).toEqual(['Back to topics', 'End meeting', 'Facilitator']);
    expect(labels(barRow(board({ phase: 'topics', topics: [topic(1, 'ideas')] })))).toEqual(['Start discussion', 'Invite people', 'Facilitator']);
    expect(labels(barRow(board({ phase: 'topics', topics: [topic(1, 'discussed')] })))).toEqual(['Invite people', 'Facilitator']);
  });

  it('keeps showing Finish topic at 0:00, before the vote opens', () => {
    expect(barRow(board({ phase: 'discussion', topics: [topic(2, 'discussing')], timer })).primary.label).toBe('Finish topic');
  });
});

describe('phoneBar', () => {
  it('shows a single secondary as it is', () => {
    const bar = phoneBar(barRow(board({ phase: 'topics' })));
    expect([bar.primary.label, bar.other?.label]).toEqual(['Invite people', 'Facilitator']);
    expect(bar.more).toEqual([]);
  });

  it('folds two or more secondaries into More, with the Facilitator controls below them', () => {
    const bar = phoneBar(barRow(board({ phase: 'discussion', topics: [topic(2, 'discussing')], timer })));
    expect(bar.other?.label).toBe('More');
    expect(bar.more.map((a) => a.label)).toEqual(['Stop timer', 'Return topic']);
    expect(bar.moreHasControls).toBe(true);
  });

  it('keeps the Facilitator controls in More on an ended meeting', () => {
    const bar = phoneBar(barRow(board({ phase: 'ended' })));
    expect(bar.more.map((a) => a.label)).toEqual(['Reopen meeting', 'Back up meeting file']);
    expect(bar.moreHasControls).toBe(true);
  });
});

describe('wideBar', () => {
  it('shows every button but Facilitator, whose controls sit below', () => {
    const bar = wideBar(barRow(board({ phase: 'topics', topics: [topic(1, 'ideas')] })));
    expect(bar.secondaries.map((a) => a.label)).toEqual(['Invite people']);
    expect(bar.controls).toBe(true);
    expect(wideBar(barRow(board({ phase: 'ended' }))).controls).toBe(true);
  });
});
