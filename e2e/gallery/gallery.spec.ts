import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  addTopic, APP_PATH, banner, createMeeting, discussTopic, fillMeeting, forceSignals, hostMeeting, joinMeeting, NETWORK_WAIT, openPeople,
  outcomeLine, realLength, START_BUTTON, THEMES, timeUpSheet, topicCard, withRehearsal,
} from '../helpers';

// The screenshot gallery for design review:
// every screen at phone and desktop widths in all four themes. Run with `npm run gallery`; the pictures and an
// index.html land in gallery/ (GALLERY_DIR to change it), which git ignores. In CI it runs from
// .github/workflows/gallery.yml and the folder is uploaded as an artifact.
const DIR = process.env.GALLERY_DIR ?? 'gallery';
const WIDTHS = { phone: { width: 360, height: 780 }, desktop: { width: 1280, height: 860 } };
type Width = keyof typeof WIDTHS;
const shots: string[] = [];
const TIME_UP_WAIT = 30_000;

const MAX_HEIGHT = 4000;

// A tall page is shot by making the viewport as tall as the page, not with fullPage: fixed bars, scrims and sheets then
// sit where a tall screen would put them, instead of floating mid-picture at the first viewport's height.
async function fitViewport(page: Page, width: Width): Promise<void> {
  const base = WIDTHS[width];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wanted = await page.evaluate(([min, max]) => Math.min(max, Math.max(min, document.documentElement.scrollHeight)), [base.height, MAX_HEIGHT]);
    if (page.viewportSize()?.height === wanted) return;
    await page.setViewportSize({ width: base.width, height: wanted });
    await page.waitForFunction((h) => window.innerHeight === h, wanted);
    // Two frames, so the layout for the new height has been painted.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  }
}

// An autofocused field arrives with its text selected; collapse that so the picture shows the clean state.
async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    const el = document.activeElement;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.setSelectionRange(el.value.length, el.value.length);
  });
}

async function shoot(page: Page, width: Width, name: string): Promise<void> {
  const original = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  try {
    for (const theme of THEMES) {
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
      await fitViewport(page, width);
      await clearSelection(page);
      const file = join(DIR, width, `${name}--${theme}.png`);
      await page.screenshot({ path: file, animations: 'disabled' });
      shots.push(file);
    }
  } finally {
    await page.setViewportSize(WIDTHS[width]);
    await page.evaluate((t) => { if (t) document.documentElement.setAttribute('data-theme', t); }, original);
  }
}

// Numbers each screen in the order it is taken, so the gallery reads as a walk through a meeting.
function shooter(width: Width, prefix: string): (page: Page, name: string) => Promise<void> {
  let n = 0;
  return (page, name) => shoot(page, width, `${prefix}${String(++n).padStart(2, '0')}-${name}`);
}

const bar = (page: Page): Locator => page.getByRole('group', { name: 'Next step' });

// A phone's extra actions and the Facilitator controls sit in the bar's "More" sheet.
async function openSheet(page: Page): Promise<Locator> {
  await bar(page).getByRole('button', { name: 'More' }).click();
  const sheet = page.getByRole('dialog', { name: 'More' });
  await expect(sheet).toBeVisible();
  return sheet;
}

// A facilitator action by name: in the bar when it is there, otherwise in the side panel (wide) or the sheet (phone).
async function barAction(page: Page, name: string | RegExp): Promise<void> {
  const inBar = bar(page).getByRole('button', { name });
  if (await inBar.count()) {
    await inBar.click();
    return;
  }
  // Wide screens keep the rest in the side panel; phones fold it into a sheet.
  const panel = page.getByRole('complementary', { name: 'Facilitator' });
  const holder = (await panel.count()) ? panel : await openSheet(page);
  await holder.getByRole('button', { name }).first().click();
}

// The Facilitator controls: the side panel on desktop, a sheet on phones (close it with Escape).
async function controls(page: Page, width: Width): Promise<Locator> {
  return width === 'desktop' ? page.getByRole('complementary', { name: 'Facilitator' }) : openSheet(page);
}

async function refuseClipboard(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(Clipboard.prototype, 'writeText', { configurable: true, value: () => Promise.reject(new Error('refused')) });
    Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: undefined });
  });
}

// The first screen after a topic starts, for someone who is not facilitating: on phones the Discussing tab opens by itself.
async function expectDiscussing(page: Page, width: Width): Promise<void> {
  if (width === 'phone') await expect(page.getByRole('tab', { name: /^Discussing/ })).toHaveAttribute('aria-selected', 'true', { timeout: NETWORK_WAIT });
  else await expect(page.getByRole('region', { name: 'Discussing' }).locator('article')).toBeVisible({ timeout: NETWORK_WAIT });
}

const vote = (page: Page, topic: string): Locator => topicCard(page, topic).getByRole('button', { name: /^Vote for / });

async function walk(browser: Browser, width: Width): Promise<void> {
  const viewport = WIDTHS[width];
  const hostContext = await browser.newContext({ viewport });
  const guestContext = await browser.newContext({ viewport });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const shot = shooter(width, 'a');
  try {
    // Headless Chromium may refuse to persist storage; only the banner's own forced screen shows that banner.
    await forceSignals(host, { host: { storageNotice: false } });
    await host.goto(APP_PATH);
    await shot(host, 'home');
    await createMeeting(host, 'Hana', 'Team Lean Coffee', { rehearsal: true });
    await shot(host, 'share-step');
    await host.getByRole('dialog', { name: 'Invite people' }).getByRole('button', { name: 'Done' }).click();
    await expect(host.getByRole('textbox', { name: 'New topic' })).toBeVisible();
    await shot(host, 'topics-empty-facilitator');
    const url = host.url();

    await guest.goto(url);
    await shot(guest, 'join');
    await joinMeeting(guest, url, 'Ann');
    for (const text of ['Should we adopt trunk-based development this quarter?', 'Hiring plan for Q4', 'Release notes: who writes them?', 'Pairing rotation for new joiners']) {
      await addTopic(guest, text);
    }
    await guest.getByRole('textbox', { name: 'New topic' }).blur();
    await vote(guest, 'Hiring plan for Q4').click();
    await vote(guest, 'Hiring plan for Q4').click();
    await vote(guest, 'Release notes').click();
    await expect(topicCard(host, 'Hiring plan for Q4').getByRole('img', { name: /^2 votes/ })).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(guest, 'topics-participant');
    await shot(host, 'topics-facilitator');

    // Show votes off: everyone sees "Votes hidden" in Ideas.
    await (await controls(host, width)).getByRole('switch', { name: 'Show votes' }).click();
    if (width === 'phone') await host.keyboard.press('Escape');
    await expect(topicCard(guest, 'Hiring plan for Q4').getByRole('img', { name: /^Votes hidden/ })).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(guest, 'topics-votes-hidden');
    await (await controls(host, width)).getByRole('switch', { name: 'Show votes' }).click();
    if (width === 'phone') await host.keyboard.press('Escape');
    await expect(topicCard(guest, 'Hiring plan for Q4').getByRole('img', { name: /^2 votes/ })).toBeVisible({ timeout: NETWORK_WAIT });
    await (await controls(host, width)).getByRole('button', { name: 'Reset all votes' }).click();
    await expect(host.getByRole('dialog', { name: 'Reset all votes?' })).toBeVisible();
    await shot(host, 'reset-votes-confirmation');
    await host.keyboard.press('Escape');
    await expect(host.getByRole('dialog')).toHaveCount(0);

    await openPeople(guest);
    await shot(guest, 'people-sheet');
    await guest.keyboard.press('Escape');
    if (width === 'phone') {
      await openSheet(host);
      await shot(host, 'more-sheet');
      await host.keyboard.press('Escape');
    }
    const mine = topicCard(guest, 'Pairing rotation');
    await mine.getByRole('button', { name: /^Edit / }).click();
    const editing = guest.getByRole('textbox', { name: /^Edit #\d+$/ });
    await expect(editing).toBeVisible();
    await shot(guest, 'editing-a-topic');
    await guest.locator('article', { has: editing }).getByRole('button', { name: 'Cancel' }).click();
    await expect(editing).toHaveCount(0);
    await mine.getByRole('button', { name: /^Delete / }).click();
    await expect(guest.getByRole('dialog', { name: /^Delete #\d+\?$/ })).toBeVisible();
    await shot(guest, 'delete-confirmation');
    await guest.keyboard.press('Escape');
    await expect(guest.getByRole('dialog')).toHaveCount(0);

    await barAction(host, 'Start discussion');
    await expect(bar(host).getByRole('button', { name: /^Discuss #\d+$/ })).toBeVisible({ timeout: NETWORK_WAIT });
    if (width === 'phone') await expect(guest.getByRole('tab', { name: /^To discuss/ })).toBeVisible({ timeout: NETWORK_WAIT });
    else await expect(guest.getByRole('region', { name: 'Discussing' })).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(guest, 'discussion-nothing-yet');
    await barAction(host, /^Discuss #\d+$/);
    const picker = host.getByRole('dialog', { name: /^Discuss #\d+$/ });
    await expect(picker).toBeVisible();
    await shot(host, 'timebox-picker');
    await picker.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: realLength('50 s') }).click();
    await picker.getByRole('button', { name: START_BUTTON }).click();
    await expectDiscussing(guest, width);
    await shot(guest, 'discussing-participant');
    await shot(host, 'discussing-facilitator');
    await barAction(host, 'Stop timer');
    const confirmStop = host.getByRole('dialog', { name: 'Stop the timer?' });
    await expect(confirmStop).toBeVisible();
    await shot(host, 'stop-timer-confirmation');
    await confirmStop.getByRole('button', { name: 'Stop timer' }).click();
    await expect(guest.locator('.mtg-no-timer')).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(guest, 'discussing-no-timer');
    await barAction(host, 'Start timer');
    const restart = host.getByRole('dialog', { name: /^Start a timer for #\d+$/ });
    await restart.getByRole('group', { name: 'Timebox' }).getByRole('button', { name: realLength('10 s') }).click();
    await restart.getByRole('button', { name: START_BUTTON }).click();
    await expect(timeUpSheet(guest)).toBeVisible({ timeout: TIME_UP_WAIT });
    await expect(timeUpSheet(host)).toBeVisible({ timeout: TIME_UP_WAIT });
    await shot(guest, 'time-up-participant');
    await timeUpSheet(guest).getByRole('button', { name: 'Keep going', exact: true }).click();
    await expect(timeUpSheet(guest).getByText(/present have voted/)).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(guest, 'time-up-participant-voted');
    await expect(timeUpSheet(host).getByText(/\d+ voted/)).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(host, 'time-up-facilitator');
    // Move on is the decision's first button, so no new timer starts and the sheet does not come back.
    await timeUpSheet(host).locator('.mtg-decision').getByRole('button').first().click();
    await expect(outcomeLine(guest)).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(guest, 'outcome-line');
    await shot(host, 'outcome-line-undo');

    if (width === 'phone') await host.getByRole('tab', { name: /^To discuss/ }).click();
    await discussTopic(host, 'Release notes', '50 s');
    await expectDiscussing(guest, width);
    await barAction(host, 'Finish topic');
    if (width === 'phone') await guest.getByRole('tab', { name: /^Discussed/ }).click();
    await shot(guest, 'discussion-with-discussed');

    await barAction(host, 'End meeting');
    await expect(host.getByRole('dialog', { name: 'End the meeting?' })).toBeVisible();
    await shot(host, 'end-meeting-confirmation');
    await host.getByRole('dialog', { name: 'End the meeting?' }).getByRole('button', { name: 'End meeting' }).click();
    await expect(banner(guest, 'Meeting ended')).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(bar(host).getByRole('button', { name: 'Copy as text' })).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(guest, 'ended-participant');
    await shot(host, 'ended-facilitator');
    await barAction(host, 'Back up meeting file');
    await expect(host.getByRole('dialog', { name: 'Back up meeting file' })).toBeVisible();
    await shot(host, 'back-up-confirmation');
    await host.keyboard.press('Escape');
  } finally {
    await Promise.all([hostContext.close(), guestContext.close()]);
  }
}

// A short meeting with the clipboard refused: the fields to copy from by hand, and To discuss once it is empty.
async function shortMeeting(browser: Browser, width: Width): Promise<void> {
  const context = await browser.newContext({ viewport: WIDTHS[width] });
  await refuseClipboard(context);
  const shot = shooter(width, 'b');
  try {
    const host = await context.newPage();
    await forceSignals(host, { host: { storageNotice: false } });
    await createMeeting(host, 'Hana', 'Short meeting', { rehearsal: true });
    const share = host.getByRole('dialog', { name: 'Invite people' });
    await share.getByRole('button', { name: 'Copy link' }).click();
    await expect(share.getByRole('textbox', { name: 'Meeting link' })).toBeVisible();
    await shot(host, 'share-copy-fallback');
    await share.getByRole('button', { name: 'Done' }).click();
    await expect(share).toHaveCount(0);
    await addTopic(host, 'Release notes');
    await host.getByRole('textbox', { name: 'New topic' }).blur();
    // On phones the bar returns a short hold after the add box loses focus; barAction looks at it without waiting.
    await expect(bar(host).getByRole('button', { name: 'Start discussion' })).toBeVisible();
    await barAction(host, 'Start discussion');
    await discussTopic(host, 'Release notes', '50 s');
    await barAction(host, 'Finish topic');
    if (width === 'phone') await host.getByRole('tab', { name: /^To discuss/ }).click();
    await shot(host, 'to-discuss-empty');
    await barAction(host, 'End meeting');
    await host.getByRole('dialog', { name: 'End the meeting?' }).getByRole('button', { name: 'End meeting' }).click();
    // The bar changes once the meeting has ended; barAction looks at it without waiting.
    await expect(bar(host).getByRole('button', { name: 'Copy as text' })).toBeVisible({ timeout: NETWORK_WAIT });
    await barAction(host, 'Copy as text');
    await expect(host.getByRole('textbox', { name: 'Copy the text from here' })).toBeVisible();
    await shot(host, 'copy-as-text-fallback');
  } finally {
    await context.close();
  }
}

const PARTICIPANT_BANNERS: Array<[string, Record<string, unknown>]> = [
  ['reload-this-page', { mismatch: 'reloadThisPage' }],
  ['ask-facilitator', { mismatch: 'askFacilitator' }],
  ['no-relays', { connection: 'noRelays' }],
  ['host-offline', { connection: 'hostOffline' }],
  ['change-not-delivered', { pendingFailed: true }],
  ['stale-tab', { staleTab: true }],
  ['too-many-tabs', { staleTab: true, staleTabMessage: 'This meeting is open in too many tabs on this device. Reload this page to carry on' }],
];
const HOST_BANNERS: Array<[string, Record<string, unknown>]> = [
  ['no-relays', { connection: 'noRelays' }],
  ['save-failed', { saveFailed: true }],
  ['storage-notice', { storageNotice: true }],
  ['over-limits', { overLimits: true }],
  ['oversize', { oversize: true }],
];

// Screens a meeting rarely shows: file errors, every banner, a full meeting, connecting, and the hosting states.
async function states(browser: Browser, width: Width): Promise<void> {
  const viewport = WIDTHS[width];
  const context = await browser.newContext({ viewport });
  const guestContext = await browser.newContext({ viewport });
  const shot = shooter(width, 'c');
  try {
    const home = await context.newPage();
    await home.goto(withRehearsal(`${APP_PATH}#start`));
    await shot(home, 'home-rehearsal');
    await home.getByRole('button', { name: 'Create meeting' }).click();
    await expect(home.getByText('Enter a meeting name')).toBeVisible();
    await shot(home, 'home-create-errors');
    const file = home.locator('input[type=file]');
    await file.setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": 1}') });
    await expect(home.getByText("That file isn't a Retrobrew meeting file")).toBeVisible();
    await shot(home, 'home-file-not-retrobrew');
    await file.setInputFiles({ name: 'cut.retrobrew.json', mimeType: 'application/json', buffer: Buffer.from('{"format": "retrobrew-board", "version": 2}') });
    await expect(home.getByText('That meeting file is damaged or incomplete')).toBeVisible();
    await shot(home, 'home-file-damaged');
    await file.setInputFiles({ name: 'old.retrobrew.json', mimeType: 'application/json', buffer: Buffer.from('{"format": "retrobrew-board", "version": 1, "board": {}}') });
    await expect(home.getByText('That meeting file was made by an older version of Retrobrew')).toBeVisible();
    await shot(home, 'home-file-older');
    await home.close();

    for (const [name, force] of HOST_BANNERS) {
      const page = await context.newPage();
      // Headless Chromium may refuse to persist storage; only the persistence case shows that banner.
      await forceSignals(page, { host: { storageNotice: false, ...force } });
      await hostMeeting(page, 'Hana', 'Team Lean Coffee');
      await expect(page.locator('.mtg-banner .rb-banner')).toHaveCount(1, { timeout: NETWORK_WAIT });
      await shot(page, `banner-facilitator-${name}`);
      await page.close();
    }

    const host = await context.newPage();
    await forceSignals(host, { host: { storageNotice: false } });
    const url = await hostMeeting(host, 'Hana', 'Team Lean Coffee');
    const guest = await guestContext.newPage();
    await joinMeeting(guest, url, 'Ann');
    for (const [name, force] of PARTICIPANT_BANNERS) {
      await forceSignals(guest, { participant: force });
      await guest.reload();
      await expect(guest.locator('.mtg-banner .rb-banner')).toHaveCount(1, { timeout: NETWORK_WAIT });
      await shot(guest, `banner-participant-${name}`);
    }

    // The hosting states: open in another tab, and taken over. The takeover leaves the meeting with 60 people.
    const second = await context.newPage();
    await second.goto(url);
    await expect(second.getByText('This meeting is open in another tab.')).toBeVisible();
    await shot(second, 'hosting-open-in-another-tab');
    await fillMeeting(second, 60);
    await second.getByRole('button', { name: 'Take over here' }).click();
    await expect(second.getByRole('button', { name: /here$/ })).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(host.getByText('This meeting is now open in another tab.')).toBeVisible({ timeout: NETWORK_WAIT });
    await shot(host, 'hosting-taken-over');

    // Someone new: a broken link, the empty-name error, then a full meeting.
    const strangerContext = await browser.newContext({ viewport });
    try {
      const broken = await strangerContext.newPage();
      await broken.goto(`${APP_PATH}#b=abcdefgh&k=short&h=short`);
      await expect(broken.getByRole('heading', { name: "This link isn't complete" })).toBeVisible();
      await shot(broken, 'broken-link');
      await broken.close();
      const stranger = await strangerContext.newPage();
      await stranger.goto(url);
      await stranger.getByRole('button', { name: 'Take part' }).click();
      await expect(stranger.getByText('Add your name first')).toBeVisible();
      await shot(stranger, 'join-empty-name');
      await stranger.getByRole('textbox', { name: 'Your name' }).fill('Ben');
      await stranger.getByRole('button', { name: 'Take part' }).click();
      await expect(stranger.getByRole('alert').filter({ hasText: 'This meeting is full. It can have up to 60 people' })).toBeVisible({ timeout: NETWORK_WAIT });
      await shot(stranger, 'join-meeting-full');
    } finally {
      await strangerContext.close();
    }

    // With both tabs closed nobody hosts the meeting, and a forced start-up shows the hosting states: starting and failed.
    await host.close();
    await second.close();
    for (const hosting of ['starting', 'failed'] as const) {
      const page = await context.newPage();
      await forceSignals(page, { hosting });
      await page.goto(url);
      await expect(page.getByText(hosting === 'starting' ? 'Starting the meeting…' : "The meeting couldn't start on this device.")).toBeVisible({ timeout: NETWORK_WAIT });
      await shot(page, `hosting-${hosting}`);
      await page.close();
    }

    // Connecting to a meeting whose facilitator has gone: at once, after 15 s and after 60 s.
    const lateContext = await browser.newContext({ viewport });
    try {
      const late = await lateContext.newPage();
      await late.goto(url);
      await shot(late, 'join-with-name-field');
      await late.getByRole('textbox', { name: 'Your name' }).fill('Cy');
      await late.getByRole('button', { name: 'Take part' }).click();
      await expect(late.getByText('Connecting to the facilitator…')).toBeVisible();
      await shot(late, 'connecting');
      await expect(late.getByRole('button', { name: 'Retry' })).toBeVisible({ timeout: 25_000 });
      await shot(late, 'connecting-15-s');
      await expect(late.getByText("If it still doesn't connect", { exact: false })).toBeVisible({ timeout: 60_000 });
      await shot(late, 'connecting-60-s');
    } finally {
      await lateContext.close();
    }
  } finally {
    await Promise.all([context.close().catch(() => undefined), guestContext.close().catch(() => undefined)]);
  }
}

test.beforeAll(() => {
  // Empty the folder's pictures first, so a stale or renamed screen never reaches index.html.
  for (const width of Object.keys(WIDTHS)) {
    const folder = join(DIR, width);
    mkdirSync(folder, { recursive: true });
    for (const f of readdirSync(folder)) if (f.endsWith('.png')) rmSync(join(folder, f));
  }
});

test.afterAll(() => {
  const files = readdirSync(DIR, { recursive: true }).map(String).filter((f) => f.endsWith('.png')).sort();
  const rows = files.map((f) => `<figure><img src="${f}" alt="${f}" loading="lazy"><figcaption>${f}</figcaption></figure>`).join('\n');
  writeFileSync(join(DIR, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Retrobrew screenshot gallery</title>
<style>body{font:14px system-ui;margin:16px}figure{display:inline-block;margin:8px;vertical-align:top}img{max-width:420px;border:1px solid #ccc}</style>
<h1>Retrobrew screenshot gallery</h1><p>${files.length} screenshots, phone (360 px) and desktop (1280 px), in all four themes.</p>
${rows}
`);
  console.log(`Gallery: ${shots.length} screenshots in ${relative(process.cwd(), DIR) || '.'}/`);
});

for (const width of Object.keys(WIDTHS) as Width[]) {
  test(`every screen at ${width} width in all four themes`, async ({ browser }) => {
    test.setTimeout(25 * 60_000);
    await walk(browser, width);
    await shortMeeting(browser, width);
    await states(browser, width);
  });
}
