import { describe, expect, it } from 'vitest';
import { FakeScheduler } from '../test/fake-scheduler';
import { COALESCE_MS, Pacer, REFRESH_MS, RELAY_GAP_MS } from './pacer';

function setup() {
  const scheduler = new FakeScheduler(0);
  const log: string[] = [];
  const pacer = new Pacer({
    scheduler,
    sendDirect: (full) => log.push(`direct${full ? ' full' : ''}@${scheduler.now()}`),
    sendBundle: (full) => log.push(`bundle${full ? ' full' : ''}@${scheduler.now()}`),
  });
  return { scheduler, log, pacer };
}

describe('Pacer', () => {
  it('starts with a full refresh, then refreshes every 5 s with nothing changing', () => {
    const { pacer, log, scheduler } = setup();
    pacer.start();
    scheduler.advance(REFRESH_MS * 2);
    expect(log).toEqual(['direct full@0', 'bundle full@0', 'direct full@5000', 'bundle full@5000', 'direct full@10000', 'bundle full@10000']);
  });

  it('sends the refresh of a resume at once, though a bundle went out in the same instant', () => {
    const { pacer, log, scheduler } = setup();
    pacer.start();
    // A frozen page's overdue refresh timer runs just before its visibility event; that bundle went to a dead socket.
    scheduler.advance(REFRESH_MS);
    log.length = 0;
    pacer.resume();
    expect(log).toEqual(['direct full@5000', 'bundle full@5000']);
    // The cycle restarts from it, and nothing doubles.
    scheduler.advance(REFRESH_MS);
    expect(log).toEqual(['direct full@5000', 'bundle full@5000', 'direct full@10000', 'bundle full@10000']);
  });

  it('sends the refresh of a resume at once when a change bundle waits for its slot', () => {
    const { pacer, log, scheduler } = setup();
    pacer.start();
    scheduler.advance(1000);
    pacer.change();
    scheduler.advance(10);
    pacer.change();
    scheduler.advance(COALESCE_MS);
    log.length = 0;
    pacer.resume();
    scheduler.advance(RELAY_GAP_MS * 2);
    // One full bundle at once, and not the change bundle that was waiting after it.
    expect(log.filter((l) => l.startsWith('bundle'))).toEqual(['bundle full@1160']);
  });

  it('keeps the relay gap on an ordinary refresh', () => {
    const { pacer, log, scheduler } = setup();
    pacer.start();
    scheduler.advance(REFRESH_MS);
    log.length = 0;
    pacer.refresh();
    scheduler.advance(RELAY_GAP_MS);
    expect(log).toEqual(['direct full@5000', 'bundle full@5500']);
  });

  it('flushes the first change at once and coalesces the rest of its 150 ms window into one flush', () => {
    const { pacer, log, scheduler } = setup();
    pacer.start();
    log.length = 0;
    scheduler.advance(1000);
    pacer.change();
    scheduler.advance(10);
    pacer.change();
    pacer.change();
    scheduler.advance(COALESCE_MS + RELAY_GAP_MS);
    expect(log).toEqual(['direct@1000', 'bundle@1000', 'direct@1150', 'bundle@1500']);
  });

  it('keeps relay events at least 500 ms apart and sends only the latest', () => {
    const { pacer, log, scheduler } = setup();
    pacer.start();
    log.length = 0;
    for (let t = 0; t < 2000; t += 50) {
      pacer.change();
      scheduler.advance(50);
    }
    scheduler.advance(1000);
    const bundles = log.filter((l) => l.startsWith('bundle')).map((l) => Number(l.split('@')[1]));
    for (let i = 1; i < bundles.length; i++) expect(bundles[i] - bundles[i - 1]).toBeGreaterThanOrEqual(RELAY_GAP_MS);
    expect(bundles.length).toBeLessThanOrEqual(1 + Math.ceil(3000 / RELAY_GAP_MS));
  });

  it('turns a change bundle that is waiting for a slot when the refresh falls due into the refresh', () => {
    const { pacer, log, scheduler } = setup();
    pacer.start();
    scheduler.advance(4800);
    log.length = 0;
    pacer.change(); // flushes at once: the relay slot is free
    scheduler.advance(100);
    pacer.change(); // flushes at 4950; its bundle waits for the slot at 5300
    scheduler.advance(500);
    expect(log).toEqual(['direct@4800', 'bundle@4800', 'direct@4950', 'direct full@5000', 'bundle full@5300']);
  });

  it('gives a version reply only a slot no bundle needs', () => {
    const { pacer, scheduler } = setup();
    pacer.start();
    expect(pacer.takeSpareSlot()).toBe(false); // the opening refresh just used the slot
    scheduler.advance(RELAY_GAP_MS);
    expect(pacer.takeSpareSlot()).toBe(true);
    expect(pacer.takeSpareSlot()).toBe(false);
    scheduler.advance(RELAY_GAP_MS);
    pacer.change();
    scheduler.advance(10);
    pacer.change();
    scheduler.advance(COALESCE_MS);
    expect(pacer.takeSpareSlot()).toBe(false); // a bundle is waiting for the next slot
  });

  it('sends nothing after stop', () => {
    const { pacer, log, scheduler } = setup();
    pacer.start();
    pacer.stop();
    log.length = 0;
    pacer.change();
    scheduler.advance(REFRESH_MS * 3);
    expect(log).toEqual([]);
    expect(scheduler.pending()).toBe(0);
  });
});
