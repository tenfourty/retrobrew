import { columnOrder } from '../../engine/order';
import type { Command, TopicView, ViewState } from '../../engine/types';
import { Column } from '../../ui/components';
import { cx } from '../../ui/cx';
import { TopicItem } from './TopicItem';

// The topics phase (docs/product/mvp-screens.md, The topics phase): the Ideas pinboard, newest first, and Discussed
// once the meeting has come back from a discussion, below Ideas on phones and beside it on wide screens.
export function TopicsPhase(props: {
  view: ViewState; you: string; facilitator: boolean; readOnly: boolean; votesLeft: number;
  send: (cmd: Command, place: string) => void; onDelete: (topic: TopicView, opener: HTMLElement | null) => void;
  alertFor: (place: string) => string | undefined;
}) {
  const { view } = props;
  const ideas = columnOrder(view, 'ideas');
  const discussed = columnOrder(view, 'discussed');
  // Show votes off hides the counts on Ideas topics until the discussion starts, the facilitator's included.
  const hidden = view.phase === 'topics' && !view.showVotes;
  const item = (t: TopicView) => (
    <TopicItem key={t.topicId} topic={t} view={view} you={props.you} facilitator={props.facilitator} readOnly={props.readOnly}
      votesLeft={props.votesLeft} send={(cmd) => props.send(cmd, `card:${t.topicId}`)} onDelete={props.onDelete} alert={props.alertFor(`card:${t.topicId}`)} />
  );
  return (
    <div className={cx('mtg-topics', discussed.length > 0 && 'mtg-topics-with-discussed')}>
      <Column state="ideas" className="mtg-pinboard" focusable empty="No topics yet. Add the first one."
        note={hidden ? 'Votes are hidden until the discussion starts' : undefined}>
        {ideas.map(item)}
      </Column>
      {discussed.length > 0 ? <Column state="discussed">{discussed.map(item)}</Column> : null}
    </div>
  );
}
