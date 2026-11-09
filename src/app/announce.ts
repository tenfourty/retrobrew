import type { Timer, ViewState } from '../engine/types';
import { charactersLeftText, topicLength } from '../ui/format';
import { COPY } from './banners';
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
  // The region keeps its last words, so a topic leaving Discussing says so; otherwise it still reads "Now discussing #n".
  // A vote that was open is closed by its outcome line, which says the rest.
  if (was && now?.topicId !== was.topicId && after.phase === before.phase && after.phase === 'discussion') {
    const left = after.topics.find((t) => t.topicId === was.topicId);
    if (left?.column === 'toDiscuss') said.push(`#${was.topicId} returned to To discuss`);
    else if (left?.column === 'discussed' && !before.vote) said.push(`#${was.topicId} moved to Discussed`);
  }
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

// A live region is only spoken when it changes, but a reader browsing the page later still meets whatever it holds. So
// the announcer empties it this long after it last spoke, long enough to read the longest line.
export const LIVE_REGION_CLEAR_MS = 8000;

// When a banner clears, a short line replaces the stale words in the region, where one makes sense: the facilitator
// coming back and the network coming back. Recoveries are keyed by the banner's kind (its key in COPY), not by its
// words, so editing the copy cannot drop one.
type BannerKind = keyof typeof COPY;
const RECOVERIES: Partial<Record<BannerKind, string>> = {
  hostOffline: 'The facilitator is back.',
  noRelays: 'The meeting network is back.',
};

function bannerKind(text: string): BannerKind | null {
  for (const kind of Object.keys(COPY) as BannerKind[]) if (COPY[kind] === text) return kind;
  return null;
}

export function bannerRecovery(before: string | null, after: string | null): string | null {
  if (before === null || after !== null) return null;
  const kind = bannerKind(before);
  return (kind && RECOVERIES[kind]) ?? null;
}

// What the region says when the banner changes from `before` to `after` (null: no banner): the new banner's words, or
// when it goes with nothing in its place, its recovery line if it has one. Nothing on the first render with no banner,
// nor when a banner with no recovery clears (the region is emptied after 8 s). A banner replaced by another says the new
// one's words only: a participant whose offline banner gives way to the ended banner hears "Meeting ended", not also
// that the facilitator is back, since that is not what has happened.
export function bannerLine(before: string | null, after: string | null): string | null {
  return after ?? bannerRecovery(before, after);
}
