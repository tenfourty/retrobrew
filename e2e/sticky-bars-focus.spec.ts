import { expect, test, type Page } from '@playwright/test';
import { addTopic, hostMeeting, joinMeeting, NETWORK_WAIT, topicCard } from './helpers';

// docs/product/mvp-screens.md (Accessibility): the page sets scroll-padding from the sticky top bar and the bottom dock, so
// a control reached with the keyboard is never hidden under either. At 360 px wide, in a board long enough to scroll.
const PHONE = { width: 360, height: 640 };
const TOPICS = 14;

interface Clearance { label: string; skipped: boolean; underTop: number; underDock: number; scrolled: number }

// How many pixels of the focused control lie under the sticky top bar and under the dock (0: clear).
// A focusable column taller than the space between the bars cannot clear both, so it is reported as skipped, not judged.
async function clearance(page: Page): Promise<Clearance | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const sticky = document.querySelector('.mtg-sticky');
    const dock = document.querySelector('.mtg-dock');
    if (!el || el === document.body || sticky?.contains(el) || dock?.contains(el)) return null;
    const box = el.getBoundingClientRect();
    const free = window.innerHeight - (sticky?.getBoundingClientRect().height ?? 0) - (dock?.getBoundingClientRect().height ?? 0);
    if (box.width === 0 || box.height === 0) return null;
    const label = `${el.tagName}: ${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 30) ?? ''}`;
    const overlap = (bar: Element | null) => {
      const r = bar?.getBoundingClientRect();
      return r && r.height > 0 ? Math.max(0, Math.min(box.bottom, r.bottom) - Math.max(box.top, r.top)) : 0;
    };
    return { label, skipped: box.height > free, underTop: overlap(sticky), underDock: overlap(dock), scrolled: window.scrollY };
  });
}

// Presses Tab (or Shift+Tab) through the page, noting every control that lands under a bar, and the furthest the page scrolled.
async function walk(page: Page, key: 'Tab' | 'Shift+Tab', steps: number): Promise<{ hidden: string[]; skipped: string[]; stops: number; maxScroll: number; minScroll: number }> {
  const hidden: string[] = [];
  let stops = 0;
  const skipped: string[] = [];
  let maxScroll = 0;
  let minScroll = Infinity;
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(key);
    const c = await clearance(page);
    if (!c) continue;
    maxScroll = Math.max(maxScroll, c.scrolled);
    minScroll = Math.min(minScroll, c.scrolled);
    if (c.skipped) { skipped.push(c.label); continue; }
    stops++;
    if (c.underTop > 0.5) hidden.push(`"${c.label}" is ${c.underTop}px under the top bar`);
    if (c.underDock > 0.5) hidden.push(`"${c.label}" is ${c.underDock}px under the dock`);
  }
  return { hidden, skipped, stops, maxScroll, minScroll };
}

test('at 360 px a control reached by Tab or Shift+Tab is never hidden under the sticky bars', async ({ browser }) => {
  test.slow();
  const hostContext = await browser.newContext({ viewport: PHONE });
  const annContext = await browser.newContext({ viewport: PHONE });
  try {
    const host = await hostContext.newPage();
    const ann = await annContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Sticky bars', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    for (let i = 1; i <= TOPICS; i++) await addTopic(host, `Topic ${String.fromCharCode(64 + i)} to review`);
    await host.getByRole('textbox', { name: 'New topic' }).blur();
    await expect(topicCard(ann, `Topic ${String.fromCharCode(64 + TOPICS)} to review`)).toBeVisible({ timeout: NETWORK_WAIT });
    await host.getByRole('button', { name: 'Start discussion' }).click();
    await expect(host.getByRole('tab', { name: /To discuss/ })).toBeVisible();
    await expect(ann.getByRole('tab', { name: /To discuss/ })).toBeVisible({ timeout: NETWORK_WAIT });

    for (const [who, page] of [['facilitator', host], ['participant', ann]] as const) {
      await page.getByRole('tab', { name: /To discuss/ }).click();
      await expect(topicCard(page, 'Topic A to review')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight * 2), `${who}: the board is long`).toBe(true);
      // The bars' heights reach the page, so the padding has something to use.
      const insets = await page.evaluate(() => {
        const style = document.documentElement.style;
        return { top: parseFloat(style.getPropertyValue('--mtg-top')), bottom: parseFloat(style.getPropertyValue('--mtg-bottom')) };
      });
      expect(insets.top, `${who}: --mtg-top`).toBeGreaterThan(0);
      expect(insets.bottom, `${who}: --mtg-bottom`).toBeGreaterThan(0);

      await page.evaluate(() => window.scrollTo(0, 0));
      await page.getByRole('tab', { name: /To discuss/ }).focus();
      const down = await walk(page, 'Tab', 60);
      expect(down.maxScroll, `${who}: Tab scrolled the board`).toBeGreaterThan(300);
      expect(down.stops, `${who}: Tab visited controls`).toBeGreaterThan(10);
      expect(down.hidden, `${who}: going down`).toEqual([]);
      // Only a tall column may go unjudged: never a topic's button, field or link.
      expect(down.skipped.filter((label) => /^(BUTTON|INPUT|A|TEXTAREA):/.test(label)), `${who}: skipped controls`).toEqual([]);
      expect(down.skipped.length, `${who}: skipped stops`).toBeLessThan(down.stops);

      const up = await walk(page, 'Shift+Tab', 60);
      expect(up.stops, `${who}: Shift+Tab visited controls`).toBeGreaterThan(10);
      expect(up.hidden, `${who}: going up`).toEqual([]);
      expect(up.minScroll, `${who}: Shift+Tab scrolled the board back up`).toBeLessThan(down.maxScroll - 300);
      expect(up.skipped.filter((label) => /^(BUTTON|INPUT|A|TEXTAREA):/.test(label)), `${who}: skipped controls going up`).toEqual([]);
      expect(up.skipped.length, `${who}: skipped stops going up`).toBeLessThan(up.stops);
    }
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});
