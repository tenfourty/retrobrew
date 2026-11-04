import { useId } from 'preact/hooks';

export interface SegmentOption<T> {
  value: T;
  label: string;
  disabled?: boolean;
}

// A single choice from a row of buttons (design/system/components/Segmented): timeboxes, extensions and the vote
// allowance. The chosen one is marked with aria-pressed, so the choice is never shown by colour alone.
export function Segmented<T extends string | number>(props: { label: string; options: SegmentOption<T>[]; value: T; onChange: (value: T, from: HTMLElement) => void; hint?: string;
  // A fixed number of columns, for a long list that should fill even rows (the nine timeboxes in three) and not leave one alone on the last.
  columns?: number }) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div className="rb-segmented-field" role="group" aria-labelledby={labelId} aria-describedby={props.hint ? hintId : undefined}>
      <span className="rb-label" id={labelId}>{props.label}</span>
      <div className="rb-segmented" style={props.columns ? `--seg-cols:${props.columns}` : undefined}>
        {props.options.map((o) => (
          <button key={String(o.value)} type="button" className="rb-segment" aria-pressed={o.value === props.value ? 'true' : 'false'}
            disabled={o.disabled} onClick={(e) => props.onChange(o.value, e.currentTarget)}>
            {o.label}
          </button>
        ))}
      </div>
      {props.hint ? <p className="rb-hint" id={hintId}>{props.hint}</p> : null}
    </div>
  );
}
