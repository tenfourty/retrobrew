import { expect, test } from '@playwright/test';
import { hostMeeting } from './helpers';
import { LOCAL_RELAY_URLS } from './relay/settings';

test('the local battery talks to the local relay, under both its names, and nothing else', async ({ page }) => {
  const sockets: string[] = [];
  page.on('websocket', (ws) => sockets.push(ws.url()));
  await hostMeeting(page, 'Host');
  const usedName = (relay: string) => sockets.some((url) => url.startsWith(relay));
  await expect.poll(() => LOCAL_RELAY_URLS.every(usedName)).toBe(true);
  expect(sockets.filter((url) => !LOCAL_RELAY_URLS.some((relay) => url.startsWith(relay)))).toEqual([]);
});
