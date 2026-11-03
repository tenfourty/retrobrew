import { expect, test, type Page } from '@playwright/test';
import { addTopic, canary, collectPageErrors, describeSends, hostMeeting, joinMeeting, NETWORK_WAIT, recordWsFrames, removeWebRTC, topicCard } from '../helpers';
import { restartRelay } from '../relay/restart';

// Counts the WebSockets a page opens from now on.
function countSockets(page: Page): () => number {
  let opened = 0;
  page.on('websocket', () => { opened++; });
  return () => opened;
}

// Runs on its own, after the rest of the battery (project local-restart), because it restarts the shared relay.
test('the meeting carries on after the relay restarts: everyone reconnects and subscribes again', async ({ browser }) => {
  const contexts = [await browser.newContext(), await browser.newContext()];
  // Relays only, so the restart is felt: a direct connection would carry the topics whatever the relay did.
  for (const context of contexts) await removeWebRTC(context);
  const [host, participant] = (await Promise.all(contexts.map((c) => c.newPage()))) as [Page, Page];
  const frames = [recordWsFrames(host), recordWsFrames(participant)];
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];

  let finished = false;
  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, canary('Relayed'));
    const socketsOpened = [countSockets(host), countSockets(participant)];
    const framesBefore = frames.map((f) => f.length);
    // A server-side restart: every socket drops, and a relay that never reconnected would deliver nothing again.
    restartRelay();
    const fromParticipant = canary('After the restart ');
    await addTopic(participant, fromParticipant);
    await expect(topicCard(host, fromParticipant)).toBeVisible({ timeout: 2 * NETWORK_WAIT });
    const fromHost = canary('And back ');
    await addTopic(host, fromHost);
    await expect(topicCard(participant, fromHost)).toBeVisible({ timeout: NETWORK_WAIT });

    // The restart was felt: each page opened new sockets after it and subscribed again on them.
    for (const [i, who] of ['host', 'participant'].entries()) {
      expect(socketsOpened[i]!(), `${who} opened new sockets`).toBeGreaterThan(0);
      const after = frames[i]!.slice(framesBefore[i]);
      expect(after.some((f) => f.dir === 'sent' && f.payload.startsWith('["REQ"')), `${who} subscribed again`).toBe(true);
    }
    expect(errors).toEqual([]);
    finished = true;
  } finally {
    if (!finished) for (const [i, who] of ['host', 'participant'].entries()) console.log(`${who} relay events (restart at the first SOCKET CLOSED):\n${describeSends(frames[i]!)}`);
    await Promise.all(contexts.map((c) => c.close()));
  }
});
