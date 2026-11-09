import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { MAX_TOPICS } from '../../src/engine/limits';
import { collectPageErrors, hostMeeting, joinMeeting, NETWORK_WAIT, realLength, relayHealthOf, START_BUTTON, timeUpSheet } from '../helpers';

// Endurance: a facilitator and five participants in a
// rehearsal meeting for 50 minutes, about a hundred time-up rounds, checking that every board stays in sync, that
// memory and open sockets don't grow, that the wake lock isn't requested over and over, and that no page throws.
// Run with `npm run test:soak`. E2E_SOAK_MINUTES shortens it, to check the test itself.
const MINUTES = Number(process.env.E2E_SOAK_MINUTES || 50);
// The job's timeout is 90 minutes; the test's own is MINUTES + 15. Fail with a message, not a late timeout.
if (!Number.isFinite(MINUTES) || MINUTES < 1 || MINUTES > 70) {
  throw new Error(`E2E_SOAK_MINUTES must be a number from 1 to 70, not "${process.env.E2E_SOAK_MINUTES}"`);
}
const PEOPLE = ['Ann', 'Ben', 'Cy', 'Dee', 'Eli'];
const CHOICES = ['Keep going', 'No preference', 'Move on'];
// A "2 min" timebox on a rehearsal board runs for 20 seconds.
const TIMEBOX = '20 s';
const TIME_UP_WAIT = 60_000;

// Wake lock requests and releases, counted in Node (exposeFunction), so a reload cannot reset them. The mock sentinel
// is released, as the real one is, when the page turns hidden; the app asks again when it turns visible.
interface WakeLockCounts { requests: number; releases: number }
async function countWakeLocks(context: BrowserContext): Promise<WakeLockCounts> {
  const counts: WakeLockCounts = { requests: 0, releases: 0 };
  await context.exposeFunction('__rbWakeLockEvent', (kind: 'request' | 'release') => {
    if (kind === 'request') counts.requests += 1;
    else counts.releases += 1;
  });
  await context.addInitScript(() => {
    const report = (window as unknown as { __rbWakeLockEvent: (kind: string) => void }).__rbWakeLockEvent;
    const live = new Set<{ release: () => Promise<void> }>();
    Object.defineProperty(Navigator.prototype, 'wakeLock', {
      configurable: true,
      get: () => ({
        request: async () => {
          const listeners: Array<() => void> = [];
          const sentinel = {
            released: false,
            type: 'screen',
            release: async () => {
              if (sentinel.released) return;
              sentinel.released = true;
              live.delete(sentinel);
              report('release');
              listeners.forEach((fn) => fn());
            },
            addEventListener: (_type: string, fn: () => void) => { listeners.push(fn); },
            removeEventListener() {},
          };
          live.add(sentinel);
          report('request');
          return sentinel;
        },
      }),
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') [...live].forEach((sentinel) => void sentinel.release());
    });
  });
  return counts;
}

// The page turns hidden, then visible again, as when a phone locks and unlocks (its sockets stay up).
async function hideThenShow(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const setState = (state: string | null) => {
      if (state) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      else delete (document as unknown as { visibilityState?: string }).visibilityState;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setState('hidden');
    await pause(200);
    setState(null);
  });
}

// Open WebSockets per page, from the browser's own events.
function trackSockets(page: Page): () => number {
  let open = 0;
  page.on('websocket', (ws) => {
    open += 1;
    ws.on('close', () => { open -= 1; });
  });
  return () => open;
}

// What every board must agree on: each column's topics, in order, with their vote totals. A phone shows one tab at a
// time, but every column is in its page (the hidden tabs' panels too).
// The vote totals on a board's lines, or a failure when a line shows none (no dots, or "Votes hidden").
function totalsOf(board: string[]): number[] {
  return board.map((line) => {
    const total = /\((\d+) votes?\)$/.exec(line);
    if (!total) throw new Error(`no vote total on "${line}"`);
    return Number(total[1]);
  });
}

const COLUMNS = ['Ideas', 'To discuss', 'Discussing', 'Discussed'];
async function boardOf(page: Page): Promise<string[]> {
  return page.locator('section[aria-label]').evaluateAll((sections, columns) => sections
    .filter((s) => columns.includes(s.getAttribute('aria-label') ?? ''))
    .flatMap((s) => [...s.querySelectorAll('article')].map((card) => {
      const label = card.querySelector('.rb-dots[role="img"]')?.getAttribute('aria-label') ?? '?';
      // "2 votes, 1 yours" differs between pages by design; the total is what must agree.
      return `${s.getAttribute('aria-label')}: ${card.querySelector('.rb-card-text')?.textContent ?? ''} (${label.split(',')[0]})`;
    })), COLUMNS);
}

// The lines that differ between two boards, one line per difference ("- " only in expected, "+ " only on the page).
function boardDiff(expected: string[], actual: string[]): string[] {
  return [...expected.filter((l) => !actual.includes(l)).map((l) => `- ${l}`), ...actual.filter((l) => !expected.includes(l)).map((l) => `+ ${l}`)];
}

// The page's direct peers as its Trystero room lists them (e2e builds), for a failure message.
async function directPeersOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const peers = (window as unknown as { __rbDirectPeers?: () => string[] }).__rbDirectPeers;
    return peers ? `${peers().length} direct peer(s)` : 'no direct-peers hook';
  }).catch((e: unknown) => `unreadable: ${String(e)}`);
}

// A diagnostic read that gives up after 5 s, so a stuck page cannot hide the failure being reported. A read that
// throws or times out yields `unreadable(why)` instead.
async function within<T>(read: Promise<T>, unreadable: (why: string) => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => { timer = setTimeout(() => resolve(unreadable('timeout')), 5_000); });
  try {
    return await Promise.race([read.catch((e: unknown) => unreadable(String(e))), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Polls every person's board until it equals `expected` (the host's, read earlier). A person who is still different
// after NETWORK_WAIT is named, with how their board differs, the host's board as it reads now (a host that moved on
// since `expected` was read says the wait read it too early), and each page's relay health and direct peers.
async function expectBoardsAgree(host: Page, people: Page[], expected: string[], cycle: number): Promise<void> {
  const names = people.map((_, i) => PEOPLE[i]);
  const last: string[][] = people.map(() => []);
  const results = await Promise.all(people.map((p, i) => expect.poll(async () => (last[i] = await boardOf(p)), { timeout: NETWORK_WAIT }).toEqual(expected).then(() => null, (e: unknown) => e)));
  const diverged = results.flatMap((r, i) => (r ? [i] : []));
  if (diverged.length === 0) return;
  const hostNow = await within(boardOf(host), (why) => [`unreadable: ${why}`]);
  const hostDiff = boardDiff(expected, hostNow);
  const lines = [`After cycle ${cycle}, ${diverged.map((i) => names[i]).join(', ')} of ${names.length} people still differ from the host's board read at the end of the cycle.`];
  lines.push(`Host now ${hostDiff.length === 0 ? 'still equals' : 'differs from'} that board: ${hostDiff.join(' | ') || 'no difference'}`);
  for (const i of diverged) lines.push(`${names[i]} differs: ${boardDiff(expected, last[i]).join(' | ')}`);
  for (const [who, page] of [['host', host], ...people.map((p, i) => [names[i], p] as const)] as Array<[string, Page]>) {
    lines.push(`${who}: relays ${await within(relayHealthOf(page), (why) => `unreadable: ${why}`)}; ${await within(directPeersOf(page), (why) => `unreadable: ${why}`)}`);
  }
  throw new Error(lines.join('\n'), { cause: results[diverged[0]] });
}

// The page's JavaScript heap after a garbage collection, in bytes.
async function heapAfterGc(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  return metrics.find((m) => m.name === 'JSHeapUsedSize')!.value;
}

test('a facilitator and five participants run a rehearsal meeting for 50 minutes', async ({ browser }) => {
  test.setTimeout((MINUTES + 15) * 60_000);
  const contexts = await Promise.all([browser.newContext(), ...PEOPLE.map(() => browser.newContext({ viewport: { width: 390, height: 844 } }))]);
  const wakeLocks = await countWakeLocks(contexts[0]);
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  const [host, ...people] = pages;
  const errors = pages.map((p, i) => collectPageErrors(p, i === 0 ? 'host' : PEOPLE[i - 1]));
  const sockets = pages.map(trackSockets);
  const bar = host.getByRole('group', { name: 'Next step' });
  try {
    const url = await hostMeeting(host, 'Hana', 'Soak', { rehearsal: true });
    for (const [i, page] of people.entries()) await joinMeeting(page, url, PEOPLE[i]);
    await expect(host.getByRole('button', { name: `${PEOPLE.length + 1} here` })).toBeVisible({ timeout: NETWORK_WAIT });

    // Each cycle has two time-up rounds and takes about 45 seconds, at the very least 30 (a 20 s timebox and one 10 s
    // extension). Every other cycle finishes its topic; the rest return theirs to To discuss, where it is discussed
    // again. So a run needs at most MINUTES finished topics (at 30 s a cycle), plus the five that get votes: 55 for 50
    // minutes, inside the 60-topic limit. Past 55 the limit caps it, and the deadline check below says if they ran out.
    const topics = Math.min(MAX_TOPICS - 5, MINUTES + 5);
    for (let n = 1; n <= topics; n++) {
      const page = people[n % people.length];
      await page.getByRole('textbox', { name: 'New topic' }).fill(`Soak topic ${n}`);
      await page.getByRole('textbox', { name: 'New topic' }).press('Enter');
    }
    await expect(host.locator('section[aria-label="Ideas"] article')).toHaveCount(topics, { timeout: NETWORK_WAIT });
    // Votes before the discussion (3 each, Show votes is on), spread so the topics' totals differ: 5, 4, 2, 3 and 1.
    // The boards then have something to disagree on.
    const ballots = [[1, 1, 1], [1, 1, 2], [2, 2, 2], [3, 3, 4], [4, 4, 5]];
    for (const [i, page] of people.entries()) {
      for (const [k, n] of ballots[i].entries()) {
        const card = page.locator('article').filter({ has: page.getByText(`Soak topic ${n}`, { exact: true }) });
        await card.getByRole('button', { name: /^Vote for / }).click();
        await expect(page.getByText(k === 2 ? 'No votes left' : `${2 - k} ${2 - k === 1 ? 'vote' : 'votes'} left`, { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
      }
    }
    await expect.poll(async () => totalsOf(await boardOf(host)).filter((t) => t > 0).length, { timeout: NETWORK_WAIT }).toBe(5);
    await bar.getByRole('button', { name: 'Start discussion' }).click();

    // One lock request so far; the page turns hidden and the app must ask again, once.
    await expect.poll(() => wakeLocks.requests, { timeout: NETWORK_WAIT }).toBe(1);
    await hideThenShow(host);
    await expect.poll(() => [wakeLocks.requests, wakeLocks.releases], { timeout: NETWORK_WAIT }).toEqual([2, 1]);

    const heapStart = await Promise.all(pages.map(heapAfterGc));
    const socketsStart = sockets.map((open) => open());
    const deadline = Date.now() + MINUTES * 60_000;
    let rounds = 0;
    let finished = 0;
    let cycles = 0;
    while (Date.now() < deadline) {
      const next = bar.getByRole('button', { name: /^Discuss #\d+$/ });
      // Topics running out would end the run early: stop here and fail below, with the reason.
      if ((await next.count()) === 0) break;
      await next.click();
      const picker = host.getByRole('dialog', { name: /^Discuss #\d+$/ });
      await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: realLength(TIMEBOX) }).click();
      await picker.getByRole('button', { name: START_BUTTON }).click();
      // Two time-up rounds per cycle: keep going once, then move on, or stop and return the topic.
      const finish = cycles % 2 === 0;
      for (const keepGoing of [true, false]) {
        await Promise.all(pages.map((p) => expect(timeUpSheet(p)).toBeVisible({ timeout: TIME_UP_WAIT })));
        await Promise.all(people.map((p, i) => timeUpSheet(p).getByRole('button', { name: CHOICES[(rounds + i) % 3], exact: true }).click()));
        await expect(timeUpSheet(host).getByText(`${PEOPLE.length} voted · ${PEOPLE.length + 1} here`)).toBeVisible({ timeout: NETWORK_WAIT });
        // Every phone's tally is the host's.
        const tally = await timeUpSheet(host).locator('.rb-timeup-totals').textContent();
        await Promise.all(people.map((p) => expect(timeUpSheet(p).locator('.rb-timeup-totals')).toHaveText(tally ?? '', { timeout: NETWORK_WAIT })));
        rounds += 1;
        if (!keepGoing && !finish) {
          await host.keyboard.press('Escape');
          // Time is up, so there is no timer to stop: Return topic is in the Facilitator panel.
          const returning = await host.locator('section[aria-label="Discussing"] .rb-card-text').first().textContent();
          await host.getByRole('complementary', { name: 'Facilitator' }).getByRole('button', { name: 'Return topic' }).click();
          // The host applies the command asynchronously (size check, save, then render), so wait for its own board to
          // show the topic back in To discuss before it is read as the board everyone must agree on.
          await expect(host.locator('section[aria-label="Discussing"] article')).toHaveCount(0, { timeout: NETWORK_WAIT });
          await expect(host.locator('section[aria-label="To discuss"] article').first().locator('.rb-card-text')).toHaveText(returning ?? '', { timeout: NETWORK_WAIT });
          break;
        }
        const decision = timeUpSheet(host).locator('.mtg-decision').getByRole('button');
        await (keepGoing ? decision.nth(1) : decision.first()).click();
      }
      cycles += 1;
      if (finish) finished += 1;
      // Every board agrees with the facilitator's: the same topics, in the same order, with the same votes, whichever
      // tab a phone is showing.
      await expect(host.locator('section[aria-label="Discussed"] article')).toHaveCount(finished, { timeout: NETWORK_WAIT });
      const expected = await boardOf(host);
      expect(expected, 'every topic is on the board').toHaveLength(topics);
      // The totals are real: every line has one, and they differ (5, 4, 3, 2, 1 and zeros).
      expect(new Set(totalsOf(expected)).size, 'distinct vote totals').toBeGreaterThanOrEqual(3);
      await expectBoardsAgree(host, people, expected, cycles);
    }

    expect(Date.now(), `the topics ran out after ${cycles} cycles (${finished} finished), before the ${MINUTES} minutes were up`).toBeGreaterThanOrEqual(deadline);
    console.log(`Soak: ${rounds} time-up rounds in ${cycles} cycles, ${finished} topics finished, in ${MINUTES} minutes`);
    if (MINUTES >= 50) expect(rounds).toBeGreaterThanOrEqual(90);
    else expect(rounds).toBeGreaterThanOrEqual(2);

    // Memory: no page's heap grows by more than 50 MB over the run.
    const heapEnd = await Promise.all(pages.map(heapAfterGc));
    heapEnd.forEach((bytes, i) => expect(bytes - heapStart[i], `heap growth on page ${i}`).toBeLessThan(50 * 1024 * 1024));
    // Sockets: every page holds as many open sockets as at the start (a reconnect in flight gets time to finish).
    await Promise.all(sockets.map((open, i) => expect.poll(open, { message: `open sockets on page ${i}`, timeout: NETWORK_WAIT }).toBe(socketsStart[i])));
    // The wake lock was requested at the start and once more after the one hide: not again and again.
    expect([wakeLocks.requests, wakeLocks.releases]).toEqual([2, 1]);
    expect(errors.flat()).toEqual([]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
