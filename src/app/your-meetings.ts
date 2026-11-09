import type { BoardRecord, BoardStore, JoinedRecord } from '../store/board-store';
import { forgetJoined } from './joined';
import { shortDate } from './lengths';
import { meetingStatus } from './meeting-file';

// One row of "Your meetings" (docs/product/mvp-screens.md): a meeting this browser facilitates, or one it joined.
export type MeetingRow =
  | { kind: 'hosted'; boardId: string; boardName: string; at: number; record: BoardRecord }
  | { kind: 'joined'; boardId: string; boardName: string; at: number; joined: JoinedRecord };

// Most recently opened first. A meeting this browser facilitates is listed once, as facilitated, even if the same
// browser once joined it as a guest.
export function meetingRows(boards: readonly BoardRecord[], joined: readonly JoinedRecord[]): MeetingRow[] {
  const hosted = new Set(boards.map((b) => b.boardId));
  const rows: MeetingRow[] = [
    ...boards.map((record): MeetingRow => ({ kind: 'hosted', boardId: record.boardId, boardName: record.state.boardName, at: record.updatedAt, record })),
    ...joined.filter((j) => !hosted.has(j.boardId)).map((j): MeetingRow => ({ kind: 'joined', boardId: j.boardId, boardName: j.boardName, at: j.joinedAt, joined: j })),
  ];
  return rows.sort((a, b) => b.at - a.at);
}

// The line under a meeting's name.
export function rowStatus(row: MeetingRow): string {
  return row.kind === 'hosted'
    ? meetingStatus(row.record.state)
    : row.joined.endedAt !== undefined
      ? `Joined as ${row.joined.name}. Ended${shortDate(row.joined.endedAt) ? ` ${shortDate(row.joined.endedAt)}` : ''}`
      : `Joined as ${row.joined.name}. Opens while the facilitator is running it`;
}

export const REMOVE_OPEN_ELSEWHERE = 'This meeting is open in another tab. Close it there, then remove it';

export function removeTitle(row: MeetingRow): string {
  return row.kind === 'hosted' ? `Remove ${row.boardName} from this browser?` : `Remove ${row.boardName} from your meetings?`;
}

export function removeBody(row: MeetingRow): string {
  return row.kind === 'hosted'
    ? 'This deletes the meeting and its board from this browser, and nobody can open it again from here. To keep a copy, open the meeting and back it up first.'
    : 'This forgets the meeting on this device. You can join it again with its link, while the facilitator is running it.';
}

// Removes the meeting. A facilitated meeting that a tab is running is refused: its own saves would bring it back.
// Resolves an error line to show, or null when the meeting is gone.
export async function removeMeeting(store: BoardStore, row: MeetingRow, isHosted: (boardId: string) => Promise<boolean>): Promise<string | null> {
  if (row.kind === 'hosted') {
    if (await isHosted(row.boardId)) return REMOVE_OPEN_ELSEWHERE;
    await store.remove(row.boardId);
    return null;
  }
  await store.removeJoined(row.boardId);
  // The stored name goes too, so the link opened again shows the join form instead of rejoining silently.
  forgetJoined(row.boardId);
  return null;
}
