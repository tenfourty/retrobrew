import { describe, expect, it } from 'vitest';
import { decisionButtons, moveOnNote, outcomeLine, turnoutLine } from './decision';

describe('decisionButtons', () => {
  const more = '3 more minutes';

  it('puts Keep going first only when it has more votes than Move on', () => {
    expect(decisionButtons({ extend: 3, none: 0, end: 2 }, more)).toEqual({
      primary: { kind: 'extend', label: 'Keep going for 3 more minutes' },
      secondary: { kind: 'end', label: 'Or move on' },
    });
  });

  it('puts Move on first on a tie, with no votes, or when Move on leads', () => {
    const moveOnFirst = { primary: { kind: 'end', label: 'Move on' }, secondary: { kind: 'extend', label: 'Or keep going for 3 more minutes' } };
    expect(decisionButtons({ extend: 2, none: 0, end: 2 }, more)).toEqual(moveOnFirst);
    expect(decisionButtons({ extend: 0, none: 0, end: 0 }, more)).toEqual(moveOnFirst);
    expect(decisionButtons({ extend: 1, none: 0, end: 4 }, more)).toEqual(moveOnFirst);
  });

  it('counts No preference for neither side', () => {
    expect(decisionButtons({ extend: 1, none: 9, end: 1 }, more).primary.kind).toBe('end');
    expect(decisionButtons({ extend: 2, none: 9, end: 1 }, more).primary.kind).toBe('extend');
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
    expect(outcomeLine({ kind: 'movedOn' }, 10_000)).toBe('Moved on to the next topic');
  });
});
