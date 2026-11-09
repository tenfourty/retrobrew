import { afterEach, describe, expect, it } from 'vitest';
import { clearCanary, noteError, recentErrors, resetErrors } from '../feedback/errors';
import { boardStrings, fragmentStrings, registerBoardStrings, registerFragmentStrings } from './feedback-canary';

const VIEW = {
  boardId: 'board1234567890',
  boardName: 'Quarterly Oddity',
  topics: [{ text: 'Secret roadmap item' }, { text: 'Second topic' }],
  attendees: { a: { name: 'Hana Sentinel' }, b: { name: 'Ann Other' } },
};
const HASH = '#b=board1234567890&k=keykeykeykeykeykey&h=hosthosthost';

describe('boardStrings', () => {
  it('lists the board name, id, topics, people, the whole fragment and the parts of it', () => {
    const strings = boardStrings(VIEW, HASH);
    for (const s of ['Quarterly Oddity', 'board1234567890', 'Secret roadmap item', 'Second topic', 'Hana Sentinel', 'Ann Other', HASH, 'keykeykeykeykeykey', 'hosthosthost']) {
      expect(strings).toContain(s);
    }
  });
});

describe('registerBoardStrings', () => {
  afterEach(() => { clearCanary(); resetErrors(); });

  it('makes an error that quotes board text come out withheld, including text added later', () => {
    registerBoardStrings(VIEW, HASH);
    noteError('error', new TypeError('cannot read Secret roadmap item of undefined'));
    expect(recentErrors()[0]?.message).toBe('[withheld]');
    registerBoardStrings({ ...VIEW, topics: [{ text: 'Brand new topic' }] }, HASH);
    noteError('error', new TypeError('bad Brand new topic here'));
    expect(recentErrors()[0]?.message).toBe('[withheld]');
    // Registering is additive: the first topic is still known.
    noteError('error', new RangeError('again Second topic'));
    expect(recentErrors()[0]?.message).toBe('[withheld]');
  });
});

describe('fragmentStrings', () => {
  afterEach(() => { clearCanary(); resetErrors(); });

  it('lists the whole fragment and each value, with no board state', () => {
    expect(fragmentStrings(HASH)).toEqual([HASH, 'board1234567890', 'keykeykeykeykeykey', 'hosthosthost']);
  });

  it('withholds a start-up error that quotes the link, before any board state exists', () => {
    registerFragmentStrings(HASH);
    noteError('startup', new Error('could not open keykeykeykeykeykey'));
    expect(recentErrors()[0]?.message).toBe('[withheld]');
  });
});
