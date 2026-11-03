// What the create form tells the host view in the same tab: open the share step once, straight after creating.
// Kept in sessionStorage, so it belongs to this tab and never reaches the board or another device.

export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function session(): KeyValueStore | null {
  try {
    return window.sessionStorage;
  } catch {
    // Storage can be blocked; the share step then simply doesn't open by itself.
    return null;
  }
}

const inviteKey = (boardId: string) => `rb-invite:${boardId}`;

export function markJustCreated(boardId: string, store: KeyValueStore | null = session()): void {
  store?.setItem(inviteKey(boardId), '1');
}

// True once, for the first host view after creating the meeting.
export function takeJustCreated(boardId: string, store: KeyValueStore | null = session()): boolean {
  const created = store?.getItem(inviteKey(boardId)) === '1';
  store?.removeItem(inviteKey(boardId));
  return created;
}
