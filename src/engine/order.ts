import type { ColumnId, TopicView, ViewState } from './types';

const byPosition = (a: TopicView, b: TopicView) => a.position - b.position || a.topicId - b.topicId;

// A topic missing from discussedOrder (none should be) goes last.
const LAST = Number.MAX_SAFE_INTEGER;

// One column's topics in the order of docs/product/lean-coffee-rules.md, Ordering and numbering,
// so every screen agrees on it. "The top-voted topic" is the first of To discuss.
export function columnOrder(view: Pick<ViewState, 'topics' | 'discussedOrder'>, column: ColumnId): TopicView[] {
  const topics = view.topics.filter((t) => t.column === column);
  if (column === 'toDiscuss') return topics.sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0) || byPosition(a, b));
  if (column === 'discussed') {
    const rank = (t: TopicView) => {
      const index = view.discussedOrder.indexOf(t.topicId);
      return index === -1 ? LAST : index;
    };
    return topics.sort((a, b) => rank(a) - rank(b) || byPosition(a, b));
  }
  return topics.sort(byPosition);
}
