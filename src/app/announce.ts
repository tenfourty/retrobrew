import type { Timer, ViewState } from '../engine/types';
import { charactersLeftText, topicLength } from '../ui/format';
import { lengthSentence } from './lengths';

type Board = Pick<ViewState, 'phase' | 'topics' | 'vote'>;

const PHASE_CHANGES: Record<string, string> = {
  'topics>discussion': 'Discussion started',
  'discussion>topics': 'Back to collecting topics',
  'topics>ended': 'Meeting ended',
  'discussion>ended': 'Meeting ended',
  'ended>discussion': 'Meeting reopened',
  // There is no 'ended>topics': reopening always goes to the discussion phase (engine/phases.ts, reopenMeeting). If that
  // ever changes, add its entry here and its case to announce.test.ts.
};

export const TIME_UP_ANNOUNCEMENT = "Time's up. Vote to keep going or move on";

// What the page's live region says when a new view arrives (docs/product/mvp-screens.md, Accessibility): phase
// changes, a topic starting and time up. Nothing for the first view, which only shows where the meeting is.
export function announcementsBetween(before: Board | null, after: Board): string[] {
  if (!before) return [];
  const said: string[] = [];
  const change = PHASE_CHANGES[`${before.phase}>${after.phase}`];
  if (change) said.push(change);
  const was = before.topics.find((t) => t.column === 'discussing');
  const now = after.topics.find((t) => t.column === 'discussing');
  if (now && now.topicId !== was?.topicId) said.push(`Now discussing #${now.topicId}: ${now.text}`);
  if (after.vote && (after.vote.round !== before.vote?.round || after.vote.topicId !== before.vote?.topicId)) said.push(TIME_UP_ANNOUNCEMENT);
  return said;
}

// The countdown is announced at one timebox minute left: "1 minute left", or "10 seconds left" on a rehearsal timer.
// A timer no longer than that minute starts there, so it isn't announced: a 1-minute timebox or a 1-minute extension
// never says "1 minute left". Only just after the mark, within 5 seconds of it: a page that joins or wakes later in the
// last minute would otherwise say "1 minute left" with less than that left. The 5 seconds is the same for a real timer
// and a rehearsal one, whose minute is 10 seconds: the ticker runs every 250 ms, so the window is always hit while the
// tab is visible, and a rehearsal timer is not left to guess at half a minute.
const GRACE_MS = 5000;
export function countdownAnnouncement(timer: Timer | null, remainingMs: number): string | null {
  if (!timer || timer.endsAt - timer.startedAt <= timer.minuteMs) return null;
  const grace = Math.min(GRACE_MS, timer.minuteMs / 2);
  if (remainingMs <= 0 || remainingMs > timer.minuteMs || remainingMs < timer.minuteMs - grace) return null;
  return `${lengthSentence(timer.minuteMs)} left`;
}

// The add box's counter is not a live region of its own. The page says how many characters are left as the draft grows
// past 240, 260 and 280 (once, for the highest mark a keystroke or paste crossed), and nothing in between.
export const LENGTH_MARKS = [240, 260, 280];
export function lengthNotice(before: string, after: string): string | null {
  const was = topicLength(before);
  const now = topicLength(after);
  const crossed = LENGTH_MARKS.filter((mark) => was < mark && now >= mark);
  return crossed.length > 0 ? charactersLeftText(now) : null;
}
