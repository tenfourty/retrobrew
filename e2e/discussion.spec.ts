import { expect, test, type Page } from '@playwright/test';
import { addTopic, discussTopic, expectNoA11yViolations, hostMeeting, joinMeeting, NETWORK_WAIT, outcomeLine, stopTimer, timeUpSheet, topicCard } from './helpers';

const LONG = 'Should we adopt trunk-based development this quarter?';
const column = (page: Page, name: string) => page.getByRole('region', { name });
const tab = (page: Page, name: RegExp) => page.getByRole('tab', { name });

test('wide screens show To discuss, Discussing and Discussed side by side', async ({ browser }) => {
  test.slow();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, ann] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Columns check', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    for (const text of ['Release notes', 'Hiring plan', 'Pairing rotation']) await addTopic(ann, text);
    await expect(column(host, 'Ideas').locator('article')).toHaveCount(3, { timeout: NETWORK_WAIT });
    await topicCard(ann, 'Hiring plan').getByRole('button', { name: /^Vote for / }).click();
    await topicCard(ann, 'Hiring plan').getByRole('button', { name: /^Vote for / }).click();
    await topicCard(ann, 'Release notes').getByRole('button', { name: /^Vote for / }).click();
    await expect(ann.getByText('No votes left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
    await host.getByRole('button', { name: 'Start discussion' }).click();

    // To discuss in vote order, with the topics nobody voted for under "No votes yet".
    const toDiscuss = column(ann, 'To discuss');
    await expect(toDiscuss.locator('.rb-card-text, .rb-col-group')).toHaveText(['Hiring plan', 'Release notes', 'No votes yet', 'Pairing rotation'], { timeout: NETWORK_WAIT });
    await expect(column(ann, 'Discussing').getByText('Nothing is being discussed yet. The facilitator picks the next topic.')).toBeVisible();
    await expect(column(host, 'Discussing').getByText('Pick a topic from To discuss.')).toBeVisible();
    await expect(column(ann, 'Discussed').getByText('Finished topics appear here')).toBeVisible();
    await expect(toDiscuss.getByRole('button', { name: /^Discuss (?!#\d+$)/ })).toHaveCount(0);
    await expect(column(host, 'To discuss').getByRole('button', { name: /^Discuss (?!#\d+$)/ })).toHaveCount(3);

    // New topics land at the end of To discuss.
    await expect(ann.getByRole('button', { name: 'Add another topic' })).toBeVisible();
    await addTopic(ann, 'Retro format');
    await expect(toDiscuss.locator('.rb-card-text')).toHaveText(['Hiring plan', 'Release notes', 'Pairing rotation', 'Retro format'], { timeout: NETWORK_WAIT });

    // Any topic can be picked, not only the top one.
    await discussTopic(host, 'Release notes', '10 s');
    const live = column(ann, 'Discussing').locator('article');
    await expect(live.locator('.rb-card-text')).toHaveText('Release notes', { timeout: NETWORK_WAIT });
    await expect(live.getByRole('timer')).toContainText('of 10 s');
    // Only one topic is discussed at a time: the other Discuss buttons wait, with the reason, instead of failing after the picker.
    const waiting = column(host, 'To discuss').getByRole('button', { name: /^Discuss (?!#\d+$)/ });
    await expect(waiting).toHaveCount(3);
    for (const button of await waiting.all()) {
      await expect(button).toBeDisabled();
      await expect(button).toHaveAccessibleDescription('Finish or return the topic being discussed first');
      await expect(button).toHaveAttribute('title', 'Finish or return the topic being discussed first');
    }
    await expect(live.getByRole('button')).toHaveCount(0);
    await expectNoA11yViolations(ann);
    await stopTimer(host);
    await expect(live.getByText('No timer')).toBeVisible({ timeout: NETWORK_WAIT });
    await host.getByRole('button', { name: 'Start timer' }).click();
    const picker = host.getByRole('dialog', { name: 'Start a timer for #1' });
    await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: '10 s', exact: true }).click();
    await picker.getByRole('button', { name: 'Start 10 s' }).click();
    await expect(timeUpSheet(host)).toBeVisible({ timeout: 30_000 });
    await timeUpSheet(host).locator('.mtg-decision').getByRole('button').first().click();
    // The outcome line sits at the top of the Discussing column.
    await expect(column(ann, 'Discussing').locator('xpath=..').locator('.rb-outcome')).toHaveText('Moved on · Next topic coming up', { timeout: NETWORK_WAIT });
    await expect(column(ann, 'Discussed').locator('.rb-card-text')).toHaveText(['Release notes']);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('phones show a status strip and a tab per column, without switching tabs while someone types', async ({ browser }) => {
  test.slow();
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await hostContext.newPage();
    const ann = await annContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Tabs check', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await addTopic(host, LONG);
    await addTopic(host, 'Hiring plan');
    await addTopic(host, 'Release notes');
    await host.getByRole('button', { name: 'Start discussion' }).click();

    await expect(tab(ann, /^To discuss/)).toHaveAccessibleName('To discuss 3', { timeout: NETWORK_WAIT });
    await expect(tab(ann, /^Discussing/)).toHaveAccessibleName('Discussing');
    await expect(tab(ann, /^Discussed/)).toHaveAccessibleName('Discussed 0');
    await expect(tab(ann, /^To discuss/)).toHaveAttribute('aria-selected', 'true');
    const strip = ann.getByRole('button', { name: 'Discussion · Next topic coming up' });
    await expect(strip).toBeVisible();

    // A topic starting opens the Discussing tab, and the strip shows its number, the start of its text and the time.
    await discussTopic(host, LONG, '50 s');
    await expect(tab(ann, /^Discussing/)).toHaveAttribute('aria-selected', 'true', { timeout: NETWORK_WAIT });
    const busy = ann.locator('.rb-strip-main');
    await expect(busy).toContainText('#1');
    await expect(busy).toContainText('Should we adopt trunk-ba…');
    await expect(busy).toHaveAccessibleName(`Discussing #1 ${LONG}`);
    await expectNoA11yViolations(ann);

    // Arrow keys move between tabs; tapping the strip opens Discussing.
    await tab(ann, /^Discussing/).focus();
    await ann.keyboard.press('ArrowRight');
    await expect(tab(ann, /^Discussed/)).toHaveAttribute('aria-selected', 'true');
    await expect(tab(ann, /^Discussed/)).toBeFocused();
    await busy.click();
    await expect(tab(ann, /^Discussing/)).toHaveAttribute('aria-selected', 'true');

    // With a draft in the add box, a new topic starting leaves the tab alone.
    await host.getByRole('button', { name: 'Finish topic' }).click();
    await tab(ann, /^To discuss/).click();
    await ann.getByRole('textbox', { name: 'New topic' }).fill('Half a thought');
    await ann.getByRole('textbox', { name: 'New topic' }).blur();
    await discussTopic(host, 'Hiring plan', '10 s');
    await expect(busy).toContainText('Hiring plan', { timeout: NETWORK_WAIT });
    await expect(tab(ann, /^To discuss/)).toHaveAttribute('aria-selected', 'true');

    // Time's up: the strip says so and its Vote chip reopens the sheet.
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: 30_000 });
    await ann.keyboard.press('Escape');
    await expect(busy).toContainText("Time's up");
    await ann.locator('.rb-strip').getByRole('button', { name: 'Vote on keep going' }).click();
    await expect(timeUpSheet(ann)).toBeVisible();
    await timeUpSheet(host).locator('.mtg-decision').getByRole('button').first().click();
    // The outcome line sits just under the strip.
    const line = outcomeLine(ann);
    await expect(line).toHaveText('Moved on · Next topic coming up', { timeout: NETWORK_WAIT });
    // The vote ended under Ann's open sheet, taking the chip that opened it: focus lands on the strip, not the page body.
    await expect(timeUpSheet(ann)).toHaveCount(0);
    await expect(busy).toBeFocused();
    const [stripBox, lineBox, tabsBox] = await Promise.all([ann.locator('.rb-strip').boundingBox(), line.boundingBox(), ann.getByRole('tablist').boundingBox()]);
    expect(lineBox!.y).toBeGreaterThan(stripBox!.y);
    expect(lineBox!.y).toBeLessThan(tabsBox!.y);
    expect(await ann.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

// The add box unmounts when the layout flips and sends no blur, so the focus it had must not outlive it: a stale
// "focused" would keep the facilitator's bar hidden once the phone dock came back.
test('a focus the add box lost when the layout flipped does not hide the facilitator bar', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await context.newPage();
    await hostMeeting(host, 'Hana', 'Flip check', { rehearsal: true });
    const bar = host.getByRole('group', { name: 'Next step' });
    await expect(bar).toBeVisible();
    await host.getByRole('textbox', { name: 'New topic' }).focus();
    await expect(bar).toHaveCount(0);
    await host.setViewportSize({ width: 1024, height: 740 });
    await expect(host.getByRole('complementary', { name: 'Facilitator' })).toBeVisible();
    await host.setViewportSize({ width: 360, height: 740 });
    await expect(bar).toBeVisible();
    await expect(host.getByRole('textbox', { name: 'New topic' })).not.toBeFocused();
  } finally {
    await context.close();
  }
});

// A facilitator on a tablet has the 280 px side panel beside the board: the columns wrap rather than shrink to a sliver.
// Delete must never drop focus on the page body.
test('at 768 px the facilitator\'s columns stay readable, and deleting a topic keeps focus in To discuss', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 } });
  try {
    const host = await context.newPage();
    await hostMeeting(host, 'Hana', 'Tablet check', { rehearsal: true });
    for (const text of ['Alpha topic', 'Beta topic', 'Gamma topic']) await addTopic(host, text);
    await topicCard(host, 'Alpha topic').getByRole('button', { name: /^Vote for / }).click();
    await host.getByRole('button', { name: 'Start discussion' }).click();
    const toDiscuss = column(host, 'To discuss');
    // Unvoted topics keep the board's order, newest first (src/engine/order.ts).
    await expect(toDiscuss.locator('.rb-card-text, .rb-col-group')).toHaveText(['Alpha topic', 'No votes yet', 'Gamma topic', 'Beta topic'], { timeout: NETWORK_WAIT });
    for (const name of ['To discuss', 'Discussing', 'Discussed']) {
      expect((await column(host, name).boundingBox())!.width).toBeGreaterThanOrEqual(260);
    }
    expect(await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const remove = async (text: string) => {
      await topicCard(host, text).getByRole('button', { name: /^Delete / }).click();
      await host.getByRole('dialog').getByRole('button', { name: 'Delete topic' }).click();
      await expect(topicCard(host, text)).toHaveCount(0, { timeout: NETWORK_WAIT });
    };
    // The last voted topic has the "No votes yet" heading after it: focus still goes to a card, not the page body.
    await remove('Alpha topic');
    await expect(toDiscuss.locator(':focus')).toHaveCount(1);
    await remove('Beta topic');
    await expect(toDiscuss.locator(':focus')).toHaveCount(1);
    // No card is left in the column, so the column itself has focus.
    await remove('Gamma topic');
    await expect(toDiscuss).toBeFocused();
  } finally {
    await context.close();
  }
});
