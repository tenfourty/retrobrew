import { openDB } from 'idb';
import { fromB64url } from '../crypto/bytes';
import { importKeyPair } from '../crypto/sign';
import { MAX_ATTENDEES, MAX_BOARD_NAME, MAX_NAME, MAX_TOPIC, MAX_TOPICS, utf8Bytes } from '../engine/limits';
import { migrateBoard } from '../engine/migrate';
import { SOUND_IDS, VOTE_ALLOWANCES, type BoardState } from '../engine/types';
import { RESERVED_KEYS, parseTabTable, type TabTable } from '../session/tabs';

export interface BoardRecord {
  boardId: string;
  roomKey: string;
  hostPub: string;
  hostKeys: { publicKey: JsonWebKey; privateKey?: JsonWebKey };
  epoch: number;
  state: BoardState;
  relays: string[];
  updatedAt: number;
  // Each person's tabs: acks, pending rejects and the pruning watermark. Saved in the same write as state.
  tabs?: TabTable;
  // Whether navigator.storage.persist() promised to keep this browser's data when the meeting was created or imported
  // here. Absent on meetings made before the note existed: no banner for them. Never exported or imported.
  persistence?: 'granted' | 'refused';
}

// Device keys are non-extractable CryptoKeys; IndexedDB stores them as they are.
export interface DeviceRecord {
  id: 'device';
  keys: CryptoKeyPair;
  name?: string;
}

// A meeting this device joined as a guest (docs/product/mvp-screens.md, Your meetings). It holds no board: only the
// meeting's name, the share link the person was given (the same link they already hold, so it exposes nothing beyond
// that board) and the name they joined under. It is never exported, and no wire message carries it.
export interface JoinedRecord {
  boardId: string;
  boardName: string;
  link: string;
  name: string;
  joinedAt: number;
  // When the meeting ended, once this device's page has seen the ended view. Optional, so records made before it
  // (and meetings still running) read as before and the store needs no new version.
  endedAt?: number;
}

// The device keeps this many joined meetings; the oldest go first.
export const JOINED_LIMIT = 20;

export interface BoardStore {
  get(id: string): Promise<BoardRecord | undefined>;
  put(record: BoardRecord): Promise<void>;
  // Changes only the persistence note of the stored record, in one transaction, so a write another tab made since
  // (a host's saved state) is never overwritten. Resolves the record as stored, or undefined if there is none.
  notePersistence(id: string, note: 'granted' | 'refused'): Promise<BoardRecord | undefined>;
  list(): Promise<BoardRecord[]>;
  remove(id: string): Promise<void>;
  listJoined(): Promise<JoinedRecord[]>;
  putJoined(record: JoinedRecord): Promise<void>;
  removeJoined(id: string): Promise<void>;
  getDevice(): Promise<DeviceRecord | undefined>;
  putDevice(record: DeviceRecord): Promise<void>;
  close(): void;
}

export const EXPORT_FORMAT = 'retrobrew-board';
// Version 2 files use the protocol 3 names. A version 1 file, made before protocol 3, can't be opened (OlderVersionError).
const EXPORT_VERSION = 2;

export const OLDER_VERSION_MESSAGE = 'This file was made by an older version of Retrobrew and can’t be opened. Please start a new meeting';
export class OlderVersionError extends Error {
  constructor() {
    super(OLDER_VERSION_MESSAGE);
    this.name = 'OlderVersionError';
  }
}

// Every board read from storage or a file is brought up to date before anyone uses it.
// The tab table is checked too: malformed or reserved keys are dropped, a table malformed elsewhere is left out, and
// one over the tab bounds is brought within them.
function migrateRecord(record: BoardRecord): BoardRecord {
  const { tabs, ...rest } = record;
  const parsed = tabs === undefined ? null : parseTabTable(tabs, Date.now());
  return { ...rest, epoch: safeEpoch(record.epoch), state: migrateBoard(record.state), ...(parsed ? { tabs: parsed } : {}) };
}

function isJoinedRecord(x: unknown): x is JoinedRecord {
  if (typeof x !== 'object' || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r.boardId === 'string' && typeof r.boardName === 'string' && typeof r.link === 'string'
    && typeof r.name === 'string' && typeof r.joinedAt === 'number'
    && (r.endedAt === undefined || (typeof r.endedAt === 'number' && Number.isFinite(r.endedAt)));
}

export async function openStore(name = 'retrobrew'): Promise<BoardStore> {
  // Version 2 keys the boards by boardId. A version 1 database (made before protocol 3) keyed them by another field, and
  // a store's key path can't change, so its boards are dropped: they can't be read, and the store is recreated empty.
  const db = await openDB(name, 3, {
    upgrade(database, oldVersion) {
      if (oldVersion === 0) {
        database.createObjectStore('boards', { keyPath: 'boardId' });
        database.createObjectStore('device', { keyPath: 'id' });
        database.createObjectStore('joined', { keyPath: 'boardId' });
        return;
      }
      if (oldVersion < 2) {
        database.deleteObjectStore('boards');
        database.createObjectStore('boards', { keyPath: 'boardId' });
      }
      // Version 3 adds the meetings this device joined as a guest.
      if (oldVersion < 3) database.createObjectStore('joined', { keyPath: 'boardId' });
    },
  });
  return {
    get: async (id) => {
      const record = (await db.get('boards', id)) as BoardRecord | undefined;
      return record && migrateRecord(record);
    },
    put: async (record) => { await db.put('boards', record); },
    notePersistence: async (id, note) => {
      const tx = db.transaction('boards', 'readwrite');
      const stored = (await tx.store.get(id)) as BoardRecord | undefined;
      if (stored) await tx.store.put({ ...stored, persistence: note });
      await tx.done;
      return stored && migrateRecord({ ...stored, persistence: note });
    },
    list: async () => ((await db.getAll('boards')) as BoardRecord[]).map(migrateRecord),
    remove: (id) => db.delete('boards', id),
    listJoined: async () => ((await db.getAll('joined')) as JoinedRecord[]).filter(isJoinedRecord),
    putJoined: async (record) => {
      const tx = db.transaction('joined', 'readwrite');
      await tx.store.put(record);
      const all = ((await tx.store.getAll()) as JoinedRecord[]).sort((a, b) => b.joinedAt - a.joinedAt);
      for (const old of all.slice(JOINED_LIMIT)) await tx.store.delete(old.boardId);
      await tx.done;
    },
    removeJoined: (id) => db.delete('joined', id),
    getDevice: () => db.get('device', 'device') as Promise<DeviceRecord | undefined>,
    putDevice: async (record) => { await db.put('device', record); },
    close: () => db.close(),
  };
}

// A plain export is an archive: without the room key and host key it can't be used to join or run the meeting.
// The backup (with keys) also keeps the tab table, so a restored meeting still recognises duplicate commands.
export function exportBoard(record: BoardRecord, includeKeys: boolean): string {
  // Neither carries the persistence note: it belongs to this browser.
  const board = includeKeys ? { ...record, persistence: undefined } : { ...record, roomKey: undefined, hostKeys: { publicKey: record.hostKeys.publicKey }, tabs: undefined, persistence: undefined };
  return JSON.stringify({ format: EXPORT_FORMAT, version: EXPORT_VERSION, board }, null, 2);
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isInt = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min;
const isStr = (x: unknown): x is string => typeof x === 'string';
const optional = (x: unknown, check: (v: unknown) => boolean): boolean => x === undefined || check(x);
const COLUMNS = ['ideas', 'toDiscuss', 'discussing', 'discussed'];
const ROLES = ['owner', 'facilitator', 'guest'];
const PHASES = ['topics', 'discussion', 'ended'];
// The hard ceiling: ten times the caps. A board between the caps and the ceiling still loads (growth is refused later);
// anything past it is refused outright, so a hostile file can't make the app build huge structures.
const CEILING = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ID = 128 * CEILING;
const MAX_RELAYS = 8 * CEILING;
const MAX_VOTERS_PER_TOPIC = MAX_ATTENDEES * Math.max(...VOTE_ALLOWANCES) * CEILING;
const textWithin = (x: unknown, max: number): boolean => isStr(x) && x.length <= max * 2 * CEILING && [...x].length <= max * CEILING;
const idList = (x: unknown, max: number): boolean => Array.isArray(x) && x.length <= max && x.every((v) => isStr(v) && v.length <= MAX_ID);
const BOARD_ID = /^[A-Za-z0-9_-]{8,64}$/;

function bytesOfLength(x: unknown, length: number): boolean {
  try {
    return isStr(x) && fromB64url(x).length === length;
  } catch {
    return false;
  }
}

function validTopic(x: unknown): boolean {
  return isRecord(x) && isInt(x.topicId, 1) && x.topicId < Number.MAX_SAFE_INTEGER - 1 && textWithin(x.text, MAX_TOPIC) && COLUMNS.includes(x.column as string) && isNum(x.position)
    && isStr(x.authorId) && x.authorId.length <= MAX_ID && idList(x.voters, MAX_VOTERS_PER_TOPIC);
}

function validTimer(x: unknown): boolean {
  return x === null || (isRecord(x) && isInt(x.topicId, 1) && isNum(x.startedAt) && isNum(x.endsAt)
    && optional(x.round, (v) => isInt(v)) && optional(x.minuteMs, (v) => isInt(v, 1)));
}

function validContinueVote(x: unknown): boolean {
  if (x === null) return true;
  if (!isRecord(x) || !isInt(x.topicId, 1) || !isInt(x.round) || !idList(x.voters, MAX_ATTENDEES * CEILING)) return false;
  const totals = x.totals;
  return isRecord(totals) && isInt(totals.extend) && isInt(totals.none) && isInt(totals.end);
}

function validMoveOnUndo(x: unknown): boolean {
  return x === null || (isRecord(x) && isInt(x.topicId, 1) && x.timer !== null && validTimer(x.timer) && validContinueVote(x.continueVote) && x.continueVote !== null);
}

// Every field the engine relies on. MVP fields may be missing from older files (migrateBoard fills them in on load),
// but must be well typed when present. An unknown timer sound is refused, like an unknown phase.
export function validateBoardState(x: unknown): x is BoardState {
  if (!isRecord(x)) return false;
  if (!isStr(x.boardId) || !textWithin(x.boardName, MAX_BOARD_NAME) || !isInt(x.voteAllowance, 1) || x.voteAllowance > Math.max(...VOTE_ALLOWANCES)
    || typeof x.showVotes !== 'boolean' || !isInt(x.topicIdSeed, 1)
    || !Array.isArray(x.topics) || x.topics.length > MAX_TOPICS * CEILING || !x.topics.every(validTopic)
    || !isRecord(x.attendees)) return false;
  // Two topics with one topicId would make every command on that card ambiguous: that is corruption, not something to repair.
  if (new Set(x.topics.map((t: { topicId: number }) => t.topicId)).size !== x.topics.length) return false;
  const people = Object.entries(x.attendees);
  // A key that is reserved, or that differs from the person's own id, is refused.
  const attendeesOk = people.length <= MAX_ATTENDEES * CEILING && people.every(([id, a]) =>
    !RESERVED_KEYS.has(id) && isRecord(a) && a.id === id && id.length <= MAX_ID && textWithin(a.name, MAX_NAME) && ROLES.includes(a.role as string));
  return attendeesOk && validTimer(x.timer)
    && optional(x.phase, (v) => PHASES.includes(v as string))
    && optional(x.voteRound, (v) => isInt(v))
    && optional(x.continueVote, validContinueVote)
    && optional(x.moveOnUndo, validMoveOnUndo)
    && optional(x.timerSound, (v) => (SOUND_IDS as readonly unknown[]).includes(v))
    && optional(x.endedAt, (v) => v === null || isNum(v))
    && optional(x.discussedOrder, (v) => Array.isArray(v) && v.length <= MAX_TOPICS * CEILING && v.every((id) => isInt(id, 1)))
    && optional(x.rehearsal, (v) => typeof v === 'boolean');
}

// Repairs what is safe to repair in a valid state: a card-ID seed that could re-issue an existing ID, a timer or time-up
// vote naming a topic that isn't there, and a finished-order list with unknown or repeated cards.
function repairState(state: BoardState): BoardState {
  const ids = new Set(state.topics.map((t) => t.topicId));
  const largest = Math.max(0, ...ids);
  const discussedOrder = state.discussedOrder === undefined ? undefined : [...new Set(state.discussedOrder.filter((id) => ids.has(id)))];
  return {
    ...state,
    topicIdSeed: state.topicIdSeed > largest ? state.topicIdSeed : largest + 1,
    timer: state.timer && ids.has(state.timer.topicId) ? state.timer : null,
    ...(state.continueVote === undefined ? {} : { continueVote: state.continueVote && ids.has(state.continueVote.topicId) ? state.continueVote : null }),
    ...(discussedOrder ? { discussedOrder } : {}),
  };
}

export function importBoard(json: string): BoardRecord {
  const notABoard = new Error('This file is not a Retrobrew board');
  let parsed: unknown;
  if (typeof json !== 'string') throw notABoard;
  if (json.length > MAX_FILE_BYTES || (json.length * 3 > MAX_FILE_BYTES && utf8Bytes(json) > MAX_FILE_BYTES)) throw tooBig();
  try {
    parsed = JSON.parse(json);
  } catch {
    throw notABoard;
  }
  const file = parsed as { format?: unknown; version?: unknown; board?: unknown };
  if (file?.format === EXPORT_FORMAT && file.version === 1) throw new OlderVersionError();
  if (file?.format !== EXPORT_FORMAT || file.version !== EXPORT_VERSION || !isRecord(file.board)) throw notABoard;
  const board = file.board;
  const hostKeys = board.hostKeys as BoardRecord['hostKeys'] | undefined;
  if (board.roomKey === undefined || !hostKeys?.privateKey) throw new Error('This file has no keys, so this browser can’t run the board');
  const tabs = board.tabs === undefined ? undefined : parseTabTable(board.tabs, Date.now());
  // The epoch is not checked: one that isn't a safe count (Infinity and NaN arrive as null) loads as 0 (migrateRecord),
  // and the host's next epoch is then the clock (nextEpoch), so a damaged backup still loads and its views still pass.
  // The state's board ID must match the record's: otherwise every hello and command would drop silently.
  const valid = isStr(board.boardId) && BOARD_ID.test(board.boardId)
    && bytesOfLength(board.roomKey, 32) && bytesOfLength(board.hostPub, 65)
    && isRecord(hostKeys.publicKey) && isRecord(hostKeys.privateKey)
    && isNum(board.updatedAt)
    && Array.isArray(board.relays) && board.relays.length <= MAX_RELAYS && board.relays.every((r) => isStr(r) && r.length <= 2048 && /^wss?:\/\//.test(r))
    && validateBoardState(board.state) && board.state.boardId === board.boardId
    && tabs !== null;
  if (!valid) throw notABoard;
  const record = { ...(board as unknown as BoardRecord) };
  // The persistence note describes the browser that made the meeting, not this one: an import drops it, and the
  // app asks this browser and records the answer (src/app/persistence.ts).
  delete record.persistence;
  // The tab table as parsed (brought within today's bounds), never the raw one from the file.
  return migrateRecord({ ...record, state: repairState(record.state), tabs });
}

export const MAX_IMPORT_BYTES = MAX_FILE_BYTES;
export const tooBig = (): Error => new Error('This file is too big to be a Retrobrew board');

// importBoard, plus a check that the stored host key pair can really be imported, so a file with unusable keys
// is refused now rather than failing when the host starts.
export async function readBoardFile(json: string): Promise<BoardRecord> {
  const record = importBoard(json);
  try {
    await importKeyPair({ publicKey: record.hostKeys.publicKey, privateKey: record.hostKeys.privateKey! });
  } catch {
    throw new Error('This file is not a Retrobrew board');
  }
  return record;
}

// Importing a board this browser already has never lowers its epoch, so the next host session still beats
// every view that participants have seen.
export function mergeImported(existing: BoardRecord | undefined, imported: BoardRecord): BoardRecord {
  if (!existing) return imported;
  return { ...imported, epoch: Math.max(safeEpoch(existing.epoch), imported.epoch) };
}

// Saves an imported board, unless a tab is hosting that meeting right now: the host's own saves would race the
// import, and the import's older state and tab table could overwrite what the host has acknowledged.
// The stored epoch is read under the same guard and never lowered, so the import can't win over a newer epoch.
// Returns what was saved.
export async function saveImportedBoard(store: BoardStore, imported: BoardRecord, isHosted: (boardId: string) => Promise<boolean>): Promise<BoardRecord> {
  if (await isHosted(imported.boardId)) throw new Error('This meeting is open in another tab. Close it there, then import the file again');
  const record = mergeImported(await store.get(imported.boardId), imported);
  await store.put(record);
  return record;
}

// Whenever the host resumes from storage (a reload or an import), its epoch is the later of the saved epoch plus one
// and the clock, so its first view beats anything older even if the saved epoch was lost or came from an old backup.
// A saved epoch that isn't a safe count, or whose successor wouldn't be, counts as 0.
export function nextEpoch(saved: number, now: number): number {
  return Math.max(safeEpoch(saved) + 1, now);
}

// An epoch every receiver accepts as a count (a safe, non-negative integer) with room for one more, or else 0.
function safeEpoch(x: unknown): number {
  return Number.isSafeInteger(x) && (x as number) >= 0 && (x as number) < Number.MAX_SAFE_INTEGER ? (x as number) : 0;
}
