import { expect, test, type Page } from '@playwright/test';
import { addTopic, discussTopic, expectNoA11yViolations, hostMeeting, joinMeeting, NETWORK_WAIT, topicCard } from './helpers';

const ideas = (page: Page) => page.getByRole('region', { name: 'Ideas' });
const newTopic = (page: Page) => page.getByRole('textbox', { name: 'New topic' });

test('people add, vote on, edit and delete topics, and the facilitator can hide votes', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, ann] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Topics check');
    await joinMeeting(ann, url, 'Ann');
    await expect(ideas(ann).getByText('No topics yet. Add the first one.')).toBeVisible();
    await expect(newTopic(ann)).toHaveAttribute('placeholder', 'Add a topic');
    await expect(newTopic(ann)).toHaveAccessibleDescription('Everyone in the meeting sees this name next to the topics you add');

    // Enter submits and keeps focus in the box; the newest topic comes first.
    await newTopic(ann).fill('Release notes');
    await newTopic(ann).press('Enter');
    await expect(newTopic(ann)).toBeFocused();
    await expect(newTopic(ann)).toHaveValue('');
    await newTopic(ann).fill('Pairing rotation');
    await newTopic(ann).press('Enter');
    await expect(ideas(host).locator('article')).toHaveCount(2, { timeout: NETWORK_WAIT });
    await expect(ideas(host).locator('.rb-card-text')).toHaveText(['Pairing rotation', 'Release notes']);
    await expect(ideas(ann).locator('.rb-chip')).toHaveText(/Ideas\s*2/);

    // From 240 characters a counter shows, and the box stops at 280.
    await newTopic(ann).fill('a'.repeat(241));
    await expect(ann.locator('#rb-topic-count')).toHaveText('39 characters left');
    await newTopic(ann).fill('b'.repeat(300));
    await expect(newTopic(ann)).toHaveValue('b'.repeat(280));
    await expect(ann.locator('#rb-topic-count')).toHaveText('0 characters left');
    await newTopic(ann).fill('');

    // Authors can edit and delete their topics; the facilitator can delete any topic but edit none of theirs.
    const annCard = topicCard(ann, 'Pairing rotation');
    await expect(annCard.getByRole('button')).toHaveText(['Vote', 'Edit', 'Delete']);
    await expect(topicCard(host, 'Pairing rotation').getByRole('button')).toHaveText(['Vote', 'Delete']);
    for (const left of ['2 votes left', '1 vote left', 'No votes left']) {
      await annCard.getByRole('button', { name: 'Vote', exact: true }).click();
      await expect(ann.getByText(left, { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
    }
    const vote = topicCard(ann, 'Release notes').getByRole('button', { name: 'Vote', exact: true });
    await expect(vote).toBeDisabled();
    await expect(vote).toHaveAccessibleDescription('You have no votes left');
    await expect(annCard.getByRole('img', { name: '3 votes, 3 yours' })).toBeVisible();
    await annCard.getByRole('button', { name: 'Remove vote' }).click();
    await expect(ann.getByText('1 vote left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });

    // The last Remove vote unmounts the focused button, so focus moves to the card's Vote.
    await annCard.getByRole('button', { name: 'Remove vote' }).click();
    await expect(ann.getByText('2 votes left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
    await annCard.getByRole('button', { name: 'Remove vote' }).click();
    await expect(ann.getByText('3 votes left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(annCard.getByRole('button', { name: 'Vote', exact: true })).toBeFocused();

    await annCard.getByRole('button', { name: 'Edit' }).click();
    const edit = ann.getByRole('textbox', { name: 'Edit #2' });
    await expect(edit).toHaveValue('Pairing rotation');
    await expect(edit).toBeFocused();
    await edit.fill('Pairing rotation for new joiners');
    await edit.press('Enter');
    await expect(annCard.getByRole('button', { name: 'Edit' })).toBeFocused();
    await expect(topicCard(host, 'Pairing rotation for new joiners')).toBeVisible({ timeout: NETWORK_WAIT });
    const edited = topicCard(ann, 'Pairing rotation for new joiners');
    await edited.getByRole('button', { name: 'Edit' }).click();
    await ann.getByRole('textbox', { name: 'Edit #2' }).fill('Something else');
    await ann.getByRole('textbox', { name: 'Edit #2' }).press('Escape');
    await expect(edited.locator('.rb-card-text')).toHaveText('Pairing rotation for new joiners');
    await expect(edited.getByRole('button', { name: 'Edit' })).toBeFocused();
    // Saving empty text asks the delete confirmation.
    await edited.getByRole('button', { name: 'Edit' }).click();
    await ann.getByRole('textbox', { name: 'Edit #2' }).fill('   ');
    // While editing, the card holds a field rather than its text, so find Save on the page.
    await ann.getByRole('button', { name: 'Save' }).click();
    const confirm = ann.getByRole('dialog', { name: 'Delete #2?' });
    await expect(confirm.getByText('The topic and its votes are removed, and everyone gets those votes back.')).toBeVisible();
    await expect(confirm.getByRole('button')).toHaveText(['Delete topic', 'Cancel']);
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(edited).toBeVisible();
    await expect(edited.getByRole('button', { name: 'Edit' })).toBeFocused();

    // The facilitator deletes Ann's topic; Ann gets her votes back.
    await topicCard(host, 'Pairing rotation for new joiners').getByRole('button', { name: 'Delete' }).click();
    await host.getByRole('dialog', { name: 'Delete #2?' }).getByRole('button', { name: 'Delete topic' }).click();
    // The deleted card's button is gone, so the host's focus lands on the next card's first button.
    await expect(topicCard(host, 'Release notes').getByRole('button', { name: 'Vote', exact: true })).toBeFocused({ timeout: NETWORK_WAIT });
    await expect(topicCard(ann, 'Pairing rotation for new joiners')).toHaveCount(0, { timeout: NETWORK_WAIT });
    await expect(ann.getByText('3 votes left', { exact: true })).toBeVisible();

    // Show votes off: everyone, the facilitator too, sees only their own dots and "Votes hidden".
    await topicCard(host, 'Release notes').getByRole('button', { name: 'Vote', exact: true }).click();
    await host.getByRole('complementary', { name: 'Facilitator' }).getByRole('switch', { name: 'Show votes' }).click();
    await expect(ideas(ann).getByText('Votes are hidden until the discussion starts')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(topicCard(ann, 'Release notes').getByRole('img', { name: 'Votes hidden' })).toBeVisible();
    // No count leaks to Ann: no dots image that states a number of votes.
    await expect(topicCard(ann, 'Release notes').getByRole('img', { name: /^\d+ votes?/ })).toHaveCount(0);
    await expect(topicCard(host, 'Release notes').getByRole('img', { name: 'Votes hidden, 1 yours' })).toBeVisible();
    await expectNoA11yViolations(ann);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('a refused topic says why above the add box, and Discussed shows after a discussion', async ({ page }) => {
  await hostMeeting(page, 'Hana', 'Limits check');
  for (let n = 1; n <= 60; n++) {
    await newTopic(page).fill(`Topic ${n}`);
    await newTopic(page).press('Enter');
  }
  await expect(ideas(page).locator('article')).toHaveCount(60);
  await newTopic(page).fill('One too many');
  await newTopic(page).press('Enter');
  const refusal = page.locator('.mtg-add .rb-alert');
  await expect(refusal).toHaveText('This meeting has 60 topics, which is as many as it can hold');
  await expect(page.locator('[data-live-region]')).toHaveText('This meeting has 60 topics, which is as many as it can hold');
  // It clears on the next action.
  await topicCard(page, 'Topic 60').getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog', { name: 'Delete #60?' }).getByRole('button', { name: 'Delete topic' }).click();
  await expect(refusal).toHaveCount(0);

  await page.getByRole('button', { name: 'Start discussion' }).click();
  await discussTopic(page, 'Topic 42', '1 min');
  await page.getByRole('button', { name: 'Finish topic' }).click();
  await page.getByRole('complementary', { name: 'Facilitator' }).getByRole('button', { name: 'Back to topics' }).click();
  const discussed = page.getByRole('region', { name: 'Discussed' });
  await expect(discussed.locator('.rb-card-text')).toHaveText(['Topic 42']);
  await expect(discussed.getByRole('button')).toHaveCount(0);
});

test('on a phone the add box pins to the bottom and the action bar hides while it has focus', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const page = await context.newPage();
    await hostMeeting(page, 'Hana', 'Phone topics');
    await addTopic(page, 'Release notes');
    await addTopic(page, 'Pairing rotation');
    const bar = page.getByRole('group', { name: 'Next step' });
    await newTopic(page).blur();
    await expect(bar).toBeVisible();
    const box = await newTopic(page).boundingBox();
    const barBox = await bar.boundingBox();
    expect(box!.y).toBeLessThan(barBox!.y);
    expect(barBox!.y + barBox!.height).toBeLessThanOrEqual(740);
    await newTopic(page).focus();
    await expect(bar).toHaveCount(0);
    await newTopic(page).blur();
    await expect(bar).toBeVisible();
    // Cards stack on phones.
    await expect(ideas(page).locator('article')).toHaveCount(2);
    const [first, second] = await ideas(page).locator('article').all();
    expect((await first.boundingBox())!.x).toBe((await second.boundingBox())!.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // A 280-character topic with no spaces, and a topic of 140 emoji, still fit at 320 px.
    await page.setViewportSize({ width: 320, height: 640 });
    await addTopic(page, 'x'.repeat(280));
    await addTopic(page, '😀'.repeat(140));
    await expect(ideas(page).locator('article')).toHaveCount(4);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    await context.close();
  }
});

test('on a phone a participant gets the add box pinned to the bottom of the screen', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext({ viewport: { width: 360, height: 740 } })]);
  try {
    const [host, ann] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Phone guest');
    await joinMeeting(ann, url, 'Ann');
    await addTopic(ann, 'Release notes');
    await expect(newTopic(ann)).toBeInViewport();
    const box = (await newTopic(ann).boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(740);
    expect(box.y).toBeGreaterThan(740 - 160);
    // Cards scroll behind it, not beneath: the last card ends above the box.
    const card = (await ideas(ann).locator('article').last().boundingBox())!;
    expect(card.y + card.height).toBeLessThanOrEqual(box.y);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
