import type { ComponentChildren } from 'preact';
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
  children?: ComponentChildren; className?: string;
}) {
  // Locked once this page has chosen, or the host says it voted (after a reload), or the page is read-only.
  const locked = props.voted || props.choice !== undefined || !!props.disabled;
  return (
    <section className={cx('rb-timeup', props.className)} aria-label="Time-up vote">
      {props.title ? <h3>{props.title}</h3> : null}
      <p className="rb-timeup-topic">{props.topic}</p>
      <div className="rb-choices" role="group" aria-label="Your vote">
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
      {props.children ? <div className="rb-timeup-decision">{props.children}</div> : null}
    </section>
  );
}

// A short-lived line saying how the vote was decided (design/system/components/OutcomeLine). It has no live region of
// its own: the page's single polite live region reads it out.
export function OutcomeLine(props: { children: ComponentChildren }) {
  return <p className="rb-outcome">{props.children}</p>;
}
