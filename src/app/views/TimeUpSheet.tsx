import { useEffect, useRef, useState } from 'preact/hooks';
import { REAL_MINUTE_MS } from '../../engine/discussion';
import type { ViewState } from '../../engine/types';
import { Button } from '../../ui/components';
import { Segmented } from '../../ui/segmented';
import { Sheet } from '../../ui/sheet';
import { TimeUpVote, type TimeUpChoice } from '../../ui/time-up-vote';
import { DECISION_HEADING, decisionButtons, moveOnNote, NEW_TIMEBOX, recommendation, turnoutLine, VOTE_HEADING, VOTE_HINT, VOTE_TITLE } from '../decision';
import { moreSentence, timeboxLabel } from '../lengths';
import { EXTENSIONS, lastExtension, rememberExtension } from '../prefs';

// The time-up sheet (docs/product/mvp-screens.md, The time-up sheet). Everyone gets the ballot; the facilitator also
// gets the totals, the turnout and the decision. `choice` is this page's own ballot, held in memory only.
export function TimeUpSheet(props: {
  open: boolean; onClose: () => void; opener?: HTMLElement | null; view: ViewState; facilitator: boolean; readOnly: boolean;
  choice: TimeUpChoice | undefined; onVote: (choice: TimeUpChoice) => void;
  onKeepGoing: (minutes: number) => void; onMoveOn: () => void; onStartAgain: () => void;
  // Opened from "Decide": focus goes straight to the decision.
  atDecision: boolean;
}) {
  const [extension, setExtension] = useState(lastExtension);
  const closeRow = useRef<HTMLDivElement>(null);
  useEffect(() => { if (props.open) setExtension(lastExtension()); }, [props.open]);

  const vote = props.view.vote;
  const topic = vote && props.view.topics.find((t) => t.topicId === vote.topicId);
  if (!vote || !topic) return null;
  const minuteMs = props.view.timer?.minuteMs ?? REAL_MINUTE_MS;
  const totals = vote.totals ?? { extend: 0, none: 0, end: 0 };
  const buttons = decisionButtons(moreSentence(extension * minuteMs));
  const leaning = recommendation(totals);
  const decide = (kind: 'extend' | 'end') => {
    if (kind === 'end') { props.onMoveOn(); return; }
    rememberExtension(extension);
    props.onKeepGoing(extension);
  };

  return (
    <Sheet open={props.open} title={VOTE_TITLE} onClose={props.onClose} noClose returnFocusTo={props.opener}
      initialFocus={props.atDecision ? '.mtg-decision-primary' : undefined}>
      <TimeUpVote voteHeading={VOTE_HEADING} decisionHeading={props.facilitator ? DECISION_HEADING : undefined} topic={`#${topic.topicId} ${topic.text}`} choice={props.choice} voted={vote.voted} disabled={props.readOnly}
        onChoose={(choice) => {
          props.onVote(choice);
          // The tapped button locks while it has focus, which would drop focus to the page behind the modal.
          setTimeout(() => closeRow.current?.querySelector('button')?.focus(), 0);
        }} hint={vote.voted ? undefined : VOTE_HINT}
        totals={props.facilitator || vote.voted ? vote.totals : undefined}
        turnout={props.facilitator || vote.voted ? turnoutLine(vote.turnout, props.facilitator) : undefined}>
        {props.facilitator ? (
          <>
            {leaning ? <p className="mtg-leaning">{leaning}</p> : null}
            <Segmented label="More time" value={extension} onChange={setExtension}
              options={EXTENSIONS.map((m) => ({ value: m, label: timeboxLabel(m, minuteMs), disabled: props.readOnly }))} />
            <div className="mtg-decision">
              <Button className="mtg-decision-primary" disabled={props.readOnly} onClick={() => decide(buttons.primary.kind)}>{buttons.primary.label}</Button>
              <Button variant="ghost" disabled={props.readOnly} onClick={() => decide(buttons.secondary.kind)}>{buttons.secondary.label}</Button>
            </div>
            <p>{moveOnNote(topic.topicId)}</p>
            <div><Button variant="ghost" size="sm" disabled={props.readOnly} onClick={props.onStartAgain}>{NEW_TIMEBOX}</Button></div>
          </>
        ) : null}
      </TimeUpVote>
      <div ref={closeRow}><Button variant="ghost" onClick={props.onClose}>Close</Button></div>
    </Sheet>
  );
}
