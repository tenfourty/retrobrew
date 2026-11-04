import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  addTopic, APP_PATH, banner, createMeeting, discussTopic, expectContrastWhile, expectNoA11yViolationsInEveryTheme, expectTapTargets,
  forceSignals, hostMeeting, joinMeeting, NETWORK_WAIT, THEMES, timeUpSheet, topicCard, withRehearsal,
  realLength,
} from './helpers';

const TIME_UP_WAIT = 45_000;
const facilitatorPanel = (page: Page) => page.getByRole('complementary', { name: 'Facilitator' });
const liveRegion = (page: Page) => page.locator('[data-live-region]');
const tab = (page: Page, name: RegExp) => page.getByRole('tab', { name });

async function endMeeting(host: Page): Promise<void> {
  await facilitatorPanel(host).getByRole('button', { name: 'End meeting' }).click();
  await host.getByRole('dialog', { name: 'End the meeting?' }).getByRole('button', { name: 'End meeting' }).click();
}

async function expectAccessible(page: Page): Promise<void> {
  await expectTapTargets(page);
  await expectNoA11yViolationsInEveryTheme(page);
}

// Counts how often the live region goes from something else to exactly these words (it is emptied before each
// announcement, so the same words twice in a row count twice). Install it before the words can be said.
async function countSaid(page: Page, text: string): Promise<() => Promise<number>> {
  const key = `__said_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(({ key, text }) => {
    const w = window as unknown as Record<string, number>;
    w[key] = 0;
    let last = '';
    new MutationObserver(() => {
      const now = document.querySelector('[data-live-region]')?.textContent ?? '';
      if (now === text && last !== text) w[key] += 1;
      last = now;
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, { key, text });
  return () => page.evaluate((k) => (window as unknown as Record<string, number>)[k], key);
}

test('every phase passes axe in all four themes, with 44 px targets, wide and on a phone', async ({ browser }) => {
  test.setTimeout(240_000);
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await hostContext.newPage();
    const ann = await annContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Accessibility check', { rehearsal: true });

    // The join screen.
    await ann.goto(url);
    await expect(ann.getByRole('button', { name: 'Take part' })).toBeVisible();
    await expectAccessible(ann);
    await joinMeeting(ann, url, 'Ann');

    // Collecting topics.
    for (const text of ['Release notes', 'Hiring plan', 'Pairing rotation']) await addTopic(host, text);
    await expect(topicCard(ann, 'Pairing rotation')).toBeVisible({ timeout: NETWORK_WAIT });
    await topicCard(ann, 'Hiring plan').getByRole('button', { name: /^Vote for / }).click();
    await expect(topicCard(host, 'Hiring plan').getByRole('img', { name: '1 vote' })).toBeVisible({ timeout: NETWORK_WAIT });
    // The facilitator's panel holds the timer sound's Select and its Play row.
    await expect(facilitatorPanel(host).getByRole('combobox', { name: 'Timer sound' })).toBeVisible();
    await expect(facilitatorPanel(host).getByRole('button', { name: 'Play' })).toBeVisible();
    await expectAccessible(host);
    await expectAccessible(ann);
    // Show votes off: everyone sees "Votes hidden" and, for the voter, their own dots.
    const showVotes = facilitatorPanel(host).getByRole('switch', { name: 'Show votes' });
    await showVotes.click();
    await expect(topicCard(ann, 'Hiring plan').getByRole('img', { name: 'Votes hidden, 1 yours' })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(topicCard(host, 'Hiring plan').getByRole('img', { name: 'Votes hidden' })).toBeVisible();
    await expectAccessible(host);
    await expectAccessible(ann);
    await showVotes.click();
    await expect(topicCard(ann, 'Hiring plan').getByRole('img', { name: '1 vote' })).toBeVisible({ timeout: NETWORK_WAIT });

    // Discussion with a timer running, and the Discussing tab on the phone.
    await host.getByRole('button', { name: 'Start discussion' }).click();
    await expect(tab(ann, /^To discuss/)).toBeVisible({ timeout: NETWORK_WAIT });
    await discussTopic(host, 'Hiring plan', '50 s');
    await expect(tab(ann, /^Discussing/)).toHaveAttribute('aria-selected', 'true', { timeout: NETWORK_WAIT });
    await expectAccessible(host);
    await expectAccessible(ann);
    await tab(ann, /^To discuss/).click();
    await expectAccessible(ann);
    await host.getByRole('button', { name: 'Finish topic' }).click();

    // Time up: the sheet everyone sees, then the decision, then the ended board.
    await discussTopic(host, 'Release notes', '10 s');
    for (const page of [host, ann]) await expect(timeUpSheet(page)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expectAccessible(host);
    await expectAccessible(ann);
    // With the vote open and the sheet closed, the dial (wide) and the strip (phone) show time up on the page itself, not
    // behind a modal that makes them inert: axe checks the time-up colour only here.
    for (const page of [host, ann]) {
      await timeUpSheet(page).getByRole('button', { name: 'Close', exact: true }).click();
      await expect(timeUpSheet(page)).toHaveCount(0);
      await expect(page.locator('.rb-timer-up, .rb-strip-up').first()).toBeVisible();
      await expectAccessible(page);
    }
    await host.getByRole('button', { name: 'Decide' }).click();
    await timeUpSheet(host).locator('.mtg-decision').getByRole('button').first().click();
    await expect(timeUpSheet(ann)).toHaveCount(0, { timeout: NETWORK_WAIT });
    await endMeeting(host);
    await expect(ann.locator('.rb-banner-text')).toContainText('Meeting ended', { timeout: NETWORK_WAIT });
    await expectAccessible(host);
    await expectAccessible(ann);
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

test('the one live region says each phase change, topic, the countdown and time up, and nothing from a hidden tab', async ({ browser }) => {
  test.setTimeout(180_000);
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await hostContext.newPage();
    const ann = await annContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Announcements', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await addTopic(host, 'Release notes');
    await addTopic(host, 'Hiring plan');
    await expect(topicCard(ann, 'Hiring plan')).toBeVisible({ timeout: NETWORK_WAIT });
    // Joining announces nothing: the first view only shows where the meeting is.
    await expect(liveRegion(ann)).toHaveCount(1);
    await expect(liveRegion(ann)).toHaveText('');

    await host.getByRole('button', { name: 'Start discussion' }).click();
    await expect(liveRegion(ann)).toHaveText('Discussion started', { timeout: NETWORK_WAIT });
    await expect(liveRegion(host)).toHaveText('Discussion started');

    // 5 timebox minutes of 10 seconds. A topic starting opens the Discussing tab, so the phone goes back to To discuss:
    // the Discussing panel is hidden, and the strip's running clock and the dial never reach the live region.
    const countdowns = await countSaid(ann, '10 seconds left');
    await discussTopic(host, 'Release notes', '50 s');
    await expect(liveRegion(ann)).toHaveText(/^Now discussing #\d+: Release notes$/, { timeout: NETWORK_WAIT });
    await expect(tab(ann, /^Discussing/)).toHaveAttribute('aria-selected', 'true');
    await tab(ann, /^To discuss/).click();
    await expect(ann.locator('#discussion-panel-discussing')).toBeHidden();
    await expect(liveRegion(ann)).toHaveText('10 seconds left', { timeout: 60_000 });
    await expect(tab(ann, /^To discuss/)).toHaveAttribute('aria-selected', 'true');
    // Only the countdown, once: the clock keeps running, and the region says it again only for a new timer.
    await expect(liveRegion(ann)).toHaveCount(1);

    await expect(timeUpSheet(ann)).toBeVisible({ timeout: TIME_UP_WAIT });
    expect(await countdowns()).toBe(1);
    await expect(liveRegion(ann)).toHaveText("Time's up. Vote to keep going or move on");
    // The region moved into the open sheet, so a screen reader reads it past the inert page.
    await expect(timeUpSheet(ann).locator('[data-live-region]')).toHaveCount(1);
    await expect(liveRegion(host)).toHaveCount(1);
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

test('a participant who is only reading keeps focus when the meeting ends', async ({ browser }) => {
  test.setTimeout(120_000);
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await hostContext.newPage();
    const ann = await annContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Reading', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await addTopic(host, 'Release notes');
    await expect(topicCard(ann, 'Release notes')).toBeVisible({ timeout: NETWORK_WAIT });
    await ann.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await ann.evaluate(() => document.activeElement === document.body)).toBe(true);
    await endMeeting(host);
    await expect(ann.locator('.rb-banner-text')).toContainText('Meeting ended', { timeout: NETWORK_WAIT });
    await expect(liveRegion(ann)).toHaveText('Meeting ended');
    expect(await ann.evaluate(() => document.activeElement === document.body)).toBe(true);
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

test('a facilitator whose device cannot save sees that banner, not the ended banner', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const host = await context.newPage();
    await forceSignals(host, { host: { storageNotice: false, saveFailed: true } });
    await hostMeeting(host, 'Hana', 'Save failing', { rehearsal: true });
    await addTopic(host, 'Release notes');
    await expect(banner(host, "This device couldn't save the meeting")).toBeVisible({ timeout: NETWORK_WAIT });
    await endMeeting(host);
    await expect(host.getByText('This meeting has ended. Copy the outcome or reopen it')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(banner(host, "This device couldn't save the meeting")).toBeVisible();
    await expect(host.locator('.rb-banner-text')).toHaveCount(1);
    await expect(host.locator('.rb-banner-text', { hasText: /^Meeting ended/ })).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the countdown is said once for each timer: a layout flip does not repeat it, and a timer after "keep going" says it again', async ({ browser }) => {
  test.setTimeout(180_000);
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await hostContext.newPage();
    const ann = await annContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Countdown rounds', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await addTopic(host, 'Release notes');
    await expect(topicCard(ann, 'Release notes')).toBeVisible({ timeout: NETWORK_WAIT });
    await host.getByRole('button', { name: 'Start discussion' }).click();
    const countdowns = await countSaid(ann, '10 seconds left');
    // A 20 s timer says it at 10 s left. The phone then turns wide, so the discussion view mounts again inside that window.
    await discussTopic(host, 'Release notes', '20 s');
    await expect.poll(countdowns, { timeout: NETWORK_WAIT }).toBe(1);
    await ann.setViewportSize({ width: 1280, height: 800 });
    await expect(ann.getByRole('tab')).toHaveCount(0);
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: TIME_UP_WAIT });
    expect(await countdowns()).toBe(1);

    // Keep going for 20 more seconds: a new timer, a new round, so it counts down again at its own mark.
    const sheet = timeUpSheet(host);
    await sheet.getByRole('group', { name: 'Your vote' }).getByRole('button', { name: 'Keep going', exact: true }).click();
    await sheet.getByRole('group', { name: 'More time' }).getByRole('button', { name: realLength('20 s') }).click();
    await sheet.locator('.mtg-decision').getByRole('button').nth(1).click();
    await expect.poll(countdowns, { timeout: NETWORK_WAIT }).toBe(2);
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: TIME_UP_WAIT });
    expect(await countdowns()).toBe(2);
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

test('buttons keep their contrast hovered and pressed, in every theme', async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await hostMeeting(page, 'Hana', 'Button states', { rehearsal: true });
    await addTopic(page, 'Release notes');
    await expect(topicCard(page, 'Release notes')).toBeVisible();
    await page.getByRole('textbox', { name: 'New topic' }).blur();
    // One enabled button of each variant: Start discussion, Invite people, a card's Edit, and End meeting.
    const variants = {
      primary: page.locator('.rb-btn-primary:visible:not(:disabled)').first(),
      secondary: page.locator('.rb-btn-secondary:visible:not(:disabled)').first(),
      ghost: page.locator('.rb-card .rb-btn-ghost:visible:not(:disabled)').first(),
      danger: page.locator('.rb-btn-danger:visible:not(:disabled)').first(),
    };
    for (const theme of THEMES) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      for (const [name, button] of Object.entries(variants)) {
        for (const state of ['hover', 'active'] as const) await expectContrastWhile(page, button, state, `${theme} ${name} button`);
      }
    }
  } finally {
    await context.close();
  }
});

test('sheets follow prefers-reduced-motion', async ({ browser }) => {
  const sheetAnimation = async (reducedMotion: 'reduce' | 'no-preference') => {
    const context = await browser.newContext({ reducedMotion });
    try {
      const page = await context.newPage();
      await createMeeting(page, 'Hana');
      const sheet = page.getByRole('dialog', { name: 'Invite people' });
      await expect(sheet).toBeVisible();
      return await sheet.evaluate((el) => getComputedStyle(el).animationName);
    } finally {
      await context.close();
    }
  };
  // The sheet slides in unless the person asked for less motion (the control shows the test can tell the two apart).
  expect(await sheetAnimation('no-preference')).toBe('rb-sheet-in');
  expect(await sheetAnimation('reduce')).toBe('none');
});

// Clipboard writes fail and there is no native share, so the fields to copy from by hand show.
async function refuseClipboard(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(Clipboard.prototype, 'writeText', { configurable: true, value: () => Promise.reject(new Error('refused')) });
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: undefined });
  });
}

async function checkDialog(page: Page, name: string | RegExp): Promise<void> {
  const dialog = page.getByRole('dialog', { name });
  await expect(dialog).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

test('a facilitator on a phone: the share step, More, editing, every confirmation and the picker pass axe', async ({ browser }) => {
  test.setTimeout(360_000);
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  await refuseClipboard(context);
  try {
    const host = await context.newPage();
    await createMeeting(host, 'Hana', 'Phone check', { rehearsal: true });
    // The share step, then its field to copy from when the clipboard is refused.
    const share = host.getByRole('dialog', { name: 'Invite people' });
    await expectAccessible(host);
    await share.getByRole('button', { name: 'Copy link' }).click();
    await expect(share.getByRole('textbox', { name: 'Meeting link' })).toBeVisible();
    await expectAccessible(host);
    await share.getByRole('button', { name: 'Done' }).click();
    await expect(share).toHaveCount(0);

    await addTopic(host, 'Release notes');
    await addTopic(host, 'Pairing rotation');
    await host.getByRole('textbox', { name: 'New topic' }).blur();
    const bar = host.getByRole('group', { name: 'Next step' });
    await expect(bar.getByRole('button', { name: 'More' })).toBeVisible();
    await expectAccessible(host);
    const more = host.getByRole('dialog', { name: 'More' });
    const openMore = async () => { await bar.getByRole('button', { name: 'More' }).click(); await expect(more).toBeVisible(); };

    // More: its action and the Facilitator controls. Show votes off and on, with a vote cast.
    await openMore();
    await checkDialog(host, 'More');
    await topicCard(host, 'Pairing rotation').getByRole('button', { name: /^Vote for / }).click();
    await expect(topicCard(host, 'Pairing rotation').getByRole('img', { name: '1 vote' })).toBeVisible();
    await openMore();
    await more.getByRole('switch', { name: 'Show votes' }).click();
    await expect(more.getByRole('switch', { name: 'Show votes' })).toHaveAttribute('aria-checked', 'false');
    await expectAccessible(host);
    await host.keyboard.press('Escape');
    await expect(topicCard(host, 'Pairing rotation').getByRole('img', { name: /^Votes hidden/ })).toBeVisible();
    await expectAccessible(host);
    await openMore();
    await more.getByRole('switch', { name: 'Show votes' }).click();
    await host.keyboard.press('Escape');
    await expect(topicCard(host, 'Pairing rotation').getByRole('img', { name: '1 vote' })).toBeVisible();

    // Editing a topic, then the delete confirmation.
    const card = topicCard(host, 'Pairing rotation');
    await card.getByRole('button', { name: /^Edit / }).click();
    // The card's text moves into the field, so the card is found by the field from here on.
    const editing = host.getByRole('textbox', { name: /^Edit #\d+$/ });
    await expect(editing).toBeVisible();
    await expectAccessible(host);
    await host.locator('article', { has: editing }).getByRole('button', { name: 'Cancel' }).click();
    await expect(editing).toHaveCount(0);
    await card.getByRole('button', { name: /^Delete / }).click();
    await checkDialog(host, /^Delete #\d+\?$/);

    // Reset all votes, from the Facilitator controls in More.
    await openMore();
    await more.getByRole('button', { name: 'Reset all votes' }).click();
    await checkDialog(host, 'Reset all votes?');

    // The timebox picker, from the discussion phase's primary button.
    await bar.getByRole('button', { name: 'Start discussion' }).click();
    await expect(bar.getByRole('button', { name: /^Discuss #\d+$/ })).toBeVisible({ timeout: NETWORK_WAIT });
    await bar.getByRole('button', { name: /^Discuss #\d+$/ }).click();
    await checkDialog(host, /^Discuss #\d+$/);

    // Back to topics, then End meeting with its Copy as text field (the clipboard is refused), then the ended view's sheets.
    // (With a topic waiting, the bar's other button is More, and Back to topics sits in its controls.)
    await bar.getByRole('button', { name: 'More' }).click();
    await host.getByRole('dialog', { name: 'More' }).getByRole('button', { name: 'Back to topics' }).click();
    await host.keyboard.press('Escape');
    await expect(bar.getByRole('button', { name: 'Start discussion' })).toBeVisible({ timeout: NETWORK_WAIT });
    await openMore();
    await more.getByRole('button', { name: 'End meeting' }).click();
    const end = host.getByRole('dialog', { name: 'End the meeting?' });
    await expectAccessible(host);
    await end.getByRole('button', { name: 'Copy as text' }).click();
    await expect(end.getByRole('textbox', { name: 'Copy the text from here' })).toBeVisible();
    await expectAccessible(host);
    await end.getByRole('button', { name: 'End meeting' }).click();
    await expect(end).toHaveCount(0);
    await bar.getByRole('button', { name: 'Copy as text' }).click();
    await expect(host.getByRole('textbox', { name: 'Copy the text from here' })).toBeVisible();
    await expectAccessible(host);
    await host.keyboard.press('Escape');
    await expect(host.getByRole('dialog', { name: 'Copy as text' })).toHaveCount(0);
    await openMore();
    await expectAccessible(host);
    await more.getByRole('button', { name: 'Back up meeting file' }).click();
    await checkDialog(host, 'Back up meeting file');
  } finally {
    await context.close();
  }
});

test('the screens without a board pass axe in all four themes, with 44 px targets', async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const stranger = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    // The app home, plain and for a rehearsal, with the create form's and the file reader's errors.
    const page = await context.newPage();
    await page.goto(APP_PATH);
    await expect(page.getByRole('button', { name: 'Create meeting' })).toBeVisible();
    await expectAccessible(page);
    await page.goto(withRehearsal(`${APP_PATH}#start`));
    await page.getByRole('button', { name: 'Create meeting' }).click();
    await expect(page.getByText('Enter a meeting name')).toBeVisible();
    await expectAccessible(page);
    await page.locator('input[type=file]').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"not":"a meeting"}') });
    await expect(page.getByText("That file isn't a Retrobrew meeting file")).toBeVisible();
    await expectAccessible(page);

    // A broken link, and connecting to a meeting whose facilitator is not there.
    await page.goto(`${APP_PATH}#b=abcdefgh&k=short&h=short`);
    await expect(page.getByRole('heading', { name: "This link isn't complete" })).toBeVisible();
    await expectAccessible(page);
    const hostPage = await context.newPage();
    const url = await hostMeeting(hostPage, 'Hana', 'Away meeting');
    await hostPage.close();
    const ben = await stranger.newPage();
    await ben.goto(url);
    await ben.getByRole('textbox', { name: 'Your name' }).fill('Ben');
    await ben.getByRole('button', { name: 'Take part' }).click();
    await expect(ben.getByText('Connecting to the facilitator…')).toBeVisible();
    await expectAccessible(ben);

    // The hosting states: starting, failed, open in another tab, and taken over.
    for (const hosting of ['starting', 'failed'] as const) {
      const forced = await context.newPage();
      await forceSignals(forced, { hosting });
      await forced.goto(url);
      await expect(forced.getByText(hosting === 'starting' ? 'Starting the meeting…' : "The meeting couldn't start on this device.")).toBeVisible({ timeout: NETWORK_WAIT });
      await expectAccessible(forced);
      await forced.close();
    }
    const first = await context.newPage();
    await first.goto(url);
    await expect(first.getByRole('textbox', { name: 'New topic' })).toBeVisible({ timeout: NETWORK_WAIT });
    const second = await context.newPage();
    await second.goto(url);
    await expect(second.getByText('This meeting is open in another tab.')).toBeVisible();
    await expectAccessible(second);
    await second.getByRole('button', { name: 'Take over here' }).click();
    await expect(first.getByText('This meeting is now open in another tab.')).toBeVisible({ timeout: NETWORK_WAIT });
    await expectAccessible(first);
  } finally {
    await Promise.all([context.close(), stranger.close()]);
  }
});
