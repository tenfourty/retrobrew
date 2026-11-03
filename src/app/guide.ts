import type { Phase } from '../engine/types';

// The one-line guide under the meeting name, phrased for the viewer's role (docs/product/mvp-screens.md, The board:
// shared layout). `allowance` is the current vote allowance.
export function guideLine(phase: Phase, facilitator: boolean, allowance: number): string {
  if (phase === 'topics') {
    return facilitator
      ? 'Invite people, add topics and vote. Start the discussion when the votes are in'
      : `Add topics you'd like to talk about, then spend your ${allowance} votes`;
  }
  if (phase === 'discussion') {
    return facilitator
      ? 'Pick the next topic from To discuss. Everyone can still add topics and vote'
      : 'The facilitator picks the next topic. You can still add topics and vote';
  }
  return facilitator ? 'This meeting has ended. Copy the outcome or reopen it' : 'This meeting has ended';
}

export const FACILITATOR_LINE = 'This meeting runs on this device. Keep this page open.';
