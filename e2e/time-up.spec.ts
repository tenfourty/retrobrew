import { expect, test, type Page } from '@playwright/test';
import { addTopic, discussTopic, expectNoA11yViolations, hostMeeting, joinMeeting, NETWORK_WAIT, openPeople, outcomeLine, timeUpSheet, topicCard } from './helpers';

// On a rehearsal board a timebox minute lasts 10 seconds, so "10 s" runs out in 10 seconds. Tests wait for the sheet
// and the outcome, never for countdown digits.
const TIME_UP_WAIT = 30_000;
const HINT = 'Retrobrew never shows or stores who chose what. The facilitator decides.';

const decision = (page: Page) => timeUpSheet(page).locator('.mtg-decision').getByRole('button');

test('everyone votes when time is up, the facilitator decides, and everyone sees the outcome', async ({ browser }) => {
  test.slow();
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    const [host, ann, ben] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Time-up check', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await joinMeeting(ben, url, 'Ben');
    await addTopic(host, 'Pairing rotation');
    await host.getByRole('button', { name: 'Start discussion' }).click();

    await topicCard(host, 'Pairing rotation').getByRole('button', { name: 'Discuss', exact: true }).click();
    const picker = host.getByRole('dialog', { name: 'Discuss #1' });
    await expect(picker.getByText('Pairing rotation')).toBeVisible();
    const timeboxes = picker.getByRole('group', { name: 'Timebox' });
    await expect(timeboxes.getByRole('button')).toHaveText(['10 s', '20 s', '30 s', '40 s', '50 s', '1 min 40 s', '2 min 30 s', '3 min 20 s', '5 min']);
    await expect(timeboxes.getByRole('button', { name: '50 s' })).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.getByRole('switch', { name: 'Use real minutes' })).toHaveAttribute('aria-checked', 'false');
    await expect(picker.getByRole('button', { name: 'Start 50 s' })).toBeFocused();
    await timeboxes.getByRole('button', { name: '10 s', exact: true }).click();
    await picker.getByRole('button', { name: 'Start 10 s' }).click();

    // Ben has the People sheet open when time runs out: it closes, and focus moves into the time-up sheet.
    await openPeople(ben);
    for (const page of [host, ann, ben]) await expect(timeUpSheet(page)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(ben.getByRole('dialog', { name: 'People' })).toHaveCount(0);
    await expect(timeUpSheet(ben).getByRole('button', { name: 'Keep going', exact: true })).toBeFocused();

    const annSheet = timeUpSheet(ann);
    await expect(annSheet.getByText('#1 Pairing rotation')).toBeVisible();
    await expect(annSheet.getByText(HINT)).toBeVisible();
    await expectNoA11yViolations(ann);
    await annSheet.getByRole('button', { name: 'Keep going', exact: true }).click();
    // The ballot locks at once, and focus stays inside the sheet.
    await expect(annSheet.getByRole('button', { name: 'Keep going', exact: true })).toBeDisabled();
    await expect(annSheet.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(annSheet.getByRole('button', { name: 'Keep going', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(annSheet.getByRole('button', { name: 'Move on', exact: true })).toBeDisabled();
    await expect(annSheet.getByText(HINT)).toHaveCount(0);
    await expect(annSheet.getByText('Keep going 1 · No preference 0 · Move on 0')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(annSheet.getByText('1 of 3 present have voted')).toBeVisible();

    // Closing leaves the vote open, and the Vote chip brings the sheet back.
    await ben.keyboard.press('Escape');
    await expect(timeUpSheet(ben)).toHaveCount(0);
    await topicCard(ben, 'Pairing rotation').getByRole('button', { name: 'Vote', exact: true }).click();
    await timeUpSheet(ben).getByRole('button', { name: 'Move on', exact: true }).click();

    // A tie puts Move on first; the facilitator's own Keep going tips it.
    const hostSheet = timeUpSheet(host);
    await expect(hostSheet.getByText('2 voted · 3 here')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(hostSheet.getByText('Keep going 1 · No preference 0 · Move on 1')).toBeVisible();
    await expect(hostSheet.getByRole('group', { name: 'Your vote' }).getByRole('button')).toHaveCount(3);
    await expect(decision(host)).toHaveText(['Move on', 'Or keep going for 30 more seconds']);
    await expect(hostSheet.getByText('Move on finishes #1 and moves it to Discussed.')).toBeVisible();
    await expectNoA11yViolations(host);
    await hostSheet.getByRole('group', { name: 'Your vote' }).getByRole('button', { name: 'Keep going', exact: true }).click();
    await expect(decision(host)).toHaveText(['Keep going for 30 more seconds', 'Or move on']);
    await hostSheet.getByRole('group', { name: 'More time' }).getByRole('button', { name: '10 s', exact: true }).click();
    await expect(decision(host)).toHaveText(['Keep going for 10 more seconds', 'Or move on']);
    await decision(host).first().click();
    // Together, so every page's check falls inside the line's five seconds.
    await Promise.all([host, ann, ben].map(async (page) => {
      await expect(outcomeLine(page)).toHaveText('Keeping going for 10 more seconds', { timeout: NETWORK_WAIT });
      await expect(timeUpSheet(page)).toHaveCount(0);
    }));

    // The next time up is a new round: nothing pressed, and this device's last extension preselected.
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(timeUpSheet(ann).getByRole('button', { name: 'Keep going', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(timeUpSheet(host).getByRole('group', { name: 'More time' }).getByRole('button', { name: '10 s', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');

    // Start again gives the topic a fresh timebox, which reads as keeping going.
    await timeUpSheet(host).getByRole('button', { name: 'Start again' }).click();
    const restart = host.getByRole('dialog', { name: 'Start a timer for #1' });
    // Cancel goes back to the vote it interrupted.
    await restart.getByRole('button', { name: 'Cancel' }).click();
    await expect(timeUpSheet(host)).toBeVisible();
    await timeUpSheet(host).getByRole('button', { name: 'Start again' }).click();
    await restart.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: '20 s', exact: true }).click();
    await restart.getByRole('button', { name: 'Start 20 s' }).click();
    await expect(outcomeLine(ann)).toHaveText('Keeping going for 20 more seconds', { timeout: NETWORK_WAIT });

    await expect(timeUpSheet(host)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(decision(host).first()).toHaveText('Move on');
    await decision(host).first().click();
    await Promise.all([host, ann, ben].map((page) => expect(outcomeLine(page)).toHaveText('Moved on to the next topic', { timeout: NETWORK_WAIT })));
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('a rehearsal board can give one topic a timebox in real minutes', async ({ page }) => {
  await hostMeeting(page, 'Hana', 'Real minutes', { rehearsal: true });
  await addTopic(page, 'Retro format');
  await page.getByRole('button', { name: 'Start discussion' }).click();
  await topicCard(page, 'Retro format').getByRole('button', { name: 'Discuss', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Discuss #1' });
  await expect(picker.getByText('For this topic only. Otherwise a minute here lasts 10 seconds.')).toBeVisible();
  await picker.getByRole('switch', { name: 'Use real minutes' }).click();
  await expect(picker.getByRole('group', { name: 'Timebox' }).getByRole('button'))
    .toHaveText(['1 min', '2 min', '3 min', '4 min', '5 min', '10 min', '15 min', '20 min', '30 min']);
  await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: '1 min', exact: true }).click();
  await picker.getByRole('button', { name: 'Start 1 min' }).click();
  // A real minute: the dial's length is a full minute, not the 10 seconds a rehearsal minute lasts.
  const dial = topicCard(page, 'Retro format').getByRole('timer');
  await expect(dial).toBeVisible();
  const [minutes, seconds] = ((await dial.innerText()).match(/(\d+):(\d\d)/) ?? []).slice(1).map(Number);
  expect(minutes * 60 + seconds).toBeGreaterThan(10);
  await expect(timeUpSheet(page)).toHaveCount(0);

  // The switch is off again the next time the picker opens.
  await page.getByRole('button', { name: 'Finish topic' }).click();
  await addTopic(page, 'Pairing');
  await discussTopic(page, 'Pairing', '10 s');
  await expect(timeUpSheet(page)).toBeVisible({ timeout: TIME_UP_WAIT });
});
