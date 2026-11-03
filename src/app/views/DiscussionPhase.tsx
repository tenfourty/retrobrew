import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { remainingMs } from '../../clock/clock';
import { columnOrder } from '../../engine/order';
import type { Command, TopicView, ViewState } from '../../engine/types';
import { Button, Column, ColumnGroup, DialTimer } from '../../ui/components';
import { StatusStrip } from '../../ui/status-strip';
import { TabPanel, Tabs } from '../../ui/tabs';
import { countdownAnnouncement } from '../announce';
import { useAnnounce } from '../announcer';
import { lengthLabel } from '../lengths';
import { STRIP_IDLE, stripContent, switchToDiscussing } from '../status-strip';
import { useInset } from '../use-inset';
import { TopicItem } from './TopicItem';

type Tab = 'todiscuss' | 'discussing' | 'discussed';

// Re-renders every quarter second while a timer runs, so the countdown moves.
function useTicking(on: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const id = setInterval(() => set((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [on]);
}

// The discussion phase (docs/product/mvp-screens.md, The discussion phase). Wide: To discuss, Discussing and
// Discussed side by side. Phones: a status strip and a tab per column; when a topic starts the Discussing tab opens,
// but not while someone is typing a topic. "No votes yet" heads the topics nobody voted for, only when some topic has votes.
// onDiscuss, onDelete and onOpenVote pass the button, so focus returns to it
// when the sheet they open closes.
export function DiscussionPhase(props: {
  view: ViewState; you: string; facilitator: boolean; readOnly: boolean; votesLeft: number; wide: boolean;
  hostNow: () => number; typing: boolean; outcome: ComponentChildren;
  // The round of the last timer whose countdown was said. MeetingScreen keeps it, so this view remounting (the layout
  // flipping, the phase going to topics and back) never says "1 minute left" twice for one timer. Every timer has its own
  // round, so a timer started by "keep going" is counted down again.
  countedDown: { current: number | null };
  send: (cmd: Command, place: string) => void; onDelete: (topic: TopicView, opener: HTMLElement | null) => void;
  alertFor: (place: string) => string | undefined;
  onDiscuss: (topicId: number, opener: HTMLElement) => void; onOpenVote: (opener: HTMLElement) => void;
}) {
  const { view, wide } = props;
  const toDiscuss = columnOrder(view, 'toDiscuss');
  const discussed = columnOrder(view, 'discussed');
  const discussing = view.topics.find((t) => t.column === 'discussing');
  const voted = toDiscuss.filter((t) => (t.votes ?? 0) > 0);
  const unvoted = toDiscuss.filter((t) => (t.votes ?? 0) === 0);
  const [tab, setTab] = useState<Tab>(discussing ? 'discussing' : 'todiscuss');
  const top = useRef<HTMLDivElement>(null);
  useTicking(view.timer !== null && view.vote === null);
  // An edit draft per topic, kept here so it survives the layout flipping between columns and tabs.
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const setDraft = (topicId: number) => (draft: string | null) => setDrafts((all) => {
    const { [topicId]: _old, ...rest } = all;
    return draft === null ? rest : { ...rest, [topicId]: draft };
  });
  useInset(top, '--mtg-top', !wide);

  const shownTopic = useRef(discussing?.topicId);
  useEffect(() => {
    if (switchToDiscussing(shownTopic.current, discussing?.topicId, props.typing)) setTab('discussing');
    shownTopic.current = discussing?.topicId;
  }, [discussing?.topicId]);

  const timer = view.timer;
  const remaining = timer ? remainingMs(timer.endsAt, props.hostNow()) / 1000 : null;
  // "1 minute left" (or "10 seconds left" on a rehearsal timer), once for each timer. This view stays mounted on both
  // layouts and every tab, so a hidden panel never changes what is said.
  const announce = useAnnounce();
  const { countedDown } = props;
  const countdown = countdownAnnouncement(timer, (remaining ?? 0) * 1000);
  useEffect(() => {
    if (countdown && timer && view.vote === null && countedDown.current !== timer.round) {
      countedDown.current = timer.round;
      announce(countdown);
    }
  });
  const item = (t: TopicView) => (
    <TopicItem key={t.topicId} topic={t} view={view} you={props.you} facilitator={props.facilitator} readOnly={props.readOnly}
      votesLeft={props.votesLeft} send={(cmd) => props.send(cmd, `card:${t.topicId}`)} onDelete={props.onDelete}
      draft={drafts[t.topicId] ?? null} onDraft={setDraft(t.topicId)} onDiscuss={props.onDiscuss} alert={props.alertFor(`card:${t.topicId}`)} />
  );

  const toDiscussColumn = (
    <Column state="todiscuss" focusable count={toDiscuss.length} empty="Every topic has been discussed. Add another, or go back to topics to collect more.">
      {voted.map(item)}
      {voted.length > 0 && unvoted.length > 0 ? <ColumnGroup>No votes yet</ColumnGroup> : null}
      {unvoted.map(item)}
    </Column>
  );
  const discussingColumn = (
    <Column state="discussing" count={null} focusFallback={wide && !props.facilitator}
      empty={props.facilitator ? 'Pick a topic from To discuss.' : 'Nothing is being discussed yet. The facilitator picks the next topic.'}>
      {discussing ? (
        <TopicItem topic={discussing} view={view} you={props.you} facilitator={props.facilitator} readOnly={props.readOnly}
          votesLeft={props.votesLeft} send={(cmd) => props.send(cmd, `card:${discussing.topicId}`)} onDelete={props.onDelete} live
          alert={props.alertFor(`card:${discussing.topicId}`)}>
          {timer && remaining !== null ? (
            <DialTimer remaining={remaining} total={(timer.endsAt - timer.startedAt) / 1000} warnAt={timer.minuteMs / 1000} up={view.vote !== null}
              sub={`of ${lengthLabel(timer.endsAt - timer.startedAt)}`} />
          ) : <p className="mtg-no-timer">No timer</p>}
          {wide && view.vote ? <div><Button variant="secondary" size="sm" onClick={(e) => props.onOpenVote(e.currentTarget)}>Vote</Button></div> : null}
        </TopicItem>
      ) : null}
    </Column>
  );
  const discussedColumn = <Column state="discussed" focusable count={discussed.length} empty="Finished topics appear here">{discussed.map(item)}</Column>;

  // Wide: the outcome line sits at the top of the Discussing column.
  if (wide) {
    return <div className="mtg-columns">{toDiscussColumn}<div className="mtg-discussing">{props.outcome}{discussingColumn}</div>{discussedColumn}</div>;
  }

  const strip = stripContent(view, remaining);
  return (
    <div className="mtg-discussion">
      <div className="mtg-sticky" ref={top}>
        <StatusStrip label={strip.label} focusFallback={!props.facilitator} idleText={STRIP_IDLE} number={strip.number} text={strip.short} end={strip.end} chip={strip.chip}
          up={view.vote !== null} onOpen={() => setTab('discussing')} onChip={props.onOpenVote} />
        {props.outcome}
        <Tabs label="Discussion" base="discussion" selected={tab} onSelect={setTab} tabs={[
          { id: 'todiscuss', label: 'To discuss', count: toDiscuss.length, state: 'todiscuss' },
          { id: 'discussing', label: 'Discussing', state: 'discussing' },
          { id: 'discussed', label: 'Discussed', count: discussed.length, state: 'discussed' },
        ]} />
      </div>
      <TabPanel base="discussion" id="todiscuss" hidden={tab !== 'todiscuss'}>{toDiscussColumn}</TabPanel>
      <TabPanel base="discussion" id="discussing" hidden={tab !== 'discussing'}>{discussingColumn}</TabPanel>
      <TabPanel base="discussion" id="discussed" hidden={tab !== 'discussed'}>{discussedColumn}</TabPanel>
    </div>
  );
}
