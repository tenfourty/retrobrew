import { expect, test } from '@playwright/test';
import { APP_PATH, expectNoA11yViolations, hostMeeting } from './helpers';

test('the home page has no serious accessibility violations', async ({ page }) => {
  await page.goto(APP_PATH);
  await expect(page.getByRole('button', { name: 'Create meeting' })).toBeVisible();
  await expectNoA11yViolations(page);
});

test('the join page has no serious accessibility violations', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const url = await hostMeeting(await hostContext.newPage(), 'Host');
    const guest = await guestContext.newPage();
    await guest.goto(url);
    await expect(guest.getByRole('button', { name: 'Take part' })).toBeVisible();
    await expectNoA11yViolations(guest);
  } finally {
    await hostContext.close();
    await guestContext.close();
  }
});
