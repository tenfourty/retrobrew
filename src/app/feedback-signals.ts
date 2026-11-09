import type { TroubleLatch } from '../feedback/trouble';

/** What a page tells the trouble latch about itself. */
export interface TroubleSignals {
  /** The meeting could not start on this device. */
  startup?: boolean;
  /** A save failed. */
  save?: boolean;
  /** The connection is lost and counts at once (a participant's connecting panel at its 60 s stage). */
  connectionNow?: boolean;
  /** The relays are lost; counts only if they stay lost for the latch delay. */
  connectionAfterDelay?: boolean;
}

/** Applies the connection signals to the latch: the immediate signal takes over from the delayed one. */
export function applyConnection(latch: TroubleLatch, now: boolean, afterDelay: boolean, delayMs: number): void {
  if (now) {
    latch.clear('connection');
    latch.set('connection', true);
  } else if (afterDelay) {
    latch.set('connection', true, delayMs);
  } else {
    latch.clear('connection');
  }
}
