import { describe, expect, it } from 'vitest';
import { createBoard } from '../engine/board';
import { redactFor } from '../engine/redact';
import type { BoardState } from '../engine/types';
import { countedView } from './counted-view';
import { meetingAsText } from './meeting-text';

const OWNER = 'owner-id';
const ANN = 'ann-id';

// A topics-phase board with Show votes off and two votes on one Ideas topic: the count is hidden on screen.
function hiddenBoard(): BoardState {
  const s = createBoard({ boardId: 'b', boardName: 'Team', ownerId: OWNER, ownerName: 'Olu' });
  s.attendees[ANN] = { id: ANN, name: 'Ann', role: 'guest' };
  s.showVotes = false;
  s.topicIdSeed = 1;
  s.topics = [{ topicId: 1, text: 'Release notes', column: 'ideas', position: -1, authorId: ANN, voters: [ANN, ANN] }];
  return s;
}

describe('countedView', () => {
  it('keeps every count for the facilitator while the screen and participants see none', () => {
    const state = hiddenBoard();
    expect(redactFor(state, OWNER).topics[0].votes).toBeUndefined();
    expect(redactFor(state, ANN).topics[0].votes).toBeUndefined();
    expect(countedView(state, OWNER).topics[0].votes).toBe(2);
  });

  it('copies the real counts from the counted view, and no count from the screen view', () => {
    const state = hiddenBoard();
    const today = new Date(2026, 9, 6).getTime();
    expect(meetingAsText(countedView(state, OWNER), today)).toContain('- Release notes (2 votes)\n');
    expect(meetingAsText(redactFor(state, OWNER), today)).toContain('- Release notes\n');
  });

  it('changes nothing else about the view, and leaves the board untouched', () => {
    const state = hiddenBoard();
    const { showVotes, topics: _t, ...counted } = countedView(state, OWNER);
    const { showVotes: _s, topics: _u, ...shown } = redactFor(state, OWNER);
    expect(counted).toEqual(shown);
    expect(showVotes).toBe(true);
    expect(state.showVotes).toBe(false);
  });
});
