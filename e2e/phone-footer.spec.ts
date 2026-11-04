import { expect, test, type Page } from '@playwright/test';
import { addTopic, hostMeeting, joinMeeting, NETWORK_WAIT, topicCard } from './helpers';

const PHONE = { width: 390, height: 844 };
const dockShare = async (page: Page) => (await page.locator('.mtg-dock').evaluate((el) => el.getBoundingClientRect().height)) / PHONE.height;

test('the phone footer is a compact row: the facilitator\'s under 16% of the screen, a guest\'s under 10%', async ({ browser }) => {
  test.slow();
  const hostContext = await browser.newContext({ viewport: PHONE });
  const annContext = await browser.newContext({ viewport: PHONE });
  try {
    const host = await hostContext.newPage();
    const ann = await annContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Footer check', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await addTopic(ann, 'Release notes');
    await expect(topicCard(host, 'Release notes')).toBeVisible({ timeout: NETWORK_WAIT });
    await host.getByRole('textbox', { name: 'New topic' }).blur();
    await ann.getByRole('textbox', { name: 'New topic' }).blur();
    await expect(host.getByRole('button', { name: 'Start discussion' })).toBeVisible();
    expect(await dockShare(host)).toBeLessThan(0.16);
    expect(await dockShare(ann)).toBeLessThan(0.1);
    // The name hint waits for focus, so the resting footer has one row for the box.
    await expect(host.locator('.mtg-dock .rb-add-hint')).toBeHidden();
    await host.getByRole('textbox', { name: 'New topic' }).focus();
    await expect(host.locator('.mtg-dock .rb-add-hint')).toBeVisible();
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

test('on a phone the first tap on Discuss works right after adding a topic with Enter', async ({ browser }) => {
  test.slow();
  const context = await browser.newContext({ viewport: PHONE });
  try {
    const host = await context.newPage();
    await hostMeeting(host, 'Hana', 'First tap', { rehearsal: true });
    await addTopic(host, 'Alpha');
    await host.getByRole('textbox', { name: 'New topic' }).blur();
    await host.getByRole('button', { name: 'Start discussion' }).click();
    await expect(host.getByRole('tab', { name: /To discuss/ })).toBeVisible();
    // Enter keeps focus in the box, which hides the facilitator's bar. Tapping a card blurs the box first; the bar must not
    // come back under the tap and push the card's button out from under it.
    await addTopic(host, 'Beta');
    await expect(topicCard(host, 'Beta')).toBeVisible();
    await topicCard(host, 'Alpha').getByRole('button', { name: /^Discuss (?!#\d+$)/ }).click();
    await expect(host.getByRole('dialog', { name: /^Discuss #\d+$/ })).toBeVisible({ timeout: NETWORK_WAIT });
  } finally {
    await context.close();
  }
});
