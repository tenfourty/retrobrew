import type { Phase } from '../engine/types';

// The one-line guide under the meeting name, phrased for the viewer's role (docs/product/mvp-screens.md, The board:
// shared layout). `allowance` is the current vote allowance.
// `discussingId` is the topic in Discussing, if any: a guest is then told which one, not that the facilitator is still to pick.
export function guideLine(phase: Phase, facilitator: boolean, allowance: number, discussingId: number | null = null): string {
  if (phase === 'topics') {
    return facilitator
      ? 'Invite people, add topics and vote. Start the discussion when the votes are in'
      : `Add topics you'd like to talk about, then spend your ${allowance} votes`;
  }
  if (phase === 'discussion') {
    if (!facilitator && discussingId !== null) return `Now discussing #${discussingId}. You can still add topics and vote`;
    return facilitator
      ? 'Pick the next topic from To discuss. Everyone can still add topics and vote'
      : 'The facilitator picks the next topic. You can still add topics and vote';
  }
  return facilitator ? 'This meeting has ended. Copy the outcome or reopen it' : 'This meeting has ended';
}

export const SHOW_VOTES_CAVEAT = "Hidden on screen. It doesn't make votes secret from other attendees.";
export const SHOW_VOTES_LOCKED = 'Votes always show once the discussion starts';

// The hints under the Show votes switch. The caveat describes the hidden state, so it shows only while votes are hidden;
// once the discussion starts the switch is locked on and says so, and the caveat has nothing left to describe.
export function showVotesHints(phase: Phase, showVotes: boolean): string[] {
  if (phase !== 'topics') return [SHOW_VOTES_LOCKED];
  return showVotes ? [] : [SHOW_VOTES_CAVEAT];
}

export const FACILITATOR_LINE = 'This meeting runs on this device. Keep this page open.';
