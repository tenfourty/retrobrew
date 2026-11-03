import type { Scheduler } from '../session/scheduler';

// A clock for tests that only moves when told to. Timers run in time order, and a timer that falls due
// during advance() runs with now() at its own due time.
export class FakeScheduler implements Scheduler {
  private time: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 1_000_000) {
    this.time = start;
  }

  now = (): number => this.time;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at > end) continue;
        if (!due || entry[1].at < due[1].at || (entry[1].at === due[1].at && entry[0] < due[0])) due = entry;
      }
      if (!due) break;
      this.timers.delete(due[0]);
      this.time = due[1].at;
      due[1].fn();
    }
    this.time = end;
  }

  pending(): number {
    return this.timers.size;
  }
}
