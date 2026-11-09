/** The define's value in dev and the e2e build, where the feature talks to the stub on the page's own origin. */
const STUB = 'self';

/**
 * Whether a build with this define may show the feature on this origin: never when the define is empty (compiled out),
 * on any origin for the stub, and otherwise only on exactly the origin it was built for.
 */
export function feedbackAllowed(define: string, origin: string): boolean {
  if (define === '') return false;
  if (define === STUB) return true;
  return define === 'https://retrobrew.app' && origin === define;
}

/**
 * Whether this build carries the feedback feature at all. A module-level constant on the compile-time define, so the
 * bundler folds it and drops every branch it guards (and the modules only those branches reach) in a build without
 * FEEDBACK_ORIGIN. This is the one choke point: every entry into the feature from always-loaded code tests it directly
 * (`if (FEEDBACK_BUILT)`, `FEEDBACK_BUILT && …`), because a function call such as `feedbackEnabled()` is not folded.
 * `npm run check:assets` fails a build without the define that still carries the feature.
 */
export const FEEDBACK_BUILT: boolean = __RB_FEEDBACK_ORIGIN__ !== '';

/**
 * True when this page may show anything of the feedback feature: the build carries it and the page is on that origin.
 * Callers in always-loaded code test `FEEDBACK_BUILT` first, so the compiled-out build keeps none of their branch.
 */
export function feedbackEnabled(): boolean {
  return FEEDBACK_BUILT && feedbackAllowed(__RB_FEEDBACK_ORIGIN__, location.origin);
}
