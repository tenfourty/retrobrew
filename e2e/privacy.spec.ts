import { expect, test } from '@playwright/test';
import { addTopic, canary, forceNoDirectPath, hostMeeting, joinMeeting, nostrEvents, RELAY_EVENT_KIND, recordWsFrames, topicCard } from './helpers';

const BASE64URL = /^[A-Za-z0-9_-]+$/;
// e: 1 marks a relay ping that its sender wants echoed back (docs/product/sync-protocol.md, Paths).
const ALLOWED_KEYS = new Set(['from', 'to', 'd', 'e']);

test('relays never see topics or names in the clear', { tag: '@public' }, async ({ browser }) => {
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  // Keep the participant on the relay path: with a fast relay, a direct connection could otherwise carry everything.
  await forceNoDirectPath(participantContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const frames = recordWsFrames(participant);
  const meetingName = canary('Meeting');
  const name = canary('Person');
  const topic = canary('Topic');

  try {
    const url = await hostMeeting(host, 'Host', meetingName);
    await joinMeeting(participant, url, name);
    await addTopic(participant, topic);
    await expect(topicCard(host, topic)).toBeVisible();
    await topicCard(participant, topic).getByRole('button', { name: 'Vote', exact: true }).click();
    await expect(participant.getByText('2 votes left')).toBeVisible();
    // Let a few heartbeats and snapshots go by.
    await participant.waitForTimeout(3000);

    const leaks = frames.filter((f) => [topic, name, meetingName].some((secret) => f.payload.includes(secret)));
    expect(leaks.map((f) => `${f.dir} ${f.url}: ${f.payload.slice(0, 200)}`)).toEqual([]);

    const appEvents = nostrEvents(frames).filter(({ event }) => event.kind === RELAY_EVENT_KIND);
    expect(appEvents.length).toBeGreaterThan(0);
    const problems: string[] = [];
    let withPayload = 0;
    for (const { event } of appEvents) {
      let content: Record<string, unknown>;
      try {
        content = JSON.parse(event.content) as Record<string, unknown>;
      } catch {
        problems.push(`content is not JSON: ${event.content.slice(0, 80)}`);
        continue;
      }
      const extra = Object.keys(content).filter((k) => !ALLOWED_KEYS.has(k));
      if (extra.length) problems.push(`unexpected keys ${extra.join(', ')}`);
      if (content.e !== undefined && content.e !== 1) problems.push(`e is not 1: ${String(content.e)}`);
      if (content.d === undefined) continue;
      withPayload++;
      if (typeof content.d !== 'string' || !BASE64URL.test(content.d)) problems.push(`d is not base64url: ${String(content.d).slice(0, 40)}`);
    }
    expect(problems).toEqual([]);
    expect(withPayload).toBeGreaterThan(0);
    test.info().annotations.push({
      type: 'frames',
      description: `${frames.length} frames, ${appEvents.length} kind-${RELAY_EVENT_KIND} events, ${withPayload} with a payload`,
    });
  } finally {
    await hostContext.close();
    await participantContext.close();
  }
});
