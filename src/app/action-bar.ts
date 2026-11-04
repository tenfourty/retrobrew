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
    // None of the Facilitator controls applies to an ended meeting (the engine refuses them), so there is no Facilitator button.
    return { primary: act('copyText', 'Copy as text'), secondaries: [act('reopen', 'Reopen meeting'), act('backUp', 'Back up meeting file')] };
  }
  // Once time is up the timer has nothing left to stop, so "Stop timer" is gone: the decision is Decide's.
  if (view.vote) return { primary: act('decide', 'Decide'), secondaries: [FACILITATOR] };
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

// Phones hold the primary and one other button, so the bar fits at 320 px. That button reads "More" whenever the row has
// any secondary, and its sheet lists the row's secondaries in order and then, if the row offered "Facilitator", the
// Facilitator controls. "Facilitator" itself never appears in the phone bar.
export function phoneBar(row: BarRow): { primary: BarAction; other: BarAction | null; more: BarAction[]; moreHasControls: boolean } {
  return {
    primary: row.primary,
    other: row.secondaries.length > 0 ? act('more', 'More') : null,
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

// The buttons the Facilitator controls repeat from the action bar. Where the controls sit in the same place as the bar's
// buttons (the wide side panel, the phone's More sheet), the controls leave those out, so each button shows once, a few
// lines from the next. `wide` is the side panel (the bar's every button shows); `more` is the More sheet (the row's
// secondaries list there).
export type ControlId = 'invite' | 'backToTopics' | 'returnTopic' | 'endMeeting';
export function controlsLeftOut(row: BarRow, where: 'wide' | 'more'): ReadonlySet<ControlId> {
  const listed = where === 'wide' ? [row.primary, ...wideBar(row).secondaries] : phoneBar(row).more;
  const ids = new Set(listed.map((a) => a.id));
  return new Set((['invite', 'backToTopics', 'returnTopic', 'endMeeting'] as const).filter((id) => ids.has(id)));
}
