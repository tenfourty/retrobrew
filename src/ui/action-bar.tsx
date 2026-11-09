import type { ComponentChildren } from 'preact';
import { Button, type ButtonProps } from './components';
import { cx } from './cx';
import { TroubleMark, troubleProps } from './trouble-mark';

// The facilitator's action bar (design/system/components/ActionBar). `stacked` is the wide side-panel block; otherwise
// it is the phone bar, with the primary passed last so it sits on the right.
export function ActionBar(props: { stacked: boolean; children: ComponentChildren; label: string }) {
  return <div className={cx(props.stacked ? 'rb-actionbar-stack' : 'rb-actionbar')} role="group" aria-label={props.label}>{props.children}</div>;
}

export interface ListAction {
  label: string;
  // Passes the clicked button on, so a sheet it opens can return focus to it.
  onClick: (from: HTMLElement) => void;
  variant?: ButtonProps['variant'];
  disabled?: boolean;
  // The accent dot and its hidden description, when the app has noticed a problem this row helps with (null or absent: none).
  trouble?: string | null;
}

// A full-width list of buttons, for the phone's "More" sheet (design/system/components/ActionList).
export function ActionList(props: { actions: ListAction[] }) {
  return (
    <ul className="rb-action-list">
      {props.actions.map((a) => (
        <li key={a.label}>
          <Button variant={a.variant ?? 'secondary'} disabled={a.disabled} onClick={(e) => a.onClick(e.currentTarget)} {...troubleProps('trouble-more', a.trouble ?? null)}>
            {a.label}
            <TroubleMark id="trouble-more" description={a.trouble ?? null} />
          </Button>
        </li>
      ))}
    </ul>
  );
}
