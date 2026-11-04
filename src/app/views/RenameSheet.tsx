import { useEffect, useState } from 'preact/hooks';
import { MESSAGES } from '../../engine/messages';
import { Button } from '../../ui/components';
import { Sheet } from '../../ui/sheet';

export const RENAME_TITLE = 'Change your name';

// Changing your name mid-meeting: everyone sees the new name on the topics you added and in the People sheet.
export function RenameSheet(props: { open: boolean; current: string; onSave: (name: string) => void; onClose: () => void; returnFocusTo?: HTMLElement | null }) {
  const [name, setName] = useState(props.current);
  const [error, setError] = useState('');
  useEffect(() => { if (props.open) { setName(props.current); setError(''); } }, [props.open]);
  const save = (e: Event) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setError(MESSAGES.emptyName); return; }
    props.onSave(trimmed);
  };
  return (
    <Sheet open={props.open} title={RENAME_TITLE} onClose={props.onClose} noClose returnFocusTo={props.returnFocusTo}>
      <form onSubmit={save}>
        <div className="rb-field">
          <label className="rb-label" htmlFor="rename-field">Your name</label>
          <input id="rename-field" className="rb-input" value={name} maxLength={60} autoComplete="name" aria-invalid={error ? 'true' : undefined}
            aria-describedby={error ? 'rename-error' : undefined} onInput={(e) => { setName(e.currentTarget.value); setError(''); }} />
          {error ? <p className="rb-alert" id="rename-error" role="alert">{error}</p> : null}
        </div>
        <div className="rb-confirm-actions">
          <Button type="submit" variant="primary">Save name</Button>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
        </div>
      </form>
    </Sheet>
  );
}
