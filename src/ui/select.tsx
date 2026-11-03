import { useId } from 'preact/hooks';

// A select styled like .rb-input (design/system/components/Select), with its label above.
export function Select<T extends string>(props: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="rb-field">
      <label className="rb-label" htmlFor={id}>{props.label}</label>
      <select id={id} className="rb-input rb-select" value={props.value} disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.value as T)}>
        {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
