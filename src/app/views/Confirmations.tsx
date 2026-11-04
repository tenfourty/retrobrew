import { useEffect, useRef } from 'preact/hooks';
import type { ViewState } from '../../engine/types';
import { ConfirmDialog } from '../../ui/sheet';

export type ConfirmId = 'resetVotes' | 'raiseVotes' | 'endMeeting' | 'backUp' | 'stopTimer';

// A read-only field holding text the clipboard refused, selected, so it can be copied by hand.
export function CopyField(props: { text: string }) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { field.current?.focus(); field.current?.select(); }, [props.text]);
  return (
    <div className="rb-field">
      <label className="rb-label" htmlFor="copy-text-field">Copy the text from here</label>
      <textarea ref={field} id="copy-text-field" className="rb-input mtg-copy-field" readOnly rows={8} value={props.text} />
    </div>
  );
}

// The facilitator's confirmations (docs/product/mvp-screens.md, Confirmations). "Copy as text" in the End meeting
// dialog copies without closing it; if the clipboard is refused, the text appears in the dialog to copy by hand.
export function Confirmations(props: {
  open: ConfirmId | null; view: ViewState; raiseTo: number | null; onRaiseVotes: () => void; opener?: HTMLElement | null; onCancel: () => void;
  onResetVotes: () => void; onEndMeeting: () => void; onStopTimer: () => void; onBackUp: () => void;
  onCopy: () => void; copied: boolean; copyFallback: string | null;
}) {
  const discussing = props.view.topics.find((t) => t.column === 'discussing');
  return (
    <>
      <ConfirmDialog open={props.open === 'resetVotes'} title="Reset all votes?" onCancel={props.onCancel} returnFocusTo={props.opener}
        body={<p>This removes every vote on topics that haven't been discussed, and gives them back. Votes on discussed topics stay spent.</p>}
        actions={[{ label: 'Reset votes', variant: 'danger', onClick: props.onResetVotes }]} />
      <ConfirmDialog open={props.open === 'raiseVotes' && props.raiseTo !== null} title={`Give everyone ${props.raiseTo} votes?`} onCancel={props.onCancel} returnFocusTo={props.opener}
        focusCancel body={<p>{`Everyone gets ${props.raiseTo} votes each. The allowance can't be lowered again once votes are cast.`}</p>}
        actions={[{ label: `Give ${props.raiseTo} votes`, variant: 'primary', onClick: props.onRaiseVotes }]} />
      <ConfirmDialog open={props.open === 'endMeeting'} title="End the meeting?" onCancel={props.onCancel} returnFocusTo={props.opener}
        body={(
          <>
            <p>Everyone sees the final board, and nobody can add or vote. You can reopen it later.</p>
            {discussing ? <p>{`#${discussing.topicId} moves to Discussed.`}</p> : null}
            {props.copyFallback !== null ? <CopyField text={props.copyFallback} /> : null}
          </>
        )}
        actions={[
          { label: props.copied ? 'Copied' : 'Copy as text', variant: 'secondary', onClick: props.onCopy },
          { label: 'End meeting', variant: 'danger', onClick: props.onEndMeeting },
        ]} />
      <ConfirmDialog open={props.open === 'stopTimer'} title="Stop the timer?" onCancel={props.onCancel} returnFocusTo={props.opener}
        body={<p>{discussing ? `#${discussing.topicId} stays in Discussing with no timer. You can start a new timer later.` : 'The topic stays in Discussing with no timer.'}</p>}
        actions={[{ label: 'Stop timer', variant: 'danger', onClick: props.onStopTimer }]} />
      <ConfirmDialog open={props.open === 'backUp'} title="Back up meeting file" onCancel={props.onCancel} returnFocusTo={props.opener}
        body={<p>This file holds the meeting's keys. Anyone who has it can open and run this meeting, so keep it somewhere private.</p>}
        actions={[{ label: 'Download file', variant: 'primary', onClick: props.onBackUp }]} />
    </>
  );
}
