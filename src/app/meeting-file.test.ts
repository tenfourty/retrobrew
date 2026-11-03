import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { generateRoomKey } from '../crypto/aead';
import { toB64url } from '../crypto/bytes';
import { exportKeyPair, fingerprint, generateSigningKeys, signerFrom } from '../crypto/sign';
import { createBoard } from '../engine/board';
import { exportBoard, MAX_IMPORT_BYTES, type BoardRecord } from '../store/board-store';
import { checkFileSize, FILE_DAMAGED, FILE_NOT_RETROBREW, FILE_OLDER_VERSION, meetingStatus, readMeetingFile } from './meeting-file';

async function newRecord(): Promise<BoardRecord> {
  const pair = await generateSigningKeys(true);
  const signer = await signerFrom(pair);
  const boardId = 'board-guid-123';
  return {
    boardId, roomKey: toB64url(generateRoomKey()), hostPub: signer.pub, hostKeys: await exportKeyPair(pair),
    epoch: 3, relays: ['wss://relay.example'], updatedAt: 1,
    state: createBoard({ boardId, boardName: 'Team', ownerId: await fingerprint(signer.pub), ownerName: 'Ann' }),
  };
}

describe('readMeetingFile', () => {
  it('reads a backup', async () => {
    const record = await newRecord();
    expect((await readMeetingFile(exportBoard(record, true))).boardId).toBe('board-guid-123');
  });

  it("says a file that isn't ours isn't a Retrobrew meeting file", async () => {
    for (const text of ['not json', '[1, 2]', '{"format": "something-else"}', 'null']) {
      await expect(readMeetingFile(text)).rejects.toThrow(FILE_NOT_RETROBREW);
    }
  });

  it('says one of ours that can’t be run is damaged or incomplete', async () => {
    const record = await newRecord();
    await expect(readMeetingFile('{"format": "retrobrew-board", "version": 2}')).rejects.toThrow(FILE_DAMAGED);
    await expect(readMeetingFile(exportBoard(record, false))).rejects.toThrow(FILE_DAMAGED);
  });

  it('says a file made by an older version can’t be opened, and to start a new meeting', async () => {
    await expect(readMeetingFile('{"format": "retrobrew-board", "version": 1, "board": {}}')).rejects.toThrow(FILE_OLDER_VERSION);
    expect(FILE_OLDER_VERSION).toContain('older version');
    expect(FILE_OLDER_VERSION).toContain('start a new meeting');
  });
});

describe('checkFileSize', () => {
  it('says a file too big to read isn’t a Retrobrew meeting file', () => {
    expect(() => checkFileSize(MAX_IMPORT_BYTES + 1)).toThrow(FILE_NOT_RETROBREW);
    expect(() => checkFileSize(MAX_IMPORT_BYTES)).not.toThrow();
  });
});

describe('meetingStatus', () => {
  it('names the phase, and the date a meeting ended', () => {
    expect(meetingStatus({ phase: 'topics', endedAt: null })).toBe('Collecting topics');
    expect(meetingStatus({ phase: 'discussion', endedAt: null })).toBe('In discussion');
    expect(meetingStatus({ phase: 'ended', endedAt: new Date(2026, 9, 6, 12).getTime() })).toBe('Ended 6 Oct 2026');
  });
});
