import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef } from 'preact/hooks';
import { topmostDialog } from '../ui/sheet';
import { createSpeaker } from './speaker';

const Announce = createContext<(text: string) => void>(() => undefined);

// The page's one polite live region (docs/product/mvp-screens.md, Accessibility). Phase changes, a topic starting,
// the countdown, outcome lines, copy confirmations and refusals all go through it.
// An open sheet is a modal dialog, which makes the rest of the page inert, and inert content is never read out. So the
// region moves into the topmost open dialog before it speaks, and back to the page when none is open.
export function Announcer({ children }: { children?: ComponentChildren }) {
  const region = useRef<HTMLDivElement | null>(null);

  const ensureRegion = useCallback((): HTMLDivElement => {
    if (region.current) return region.current;
    const el = document.createElement('div');
    el.className = 'rb-visually-hidden';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.dataset.liveRegion = '';
    document.body.appendChild(el);
    region.current = el;
    return el;
  }, []);

  // Found when it speaks, not when it is asked: a sheet that opens in the same update (time up) is already open by now.
  const speaker = useMemo(() => createSpeaker(ensureRegion, (el) => {
    const host = topmostDialog() ?? document.body;
    if (el.parentElement !== host) host.appendChild(el);
  }), [ensureRegion]);

  // Effects run children first, so a banner present on the first render announces before this effect: announce() makes
  // the region itself if it isn't there yet. The effect still makes it up front, so it exists before it first speaks.
  useEffect(() => {
    ensureRegion();
    return () => { speaker.dispose(); region.current?.remove(); region.current = null; };
  }, [ensureRegion, speaker]);

  return <Announce.Provider value={speaker.announce}>{children}</Announce.Provider>;
}

export function useAnnounce(): (text: string) => void {
  return useContext(Announce);
}
