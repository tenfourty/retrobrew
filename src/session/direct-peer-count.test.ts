import { describe, expect, it } from 'vitest';
import { FakeScheduler } from '../test/fake-scheduler';
import { TestRoom } from '../test/sessions';
import { settle } from '../test/settle';

describe('participant direct peer count', () => {
  it('counts the peers its direct path reports, and is 0 when that path never connects', async () => {
    const room = await TestRoom.create();
    const scheduler = new FakeScheduler(Date.now());
    room.host('host', { scheduler });
    const ann = await room.person('Ann', { scheduler });
    const bob = await room.person('Bob', { scheduler, directPath: false });
    await settle();
    expect(ann.session.directPeerCount()).toBe(1);
    expect(bob.session.directPeerCount()).toBe(0);
  });

  it('is 0 for a transport that cannot report direct peers', async () => {
    const room = await TestRoom.create();
    const base = room.transport('Cy');
    const transport = Object.create(base, { directPeers: { value: undefined } });
    const cy = await room.person('Cy', { transport });
    expect(cy.session.directPeerCount()).toBe(0);
  });
});
