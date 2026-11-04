import { describe, expect, it } from 'vitest';
import { decisionButtons, moveOnNote, outcomeLine, recommendation, turnoutLine } from './decision';

describe('decisionButtons', () => {
  it('keeps Move on first and Keep going second, whatever the votes', () => {
    expect(decisionButtons('3 more minutes')).toEqual({
      primary: { kind: 'end', label: 'Move on' },
      secondary: { kind: 'extend', label: 'Keep going for 3 more minutes' },
    });
  });
});

describe('recommendation', () => {
  it('says nothing until someone has chosen a side', () => {
    expect(recommendation({ extend: 0, none: 0, end: 0 })).toBeNull();
    expect(recommendation({ extend: 0, none: 4, end: 0 })).toBeNull();
  });

  it('names the side with more votes, counting No preference for neither', () => {
    expect(recommendation({ extend: 3, none: 0, end: 2 })).toBe('Most votes say keep going');
    expect(recommendation({ extend: 1, none: 9, end: 2 })).toBe('Most votes say move on');
  });

  it('calls a tie split', () => {
    expect(recommendation({ extend: 2, none: 0, end: 2 })).toBe('The votes are split');
  });
});

describe('the time-up sheet’s lines', () => {
  it('writes turnout for participants and for the facilitator', () => {
    expect(turnoutLine({ voted: 2, here: 5 }, false)).toBe('2 of 5 present have voted');
    expect(turnoutLine({ voted: 2, here: 5 }, true)).toBe('2 voted · 5 here');
  });

  it('says what Move on does', () => {
    expect(moveOnNote(4)).toBe('Move on finishes #4 and moves it to Discussed.');
  });

  it('writes outcome lines by the new timer’s real length', () => {
    expect(outcomeLine({ kind: 'extended', minutes: 3 }, 60_000)).toBe('Keeping going for 3 more minutes');
    expect(outcomeLine({ kind: 'extended', minutes: 1 }, 60_000)).toBe('Keeping going for 1 more minute');
    expect(outcomeLine({ kind: 'extended', minutes: 3 }, 10_000)).toBe('Keeping going for 30 more seconds');
    expect(outcomeLine({ kind: 'movedOn', topicId: 1 }, 10_000)).toBe('Moved on · Next topic coming up');
    expect(outcomeLine({ kind: 'movedOn', topicId: 1 }, 10_000, true)).toBe('Moved on to the next topic');
  });
});
