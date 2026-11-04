import { expect, test, type Page } from '@playwright/test';
import { addTopic, discussTopic, expectNoA11yViolations, hostMeeting, joinMeeting, NETWORK_WAIT, outcomeLine, topicCard } from './helpers';

const BANNER = /^Meeting ended · \d{1,2} [A-Z][a-z]{2} \d{4}$/;
const summary = (page: Page) => page.getByRole('region', { name: 'Final board' });
const facilitatorPanel = (page: Page) => page.getByRole('complementary', { name: 'Facilitator' });

test('everyone sees the final board, can copy it as text, and keeps it after the host goes away', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 360, height: 740 } });
  const benContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Ended check', { rehearsal: true });
    const ann = await annContext.newPage();
    await joinMeeting(ann, url, 'Ann');
    for (const text of ['Release notes', 'Hiring plan', 'Pairing rotation', 'Retro format']) await addTopic(host, text);
    await expect(topicCard(ann, 'Retro format')).toBeVisible({ timeout: NETWORK_WAIT });
    await topicCard(ann, 'Hiring plan').getByRole('button', { name: /^Vote for / }).click();
    await topicCard(ann, 'Hiring plan').getByRole('button', { name: /^Vote for / }).click();
    await topicCard(ann, 'Release notes').getByRole('button', { name: /^Vote for / }).click();
    await expect(ann.getByText('No votes left', { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });

    await host.getByRole('button', { name: 'Start discussion' }).click();
    await discussTopic(host, 'Release notes', '50 s');
    await host.getByRole('button', { name: 'Finish topic' }).click();
    await discussTopic(host, 'Hiring plan', '50 s');
    await host.getByRole('button', { name: 'Finish topic' }).click();
    // Ending with a topic in Discussing finishes it first.
    await discussTopic(host, 'Pairing rotation', '50 s');
    // The participant has focus in the add box, which the ending removes. A participant only reading, with focus on the body, keeps it.
    await ann.getByRole('textbox', { name: 'New topic' }).focus();
    await facilitatorPanel(host).getByRole('button', { name: 'End meeting' }).click();
    await host.getByRole('dialog', { name: 'End the meeting?' }).getByRole('button', { name: 'End meeting' }).click();

    await expect(ann.locator('.rb-banner-text')).toHaveText(BANNER, { timeout: NETWORK_WAIT });
    await expect(ann.getByText('This meeting has ended', { exact: true })).toBeVisible();
    await expect(host.getByText('This meeting has ended. Copy the outcome or reopen it')).toBeVisible();
    // No interim ended rendering is left: no next-topic prompt, no disabled actions, no stray outcome line.
    await expect(host.getByText('Next topic coming up')).toHaveCount(0);
    await expect(outcomeLine(host)).toHaveCount(0);
    await expect(outcomeLine(ann)).toHaveCount(0);
    // Focus never drops to the page body when the meeting ends under the focused control.
    await expect(facilitatorPanel(host).getByRole('button', { name: 'Copy as text' })).toBeFocused();
    await expect(ann.locator('.rb-banner').getByRole('button', { name: 'Copy as text' })).toBeFocused();

    const final = summary(ann);
    await expect(final.getByRole('heading')).toHaveText(['Discussed', 'Not discussed']);
    await expect(final.locator('ol .rb-card-text')).toHaveText(['Release notes', 'Hiring plan', 'Pairing rotation']);
    await expect(final.locator('ul .rb-card-text')).toHaveText(['Retro format']);
    await expect(final.getByRole('button')).toHaveCount(0);
    await expect(ann.getByRole('textbox', { name: 'New topic' })).toHaveCount(0);
    await expect(ann.locator('.rb-budget')).toHaveCount(0);
    expect(await ann.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectNoA11yViolations(ann);
    await expectNoA11yViolations(host);

    // Copy as text is on the banner for participants, and focus stays on it.
    await ann.locator('.rb-banner').getByRole('button', { name: 'Copy as text' }).click();
    await expect(ann.locator('.rb-banner').getByRole('button', { name: 'Copied' })).toBeVisible();
    await expect(ann.locator('.rb-banner').getByRole('button', { name: 'Copied' })).toBeFocused();
    await expect(ann.locator('[data-live-region]')).toHaveText('Outcome copied');
    expect(await ann.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp([
      '^Ended check',
      '\\d{1,2} [A-Z][a-z]+ \\d{4} · Rehearsal',
      '',
      'Discussed',
      '1\\. Release notes \\(1 vote\\)',
      '2\\. Hiring plan \\(2 votes\\)',
      '3\\. Pairing rotation \\(0 votes\\)',
      '',
      'Not discussed',
      '- Retro format \\(0 votes\\)',
      '$',
    ].join('\\n')));

    // Someone who joins after the end sees the final board straight away.
    const ben = await benContext.newPage();
    await ben.goto(url);
    await ben.getByRole('textbox', { name: 'Your name' }).fill('Ben');
    await ben.getByRole('button', { name: 'Take part' }).click();
    await expect(summary(ben).locator('ol .rb-card-text')).toHaveText(['Release notes', 'Hiring plan', 'Pairing rotation'], { timeout: NETWORK_WAIT });
    // The Take part button that had focus is gone, and the first view moves nothing: focus lands on Copy as text, not the body.
    await expect(ben.locator('.rb-banner').getByRole('button', { name: 'Copy as text' })).toBeFocused();

    // The host goes away: participants keep the ended view, with no connection banner.
    await hostContext.close();
    await ann.waitForTimeout(25_000);
    await expect(ann.locator('.rb-banner')).toHaveCount(1);
    await expect(ann.locator('.rb-banner-text')).toHaveText(BANNER);
    await expect(summary(ann).locator('ol .rb-card-text')).toHaveCount(3);
  } finally {
    await Promise.all([hostContext.close().catch(() => undefined), annContext.close(), benContext.close()]);
  }
});

test('a clipboard that is refused gives the outcome in a field to copy, and focus comes back to the button', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const annContext = await browser.newContext();
  try {
    await annContext.addInitScript(() => {
      Object.defineProperty(Clipboard.prototype, 'writeText', { configurable: true, value: () => Promise.reject(new Error('refused')) });
    });
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Refused copy');
    const ann = await annContext.newPage();
    await joinMeeting(ann, url, 'Ann');
    await addTopic(host, 'Release notes');
    await facilitatorPanel(host).getByRole('button', { name: 'End meeting' }).click();
    await host.getByRole('dialog', { name: 'End the meeting?' }).getByRole('button', { name: 'End meeting' }).click();
    const copy = ann.locator('.rb-banner').getByRole('button', { name: 'Copy as text' });
    await copy.click({ timeout: NETWORK_WAIT });
    const dialog = ann.getByRole('dialog', { name: 'Copy as text' });
    const field = dialog.getByRole('textbox', { name: 'Copy the text from here' });
    await expect(field).toHaveValue(/^Refused copy\n.*\n\nDiscussed\nNone\n\nNot discussed\n- Release notes \(0 votes\)\n$/);
    await expect(field).toBeFocused();
    await ann.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(copy).toBeFocused();
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});

test('Copy as text counts every vote, even while Show votes hides them, and participants never see them', async ({ browser }) => {
  const hostContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const annContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Hidden count');
    const ann = await annContext.newPage();
    await joinMeeting(ann, url, 'Ann');
    await addTopic(host, 'Release notes');
    const panel = facilitatorPanel(host);
    await panel.getByRole('switch', { name: 'Show votes' }).click();
    await topicCard(ann, 'Release notes').getByRole('button', { name: /^Vote for / }).click({ timeout: NETWORK_WAIT });
    await topicCard(ann, 'Release notes').getByRole('button', { name: /^Vote for / }).click();
    await expect(ann.getByText('1 vote left')).toBeVisible({ timeout: NETWORK_WAIT });
    // On screen the count is hidden from everyone, the facilitator too.
    await expect(topicCard(ann, 'Release notes').getByRole('img', { name: 'Votes hidden, 2 yours' })).toBeVisible();
    await expect(topicCard(host, 'Release notes').getByRole('img', { name: 'Votes hidden' })).toBeVisible();
    await expect(topicCard(host, 'Release notes').getByRole('img', { name: /\d votes?$/ })).toHaveCount(0);

    // From the topics phase, in the End meeting dialog: the real count.
    await panel.getByRole('button', { name: 'End meeting' }).click();
    const end = host.getByRole('dialog', { name: 'End the meeting?' });
    await end.getByRole('button', { name: 'Copy as text' }).click();
    await expect(end.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await host.evaluate(() => navigator.clipboard.readText())).toMatch(/\nNot discussed\n- Release notes \(2 votes\)\n$/);
    await end.getByRole('button', { name: 'End meeting' }).click();

    // From the ended view, in the action bar.
    await expect(summary(host)).toBeVisible({ timeout: NETWORK_WAIT });
    // What no longer applies is gone: the Facilitator controls (the engine refuses them) and the keep-this-page-open line.
    await expect(panel.getByRole('group', { name: 'Votes each' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Reset all votes' })).toHaveCount(0);
    await expect(panel.getByRole('switch', { name: 'Show votes' })).toHaveCount(0);
    await expect(panel.getByText('Timer sound')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Reopen meeting' })).toBeVisible();
    await expect(host.getByText('This meeting runs on this device. Keep this page open.')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Copy as text' }).click();
    await expect(panel.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await host.evaluate(() => navigator.clipboard.readText())).toMatch(/\nNot discussed\n- Release notes \(2 votes\)\n$/);
    // Once ended, everyone sees every count.
    await expect(topicCard(ann, 'Release notes').getByRole('img', { name: '2 votes, 2 yours' })).toBeVisible({ timeout: NETWORK_WAIT });
  } finally {
    await Promise.all([hostContext.close(), annContext.close()]);
  }
});
