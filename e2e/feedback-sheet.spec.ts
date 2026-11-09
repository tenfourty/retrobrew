import { expect, test, type Locator, type Page } from '@playwright/test';
import { COPY } from '../src/feedback/copy';
import {
  addTopic, APP_PATH, banner, canary, expectNoA11yViolationsInEveryTheme, feedbackStub, forceFeedback, forceSignals, hostMeeting, joinMeeting,
  NETWORK_WAIT, settleTransitions,
} from './helpers';

// The feedback sheet, from every place that opens it, against the stub the e2e preview serves (scripts/feedback-stub.mjs;
// the browser tests). Each test finds its own report in the stub by a token in the
// message, so a body left by another test never confuses it. The stub is one state for the whole run: a test that forces a
// mode puts it back (`reset`) before it ends.
//
// Tests run in the file's order in one worker, on fresh pages. Meetings are rehearsal boards.

const WIDTHS = [
  { name: 'phone', wide: false, viewport: { width: 360, height: 780 } },
  { name: 'wide', wide: true, viewport: { width: 1280, height: 860 } },
] as const;

const BROKEN_LINK = `${APP_PATH}#b=abcdefgh&k=short&h=short`;
const WENT_WRONG = 'Something went wrong on this page.';
const TROUBLE_DESCRIPTION = COPY.troubleDescription;

const sheetOf = (page: Page): Locator => page.getByRole('dialog', { name: COPY.title });
const messageBox = (page: Page): Locator => sheetOf(page).getByRole('textbox', { name: COPY.messageLabel });
const sendButton = (page: Page): Locator => sheetOf(page).getByRole('button', { name: COPY.send, exact: true });
const exactRequest = (page: Page): Locator => sheetOf(page).getByLabel(COPY.jsonLabel);

// Opens both disclosures (the rows and the exact JSON), whatever state they are in.
async function showReport(page: Page): Promise<void> {
  await sheetOf(page).evaluate((dialog) => dialog.querySelectorAll('details').forEach((d) => { d.open = true; }));
}

// Waits for the sheet's one request for /version.txt to have been answered and painted, so the JSON no longer changes by itself.
async function openAndSettle(page: Page, open: () => Promise<void>): Promise<void> {
  const live = page.waitForResponse((r) => new URL(r.url()).pathname === '/version.txt');
  await open();
  await expect(sheetOf(page)).toBeVisible();
  await live;
  await settleTransitions(page);
}

async function stubBodiesWith(request: Parameters<typeof feedbackStub>[0], token: string): Promise<string[]> {
  return (await feedbackStub(request).received()).filter((body) => body.includes(token));
}

async function expectFocusInside(dialog: Locator): Promise<void> {
  await expect.poll(() => dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
}

test.afterEach(async ({ request }) => {
  await feedbackStub(request).reset();
});

for (const { name, wide, viewport } of WIDTHS) {
  test.describe(`at ${name} width`, () => {
    test.use({ viewport });

    test('the home page footer opens the sheet, focus goes in, and Cancel and Escape give it back', async ({ page }) => {
      await page.goto(APP_PATH);
      const opener = page.getByRole('button', { name: COPY.button });
      await opener.click();
      await expect(sheetOf(page)).toBeVisible();
      await expectFocusInside(sheetOf(page));
      await expect(page.getByRole('button', { name: 'Something broke' })).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByRole('button', { name: 'Something else' })).toHaveAttribute('aria-pressed', 'true');
      await sheetOf(page).getByRole('button', { name: COPY.cancel }).click();
      await expect(sheetOf(page)).toBeHidden();
      await expect(opener).toBeFocused();

      await opener.click();
      await expect(sheetOf(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(sheetOf(page)).toBeHidden();
      await expect(opener).toBeFocused();
    });

    test('the page for a broken link opens the sheet', async ({ page }) => {
      await page.goto(BROKEN_LINK);
      await expect(page.getByRole('heading', { name: "This link isn't complete" })).toBeVisible();
      await page.getByRole('button', { name: COPY.button }).click();
      await expect(sheetOf(page)).toBeVisible();
      await expectFocusInside(sheetOf(page));
    });

    test('a meeting opens the sheet: the top bar when wide, the More and People sheets on a phone', async ({ page }) => {
      test.slow();
      await forceSignals(page, { host: { storageNotice: false } });
      await hostMeeting(page, 'Hana', 'Feedback places', { rehearsal: true });
      await page.getByRole('textbox', { name: 'New topic' }).blur();
      if (wide) {
        const top = page.locator('.mtg-top-end').getByRole('button', { name: COPY.button });
        await top.click();
        await expect(sheetOf(page)).toBeVisible();
        await expectFocusInside(sheetOf(page));
        await page.keyboard.press('Escape');
        await expect(sheetOf(page)).toBeHidden();
        await expect(top).toBeFocused();
        return;
      }
      await page.getByRole('group', { name: 'Next step' }).getByRole('button', { name: 'More' }).click();
      await page.getByRole('dialog', { name: 'More' }).getByRole('button', { name: COPY.button }).click();
      await expect(sheetOf(page)).toBeVisible();
      await expectFocusInside(sheetOf(page));
      await page.keyboard.press('Escape');
      await expect(sheetOf(page)).toBeHidden();

      await page.getByRole('button', { name: /^\d+ here$/ }).click();
      await page.getByRole('dialog', { name: 'People' }).getByRole('button', { name: COPY.button }).click();
      await expect(sheetOf(page)).toBeVisible();
      await expectFocusInside(sheetOf(page));
    });

    test('a meeting that cannot start offers the sheet beside Try again, opened on "Something broke" with the reason', async ({ page }) => {
      test.slow();
      await forceSignals(page, { host: { storageNotice: false } });
      const url = await hostMeeting(page, 'Hana', 'Failed start', { rehearsal: true });
      await page.close();
      const failed = await page.context().newPage();
      await forceSignals(failed, { hosting: 'failed' });
      await failed.goto(url);
      const panel = failed.getByRole('alert').filter({ hasText: "The meeting couldn't start on this device." });
      await expect(panel).toBeVisible({ timeout: NETWORK_WAIT });
      await expect(panel.getByRole('button', { name: 'Try again' })).toBeVisible();
      const open = panel.getByRole('button', { name: COPY.button });
      await expect(open).toHaveAccessibleDescription(TROUBLE_DESCRIPTION);
      await open.click();
      await expect(sheetOf(failed)).toBeVisible();
      await expect(sheetOf(failed)).toContainText('The app noticed that the meeting could not start.');
      await expect(sheetOf(failed).getByRole('button', { name: COPY.kinds.broke })).toHaveAttribute('aria-pressed', 'true');
    });

    test('the sheet passes axe in Business and Party, light and dark, plain and with its alerts showing', async ({ page }) => {
      await page.goto(APP_PATH);
      await page.getByRole('button', { name: COPY.button }).click();
      await expect(sheetOf(page)).toBeVisible();
      await showReport(page);
      await expectNoA11yViolationsInEveryTheme(page);

      await messageBox(page).fill('See https://retrobrew.app/app/#b=abcdefgh12345678&k=abcdefghijklmnop1234&h=xxxxxxxx');
      await expect(sheetOf(page).getByText(COPY.linkRefused)).toBeVisible();
      await sheetOf(page).getByRole('textbox', { name: COPY.emailLabel }).fill('not an address');
      await messageBox(page).focus();
      await expect(sheetOf(page).getByText(COPY.emailInvalid)).toBeVisible();
      await expectNoA11yViolationsInEveryTheme(page);
    });
  });
}

test('sending shows the stub exactly the JSON the sheet shows, then the sent state', async ({ page, request }) => {
  const stub = feedbackStub(request);
  await stub.reset();
  const token = canary('sent-');
  await page.goto(APP_PATH);
  await openAndSettle(page, () => page.getByRole('button', { name: COPY.button }).click());
  await showReport(page);
  await sheetOf(page).getByRole('button', { name: COPY.kinds.idea }).click();
  await messageBox(page).fill(`An idea ${token}`);
  const shown = await exactRequest(page).textContent();
  expect(shown).toContain(token);
  await sendButton(page).click();

  const status = sheetOf(page).getByRole('status').filter({ hasText: COPY.sent });
  await expect(status).toBeVisible();
  await expect(sheetOf(page).getByText(COPY.sentEmail)).toHaveCount(0);
  await expect(sheetOf(page).getByRole('button', { name: COPY.done })).toBeFocused();
  const bodies = await stubBodiesWith(request, token);
  expect(bodies).toEqual([shown]);
  const body = JSON.parse(bodies[0]!) as { kind: string; message: string; contact: unknown; report: { page: string; role: string } };
  expect(body).toMatchObject({ kind: 'idea', message: `An idea ${token}`, contact: null, report: { page: 'home', role: 'none' } });

  await sheetOf(page).getByRole('button', { name: COPY.done }).click();
  await expect(sheetOf(page)).toBeHidden();
  // The draft went with the send.
  await page.getByRole('button', { name: COPY.button }).click();
  await expect(messageBox(page)).toHaveValue('');
});

test('an email goes in its own field of the body and the sent state says who replies', async ({ page, request }) => {
  const stub = feedbackStub(request);
  await stub.reset();
  const token = canary('mail-');
  await page.goto(APP_PATH);
  await page.getByRole('button', { name: COPY.button }).click();
  await messageBox(page).fill(`Please reply ${token}`);
  await sheetOf(page).getByRole('textbox', { name: COPY.emailLabel }).fill('reader@example.org');
  await sendButton(page).click();
  await expect(sheetOf(page).getByText(COPY.sentEmail)).toBeVisible();
  const [body] = await stubBodiesWith(request, token);
  const parsed = JSON.parse(body!) as { contact: { email: string }; report: unknown };
  expect(parsed.contact).toEqual({ email: 'reader@example.org' });
  expect(JSON.stringify(parsed.report)).not.toContain('reader@example.org');
});

test('a failed send keeps the message and offers a retry; a rate limit and a slow answer have their own lines', async ({ page, request }) => {
  const stub = feedbackStub(request);
  await stub.reset();
  const token = canary('fail-');
  await page.goto(APP_PATH);
  await page.getByRole('button', { name: COPY.button }).click();
  await messageBox(page).fill(`Trying ${token}`);

  await stub.setMode('fail');
  await sendButton(page).click();
  await expect(sheetOf(page).getByRole('alert').filter({ hasText: COPY.failed })).toBeVisible();
  await expect(messageBox(page)).toHaveValue(`Trying ${token}`);
  await expect(sheetOf(page).getByRole('button', { name: COPY.copyMessage })).toBeVisible();
  expect(await stubBodiesWith(request, token)).toEqual([]);

  await stub.setMode('ratelimit');
  await sendButton(page).click();
  await expect(sheetOf(page).getByRole('alert').filter({ hasText: COPY.failedRate })).toBeVisible();
  expect(await stubBodiesWith(request, token)).toEqual([]);

  await stub.setMode('slow');
  await sendButton(page).click();
  await expect(sheetOf(page).getByRole('button', { name: COPY.sending })).toBeDisabled();
  await expect(sheetOf(page).getByText(COPY.sendingStatus)).toBeVisible();
  await expect(sheetOf(page).getByRole('status').filter({ hasText: COPY.sent })).toBeVisible({ timeout: NETWORK_WAIT });
  expect(await stubBodiesWith(request, token)).toHaveLength(1);
});

test('offline, the sheet says so and Send waits for the connection', async ({ page, context, request }) => {
  const stub = feedbackStub(request);
  await stub.reset();
  const token = canary('off-');
  await page.goto(APP_PATH);
  await page.getByRole('button', { name: COPY.button }).click();
  await messageBox(page).fill(`Offline ${token}`);
  await expect(sendButton(page)).toBeEnabled();
  await context.setOffline(true);
  await expect(sheetOf(page).getByRole('alert').filter({ hasText: COPY.offline })).toBeVisible();
  await expect(sendButton(page)).toBeDisabled();
  await context.setOffline(false);
  await expect(sheetOf(page).getByText(COPY.offline)).toHaveCount(0);
  await expect(sendButton(page)).toBeEnabled();
  expect(await stubBodiesWith(request, token)).toEqual([]);
});

test('a message that carries a meeting link is refused until the link is taken out', async ({ page, request }) => {
  const stub = feedbackStub(request);
  await stub.reset();
  const token = canary('link-');
  await page.goto(APP_PATH);
  await page.getByRole('button', { name: COPY.button }).click();
  await messageBox(page).fill(`${token} https://retrobrew.app/app/#b=abcdefgh12345678&k=abcdefghijklmnop1234&h=xxxxxxxx`);
  await expect(sheetOf(page).getByRole('alert').filter({ hasText: COPY.linkRefused })).toBeVisible();
  await expect(sendButton(page)).toBeDisabled();
  await messageBox(page).fill(`${token} the link is gone`);
  await expect(sheetOf(page).getByText(COPY.linkRefused)).toHaveCount(0);
  await expect(sendButton(page)).toBeEnabled();
  expect(await stubBodiesWith(request, token)).toEqual([]);
});

test.describe('#feedback arrivals', () => {
  for (const [hash, from] of [['#feedback', 'home'], ['#feedback=landing', 'landing'], ['#feedback=guide', 'guide']] as const) {
    test(`${hash} opens the sheet over the home page, reports ${from}, and closing drops the fragment`, async ({ page, request }) => {
      const stub = feedbackStub(request);
      await stub.reset();
      const token = canary('arrive-');
      await page.goto(`${APP_PATH}${hash}`);
      await expect(sheetOf(page)).toBeVisible();
      await expectFocusInside(sheetOf(page));
      await messageBox(page).fill(`From ${from} ${token}`);
      await sendButton(page).click();
      await expect(sheetOf(page).getByRole('status').filter({ hasText: COPY.sent })).toBeVisible();
      const [body] = await stubBodiesWith(request, token);
      expect((JSON.parse(body!) as { report: { page: string } }).report.page).toBe(from);

      await sheetOf(page).getByRole('button', { name: COPY.done }).click();
      await expect(sheetOf(page)).toBeHidden();
      await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
      await page.reload();
      await expect(page.getByRole('button', { name: 'Create meeting' })).toBeVisible();
      await expect(sheetOf(page)).toHaveCount(0);
    });
  }

  test('Escape drops the fragment too', async ({ page }) => {
    await page.goto(`${APP_PATH}#feedback`);
    await expect(sheetOf(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheetOf(page)).toBeHidden();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('');
  });
});

for (const { name, wide, viewport } of WIDTHS) {
  test(`an uncaught error shows the banner and the dot; sending clears them (${name})`, async ({ browser, request }) => {
    test.slow();
    const stub = feedbackStub(request);
    await stub.reset();
    const token = canary('boom-');
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      await forceSignals(page, { host: { storageNotice: false } });
      await forceFeedback(page, { throwOnLoad: true });
      await hostMeeting(page, 'Hana', 'Trouble check', { rehearsal: true });

      const notice = page.locator('.mtg-banner');
      await expect(notice).toContainText(WENT_WRONG, { timeout: NETWORK_WAIT });
      await expect(notice.getByRole('button', { name: COPY.button })).toBeVisible();
      const top = page.locator('.mtg-top-end').getByRole('button', { name: COPY.button });
      if (wide) {
        await expect(top).toHaveAccessibleDescription(TROUBLE_DESCRIPTION);
        await expect(top.locator('.fbk-dot')).toHaveCount(1);
      }

      await notice.getByRole('button', { name: COPY.button }).click();
      await expect(sheetOf(page)).toBeVisible();
      await expect(sheetOf(page)).toContainText('The app noticed that something went wrong on this page.');
      await expect(sheetOf(page).getByRole('button', { name: COPY.kinds.broke })).toHaveAttribute('aria-pressed', 'true');
      await expect(exactRequest(page)).toContainText('A browser test threw this error');
      await messageBox(page).fill(`It threw ${token}`);
      await sendButton(page).click();
      await expect(sheetOf(page).getByRole('status').filter({ hasText: COPY.sent })).toBeVisible();
      const [body] = await stubBodiesWith(request, token);
      expect(JSON.parse(body!)).toMatchObject({ kind: 'broke', report: { page: 'host', trouble: { source: 'error' } } });

      await sheetOf(page).getByRole('button', { name: COPY.done }).click();
      await expect(banner(page, WENT_WRONG)).toHaveCount(0);
      if (wide) {
        await expect(top.locator('.fbk-dot')).toHaveCount(0);
        await expect(top).toHaveAccessibleDescription('');
      }
    } finally {
      await context.close();
    }
  });
}

test('nothing from the board reaches the stub, and an error that quotes board text arrives withheld', async ({ browser, request }) => {
  test.slow();
  const stub = feedbackStub(request);
  await stub.reset();
  const sentinels = {
    meeting: canary('mtgname'),
    host: canary('hostname'),
    guest: canary('guestname'),
    topic: canary('topictext'),
    guestTopic: canary('guesttopic'),
  };
  const token = canary('sentinel-');
  const hostContext = await browser.newContext({ viewport: WIDTHS[1].viewport });
  const guestContext = await browser.newContext({ viewport: WIDTHS[1].viewport });
  try {
    const host = await hostContext.newPage();
    const guest = await guestContext.newPage();
    await forceSignals(host, { host: { storageNotice: false } });
    // The error names the topic's text, as an exception from a parser might.
    await forceFeedback(host, { throwOnLoad: true, throwMessage: `cannot read ${sentinels.topic} of undefined` });
    const url = await hostMeeting(host, sentinels.host, sentinels.meeting, { rehearsal: true });
    await joinMeeting(guest, url, sentinels.guest);
    await addTopic(host, sentinels.topic);
    await addTopic(guest, sentinels.guestTopic);
    await expect(host.locator('article', { hasText: sentinels.guestTopic })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(host.locator('.mtg-banner')).toContainText(WENT_WRONG);

    await host.locator('.mtg-top-end').getByRole('button', { name: COPY.button }).click();
    await showReport(host);
    await messageBox(host).fill(`Something odd ${token}`);
    const shown = (await exactRequest(host).textContent()) ?? '';
    await expect(exactRequest(host)).toContainText('[withheld]');
    await sendButton(host).click();
    await expect(sheetOf(host).getByRole('status').filter({ hasText: COPY.sent })).toBeVisible();

    const [body] = await stubBodiesWith(request, token);
    expect(body).toBeDefined();
    expect(body).toContain('[withheld]');
    const hash = new URLSearchParams(new URL(url).hash.slice(1));
    const board = hash.get('b')!;
    const key = hash.get('k')!;
    for (const secret of [...Object.values(sentinels), board, key, hash.get('h')!, '#b=']) {
      expect(body, `the body must not hold ${secret}`).not.toContain(secret);
      expect(shown, `the sheet must not show ${secret}`).not.toContain(secret);
    }
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
});
