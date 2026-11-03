import { expect, test, type BrowserContext } from '@playwright/test';
import { banner, expectNoA11yViolations, hostMeeting, joinMeeting, NETWORK_WAIT, openPeople } from './helpers';

const PERSIST = "This browser hasn't promised to keep this meeting. Back up the meeting file when you finish, and don't use a private window.";

// Headless Chromium's answer to navigator.storage.persist() varies; pin it.
async function persistence(context: BrowserContext, granted: boolean): Promise<void> {
  await context.addInitScript((value) => {
    Object.defineProperty(StorageManager.prototype, 'persist', { configurable: true, value: async () => value });
  }, granted);
}

test('the host and a participant share one frame, each with their own guide line', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    await persistence(hostContext, false);
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Frame check', { rehearsal: true });
    await expect(host.getByRole('heading', { level: 1, name: 'Frame check' })).toBeVisible();
    await expect(host.getByText('Rehearsal', { exact: true })).toBeVisible();
    await expect(host.getByText('Invite people, add topics and vote. Start the discussion when the votes are in')).toBeVisible();
    await expect(host.getByText('This meeting runs on this device. Keep this page open.')).toBeVisible();
    await expect(host.getByRole('link', { name: 'How Lean Coffee works' })).toHaveAttribute('target', '_blank');
    await expect(banner(host, PERSIST)).toBeVisible();
    await expect(host.locator('[data-live-region]')).toContainText(PERSIST);
    await host.getByRole('button', { name: 'Dismiss' }).click();
    await expect(banner(host, PERSIST)).toHaveCount(0);
    await expect(host.getByText('3 votes left')).toBeVisible();

    const guest = await guestContext.newPage();
    await joinMeeting(guest, url, 'Ann');
    await expect(host.getByRole('button', { name: '2 here' })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(guest.getByText("Add topics you'd like to talk about, then spend your 3 votes")).toBeVisible();
    await expect(guest.getByText('This meeting runs on this device. Keep this page open.')).toHaveCount(0);
    await expect(guest.getByText('Rehearsal', { exact: true })).toBeVisible();
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});

test('the People sheet lists who is here and holds this device’s settings', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    await persistence(hostContext, true);
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana');
    const guest = await guestContext.newPage();
    await joinMeeting(guest, url, 'Ann');

    // Phones keep the mode switch in the People sheet; wide screens keep it in the top bar.
    await expect(host.getByRole('switch', { name: 'Party mode' })).toBeVisible();
    await expect(guest.getByRole('switch', { name: 'Party mode' })).toHaveCount(0);
    const sheet = await openPeople(guest);
    await expect(sheet.getByRole('listitem').filter({ hasText: 'Ann (you)' })).toBeVisible();
    await expect(sheet.getByRole('listitem').filter({ hasText: 'Hana' })).toContainText('Facilitator');
    await expect(sheet.getByRole('switch', { name: 'Party mode' })).toBeVisible();
    const guestSound = sheet.getByRole('switch', { name: 'Play the timer sound on this device' });
    await expect(guestSound).toHaveAttribute('aria-checked', 'false');
    await guestSound.click();
    await expect(guestSound).toHaveAttribute('aria-checked', 'true');
    expect(await guest.evaluate(() => localStorage.getItem('rb-sound'))).toBe('on');
    await expectNoA11yViolations(guest);
    await guest.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(guest.getByRole('button', { name: '2 here' })).toBeFocused();

    const hostSheet = await openPeople(host);
    await expect(hostSheet.getByRole('listitem').filter({ hasText: 'Ann' })).toContainText(/Direct|Through relays/, { timeout: NETWORK_WAIT });
    await expect(hostSheet.getByRole('listitem').filter({ hasText: 'Hana (you)' })).not.toContainText(/Direct|Through relays|Offline/);
    await expect(hostSheet.getByRole('switch', { name: 'Play the timer sound on this device' })).toHaveAttribute('aria-checked', 'true');
    await hostSheet.getByText('Connection details').click();
    await expect(hostSheet.getByText(/^Refused by relays: \d+$/)).toBeVisible();
    await expect(hostSheet.getByText(/^Relay notices: \d+$/)).toBeVisible();
    await expect(hostSheet.getByText(/^Oversize events/)).toHaveCount(0);
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
