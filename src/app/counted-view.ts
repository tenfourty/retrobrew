import { redactFor } from '../engine/redact';
import type { BoardState, ViewContext, ViewState } from '../engine/types';

// The facilitator's board with every vote count, even while Show votes hides them on screen and in the topics phase.
// Only the facilitator's Copy as text uses it; it is never drawn and never sent. A participant's view keeps the rules.
export function countedView(state: BoardState, viewerId: string, ctx: ViewContext = {}): ViewState {
  return redactFor({ ...state, showVotes: true }, viewerId, ctx);
}
