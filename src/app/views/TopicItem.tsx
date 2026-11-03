import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ColumnState } from '../../ui/components';
import { Button, TopicCard } from '../../ui/components';
import type { Command, TopicView, ViewState } from '../../engine/types';

export const NO_VOTES_HINT_ID = 'no-votes-left-hint';

const STATE: Record<TopicView['column'], ColumnState> = { ideas: 'ideas', toDiscuss: 'todiscuss', discussing: 'discussing', discussed: 'discussed' };

// One topic with the actions the viewer may take on it (docs/product/mvp-screens.md, The topics phase and The
// discussion phase). Ideas and To discuss topics have actions; Discussing and Discussed topics have none, their dots spent.
// onDelete and onDiscuss pass the button, so focus returns to it when the sheet they open closes. Attendees are never
// removed from a board (docs/product/mvp-screens.md, The topics phase), so an author is always in view.attendees.
export function TopicItem(props: {
  topic: TopicView; view: ViewState; you: string; facilitator: boolean; readOnly: boolean; votesLeft: number;
  send: (cmd: Command) => void; onDelete: (topic: TopicView, opener: HTMLElement | null) => void;
  onDiscuss?: (topicId: number, opener: HTMLElement) => void;
  alert?: string; live?: boolean; children?: ComponentChildren;
  // An edit draft held by the parent (null: not editing), so it survives this card mounting again; otherwise the card keeps its own.
  draft?: string | null; onDraft?: (draft: string | null) => void;
}) {
  const { topic, view, you, readOnly } = props;
  const [ownDraft, setOwnDraft] = useState<string | null>(null);
  const draft = props.draft !== undefined ? props.draft : ownDraft;
  const setDraft = props.onDraft ?? setOwnDraft;
  // An ended meeting is read-only: no topic has actions.
  const open = view.phase !== 'ended' && (topic.column === 'ideas' || topic.column === 'toDiscuss');
  const author = topic.authorId === you;
  // Focus goes back to the control that was used when it disappears under the keyboard: Save, Cancel, Enter or Escape
  // return to Edit, and the last Remove vote to Vote.
  const control = (act: string) => document.querySelector<HTMLElement>(`article[data-card="${topic.topicId}"] [data-act="${act}"]`);
  const wasEditing = useRef(false);
  const askDeleteNext = useRef(false);
  useEffect(() => {
    if (draft !== null) { wasEditing.current = true; return; }
    if (!wasEditing.current) return;
    wasEditing.current = false;
    // Saving empty text asks the delete confirmation, which returns focus to Edit when cancelled.
    if (askDeleteNext.current) { askDeleteNext.current = false; props.onDelete(topic, control('edit')); } else control('edit')?.focus();
  }, [draft]);
  const lastMine = useRef(topic.mine);
  useEffect(() => {
    const active = document.activeElement;
    if (lastMine.current > 0 && topic.mine === 0 && (!active || active === document.body || !active.isConnected)) control('vote')?.focus();
    lastMine.current = topic.mine;
  }, [topic.mine]);
  const votesHidden = topic.votes === undefined && topic.column === 'ideas';
  const save = () => {
    const text = (draft ?? '').trim();
    // Saving empty text asks the delete confirmation; cancelling it leaves the topic as it was.
    if (!text) { askDeleteNext.current = true; setDraft(null); return; }
    if (text !== topic.text) props.send({ type: 'editTopic', topicId: topic.topicId, text });
    setDraft(null);
  };
  const actions = open ? (
    <>
      <Button size="sm" variant="secondary" data-act="vote" disabled={readOnly || props.votesLeft === 0}
        aria-describedby={props.votesLeft === 0 ? NO_VOTES_HINT_ID : undefined}
        onClick={() => props.send({ type: 'addVote', topicId: topic.topicId })}>Vote</Button>
      {topic.mine > 0 ? (
        <Button size="sm" variant="ghost" disabled={readOnly} onClick={() => props.send({ type: 'removeVote', topicId: topic.topicId })}>Remove vote</Button>
      ) : null}
      {author ? <Button size="sm" variant="ghost" data-act="edit" disabled={readOnly} onClick={() => setDraft(topic.text)}>Edit</Button> : null}
      {author || props.facilitator ? <Button size="sm" variant="danger" disabled={readOnly} onClick={(e) => props.onDelete(topic, e.currentTarget)}>Delete</Button> : null}
      {props.facilitator && topic.column === 'toDiscuss' && props.onDiscuss ? (
        <Button size="sm" variant="primary" disabled={readOnly} onClick={(e) => props.onDiscuss!(topic.topicId, e.currentTarget)}>Discuss</Button>
      ) : null}
    </>
  ) : undefined;
  return (
    <TopicCard text={topic.text} author={view.attendees[topic.authorId]?.name ?? ''} number={topic.topicId}
      votes={topic.votes} mine={topic.mine} votesHidden={votesHidden} state={STATE[topic.column]} live={props.live}
      alert={props.alert} actions={actions}
      editing={draft !== null && open && !readOnly ? { label: `Edit #${topic.topicId}`, value: draft, onInput: setDraft, onSave: save, onCancel: () => setDraft(null) } : undefined}>
      {props.children}
    </TopicCard>
  );
}
