import type { ViewState } from '../engine/types';
import { formatClock } from '../ui/format';

export const STRIP_IDLE = 'Discussion · Next topic coming up';

// The start of a topic for the status strip: its first 24 characters, then "…" if it is longer.
export function shortTopic(text: string): string {
  const chars = [...text];
  return chars.length > 24 ? `${chars.slice(0, 24).join('')}…` : text;
}

export interface StripContent {
  // Nothing is in Discussing: the strip reads STRIP_IDLE.
  idle: boolean;
  number?: number;
  short?: string;
  // The countdown ("3:12"), "No timer" or "Time's up".
  end?: string;
  // The "Vote" chip, while the time-up vote is open.
  chip: boolean;
  // The strip's accessible name, with the topic's full text. It leaves the countdown out, so the name changes only when the
  // topic or its state does; the page's live region announces the time.
  label: string;
}

// What the phone's status strip shows (docs/product/mvp-screens.md, The discussion phase). `remaining` is the timer's
// seconds left on the host's clock, or null without a timer.
export function stripContent(view: Pick<ViewState, 'topics' | 'timer' | 'vote'>, remaining: number | null): StripContent {
  const topic = view.topics.find((t) => t.column === 'discussing');
  if (!topic) return { idle: true, chip: false, label: STRIP_IDLE };
  let end: string;
  if (view.vote) end = "Time's up";
  else if (view.timer && remaining !== null) end = formatClock(remaining);
  else end = 'No timer';
  return {
    idle: false, number: topic.topicId, short: shortTopic(topic.text), end, chip: view.vote !== null,
    label: `Discussing #${topic.topicId} ${topic.text}${view.vote ? ", Time's up" : view.timer ? '' : ', No timer'}`,
  };
}

// When a topic starts, the phone switches to the Discussing tab, but not while the add box has focus or holds a draft.
export function switchToDiscussing(before: number | undefined, after: number | undefined, typing: boolean): boolean {
  return after !== undefined && after !== before && !typing;
}
