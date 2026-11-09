import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from './handoff';
import { MESSAGES } from '../engine/messages';
import { forgetJoined, JOINED_LIMIT, joinedName, joinRefusalText, joiningTitle, joinedRecordFor, rememberJoined } from './joined';

// A meeting is its board ID and its facilitator's key: the same board ID under another key is another meeting.
const m = (boardId: string, hostPub = 'host-key') => ({ boardId, hostPub });

function memory(): KeyValueStore {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); }, removeItem: (k) => { map.delete(k); } };
}

describe('joined meetings', () => {
  it('remembers the name per meeting until forgotten', () => {
    const store = memory();
    expect(joinedName(m('board-a'), store)).toBeNull();
    rememberJoined(m('board-a'), 'Ann', store);
    rememberJoined(m('board-b'), 'Annie', store);
    expect(joinedName(m('board-a'), store)).toBe('Ann');
    expect(joinedName(m('board-b'), store)).toBe('Annie');
    forgetJoined('board-a', store);
    expect(joinedName(m('board-a'), store)).toBeNull();
  });

  it('keeps only the most recent meetings, dropping the oldest', () => {
    const store = memory();
    for (let i = 0; i < JOINED_LIMIT + 2; i++) rememberJoined(m(`board-${i}`), `Name ${i}`, store);
    expect(joinedName(m('board-0'), store)).toBeNull();
    expect(joinedName(m('board-1'), store)).toBeNull();
    expect(joinedName(m('board-2'), store)).toBe('Name 2');
    // Joining an old meeting again makes it the newest.
    rememberJoined(m('board-2'), 'Name 2', store);
    rememberJoined(m('board-new'), 'New', store);
    expect(joinedName(m('board-2'), store)).toBe('Name 2');
    expect(joinedName(m('board-3'), store)).toBeNull();
  });

  it('rejoins silently only when the link names the same facilitator', () => {
    const store = memory();
    rememberJoined(m('board-a', 'real-host'), 'Ann', store);
    expect(joinedName(m('board-a', 'other-host'), store)).toBeNull();
    expect(joinedName(m('board-a', 'real-host'), store)).toBe('Ann');
  });

  it('ignores a stored value it does not recognise', () => {
    const store = memory();
    store.setItem('rb-joined:board-a', 'Ann');
    expect(joinedName(m('board-a'), store)).toBeNull();
    store.setItem('rb-joined:board-a', JSON.stringify({ hostPub: 'host-key', name: 42 }));
    expect(joinedName(m('board-a'), store)).toBeNull();
  });

  it('works without storage', () => {
    rememberJoined(m('board-a'), 'Ann', null);
    expect(joinedName(m('board-a'), null)).toBeNull();
  });

  it('survives a store that refuses to write', () => {
    const refusing: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('full'); }, removeItem: () => undefined };
    expect(() => rememberJoined(m('board-a'), 'Ann', refusing)).not.toThrow();
  });
});

describe('joinRefusalText', () => {
  it('puts the refusal in words, and says nothing when the join was not refused', () => {
    expect(joinRefusalText('meetingFull')).toBe(MESSAGES.meetingFull);
    expect(joinRefusalText('emptyName')).toBe(MESSAGES.emptyName);
    expect(joinRefusalText('somethingNew')).toBe(MESSAGES.badCommand);
    expect(joinRefusalText('toString')).toBe(MESSAGES.badCommand);
    expect(joinRefusalText(null)).toBeNull();
  });
});

describe('joiningTitle', () => {
  it('names the meeting once the facilitator has answered', () => {
    expect(joiningTitle('Team Lean Coffee')).toBe('Joining Team Lean Coffee');
  });
  it('says nothing before an answer, or for a blank name', () => {
    expect(joiningTitle(undefined)).toBeNull();
    expect(joiningTitle('  ')).toBeNull();
  });
});

describe('joinedRecordFor', () => {
  const meeting = { boardId: 'b', boardName: 'Retro', link: 'https://x.test/app/#b', name: 'Ana' };
  it('has no endedAt while the meeting runs, and when it is reopened', () => {
    expect(joinedRecordFor(meeting, { phase: 'discussion', endedAt: null }, 5)).toEqual({ ...meeting, joinedAt: 5 });
    expect(joinedRecordFor(meeting, { phase: 'topics', endedAt: 3 }, 5)).toEqual({ ...meeting, joinedAt: 5 });
  });
  it('keeps the host end time once the meeting has ended', () => {
    expect(joinedRecordFor(meeting, { phase: 'ended', endedAt: 3 }, 5)).toEqual({ ...meeting, joinedAt: 5, endedAt: 3 });
  });
  it('falls back to now when the ended state has no end time', () => {
    expect(joinedRecordFor(meeting, { phase: 'ended', endedAt: null }, 5)).toEqual({ ...meeting, joinedAt: 5, endedAt: 5 });
  });
});
