import { expect, test, type Page } from '@playwright/test';
import { addTopic, hostMeeting, joinMeeting, NETWORK_WAIT } from './helpers';
import { MAX_TOPICS } from '../src/engine/limits';

const BOARD_FULL = 'This board is full. Delete some topics before adding more';
const ideas = (page: Page) => page.getByRole('region', { name: 'Ideas' });
const cards = (page: Page) => ideas(page).locator('article');
// The notice is a `.rb-alert` beside the add box, not a banner, so `banner()` does not apply.
const alert = (page: Page) => page.locator('.rb-alert', { hasText: BOARD_FULL });

// A seeded generator, so a run is the same every time.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 280 random CJK characters (the topic limit): deflate can't shrink them, so the board reaches the 44 KB cap in
// about 45 topics, well before the 60-topic limit. All are in the Basic Multilingual Plane, so the box counts 280.
function incompressibleTopic(random: () => number): string {
  let text = '';
  for (let i = 0; i < 280; i++) text += String.fromCharCode(0x4e00 + Math.floor(random() * 0x51ff));
  return text;
}

test('a board filled to the size cap refuses the next topic, for the facilitator and for a participant, and shows the notice', async ({ browser }) => {
  test.setTimeout(300_000);
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const [host, ann] = await Promise.all(contexts.map((c) => c.newPage()));
    const url = await hostMeeting(host, 'Hana', 'Size cap check');
    await joinMeeting(ann, url, 'Ann');

    // Add topics until the host refuses one; the cap, not the 60-topic limit, must be what stops the board.
    const random = mulberry32(20261106);
    let accepted = 0;
    let refusedText = '';
    for (; accepted < MAX_TOPICS; accepted++) {
      refusedText = incompressibleTopic(random);
      await addTopic(host, refusedText);
      await expect(async () => {
        const refused = await alert(host).isVisible();
        expect(refused || (await cards(host).count()) === accepted + 1).toBe(true);
      }).toPass({ timeout: 15_000 });
      if (await alert(host).isVisible()) break;
    }
    expect(accepted).toBeGreaterThan(10);
    expect(accepted).toBeLessThan(MAX_TOPICS);

    // The facilitator's refused topic is not on the board, and the notice shows beside the add box.
    await expect(alert(host)).toBeVisible();
    await expect(cards(host)).toHaveCount(accepted);

    // The participant sees every accepted topic, and their own attempt is refused with the same notice.
    await expect(cards(ann)).toHaveCount(accepted, { timeout: NETWORK_WAIT });
    await addTopic(ann, refusedText);
    await expect(alert(ann)).toBeVisible({ timeout: NETWORK_WAIT });
    await expect(cards(ann)).toHaveCount(accepted);
    await expect(cards(host)).toHaveCount(accepted);

    // Deleting a topic makes room again, as the notice says.
    await cards(host).first().getByRole('button', { name: 'Delete' }).click();
    await host.getByRole('dialog', { name: /^Delete #\d+\?/ }).getByRole('button', { name: 'Delete topic' }).click();
    await expect(cards(host)).toHaveCount(accepted - 1);
    await addTopic(host, 'Room again');
    await expect(cards(host)).toHaveCount(accepted, { timeout: 15_000 });
    await expect(alert(host)).toHaveCount(0);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
