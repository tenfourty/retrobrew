import { afterEach, describe, expect, it, vi } from 'vitest';
import { boardIsHosted, onPageVisible, RESUME_DEBOUNCE_MS } from './browser';

describe('boardIsHosted', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('is true only while some tab holds that board’s host lock', async () => {
    vi.stubGlobal('navigator', { locks: { query: async () => ({ held: [{ name: 'retrobrew-board:b1' }], pending: [] }) } });
    expect(await boardIsHosted('b1')).toBe(true);
    expect(await boardIsHosted('b2')).toBe(false);
  });

  it('is false without the Web Locks API, or when a query fails', async () => {
    vi.stubGlobal('navigator', {});
    expect(await boardIsHosted('b1')).toBe(false);
    vi.stubGlobal('navigator', { locks: { query: async () => { throw new Error('nope'); } } });
    expect(await boardIsHosted('b1')).toBe(false);
  });
});

describe('onPageVisible', () => {
  function page() {
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const win = new EventTarget();
    let clock = 1_000_000;
    const runs: number[] = [];
    const stop = onPageVisible(() => runs.push(clock), { doc, win, now: () => clock });
    const pageshow = (persisted: boolean) => win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
    const visible = () => doc.dispatchEvent(new Event('visibilitychange'));
    return { doc, runs, stop, pageshow, visible, advance: (ms: number) => { clock += ms; } };
  }

  it('runs when the page becomes visible, and not when it is hidden', () => {
    const p = page();
    p.doc.visibilityState = 'hidden';
    p.visible();
    expect(p.runs).toHaveLength(0);
    p.doc.visibilityState = 'visible';
    p.visible();
    expect(p.runs).toHaveLength(1);
  });

  it('acts on pageshow only for a page restored from the back-forward cache', () => {
    const p = page();
    p.pageshow(false);
    expect(p.runs).toHaveLength(0);
    p.pageshow(true);
    expect(p.runs).toHaveLength(1);
  });

  it('runs once for a restore that fires both events, and again a second later', () => {
    const p = page();
    p.pageshow(true);
    p.advance(50);
    p.visible();
    expect(p.runs).toHaveLength(1);
    p.advance(RESUME_DEBOUNCE_MS);
    p.visible();
    expect(p.runs).toHaveLength(2);
  });

  it('stops listening when stopped', () => {
    const p = page();
    p.stop();
    p.visible();
    p.pageshow(true);
    expect(p.runs).toHaveLength(0);
  });
});
