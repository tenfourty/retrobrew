import type { ViewState } from '../engine/types';

// When the facilitator decides a time-up vote, everyone sees one line for a few seconds: "Keeping going for 3 more
// minutes" or "Moved on to the next topic". Only these two outcomes get a line.
export type Outcome = { kind: 'extended'; minutes: number } | { kind: 'movedOn' };

type Board = Pick<ViewState, 'vote' | 'timer' | 'topics'>;

// The outcome of the vote that was open in `before`, if `after` shows it was decided. A new timer on the same topic
// (extend, or "Start again" while the vote was open) is keeping going; the topic moving to Discussed is moving on.
export function outcomeBetween(before: Board | null, after: Board): Outcome | null {
  const vote = before?.vote;
  if (!vote || after.vote) return null;
  const timer = after.timer;
  if (timer && timer.topicId === vote.topicId && timer.round > vote.round) {
    return { kind: 'extended', minutes: Math.round((timer.endsAt - timer.startedAt) / timer.minuteMs) };
  }
  const topic = after.topics.find((t) => t.topicId === vote.topicId);
  return topic?.column === 'discussed' ? { kind: 'movedOn' } : null;
}
