import { expect, test, type Page } from '@playwright/test';
import { addTopic, APP_PATH, discussTopic, expectNoA11yViolations, fillMeeting, forceSignals, hostMeeting, joinMeeting, NETWORK_WAIT, openPeople, timeUpSheet } from './helpers';

test('the join screen asks for a name, and coming back rejoins without it', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Join check', { rehearsal: true });
    const ann = await annContext.newPage();
    await ann.goto(url);
    await expect(ann.getByRole('heading', { level: 1, name: "You're invited to a Lean Coffee" })).toBeVisible();
    await expect(ann.getByText("Choose the name the group will see. The board opens as soon as the facilitator's device answers.")).toBeVisible();
    await expect(ann.getByRole('textbox', { name: 'Your name' })).toHaveAccessibleDescription('Everyone in the meeting sees this name next to the topics you add');
    await expect(ann.getByRole('link', { name: 'How Lean Coffee works' })).toHaveAttribute('target', '_blank');
    await expectNoA11yViolations(ann);
    await ann.getByRole('button', { name: 'Take part' }).click();
    await expect(ann.getByText('Add your name first')).toBeVisible();
    await expect(ann.getByRole('textbox', { name: 'Your name' })).toBeFocused();
    await ann.getByRole('textbox', { name: 'Your name' }).fill('Ann');
    await ann.getByRole('button', { name: 'Take part' }).click();
    await expect(ann.getByRole('textbox', { name: 'New topic' })).toBeVisible({ timeout: NETWORK_WAIT });

    // Ann votes when time is up, then reloads: she rejoins without the form, and the sheet says she has voted.
    await addTopic(host, 'Pairing rotation');
    await host.getByRole('button', { name: 'Start discussion' }).click();
    await discussTopic(host, 'Pairing rotation', '10 s');
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: 30_000 });
    await timeUpSheet(ann).getByRole('button', { name: 'Move on', exact: true }).click();
    await expect(timeUpSheet(ann).getByText('1 of 2 present have voted')).toBeVisible({ timeout: NETWORK_WAIT });
    await ann.reload();
    await expect(ann.getByRole('textbox', { name: 'Your name' })).toHaveCount(0);
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(timeUpSheet(ann).getByText("You've voted")).toBeVisible();
    for (const choice of ['Keep going', 'No preference', 'Move on']) {
      const button = timeUpSheet(ann).getByRole('button', { name: choice, exact: true });
      await expect(button).toHaveAttribute('aria-pressed', 'false');
      await expect(button).toBeDisabled();
    }
    await ann.keyboard.press('Escape');
    const people = await openPeople(ann);
    await expect(people.getByRole('listitem').filter({ hasText: 'Ann (you)' })).toBeVisible();
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

test('a name remembered for a meeting is not used for a link that names another facilitator', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const benContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Identity check', { rehearsal: true });
    // Ben's device remembers a join of a meeting with this board ID under someone else's key.
    const boardId = new URLSearchParams(new URL(url).hash.slice(1)).get('b')!;
    const ben = await benContext.newPage();
    await ben.addInitScript((id) => window.localStorage.setItem(`rb-joined:${id}`, JSON.stringify({ hostPub: 'another-facilitator', name: 'Ben' })), boardId);
    await ben.goto(url);
    await expect(ben.getByRole('heading', { level: 1, name: "You're invited to a Lean Coffee" })).toBeVisible();
    await expect(ben.getByRole('textbox', { name: 'Your name' })).toHaveValue('');
    await expect(host.getByText('Ben')).toHaveCount(0);
  } finally {
    await Promise.all([hostContext.close(), benContext.close()]);
  }
});

test('a broken link says so, with no join form', async ({ page }) => {
  await page.goto(`${APP_PATH}#b=abcdefgh&k=short&h=short`);
  await expect(page.getByRole('heading', { name: "This link isn't complete" })).toBeVisible();
  // The page offers a way on besides the logo.
  await expect(page.getByRole('link', { name: 'start a meeting of your own' })).toBeVisible();
  await expect(page.getByText('Ask the facilitator to share the meeting link again.')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
});

test('joining a meeting whose facilitator is away keeps trying, and offers Retry after 15 seconds', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext();
  try {
    const url = await hostMeeting(await hostContext.newPage(), 'Hana');
    await hostContext.close();
    const ann = await annContext.newPage();
    await ann.goto(url);
    await ann.getByRole('textbox', { name: 'Your name' }).fill('Ann');
    await ann.getByRole('button', { name: 'Take part' }).click();
    await expect(ann.getByText('Connecting to the facilitator…')).toBeVisible();
    await expect(ann.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(ann.getByText('Still trying to reach the facilitator. They need to have the meeting open.')).toBeVisible({ timeout: 25_000 });
    await expect(ann.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expectNoA11yViolations(ann);
  } finally {
    await Promise.all([hostContext.close().catch(() => undefined), annContext.close()]);
  }
});

test('a banner before any board has its Retry and Reload actions', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext();
  try {
    const url = await hostMeeting(await hostContext.newPage(), 'Hana');
    await hostContext.close();
    const ann = await annContext.newPage();
    await forceSignals(ann, { participant: { pendingFailed: true } });
    await ann.goto(url);
    await ann.getByRole('textbox', { name: 'Your name' }).fill('Ann');
    await ann.getByRole('button', { name: 'Take part' }).click();
    await expect(ann.getByText('Connecting to the facilitator…')).toBeVisible();
    const retry = ann.locator('.rb-banner').getByRole('button', { name: 'Retry' });
    await expect(ann.locator('.rb-banner-text')).toHaveText("Your last change didn't reach the facilitator.");
    await retry.click();
    await expect(ann.getByText('Connecting to the facilitator…')).toBeVisible();

  } finally {
    await Promise.all([hostContext.close().catch(() => undefined), annContext.close()]);
  }
});

test('Reload on a banner before any board reloads the page, which rejoins without the form', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext();
  try {
    const url = await hostMeeting(await hostContext.newPage(), 'Hana');
    const ann = await annContext.newPage();
    await joinMeeting(ann, url, 'Ann');
    await hostContext.close();
    await forceSignals(ann, { participant: { staleTab: true } });
    await ann.reload();
    await expect(ann.getByRole('textbox', { name: 'Your name' })).toHaveCount(0);
    await expect(ann.getByText('Connecting to the facilitator…')).toBeVisible();
    const reload = ann.locator('.rb-banner').getByRole('button', { name: 'Reload' });
    await expect(reload).toBeVisible();
    await expectNoA11yViolations(ann);
    await Promise.all([ann.waitForEvent('load'), reload.click()]);
    await expect(ann.getByText('Connecting to the facilitator…')).toBeVisible();
  } finally {
    await Promise.all([hostContext.close().catch(() => undefined), annContext.close()]);
  }
});

test('a second tab of the facilitator’s meeting can take it over', async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    const url = await hostMeeting(first, 'Hana');
    const second = await context.newPage();
    await second.goto(url);
    await expect(second.getByText('This meeting is open in another tab.')).toBeVisible();
    await expectNoA11yViolations(second);
    await second.getByRole('button', { name: 'Take over here' }).click();
    await expect(second.getByRole('textbox', { name: 'New topic' })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(first.getByText('This meeting is now open in another tab.')).toBeVisible();
  } finally {
    await context.close();
  }
});

test('a full meeting sends a newcomer back to the join form with the reason, and Take part tries again', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const benContext = await browser.newContext();
  try {
    const first = await hostContext.newPage();
    const url = await hostMeeting(first, 'Hana', 'Full meeting');
    // A second tab takes the meeting over, so the host starts again from the stored board, now with 60 people.
    const host = await hostContext.newPage();
    await host.goto(url);
    await expect(host.getByText('This meeting is open in another tab.')).toBeVisible();
    await fillMeeting(host, 60);
    await host.getByRole('button', { name: 'Take over here' }).click();
    await expect(host.getByRole('button', { name: /here$/ })).toBeVisible({ timeout: NETWORK_WAIT });

    const ben = await benContext.newPage();
    await ben.goto(url);
    await ben.getByRole('textbox', { name: 'Your name' }).fill('Ben');
    await ben.getByRole('button', { name: 'Take part' }).click();
    await expect(ben.getByRole('alert').filter({ hasText: 'This meeting is full. It can have up to 60 people' })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(ben.getByRole('textbox', { name: 'Your name' })).toHaveValue('Ben');
    await expectNoA11yViolations(ben);
    // Trying again, under another name, is refused the same way while the meeting is full.
    await ben.getByRole('textbox', { name: 'Your name' }).fill('Benjamin');
    await ben.getByRole('button', { name: 'Take part' }).click();
    await expect(ben.getByRole('alert').filter({ hasText: 'This meeting is full. It can have up to 60 people' })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(ben.getByRole('textbox', { name: 'New topic' })).toHaveCount(0);
  } finally {
    await Promise.all([hostContext.close(), benContext.close()]);
  }
});

test('a silent rejoin the host refuses forgets the stored name and shows the form, with the name field focused', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const benContext = await browser.newContext();
  try {
    const first = await hostContext.newPage();
    const url = await hostMeeting(first, 'Hana', 'Full rejoin');
    const host = await hostContext.newPage();
    await host.goto(url);
    await expect(host.getByText('This meeting is open in another tab.')).toBeVisible();
    await fillMeeting(host, 60);
    await host.getByRole('button', { name: 'Take over here' }).click();
    await expect(host.getByRole('button', { name: /here$/ })).toBeVisible({ timeout: NETWORK_WAIT });

    // Ben's device remembers an earlier join of this meeting, so opening the link rejoins without the form.
    const ben = await benContext.newPage();
    const params = new URLSearchParams(new URL(url).hash.slice(1));
    const boardId = params.get('b')!;
    await ben.addInitScript(([id, hostPub]) => window.localStorage.setItem(`rb-joined:${id}`, JSON.stringify({ hostPub, name: 'Ben' })), [boardId, params.get('h')!]);
    await ben.goto(url);
    const message = ben.getByRole('alert').filter({ hasText: 'This meeting is full. It can have up to 60 people' });
    await expect(message).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(ben.getByRole('textbox', { name: 'Your name' })).toHaveValue('Ben');
    await expect(ben.getByRole('textbox', { name: 'Your name' })).toBeFocused();
    expect(await ben.evaluate((id) => window.localStorage.getItem(`rb-joined:${id}`), boardId)).toBeNull();
  } finally {
    await Promise.all([hostContext.close(), benContext.close()]);
  }
});

async function submitCreateForm(page: Page): Promise<void> {
  await page.goto(APP_PATH);
  await page.getByRole('textbox', { name: 'Meeting name' }).fill('E2E meeting');
  await page.getByRole('textbox', { name: 'Your name' }).fill('Hana');
  await page.getByRole('button', { name: 'Create meeting' }).click();
}

test("the facilitator's starting and failed states", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const starting = await context.newPage();
    await forceSignals(starting, { hosting: 'starting' });
    await submitCreateForm(starting);
    await expect(starting.getByText('Starting the meeting…')).toBeVisible({ timeout: NETWORK_WAIT });
    await expectNoA11yViolations(starting);
    await starting.close();

    const failed = await context.newPage();
    await forceSignals(failed, { hosting: 'failed' });
    await submitCreateForm(failed);
    await expect(failed.getByText("The meeting couldn't start on this device.")).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(failed.getByText('A browser test stopped the meeting from starting')).toBeVisible();
    await expect(failed.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expectNoA11yViolations(failed);
  } finally {
    await context.close();
  }
});
