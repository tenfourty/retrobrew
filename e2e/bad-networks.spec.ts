import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import {
  addTopic, blockRelay, canary, collectConsole, collectPageErrors, forceNoDirectPath, hostMeeting, installNetworkHooks, joinMeeting,
  banner, countSends, describeSends, NETWORK_WAIT, recordWsFrames, relayHealthOf, removeWebRTC, topicCard, unblockRelay, useRateLimitedRelay, type WsFrame,
} from './helpers';
import { LOCAL_RELAY_ALIAS_URL, LOCAL_RELAY_URL, LOCAL_RELAY_URLS } from './relay/settings';

const NO_RELAYS = "Can't reach the meeting network. Check your connection.";

// Relay replies refusing one of this page's events: ["OK", <id>, false, <reason>].
function refusals(frames: WsFrame[]): string[] {
  return frames.filter((f) => f.dir === 'received' && /^\["OK","[0-9a-f]{64}",false/.test(f.payload)).map((f) => f.payload);
}

// Records in the page whether a banner with some text ever appears from now on, however briefly, so a banner that flashes while the
// test is waiting on something else is still caught.
async function everShows(page: Page, text: string): Promise<() => Promise<boolean>> {
  const key = `__ever_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(({ key, text }) => {
    const w = window as unknown as Record<string, boolean>;
    w[key] = false;
    const check = () => { if ([...document.querySelectorAll('.rb-banner-text')].some((el) => (el as HTMLElement).innerText.includes(text))) w[key] = true; };
    check();
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
  }, { key, text });
  return () => page.evaluate((key) => (window as unknown as Record<string, boolean>)[key], key);
}

test('the meeting carries on with one relay blocked, and every device says so when all are', async ({ browser }) => {
  const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()];
  for (const context of contexts) await installNetworkHooks(context);
  // Relays only, so that losing them matters: with no direct path, the topic below can only arrive through the surviving relay.
  await forceNoDirectPath(contexts[0]!);
  await forceNoDirectPath(contexts[1]!);
  const [host, participant] = (await Promise.all(contexts.map((c) => c.newPage()))) as [Page, Page];
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, canary('Relayed'));
    const hostSawBanner = await everShows(host, NO_RELAYS);
    const participantSawBanner = await everShows(participant, NO_RELAYS);

    for (const context of contexts) await blockRelay(context, LOCAL_RELAY_URL);
    const first = canary('One relay down ');
    await addTopic(participant, first);
    await expect(topicCard(host, first)).toBeVisible({ timeout: NETWORK_WAIT });
    await participant.waitForTimeout(12_000);
    // The banners are watched across the whole window with one relay down, not just at its end.
    expect(await participantSawBanner()).toBe(false);
    expect(await hostSawBanner()).toBe(false);

    for (const context of contexts) await blockRelay(context, LOCAL_RELAY_ALIAS_URL);
    await expect(banner(participant, NO_RELAYS)).toBeVisible({ timeout: 20_000 });
    await expect(banner(host, NO_RELAYS)).toBeVisible({ timeout: 20_000 });

    for (const context of contexts) {
      await unblockRelay(context, LOCAL_RELAY_URL);
      await unblockRelay(context, LOCAL_RELAY_ALIAS_URL);
    }
    await expect(banner(participant, NO_RELAYS)).toHaveCount(0, { timeout: 45_000 });
    await expect(banner(host, NO_RELAYS)).toHaveCount(0, { timeout: 45_000 });
    const second = canary('Relays back ');
    await addTopic(participant, second);
    await expect(topicCard(host, second)).toBeVisible({ timeout: NETWORK_WAIT });
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

// Records in the page when its topic list first reaches `count` (Date.now(); every context shares one machine clock),
// however briefly after Playwright's own polling would notice. Call before the burst.
async function watchTopicCount(page: Page, count: number): Promise<{ at(): Promise<number>; timeline(): Promise<Array<[number, number]>>; stalls(): Promise<Array<[number, number]>> }> {
  const key = `__count_${Math.random().toString(36).slice(2)}`;
  await page.evaluate(({ key, count }) => {
    const w = window as unknown as Record<string, number | undefined>;
    const seen: Array<[number, number]> = [];
    (w as unknown as Record<string, unknown>)[`${key}_timeline`] = seen;
    const check = () => {
      const n = document.querySelectorAll('article').length;
      if (seen.length === 0 || seen[seen.length - 1]![1] !== n) seen.push([Date.now(), n]);
      if (w[key] === undefined && n >= count) w[key] = Date.now();
    };
    check();
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
    // Main-thread stalls over 300 ms (a timer that fires late), so a page that was busy shows up as such.
    const stalls: Array<[number, number]> = [];
    (w as unknown as Record<string, unknown>)[`${key}_stalls`] = stalls;
    let last = Date.now();
    setInterval(() => { const now = Date.now(); if (now - last > 300) stalls.push([now, now - last]); last = now; }, 50);
  }, { key, count });
  return {
    at: async () => {
      const handle = await page.waitForFunction((key) => (window as unknown as Record<string, number | undefined>)[key], key, { timeout: 10_000 });
      return (await handle.jsonValue()) as number;
    },
    stalls: () => page.evaluate((key) => (window as unknown as Record<string, Array<[number, number]>>)[`${key}_stalls`]!, key),
    timeline: () => page.evaluate((key) => (window as unknown as Record<string, Array<[number, number]>>)[`${key}_timeline`]!, key),
  };
}

const TOPICS_EACH = 6; // Ten people make the board's 60-topic limit; a hello and six commands also exceed one connection's burst of 6.

test('ten people adding topics in a burst through a rate-limiting relay: nothing lost, nothing refused, everyone converges', async ({ browser }) => {
  test.setTimeout(420_000);
  // No WebRTC anywhere: everything goes through the relay, and Trystero's own signalling (which also uses the relays)
  // doesn't share the rate limit, so the test measures the app's own relay traffic.
  const hostContext = await browser.newContext();
  await useRateLimitedRelay(hostContext);
  await removeWebRTC(hostContext);
  const host = await hostContext.newPage();
  const hostFrames = recordWsFrames(host);
  const droppedLines = collectConsole(host, /dropped held events/);
  const people = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const context = await browser.newContext();
    await useRateLimitedRelay(context);
    await removeWebRTC(context);
    const page = await context.newPage();
    const dropped = collectConsole(page, /dropped held events/);
    return { context, page, frames: recordWsFrames(page), name: `Person ${i + 1}`, dropped };
  }));
  const errors = [...collectPageErrors(host, 'host'), ...people.flatMap((p) => collectPageErrors(p.page, p.name))];

  let finished = false;
  try {
    const url = await hostMeeting(host, 'Host');
    await Promise.all(people.map((p) => joinMeeting(p.page, url, p.name)));
    const topics = people.map((p) => Array.from({ length: TOPICS_EACH }, (_, n) => n + 1).map((n) => canary(`${p.name} topic ${n} `)));

    const total = people.length * TOPICS_EACH;
    const hostAt = await watchTopicCount(host, total);
    const peopleAt = await Promise.all(people.map((p) => watchTopicCount(p.page, total)));
    // Everyone adds one topic at a time, all ten at once, and a round starts once the host has all but the last round,
    // so at most two rounds (20 commands) wait at the host. The host is one browser tab that seals and saves every
    // command; on the CI runner it manages about a third of a command a second (56 of 60 after
    // 150 s, still climbing, nobody told "didn't reach"), so all sixty at once would need over three minutes, which is
    // the host's speed and not what this test is about. Twenty waiting is still about a minute for the last, far past
    // the 12 s at which the outbox used to give up, so this
    // fails on that code. The outbox now resends with back-off while the host is heard, for two minutes without any
    // ack (every acked command restarts the two minutes). A host that stays slower still fails: the polls
    // below time out.
    for (let n = 0; n < TOPICS_EACH; n++) {
      if (n >= 2) await expect.poll(() => host.locator('article').count(), { timeout: 120_000 }).toBeGreaterThanOrEqual((n - 1) * people.length);
      await Promise.all(people.map((p, i) => addTopic(p.page, topics[i]![n]!)));
    }

    // The burst is over once the host has every topic; every view then converges within 4 s. The times come from the
    // pages themselves, not from Playwright's polling, which can notice a change a second late.
    // The last twenty commands at up to three seconds each on a loaded host: longer than NETWORK_WAIT. The wait is above the outbox's two minutes, so a give-up shows as a banner before it ends.
    await expect(host.locator('article')).toHaveCount(total, { timeout: 150_000 });
    // The bug itself: no one was told that their change didn't reach the facilitator.
    for (const p of people) await expect(banner(p.page, "didn't reach")).toHaveCount(0);
    const hostTime = await hostAt.at();
    const times = await Promise.all(peopleAt.map((w) => w.at()));
    const converged = Math.max(...times) - hostTime;
    if (converged >= 1000) {
      // Evidence for a slow view: when the host's and the slowest person's topic counts changed.
      const slowest = peopleAt[times.indexOf(Math.max(...times))]!;
      const show = (rows: Array<[number, number]>) => rows.map(([t, n]) => `${t - hostTime}ms:${n}`).join(' ');
      const stalled = (rows: Array<[number, number]>) => rows.map(([t, ms]) => `${t - hostTime}ms:+${ms}`).join(' ') || 'none';
      console.log(`host topic counts: ${show(await hostAt.timeline())}\nslowest view: ${show(await slowest.timeline())}\nhost stalls (end:length): ${stalled(await hostAt.stalls())}\nslowest view stalls: ${stalled(await slowest.stalls())}`);
    }
    const refused = [...refusals(hostFrames), ...people.flatMap((p) => refusals(p.frames))];
    test.info().annotations.push({ type: 'convergence', description: `the slowest of ten views had every topic ${converged} ms after the host; ${refused.length} refusals` });
    console.log(`convergence: the slowest of ten views had every topic ${converged} ms after the host; ${refused.length} refusals`);
    // 4 s, not 2 s: on a loaded runner a view's page freezes for 300 to 500 ms several times (2435 ms in one run, no
    // refusals, the slowest view's stalls adding up to over 2 s). Still under the 5 s periodic refresh, so a view that
    // only converges when the refresh finds it fails.
    expect(converged).toBeLessThan(4000);
    for (const [i, p] of people.entries()) for (const topic of topics[i]!) {
      await expect(topicCard(host, topic)).toHaveCount(1);
      await expect(topicCard(p.page, topic)).toHaveCount(1);
    }

    // Nobody was refused, so nobody was banned: the host and every participant stayed inside their send budget.
    expect(refusals(hostFrames)).toEqual([]);
    expect(people.flatMap((p) => refusals(p.frames))).toEqual([]);
    expect(errors).toEqual([]);
    finished = true;
  } finally {
    // Evidence for a refusal, whatever else failed first.
    if (!finished) {
      // Who got through: topics on the host by person, and who is told their change didn't reach the facilitator.
      const texts = await host.locator('article').allInnerTexts().catch(() => [] as string[]);
      const byPerson = people.map((p) => `${p.name}: ${texts.filter((t) => t.includes(`${p.name} topic`)).length}`).join(', ');
      const told = await Promise.all(people.map(async (p) => `${p.name}: ${await banner(p.page, "didn't reach").count().catch(() => -1)}`));
      console.log(`topics on the host by person: ${byPerson}\nbanner "didn't reach" by person: ${told.join(', ')}`);
      // Each page's relays as its transport sees them (events held now, given up on), and what it sent in all: a person
      // short on the host who sent as many to-peer events as their topics need was not received; one who sent fewer
      // never sent them.
      console.log(`host relays: ${await relayHealthOf(host)}\nhost sent: ${countSends(hostFrames)}`);
      for (const p of people) console.log(`${p.name} relays: ${await relayHealthOf(p.page)}\n${p.name} sent: ${countSends(p.frames)}`);
      console.log(`host sends (held events dropped: ${droppedLines.length ? droppedLines.join('; ') : 'none'}):\n${describeSends(hostFrames)}`);
      for (const p of people) console.log(`${p.name} sends (held events dropped: ${p.dropped.length ? p.dropped.join('; ') : 'none'}):\n${describeSends(p.frames)}`);
    }
    await hostContext.close();
    await Promise.all(people.map((p) => p.context.close()));
  }
});

test('a participant with a dozen changes waiting resends them inside a rate-limiting relay’s limits, and none is lost', async ({ browser }) => {
  test.setTimeout(180_000);
  const hostContext = await browser.newContext();
  const participantContext = await browser.newContext();
  for (const context of [hostContext, participantContext]) {
    await useRateLimitedRelay(context);
    await removeWebRTC(context);
  }
  await installNetworkHooks(participantContext);
  const host = await hostContext.newPage();
  const participant = await participantContext.newPage();
  const frames = recordWsFrames(participant);
  const errors = [...collectPageErrors(host, 'host'), ...collectPageErrors(participant, 'participant')];

  try {
    const url = await hostMeeting(host, 'Host');
    await joinMeeting(participant, url, canary('Queued'));
    // Cut the participant off, make twelve changes, then let it back: they are all waiting to be resent.
    for (const relay of LOCAL_RELAY_URLS) await blockRelay(participantContext, relay);
    const topics = Array.from({ length: 12 }, (_, i) => canary(`Queued ${i} `));
    for (const topic of topics) await addTopic(participant, topic);
    // Its banner proves every socket is down; only then does "the host has nothing" show the changes are queued.
    await expect(banner(participant, NO_RELAYS)).toBeVisible({ timeout: 20_000 });
    await expect(host.locator('article')).toHaveCount(0);
    for (const relay of LOCAL_RELAY_URLS) await unblockRelay(participantContext, relay);
    await expect(host.locator('article')).toHaveCount(12, { timeout: 2 * NETWORK_WAIT });
    for (const topic of topics) await expect(topicCard(host, topic)).toHaveCount(1);
    expect(refusals(frames)).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    if (refusals(frames).length) console.log(`queued-test participant sends:\n${describeSends(frames)}`);
    await hostContext.close();
    await participantContext.close();
  }
});
