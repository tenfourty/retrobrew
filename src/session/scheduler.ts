// Timers behind an interface, so session tests run on a fake clock.
export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

// A repeating timer. Call the result to stop it.
export function every(scheduler: Scheduler, ms: number, fn: () => void): () => void {
  let handle: unknown;
  let stopped = false;
  const run = () => {
    if (stopped) return;
    handle = scheduler.setTimeout(run, ms);
    fn();
  };
  handle = scheduler.setTimeout(run, ms);
  return () => {
    stopped = true;
    scheduler.clearTimeout(handle);
  };
}

// Host time for views: each value is later than the last, even if the system clock steps back,
// so a participant always sees the host's next view as newer.
export class MonotonicClock {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number) {}

  next(): number {
    this.last = Math.max(this.now(), this.last + 1);
    return this.last;
  }
}
