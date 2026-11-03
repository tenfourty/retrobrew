import type { Scheduler } from './scheduler';

// A token bucket for one sender's relay events: `capacity` at once, then one more every `refillMs`. Public relays
// refuse a connection's events beyond a small burst (relay.damus.io: 6, then 3 a second), so a participant with many
// commands to resend spreads them out instead of being refused and then banned.
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private waiting: Promise<void> = Promise.resolve();

  constructor(private readonly scheduler: Scheduler, private readonly capacity: number, private readonly refillMs: number) {
    this.tokens = capacity;
    this.updatedAt = scheduler.now();
  }

  // Resolves when the next event may go, in the order take() was called.
  take(): Promise<void> {
    const turn = this.waiting.then(() => this.next());
    this.waiting = turn;
    return turn;
  }

  private refill(): void {
    const now = this.scheduler.now();
    const earned = Math.floor((now - this.updatedAt) / this.refillMs);
    if (earned <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + earned);
    this.updatedAt = this.tokens === this.capacity ? now : this.updatedAt + earned * this.refillMs;
  }

  private async next(): Promise<void> {
    this.refill();
    while (this.tokens < 1) {
      const wait = this.updatedAt + this.refillMs - this.scheduler.now();
      await new Promise<void>((resolve) => this.scheduler.setTimeout(resolve, Math.max(0, wait)));
      this.refill();
    }
    // Refill counts from the first token taken out of a full bucket, never from an earlier idle moment.
    if (this.tokens === this.capacity) this.updatedAt = this.scheduler.now();
    this.tokens -= 1;
  }
}
