import { expect, test, type Page } from '@playwright/test';
import { APP_PATH, expectNoA11yViolations, expectTapTargets, hostMeeting, joinMeeting, NETWORK_WAIT } from './helpers';

const row = (page: Page, meeting: string) => page.getByRole('listitem').filter({ hasText: meeting });

test('a guest’s Your meetings lists the meeting they joined, and the entry rejoins through the link', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Guest list check');
    const ann = await annContext.newPage();
    await joinMeeting(ann, url, 'Ann');

    // A fresh tab on the same device lists it, with the name Ann joined under and what rejoining needs.
    const home = await annContext.newPage();
    await home.goto(APP_PATH);
    const entry = row(home, 'Guest list check');
    await expect(entry.getByText('Joined', { exact: true })).toBeVisible();
    await expect(entry.getByText('Joined as Ann. Opens while the facilitator is running it')).toBeVisible();
    await expectNoA11yViolations(home);
    await expectTapTargets(home);

    // The entry's link is the share link, and rejoining through it skips the join form.
    await expect(entry.getByRole('link', { name: 'Guest list check' })).toHaveAttribute('href', url);
    await entry.getByRole('link', { name: 'Guest list check' }).click();
    await expect(home.getByRole('textbox', { name: 'New topic' })).toBeVisible({ timeout: NETWORK_WAIT });
  } finally {
    await hostContext.close();
    await annContext.close();
  }
});

test('Remove on a joined meeting asks first with Cancel focused, then forgets the entry and the name', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Forget me');
    const ann = await annContext.newPage();
    await joinMeeting(ann, url, 'Ann');
    const home = await annContext.newPage();
    await home.goto(APP_PATH);

    await row(home, 'Forget me').getByRole('button', { name: 'Remove Forget me' }).click();
    const dialog = home.getByRole('dialog', { name: 'Remove Forget me from your meetings?' });
    await expect(dialog.getByText('This forgets the meeting on this device.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expectNoA11yViolations(home);
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(row(home, 'Forget me')).toBeVisible();

    await row(home, 'Forget me').getByRole('button', { name: 'Remove Forget me' }).click();
    await home.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(row(home, 'Forget me')).toHaveCount(0);
    await expect(home.getByText('Meetings you start or join in this browser are listed here')).toBeVisible();

    // Gone after a reload, and the link now asks for a name again instead of rejoining silently.
    await home.reload();
    await expect(row(home, 'Forget me')).toHaveCount(0);
    await home.goto(url);
    await expect(home.getByRole('textbox', { name: 'Your name' })).toBeVisible();
  } finally {
    await hostContext.close();
    await annContext.close();
  }
});

test('Remove on a facilitated meeting suggests a backup, refuses while a tab runs it, then deletes the board', async ({ page }) => {
  await hostMeeting(page, 'Hana', 'Delete me');
  const home = await page.context().newPage();
  await home.goto(APP_PATH);

  // The meeting is running in the first tab: its saves would bring it back, so it is kept.
  await row(home, 'Delete me').getByRole('button', { name: 'Remove Delete me' }).click();
  const dialog = home.getByRole('dialog', { name: 'Remove Delete me from this browser?' });
  await expect(dialog.getByText('deletes the meeting and its board from this browser')).toBeVisible();
  await expect(dialog.getByText('back it up first')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(home.getByRole('alert').filter({ hasText: 'open in another tab' })).toBeVisible();
  await expect(row(home, 'Delete me')).toBeVisible();

  // Once that tab is closed the board goes, and stays gone.
  await page.close();
  await expect(async () => {
    await row(home, 'Delete me').getByRole('button', { name: 'Remove Delete me' }).click();
    await home.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(row(home, 'Delete me')).toHaveCount(0, { timeout: 1000 });
  }).toPass();
  await home.reload();
  await expect(row(home, 'Delete me')).toHaveCount(0);
});
