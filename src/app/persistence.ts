import type { BoardRecord, BoardStore } from '../store/board-store';

// Whether the browser promised to keep this device's data. A missing call, a refusal and a throw all count as no.
async function persistGranted(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) === true;
  } catch {
    return false;
  }
}

// Asks the browser to keep the meeting (it may wait on a prompt) and saves the answer on the record, for banner 6
// (docs/product/mvp-screens.md). The record is already saved before this is called, so a slow prompt never holds up
// the save.
export async function recordPersistence(store: BoardStore, record: BoardRecord): Promise<BoardRecord> {
  const note = (await persistGranted()) ? 'granted' : 'refused';
  // Only the note is written, on the record as it is stored now: while the browser's prompt was open another tab
  // may have started hosting this meeting, and a whole-record save from here would overwrite its state.
  return (await store.notePersistence(record.boardId, note)) ?? { ...record, persistence: note };
}

// A new meeting: saved first, then the browser is asked.
export async function storeNewMeeting(store: BoardStore, record: BoardRecord): Promise<BoardRecord> {
  await store.put(record);
  return recordPersistence(store, record);
}
