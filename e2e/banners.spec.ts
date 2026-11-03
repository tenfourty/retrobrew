import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  banner, expectNoA11yViolations, expectNoA11yViolationsInEveryTheme, forceSignals, hostMeeting, joinMeeting, NETWORK_WAIT,
} from './helpers';

// Every banner, its words, its action and its contrast in each tone (docs/product/mvp-screens.md, Connection states
// and banners). The signals are forced (src/app/test-hooks.ts), because most of these states take minutes or a broken
// network to reach. The tone is a class on the banner, so it is checked too; contrast runs in all four themes for one
// banner of each tone and in the current theme for the rest.
async function endMeeting(host: Page): Promise<void> {
  await host.getByRole('complementary', { name: 'Facilitator' }).getByRole('button', { name: 'End meeting' }).click();
  await host.getByRole('dialog', { name: 'End the meeting?' }).getByRole('button', { name: 'End meeting' }).click();
}

const bannerBox = (page: Page, text: string): Locator => page.locator('.mtg-banner .rb-banner', { has: banner(page, text) });

interface Case { force: Record<string, unknown>; text: string; action?: string; tone: 'info' | 'warning' | 'error'; themes?: boolean }

const PARTICIPANT: Case[] = [
  { force: { mismatch: 'reloadThisPage' }, text: 'This meeting was started with a different version of Retrobrew. Reload this page.', action: 'Reload', tone: 'error', themes: true },
  { force: { mismatch: 'askFacilitator' }, text: 'This meeting is running on an older version of Retrobrew. Ask the facilitator to reload their page.', tone: 'error' },
  { force: { connection: 'noRelays' }, text: "Can't reach the meeting network. Check your connection.", tone: 'warning', themes: true },
  { force: { connection: 'hostOffline' }, text: "The facilitator's device is offline. You can still read the board, and it updates when they're back.", tone: 'warning' },
  { force: { pendingFailed: true }, text: "Your last change didn't reach the facilitator.", action: 'Retry', tone: 'error' },
  { force: { staleTab: true }, text: 'This page has been away too long. Reload it to carry on', action: 'Reload', tone: 'error' },
  {
    force: { staleTab: true, staleTabMessage: 'This meeting is open in too many tabs on this device. Reload this page to carry on' },
    text: 'This meeting is open in too many tabs on this device. Reload this page to carry on', action: 'Reload', tone: 'error',
  },
];

const HOST: Case[] = [
  { force: { connection: 'noRelays' }, text: "Can't reach the meeting network. Check your connection.", tone: 'warning', themes: true },
  { force: { saveFailed: true }, text: "This device couldn't save the meeting. Keep this page open and back up the meeting file.", action: 'Back up', tone: 'error', themes: true },
  {
    force: { persistenceRefused: true },
    text: "This browser hasn't promised to keep this meeting. Back up the meeting file when you finish, and don't use a private window.",
    action: 'Dismiss', tone: 'info', themes: true,
  },
  {
    force: { overLimits: true },
    text: "This meeting is bigger than Retrobrew's limits. It runs as normal, but new topics and people can't be added until some topics are deleted.",
    tone: 'warning',
  },
  {
    force: { oversize: true },
    text: "This meeting is too big to send to everyone in one go. It runs as normal, but new topics and people can't be added until some topics are deleted.",
    tone: 'warning',
  },
];

async function expectBanner(page: Page, c: Case): Promise<void> {
  const box = bannerBox(page, c.text);
  await expect(page.locator('.mtg-banner .rb-banner')).toHaveCount(1, { timeout: NETWORK_WAIT });
  await expect(box).toHaveCount(1);
  await expect(box).toHaveClass(new RegExp(`rb-banner-${c.tone}`));
  await expect(box.getByRole('button')).toHaveText(c.action ? [c.action] : []);
  if (c.themes) await expectNoA11yViolationsInEveryTheme(page);
  else await expectNoA11yViolations(page);
}

test('a participant sees each banner with its action, readable in every tone', async ({ browser }) => {
  test.setTimeout(240_000);
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Banner check');
    const ann = await annContext.newPage();
    await joinMeeting(ann, url, 'Ann');
    await expect(ann.locator('.mtg-banner')).toHaveCount(0);
    for (const c of PARTICIPANT) {
      await forceSignals(ann, { participant: c.force });
      await ann.reload();
      await expectBanner(ann, c);
    }
    // The ended banner (info) always wins for a participant, whatever else is forced.
    await endMeeting(host);
    await ann.reload();
    await expectBanner(ann, { force: {}, text: 'Meeting ended', action: 'Copy as text', tone: 'info', themes: true });
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

test('the facilitator sees each banner with its action, readable in every tone', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  try {
    for (const c of HOST) {
      const page = await context.newPage();
      // Headless Chromium may refuse to persist storage; only the persistence case shows that banner.
      await forceSignals(page, { host: { persistenceRefused: false, ...c.force } });
      await hostMeeting(page, 'Hana', 'Banner check');
      await expectBanner(page, c);
      if (c.action === 'Back up') {
        await bannerBox(page, c.text).getByRole('button', { name: 'Back up' }).click();
        await expect(page.getByRole('dialog', { name: 'Back up meeting file' })).toBeVisible();
        await page.keyboard.press('Escape');
      }
      await page.close();
    }
  } finally {
    await context.close();
  }
});
