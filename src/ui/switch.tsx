import { useId } from 'preact/hooks';

// An on/off control with a label and optional hints, one per line (design/system/components/Switch).
export function Switch(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; hint?: string | string[]; disabled?: boolean }) {
  const hintId = useId();
  const hints = props.hint === undefined ? [] : [props.hint].flat();
  return (
    <div className="rb-toggle-field">
      <button type="button" role="switch" className="rb-toggle" aria-checked={props.checked ? 'true' : 'false'} disabled={props.disabled}
        aria-describedby={hints.length ? hints.map((_, i) => `${hintId}-${i}`).join(' ') : undefined} onClick={() => props.onChange(!props.checked)}>
        <span className="rb-toggle-track" aria-hidden="true"><span className="rb-toggle-thumb" /></span>
        <span>{props.label}</span>
      </button>
      {hints.map((hint, i) => <p key={hint} className="rb-hint" id={`${hintId}-${i}`}>{hint}</p>)}
    </div>
  );
}
