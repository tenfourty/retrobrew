import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../../ui/components';
import { QrCode } from '../../ui/qr';
import { Sheet } from '../../ui/sheet';
import { useAnnounce } from '../announcer';
import { copyText } from '../clipboard';

const COPIED_MS = 2000;

// The share step (docs/product/mvp-screens.md, The share step): a QR code drawn here, the native share sheet where
// it exists, and Copy link, with a field to copy from by hand if the clipboard is refused.
export function ShareSheet(props: { open: boolean; link: string; meetingName: string; opener?: HTMLElement | null; onClose: () => void }) {
  const announce = useAnnounce();
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const canShare = typeof navigator.share === 'function';

  useEffect(() => {
    if (!props.open) { setCopied(false); setManual(false); }
  }, [props.open]);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  useEffect(() => {
    if (manual) { field.current?.focus(); field.current?.select(); }
  }, [manual]);

  const copy = async () => {
    if (await copyText(props.link)) {
      setCopied(true);
      announce('Link copied');
    } else {
      setManual(true);
    }
  };
  const share = () => {
    // Closing the native sheet without sharing rejects; there is nothing to say about that.
    navigator.share({ title: props.meetingName, text: 'Join my Lean Coffee on Retrobrew', url: props.link }).catch(() => undefined);
  };

  return (
    <Sheet open={props.open} title="Invite people" onClose={props.onClose} returnFocusTo={props.opener} noClose>
      <QrCode text={props.link} label="QR code for the meeting link" />
      <p className="mtg-center">Scan to join, or share the link</p>
      <div className="mtg-buttons">
        {canShare ? <Button onClick={share}>Share link</Button> : null}
        <Button variant={canShare ? 'secondary' : 'primary'} onClick={() => void copy()}>{copied ? 'Link copied' : 'Copy link'}</Button>
      </div>
      {manual ? (
        <div className="rb-field">
          <label className="rb-label" htmlFor="share-link-field">Copy the link from here</label>
          <input ref={field} id="share-link-field" className="rb-input" readOnly value={props.link} />
        </div>
      ) : null}
      <p className="rb-hint">Anyone with this link can join and read the meeting. Share it only with the people taking part.</p>
      <div><Button variant="ghost" onClick={props.onClose}>Done</Button></div>
    </Sheet>
  );
}
