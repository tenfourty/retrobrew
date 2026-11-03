import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { canary, collectPageErrors, hostMeeting, installNetworkHooks, joinMeeting } from './helpers';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Trystero keeps a pool of ready offers and refreshes any over 57 s old when it hands it out; before the fix in
// src/transport/restart-offer.ts that offer had no transport in it and never connected. Which of two pages
// makes the offer depends on the order of their peer IDs, which are random: the lower one leads. The test needs both
// directions, so it first opens hosts until one's ID is mid-range (its first character within the middle fifth of the
// sorted alphabet Trystero draws from, so each joiner is about as likely to lead as not), and then lets people join a
// host that has been running for 65 s, at least 3 of them and then one at a time until the host has led one and one has
// led the host (at most MAX_JOINERS, a miss of 1 in a million or less), so every run exercises the fix both ways; each
// must get a direct connection, which the host's room lists. Rehearsal timing cannot shorten the 57 s: it is
// Trystero's own, in real time.
const MIN_JOINERS = 3;
const MAX_JOINERS = 30;
const MAX_HOSTS = 40;
// The alphabet of Trystero's peer IDs; IDs compare as strings, so a character's rank is its place once sorted.
const ID_ALPHABET = [...'0123456789AaBbCcDdEeFfGgHhIiJjKkLlMmNnOoPpQqRrSsTtUuVvWwXxYyZz'].sort();
const isMidRange = (id: string) => {
  const rank = ID_ALPHABET.indexOf(id[0]!);
  return rank >= 25 && rank <= 36;
};

test('people who join a meeting over a minute old get a direct connection, whichever page makes the offer', async ({ browser }) => {
  test.setTimeout(300_000);
  const contexts: BrowserContext[] = [];
  const errorLists: string[][] = [];
  const directPeers = (page: Page) => page.evaluate(() => {
    if (!window.__rbDirectPeers) throw new Error('the host page has no direct-peers hook: is this an e2e build?');
    return window.__rbDirectPeers();
  });

  try {
    let host!: Page;
    let url = '';
    let hostId: string | null = null;
    for (let tries = 0; tries < MAX_HOSTS && !(hostId && isMidRange(hostId)); tries += 1) {
      if (tries > 0) { await contexts.pop()!.close(); errorLists.pop(); }
      const hostContext = await browser.newContext();
      contexts.push(hostContext);
      host = await hostContext.newPage();
      await installNetworkHooks(hostContext);
      errorLists.push(collectPageErrors(host, 'host'));
      url = await hostMeeting(host, 'Host');
      await expect.poll(() => host.evaluate(() => window.__rbE2E!.peerId()), { timeout: 15_000 }).toBeTruthy();
      hostId = await host.evaluate(() => window.__rbE2E!.peerId());
    }
    expect(hostId && isMidRange(hostId), `no host with a mid-range peer ID in ${MAX_HOSTS} tries`).toBe(true);
    await wait(65_000);
    const joiners: Array<{ page: Page; id: string }> = [];
    for (let i = 0; i < MAX_JOINERS; i += 1) {
      const context = await browser.newContext();
      contexts.push(context);
      await installNetworkHooks(context);
      const page = await context.newPage();
      errorLists.push(collectPageErrors(page, `participant ${i}`));
      await joinMeeting(page, url, canary(`Late ${i}`));
      await expect.poll(() => page.evaluate(() => window.__rbE2E!.peerId()), { timeout: 15_000 }).toBeTruthy();
      joiners.push({ page, id: (await page.evaluate(() => window.__rbE2E!.peerId()))! });
      if (joiners.length >= MIN_JOINERS && joiners.some(({ id }) => hostId! < id) && joiners.some(({ id }) => id < hostId!)) break;
    }
    const hostLeads = joiners.filter(({ id }) => hostId! < id).length;
    expect(hostLeads, `the host made the offer to none of ${joiners.length} people`).toBeGreaterThan(0);
    expect(joiners.length - hostLeads, `none of ${joiners.length} people made the offer to the host`).toBeGreaterThan(0);
    console.log(`late join: the host makes the offer to ${hostLeads} of ${joiners.length}`);
    for (const { page, id } of joiners) {
      await expect.poll(async () => (await directPeers(host)).includes(id),
        { timeout: 30_000, message: `no direct connection to ${hostId! < id ? 'a participant the host offers to' : 'a participant that offers to the host'}` }).toBe(true);
      await expect.poll(() => page.evaluate(() => window.__rbE2E!.connectedPeers()), { timeout: 15_000 }).toBeGreaterThan(0);
    }
    expect(errorLists.flat()).toEqual([]);
  } finally {
    for (const context of contexts) await context.close();
  }
});
