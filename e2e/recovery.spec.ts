import { expect, test, type Page } from '@playwright/test';
import { banner, addTopic, canary, collectPageErrors, discussTopic, forceNoDirectPath, freezePage, hostMeeting, installNetworkHooks, joinMeeting, resumePage, timeUpSheet, topicCard } from './helpers';

const HOST_OFFLINE = "The facilitator's device is offline.";

// How long a resumed page may go without hearing from the host before it shows the offline banner (RESUME_GRACE_MS in
// src/session/participant.ts is 5 s); the banner watch runs past it.
const GRACE_WATCH_MS = 7000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Notes a recovery time on the test, and in the log: CI's list reporter shows no annotations.
function recovery(description: string): void {
  test.info().annotations.push({ type: 'recovery', description });
  console.log(`recovery: ${description}`);
}

// Records in the page whether a banner with some text ever appears from now on, however briefly. It keeps watching across a freeze.
async function everShows(page: Page, text: string): Promise<() => Promise<boolean>> {
  const key = `__ever_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(({ key, text }) => {
    const w = window as unknown as Record<string, boolean>;
    w[key] = false;
    const check = () => { if ([...document.querySelectorAll('.rb-banner-text')].some((el) => (el as HTMLElement).innerText.includes(text))) w[key] = true; };
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, { key, text });
  return () => page.evaluate((key) => (window as unknown as Record<string, boolean>)[key], key);
}

test('a participant whose phone locks for 40 s is up to date within 5 s of unlocking, with no offline banner', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  await installNetworkHooks(participantContext);
  // With no direct path the page has no connected peer connections for freezePage to close, so catch-up has to come through the
  // relay reconnect and resubscribe that resume drives, not a Trystero reconnect.
  await forceNoDirectPath(participantContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, canary('Locked'));
    const sawOffline = await everShows(participant, HOST_OFFLINE);
    await freezePage(participant);
    const topic = canary('While locked ');
    await addTopic(host, topic);
    await wait(40_000);
    const unlockedAt = Date.now();
    await resumePage(participant);
    await expect(topicCard(participant, topic)).toBeVisible({ timeout: 5000 });
    recovery(`participant up to date ${Date.now() - unlockedAt} ms after unlocking`);
    // Keep watching past the resume grace: a host that is not heard from shows the banner once it runs out.
    await wait(GRACE_WATCH_MS);
    expect(await sawOffline()).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await hostContext.close();
    await participantContext.close();
  }
});

test('a participant with a live direct connection is up to date within 5 s of unlocking, with no page errors', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  await installNetworkHooks(participantContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, canary('Direct'));
    // freezePage closes this connection, so make sure there is one to close.
    await expect.poll(() => participant.evaluate(() => window.__rbE2E!.connectedPeers()), { timeout: 15_000 }).toBeGreaterThan(0);
    await freezePage(participant);
    const topic = canary('While locked ');
    await addTopic(host, topic);
    await wait(10_000);
    const unlockedAt = Date.now();
    await resumePage(participant);
    await expect(topicCard(participant, topic)).toBeVisible({ timeout: 5000 });
    recovery(`directly connected participant up to date ${Date.now() - unlockedAt} ms after unlocking`);
    // The direct connection freezePage closed is formed again, not only the relay path: the page rejoins the direct room.
    const reconnecting = Date.now();
    await expect.poll(() => participant.evaluate(() => window.__rbE2E!.connectedPeers()), { timeout: 15_000 }).toBeGreaterThan(0);
    recovery(`direct connection back ${Date.now() - unlockedAt} ms after unlocking (${Date.now() - reconnecting} ms after catch-up)`);
    // It came back through the rejoin, not through the minute's announcement.
    const urls = await participant.evaluate(() => window.__rbE2E!.socketUrls());
    expect(urls.some((socketUrl) => new URL(socketUrl).searchParams.get('rejoin') === '1')).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await hostContext.close();
    await participantContext.close();
  }
});

test('a page that comes back from a lock rejoins the direct room through fresh signalling clients, and its direct connection returns', { tag: '@public' }, async ({ browser }) => {
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  await installNetworkHooks(participantContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, canary('Rejoin'));
    await expect.poll(() => participant.evaluate(() => window.__rbE2E!.connectedPeers()), { timeout: 30_000 }).toBeGreaterThan(0);
    await freezePage(participant);
    await wait(3000);
    const unlockedAt = Date.now();
    await resumePage(participant);
    // The relays accept the marked URLs (?rejoin=1), and the fresh clients' announcements bring the connection back.
    await expect.poll(() => participant.evaluate(() => window.__rbE2E!.connectedPeers()), { timeout: 20_000 }).toBeGreaterThan(0);
    recovery(`direct connection back ${Date.now() - unlockedAt} ms after unlocking`);
    const urls = await participant.evaluate(() => window.__rbE2E!.socketUrls());
    expect(urls.some((socketUrl) => new URL(socketUrl).searchParams.get('rejoin') === '1')).toBe(true);
    expect(urls.some((socketUrl) => new URL(socketUrl).searchParams.has('rejoin') && new URL(socketUrl).searchParams.get('rejoin') !== '1')).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await hostContext.close();
    await participantContext.close();
  }
});

// Does the host's working connection to a participant it did not lose survive the host's rejoin? Trystero's leave()
// keeps a connection it shares between rooms, and the new room takes it back. The test asserts that the link either
// survives or forms again within 15 s of the host being shown and that the host's new room lists that participant
// (a connection still open says nothing about whether the room uses it), logs which, and asserts that both
// participants have a direct connection afterwards.
test('a host that rejoins after losing one link while hidden keeps its other link or gets it back within 15 s, and has direct connections to both participants', async ({ browser }) => {
  test.setTimeout(120_000);
  const hostContext = await browser.newContext();
  const untouchedContext = await browser.newContext();
  const lostContext = await browser.newContext();
  await installNetworkHooks(hostContext);
  await installNetworkHooks(untouchedContext);
  await installNetworkHooks(lostContext);
  const host = await hostContext.newPage();
  const untouched = await untouchedContext.newPage();
  const lost = await lostContext.newPage();
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(untouched, 'untouched'), ...collectPageErrors(lost, 'lost')];
  const connected = (page: Page) => page.evaluate(() => window.__rbE2E!.connectedPeers());
  const marked = (page: Page) => page.evaluate(() => window.__rbE2E!.markedConnectedPeers());
  const directPeers = (page: Page) => page.evaluate(() => {
    if (!window.__rbDirectPeers) throw new Error('the host page has no direct-peers hook: is this an e2e build?');
    return window.__rbDirectPeers();
  });

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(untouched, url, canary('Untouched'));
    await expect.poll(() => connected(host), { timeout: 30_000 }).toBe(1);
    expect(await host.evaluate(() => window.__rbE2E!.markConnectedPeers())).toBe(1);
    const untouchedId = await untouched.evaluate(() => window.__rbE2E!.peerId());
    expect(untouchedId, 'the untouched participant has announced its peer ID').not.toBeNull();
    // The room lists a peer only once its own handshake over the connection has finished, a moment after the connection.
    await expect.poll(async () => (await directPeers(host)).includes(untouchedId!),
      { timeout: 15_000, message: "the host's room did not list the untouched participant" }).toBe(true);
    await joinMeeting(lost, url, canary('Lost'));
    await expect.poll(() => connected(host), { timeout: 30_000 }).toBe(2);
    // The lost participant's connections before the host closes its end: one that still reads connected afterwards
    // is the old one, so only an unmarked connection shows the link came back.
    await expect.poll(() => connected(lost), { timeout: 30_000 }).toBeGreaterThan(0);
    await lost.evaluate(() => window.__rbE2E!.markConnectedPeers());
    // The host's tab goes to the background and its link to one participant is lost meanwhile, as in a lock.
    await host.evaluate(() => window.__rbE2E!.hide());
    expect(await host.evaluate(() => window.__rbE2E!.closeUnmarkedPeers())).toBe(1);
    const shownAt = Date.now();
    await host.evaluate(() => window.__rbE2E!.show());
    await expect.poll(async () => (await host.evaluate(() => window.__rbE2E!.socketUrls()))
      .some((socketUrl) => new URL(socketUrl).searchParams.get('rejoin') === '1'), { timeout: 10_000 }).toBe(true);
    // The host's only marked connection is to the untouched participant, and each participant has one connection to
    // the host: so either that one is still connected, or two connected ones mean it formed again.
    await expect.poll(async () => (await marked(host)) > 0 || (await connected(host)) >= 2,
      { timeout: Math.max(1, shownAt + 15_000 - Date.now()), message: 'the link to the untouched participant neither survived nor came back within 15 s' }).toBe(true);
    // The rejoin's sockets are open, so the room the hook reads is the new one: it must list the participant.
    await expect.poll(async () => (await directPeers(host)).includes(untouchedId!),
      { timeout: Math.max(1, shownAt + 15_000 - Date.now()), message: "the host's new room did not list the untouched participant within 15 s" }).toBe(true);
    await expect.poll(() => connected(host), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    recovery(`host connected to both participants ${Date.now() - shownAt} ms after it was shown`);
    // Let any second connection to the untouched participant form before reading what happened to the first.
    await wait(5000);
    const survived = await marked(host);
    const total = await connected(host);
    const listed = (await directPeers(host)).includes(untouchedId!);
    // With two connections open, one to each participant, and the old one among them, the room can only be using it.
    const finding = survived === 0 ? 'was closed and a new one formed'
      : total > 2 ? 'stayed open but a new one formed beside it'
        : listed ? "SURVIVED, and the host's new room uses it" : "stayed open, but the host's new room no longer lists the participant";
    recovery(`the host's connection to the untouched participant ${finding} (rejoin finding; ${total} connected)`);
    expect(survived > 0 || total >= 2).toBe(true);
    expect(listed, "the host's new room lists the untouched participant").toBe(true);
    await expect.poll(() => connected(untouched), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(async () => await connected(lost) - await lost.evaluate(() => window.__rbE2E!.markedConnectedPeers()),
      { timeout: 15_000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await hostContext.close();
    await untouchedContext.close();
    await lostContext.close();
  }
});

// Trystero keeps a pool of ready offers and restarts any over 57 s old (fixed in src/transport/restart-offer.ts;
// e2e/late-join.spec.ts covers a stale pool on either side). Which of two pages makes the offer depends on the order of
// their peer IDs: the lower one does. So this test locks the page that makes the offer, whose rejoin gives it a fresh
// pool, after both pages' pools are over a minute old. Rehearsal timing cannot shorten this: the 57 s is Trystero's own,
// in real time.
test('a page that rejoins in a meeting over a minute old gets its direct connection back, when it makes the offer', async ({ browser }) => {
  test.setTimeout(180_000);
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  await installNetworkHooks(hostContext);
  await installNetworkHooks(participantContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, canary('Old room'));
    await expect.poll(() => participant.evaluate(() => window.__rbE2E!.connectedPeers()), { timeout: 15_000 }).toBeGreaterThan(0);
    await wait(65_000);
    const [hostId, participantId] = await Promise.all([host, participant].map((page) => page.evaluate(() => window.__rbE2E!.peerId())));
    expect(hostId).toBeTruthy();
    expect(participantId).toBeTruthy();
    const hostOffers = hostId! < participantId!;
    const [locked, other] = hostOffers ? [host, participant] : [participant, host];
    recovery(`locking the ${hostOffers ? 'host' : 'participant'}, whose peer ID is the lower`);
    await freezePage(locked);
    await wait(10_000);
    const unlockedAt = Date.now();
    await resumePage(locked);
    await expect.poll(() => locked.evaluate(() => window.__rbE2E!.connectedPeers()), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => other.evaluate(() => window.__rbE2E!.connectedPeers()), { timeout: 15_000 }).toBeGreaterThan(0);
    recovery(`direct connection back in a meeting over a minute old ${Date.now() - unlockedAt} ms after unlocking`);
    expect(errors).toEqual([]);
  } finally {
    await hostContext.close();
    await participantContext.close();
  }
});

test('while the facilitator’s phone is locked the board is read-only, and everyone is back within 5 s of unlocking', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  await installNetworkHooks(hostContext);
  // With no direct path the host has no connected peer connections for freezePage to close, so the host's own relay reconnect is
  // what brings everyone back.
  await forceNoDirectPath(hostContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, canary('Waiting'));
    const existing = canary('Before locking ');
    await addTopic(host, existing);
    await expect(topicCard(participant, existing)).toBeVisible();
    await expect(topicCard(participant, existing).getByRole('button', { name: /^Vote for / })).toBeEnabled();
    await freezePage(host);
    // After 20 s without the host, the meeting pauses: the board stays, read-only.
    await expect(banner(participant, HOST_OFFLINE)).toBeVisible({ timeout: 30_000 });
    await expect(participant.getByRole('textbox', { name: 'New topic' })).toHaveCount(0);
    await expect(topicCard(participant, existing).getByRole('button', { name: /^Vote for / })).toBeDisabled();
    const unlockedAt = Date.now();
    await resumePage(host);
    await expect(banner(participant, HOST_OFFLINE)).toHaveCount(0, { timeout: 5000 });
    recovery(`participant back ${Date.now() - unlockedAt} ms after the host unlocked`);
    const topic = canary('After unlocking ');
    await addTopic(participant, topic);
    await expect(topicCard(host, topic)).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await hostContext.close();
    await participantContext.close();
  }
});

test('while the facilitator is away a guest counts only themselves, and a timer that runs out says time up will show when they are back', async ({ browser }) => {
  test.slow();
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  await installNetworkHooks(hostContext);
  await forceNoDirectPath(hostContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();

  try {
    const url = await hostMeeting(host, 'Host', 'Away check', { rehearsal: true });
    await joinMeeting(participant, url, 'Waiting');
    await addTopic(host, 'Pairing rotation');
    await host.getByRole('button', { name: 'Start discussion' }).click();
    await expect(participant.getByRole('button', { name: '2 here' })).toBeVisible({ timeout: 30_000 });
    await discussTopic(host, 'Pairing rotation', '10 s');
    await expect(participant.getByRole('timer')).toBeVisible({ timeout: 30_000 });
    await freezePage(host);
    // The facilitator is away: the head count can't know the others are still here, and the timer runs out with no vote.
    await expect(banner(participant, HOST_OFFLINE)).toBeVisible({ timeout: 30_000 });
    await expect(participant.getByRole('button', { name: '1 here' })).toBeVisible();
    const note = participant.getByText("Time's up will show when the facilitator is back.", { exact: true });
    await expect(note).toBeVisible({ timeout: 30_000 });
    await expect(timeUpSheet(participant)).toHaveCount(0);
    await resumePage(host);
    // Back again: the vote opens on everyone's screen and the note goes.
    await expect(timeUpSheet(participant)).toBeVisible({ timeout: 30_000 });
    await expect(note).toHaveCount(0);
  } finally {
    await hostContext.close();
    await participantContext.close();
  }
});
