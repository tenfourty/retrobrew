import { columnOrder } from '../engine/order';
import type { ViewState } from '../engine/types';

export type ActionId =
  | 'copyText' | 'reopen' | 'backUp' | 'decide' | 'stopTimer' | 'facilitator' | 'finish' | 'returnTopic' | 'startTimer'
  | 'discussNext' | 'backToTopics' | 'endMeeting' | 'startDiscussion' | 'invite' | 'more';

export interface BarAction {
  id: ActionId;
  label: string;
}

export interface BarRow {
  primary: BarAction;
  secondaries: BarAction[];
}

const act = (id: ActionId, label: string): BarAction => ({ id, label });
const FACILITATOR = act('facilitator', 'Facilitator');

// The facilitator action bar's state table (docs/product/mvp-screens.md, The facilitator action bar): the first row
// that matches applies. The primary is always the next step.
export function barRow(view: Pick<ViewState, 'phase' | 'topics' | 'timer' | 'vote' | 'discussedOrder'>): BarRow {
  const discussing = view.topics.find((t) => t.column === 'discussing');
  if (view.phase === 'ended') {
    // The Facilitator controls stay on an ended meeting too: on phones they sit in "More", below its two buttons.
    return { primary: act('copyText', 'Copy as text'), secondaries: [act('reopen', 'Reopen meeting'), act('backUp', 'Back up meeting file'), FACILITATOR] };
  }
  if (view.vote) return { primary: act('decide', 'Decide'), secondaries: [act('stopTimer', 'Stop timer'), FACILITATOR] };
  if (discussing && view.timer) {
    return { primary: act('finish', 'Finish topic'), secondaries: [act('stopTimer', 'Stop timer'), act('returnTopic', 'Return topic'), FACILITATOR] };
  }
  if (discussing) {
    return { primary: act('finish', 'Finish topic'), secondaries: [act('startTimer', 'Start timer'), act('returnTopic', 'Return topic'), FACILITATOR] };
  }
  if (view.phase === 'discussion') {
    const next = columnOrder(view, 'toDiscuss')[0];
    if (next) return { primary: act('discussNext', `Discuss #${next.topicId}`), secondaries: [FACILITATOR] };
    return { primary: act('backToTopics', 'Back to topics'), secondaries: [act('endMeeting', 'End meeting'), FACILITATOR] };
  }
  const ideas = view.topics.some((t) => t.column === 'ideas');
  if (ideas) return { primary: act('startDiscussion', 'Start discussion'), secondaries: [act('invite', 'Invite people'), FACILITATOR] };
  return { primary: act('invite', 'Invite people'), secondaries: [FACILITATOR] };
}

// Phones hold the primary and at most one other button, so the bar fits at 320 px. A row with one secondary shows it;
// a row with more shows "More", whose sheet lists that row's secondaries in order and then, if the row offered
// "Facilitator", the Facilitator controls. "Facilitator" itself never appears beside "More".
export function phoneBar(row: BarRow): { primary: BarAction; other: BarAction | null; more: BarAction[]; moreHasControls: boolean } {
  if (row.secondaries.length <= 1) return { primary: row.primary, other: row.secondaries[0] ?? null, more: [], moreHasControls: false };
  return {
    primary: row.primary,
    other: act('more', 'More'),
    more: row.secondaries.filter((a) => a.id !== 'facilitator'),
    moreHasControls: row.secondaries.some((a) => a.id === 'facilitator'),
  };
}

// Wide screens show every button, stacked, with the Facilitator controls in place below them, so "Facilitator" is left out.
export function wideBar(row: BarRow): { primary: BarAction; secondaries: BarAction[]; controls: boolean } {
  return {
    primary: row.primary,
    secondaries: row.secondaries.filter((a) => a.id !== 'facilitator'),
    controls: row.secondaries.some((a) => a.id === 'facilitator'),
  };
}
