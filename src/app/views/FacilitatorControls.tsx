import type { ComponentChildren } from 'preact';
import { VOTE_ALLOWANCES, type Command, type ViewState } from '../../engine/types';
import { Button } from '../../ui/components';
import { Segmented } from '../../ui/segmented';
import { Switch } from '../../ui/switch';

export const SHOW_VOTES_CAVEAT = "Hidden on screen. It doesn't make votes secret from other attendees.";

// The Facilitator controls, in the order set out in docs/product/mvp-screens.md (The Facilitator sheet). A Sheet on
// phones, a section of the side panel on wide screens. `sound` is the timer sound block. The handlers pass the clicked
// button, so a sheet they open can return focus to it.
export function FacilitatorControls(props: {
  view: ViewState; readOnly: boolean; send: (cmd: Command) => void;
  onInvite: (from: HTMLElement) => void; onResetVotes: (from: HTMLElement) => void; onEndMeeting: (from: HTMLElement) => void;
  sound?: ComponentChildren;
}) {
  const { view, readOnly, send } = props;
  const discussing = view.topics.find((t) => t.column === 'discussing');
  const topicsPhase = view.phase === 'topics';
  return (
    <div className="mtg-controls">
      {view.phase !== 'ended' ? <div><Button variant="secondary" disabled={readOnly} onClick={(e) => props.onInvite(e.currentTarget)}>Invite people</Button></div> : null}
      <Segmented label="Votes each" value={view.voteAllowance} hint="The allowance can go up but not down"
        options={VOTE_ALLOWANCES.map((v) => ({ value: v, label: String(v), disabled: readOnly || v < view.voteAllowance }))}
        onChange={(votes) => { if (votes > view.voteAllowance) send({ type: 'raiseAllowance', votes }); }} />
      <div><Button variant="secondary" disabled={readOnly} onClick={(e) => props.onResetVotes(e.currentTarget)}>Reset all votes</Button></div>
      <Switch label="Show votes" checked={view.showVotes} disabled={readOnly || !topicsPhase}
        hint={topicsPhase ? SHOW_VOTES_CAVEAT : [SHOW_VOTES_CAVEAT, 'Votes always show once the discussion starts']}
        onChange={(value) => send({ type: 'setShowVotes', value })} />
      {view.phase === 'discussion' ? (
        <div className="mtg-control-with-hint">
          <Button variant="secondary" disabled={readOnly || discussing !== undefined} aria-describedby={discussing ? 'back-to-topics-hint' : undefined}
            onClick={() => send({ type: 'backToTopics' })}>Back to topics</Button>
          {discussing ? <p className="rb-hint" id="back-to-topics-hint">Finish or return the topic being discussed first</p> : null}
        </div>
      ) : null}
      {props.sound}
      {discussing ? (
        <div><Button variant="secondary" disabled={readOnly} onClick={() => send({ type: 'returnTopic', topicId: discussing.topicId })}>Return topic</Button></div>
      ) : null}
      {view.phase !== 'ended' ? <div className="mtg-controls-end"><Button variant="danger" disabled={readOnly} onClick={(e) => props.onEndMeeting(e.currentTarget)}>End meeting</Button></div> : null}
    </div>
  );
}
