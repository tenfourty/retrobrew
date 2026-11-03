import { expect, test, type Page } from '@playwright/test';
import { APP_PATH, expectNoA11yViolations, withRehearsal } from './helpers';

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('a rehearsal link starts a rehearsal meeting, listed with its badge', async ({ page, context }) => {
  await page.goto(withRehearsal(`${APP_PATH}#start`));
  await expect(page.getByRole('heading', { name: 'Start a rehearsal meeting' })).toBeVisible();
  await expect(page.getByText('Timeboxes are shortened, for trying things out')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Meeting name' })).toBeFocused();
  await expectNoA11yViolations(page);
  await page.getByRole('textbox', { name: 'Meeting name' }).fill('Rehearsal run');
  await page.getByRole('textbox', { name: 'Your name' }).fill('Host');
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await page.waitForFunction(() => /[#&]b=/.test(location.hash));

  // A second tab of the same browser lists it, so the host tab keeps running.
  const home = await context.newPage();
  await home.goto(APP_PATH);
  const row = home.getByRole('listitem').filter({ hasText: 'Rehearsal run' });
  await expect(row.getByText('Rehearsal', { exact: true })).toBeVisible();
  await expect(row.getByText('Collecting topics')).toBeVisible();
  await expect(home.getByRole('heading', { name: 'Start a meeting' })).toBeVisible();
});

test('the create form says what is missing and focuses it', async ({ page }) => {
  await page.goto(APP_PATH);
  await expect(page.getByText('Meetings you start in this browser are listed here')).toBeVisible();
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await expect(page.getByText('Enter a meeting name')).toBeVisible();
  await expect(page.getByText('Enter your name')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Meeting name' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Meeting name' }).fill('Team Lean Coffee');
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await expect(page.getByText('Enter a meeting name')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Your name' })).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Your name' })).toHaveAccessibleDescription(/Everyone in the meeting sees this name/);
});

test('Open a meeting file explains a file it can’t open', async ({ page }) => {
  await page.goto(APP_PATH);
  const input = page.getByLabel('Open a meeting file');
  await input.setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello": 1}') });
  await expect(page.getByText("That file isn't a Retrobrew meeting file")).toBeVisible();
  await input.setInputFiles({ name: 'cut.retrobrew.json', mimeType: 'application/json', buffer: Buffer.from('{"format": "retrobrew-board", "version": 2}') });
  await expect(page.getByText('That meeting file is damaged or incomplete')).toBeVisible();
  await input.setInputFiles({ name: 'old.retrobrew.json', mimeType: 'application/json', buffer: Buffer.from('{"format": "retrobrew-board", "version": 1, "board": {}}') });
  await expect(page.getByText('That meeting file was made by an older version of Retrobrew')).toBeVisible();
});

test('the form says it is saving while the browser’s storage prompt is open, and clears an error as you type', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __release: () => void }).__release = () => undefined;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persist: () => new Promise<boolean>((resolve) => { (window as unknown as { __release: () => void }).__release = () => resolve(true); }) },
    });
  });
  await page.goto(APP_PATH);
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await expect(page.getByText('Enter a meeting name')).toBeVisible();
  await page.getByRole('textbox', { name: 'Meeting name' }).fill('Team');
  await expect(page.getByText('Enter a meeting name')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Meeting name' })).not.toHaveAttribute('aria-invalid', 'true');
  await page.getByRole('textbox', { name: 'Your name' }).fill('Host');
  await page.getByRole('button', { name: 'Create meeting' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saving the meeting' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create meeting' })).toBeDisabled();
  await expect(page.locator('label.rb-file')).toHaveAttribute('aria-disabled', 'true');
  await page.evaluate(() => (window as unknown as { __release: () => void }).__release());
  await page.waitForFunction(() => /[#&]b=/.test(location.hash));
});

for (const width of [360, 1280]) {
  test(`the wordmark and the guide link are 44 px tap targets at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(APP_PATH);
    for (const name of ['Retrobrew', 'How Lean Coffee works']) {
      const box = await page.getByRole('link', { name }).filter({ visible: true }).boundingBox();
      expect(box?.height, name).toBeGreaterThanOrEqual(44);
    }
    expect(await noSideScroll(page)).toBe(true);
    const guide = await page.getByRole('link', { name: 'How Lean Coffee works' }).filter({ visible: true }).boundingBox();
    const create = await page.getByRole('button', { name: 'Create meeting' }).boundingBox();
    // At phone width the guide link moves under the form.
    if (width < 768) expect(guide!.y).toBeGreaterThan(create!.y);
    else expect(guide!.y).toBeLessThan(create!.y);
  });
}
