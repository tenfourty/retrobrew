import { readFile, writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { COPY } from '../src/app/banners';
import { MAX_TOPICS } from '../src/engine/limits';
import { addTopic, APP_PATH, banner, discussTopic, hostMeeting, installNetworkHooks, NETWORK_WAIT } from './helpers';

// R75 with a real file: a meeting file holding more topics than the cap still opens, and the facilitator sees the
// over-limits banner (docs/product/lean-coffee-rules.md, Limits). banners.spec.ts forces the signal; this one imports.

test('importing a meeting file with more topics than the limit shows the over-limits banner', async ({ browser }, testInfo) => {
  test.slow();
  const firstContext = await browser.newContext({ acceptDownloads: true });
  const secondContext = await browser.newContext();
  try {
    await installNetworkHooks(firstContext);
    await installNetworkHooks(secondContext);
    const first = await firstContext.newPage();
    await hostMeeting(first, 'Olu', 'Too many topics', { rehearsal: true });

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
    const saved = testInfo.outputPath('backup.retrobrew.json');
    await (await download).saveAs(saved);
    // The importing browser must be the only facilitator: a second one would raise the other-browser banner, which
    // outranks the over-limits one. Storage is per context, so the import needs its own; the first one must be gone.
    await firstContext.close();

    // Make it a live meeting one topic over the cap: reopen the phase and add filler topics to the board in the file.
    const file = JSON.parse(await readFile(saved, 'utf8'));
    const state = file.board.state;
    state.phase = 'topics';
    state.endedAt = null;
    state.timer = null;
    state.continueVote = null;
    state.moveOnUndo = null;
    const author = Object.keys(state.attendees)[0];
    const next = state.topicIdSeed;
    for (let i = 0; i <= MAX_TOPICS; i++) {
      state.topics.push({ topicId: next + i, text: `Filler ${i}`, column: 'ideas', position: 1000 + i, authorId: author, voters: [] });
    }
    state.topicIdSeed = next + MAX_TOPICS + 1;
    expect(state.topics.length).toBeGreaterThan(MAX_TOPICS);
    const over = testInfo.outputPath('over-limit.retrobrew.json');
    await writeFile(over, JSON.stringify(file));

    const second = await secondContext.newPage();
    await second.goto(APP_PATH);
    await second.getByLabel('Open a meeting file').setInputFiles(over);
    await expect(banner(second, COPY.overLimits)).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(banner(second, COPY.otherBrowser)).toHaveCount(0);
    await expect(second.getByText('Filler 0').first()).toBeVisible();
  } finally {
    await Promise.all([firstContext.close().catch(() => undefined), secondContext.close()]);
  }
});
