import type { Totals, Turnout } from '../engine/types';
import type { Outcome } from '../session/outcome';
import { moreSentence } from './lengths';

// The time-up sheet's words (docs/product/mvp-screens.md, The time-up sheet and The facilitator's decision).
export const VOTE_TITLE = "Time's up. Keep going?";
// The button that reopens the time-up vote (the strip's chip, the Discussing card's button): named for what it votes on, so
// it is not mistaken for voting on a topic.
export const KEEP_GOING_VOTE = 'Vote on keep going';
export const NEW_TIMEBOX = 'New timebox';
export const VOTE_HINT = 'Retrobrew never shows or stores who chose what. The facilitator decides.';

// Participants see "2 of 5 present have voted" once they have voted; the facilitator always sees "2 voted · 5 here".
export function turnoutLine(turnout: Turnout, facilitator: boolean): string {
  return facilitator ? `${turnout.voted} voted · ${turnout.here} here` : `${turnout.voted} of ${turnout.here} present have voted`;
}

export interface DecisionButton {
  kind: 'extend' | 'end';
  label: string;
}

// The two buttons never swap: Move on is always the primary, above Keep going. What the room leans towards is said
// separately, in recommendation(), so a late vote can't move the button under the facilitator's thumb.
// `more` is the extension in words.
export function decisionButtons(more: string): { primary: DecisionButton; secondary: DecisionButton } {
  return { primary: { kind: 'end', label: 'Move on' }, secondary: { kind: 'extend', label: `Keep going for ${more}` } };
}

// What the votes so far suggest, for the facilitator. No preference votes count for neither side; null when nobody has chosen.
export function recommendation(totals: Totals): string | null {
  if (totals.extend > totals.end) return 'Most votes say keep going';
  if (totals.end > totals.extend) return 'Most votes say move on';
  return totals.extend > 0 ? 'The votes are split' : null;
}

export const VOTE_HEADING = 'Your vote';
export const DECISION_HEADING = 'Your decision';

export function moveOnNote(topicId: number): string {
  return `Move on finishes #${topicId} and moves it to Discussed.`;
}

// The outcome line everyone sees for a few seconds. `minuteMs` is the new timer's minute, so a rehearsal board says
// "Keeping going for 30 more seconds".
// Moving on only finishes the topic: "Moved on to the next topic" is said only once a next topic is in Discussing.
export function outcomeLine(outcome: Outcome, minuteMs: number, nextStarted = false): string {
  if (outcome.kind === 'movedOn') return nextStarted ? 'Moved on to the next topic' : 'Moved on · Next topic coming up';
  return `Keeping going for ${moreSentence(outcome.minutes * minuteMs)}`;
}
