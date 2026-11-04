import { expect, test } from '@playwright/test';
import { addTopic, canary, collectPageErrors, hostMeeting, joinMeeting, NETWORK_WAIT, topicCard, watchForText } from './helpers';

test('a host and two participants share topics and votes', { tag: '@public' }, async ({ browser }) => {
  const people = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);
  const [host, alice, bob] = await Promise.all(people.map((c) => c.newPage()));
  const errors = [collectPageErrors(host, 'host'), collectPageErrors(alice, 'alice'), collectPageErrors(bob, 'bob')];

  try {
    const url = await hostMeeting(host, 'Host');
    await Promise.all([joinMeeting(alice, url, 'Alice'), joinMeeting(bob, url, 'Bob')]);

    // A topic from one participant reaches the host and the other participant.
    const topic = canary('Topic ');
    const seenByHost = await watchForText(host, topic);
    const seenByBob = await watchForText(bob, topic);
    const sentAt = await alice.evaluate(() => Date.now());
    await addTopic(alice, topic);
    const hostMs = (await seenByHost()) - sentAt;
    const bobMs = (await seenByBob()) - sentAt;
    test.info().annotations.push(
      { type: 'propagation', description: `topic reached the host in ${hostMs} ms` },
      { type: 'propagation', description: `topic reached the other participant in ${bobMs} ms` },
    );
    await expect(topicCard(host, topic)).toBeVisible();
    await expect(topicCard(bob, topic)).toBeVisible();

    // Three votes each, then the Vote buttons are disabled.
    const card = topicCard(alice, topic);
    for (const left of ['2 votes left', '1 vote left', 'No votes left']) {
      await card.getByRole('button', { name: /^Vote for / }).click();
      await expect(alice.getByText(left, { exact: true })).toBeVisible({ timeout: NETWORK_WAIT });
    }
    for (const button of await alice.getByRole('button', { name: /^Vote for / }).all()) await expect(button).toBeDisabled();

    // The host sees the count.
    await expect(topicCard(host, topic).getByRole('img', { name: /^3 votes/ })).toBeVisible();
    expect(errors.flat()).toEqual([]);
  } finally {
    await Promise.all(people.map((c) => c.close()));
  }
});
