import { LIVE_REGION_CLEAR_MS } from './announce';

// The timing of the page's live region, apart from the DOM so it can be tested with fake timers (the Announcer in
// announcer.tsx supplies the real region). `region()` makes the region if it isn't there; `place(region)` moves it where
// it will be heard (into the topmost open dialog), and is called when it speaks, not when it is asked.
export interface SpeakerRegion { textContent: string | null }

export interface Speaker<R extends SpeakerRegion> {
  announce(text: string): void;
  // Cancels anything waiting: the speech not yet made and the emptying.
  dispose(): void;
  readonly region: () => R;
}

export const SPEAK_DELAY_MS = 50;

export function createSpeaker<R extends SpeakerRegion>(region: () => R, place: (region: R) => void): Speaker<R> {
  let pending: ReturnType<typeof setTimeout> | undefined;
  let clearing: ReturnType<typeof setTimeout> | undefined;
  let queued: string[] = [];
  return {
    region,
    announce(text) {
      const el = region();
      // Empty it, then speak on the next tick, so the same words twice in a row are read twice. Messages that arrive
      // together, such as a phase change and a topic starting, are read as one.
      el.textContent = '';
      queued.push(text);
      clearTimeout(pending);
      clearTimeout(clearing);
      pending = setTimeout(() => {
        place(el);
        el.textContent = queued.join(' ');
        queued = [];
        // Emptying is not an announcement, and a newer announce() cancels it. A reader browsing later meets no stale line.
        clearing = setTimeout(() => { el.textContent = ''; }, LIVE_REGION_CLEAR_MS);
      }, SPEAK_DELAY_MS);
    },
    dispose() {
      clearTimeout(pending);
      clearTimeout(clearing);
    },
  };
}
