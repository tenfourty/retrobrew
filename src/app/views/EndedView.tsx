import type { TopicView, ViewState } from '../../engine/types';
import { EndedSummary } from '../../ui/ended-summary';
import { finalLists } from '../meeting-text';
import { TopicItem } from './TopicItem';

// The ended view's board (docs/product/mvp-screens.md, The ended view): read-only, "Discussed" in the order topics
// were finished, then "Not discussed" in vote order. Each topic shows its votes and no actions.
export function EndedView(props: { view: ViewState; you: string; facilitator: boolean }) {
  const { discussed, notDiscussed } = finalLists(props.view);
  const item = (t: TopicView) => (
    <TopicItem key={t.topicId} topic={t} view={props.view} you={props.you} facilitator={props.facilitator} readOnly votesLeft={0}
      send={() => undefined} onDelete={() => undefined} />
  );
  return <EndedSummary discussed={discussed.map(item)} notDiscussed={notDiscussed.map(item)} />;
}
