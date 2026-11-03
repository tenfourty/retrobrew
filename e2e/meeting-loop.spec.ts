import { expect, test, type Page } from '@playwright/test';
import {
  addTopic, APP_PATH, discussTopic, expectNoA11yViolations, expectNoA11yViolationsInEveryTheme, hostMeeting, joinMeeting, NETWORK_WAIT,
  banner, outcomeLine, timeUpSheet, topicCard,
} from './helpers';

// The whole Lean Coffee loop on a rehearsal board, where a timebox minute lasts 10 seconds: a facilitator and two
// participants, from the first topic to Copy as text. Tests wait for sheets and outcomes, never countdown digits.
const TIME_UP_WAIT = 30_000;
const decision = (page: Page) => timeUpSheet(page).locator('.mtg-decision').getByRole('button');
const bar = (page: Page) => page.getByRole('group', { name: 'Next step' });
const panel = (page: Page) => page.getByRole('complementary', { name: 'Facilitator' });
const vote = (page: Page, topic: string) => topicCard(page, topic).getByRole('button', { name: 'Vote', exact: true });

test('a whole meeting runs from topics to Copy as text', async ({ browser }) => {
  test.setTimeout(240_000);
  const hostContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const annContext = await browser.newContext({ viewport: { width: 360, height: 740 } });
  const benContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Loop check', { rehearsal: true });
    const ann = await annContext.newPage();
    const ben = await benContext.newPage();
    await joinMeeting(ann, url, 'Ann');
    await joinMeeting(ben, url, 'Ben');
    await expect(host.getByRole('button', { name: '3 here' })).toBeVisible({ timeout: NETWORK_WAIT });

    // Topics, an edit, more votes and a reset.
    await addTopic(ann, 'Release notes');
    await addTopic(ben, 'Hiring plan');
    await addTopic(ben, 'Pairing rotation');
    await addTopic(host, 'Retro format');
    for (const page of [host, ann, ben]) {
      for (const text of ['Release notes', 'Hiring plan', 'Pairing rotation', 'Retro format']) {
        await expect(topicCard(page, text)).toBeVisible({ timeout: NETWORK_WAIT });
      }
    }
    await topicCard(ben, 'Pairing rotation').getByRole('button', { name: 'Edit' }).click();
    await ben.getByRole('textbox', { name: /^Edit #\d+$/ }).fill('Pairing rotation for new joiners');
    await ben.getByRole('textbox', { name: /^Edit #\d+$/ }).press('Enter');
    await expect(topicCard(ann, 'Pairing rotation for new joiners')).toBeVisible({ timeout: NETWORK_WAIT });
    await panel(host).getByRole('group', { name: 'Votes each' }).getByRole('button', { name: '5' }).click();
    await expect(ann.getByText('5 votes left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
    await vote(ann, 'Release notes').click();
    await expect(ann.getByText('4 votes left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
    await panel(host).getByRole('button', { name: 'Reset all votes' }).click();
    await host.getByRole('dialog', { name: 'Reset all votes?' }).getByRole('button', { name: 'Reset votes' }).click();
    await expect(ann.getByText('5 votes left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });

    // Real votes, then the discussion.
    for (const page of [ann, ben]) {
      await vote(page, 'Hiring plan').click();
      await vote(page, 'Hiring plan').click();
      await vote(page, 'Release notes').click();
      await expect(page.getByText('2 votes left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
    }
    await bar(host).getByRole('button', { name: 'Start discussion' }).click();
    const toDiscuss = host.getByRole('region', { name: 'To discuss' }).locator('.rb-card-text');
    await expect(toDiscuss.nth(0)).toHaveText('Hiring plan', { timeout: NETWORK_WAIT });
    await expect(toDiscuss.nth(1)).toHaveText('Release notes', { timeout: NETWORK_WAIT });
    await expect(bar(host).getByRole('button')).toHaveText([/^Discuss #\d+$/]);

    // Any topic can be discussed, not only the top one: stop, restart and return it.
    await discussTopic(host, 'Retro format', '10 s');
    await bar(host).getByRole('button', { name: 'Stop timer' }).click();
    await bar(host).getByRole('button', { name: 'Start timer' }).click();
    const restart = host.getByRole('dialog', { name: /^Start a timer for #\d+$/ });
    await restart.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: '20 s', exact: true }).click();
    await restart.getByRole('button', { name: 'Start 20 s' }).click();
    await bar(host).getByRole('button', { name: 'Return topic' }).click();
    await expect(bar(host).getByRole('button')).toHaveText([/^Discuss #\d+$/]);

    // The top topic, a time-up vote with turnout, an extension, then moving on.
    await bar(host).getByRole('button', { name: /^Discuss #\d+$/ }).click();
    const picker = host.getByRole('dialog', { name: /^Discuss #\d+$/ });
    await expect(picker.getByText('Hiring plan')).toBeVisible();
    await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: '10 s', exact: true }).click();
    await picker.getByRole('button', { name: 'Start 10 s' }).click();
    for (const page of [host, ann, ben]) await expect(timeUpSheet(page)).toBeVisible({ timeout: TIME_UP_WAIT });
    await timeUpSheet(ann).getByRole('button', { name: 'Keep going', exact: true }).click();
    await timeUpSheet(ben).getByRole('button', { name: 'Keep going', exact: true }).click();
    await expect(timeUpSheet(host).getByText('2 voted · 3 here')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(timeUpSheet(ben).getByText('2 of 3 present have voted')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(decision(host)).toHaveText(['Keep going for 30 more seconds', 'Or move on']);
    await timeUpSheet(host).getByRole('group', { name: 'More time' }).getByRole('button', { name: '10 s', exact: true }).click();
    await decision(host).first().click();
    await Promise.all([host, ann, ben].map((page) =>
      expect(outcomeLine(page)).toHaveText('Keeping going for 10 more seconds', { timeout: NETWORK_WAIT })));
    await expect(timeUpSheet(ann)).toHaveCount(0, { timeout: NETWORK_WAIT });
    await expect(timeUpSheet(ann)).toBeVisible({ timeout: TIME_UP_WAIT });
    await timeUpSheet(ann).getByRole('button', { name: 'Move on', exact: true }).click();
    await expect(decision(host)).toHaveText(['Move on', 'Or keep going for 10 more seconds'], { timeout: NETWORK_WAIT });
    await decision(host).first().click();
    await Promise.all([host, ann, ben].map((page) =>
      expect(outcomeLine(page)).toHaveText('Moved on to the next topic', { timeout: NETWORK_WAIT })));

    // A second topic finished from the bar, then back to topics to collect more.
    await bar(host).getByRole('button', { name: /^Discuss #\d+$/ }).click();
    await host.getByRole('dialog', { name: /^Discuss #\d+$/ }).getByRole('button', { name: /^Start / }).click();
    await bar(host).getByRole('button', { name: 'Finish topic' }).click();
    await expect(ann.getByRole('tab', { name: /^Discussed/ })).toHaveAccessibleName('Discussed 2', { timeout: NETWORK_WAIT });
    await panel(host).getByRole('button', { name: 'Back to topics' }).click();
    await addTopic(ann, 'Onboarding buddies');
    await expect(topicCard(host, 'Onboarding buddies')).toBeVisible({ timeout: NETWORK_WAIT });
    await bar(host).getByRole('button', { name: 'Start discussion' }).click();

    // End with a topic in Discussing, copy the outcome, then reopen.
    await discussTopic(host, 'Onboarding buddies', '50 s');
    await bar(host).getByRole('button', { name: 'Finish topic' }).waitFor();
    await panel(host).getByRole('button', { name: 'End meeting' }).click();
    await host.getByRole('dialog', { name: 'End the meeting?' }).getByRole('button', { name: 'End meeting' }).click();
    await expect(banner(ann, 'Meeting ended')).toBeVisible({ timeout: NETWORK_WAIT });
    await bar(host).getByRole('button', { name: 'Copy as text' }).click();
    await expect(bar(host).getByRole('button', { name: 'Copied' })).toBeVisible();
    const copied = await host.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(new RegExp([
      '^Loop check',
      '\\d{1,2} [A-Z][a-z]+ \\d{4} · Rehearsal',
      '',
      'Discussed',
      '1\\. Hiring plan \\(4 votes\\)',
      '2\\. Release notes \\(2 votes\\)',
      '3\\. Onboarding buddies \\(0 votes\\)',
      '',
      'Not discussed',
      '- .+ \\(0 votes\\)',
      '- .+ \\(0 votes\\)',
      '$',
    ].join('\\n')));
    // Each undiscussed topic is listed exactly once.
    expect(copied.trimEnd().split('\n').slice(-2).sort()).toEqual(['- Pairing rotation for new joiners (0 votes)', '- Retro format (0 votes)']);
    await expectNoA11yViolations(ann);
    await bar(host).getByRole('button', { name: 'Reopen meeting' }).click();
    await expect(banner(ann, 'Meeting ended')).toHaveCount(0, { timeout: NETWORK_WAIT });
    await expect(ann.getByRole('tab', { name: /^To discuss/ })).toBeVisible();
  } finally {
    await Promise.all([hostContext.close(), annContext.close(), benContext.close()]);
  }
});

test('a stranger on a 360 px phone starts a meeting, shares it by QR, and a second phone joins', async ({ browser }) => {
  const phone = { viewport: { width: 360, height: 740 }, permissions: ['clipboard-read', 'clipboard-write'] };
  const hostContext = await browser.newContext(phone);
  const guestContext = await browser.newContext(phone);
  const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  try {
    const host = await hostContext.newPage();
    await host.goto('/');
    await host.getByRole('main').getByRole('link', { name: 'Start a meeting' }).click();
    await host.waitForURL((u) => u.pathname === APP_PATH && u.hash === '#start');
    expect(await noSideScroll(host)).toBe(true);
    await host.getByRole('textbox', { name: 'Meeting name' }).fill('Friday Lean Coffee');
    await host.getByRole('textbox', { name: 'Your name' }).fill('Hana');
    await host.getByRole('button', { name: 'Create meeting' }).click();
    const sheet = host.getByRole('dialog', { name: 'Invite people' });
    const qr = sheet.getByRole('img', { name: 'QR code for the meeting link' });
    await expect(qr).toBeVisible({ timeout: NETWORK_WAIT });
    expect((await qr.boundingBox())!.width).toBeGreaterThanOrEqual(240);
    expect(await noSideScroll(host)).toBe(true);
    await expectNoA11yViolations(host);
    // Nothing here reads what the QR encodes; the second phone opens the copied link.
    await sheet.getByRole('button', { name: 'Copy link' }).click();
    const link = await host.evaluate(() => navigator.clipboard.readText());
    expect(link).toBe(host.url());
    await sheet.getByRole('button', { name: 'Done' }).click();

    const guest = await guestContext.newPage();
    await joinMeeting(guest, link, 'Sam');
    expect(await noSideScroll(guest)).toBe(true);
    await addTopic(host, 'What should we try next sprint?');
    await expect(topicCard(guest, 'What should we try next sprint?')).toBeVisible({ timeout: NETWORK_WAIT });
    expect(await noSideScroll(guest)).toBe(true);
    expect(await noSideScroll(host)).toBe(true);
    await expectNoA11yViolationsInEveryTheme(guest);
    await expectNoA11yViolationsInEveryTheme(host);
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
