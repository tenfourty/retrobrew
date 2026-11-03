import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { addTopic, discussTopic, freezePage, hostMeeting, installNetworkHooks, joinMeeting, openPeople, resumePage, timeUpSheet } from './helpers';

// Counts the oscillators the page starts, so a test can tell that a timer sound played without hearing it.
async function countSounds(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __rbNotes: number; AudioContext: typeof AudioContext };
    w.__rbNotes = 0;
    const Native = w.AudioContext;
    w.AudioContext = class extends Native {
      override createOscillator(): OscillatorNode {
        const osc = super.createOscillator();
        const start = osc.start.bind(osc);
        osc.start = (when?: number) => { w.__rbNotes += 1; start(when); };
        return osc;
      }
    };
  });
}

// Counts screen wake lock requests. Like a browser, the sentinel lets go (fires 'release') when the page is hidden.
async function countWakeLocks(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __rbWakeLocks: number; __rbReleaseLocks: () => void };
    w.__rbWakeLocks = 0;
    const listeners: Array<() => void> = [];
    w.__rbReleaseLocks = () => { for (const l of listeners.splice(0)) l(); };
    Object.defineProperty(Navigator.prototype, 'wakeLock', {
      configurable: true,
      get: () => ({
        request: async () => {
          w.__rbWakeLocks += 1;
          return { release: async () => undefined, addEventListener: (_type: string, l: () => void) => { listeners.push(l); } };
        },
      }),
    });
  });
}

const notes = (page: Page) => page.evaluate(() => (window as unknown as { __rbNotes: number }).__rbNotes);
const wakeLocks = (page: Page) => page.evaluate(() => (window as unknown as { __rbWakeLocks: number }).__rbWakeLocks);

test('the timer sound plays once at time up for the facilitator, and for participants who switch it on', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    for (const c of contexts) await countSounds(c);
    await countWakeLocks(contexts[0]);
    await countWakeLocks(contexts[1]);
    // Cara's device has the sound on already, but she arrives after time up.
    await contexts[3].addInitScript(() => localStorage.setItem('rb-sound', 'on'));
    const [host, ann, ben, cara] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Sound check', { rehearsal: true });
    await joinMeeting(ann, url, 'Ann');
    await joinMeeting(ben, url, 'Ben');

    // The facilitator's screen asks for a wake lock while hosting, and again when the page becomes visible after the browser let go.
    await expect.poll(() => wakeLocks(host)).toBeGreaterThanOrEqual(1);
    const before = await wakeLocks(host);
    await host.evaluate(() => {
      (window as unknown as { __rbReleaseLocks: () => void }).__rbReleaseLocks();
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => wakeLocks(host)).toBeGreaterThan(before);
    expect(await wakeLocks(ann)).toBe(0);

    // Ben switches the sound on for his device; Ann leaves it off, the default for participants.
    const people = await openPeople(ben);
    await people.getByRole('switch', { name: 'Play the timer sound on this device' }).click();
    await ben.keyboard.press('Escape');

    // The facilitator picks Pips and previews it on this device only.
    const panel = host.getByRole('complementary', { name: 'Facilitator' });
    await panel.getByRole('combobox', { name: 'Timer sound' }).selectOption({ label: 'Pips' });
    await expect(panel.getByRole('combobox', { name: 'Timer sound' })).toHaveValue('pips');
    const previewFrom = await notes(host);
    await panel.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(() => notes(host)).toBe(previewFrom + 3);
    expect(await notes(ann)).toBe(0);

    await addTopic(host, 'Pairing rotation');
    await host.getByRole('button', { name: 'Start discussion' }).click();
    const [hostFrom, benFrom] = [await notes(host), await notes(ben)];
    await discussTopic(host, 'Pairing rotation', '10 s');
    for (const page of [host, ann, ben]) await expect(timeUpSheet(page)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => notes(host)).toBe(hostFrom + 3);
    await expect.poll(() => notes(ben)).toBe(benFrom + 3);
    expect(await notes(ann)).toBe(0);

    // A late joiner with the sound on hears nothing for a vote she did not see open.
    await joinMeeting(cara, url, 'Cara');
    await expect(timeUpSheet(cara)).toBeVisible();
    // Nor does anything replay: a page that closes the sheet and carries on stays at one sound for the vote.
    await ben.keyboard.press('Escape');
    await ben.setViewportSize({ width: 390, height: 800 });
    await ben.setViewportSize({ width: 1280, height: 800 });
    await host.waitForTimeout(1_500);
    expect(await notes(cara)).toBe(0);
    expect(await notes(host)).toBe(hostFrom + 3);
    expect(await notes(ben)).toBe(benFrom + 3);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

test('a page that wakes after time up, with the sound on, stays silent for the vote it missed', async ({ browser }) => {
  const contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  try {
    for (const c of contexts) { await installNetworkHooks(c); await countSounds(c); }
    for (const c of contexts.slice(1)) await c.addInitScript(() => localStorage.setItem('rb-sound', 'on'));
    const [host, dee, eve] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Sleeping phone', { rehearsal: true });
    await joinMeeting(dee, url, 'Dee');
    await joinMeeting(eve, url, 'Eve');
    await addTopic(host, 'Retro format');
    await host.getByRole('button', { name: 'Start discussion' }).click();

    // Dee's phone locks before the timer starts; Eve's stays on.
    await freezePage(dee);
    await discussTopic(host, 'Retro format', '10 s');
    await expect(timeUpSheet(eve)).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => notes(eve)).toBeGreaterThan(0);
    // Time up passed well over 3 s ago when Dee wakes.
    await host.waitForTimeout(5_000);
    await resumePage(dee);
    await expect(timeUpSheet(dee)).toBeVisible({ timeout: 30_000 });
    await host.waitForTimeout(1_500);
    expect(await notes(dee)).toBe(0);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
