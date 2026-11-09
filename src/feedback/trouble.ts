// The trouble latch: which of the app's four kinds of trouble are on, since when. The report carries the most specific one;
// the views will use it to make "Send feedback" the loudest thing on the page.
import { TROUBLE_SOURCES, type TroubleSource } from './schema';

/** The relays must stay lost this long before it counts as trouble (docs/product/feedback.md). */
export const CONNECTION_DELAY_MS = 30_000;

export interface Trouble { source: TroubleSource; forSeconds: number }

const MAX_SECONDS = 86_400;

export class TroubleLatch {
  private readonly since = new Map<TroubleSource, number>();
  private readonly pending = new Map<TroubleSource, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();

  /**
   * Turns a source on or off. Turning it on with a delay raises it only if it is still on when the delay ends; reporting
   * the same condition again neither restarts the delay nor raises it twice.
   */
  set(source: TroubleSource, active: boolean, delayMs = 0): void {
    if (!active) {
      this.cancel(source);
      if (this.since.delete(source)) this.notify();
      return;
    }
    if (this.since.has(source) || this.pending.has(source)) return;
    if (delayMs <= 0) { this.start(source); return; }
    this.pending.set(source, setTimeout(() => {
      this.pending.delete(source);
      this.start(source);
    }, delayMs));
  }

  /** An uncaught error stays on until the page reloads or the person sends feedback. */
  raise(source: TroubleSource): void {
    this.set(source, true);
  }

  clear(source: TroubleSource): void {
    this.set(source, false);
  }

  /** Whether one source is on now (a delayed source is not on until its delay has passed). */
  has(source: TroubleSource): boolean {
    return this.since.has(source);
  }

  /** The most specific trouble now (start-up, then save, then connection, then error), or null. */
  current(): Trouble | null {
    for (const source of TROUBLE_SOURCES) {
      const at = this.since.get(source);
      if (at !== undefined) return { source, forSeconds: Math.min(MAX_SECONDS, Math.max(0, Math.floor((Date.now() - at) / 1000))) };
    }
    return null;
  }

  /** Called whenever a source switches on or off. Returns the function that stops it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(): void {
    for (const source of [...this.pending.keys()]) this.cancel(source);
    this.since.clear();
    this.listeners.clear();
  }

  private start(source: TroubleSource): void {
    this.since.set(source, Date.now());
    this.notify();
  }

  private cancel(source: TroubleSource): void {
    const timer = this.pending.get(source);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pending.delete(source);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
