import { expect, test } from '@playwright/test';
import { APP_PATH, hostMeeting } from './helpers';

// A share link from before the app moved, in the shape buildShareLink writes.
const OLD_FRAGMENT = '#b=AAAAAAAAAAAAAAAAAAAAAA&k=BBBB&h=CCCC';

test('an old /#b= share link moves to the app with its fragment', { tag: '@public' }, async ({ page }) => {
  await page.goto(`/${OLD_FRAGMENT}`);
  await page.waitForURL((url) => url.pathname === APP_PATH);
  expect(new URL(page.url()).hash).toBe(OLD_FRAGMENT);
});

test('an old /#k=…&b=… share link moves to the app with its fragment', { tag: '@public' }, async ({ page }) => {
  await page.goto('/#k=x&b=y');
  await page.waitForURL((url) => url.pathname === APP_PATH);
  expect(new URL(page.url()).hash).toBe('#k=x&b=y');
});

test('/#start on the landing page stays on the landing page', { tag: '@public' }, async ({ page }) => {
  await page.goto('/#start');
  await expect(page.getByRole('heading', { level: 1, name: 'Let the room set the agenda' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('a facilitator reopening a pre-move /#b= link gets their meeting back', { tag: '@public' }, async ({ page }) => {
  const url = new URL(await hostMeeting(page, 'Host'));
  expect(url.pathname).toBe(APP_PATH);
  await page.goto(`/${url.hash}`);
  await page.waitForURL((u) => u.pathname === APP_PATH && u.hash === url.hash);
  await expect(page.getByRole('textbox', { name: 'New topic' })).toBeVisible();
});

test('an in-page anchor on the landing page stays put', { tag: '@public' }, async ({ page }) => {
  await page.goto('/#faq');
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe('/');
});

test('/app redirects to /app/ and keeps the fragment', { tag: '@public' }, async ({ page }) => {
  const response = await page.request.get('/app', { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(response.headers().location).toBe('/app/');
  await page.goto('/app#start');
  expect(new URL(page.url()).pathname).toBe('/app/');
  await expect(page.getByRole('textbox', { name: 'Meeting name' })).toBeFocused();
});

test('Start a meeting on the landing page lands in the create form', { tag: '@public' }, async ({ page }) => {
  await page.goto('/');
  await page.getByRole('main').getByRole('link', { name: 'Start a meeting' }).click();
  await page.waitForURL((url) => url.pathname === APP_PATH && url.hash === '#start');
  await expect(page.getByRole('textbox', { name: 'Meeting name' })).toBeFocused();
});

test('the app home links back to the landing page and the guide', { tag: '@public' }, async ({ page }) => {
  await page.goto(APP_PATH);
  await expect(page.getByRole('link', { name: 'Retrobrew' })).toHaveAttribute('href', '/');
  await expect(page.getByRole('link', { name: 'How Lean Coffee works' })).toHaveAttribute('href', '/lean-coffee/');
  await expect(page.getByRole('heading', { name: 'Your meetings' })).toBeVisible();
});

test('the FAQ states the shared relays and per-device votes', { tag: '@public' }, async ({ page }) => {
  await page.goto('/');
  await page.getByText('What do the relays see?').click();
  await expect(page.getByText("Everyone in a meeting connects through the same built-in relays. A modified copy of Retrobrew set up with other relays can't change that for the people who join, because the meeting link carries no relay choice.")).toBeVisible();
  await expect(page.getByText('Votes count per device, not per person, because there are no accounts: someone who joins from two devices gets a full set of votes on each.')).toBeVisible();
});

// The steps, reasons and questions themselves are pinned to the spec by src/site-copy.test.ts; here only that
// the browser exposes each section as a named region (the aria-labelledby wiring).
test('the landing page sections are named regions', { tag: '@public' }, async ({ page }) => {
  await page.goto('/');
  for (const name of ['How Lean Coffee works', 'Why Retrobrew', 'Questions']) {
    await expect(page.getByRole('region', { name })).toBeVisible();
  }
});

test('the landing page works with JavaScript off', { tag: '@public' }, async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, colorScheme: 'dark' });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Let the room set the agenda' })).toBeVisible();
    await expect(page.getByRole('main').getByRole('link', { name: 'Start a meeting' })).toHaveAttribute('href', '/app/#start');
    await expect(page.getByRole('switch', { name: 'Party mode' })).toBeHidden();
    const answer = page.getByText('On the facilitator\'s device. The meeting is stored');
    await expect(answer).toBeHidden();
    await page.getByText('Where is my data?').click();
    await expect(answer).toBeVisible();
    // Dark mode comes from the tokens' prefers-color-scheme fallback, with no data-theme set.
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe('rgb(17, 23, 38)');
  } finally {
    await context.close();
  }
});

test('the mode switch picks up the app\'s stored Party choice', { tag: '@public' }, async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('rb-mode', 'party'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^party-/);
  const modeSwitch = page.getByRole('switch', { name: 'Party mode' });
  await expect(modeSwitch).toHaveAttribute('aria-checked', 'true');
  await modeSwitch.click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^business-/);
  expect(await page.evaluate(() => localStorage.getItem('rb-mode'))).toBe('business');
});

test('the landing page still works when the browser blocks storage', { tag: '@public' }, async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^business-/);
  await page.getByRole('switch', { name: 'Party mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', /^party-/);
  expect(errors).toEqual([]);
});

// The head tags are pinned to the spec by src/site-copy.test.ts; here only what needs a server.
test('the landing page serves its icons and carries the build version', { tag: '@public' }, async ({ page }) => {
  await page.goto('/');
  for (const icon of ['favicon.svg', 'favicon.png', 'apple-touch-icon.png', 'og.png']) {
    expect((await page.request.get(`/${icon}`)).status(), icon).toBe(200);
  }
  const version = page.getByRole('contentinfo').getByRole('link', { name: /^Version / });
  await expect(version).toHaveAttribute('href', '/version.txt');
  await expect(version).toHaveText(/^Version [0-9a-z]+$/);
});

test('the app page is titled Retrobrew and kept out of search', { tag: '@public' }, async ({ page }) => {
  await page.goto(APP_PATH);
  await expect(page).toHaveTitle('Retrobrew');
  await expect(page.locator('head meta[name="robots"]')).toHaveAttribute('content', 'noindex');
});

for (const path of ['/', APP_PATH]) {
  for (const mode of ['business', 'party']) {
    test(`${path} in ${mode} has no horizontal scroll at 360 px`, { tag: '@public' }, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
      await context.addInitScript((m) => localStorage.setItem('rb-mode', m), mode);
      const page = await context.newPage();
      try {
        await page.goto(path);
        await expect(page.locator('html')).toHaveAttribute('data-theme', new RegExp(`^${mode}-`));
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBe(0);
      } finally {
        await context.close();
      }
    });
  }
}

test('every control on the landing page is a 44 px tap target at 360 px', { tag: '@public' }, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  try {
    await page.goto('/');
    await page.evaluate(() => document.fonts.ready);
    // Links inside a sentence are exempt (WCAG 2.5.8); everything else people tap must be 44 by 44 px.
    const small = await page.evaluate(() => [...document.querySelectorAll('a, button, summary')]
      .filter((el) => el.getClientRects().length > 0 && !(el.closest('p') && !el.classList.contains('site-link')))
      .map((el) => ({ el, box: el.getBoundingClientRect() }))
      .filter(({ box }) => box.height < 44 || box.width < 44)
      .map(({ el, box }) => `${el.tagName.toLowerCase()} "${el.textContent?.trim()}" ${Math.round(box.width)}×${Math.round(box.height)}`));
    expect(small).toEqual([]);
  } finally {
    await context.close();
  }
});

test('at 360 px the top bar keeps a 44 px Start a meeting and moves Your meetings out', { tag: '@public' }, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  try {
    await page.goto('/');
    const top = page.getByRole('navigation', { name: 'Main' });
    const box = await top.getByRole('link', { name: 'Start a meeting' }).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await expect(top.getByRole('link', { name: 'Your meetings' })).toBeHidden();
    await expect(page.getByRole('main').getByRole('link', { name: 'Your meetings' })).toBeVisible();
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'Your meetings' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the time-up illustration shows the three choices, the totals and the turnout the app offers', { tag: '@public' }, async ({ page }) => {
  await page.goto('/');
  const panel = page.locator('.site-illo .rb-timeup');
  await expect(panel.locator('.rb-choices .rb-choice')).toHaveText(['Keep going', 'No preference', 'Move on']);
  await expect(panel.locator('.rb-timeup-totals')).toHaveText('Keep going 4 · No preference 1 · Move on 2');
  await expect(panel).toContainText('7 voted · 8 here');
});
