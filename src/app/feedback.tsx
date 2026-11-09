import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { COPY } from '../feedback/copy';
import { installErrorCapture, recentErrors } from '../feedback/errors';
import { fetchLiveVersion } from '../feedback/send';
import { CONNECTION_DELAY_MS, TroubleLatch } from '../feedback/trouble';
import { Button } from '../ui/components';
import { TroubleMark, troubleProps } from '../ui/trouble-mark';
import { browserFacts, feedbackInputs, type PageContext } from './feedback-inputs';
import { FEEDBACK_BUILT, feedbackEnabled } from './feedback-gate';
import { feedbackHooks } from './feedback-hooks';
import { applyConnection, type TroubleSignals } from './feedback-signals';
import { FeedbackSheet, type FeedbackSheetProps } from './views/FeedbackSheet';

// The page's one trouble latch. Nothing reaches it unless `feedbackEnabled()` (the build carries the feature, on its origin).
export const latch = /* @__PURE__ */ new TroubleLatch();

/** Starts listening for the page's own uncaught errors. Called once from main.tsx; does nothing when the feature is off. */
export function installFeedback(): void {
  if (!FEEDBACK_BUILT || !feedbackEnabled()) return;
  installErrorCapture({ target: window, onError: () => latch.raise('error') });
  const hooks = import.meta.env.MODE === 'e2e' ? feedbackHooks() : {};
  if (hooks.throwOnLoad) {
    // An uncaught error from this bundle, for the browser battery.
    setTimeout(() => { throw new Error(hooks.throwMessage ?? 'A browser test threw this error'); }, 0);
  }
}

/** How long the relays must stay lost before it counts as trouble (a browser test may shorten it). */
export function connectionDelayMs(): number {
  return feedbackHooks().connectionDelayMs ?? CONNECTION_DELAY_MS;
}

/** Re-renders the page whenever a trouble source switches on or off. */
export function useTroubleVersion(): void {
  const [, force] = useState(0);
  useEffect(() => latch.subscribe(() => force((n) => n + 1)), []);
}

/** Whether the `error` source is on, for the error banner (re-renders with the latch). */
export function useErrorTrouble(): boolean {
  useTroubleVersion();
  return FEEDBACK_BUILT && feedbackEnabled() && latch.has('error');
}

/** Feeds a page's signals to the latch while it is shown, and takes them back when it goes. */
export function useTroubleSignals(signals: TroubleSignals): void {
  const { startup = false, save = false, connectionNow = false, connectionAfterDelay = false } = signals;
  useEffect(() => {
    if (!FEEDBACK_BUILT || !feedbackEnabled()) return undefined;
    latch.set('startup', startup);
    return () => latch.clear('startup');
  }, [startup]);
  useEffect(() => {
    if (!FEEDBACK_BUILT || !feedbackEnabled()) return undefined;
    latch.set('save', save);
    return () => latch.clear('save');
  }, [save]);
  useEffect(() => {
    if (!FEEDBACK_BUILT || !feedbackEnabled()) return undefined;
    applyConnection(latch, connectionNow, connectionAfterDelay, connectionDelayMs());
    return () => latch.clear('connection');
  }, [connectionNow, connectionAfterDelay]);
}

/** What a page hands the feedback sheet and its buttons, or undefined when the feature is off (nothing is placed). */
export type FeedbackWiring = Pick<FeedbackSheetProps, 'prepare' | 'loadLiveVersion' | 'trouble' | 'onSent'> & {
  /** Whether the buttons carry the accent dot. */
  troubled: boolean;
  /** Whether a banner that explains this source offers "Send feedback" (see feedback-banner.ts). */
  has: (source: Parameters<TroubleLatch['has']>[0]) => boolean;
};

/** The sheet's props for a page: it re-renders with the latch, reads the page's context once as the sheet opens. */
export function useFeedbackWiring(context: () => PageContext): FeedbackWiring | undefined {
  useTroubleVersion();
  const ref = useRef(context);
  ref.current = context;
  if (!FEEDBACK_BUILT || !feedbackEnabled()) return undefined;
  const trouble = latch.current();
  return {
    prepare: () => feedbackInputs(ref.current(), browserFacts(), latch.current(), recentErrors()),
    loadLiveVersion: () => fetchLiveVersion(),
    trouble,
    onSent: () => latch.clear('error'),
    troubled: trouble !== null,
    has: (source) => latch.has(source),
  };
}

/** The sheet for a page that is not a meeting: `open(from)` opens it, `element` goes in the page. Both are inert when the feature is off. */
export function useFeedbackSheet(context: () => PageContext, options: { openOn?: object | null; onClose?: () => void } = {}) {
  const wiring = useFeedbackWiring(context);
  const [open, setOpen] = useState(Boolean(options.openOn) && feedbackEnabled());
  const opener = useRef<HTMLElement | null>(null);
  // A new arrival (the `#feedback` link followed again) opens the sheet again.
  useEffect(() => { if (options.openOn && feedbackEnabled()) setOpen(true); }, [options.openOn]);
  return {
    wiring,
    open: (from?: HTMLElement) => { opener.current = from ?? null; setOpen(true); },
    element: FEEDBACK_BUILT && wiring ? (
      <FeedbackSheet open={open} {...wiring} returnFocusTo={opener.current}
        onClose={() => { setOpen(false); options.onClose?.(); }} />
    ) : null,
  };
}

/** The ghost "Send feedback" button, with the accent dot while the app has noticed a problem. */
export function FeedbackButton(props: { place: string; troubled: boolean; onClick: (from: HTMLElement) => void; size?: 'md' | 'sm'; children?: ComponentChildren }) {
  if (!FEEDBACK_BUILT) return null;
  const id = `fbk-trouble-${props.place}`;
  const description = props.troubled ? COPY.troubleDescription : null;
  return (
    <Button variant="ghost" size={props.size ?? 'sm'} onClick={(e) => props.onClick(e.currentTarget)} {...troubleProps(id, description)}>
      {props.children ?? COPY.button}
      <TroubleMark id={id} description={description} />
    </Button>
  );
}

/** A calm page's footer row: the button, or nothing when the feature is off. */
export function FeedbackFooter(props: { place: string; wiring: FeedbackWiring | undefined; open: (from: HTMLElement) => void }) {
  if (!FEEDBACK_BUILT || !props.wiring) return null;
  return (
    <footer className="fbk-footer">
      <FeedbackButton place={props.place} troubled={props.wiring.troubled} onClick={props.open} />
    </footer>
  );
}
