export interface ClockSample {
  offset: number;
  rtt: number;
}

const MAX_SAMPLES = 8;
// The direct estimate wins while its newest pong is this recent (docs/product/sync-protocol.md, The clock offset).
const DIRECT_FRESH_MS = 30_000;

// t0: local send time; t1: host clock when it answered; t3: local receive time.
export function sampleFrom(t0: number, t1: number, t3: number): ClockSample {
  return { offset: t1 - (t0 + t3) / 2, rtt: t3 - t0 };
}

function pushCapped<T>(list: T[], value: T): void {
  list.push(value);
  if (list.length > MAX_SAMPLES) list.shift();
}

// Host time = local time + offset. The host's clock is the source of truth for timers.
export class ClockSync {
  private readonly samples: ClockSample[] = [];
  private readonly leads: number[] = []; // hostNow − receivedAt of relay views
  private readonly echoes: number[] = []; // relay latency of our own echoed pings
  private lastPongAt = Number.NEGATIVE_INFINITY;

  addSample(t0: number, t1: number, t3: number): void {
    if (![t0, t1, t3].every(Number.isFinite) || t3 - t0 < 0) return;
    pushCapped(this.samples, sampleFrom(t0, t1, t3));
    this.lastPongAt = t3;
  }

  addRelayView(hostNow: number, receivedAt: number): void {
    if (!Number.isFinite(hostNow) || !Number.isFinite(receivedAt)) return;
    pushCapped(this.leads, hostNow - receivedAt);
  }

  // Forgets every reading: a new host session has a clock of its own.
  reset(): void {
    this.samples.length = 0;
    this.leads.length = 0;
    this.echoes.length = 0;
    this.lastPongAt = Number.NEGATIVE_INFINITY;
  }

  // Whether any reading has been taken, direct or relayed.
  get hasEstimate(): boolean {
    return this.samples.length > 0 || this.leads.length > 0;
  }

  addEcho(latencyMs: number): void {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) return;
    pushCapped(this.echoes, latencyMs);
  }

  offsetAt(localNow: number): number {
    if (this.samples.length && localNow - this.lastPongAt <= DIRECT_FRESH_MS) return this.directOffset();
    if (this.leads.length) return this.relayOffset();
    return this.samples.length ? this.directOffset() : 0;
  }

  // Ignores the 30 s freshness rule; offsetAt applies it.
  get offset(): number {
    if (this.samples.length) return this.directOffset();
    return this.leads.length ? this.relayOffset() : 0;
  }

  hostNow(localNow: number): number {
    return localNow + this.offsetAt(localNow);
  }

  // The sample with the shortest round trip is the least distorted.
  private directOffset(): number {
    return this.samples.reduce((best, s) => (s.rtt < best.rtt ? s : best)).offset;
  }

  // The least delayed view, plus half the quickest echo as its transit time.
  private relayOffset(): number {
    const transit = this.echoes.length ? Math.min(...this.echoes) / 2 : 0;
    return Math.max(...this.leads) + transit;
  }
}

export function remainingMs(endsAt: number, hostNow: number): number {
  return Math.max(0, endsAt - hostNow);
}
