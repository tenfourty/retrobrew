import { Button } from './components';
import { cx } from './cx';

// The phone's status strip (design/system/components/StatusStrip): a one-line, tappable summary of what is being
// discussed, and the "Vote" chip while the time-up vote is open. Two buttons side by side, never one inside the other.
// onChip passes the chip, so focus returns to it when the sheet it opens closes. With `focusFallback` the strip's main
// button is where focus lands when the chip has gone by then (the vote closed while its sheet was open).
export function StatusStrip(props: {
  label: string; focusFallback?: boolean; idleText?: string; number?: number; text?: string; end?: string; chip: boolean; up?: boolean;
  onOpen: () => void; onChip: (opener: HTMLElement) => void;
}) {
  return (
    <div className={cx('rb-strip', props.up && 'rb-strip-up')}>
      <button type="button" className="rb-strip-main" aria-label={props.label} data-focus-fallback={props.focusFallback ? '' : undefined} onClick={props.onOpen}>
        {props.number === undefined ? <span className="rb-strip-text">{props.idleText}</span> : (
          <>
            <span className="rb-strip-num">{`#${props.number}`}</span>
            <span className="rb-strip-text">{props.text}</span>
            <span className="rb-strip-end">{props.end}</span>
          </>
        )}
      </button>
      {props.chip ? <Button variant="secondary" size="sm" onClick={(e) => props.onChip(e.currentTarget)}>Vote</Button> : null}
    </div>
  );
}
