import { expect, test, type BrowserContext } from '@playwright/test';
import { APP_PATH, createMeeting, expectNoA11yViolations } from './helpers';

// Desktop Chromium on Linux has no navigator.share; these pin both cases so the test never depends on the platform.
async function withoutNativeShare(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => { delete (Navigator.prototype as { share?: unknown }).share; });
}

async function withNativeShare(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: async (data: ShareData) => { (window as unknown as { __shared: ShareData }).__shared = data; },
    });
  });
}

test('the share step opens after creating, with a QR code and Copy link', async ({ browser }) => {
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  try {
    await withoutNativeShare(context);
    const page = await context.newPage();
    await createMeeting(page, 'Host');
    const sheet = page.getByRole('dialog', { name: 'Invite people' });
    const qr = sheet.getByRole('img', { name: 'QR code for the meeting link' });
    await expect(qr).toBeVisible();
    const box = await qr.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(240);
    expect(box!.height).toBeGreaterThanOrEqual(240);
    await expect(sheet.getByText('Scan to join, or share the link')).toBeVisible();
    await expect(sheet.getByText('Anyone with this link can join and read the meeting. Share it only with the people taking part.')).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Share link' })).toHaveCount(0);
    // The link itself is shown as selectable text, beside Copy and the QR code, without moving initial focus off the buttons.
    const link = sheet.getByRole('textbox', { name: 'Meeting link' });
    await expect(link).toHaveValue(page.url());
    await expect(link).toHaveAttribute('readonly', '');
    await expect(sheet.getByRole('button', { name: 'Copy link' })).toBeFocused();
    await link.click();
    expect(await link.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, page.url().length]);
    await expectNoA11yViolations(page);

    const copy = sheet.getByRole('button', { name: 'Copy link' });
    await expect(copy).toHaveClass(/rb-btn-primary/);
    await copy.click();
    await expect(sheet.getByRole('button', { name: 'Link copied' })).toBeVisible();
    await expect(page.locator('[data-live-region]')).toHaveText('Link copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(page.url());
    await expect(sheet.getByRole('button', { name: 'Copy link' })).toBeVisible({ timeout: 5000 });

    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toHaveCount(0);
    // Wide screens show it in the action bar and in the Facilitator controls; take the bar's.
    const invite = page.getByRole('group', { name: 'Next step' }).getByRole('button', { name: 'Invite people' });
    await invite.click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(invite).toBeFocused();
  } finally {
    await context.close();
  }
});

test('Share link opens the native share sheet where it exists', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    await withNativeShare(context);
    const page = await context.newPage();
    await createMeeting(page, 'Host', 'Friday Lean Coffee');
    const sheet = page.getByRole('dialog', { name: 'Invite people' });
    await expect(sheet.getByRole('button', { name: 'Share link' })).toHaveClass(/rb-btn-primary/);
    await expect(sheet.getByRole('button', { name: 'Copy link' })).toHaveClass(/rb-btn-secondary/);
    await sheet.getByRole('button', { name: 'Share link' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shared?: ShareData }).__shared))
      .toEqual({ title: 'Friday Lean Coffee', text: 'Join my Lean Coffee on Retrobrew', url: page.url() });
  } finally {
    await context.close();
  }
});

test('a refused clipboard shows the link, selected, to copy by hand', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    await withoutNativeShare(context);
    await context.addInitScript(() => {
      Object.defineProperty(Clipboard.prototype, 'writeText', { configurable: true, value: () => Promise.reject(new Error('refused')) });
    });
    const page = await context.newPage();
    await createMeeting(page, 'Host');
    const sheet = page.getByRole('dialog', { name: 'Invite people' });
    const field = sheet.getByRole('textbox', { name: 'Meeting link' });
    // The link is on show before anything is copied, wrapped inside the phone's width.
    await expect(field).toHaveValue(page.url());
    expect(await field.evaluate((el: HTMLTextAreaElement) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await sheet.getByRole('button', { name: 'Copy link' }).click();
    await expect(field).toBeFocused();
    expect(await field.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, page.url().length]);
    const qr = await sheet.getByRole('img', { name: 'QR code for the meeting link' }).boundingBox();
    expect(qr!.width).toBeGreaterThanOrEqual(240);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});

test('a rehearsal meeting opens the share step too and is listed as a rehearsal', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await createMeeting(page, 'Host', 'Practice run', { rehearsal: true });
    const sheet = page.getByRole('dialog', { name: 'Invite people' });
    await expect(sheet.getByRole('img', { name: 'QR code for the meeting link' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await page.goto(APP_PATH);
    await expect(page.getByText('Practice run')).toBeVisible();
    await expect(page.getByText('Rehearsal', { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
