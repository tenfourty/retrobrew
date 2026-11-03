import type { Totals, Turnout } from '../engine/types';
import type { Outcome } from '../session/outcome';
import { moreSentence } from './lengths';

// The time-up sheet's words (docs/product/mvp-screens.md, The time-up sheet and The facilitator's decision).
export const VOTE_TITLE = "Time's up. Keep going?";
export const VOTE_HINT = 'Retrobrew never shows or stores who chose what. The facilitator decides.';

// Participants see "2 of 5 present have voted" once they have voted; the facilitator always sees "2 voted · 5 here".
export function turnoutLine(turnout: Turnout, facilitator: boolean): string {
  return facilitator ? `${turnout.voted} voted · ${turnout.here} here` : `${turnout.voted} of ${turnout.here} present have voted`;
}

export interface DecisionButton {
  kind: 'extend' | 'end';
  label: string;
}

// The option the room leans towards comes first. Keep going leads only with more votes than Move on; a tie, no votes
// or Move on ahead puts Move on first. No preference counts for neither. `more` is the extension in words.
export function decisionButtons(totals: Totals, more: string): { primary: DecisionButton; secondary: DecisionButton } {
  if (totals.extend > totals.end) {
    return { primary: { kind: 'extend', label: `Keep going for ${more}` }, secondary: { kind: 'end', label: 'Or move on' } };
  }
  return { primary: { kind: 'end', label: 'Move on' }, secondary: { kind: 'extend', label: `Or keep going for ${more}` } };
}

export function moveOnNote(topicId: number): string {
  return `Move on finishes #${topicId} and moves it to Discussed.`;
}

// The outcome line everyone sees for a few seconds. `minuteMs` is the new timer's minute, so a rehearsal board says
// "Keeping going for 30 more seconds".
export function outcomeLine(outcome: Outcome, minuteMs: number): string {
  if (outcome.kind === 'movedOn') return 'Moved on to the next topic';
  return `Keeping going for ${moreSentence(outcome.minutes * minuteMs)}`;
}
