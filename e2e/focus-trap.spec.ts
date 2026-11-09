import { expect, test, type Locator, type Page } from '@playwright/test';
import { addTopic, discussTopic, hostMeeting, timeUpSheet, topicCard } from './helpers';

const TIME_UP_WAIT = 45_000;

const focusIsIn = (dialog: Locator) => dialog.evaluate((el) => el.contains(document.activeElement));

// docs/product/mvp-screens.md, Accessibility: "Sheets and confirmations trap focus". Walks Tab forward and Shift+Tab
// back for more presses than the dialog has controls, so focus has to pass the last control and the first, and checks
// after every press that it is still inside. When the dialog has more than one control it also checks that focus
// reached more than one of them, so a trap that simply froze focus would fail.
async function expectFocusTrapped(page: Page, dialog: Locator): Promise<void> {
  const controls = await dialog.locator('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])').count();
  expect(controls).toBeGreaterThan(0);
  // Focus must already be inside: opening a sheet moves it in (no fallback here, so a sheet that does not fails).
  expect(await focusIsIn(dialog), 'focus moved into the dialog when it opened').toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) {
    const reached = new Set<string>();
    for (let press = 0; press < controls + 3; press += 1) {
      await page.keyboard.press(key);
      expect(await focusIsIn(dialog), `focus left the dialog on ${key} press ${press + 1}`).toBe(true);
      reached.add(await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return `${el?.tagName}|${el?.getAttribute('aria-label') ?? el?.textContent?.trim().slice(0, 30)}`;
      }));
    }
    if (controls > 1) expect(reached.size, `${key} reached more than one control`).toBeGreaterThan(1);
  }
}

test('Tab and Shift+Tab stay inside a sheet, a confirmation and the time-up sheet, and Escape returns focus to the opener', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const host = await context.newPage();
    await hostMeeting(host, 'Hana', 'Focus trap', { rehearsal: true });
    await addTopic(host, 'Pairing rotation');
    await expect(topicCard(host, 'Pairing rotation')).toBeVisible();
    const timeUp = timeUpSheet(host);

    await test.step('People sheet', async () => {
      // An ordinary sheet: People. Focus returns to the "{n} here" button on Escape.
      const hereButton = host.getByRole('button', { name: /^\d+ here$/ });
      await hereButton.focus();
      await host.keyboard.press('Enter');
      // Wait for the sheet Enter opened; openPeople would click the button again if the sheet had not rendered yet,
      // and that click waits behind the sheet's backdrop until the test times out.
      const people = host.getByRole('dialog', { name: 'People' });
      await expect(people).toBeVisible();
      await expect(people.locator(':focus')).toHaveCount(1);
      await expectFocusTrapped(host, people);
      await host.keyboard.press('Escape');
      await expect(people).toHaveCount(0);
      await expect(hereButton).toBeFocused();
    });

    await test.step('Reset all votes confirmation', async () => {
      // A confirmation: Reset all votes. Focus returns to the button that opened it.
      const resetButton = host.getByRole('complementary', { name: 'Facilitator' }).getByRole('button', { name: 'Reset all votes' });
      await resetButton.focus();
      await host.keyboard.press('Enter');
      const reset = host.getByRole('dialog', { name: 'Reset all votes?' });
      await expect(reset).toBeVisible();
      await expect(reset.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expectFocusTrapped(host, reset);
      await host.keyboard.press('Escape');
      await expect(reset).toHaveCount(0);
      await expect(resetButton).toBeFocused();
    });

    await test.step('time-up sheet opened by the timer', async () => {
      // The time-up sheet, opened by the timer running out.
      await host.getByRole('button', { name: 'Start discussion' }).click();
      await discussTopic(host, 'Pairing rotation', '10 s');
      // Focus is in the add box when time runs out; it must move into the time-up sheet.
      await host.getByRole('textbox', { name: 'New topic' }).focus();
      await expect(timeUp).toBeVisible({ timeout: TIME_UP_WAIT });
      await expect(timeUp.locator(':focus')).toHaveCount(1);
      await expectFocusTrapped(host, timeUp);
      await host.keyboard.press('Escape');
      await expect(timeUp).toHaveCount(0);
    });

    await test.step('time-up sheet reopened from its button', async () => {
      // Reopened from the Vote on keep going button, it traps focus too, and Escape returns focus to that button.
      const reopen = topicCard(host, 'Pairing rotation').getByRole('button', { name: 'Vote on keep going', exact: true });
      await reopen.focus();
      await host.keyboard.press('Enter');
      await expect(timeUp).toBeVisible();
      await expect(timeUp.locator(':focus')).toHaveCount(1);
      await expectFocusTrapped(host, timeUp);
      await host.keyboard.press('Escape');
      await expect(timeUp).toHaveCount(0);
      await expect(reopen).toBeFocused();
    });
  } finally {
    await context.close();
  }
});
