import { expect, test } from '@playwright/test';
import { addTopic, canary, collectPageErrors, connectionLine, forceNoDirectPath, hostMeeting, joinMeeting, topicCard } from './helpers';

test('a participant with no direct path takes part through the relays', { tag: '@public' }, async ({ browser }) => {
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  await forceNoDirectPath(participantContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];
  const name = canary('Relayed');
  const topic = canary('Topic ');

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, name);
    await addTopic(participant, topic);
    await expect(topicCard(host, topic)).toBeVisible();
    await topicCard(participant, topic).getByRole('button', { name: /^Vote for / }).click();
    await expect(participant.getByText('2 votes left')).toBeVisible();
    await expect(topicCard(host, topic).getByRole('img', { name: /^1 vote/ })).toBeVisible();

    // Give WebRTC every chance to connect; it must not.
    await host.waitForTimeout(15_000);
    await expect(await connectionLine(host, name)).toContainText('Through relays');
    await expect(await connectionLine(host, name)).not.toContainText('Direct');
    expect(errors).toEqual([]);
  } finally {
    test.info().annotations.push(...errors.map((description) => ({ type: 'pageerror', description })));
    await hostContext.close();
    await participantContext.close();
  }
});
