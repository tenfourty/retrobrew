import type { BoardState } from '../engine/types';
import { EXPORT_FORMAT, MAX_IMPORT_BYTES, OlderVersionError, readBoardFile, type BoardRecord } from '../store/board-store';
import { shortDate } from './lengths';

export const FILE_NOT_RETROBREW = "That file isn't a Retrobrew meeting file";
export const FILE_DAMAGED = 'That meeting file is damaged or incomplete';
export const FILE_OLDER_VERSION = "That meeting file was made by an older version of Retrobrew and can't be opened. Please start a new meeting";

// A file too big to be a meeting file is reported as not being one (docs/product/mvp-screens.md lists only two file errors).
export function checkFileSize(bytes: number): void {
  if (bytes > MAX_IMPORT_BYTES) throw new Error(FILE_NOT_RETROBREW);
}

// Reads an "Open a meeting file" upload, rejecting with one of the three messages the app home shows: a file that isn't
// ours at all, one of ours that can't be run (damaged, cut short, or saved without its keys), or one made by a version
// before protocol 3, which can't be opened.
export async function readMeetingFile(text: string): Promise<BoardRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(FILE_NOT_RETROBREW);
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { format?: unknown }).format !== EXPORT_FORMAT) {
    throw new Error(FILE_NOT_RETROBREW);
  }
  try {
    return await readBoardFile(text);
  } catch (err) {
    if (err instanceof OlderVersionError) throw new Error(FILE_OLDER_VERSION);
    throw new Error(FILE_DAMAGED);
  }
}

// The status line under a meeting in "Your meetings".
export function meetingStatus(state: Pick<BoardState, 'phase' | 'endedAt'>): string {
  if (state.phase === 'ended') return state.endedAt ? `Ended ${shortDate(state.endedAt)}` : 'Ended';
  return state.phase === 'discussion' ? 'In discussion' : 'Collecting topics';
}
