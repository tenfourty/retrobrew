import { describe, expect, it, vi } from 'vitest';
import type { BoardRecord, BoardStore, JoinedRecord } from '../store/board-store';
import { meetingRows, removeMeeting, REMOVE_OPEN_ELSEWHERE, rowStatus } from './your-meetings';

const board = (boardId: string, updatedAt: number): BoardRecord => ({ boardId, updatedAt, state: { boardName: `Hosted ${boardId}`, phase: 'topics' } } as unknown as BoardRecord);
const joined = (boardId: string, joinedAt: number): JoinedRecord => ({ boardId, boardName: `Joined ${boardId}`, link: `https://x.test/app/#b=${boardId}`, name: 'Ana', joinedAt });

describe('meetingRows', () => {
  it('mixes facilitated and joined meetings, most recent first', () => {
    const rows = meetingRows([board('a', 10), board('c', 30)], [joined('b', 20)]);
    expect(rows.map((r) => [r.kind, r.boardId])).toEqual([['hosted', 'c'], ['joined', 'b'], ['hosted', 'a']]);
  });
  it('lists a meeting this browser facilitates once, even if it also joined it', () => {
    const rows = meetingRows([board('a', 10)], [joined('a', 99)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('hosted');
  });
  it('says a joined meeting opens while the facilitator is running it', () => {
    expect(rowStatus(meetingRows([], [joined('b', 1)])[0])).toBe('Joined as Ana. Opens while the facilitator is running it');
    expect(rowStatus(meetingRows([board('a', 1)], [])[0])).toBe('Collecting topics');
  });
});

describe('removeMeeting', () => {
  const fake = () => ({ remove: vi.fn(async () => undefined), removeJoined: vi.fn(async () => undefined) }) as unknown as BoardStore & { remove: ReturnType<typeof vi.fn>; removeJoined: ReturnType<typeof vi.fn> };

  it('deletes a facilitated board', async () => {
    const store = fake();
    expect(await removeMeeting(store, meetingRows([board('a', 1)], [])[0], async () => false)).toBeNull();
    expect(store.remove).toHaveBeenCalledWith('a');
    expect(store.removeJoined).not.toHaveBeenCalled();
  });
  it('leaves a facilitated board that a tab is running', async () => {
    const store = fake();
    expect(await removeMeeting(store, meetingRows([board('a', 1)], [])[0], async () => true)).toBe(REMOVE_OPEN_ELSEWHERE);
    expect(store.remove).not.toHaveBeenCalled();
  });
  it('forgets a joined entry without touching boards', async () => {
    const store = fake();
    expect(await removeMeeting(store, meetingRows([], [joined('b', 1)])[0], async () => true)).toBeNull();
    expect(store.removeJoined).toHaveBeenCalledWith('b');
    expect(store.remove).not.toHaveBeenCalled();
  });
});
