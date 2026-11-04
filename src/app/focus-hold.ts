// Whether the add box "has focus" for the phone dock. Focus arriving counts at once; focus leaving counts only after a short
// hold. A tap on a card's button blurs the add box on its way down, before the click lands: if the facilitator's bar came
// back that instant, the dock would grow upward over the card and the click would land on the dock, so the first tap would
// do nothing but drop focus. Holding the "focused" state for HOLD_MS lets the click finish first. Focus returning in the
// meantime (Enter keeps it in the box) cancels the hold.
export const FOCUS_HOLD_MS = 400;

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const REAL: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

export function createFocusHold(setFocused: (focused: boolean) => void, timers: Timers = REAL, holdMs = FOCUS_HOLD_MS) {
  let pending: unknown = null;
  const cancel = () => {
    if (pending !== null) { timers.clear(pending); pending = null; }
  };
  return {
    focus() { cancel(); setFocused(true); },
    blur() {
      cancel();
      pending = timers.set(() => { pending = null; setFocused(false); }, holdMs);
    },
    // The field is gone (it unmounted, or moved): nothing holds focus any more, so don't wait.
    reset() { cancel(); setFocused(false); },
    cancel,
  };
}
