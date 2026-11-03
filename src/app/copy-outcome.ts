import { useEffect, useState } from 'preact/hooks';
import type { ViewState } from '../engine/types';
import { useAnnounce } from './announcer';
import { copyText } from './clipboard';
import { meetingAsText } from './meeting-text';

const COPIED_MS = 2000;

// Copy as text (docs/product/mvp-screens.md, Copy as text): after copying, the button reads "Copied" for 2 s and the
// live region says "Outcome copied". If the clipboard is refused, copy() returns the text, for a field to copy from.
export function useCopyOutcome(view: ViewState): { copied: boolean; copy: () => Promise<string | null> } {
  const announce = useAnnounce();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const id = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(id);
  }, [copied]);
  const copy = async () => {
    const text = meetingAsText(view, Date.now());
    if (!(await copyText(text))) return text;
    setCopied(true);
    announce('Outcome copied');
    return null;
  };
  return { copied, copy };
}
