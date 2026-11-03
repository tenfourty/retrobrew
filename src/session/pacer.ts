import type { Scheduler } from './scheduler';

// docs/product/sync-protocol.md, Coalescing and the send budget.
export const COALESCE_MS = 150;
export const RELAY_GAP_MS = 500; // 2 events a second per relay
export const REFRESH_MS = 5000;

// Paces everything the host sends. A change flushes at once after a quiet spell, and otherwise at the end of its
// 150 ms window. Each flush sends direct snapshots straight away and asks for a relay bundle, which goes out in the
// next free relay slot, at least 500 ms after the previous one. Only the latest is sent: what goes out is built
// at send time, so intermediate states are skipped, never queued. A full refresh goes out every 5 s whatever
// happens, and a change bundle that is due in the same slot becomes that refresh.
export class Pacer {
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  private flushTimer: unknown = null;
  private lastRelayAt = Number.NEGATIVE_INFINITY;
  private relayTimer: unknown = null;
  private relayWanted: 'change' | 'full' | null = null;
  private refreshTimer: unknown = null;
  private running = false;

  constructor(private readonly o: {
    scheduler: Scheduler;
    // Direct snapshots, now. full: to every direct peer, as part of a refresh.
    sendDirect(full: boolean): void;
    // One relay bundle, now. full: with every entry.
    sendBundle(full: boolean): void;
  }) {}

  // Sends a full refresh now and every 5 s after.
  start(): void {
    this.running = true;
    this.refresh();
  }

  stop(): void {
    this.running = false;
    for (const timer of [this.flushTimer, this.relayTimer, this.refreshTimer]) if (timer !== null) this.o.scheduler.clearTimeout(timer);
    this.flushTimer = this.relayTimer = this.refreshTimer = null;
    this.relayWanted = null;
  }

  // Something in the views changed.
  change(): void {
    if (!this.running || this.flushTimer !== null) return;
    const wait = this.lastFlushAt + COALESCE_MS - this.o.scheduler.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.flushTimer = this.o.scheduler.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, wait);
  }

  // A full refresh now (after a resume, for example), and the 5 s cycle restarts from it.
  refresh(): void {
    if (!this.running) return;
    this.o.sendDirect(true);
    this.wantRelay('full');
  }

  // A version reply may use a relay slot only if no bundle needs it. Returns whether it may send now;
  // a refused reply is dropped, not queued.
  takeSpareSlot(): boolean {
    if (!this.running || this.relayWanted !== null || this.relayTimer !== null) return false;
    const now = this.o.scheduler.now();
    if (now - this.lastRelayAt < RELAY_GAP_MS) return false;
    this.lastRelayAt = now;
    return true;
  }

  private flush(): void {
    this.lastFlushAt = this.o.scheduler.now();
    this.o.sendDirect(false);
    this.wantRelay('change');
  }

  private wantRelay(kind: 'change' | 'full'): void {
    if (this.relayWanted !== 'full') this.relayWanted = kind;
    if (this.relayTimer !== null) return;
    const wait = this.lastRelayAt + RELAY_GAP_MS - this.o.scheduler.now();
    if (wait <= 0) {
      this.sendRelay();
      return;
    }
    this.relayTimer = this.o.scheduler.setTimeout(() => {
      this.relayTimer = null;
      this.sendRelay();
    }, wait);
  }

  private sendRelay(): void {
    const full = this.relayWanted === 'full';
    this.relayWanted = null;
    this.lastRelayAt = this.o.scheduler.now();
    this.o.sendBundle(full);
    if (full) this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) this.o.scheduler.clearTimeout(this.refreshTimer);
    this.refreshTimer = this.o.scheduler.setTimeout(() => {
      this.refreshTimer = null;
      this.refresh();
    }, REFRESH_MS);
  }
}
