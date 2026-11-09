// Browser tests drive the feedback feature through one tab setting, `rb-e2e-feedback` in sessionStorage (JSON). Only test
// builds (`vite build --mode e2e`) read it: the read sits inside `if (import.meta.env.MODE === 'e2e')`, a constant at
// build time, so any other build compiles it out; `npm run check:assets` fails a build that still carries FEEDBACK_KEY.
export interface FeedbackHooks {
  /** Throw an uncaught error from the app's own bundle as the page starts (the `error` trouble source). */
  throwOnLoad?: boolean;
  /** The thrown error's message (at most 200 characters), so a test can put board text in it. */
  throwMessage?: string;
  /** Replaces the 30 s the relays must stay lost before it counts as trouble. */
  connectionDelayMs?: number;
}

export const FEEDBACK_KEY = 'rb-e2e-feedback';

export function parseFeedbackHooks(raw: string | null): FeedbackHooks {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const { throwOnLoad, throwMessage, connectionDelayMs } = value as Record<string, unknown>;
    const hooks: FeedbackHooks = {};
    if (throwOnLoad === true) hooks.throwOnLoad = true;
    if (typeof throwMessage === 'string') hooks.throwMessage = throwMessage.slice(0, 200);
    if (typeof connectionDelayMs === 'number' && Number.isFinite(connectionDelayMs) && connectionDelayMs >= 0) hooks.connectionDelayMs = connectionDelayMs;
    return hooks;
  } catch {
    return {};
  }
}

export function feedbackHooks(): FeedbackHooks {
  if (import.meta.env.MODE === 'e2e') {
    try {
      return parseFeedbackHooks(window.sessionStorage.getItem(FEEDBACK_KEY));
    } catch {
      return {};
    }
  }
  return {};
}
