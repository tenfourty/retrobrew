import { describe, expect, it, vi } from 'vitest';
import { utf8 } from '../crypto/bytes';
import { createBoard } from '../engine/board';
import { newSid } from '../protocol/sid';
import { bundleFields, entryContext, fitBundle, personalItem, type PersonalItem } from './refresh';
import { recordOutcome, TABS_PER_VIEW } from './tabs';

const header = { epoch: 5, seq: 9, refreshSeq: 9, hostNow: 1000, host: 'host-transport' };

describe('bundle parts', () => {
  it('build each entry from the tab table, newest tabs first, at most TABS_PER_VIEW of them', () => {
    let state = createBoard({ boardId: 'b1', boardName: 'Team', ownerId: 'owner', ownerName: 'Olu' });
    state = { ...state, attendees: { ...state.attendees, ann: { id: 'ann', name: 'Ann', role: 'guest' } } };
    let tabs = {};
    const sids = Array.from({ length: 5 }, (_, i) => newSid(1000 + i));
    sids.forEach((sid, i) => { tabs = recordOutcome(tabs, 'ann', sid, 1, 2000 + i, i === 4 ? 'tooManyVotes' : undefined); });
    const item = personalItem(state, 'ann', entryContext(tabs, 'ann', ['owner', 'ann'], undefined, 'meetingFull'), header);
    expect(Object.keys(item.acks)).toEqual(sids.slice(-TABS_PER_VIEW).reverse());
    expect(item.rejects).toEqual({ [sids[4]]: { clientSeq: 1, key: 'tooManyVotes' } });
    expect(item).toMatchObject({ t: 'personal', epoch: 5, seq: 9, host: 'host-transport', you: 'ann', joinRefused: 'meetingFull' });
    expect(bundleFields(state, header, ['owner'])).toMatchObject({ ...header, boardId: 'b1', shared: { online: ['owner'] } });
  });
});

describe('fitBundle', () => {
  const entry = (you: string, tabs: number): PersonalItem => {
    const acks: Record<string, number> = {};
    const rejects: Record<string, { clientSeq: number; key: string }> = {};
    for (let i = 0; i < tabs; i++) {
      acks[`${you}-tab-${i}`] = i + 1;
      rejects[`${you}-tab-${i}`] = { clientSeq: i + 1, key: 'tooManyVotes' };
    }
    return { t: 'personal', epoch: 1, seq: 1, host: 'h', you, role: 'guest', mine: {}, voted: false, acks, rejects };
  };
  const personals = [entry('ann', 3), entry('bob', 3), entry('stranger', 1)];
  const encode = async (items: PersonalItem[]) => utf8(JSON.stringify(items));
  const size = (items: PersonalItem[]) => JSON.stringify(items).length;

  it('sends everything when it fits', async () => {
    const { wire, trimmed, over } = await fitBundle(personals, new Set(['stranger']), new Set(), encode, (w) => w.length, 100_000);
    expect([trimmed, over]).toEqual([0, false]);
    expect(wire.length).toBe(size(personals));
  });

  it('leaves out older tabs’ acks first, then people on a direct path, then refused joiners, until it fits', async () => {
    const strangers = new Set(['stranger']);
    const direct = new Set(['bob']);
    const newest = personals.map((p) => ({ ...p, acks: { [`${p.you}-tab-0`]: 1 }, rejects: { [`${p.you}-tab-0`]: p.rejects[`${p.you}-tab-0`] } }));
    const withoutDirect = [newest[0], newest[2]];
    const attendeesOnly = [newest[0]];
    const fit = (max: number) => fitBundle(personals, strangers, direct, encode, (w) => w.length, max);
    expect((await fit(size(newest))).trimmed).toBe(1);
    const mid = await fit(size(withoutDirect));
    expect([mid.trimmed, mid.over]).toEqual([2, false]);
    expect(JSON.parse(new TextDecoder().decode(mid.wire))).toEqual(withoutDirect);
    const last = await fit(size(attendeesOnly));
    expect([last.trimmed, last.over]).toEqual([3, false]);
    expect(JSON.parse(new TextDecoder().decode(last.wire))).toEqual(attendeesOnly);
  });

  it('never leaves out an attendee’s entry to make room for a refused joiner’s, so with nobody refused it reports over', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const attendees = personals.slice(0, 2);
    const newest = attendees.map((p) => ({ ...p, acks: { [`${p.you}-tab-0`]: 1 }, rejects: { [`${p.you}-tab-0`]: p.rejects[`${p.you}-tab-0`] } }));
    const { wire, trimmed, over } = await fitBundle(attendees, new Set(), new Set(), encode, (w) => w.length, size(newest) - 1);
    expect([trimmed, over]).toEqual([3, true]);
    expect(JSON.parse(new TextDecoder().decode(wire))).toEqual(newest);
    warn.mockRestore();
  });

  it('warns, says it is over, and sends what is left if even that is too large', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { wire, trimmed, over } = await fitBundle(personals, new Set(['stranger']), new Set(['bob']), encode, (w) => w.length, 10);
    expect([trimmed, over]).toEqual([3, true]);
    expect(JSON.parse(new TextDecoder().decode(wire)).map((p: PersonalItem) => p.you)).toEqual(['ann', 'stranger']); // refused joiners ride along
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
