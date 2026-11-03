import { describe, expect, it } from 'vitest';
import { columnOrder } from './order';
import type { ColumnId, TopicView } from './types';

function topic(topicId: number, column: ColumnId, position: number, votes?: number): TopicView {
  const t: TopicView = { topicId, text: `Topic ${topicId}`, column, position, authorId: 'a', mine: 0 };
  if (votes !== undefined) t.votes = votes;
  return t;
}

const ids = (topics: TopicView[]) => topics.map((t) => t.topicId);

describe('columnOrder', () => {
  it('orders Ideas by position, lowest first, then topicId', () => {
    const view = { topics: [topic(1, 'ideas', 0), topic(2, 'ideas', -1), topic(4, 'ideas', 0), topic(3, 'ideas', 0)], discussedOrder: [] };
    expect(ids(columnOrder(view, 'ideas'))).toEqual([2, 1, 3, 4]);
  });

  it('orders To discuss by votes, highest first, then position, then topicId', () => {
    const view = {
      topics: [
        topic(1, 'toDiscuss', 0, 2), topic(2, 'toDiscuss', 1, 5), topic(3, 'toDiscuss', -1, 2),
        topic(4, 'toDiscuss', 2, 0), topic(6, 'toDiscuss', -1, 2), topic(5, 'ideas', -9, 9),
      ],
      discussedOrder: [],
    };
    expect(ids(columnOrder(view, 'toDiscuss'))).toEqual([2, 3, 6, 1, 4]);
  });

  it('treats a hidden count as no votes', () => {
    const view = { topics: [topic(1, 'toDiscuss', 0), topic(2, 'toDiscuss', 1, 1)], discussedOrder: [] };
    expect(ids(columnOrder(view, 'toDiscuss'))).toEqual([2, 1]);
  });

  it('orders Discussed by discussedOrder, the order topics were finished', () => {
    const view = { topics: [topic(1, 'discussed', 0), topic(2, 'discussed', 1), topic(3, 'discussed', 2)], discussedOrder: [3, 1, 2] };
    expect(ids(columnOrder(view, 'discussed'))).toEqual([3, 1, 2]);
  });

  it('does not reorder the view it is given', () => {
    const view = { topics: [topic(1, 'ideas', 0), topic(2, 'ideas', -1)], discussedOrder: [] };
    columnOrder(view, 'ideas');
    expect(ids(view.topics)).toEqual([1, 2]);
  });
});
