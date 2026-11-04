import { expect, test } from '@playwright/test';
import { addTopic, APP_PATH, banner, discussTopic, hostMeeting, installNetworkHooks, NETWORK_WAIT } from './helpers';

const WARNING = 'This meeting is also open as facilitator in another browser. Close it in one of them, or changes made in each will not match.';

test('a backup restored in a second browser warns both facilitator pages', async ({ browser }, testInfo) => {
  test.slow();
  const firstContext = await browser.newContext({ acceptDownloads: true });
  const secondContext = await browser.newContext();
  try {
    await installNetworkHooks(firstContext);
    await installNetworkHooks(secondContext);
    const first = await firstContext.newPage();
    await hostMeeting(first, 'Olu', 'Two browsers', { rehearsal: true });
    await expect(banner(first, WARNING)).toHaveCount(0);

    // The backup button is on the action bar of an ended meeting: run a one-topic meeting to its end.
    const bar = first.getByRole('group', { name: 'Next step' });
    await addTopic(first, 'Pairing');
    await first.getByRole('textbox', { name: 'New topic' }).blur();
    await bar.getByRole('button', { name: 'Start discussion' }).click();
    await discussTopic(first, 'Pairing', '10 s');
    await bar.getByRole('button', { name: 'Finish topic' }).click();
    await bar.getByRole('button', { name: 'End meeting' }).click();
    await first.getByRole('dialog', { name: 'End the meeting?' }).getByRole('button', { name: 'End meeting' }).click();
    await bar.getByRole('button', { name: 'Back up meeting file' }).click();
    const download = first.waitForEvent('download');
    await first.getByRole('dialog', { name: 'Back up meeting file' }).getByRole('button', { name: 'Download file' }).click();
    const file = testInfo.outputPath('two-browsers.retrobrew.json');
    await (await download).saveAs(file);

    const second = await secondContext.newPage();
    await second.goto(APP_PATH);
    await second.getByLabel('Open a meeting file').setInputFiles(file);
    // The restored meeting is an ended one: it shows the ended banner, not the add box.
    await expect(second.getByText(/^Meeting ended/).first()).toBeVisible({ timeout: NETWORK_WAIT });

    await expect(banner(first, WARNING)).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(banner(second, WARNING)).toBeVisible({ timeout: NETWORK_WAIT });
  } finally {
    await Promise.all([firstContext.close(), secondContext.close()]);
  }
});
