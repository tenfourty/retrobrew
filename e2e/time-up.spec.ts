import { expect, test, type Page } from '@playwright/test';
import { addTopic, discussTopic, expectNoA11yViolations, hostMeeting, joinMeeting, NETWORK_WAIT, openPeople, outcomeLine, realLength, START_BUTTON, timeUpSheet, topicCard } from './helpers';

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

    await topicCard(host, 'Pairing rotation').getByRole('button', { name: /^Discuss (?!#\d+$)/ }).click();
    const picker = host.getByRole('dialog', { name: 'Discuss #1' });
    await expect(picker.getByText('Pairing rotation')).toBeVisible();
    const timeboxes = picker.getByRole('group', { name: 'Timebox' });
    await expect(timeboxes.getByRole('button')).toHaveText([/^1 min\s*10 s$/, /^2 min\s*20 s$/, /^3 min\s*30 s$/, /^4 min\s*40 s$/, /^5 min\s*50 s$/, /^10 min\s*1 min 40 s$/, /^15 min\s*2 min 30 s$/, /^20 min\s*3 min 20 s$/, /^30 min\s*5 min$/]);
    await expect(timeboxes.getByRole('button', { name: '20 min, 3 min 20 s' })).toBeVisible();
    await expect(timeboxes.getByRole('button', { name: realLength('50 s') })).toHaveAttribute('aria-pressed', 'true');
    await expect(picker.getByRole('switch', { name: 'Use real minutes' })).toHaveAttribute('aria-checked', 'false');
    await expect(picker.getByRole('button', { name: START_BUTTON })).toBeFocused();
    await timeboxes.getByRole('button', { name: realLength('10 s') }).click();
    await picker.getByRole('button', { name: START_BUTTON }).click();

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

    // Closing leaves the vote open, and the Vote on keep going button brings the sheet back.
    await ben.keyboard.press('Escape');
    await expect(timeUpSheet(ben)).toHaveCount(0);
    await topicCard(ben, 'Pairing rotation').getByRole('button', { name: 'Vote on keep going', exact: true }).click();
    await timeUpSheet(ben).getByRole('button', { name: 'Move on', exact: true }).click();

    // A tie puts Move on first; the facilitator's own Keep going tips it.
    const hostSheet = timeUpSheet(host);
    await expect(hostSheet.getByText('2 voted · 3 here')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(hostSheet.getByText('Keep going 1 · No preference 0 · Move on 1')).toBeVisible();
    await expect(hostSheet.getByRole('group', { name: 'Your vote' }).getByRole('button')).toHaveCount(3);
    await expect(decision(host)).toHaveText(['Move on', 'Keep going for 30 more seconds']);
    await expect(hostSheet.getByText('The votes are split')).toBeVisible();
    await expect(hostSheet.getByRole('heading', { name: 'Your vote' })).toBeVisible();
    await expect(hostSheet.getByRole('heading', { name: 'Your decision' })).toBeVisible();
    await expect(hostSheet.getByText('Move on finishes #1 and moves it to Discussed.')).toBeVisible();
    await expectNoA11yViolations(host);
    await hostSheet.getByRole('group', { name: 'Your vote' }).getByRole('button', { name: 'Keep going', exact: true }).click();
    // The buttons keep their places; only the line above them follows the votes.
    await expect(decision(host)).toHaveText(['Move on', 'Keep going for 30 more seconds']);
    await expect(hostSheet.getByText('Most votes say keep going')).toBeVisible();
    await hostSheet.getByRole('group', { name: 'More time' }).getByRole('button', { name: realLength('10 s') }).click();
    await expect(decision(host)).toHaveText(['Move on', 'Keep going for 10 more seconds']);
    await decision(host).nth(1).click();
    // Together, so every page's check falls inside the line's five seconds.
    await Promise.all([host, ann, ben].map(async (page) => {
      await expect(outcomeLine(page)).toHaveText('Keeping going for 10 more seconds', { timeout: NETWORK_WAIT });
      await expect(timeUpSheet(page)).toHaveCount(0);
    }));

    // The next time up is a new round: nothing pressed, and this device's last extension preselected.
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(timeUpSheet(ann).getByRole('button', { name: 'Keep going', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(timeUpSheet(host).getByRole('group', { name: 'More time' }).getByRole('button', { name: realLength('10 s') }))
      .toHaveAttribute('aria-pressed', 'true');

    // New timebox gives the topic a fresh timebox, which reads as keeping going.
    await timeUpSheet(host).getByRole('button', { name: 'New timebox' }).click();
    const restart = host.getByRole('dialog', { name: 'Start a timer for #1' });
    // Cancel goes back to the vote it interrupted.
    await restart.getByRole('button', { name: 'Cancel' }).click();
    await expect(timeUpSheet(host)).toBeVisible();
    await timeUpSheet(host).getByRole('button', { name: 'New timebox' }).click();
    await restart.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: realLength('20 s') }).click();
    await restart.getByRole('button', { name: START_BUTTON }).click();
    await expect(outcomeLine(ann)).toHaveText('Keeping going for 20 more seconds', { timeout: NETWORK_WAIT });

    await expect(timeUpSheet(host)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(decision(host).first()).toHaveText('Move on');
    await decision(host).first().click();
    await Promise.all([host, ann, ben].map((page) => expect(outcomeLine(page)).toHaveText('Moved on · Next topic coming up', { timeout: NETWORK_WAIT })));

    // Undo, for the facilitator only, puts the topic back at time's up with its vote open.
    await expect(host.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(ann.getByRole('button', { name: 'Undo' })).toHaveCount(0);
    await host.getByRole('button', { name: 'Undo' }).click();
    await expect(host.getByRole('group', { name: 'Next step' }).getByRole('button', { name: 'Decide' })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(outcomeLine(host)).toHaveCount(0);
    await expect(topicCard(ann, 'Pairing rotation').getByRole('button', { name: 'Vote on keep going', exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

// docs/product/mvp-screens.md, Focus: "New timebox" from the time-up sheet lands on the facilitator's primary action, and
// the timebox it starts is the one this device uses next.
test('New timebox from the time-up sheet leaves focus on the facilitator\'s primary action', async ({ page }) => {
  await hostMeeting(page, 'Hana', 'New timebox focus', { rehearsal: true });
  await addTopic(page, 'Pairing rotation');
  await page.getByRole('button', { name: 'Start discussion' }).click();
  await discussTopic(page, 'Pairing rotation', '10 s');
  await expect(timeUpSheet(page)).toBeVisible({ timeout: TIME_UP_WAIT });
  await timeUpSheet(page).getByRole('button', { name: 'New timebox' }).click();
  const restart = page.getByRole('dialog', { name: 'Start a timer for #1' });
  await restart.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: realLength('20 s') }).click();
  await restart.getByRole('button', { name: START_BUTTON }).click();
  await expect(restart).toHaveCount(0);
  await expect(timeUpSheet(page)).toHaveCount(0);
  const primary = page.locator('.rb-btn-primary[data-focus-fallback]');
  await expect(primary).toHaveCount(1);
  await expect(primary).toBeFocused();
  // Starting a timer is what makes its length the one this device preselects next time (a rehearsal 20 s is 2 minutes).
  expect(await page.evaluate(() => localStorage.getItem('rb-timebox'))).toBe('2');
});

test('a rehearsal board can give one topic a timebox in real minutes', async ({ page }) => {
  await hostMeeting(page, 'Hana', 'Real minutes', { rehearsal: true });
  await addTopic(page, 'Retro format');
  await page.getByRole('button', { name: 'Start discussion' }).click();
  await topicCard(page, 'Retro format').getByRole('button', { name: /^Discuss (?!#\d+$)/ }).click();
  const picker = page.getByRole('dialog', { name: 'Discuss #1' });
  await expect(picker.getByText('For this topic only. Otherwise a minute here lasts 10 seconds.')).toBeVisible();
  await picker.getByRole('switch', { name: 'Use real minutes' }).click();
  await expect(picker.getByRole('group', { name: 'Timebox' }).getByRole('button'))
    .toHaveText(['1 min', '2 min', '3 min', '4 min', '5 min', '10 min', '15 min', '20 min', '30 min']);
  await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: realLength('1 min') }).click();
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

// docs/product/mvp-screens.md, The time-up sheet, Stacking: when time runs out, a confirmation or the More sheet that is
// open closes first, and focus moves into the time-up sheet. The timebox picker cannot be open then: with a timer
// running, no Discuss or Start timer button opens it.
// Returns the text of the topic that waits in To discuss while the other one is timed.
async function startTwoTopicDiscussion(page: Page): Promise<string> {
  await addTopic(page, 'Pairing rotation');
  await addTopic(page, 'Release notes');
  // On a phone the bar hides while the add box has focus.
  await page.getByRole('textbox', { name: 'New topic' }).blur();
  await page.getByRole('button', { name: 'Start discussion' }).click();
  // The bar's Discuss button names the number of the topic it starts, on every width.
  const discuss = page.getByRole('group', { name: 'Next step' }).getByRole('button', { name: /^Discuss #\d+$/ });
  await expect(discuss).toBeVisible();
  await discuss.click();
  const picker = page.getByRole('dialog', { name: /^Discuss #\d+$/ });
  await expect(picker).toBeVisible();
  const timed = (await picker.getByText('Pairing rotation').count()) > 0 ? 'Pairing rotation' : 'Release notes';
  await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: realLength('20 s') }).click();
  await picker.getByRole('button', { name: START_BUTTON }).click();
  await expect(picker).toHaveCount(0);
  return timed === 'Pairing rotation' ? 'Release notes' : 'Pairing rotation';
}

test('a confirmation that is open when time runs out closes, and focus moves into the time-up sheet', async ({ browser }) => {
  test.slow();
  const context = await browser.newContext();
  try {
    const host = await context.newPage();
    await hostMeeting(host, 'Hana', 'Stacking check', { rehearsal: true });
    const waiting = await startTwoTopicDiscussion(host);

    // The Stop the timer confirmation.
    await host.getByRole('button', { name: 'Stop timer' }).click();
    const stop = host.getByRole('dialog', { name: 'Stop the timer?' });
    await expect(stop).toBeVisible();
    await expect(timeUpSheet(host)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(stop).toHaveCount(0);
    await expect(timeUpSheet(host).locator(':focus')).toHaveCount(1);

    // A delete confirmation, for a topic that waits in To discuss. Keep going starts a new timer.
    await timeUpSheet(host).getByRole('group', { name: 'More time' }).getByRole('button', { name: realLength('10 s') }).click();
    await timeUpSheet(host).getByRole('button', { name: /^Keep going for / }).click();
    await expect(timeUpSheet(host)).toHaveCount(0);
    await topicCard(host, waiting).getByRole('button', { name: 'Delete' }).click();
    const remove = host.getByRole('dialog', { name: /^Delete #\d+\?$/ });
    await expect(remove).toBeVisible();
    await expect(timeUpSheet(host)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(remove).toHaveCount(0);
    await expect(timeUpSheet(host).locator(':focus')).toHaveCount(1);
    // Nothing was half-done: the topic is still there.
    await expect(topicCard(host, waiting)).toBeVisible();
  } finally {
    await context.close();
  }
});

test('the More sheet that is open when time runs out closes, and focus moves into the time-up sheet', async ({ browser }) => {
  test.slow();
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await context.newPage();
    await hostMeeting(host, 'Hana', 'More stacking check', { rehearsal: true });
    await startTwoTopicDiscussion(host);
    await host.getByRole('group', { name: 'Next step' }).getByRole('button', { name: 'More' }).click();
    const more = host.getByRole('dialog', { name: 'More' });
    await expect(more).toBeVisible();
    await expect(more.getByRole('region', { name: 'Facilitator controls' })).toBeVisible();
    await expect(timeUpSheet(host)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(more).toHaveCount(0);
    await expect(timeUpSheet(host).locator(':focus')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

// docs/product/mvp-screens.md, The time-up sheet: "It opens by itself, on every tab, for people who join late too."
// The reload case is in join.spec.ts; this is a fresh join while the vote is open.
test('a participant who joins while the time-up vote is open sees the sheet and can vote', async ({ browser }) => {
  test.slow();
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    const [host, ann, ben] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Late joiner check', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await addTopic(host, 'Pairing rotation');
    await host.getByRole('button', { name: 'Start discussion' }).click();
    await discussTopic(host, 'Pairing rotation', '10 s');
    await expect(timeUpSheet(host)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: NETWORK_WAIT });
    await timeUpSheet(ann).getByRole('button', { name: 'Move on', exact: true }).click();
    await expect(timeUpSheet(host).getByText('1 voted · 2 here')).toBeVisible({ timeout: NETWORK_WAIT });

    // Ben joins now, with the vote open and the facilitator not yet deciding.
    await joinMeeting(ben, url, 'Ben');
    const benSheet = timeUpSheet(ben);
    await expect(benSheet).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(benSheet.getByText('#1 Pairing rotation')).toBeVisible();
    await expect(benSheet.getByText(HINT)).toBeVisible();
    // Before voting he sees no totals and no count of votes.
    await expect(benSheet.getByText(/Keep going \d+ · No preference/)).toHaveCount(0);
    await expect(benSheet.getByText(/present have voted/)).toHaveCount(0);
    for (const choice of ['Keep going', 'No preference', 'Move on']) {
      await expect(benSheet.getByRole('button', { name: choice, exact: true })).toBeEnabled();
    }
    await benSheet.getByRole('button', { name: 'Keep going', exact: true }).click();
    await expect(benSheet.getByRole('button', { name: 'Keep going', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(benSheet.getByText('Keep going 1 · No preference 0 · Move on 1')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(benSheet.getByText('2 of 3 present have voted')).toBeVisible();
    // The facilitator's totals count the late joiner's vote.
    await expect(timeUpSheet(host).getByText('2 voted · 3 here')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(timeUpSheet(host).getByText('Keep going 1 · No preference 0 · Move on 1')).toBeVisible();
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

// Recovery: the host's board lives in IndexedDB, so a reload resumes
// it. A reload with the timer running leaves the countdown to run out on time; a reload with the vote open keeps its
// totals, and the vote goes on to a decision that everyone sees.
test('the facilitator reloads the host tab mid-timer and mid-vote, and the vote resumes with its totals', async ({ browser }) => {
  test.slow();
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    const [host, ann, ben] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Host reload check', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await joinMeeting(ben, url, 'Ben');
    await addTopic(host, 'Pairing rotation');
    await host.getByRole('button', { name: 'Start discussion' }).click();
    await discussTopic(host, 'Pairing rotation', '20 s');

    // Mid-timer: the timer ran from here. A host that restarted its countdown on reload would reach time-up 5 s or more
    // after the original 20 s, so the sheet must arrive within the original timebox plus a margin for the poll.
    const timerStarted = Date.now();
    await expect(timeUpSheet(host)).toHaveCount(0);
    await host.waitForTimeout(5000);
    await host.reload();
    // The restored board shows the topic still being discussed, with its timer running.
    await expect(topicCard(host, 'Pairing rotation')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(host.getByRole('button', { name: 'Stop timer' })).toBeVisible();
    await expect(timeUpSheet(host)).toHaveCount(0);
    const remaining = timerStarted + 20_000 + 3000 - Date.now();
    expect(remaining, 'the host restored its board with the timer still running').toBeGreaterThan(0);
    await expect(timeUpSheet(host)).toBeVisible({ timeout: remaining });
    for (const page of [ann, ben]) await expect(timeUpSheet(page)).toBeVisible({ timeout: NETWORK_WAIT });

    // Mid-vote: two people have voted, then the host reloads.
    await timeUpSheet(ann).getByRole('button', { name: 'Keep going', exact: true }).click();
    await timeUpSheet(ben).getByRole('button', { name: 'Move on', exact: true }).click();
    await expect(timeUpSheet(host).getByText('2 voted · 3 here')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(timeUpSheet(host).getByText('Keep going 1 · No preference 0 · Move on 1')).toBeVisible();
    await host.reload();
    await expect(timeUpSheet(host)).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(timeUpSheet(host).getByText('Keep going 1 · No preference 0 · Move on 1')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(timeUpSheet(host).getByText('2 voted · 3 here')).toBeVisible({ timeout: NETWORK_WAIT });
    // The vote is still open for the facilitator's own ballot, and the participants' sheets are still open.
    await timeUpSheet(host).getByRole('group', { name: 'Your vote' }).getByRole('button', { name: 'Move on', exact: true }).click();
    await expect(timeUpSheet(host).getByText('Keep going 1 · No preference 0 · Move on 2')).toBeVisible({ timeout: NETWORK_WAIT });
    for (const page of [ann, ben]) await expect(timeUpSheet(page)).toBeVisible();
    await expect(timeUpSheet(ann).getByText('Keep going 1 · No preference 0 · Move on 2')).toBeVisible({ timeout: NETWORK_WAIT });

    await expect(decision(host).first()).toHaveText('Move on');
    await decision(host).first().click();
    await Promise.all([host, ann, ben].map((page) => expect(outcomeLine(page)).toHaveText('Moved on · Next topic coming up', { timeout: NETWORK_WAIT })));
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
