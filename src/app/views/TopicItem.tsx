import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ColumnState } from '../../ui/components';
import { Button, TopicCard } from '../../ui/components';
import type { Command, TopicView, ViewState } from '../../engine/types';

// A card's buttons repeat down the page, so each one's accessible name carries its topic ("Vote for Pairing rotation");
// the visible label stays the short word, which the name starts with. A long topic is cut to 60 characters.
export function cardButtonName(action: string, text: string): string {
  const chars = [...text.trim()];
  return `${action} ${chars.length > 60 ? `${chars.slice(0, 60).join('')}…` : chars.join('')}`;
}

export const EMPTY_EDIT_ERROR = 'Enter some text, or delete the topic';
export const NO_VOTES_HINT_ID = 'no-votes-left-hint';
export const DISCUSS_BLOCKED_ID = 'discuss-blocked-hint';
export const DISCUSS_BLOCKED = 'Finish or return the topic being discussed first';

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
  // Only one topic is discussed at a time, so Discuss waits until the current one is finished or returned.
  const busy = view.topics.some((t) => t.column === 'discussing');
  // Focus goes back to the control that was used when it disappears under the keyboard: Save, Cancel, Enter or Escape
  // return to Edit, and the last Remove vote to Vote.
  const control = (act: string) => document.querySelector<HTMLElement>(`article[data-card="${topic.topicId}"] [data-act="${act}"]`);
  const wasEditing = useRef(false);
  // Saving an emptied edit says so beside the field; it clears as soon as the text changes or the edit ends.
  const [editError, setEditError] = useState<string | null>(null);
  useEffect(() => {
    if (draft !== null) { wasEditing.current = true; return; }
    setEditError(null);
    if (!wasEditing.current) return;
    wasEditing.current = false;
    control('edit')?.focus();
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
    // Saving empty text stays in the edit with an inline error: Enter must never delete a topic.
    if (!text) { setEditError(EMPTY_EDIT_ERROR); return; }
    if (text !== topic.text) props.send({ type: 'editTopic', topicId: topic.topicId, text });
    setDraft(null);
  };
  // The buttons sit in groups that each fill a row, so five buttons never wrap unevenly: voting (Vote, Remove vote),
  // the author's or facilitator's care of the topic (Edit, Delete), and the facilitator's next step (Discuss).
  const voting = (
    <>
      <Button size="sm" variant="secondary" data-act="vote" aria-label={cardButtonName('Vote for', topic.text)} disabled={readOnly || props.votesLeft === 0}
        aria-describedby={props.votesLeft === 0 ? NO_VOTES_HINT_ID : undefined}
        onClick={() => props.send({ type: 'addVote', topicId: topic.topicId })}>Vote</Button>
      {topic.mine > 0 ? (
        <Button size="sm" variant="ghost" aria-label={cardButtonName('Remove vote from', topic.text)} disabled={readOnly} onClick={() => props.send({ type: 'removeVote', topicId: topic.topicId })}>Remove vote</Button>
      ) : null}
    </>
  );
  const caring = author || props.facilitator ? (
    <>
      {author ? <Button size="sm" variant="ghost" data-act="edit" aria-label={cardButtonName('Edit', topic.text)} disabled={readOnly} onClick={() => setDraft(topic.text)}>Edit</Button> : null}
      <Button size="sm" variant="danger" aria-label={cardButtonName('Delete', topic.text)} disabled={readOnly} onClick={(e) => props.onDelete(topic, e.currentTarget)}>Delete</Button>
    </>
  ) : null;
  const next = props.facilitator && topic.column === 'toDiscuss' && props.onDiscuss ? (
    <Button size="sm" variant="primary" aria-label={cardButtonName('Discuss', topic.text)} disabled={readOnly || busy} title={busy ? DISCUSS_BLOCKED : undefined}
      aria-describedby={busy ? DISCUSS_BLOCKED_ID : undefined} onClick={(e) => props.onDiscuss!(topic.topicId, e.currentTarget)}>Discuss</Button>
  ) : null;
  const actions = open ? (
    <>
      <div className="rb-card-group">{voting}</div>
      {caring ? <div className="rb-card-group">{caring}</div> : null}
      {next ? <div className="rb-card-group">{next}</div> : null}
    </>
  ) : undefined;
  return (
    <TopicCard text={topic.text} author={view.attendees[topic.authorId]?.name ?? ''} number={topic.topicId}
      votes={topic.votes} mine={topic.mine} votesHidden={votesHidden} state={STATE[topic.column]} live={props.live}
      alert={props.alert} actions={actions}
      editing={draft !== null && open && !readOnly ? { label: `Edit #${topic.topicId}`, value: draft, onInput: (value: string) => { setEditError(null); setDraft(value); }, error: editError ?? undefined, onSave: save, onCancel: () => setDraft(null) } : undefined}>
      {props.children}
    </TopicCard>
  );
}
