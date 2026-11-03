import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from './handoff';
import { guideLine } from './guide';
import { connectionDetails, peopleRows } from './people';
import { lastExtension, lastTimebox, rememberExtension, rememberTimebox, setSoundOn, soundOn } from './prefs';

function memory(): KeyValueStore {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}

describe('guideLine', () => {
  it('speaks to participants and the facilitator in each phase', () => {
    expect(guideLine('topics', false, 5)).toBe("Add topics you'd like to talk about, then spend your 5 votes");
    expect(guideLine('topics', true, 5)).toBe('Invite people, add topics and vote. Start the discussion when the votes are in');
    expect(guideLine('discussion', false, 3)).toBe('The facilitator picks the next topic. You can still add topics and vote');
    expect(guideLine('discussion', true, 3)).toBe('Pick the next topic from To discuss. Everyone can still add topics and vote');
    expect(guideLine('ended', false, 3)).toBe('This meeting has ended');
    expect(guideLine('ended', true, 3)).toBe('This meeting has ended. Copy the outcome or reopen it');
  });
});

describe('peopleRows', () => {
  const view = {
    attendees: {
      host: { id: 'host', name: 'Zoë', role: 'owner' as const },
      a: { id: 'a', name: 'bea', role: 'guest' as const },
      b: { id: 'b', name: 'Al', role: 'guest' as const },
      c: { id: 'c', name: 'Cy', role: 'guest' as const },
    },
    online: ['host', 'c', 'a'],
  };

  it('lists online people first, then alphabetically, marking you and the facilitator', () => {
    expect(peopleRows(view, 'a')).toEqual([
      { id: 'a', name: 'bea (you)', online: true },
      { id: 'c', name: 'Cy', online: true },
      { id: 'host', name: 'Zoë', online: true, role: 'Facilitator' },
      { id: 'b', name: 'Al', online: false },
    ]);
  });

  it('tells the facilitator how each other person is connected', () => {
    const rows = peopleRows(view, 'host', [
      { participantId: 'a', status: 'relayed' },
      { participantId: 'c', status: 'offline' },
      { participantId: 'c', status: 'direct' },
    ]);
    expect(rows.map((r) => [r.name, r.connection])).toEqual([
      ['bea', 'Through relays'], ['Cy', 'Direct'], ['Zoë (you)', undefined], ['Al', 'Offline'],
    ]);
  });
});

describe('connectionDetails', () => {
  const relays = [
    { url: 'wss://a.example', connected: true, refused: 2, notices: 1 },
    { url: 'wss://b.example', connected: false, refused: 1, notices: 0 },
  ];

  it('lists each relay and adds up refusals and notices', () => {
    expect(connectionDetails(relays, 0)).toEqual({
      relays: ['wss://a.example · Connected', 'wss://b.example · Not connected'],
      counts: ['Refused by relays: 3', 'Relay notices: 1'],
    });
  });

  it('counts oversize events once there are any', () => {
    expect(connectionDetails(relays, 2).counts).toEqual(['Refused by relays: 3', 'Relay notices: 1', 'Oversize events: 2']);
  });
});

describe('per-device preferences', () => {
  it('remembers the last timebox and extension, starting at 5 and 3', () => {
    const store = memory();
    expect(lastTimebox(store)).toBe(5);
    expect(lastExtension(store)).toBe(3);
    rememberTimebox(15, store);
    rememberExtension(1, store);
    expect(lastTimebox(store)).toBe(15);
    expect(lastExtension(store)).toBe(1);
    store.setItem('rb-timebox', '7');
    expect(lastTimebox(store)).toBe(5);
  });

  it('plays the sound for facilitators and not participants, until the device says otherwise', () => {
    const store = memory();
    expect(soundOn(true, store)).toBe(true);
    expect(soundOn(false, store)).toBe(false);
    setSoundOn(true, store);
    expect(soundOn(false, store)).toBe(true);
    setSoundOn(false, store);
    expect(soundOn(true, store)).toBe(false);
  });

  it('works without storage', () => {
    expect(lastTimebox(null)).toBe(5);
    expect(soundOn(true, null)).toBe(true);
    rememberTimebox(3, null);
  });
});
