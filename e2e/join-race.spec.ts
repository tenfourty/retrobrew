import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { APP_PATH, canary, hostMeeting, NETWORK_WAIT } from './helpers';

// both name forms fill "Your name" with the device's remembered name once it has loaded. In a fresh browser
// loading it first makes and stores the device's signing key, which can be slow; a name the person typed meanwhile
// must survive it. These tests widen that window on purpose: key generation waits 1.5 s, so the name is typed first;
// each test then waits until the stored key's public half has been exported (the last step before the form fills the
// name), and two frames more for the form to show it, before checking the field and pressing the button.

const SLOW_KEYS_MS = 1500;

// The form loads the device (making and storing its key in a fresh browser), exports the key's public half, then fills
// the name. Once an export has happened, two frames are enough for the form to show what it loaded. The check is
// synchronous: waitForFunction takes a returned promise as already true, so an async check would never wait.
async function deviceLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as unknown as { __raceExports: number }).__raceExports > 0, undefined, { timeout: NETWORK_WAIT });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function slowKeyGeneration(context: BrowserContext): Promise<void> {
  await context.addInitScript((ms) => {
    const original = SubtleCrypto.prototype.generateKey;
    SubtleCrypto.prototype.generateKey = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto['generateKey']>) {
      return new Promise((resolve) => setTimeout(resolve, ms)).then(() => original.apply(this, args));
    } as SubtleCrypto['generateKey'];
    // The form fills the name only after the stored key's public half is exported: count those, so a test can wait for it.
    const exportKey = SubtleCrypto.prototype.exportKey;
    const counted = window as unknown as { __raceExports: number };
    counted.__raceExports = 0;
    SubtleCrypto.prototype.exportKey = function (this: SubtleCrypto, ...args: Parameters<SubtleCrypto['exportKey']>) {
      return exportKey.apply(this, args).then((key) => { counted.__raceExports += 1; return key; });
    } as SubtleCrypto['exportKey'];
  }, SLOW_KEYS_MS);
}

test('a name typed while the join form is still loading the device survives until Take part', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const joinerContext = await browser.newContext();
  await slowKeyGeneration(joinerContext);
  try {
    const host = await hostContext.newPage();
    const joiner = await joinerContext.newPage();
    const url = await hostMeeting(host, 'Host');
    const name = canary('Joiner');
    await joiner.goto(url);
    const field = joiner.getByRole('textbox', { name: 'Your name' });
    await field.fill(name);
    await deviceLoaded(joiner);
    expect(await field.inputValue(), 'the name typed was overwritten by the device name loading late').toBe(name);
    await joiner.getByRole('button', { name: 'Take part' }).click();
    await expect(joiner.getByRole('textbox', { name: 'New topic' })).toBeVisible({ timeout: NETWORK_WAIT });
  } finally {
    await hostContext.close();
    await joinerContext.close();
  }
});

test('a name typed while the start form is still loading the device survives until Create meeting', async ({ browser }) => {
  const context = await browser.newContext();
  await slowKeyGeneration(context);
  try {
    const page = await context.newPage();
    const name = canary('Host');
    await page.goto(APP_PATH);
    await page.getByRole('textbox', { name: 'Meeting name' }).fill('E2E meeting');
    const field = page.getByRole('textbox', { name: 'Your name' });
    await field.fill(name);
    await deviceLoaded(page);
    expect(await field.inputValue(), 'the name typed was overwritten by the device name loading late').toBe(name);
    await page.getByRole('button', { name: 'Create meeting' }).click();
    await expect(page.getByRole('textbox', { name: 'New topic' })).toBeVisible();
  } finally {
    await context.close();
  }
});
