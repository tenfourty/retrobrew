import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';
import { Button } from './components';
import { cx } from './cx';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children?: ComponentChildren;
  // Sheets that end in their own Done, Cancel or Close button leave out the header's Close.
  noClose?: boolean;
  // A CSS selector for what gets focus when the sheet opens; otherwise the first focusable control.
  initialFocus?: string;
  className?: string;
  // What gets focus back on closing. Safari doesn't focus a button on click, so callers pass the button; otherwise it is
  // whatever had focus when the sheet opened. If that is gone by then, a `[data-focus-fallback]` element gets focus.
  returnFocusTo?: HTMLElement | null;
}

// Dialogs are numbered as they open, so the topmost is the last one opened. The top layer stacks modal dialogs in that
// order, but document order (where a re-rendered or earlier-opened sheet may sit later) says nothing about it.
let opened = 0;
const OPENED = 'data-opened';

// The open dialog on top of the stack: the one opened last, or null when none is open.
export function topmostDialog(): HTMLDialogElement | null {
  let top: HTMLDialogElement | null = null;
  let at = -1;
  for (const d of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) {
    const n = Number(d.getAttribute(OPENED) ?? 0);
    if (n >= at) { top = d; at = n; }
  }
  return top;
}

// A bottom sheet on phones and a centred dialog on wide screens (design/system/components/Sheet). It is a native
// modal <dialog>, so the page behind is inert. Escape closes it, Tab and Shift+Tab stay inside it, and on closing,
// focus goes back to the control that opened it.
export function Sheet(props: SheetProps) {
  if (!props.open) return null;
  return <OpenSheet {...props} />;
}

function OpenSheet({ title, onClose, children, noClose, initialFocus, className, returnFocusTo }: SheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const node = dialog.current!;
    const opener = returnFocusTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (!node.open) { node.showModal(); node.setAttribute(OPENED, String(++opened)); }
    const first = (initialFocus && node.querySelector<HTMLElement>(initialFocus)) || node.querySelector<HTMLElement>(`.rb-sheet-body :is(${FOCUSABLE})`)
      || node.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      // The page's live region may have moved in here to be heard over the modal; hand it back before the dialog goes.
      // Known limit: a sentence being spoken from inside this dialog can be cut short by the move, when a sheet closes
      // within about 50 ms of the announcement. The region has to leave, or it goes with the dialog.
      const region = node.querySelector('[data-live-region]');
      if (region) document.body.appendChild(region);
      if (node.open) node.close();
      // The opener can be gone (the action it started changed the bar): land on the page's fallback target.
      if (opener?.isConnected) opener.focus();
      else document.querySelector<HTMLElement>('[data-focus-fallback]')?.focus();
    };
  }, []);

  const trapTab = (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusables = [...dialog.current!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  return (
    <dialog ref={dialog} className={cx('rb-sheet', className)} aria-labelledby={titleId} onKeyDown={trapTab}
      onCancel={(e) => { e.preventDefault(); close.current(); }}>
      <div className="rb-sheet-head">
        <h2 className="rb-sheet-title" id={titleId}>{title}</h2>
        {noClose ? null : <Button variant="ghost" size="sm" onClick={() => close.current()}>Close</Button>}
      </div>
      <div className="rb-sheet-body">{children}</div>
    </dialog>
  );
}

export interface ConfirmAction {
  label: string;
  variant: 'primary' | 'secondary' | 'danger';
  onClick: () => void;
}

// A Sheet with a body and a row of buttons: other actions first, the danger action last but one, and Cancel last.
// Escape and Cancel close it without acting.
export function ConfirmDialog(props: { open: boolean; title: string; body: ComponentChildren; actions: ConfirmAction[]; onCancel: () => void; cancelLabel?: string; returnFocusTo?: HTMLElement | null }) {
  const ordered = [...props.actions.filter((a) => a.variant !== 'danger'), ...props.actions.filter((a) => a.variant === 'danger')];
  return (
    <Sheet open={props.open} title={props.title} onClose={props.onCancel} noClose className="rb-confirm" returnFocusTo={props.returnFocusTo}>
      <div className="rb-confirm-body">{props.body}</div>
      <div className="rb-confirm-actions">
        {ordered.map((a, i) => <Button key={i} variant={a.variant} onClick={a.onClick}>{a.label}</Button>)}
        <Button variant="ghost" onClick={props.onCancel}>{props.cancelLabel ?? 'Cancel'}</Button>
      </div>
    </Sheet>
  );
}
