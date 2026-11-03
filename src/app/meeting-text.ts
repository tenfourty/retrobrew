import { columnOrder } from '../engine/order';
import type { TopicView, ViewState } from '../engine/types';
import { longDate } from './lengths';

type Board = Pick<ViewState, 'boardName' | 'rehearsal' | 'endedAt' | 'topics' | 'discussedOrder'>;

// Most votes first, then position, then number: the order of "Not discussed".
const byVotes = (a: TopicView, b: TopicView) =>
  (b.votes ?? 0) - (a.votes ?? 0) || a.position - b.position || a.topicId - b.topicId;

// The ended view's two parts, and Copy as text's. Before the meeting has ended, a topic in Discussing is listed last
// under Discussed, as ending would put it there.
export function finalLists(view: Pick<Board, 'topics' | 'discussedOrder'>): { discussed: TopicView[]; notDiscussed: TopicView[] } {
  const discussed = [...columnOrder(view, 'discussed'), ...columnOrder(view, 'discussing')];
  const done = new Set(discussed.map((t) => t.topicId));
  const notDiscussed = view.topics.filter((t) => !done.has(t.topicId)).sort(byVotes);
  return { discussed, notDiscussed };
}

// " (1 vote)" or " (3 votes)", including " (0 votes)". Empty where the rules hide the count (Ideas topics before the
// discussion with Show votes off): the viewer's own dots are not the count, so they are never written in its place.
function votes(t: TopicView): string {
  if (t.votes === undefined) return '';
  return ` (${t.votes} ${t.votes === 1 ? 'vote' : 'votes'})`;
}

// The plain-text outcome for the clipboard (docs/product/mvp-screens.md, Copy as text), with \n line endings and a
// final newline. `today` dates a meeting that hasn't ended yet.
export function meetingAsText(view: Board, today: number): string {
  const { discussed, notDiscussed } = finalLists(view);
  const lines = [view.boardName, `${longDate(view.endedAt ?? today)}${view.rehearsal ? ' · Rehearsal' : ''}`, '', 'Discussed'];
  if (discussed.length === 0) lines.push('None');
  discussed.forEach((t, i) => lines.push(`${i + 1}. ${t.text}${votes(t)}`));
  if (notDiscussed.length > 0) {
    lines.push('', 'Not discussed');
    for (const t of notDiscussed) lines.push(`- ${t.text}${votes(t)}`);
  }
  return `${lines.join('\n')}\n`;
}
