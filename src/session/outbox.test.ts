import { describe, expect, it } from 'vitest';
import { FakeScheduler } from '../test/fake-scheduler';
import { MAX_RESENDS, MAX_RESEND_GAP_MS, MAX_WAIT_MS, Outbox, RESEND_AFTER_MS, type Outgoing } from './outbox';

function setup(hostAlive?: () => boolean) {
  const scheduler = new FakeScheduler(0);
  const sent: number[][] = [];
  const failures: boolean[] = [];
  const outbox = new Outbox<string>({
    scheduler,
    send: (items: Outgoing<string>[]) => sent.push(items.map((i) => i.clientSeq)),
    hostAlive,
    onFailedChange: (failed) => failures.push(failed),
  });
  return { scheduler, sent, failures, outbox };
}

describe('Outbox', () => {
  it('numbers commands from 1 and sends each at once', () => {
    const { outbox, sent } = setup();
    expect(outbox.add('a')).toBe(1);
    expect(outbox.add('b')).toBe(2);
    expect(sent).toEqual([[1], [2]]);
  });

  it('resends every unacknowledged command, oldest first, every 3 s, three times, then fails', () => {
    const { outbox, sent, failures, scheduler } = setup();
    outbox.add('a');
    outbox.add('b');
    scheduler.advance(RESEND_AFTER_MS - 1);
    expect(sent).toHaveLength(2);
    for (let i = 1; i <= MAX_RESENDS; i++) {
      scheduler.advance(RESEND_AFTER_MS);
      expect(sent[sent.length - 1]).toEqual([1, 2]);
    }
    expect(outbox.failed).toBe(false);
    scheduler.advance(RESEND_AFTER_MS);
    expect(outbox.failed).toBe(true);
    expect(failures).toEqual([true]);
    scheduler.advance(60_000);
    expect(sent).toHaveLength(2 + MAX_RESENDS);
  });

  it('stops resending what an ack covers, and keeps the rest', () => {
    const { outbox, sent, scheduler } = setup();
    outbox.add('a');
    outbox.add('b');
    outbox.ack(1);
    scheduler.advance(RESEND_AFTER_MS);
    expect(sent[sent.length - 1]).toEqual([2]);
    outbox.ack(2);
    expect(outbox.unacknowledged).toEqual([]);
    scheduler.advance(60_000);
    expect(scheduler.pending()).toBe(0);
  });

  it('Retry resends from the oldest and starts counting again', () => {
    const { outbox, sent, failures, scheduler } = setup();
    outbox.add('a');
    scheduler.advance(RESEND_AFTER_MS * (MAX_RESENDS + 1));
    expect(outbox.failed).toBe(true);
    outbox.retry();
    expect(outbox.failed).toBe(false);
    expect(sent[sent.length - 1]).toEqual([1]);
    scheduler.advance(RESEND_AFTER_MS * MAX_RESENDS);
    expect(outbox.failed).toBe(false);
    outbox.ack(1);
    expect(failures).toEqual([true, false]);
  });

  it('resends at once for a new host epoch, keeping each clientSeq', () => {
    const { outbox, sent } = setup();
    outbox.add('a');
    outbox.add('b');
    outbox.resendNow();
    expect(sent[sent.length - 1]).toEqual([1, 2]);
  });

  it('ignores an ack below anything pending, and an ack after a failure clears it', () => {
    const { outbox, scheduler } = setup();
    outbox.add('a');
    outbox.ack(0);
    expect(outbox.unacknowledged).toHaveLength(1);
    scheduler.advance(RESEND_AFTER_MS * (MAX_RESENDS + 1));
    expect(outbox.failed).toBe(true);
    outbox.ack(1);
    expect(outbox.failed).toBe(false);
  });

  it('while held, keeps commands in order and sends nothing, then sends them all from 1 on release', () => {
    const { outbox, sent, failures, scheduler } = setup();
    outbox.hold();
    expect(outbox.add('a')).toBe(1);
    expect(outbox.add('b')).toBe(2);
    outbox.resendNow();
    outbox.retry();
    scheduler.advance(10 * RESEND_AFTER_MS);
    expect(sent).toEqual([]);
    expect(failures).toEqual([]);
    outbox.release();
    expect(sent).toEqual([[1, 2]]);
    scheduler.advance(RESEND_AFTER_MS);
    expect(sent).toEqual([[1, 2], [1, 2]]);
  });

  it('a hold stops resends of what was already sent, uncounted, until release', () => {
    const { outbox, sent, scheduler } = setup();
    outbox.add('a');
    outbox.hold();
    scheduler.advance(10 * RESEND_AFTER_MS);
    expect(sent).toEqual([[1]]);
    expect(outbox.failed).toBe(false);
    outbox.release();
    expect(sent).toEqual([[1], [1]]);
  });

  it('a hold clears a failure, so Retry behaves normally afterwards', () => {
    const { outbox, sent, failures, scheduler } = setup();
    outbox.add('a');
    scheduler.advance((MAX_RESENDS + 1) * RESEND_AFTER_MS);
    expect(outbox.failed).toBe(true);
    outbox.hold();
    expect(outbox.failed).toBe(false);
    outbox.release();
    const before = sent.length;
    scheduler.advance((MAX_RESENDS + 1) * RESEND_AFTER_MS);
    expect(sent.length).toBe(before + MAX_RESENDS);
    expect(outbox.failed).toBe(true);
    outbox.retry();
    expect(outbox.failed).toBe(false);
    expect(sent.length).toBe(before + MAX_RESENDS + 1);
    expect(failures).toEqual([true, false, true, false]);
  });

  it('will resend a pending command while resends are left, never in the last resend’s window, once failed or while held', () => {
    const { outbox, scheduler } = setup();
    outbox.add('a');
    expect(outbox.willResend(1)).toBe(true);
    expect(outbox.willResend(2)).toBe(false); // never added
    for (let i = 1; i < MAX_RESENDS; i++) {
      scheduler.advance(RESEND_AFTER_MS);
      expect(outbox.willResend(1)).toBe(true);
    }
    scheduler.advance(RESEND_AFTER_MS); // the last resend: its timer only marks the outbox failed
    expect(outbox.failed).toBe(false);
    expect(outbox.willResend(1)).toBe(false);
    scheduler.advance(RESEND_AFTER_MS);
    expect(outbox.failed).toBe(true);
    expect(outbox.willResend(1)).toBe(false);
    outbox.retry();
    expect(outbox.willResend(1)).toBe(true);
    outbox.hold();
    expect(outbox.willResend(1)).toBe(false);
    outbox.release();
    expect(outbox.willResend(1)).toBe(true);
    outbox.ack(1);
    expect(outbox.willResend(1)).toBe(false);
  });

  it('will not resend while held, even with every resend left', () => {
    const { outbox } = setup();
    outbox.hold();
    outbox.add('a');
    expect(outbox.willResend(1)).toBe(false);
    outbox.release();
    expect(outbox.willResend(1)).toBe(true);
  });

  describe('with the host alive', () => {
    it('keeps resending past three, with the gap doubling to 30 s, and fails only at the two-minute bound', () => {
      const { outbox, sent, failures, scheduler } = setup(() => true);
      outbox.add('a');
      const at: number[] = [];
      let seen = sent.length;
      for (let t = 1; t <= MAX_WAIT_MS + 10_000; t++) {
        scheduler.advance(1000 * 1);
        if (sent.length > seen) at.push(t), (seen = sent.length);
        if (outbox.failed) break;
      }
      // 3, 6, 9 s as ever; then 6, 12, 24 and 30 s apart; the last timer ends the wait at 120 s.
      expect(at.slice(0, 3)).toEqual([3, 6, 9]);
      const gaps = at.slice(3).map((t, i) => t - (i ? at[i + 2] : 9));
      expect(gaps.slice(0, 4)).toEqual([6, 12, 24, 30]);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(MAX_RESEND_GAP_MS / 1000);
      expect(outbox.failed).toBe(true);
      expect(scheduler.now()).toBe(MAX_WAIT_MS);
      expect(failures).toEqual([true]);
      expect(sent.length).toBeLessThan(15);
    });

    it('gives up at the next timer (at most one gap later) once the host is gone', () => {
      let alive = true;
      const { outbox, sent, scheduler } = setup(() => alive);
      outbox.add('a');
      scheduler.advance(3 * RESEND_AFTER_MS);
      alive = false;
      scheduler.advance(2 * RESEND_AFTER_MS);
      expect(outbox.failed).toBe(true);
      expect(sent).toHaveLength(1 + MAX_RESENDS);
    });

    it('an ack that moves things on restarts the count and the two minutes', () => {
      const { outbox, scheduler, sent } = setup(() => true);
      outbox.add('a');
      outbox.add('b');
      scheduler.advance(MAX_WAIT_MS - 1000);
      outbox.ack(1);
      scheduler.advance(MAX_WAIT_MS - 1000);
      expect(outbox.failed).toBe(false);
      expect(sent[sent.length - 1]).toEqual([2]);
      outbox.ack(2);
      scheduler.advance(MAX_WAIT_MS);
      expect(outbox.failed).toBe(false);
    });

    it('Retry after the bound starts a new two minutes', () => {
      const { outbox, scheduler } = setup(() => true);
      outbox.add('a');
      scheduler.advance(MAX_WAIT_MS);
      expect(outbox.failed).toBe(true);
      outbox.retry();
      scheduler.advance(MAX_WAIT_MS - 1000);
      expect(outbox.failed).toBe(false);
      scheduler.advance(1000);
      expect(outbox.failed).toBe(true);
    });

    it('has no resend to come once it has backed off, so a held copy is kept (the next one is more than 3 s away)', () => {
      const { outbox, scheduler } = setup(() => true);
      outbox.add('a');
      scheduler.advance(3 * RESEND_AFTER_MS + 1000);
      expect(outbox.willResend(1)).toBe(false);
      scheduler.advance(MAX_WAIT_MS);
      expect(outbox.failed).toBe(true);
      expect(outbox.willResend(1)).toBe(false);
    });

    it('a new command while backed off gets the three 3 s resends again, with the wait’s end unchanged', () => {
      const { outbox, sent, failures, scheduler } = setup(() => true);
      outbox.add('a');
      scheduler.advance(3 * RESEND_AFTER_MS + 1000); // backed off: next resend 5 s away
      outbox.add('b');
      expect(outbox.willResend(1)).toBe(true);
      expect(outbox.willResend(2)).toBe(true);
      const before = sent.length;
      scheduler.advance(RESEND_AFTER_MS);
      expect(sent.slice(before)).toEqual([[1, 2]]);
      scheduler.advance(2 * RESEND_AFTER_MS);
      expect(sent.length).toBe(before + 3);
      scheduler.advance(MAX_WAIT_MS - scheduler.now());
      expect(failures).toEqual([true]);
      expect(scheduler.now()).toBe(MAX_WAIT_MS + 0);
    });

    it('a timer that fires long after it was due (a locked phone) resends once and counts afresh, never failing', () => {
      const fake = new FakeScheduler(0);
      let skew = 0;
      const scheduler = { now: () => fake.now() + skew, setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout };
      const sent: number[][] = [];
      const outbox = new Outbox<string>({ scheduler, send: (items) => sent.push(items.map((i) => i.clientSeq)), hostAlive: () => true });
      outbox.add('a');
      skew = 5 * MAX_WAIT_MS; // frozen: the clock moves, no timer runs
      fake.advance(RESEND_AFTER_MS);
      expect(outbox.failed).toBe(false);
      expect(sent).toEqual([[1], [1]]);
      fake.advance(RESEND_AFTER_MS);
      expect(sent).toHaveLength(3);
      expect(outbox.failed).toBe(false);
    });

    it('adding a command every 8 s with no ack still fails at two minutes', () => {
      const { outbox, failures, scheduler } = setup(() => true);
      outbox.add('a');
      while (scheduler.now() < 2 * MAX_WAIT_MS && !outbox.failed) {
        scheduler.advance(8000);
        if (!outbox.failed) outbox.add('x');
      }
      expect(failures).toEqual([true]);
      expect(scheduler.now()).toBeLessThanOrEqual(MAX_WAIT_MS + 8000);
    });

    it('a late timer with the host gone gives up instead of restarting the count', () => {
      const fake = new FakeScheduler(0);
      let skew = 0;
      const scheduler = { now: () => fake.now() + skew, setTimeout: fake.setTimeout, clearTimeout: fake.clearTimeout };
      const sent: number[][] = [];
      const outbox = new Outbox<string>({ scheduler, send: (items) => sent.push(items.map((i) => i.clientSeq)), hostAlive: () => false });
      outbox.add('a');
      fake.advance(3 * RESEND_AFTER_MS);
      skew = 10 * RESEND_AFTER_MS;
      fake.advance(RESEND_AFTER_MS);
      expect(outbox.failed).toBe(true);
    });
  });
});
