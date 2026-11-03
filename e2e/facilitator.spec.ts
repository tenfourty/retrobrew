import { expect, test, type Page } from '@playwright/test';
import { addTopic, hostMeeting, joinMeeting, NETWORK_WAIT, timeUpSheet, topicCard } from './helpers';

const TIME_UP_WAIT = 30_000;

// The facilitator's next-step buttons: in the side panel on wide screens, in the dock on phones.
const nextStep = (page: Page) => page.getByRole('group', { name: 'Next step' });

async function pickTimebox(page: Page, title: string, timebox: string): Promise<void> {
  const picker = page.getByRole('dialog', { name: title });
  await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: timebox, exact: true }).click();
  await picker.getByRole('button', { name: `Start ${timebox}` }).click();
}

test('the side panel follows the facilitator through the whole meeting', async ({ browser }) => {
  test.slow();
  const hostContext = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const guestContext = await browser.newContext();
  try {
    const host = await hostContext.newPage();
    const url = await hostMeeting(host, 'Hana', 'Bar check', { rehearsal: true });
    const guest = await guestContext.newPage();
    await joinMeeting(guest, url, 'Ann');
    const panel = host.getByRole('complementary', { name: 'Facilitator' });
    const bar = nextStep(host);
    await expect(bar.getByRole('button')).toHaveText(['Invite people']);
    await expect(panel.getByRole('button', { name: 'Facilitator' })).toHaveCount(0);
    const votesEach = panel.getByRole('group', { name: 'Votes each' });
    await expect(votesEach.getByRole('button')).toHaveText(['3', '5', '8', '10']);
    await expect(votesEach).toHaveAccessibleDescription('The allowance can go up but not down');

    await addTopic(guest, 'Pairing rotation');
    await expect(bar.getByRole('button')).toHaveText(['Start discussion', 'Invite people'], { timeout: NETWORK_WAIT });
    await votesEach.getByRole('button', { name: '5' }).click();
    await expect(guest.getByText('5 votes left')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(votesEach.getByRole('button', { name: '3' })).toBeDisabled();
    await expect(votesEach.getByRole('button', { name: '5' })).toHaveAttribute('aria-pressed', 'true');

    await topicCard(guest, 'Pairing rotation').getByRole('button', { name: 'Vote', exact: true }).click();
    await expect(guest.getByText('4 votes left')).toBeVisible({ timeout: NETWORK_WAIT });
    await panel.getByRole('button', { name: 'Reset all votes' }).click();
    const reset = host.getByRole('dialog', { name: 'Reset all votes?' });
    await expect(reset.getByText("This removes every vote on topics that haven't been discussed, and gives them back. Votes on discussed topics stay spent.")).toBeVisible();
    await expect(reset.getByRole('button')).toHaveText(['Reset votes', 'Cancel']);
    await reset.getByRole('button', { name: 'Reset votes' }).click();
    await expect(guest.getByText('5 votes left')).toBeVisible({ timeout: NETWORK_WAIT });

    const showVotes = panel.getByRole('switch', { name: 'Show votes' });
    await expect(showVotes).toHaveAccessibleDescription("Hidden on screen. It doesn't make votes secret from other attendees.");
    await bar.getByRole('button', { name: 'Start discussion' }).click();
    await expect(bar.getByRole('button')).toHaveText(['Discuss #1']);
    // The primary keeps focus when the row changes under it.
    await expect(bar.getByRole('button', { name: 'Discuss #1' })).toBeFocused();
    await expect(showVotes).toBeDisabled();
    await expect(panel.getByText('Votes always show once the discussion starts')).toBeVisible();

    await bar.getByRole('button', { name: 'Discuss #1' }).click();
    await pickTimebox(host, 'Discuss #1', '10 s');
    await expect(bar.getByRole('button')).toHaveText(['Finish topic', 'Stop timer', 'Return topic']);
    await expect(panel.getByRole('button', { name: 'Back to topics' })).toBeDisabled();
    await expect(panel.getByRole('button', { name: 'Back to topics' })).toHaveAccessibleDescription('Finish or return the topic being discussed first');
    await bar.getByRole('button', { name: 'Stop timer' }).click();
    await expect(bar.getByRole('button')).toHaveText(['Finish topic', 'Start timer', 'Return topic']);
    await bar.getByRole('button', { name: 'Start timer' }).click();
    await pickTimebox(host, 'Start a timer for #1', '10 s');

    await expect(timeUpSheet(host)).toBeVisible({ timeout: TIME_UP_WAIT });
    await host.keyboard.press('Escape');
    await expect(bar.getByRole('button')).toHaveText(['Decide', 'Stop timer']);
    await bar.getByRole('button', { name: 'Decide' }).click();
    await expect(timeUpSheet(host).locator('.mtg-decision-primary')).toBeFocused();
    await host.keyboard.press('Escape');
    // Stop timer while the vote is open keeps the topic going, untimed.
    await bar.getByRole('button', { name: 'Stop timer' }).click();
    await expect(timeUpSheet(guest)).toHaveCount(0, { timeout: NETWORK_WAIT });
    await expect(bar.getByRole('button')).toHaveText(['Finish topic', 'Start timer', 'Return topic']);
    await bar.getByRole('button', { name: 'Return topic' }).click();
    await expect(bar.getByRole('button')).toHaveText(['Discuss #1']);

    await bar.getByRole('button', { name: 'Discuss #1' }).click();
    await pickTimebox(host, 'Discuss #1', '50 s');
    await bar.getByRole('button', { name: 'Finish topic' }).click();
    await expect(bar.getByRole('button')).toHaveText(['Back to topics', 'End meeting']);

    await bar.getByRole('button', { name: 'End meeting' }).click();
    const end = host.getByRole('dialog', { name: 'End the meeting?' });
    await expect(end.getByText('Everyone sees the final board, and nobody can add or vote. You can reopen it later.')).toBeVisible();
    await expect(end.getByRole('button')).toHaveText(['Copy as text', 'End meeting', 'Cancel']);
    await end.getByRole('button', { name: 'Copy as text' }).click();
    await expect(end.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await host.evaluate(() => navigator.clipboard.readText()))
      .toMatch(/^Bar check\n\d{1,2} [A-Z][a-z]+ \d{4} · Rehearsal\n\nDiscussed\n1\. Pairing rotation \(0 votes\)\n$/);
    await end.getByRole('button', { name: 'End meeting' }).click();
    await expect(bar.getByRole('button')).toHaveText(['Copy as text', 'Reopen meeting', 'Back up meeting file']);
    // The controls stay once the meeting has ended, without End meeting.
    await expect(panel.getByRole('heading', { name: 'Facilitator' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'End meeting' })).toHaveCount(0);

    await bar.getByRole('button', { name: 'Back up meeting file' }).click();
    const backUp = host.getByRole('dialog', { name: 'Back up meeting file' });
    await expect(backUp.getByText("This file holds the meeting's keys. Anyone who has it can open and run this meeting, so keep it somewhere private.")).toBeVisible();
    const download = host.waitForEvent('download');
    await backUp.getByRole('button', { name: 'Download file' }).click();
    expect((await download).suggestedFilename()).toBe('Bar check.retrobrew.json');

    await bar.getByRole('button', { name: 'Reopen meeting' }).click();
    await expect(bar.getByRole('button')).toHaveText(['Back to topics', 'End meeting']);
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});

test('phones fold extra actions into More, with the Facilitator controls below them', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 740 } });
  try {
    const host = await context.newPage();
    await hostMeeting(host, 'Hana', 'Phone bar', { rehearsal: true });
    const bar = nextStep(host);
    await expect(bar.getByRole('button')).toHaveText(['Facilitator', 'Invite people']);
    await bar.getByRole('button', { name: 'Facilitator' }).click();
    const sheet = host.getByRole('dialog', { name: 'Facilitator' });
    await expect(sheet.getByRole('group', { name: 'Votes each' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'End meeting' })).toBeVisible();
    await host.keyboard.press('Escape');

    await addTopic(host, 'Pairing rotation');
    // The bar hides while the add box has focus, so the keyboard has room.
    await host.getByRole('textbox', { name: 'New topic' }).blur();
    await expect(bar.getByRole('button')).toHaveText(['More', 'Start discussion']);
    await bar.getByRole('button', { name: 'More' }).click();
    const more = host.getByRole('dialog', { name: 'More' });
    await expect(more.getByRole('listitem')).toHaveText(['Invite people']);
    await expect(more.getByRole('group', { name: 'Votes each' })).toBeVisible();
    await more.getByRole('listitem').getByRole('button', { name: 'Invite people' }).click();
    await expect(host.getByRole('dialog', { name: 'Invite people' })).toBeVisible();
    await expect(more).toHaveCount(0);
    await host.getByRole('dialog', { name: 'Invite people' }).getByRole('button', { name: 'Done' }).click();

    // The bar fits at 320 px, primary on the right.
    await host.setViewportSize({ width: 320, height: 640 });
    const [other, primary] = await Promise.all([bar.getByRole('button', { name: 'More' }).boundingBox(), bar.getByRole('button', { name: 'Start discussion' }).boundingBox()]);
    expect(primary!.x).toBeGreaterThan(other!.x);
    expect(primary!.x + primary!.width).toBeLessThanOrEqual(320);
    expect(await host.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await bar.getByRole('button', { name: 'Start discussion' }).click();
    await expect(bar.getByRole('button')).toHaveText(['Facilitator', 'Discuss #1']);
    await bar.getByRole('button', { name: 'Discuss #1' }).click();
    await pickTimebox(host, 'Discuss #1', '50 s');
    await bar.getByRole('button', { name: 'More' }).click();
    await expect(more.getByRole('listitem')).toHaveText(['Stop timer', 'Return topic']);
    await more.getByRole('button', { name: 'End meeting' }).click();
    const end = host.getByRole('dialog', { name: 'End the meeting?' });
    await expect(end.getByText('#1 moves to Discussed.')).toBeVisible();
    await end.getByRole('button', { name: 'Cancel' }).click();
    await expect(end).toHaveCount(0);
  } finally {
    await context.close();
  }
});
