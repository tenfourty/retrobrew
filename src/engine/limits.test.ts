import { describe, expect, it } from 'vitest';
import { ANN, BOB, OWNER, board, must, refused, run, withTopic } from '../test/engine-fixtures';
import {
  REFRESH_CAP_BYTES, RELAY_EVENT_MAX_BYTES, boardOverLimits,
} from './limits';
import type { BoardState, Result } from './types';

const grows = (r: Result) => (r.ok ? r.grows : undefined);

// 30 English topics of about 80 characters, 15 people with 12-character names, three dots each.
function realistic(): BoardState {
  let s = board();
  for (let p = 0; p < 12; p++) s = must(run(s, `person-${String(p).padStart(15, '0')}`, { type: 'join', name: `Person ${String(p).padStart(5, '0')}` }));
  const people = Object.keys(s.attendees);
  for (let i = 0; i < 30; i++) {
    s = must(run(s, people[i % people.length], { type: 'addTopic', text: `How might we improve topic number ${i} for the whole team this quarter, and why?` }));
  }
  for (const [i, person] of people.entries()) {
    for (let d = 0; d < 3; d++) s = must(run(s, person, { type: 'addVote', topicId: ((i * 3 + d) % 30) + 1 }));
  }
  return s;
}

describe('the size caps', () => {
  it('are 44 KB and 48 KB of 1,024 bytes', () => {
    expect(REFRESH_CAP_BYTES).toBe(44 * 1024);
    expect(RELAY_EVENT_MAX_BYTES).toBe(48 * 1024);
  });
});

describe('growing changes', () => {
  it('marks a new topic for the boardFull check', () => {
    expect(grows(run(board(), ANN, { type: 'addTopic', text: 'x' }))).toBe('boardFull');
  });

  it('marks an edit that makes a topic longer in UTF-8 bytes, and no other edit', () => {
    const s = withTopic();
    expect(grows(run(s, ANN, { type: 'editTopic', topicId: 1, text: 'First topic, longer' }))).toBe('boardFull');
    // Fewer characters, more bytes.
    expect(grows(run(s, ANN, { type: 'editTopic', topicId: 1, text: '最初の話題、とても長い' }))).toBe('boardFull');
    expect(grows(run(s, ANN, { type: 'editTopic', topicId: 1, text: 'First' }))).toBeUndefined();
    expect(grows(run(s, ANN, { type: 'editTopic', topicId: 1, text: 'Other topic' }))).toBeUndefined();
  });

  it('marks a new person or a longer name for the meetingFullSize check, and no other join', () => {
    const s = board();
    expect(grows(run(s, 'new', { type: 'join', name: 'New' }))).toBe('meetingFullSize');
    expect(grows(run(s, BOB, { type: 'join', name: 'Bobby Tables' }))).toBe('meetingFullSize');
    expect(grows(run(s, BOB, { type: 'join', name: 'B' }))).toBeUndefined();
    expect(run(s, BOB, { type: 'join', name: 'Bob' })).toEqual({ ok: true, state: s, changed: false });
  });

  it('never marks votes, deletes or phase changes', () => {
    const s = withTopic();
    expect(grows(run(s, BOB, { type: 'addVote', topicId: 1 }))).toBeUndefined();
    expect(grows(run(s, ANN, { type: 'deleteTopic', topicId: 1 }))).toBeUndefined();
    expect(grows(run(s, OWNER, { type: 'startDiscussion' }))).toBeUndefined();
  });

  it('checks the hard caps first, so they refuse before any measuring', () => {
    expect(run(board(), ANN, { type: 'addTopic', text: 'x'.repeat(281) })).toEqual(refused('topicTooLong'));
    let s = board();
    for (let i = 3; i < 60; i++) s = must(run(s, `p${i}`, { type: 'join', name: `P${i}` }));
    expect(run(s, 'late', { type: 'join', name: 'Late' })).toEqual(refused('meetingFull'));
  });
});

describe('boards over the limits', () => {
  // As saved before the limits, or imported: 70 topics of 300 characters.
  function oversized(): BoardState {
    const s = board();
    s.topics = Array.from({ length: 70 }, (_, i) => ({
      topicId: i + 1, text: 'y'.repeat(300), column: 'ideas' as const, position: -i, authorId: ANN, voters: [],
    }));
    s.topicIdSeed = 71;
    return s;
  }

  it('is reported for the facilitator’s notice, from the hard caps or the measured size', () => {
    expect(boardOverLimits(oversized(), 0)).toBe(true);
    expect(boardOverLimits(withTopic(), 0)).toBe(false);
    expect(boardOverLimits(withTopic(), REFRESH_CAP_BYTES)).toBe(false);
    expect(boardOverLimits(withTopic(), REFRESH_CAP_BYTES + 1)).toBe(true);
    expect(boardOverLimits({ ...withTopic(), boardName: 'n'.repeat(81) }, 0)).toBe(true);
  });

  it('refuses growth with the usual messages but lets everything else run', () => {
    const s = oversized();
    expect(run(s, ANN, { type: 'addTopic', text: 'more' })).toEqual(refused('tooManyTopics'));
    expect(run(s, ANN, { type: 'editTopic', topicId: 1, text: 'z'.repeat(301) })).toEqual(refused('topicTooLong'));
    expect(run(s, ANN, { type: 'editTopic', topicId: 1, text: 'Short now' }).ok).toBe(true);
    expect(run(s, ANN, { type: 'deleteTopic', topicId: 2 }).ok).toBe(true);
    expect(run(s, BOB, { type: 'addVote', topicId: 3 }).ok).toBe(true);
  });

  it('lets an over-length topic be shortened, even if it is still over 280, but never lengthened', () => {
    const s = oversized();
    const shorter = run(s, ANN, { type: 'editTopic', topicId: 1, text: 'z'.repeat(290) });
    expect(shorter.ok).toBe(true);
    expect(run(s, ANN, { type: 'editTopic', topicId: 1, text: 'z'.repeat(300) }).ok).toBe(true);
    expect(run(s, ANN, { type: 'editTopic', topicId: 1, text: 'z'.repeat(301) })).toEqual(refused('topicTooLong'));
  });

  it('still refuses a normal topic edited past 280', () => {
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: 'z'.repeat(281) })).toEqual(refused('topicTooLong'));
    expect(run(withTopic(), ANN, { type: 'editTopic', topicId: 1, text: 'z'.repeat(280) }).ok).toBe(true);
  });
});
