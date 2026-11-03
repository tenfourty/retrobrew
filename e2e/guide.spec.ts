import { expect, test } from '@playwright/test';

test('/lean-coffee redirects to /lean-coffee/', { tag: '@public' }, async ({ page }) => {
  const response = await page.request.get('/lean-coffee', { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(response.headers().location).toBe('/lean-coffee/');
});

test('the landing page links to the guide, which ends with Start a meeting', { tag: '@public' }, async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: 'New to Lean Coffee? Read the short guide' }).click();
  await expect(page).toHaveURL(/\/lean-coffee\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'How to run a Lean Coffee' })).toBeVisible();
  for (const heading of ['What you need', 'Running it, as the facilitator', 'Taking part', 'Tips']) {
    await expect(page.getByRole('heading', { level: 2, name: heading })).toBeVisible();
  }
  await expect(page.getByRole('main').getByRole('link', { name: 'Start a meeting' })).toHaveAttribute('href', '/app/#start');
});

test('the guide works with JavaScript off', { tag: '@public' }, async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto('/lean-coffee/');
    await expect(page.getByRole('heading', { level: 1, name: 'How to run a Lean Coffee' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Party mode' })).toBeHidden();
  } finally {
    await context.close();
  }
});

test('the guide carries its head metadata', { tag: '@public' }, async ({ page }) => {
  await page.goto('/lean-coffee/');
  await expect(page).toHaveTitle('How to run a Lean Coffee · Retrobrew');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
  const head = page.locator('head');
  const description = 'A short guide to Lean Coffee meetings: collecting topics, voting, timeboxes and deciding when to move on, for facilitators and participants.';
  await expect(head.locator('meta[name="description"]')).toHaveAttribute('content', description);
  await expect(head.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://retrobrew.app/lean-coffee/');
  await expect(head.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://retrobrew.app/lean-coffee/');
  await expect(head.locator('meta[property="og:title"]')).toHaveAttribute('content', 'How to run a Lean Coffee');
  await expect(head.locator('meta[property="og:description"]')).toHaveAttribute('content', description);
  await expect(head.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
});

test('every control on the guide is a 44 px tap target at 360 px', { tag: '@public' }, async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const page = await context.newPage();
  try {
    await page.goto('/lean-coffee/');
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

for (const mode of ['business', 'party']) {
  test(`the guide in ${mode} has no horizontal scroll at 360 px`, { tag: '@public' }, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
    await context.addInitScript((m) => localStorage.setItem('rb-mode', m), mode);
    const page = await context.newPage();
    try {
      await page.goto('/lean-coffee/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', new RegExp(`^${mode}-`));
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBe(0);
    } finally {
      await context.close();
    }
  });
}
