import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../ui/components';
import { QrCode } from '../../ui/qr';
import { Sheet } from '../../ui/sheet';
import { useAnnounce } from '../announcer';
import { copyText } from '../clipboard';

const COPIED_MS = 2000;

// The share step (docs/product/mvp-screens.md, The share step): a QR code drawn here, the link itself as selectable text,
// the native share sheet where it exists, and Copy link. If the clipboard is refused the link is selected, to copy by hand.
export function ShareSheet(props: { open: boolean; link: string; meetingName: string; opener?: HTMLElement | null; onClose: () => void }) {
  const announce = useAnnounce();
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const canShare = typeof navigator.share === 'function';

  useEffect(() => {
    if (!props.open) { setCopied(false); setManual(false); }
  }, [props.open]);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = async () => {
    if (await copyText(props.link)) {
      setCopied(true);
      announce('Link copied');
    } else {
      // The link is already on show: select it, to copy by hand.
      setManual(true);
      field.current?.focus();
      field.current?.select();
    }
  };
  const share = () => {
    // Closing the native sheet without sharing rejects; there is nothing to say about that.
    navigator.share({ title: props.meetingName, text: 'Join my Lean Coffee on Retrobrew', url: props.link }).catch(() => undefined);
  };

  return (
    <Sheet open={props.open} title="Invite people" onClose={props.onClose} returnFocusTo={props.opener} noClose initialFocus=".mtg-buttons button">
      <QrCode text={props.link} label="QR code for the meeting link" />
      <p className="mtg-center">Scan to join, or share the link</p>
      <div className="rb-field">
        <label className="rb-label" htmlFor="share-link-field">Meeting link</label>
        <textarea ref={field} id="share-link-field" className="rb-input mtg-link-field" readOnly spellcheck={false} value={props.link}
          rows={Math.min(8, Math.ceil(props.link.length / 30))} onFocus={(e) => e.currentTarget.select()}
          onMouseUp={(e) => e.preventDefault()} />
        {manual ? <p className="rb-hint">The browser wouldn't copy it. The link is selected: copy it from here.</p> : null}
      </div>
      <div className="mtg-buttons">
        {canShare ? <Button onClick={share}>Share link</Button> : null}
        <Button variant={canShare ? 'secondary' : 'primary'} onClick={() => void copy()}>{copied ? 'Link copied' : 'Copy link'}</Button>
      </div>
      <p className="rb-hint">Anyone with this link can join and read the meeting. Share it only with the people taking part.</p>
      <div><Button variant="ghost" onClick={props.onClose}>Done</Button></div>
    </Sheet>
  );
}
