/// <reference types="node" />

// Used only by vite.config.ts at build time, never by the app.
// Which builds carry the feedback feature.

/** The one origin whose build may carry the feature. */
export const PRODUCTION_ORIGIN = 'https://retrobrew.app';

/** What the define holds for dev and the e2e build: the page's own origin, whichever it is, talking to the stub. */
export const STUB_ORIGIN = 'self';

export interface FlagInput {
  /** Vite's mode: `development`, `production` or `e2e`. */
  mode: string;
  /** Vite's command: `serve` (dev, and preview) or `build`. */
  command: string;
  env?: Record<string, string | undefined>;
}

export interface FeedbackFlag {
  /** The value of `__RB_FEEDBACK_ORIGIN__`: empty when the feature is compiled out. */
  origin: string;
  /** True when the dev server or the e2e preview mounts the stub. */
  stub: boolean;
}

/**
 * The feature is on in dev and in `--mode e2e` (pointing at the stub), and in a production build only when
 * FEEDBACK_ORIGIN names the production origin exactly. Any other value is a mistake and stops the build.
 */
export function feedbackFlag({ mode, command, env = process.env }: FlagInput): FeedbackFlag {
  const given = env.FEEDBACK_ORIGIN?.trim() ?? '';
  const stub = mode === 'e2e' || (mode === 'development' && command === 'serve');
  if (stub) {
    if (given) throw new Error(`FEEDBACK_ORIGIN is set, but dev and --mode e2e builds always use the stub (this is --mode ${mode}). Unset it.`);
    return { origin: STUB_ORIGIN, stub: true };
  }
  if (!given) return { origin: '', stub: false };
  if (given !== PRODUCTION_ORIGIN) throw new Error(`FEEDBACK_ORIGIN must be ${PRODUCTION_ORIGIN} or unset, not "${given}".`);
  return { origin: given, stub: false };
}
