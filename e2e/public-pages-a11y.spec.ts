import { expect, test } from '@playwright/test';
import { expectNoA11yViolations } from './helpers';

for (const path of ['/', '/lean-coffee/']) {
  for (const mode of ['business', 'party']) {
    for (const colorScheme of ['light', 'dark'] as const) {
      test(`${path} in ${mode} ${colorScheme} has no serious accessibility violations`, { tag: '@public' }, async ({ browser }) => {
        const context = await browser.newContext({ colorScheme });
        await context.addInitScript((m) => localStorage.setItem('rb-mode', m), mode);
        const page = await context.newPage();
        try {
          await page.goto(path);
          await expect(page.locator('html')).toHaveAttribute('data-theme', `${mode}-${colorScheme}`);
          await expectNoA11yViolations(page);
        } finally {
          await context.close();
        }
      });
    }
  }
}
