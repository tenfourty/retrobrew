import { expect, test } from '@playwright/test';
import { addTopic, canary, collectPageErrors, connectionLine, hostMeeting, joinMeeting, removeWebRTC, topicCard } from './helpers';

test('a participant whose browser has no WebRTC takes part through the relays', { tag: '@public' }, async ({ browser }) => {
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  await removeWebRTC(participantContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];
  const name = canary('NoRtc');
  const topic = canary('Topic ');

  try {
    const url = await hostMeeting(host, 'Host');
    await participant.goto(url);
    expect(await participant.evaluate(() => typeof (window as unknown as Record<string, unknown>).RTCPeerConnection)).toBe('undefined');
    await joinMeeting(participant, url, name);
    await addTopic(participant, topic);
    await expect(topicCard(host, topic)).toBeVisible();
    await topicCard(participant, topic).getByRole('button', { name: 'Vote', exact: true }).click();
    await expect(participant.getByText('2 votes left')).toBeVisible();
    await expect(topicCard(host, topic).getByRole('img', { name: /^1 vote/ })).toBeVisible();
    await expect(await connectionLine(host, name)).toContainText('Through relays');
    expect(errors).toEqual([]);
  } finally {
    test.info().annotations.push(...errors.map((description) => ({ type: 'pageerror', description })));
    await hostContext.close();
    await participantContext.close();
  }
});
