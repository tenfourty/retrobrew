import { createContext, type ComponentChildren } from 'preact';
import { useCallback, useContext, useEffect, useRef } from 'preact/hooks';
import { topmostDialog } from '../ui/sheet';

const Announce = createContext<(text: string) => void>(() => undefined);

// The page's one polite live region (docs/product/mvp-screens.md, Accessibility). Phase changes, a topic starting,
// the countdown, outcome lines, copy confirmations and refusals all go through it.
// An open sheet is a modal dialog, which makes the rest of the page inert, and inert content is never read out. So the
// region moves into the topmost open dialog before it speaks, and back to the page when none is open.
export function Announcer({ children }: { children?: ComponentChildren }) {
  const region = useRef<HTMLDivElement | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queued = useRef<string[]>([]);

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

  // Effects run children first, so a banner present on the first render announces before this effect: announce() makes
  // the region itself if it isn't there yet. The effect still makes it up front, so it exists before it first speaks.
  useEffect(() => {
    ensureRegion();
    return () => { clearTimeout(pending.current); region.current?.remove(); region.current = null; };
  }, [ensureRegion]);

  const announce = useCallback((text: string) => {
    const el = ensureRegion();
    // Empty it, then speak on the next tick, so the same words twice in a row are read twice. Messages that arrive
    // together, such as a phase change and a topic starting, are read as one.
    el.textContent = '';
    queued.current.push(text);
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      // Found when it speaks, not when it is asked: a sheet that opens in the same update (time up) is already open by now.
      const host = topmostDialog() ?? document.body;
      if (el.parentElement !== host) host.appendChild(el);
      el.textContent = queued.current.join(' ');
      queued.current = [];
    }, 50);
  }, [ensureRegion]);

  return <Announce.Provider value={announce}>{children}</Announce.Provider>;
}

export function useAnnounce(): (text: string) => void {
  return useContext(Announce);
}
