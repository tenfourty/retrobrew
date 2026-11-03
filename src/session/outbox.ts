import type { Scheduler } from './scheduler';

// docs/product/sync-protocol.md, Retries, on the participant.
export const RESEND_AFTER_MS = 3000;
export const MAX_RESENDS = 3;
// Past MAX_RESENDS the outbox keeps resending only while the host is known to be alive (a busy host is slow, not gone),
// with the gap doubling from 6 s up to 30 s, and gives up for good when nothing has been acknowledged for MAX_WAIT_MS.
export const MAX_RESEND_GAP_MS = 30_000;
export const MAX_WAIT_MS = 120_000;

export interface Outgoing<C> {
  clientSeq: number;
  cmd: C;
}

// A tab's unacknowledged commands. clientSeq starts at 1 for every tab, and every resend sends them all,
// oldest first, so the host can fill any gap. Any ack that moves things on restarts the count.
export class Outbox<C> {
  private nextSeq = 1;
  private pending: Outgoing<C>[] = [];
  private resends = 0;
  // When the count last started: the first send, or the latest ack, Retry or release. MAX_WAIT_MS runs from here.
  private since = 0;
  private timer: unknown = null;
  private dueAt = 0; // when the armed timer is due
  private isFailed = false;
  // Held: commands are kept, in order, but nothing is sent or resent until release (src/session/participant.ts holds
  // the outbox until a view lists this person as an attendee).
  private held = false;

  constructor(private readonly o: {
    scheduler: Scheduler;
    // resend: these are copies of commands already sent (all of the pending ones), not a fresh command.
    send(items: Outgoing<C>[], resend: boolean): void;
    onFailedChange?(failed: boolean): void;
    // Whether the host is known to be alive. Without it, or while it says no, the outbox gives up after MAX_RESENDS.
    hostAlive?(): boolean;
  }) {}

  get failed(): boolean {
    return this.isFailed;
  }

  get unacknowledged(): readonly Outgoing<C>[] {
    return this.pending;
  }

  get isHeld(): boolean {
    return this.held;
  }

  // Whether this command is still pending and its next resend is due within RESEND_AFTER_MS: not held or failed, and
  // with some of the three 3 s resends left. Past them the next resend can be 30 s away, longer than the host's gap rule
  // (GAP_REFUSE_MS) waits, so the relay transport must keep a held copy then (it is lasting); a new command pulls the
  // timer back to 3 s (add).
  willResend(clientSeq: number): boolean {
    if (this.held || this.isFailed || this.resends >= MAX_RESENDS) return false;
    return this.pending.some((item) => item.clientSeq === clientSeq);
  }

  private canResend(): boolean {
    const inWait = this.o.scheduler.now() - this.since < MAX_WAIT_MS;
    return inWait && (this.resends < MAX_RESENDS || this.o.hostAlive?.() === true);
  }

  // Stop sending: whatever is unacknowledged stays pending, uncounted and not failed, until release.
  hold(): void {
    if (this.held) return;
    this.held = true;
    this.disarm();
    this.setFailed(false); // the count starts afresh on release, so Retry behaves as usual after it
  }

  // Send everything pending again, from the oldest, and start counting afresh.
  release(): void {
    if (!this.held) return;
    this.held = false;
    this.restart();
    this.setFailed(false);
    if (this.pending.length) this.resendAll();
  }

  add(cmd: C): number {
    const item = { clientSeq: this.nextSeq++, cmd };
    if (this.pending.length === 0) this.since = this.o.scheduler.now();
    this.pending.push(item);
    if (this.held) return item.clientSeq;
    // Backed off: the new command gets the three 3 s resends the host's gap rule assumes (the wait's end is unchanged).
    if (this.resends >= MAX_RESENDS && !this.isFailed) {
      this.resends = 0;
      this.disarm();
    }
    this.o.send([item], false);
    this.arm();
    return item.clientSeq;
  }

  ack(clientSeq: number): void {
    const before = this.pending.length;
    this.pending = this.pending.filter((item) => item.clientSeq > clientSeq);
    if (this.pending.length === before) return;
    this.restart();
    this.setFailed(false);
    this.disarm();
    this.arm();
  }

  // Retry, after a failure: resend everything from the oldest and start counting again.
  retry(): void {
    if (this.held) return;
    this.restart();
    this.setFailed(false);
    this.resendAll();
  }

  // A new host epoch: send everything again now (sealed with the new epoch by `send`). Not counted as a retry.
  resendNow(): void {
    if (this.pending.length && !this.held) this.resendAll();
  }

  stop(): void {
    this.disarm();
  }

  private restart(): void {
    this.resends = 0;
    this.since = this.o.scheduler.now();
  }

  // 3 s until the third resend, then 6, 12, 24 and 30 s, never past the wait's end.
  private nextDelay(): number {
    const backoff = Math.min(RESEND_AFTER_MS * 2 ** Math.max(0, this.resends - MAX_RESENDS + 1), MAX_RESEND_GAP_MS);
    if (!this.canResend() || this.resends < MAX_RESENDS) return RESEND_AFTER_MS; // the old 3 s, so a gone host is given up on soon
    return Math.max(1, Math.min(backoff, this.since + MAX_WAIT_MS - this.o.scheduler.now()));
  }

  private resendAll(): void {
    this.disarm();
    this.o.send([...this.pending], true);
    this.arm();
  }

  private arm(): void {
    if (this.timer !== null || this.isFailed || this.held || this.pending.length === 0) return;
    const delay = this.nextDelay();
    this.dueAt = this.o.scheduler.now() + delay;
    this.timer = this.o.scheduler.setTimeout(() => {
      this.timer = null;
      this.onTimeout();
    }, delay);
  }

  private disarm(): void {
    if (this.timer !== null) this.o.scheduler.clearTimeout(this.timer);
    this.timer = null;
  }

  private onTimeout(): void {
    if (this.pending.length === 0) return;
    // The timer fired long after it was due: this page was suspended (a locked phone). The wait says nothing about the
    // host, so send everything once more and count afresh, as a resume would.
    if (this.o.scheduler.now() - this.dueAt > RESEND_AFTER_MS && this.o.hostAlive?.() !== false) {
      this.restart();
      this.resendAll();
      return;
    }
    if (!this.canResend()) {
      this.setFailed(true);
      return;
    }
    this.resends += 1;
    this.resendAll();
  }

  private setFailed(failed: boolean): void {
    if (failed === this.isFailed) return;
    this.isFailed = failed;
    this.o.onFailedChange?.(failed);
  }
}
