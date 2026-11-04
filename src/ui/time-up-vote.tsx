import type { ComponentChildren } from 'preact';
import { useId } from 'preact/hooks';
import { cx } from './cx';

export type TimeUpChoice = 'extend' | 'none' | 'end';

const CHOICES: Array<{ value: TimeUpChoice; label: string }> = [
  { value: 'extend', label: 'Keep going' },
  { value: 'none', label: 'No preference' },
  { value: 'end', label: 'Move on' },
];

// The time-up ballot (design/system/components/TimeUpVote): three choices, then the totals and turnout, then, for the
// facilitator, the decision area passed as children. After voting the buttons are disabled and the choice shows
// pressed (they lock as soon as a choice is made, before the host confirms, so a second tap cannot overwrite it); after a reload the view only knows that you voted, so it says so with nothing pressed.
export function TimeUpVote(props: {
  topic: string; choice?: TimeUpChoice; voted: boolean; disabled?: boolean; onChoose: (choice: TimeUpChoice) => void;
  hint?: string; totals?: { extend: number; none: number; end: number }; turnout?: string; title?: string;
  // Visible headings over the ballot and over the facilitator's decision (the children), so the two sets of Keep going and Move on are told apart.
  voteHeading?: string; decisionHeading?: string;
  children?: ComponentChildren; className?: string;
}) {
  const voteId = useId();
  const decisionId = useId();
  // Locked once this page has chosen, or the host says it voted (after a reload), or the page is read-only.
  const locked = props.voted || props.choice !== undefined || !!props.disabled;
  return (
    <section className={cx('rb-timeup', props.className)} aria-label="Time-up vote">
      {props.title ? <h3>{props.title}</h3> : null}
      <p className="rb-timeup-topic">{props.topic}</p>
      {props.voteHeading ? <h3 className="rb-timeup-heading" id={voteId}>{props.voteHeading}</h3> : null}
      <div className="rb-choices" role="group" aria-label={props.voteHeading ? undefined : 'Your vote'} aria-labelledby={props.voteHeading ? voteId : undefined}>
        {CHOICES.map((c) => (
          <button key={c.value} type="button" className="rb-choice" aria-pressed={props.choice === c.value ? 'true' : 'false'}
            disabled={locked} onClick={() => props.onChoose(c.value)}>
            {c.label}
          </button>
        ))}
      </div>
      {props.voted && !props.choice ? <p>You've voted</p> : null}
      {props.hint && !locked ? <p>{props.hint}</p> : null}
      {props.totals ? <p className="rb-timeup-totals">{`Keep going ${props.totals.extend} · No preference ${props.totals.none} · Move on ${props.totals.end}`}</p> : null}
      {props.turnout ? <p>{props.turnout}</p> : null}
      {props.children ? (
        <div className="rb-timeup-decision" role={props.decisionHeading ? 'group' : undefined} aria-labelledby={props.decisionHeading ? decisionId : undefined}>
          {props.decisionHeading ? <h3 className="rb-timeup-heading" id={decisionId}>{props.decisionHeading}</h3> : null}
          {props.children}
        </div>
      ) : null}
    </section>
  );
}

// A short-lived line saying how the vote was decided (design/system/components/OutcomeLine). It has no live region of
// its own: the page's single polite live region reads it out.
// `action` is an optional quiet button beside the line (Undo after Move on).
export function OutcomeLine(props: { children: ComponentChildren; action?: ComponentChildren }) {
  if (!props.action) return <p className="rb-outcome">{props.children}</p>;
  return <div className="rb-outcome-row"><p className="rb-outcome">{props.children}</p>{props.action}</div>;
}
