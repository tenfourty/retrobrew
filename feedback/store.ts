// The inbox: one sealed file per record at `<dir>/<ULID>.sealed`, mode 0600, written to a temporary name in the same
// directory, fsynced and renamed, so a crash leaves no half record and two requests never share a file.
//
// Retention is this store's own job, whatever the reader does: `sweep` deletes records older than the retention, and
// `put` deletes the oldest records when the inbox is at its ceiling (count or bytes), so it never refuses a new one.
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { open, rename, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ULID, ulid } from './ulid.ts';
import type { FileHandle } from 'node:fs/promises';

export interface StoreOptions {
  dir: string;
  now: () => number;
  maxRecords: number;
  maxBytes: number;
  retentionMs: number;
  /** Writes and syncs the data to the open file. Replaceable so a test can make a write fail. */
  write?: (file: FileHandle, data: string) => Promise<void>;
}

export interface RecordInfo {
  id: string;
  size: number;
}

export interface Store {
  /** Writes one sealed record; returns its id and how many older records were evicted to make room. */
  put(sealed: string): Promise<{ id: string; evicted: number }>;
  list(): RecordInfo[];
  /** The sealed text, or null if there is no such record. */
  read(id: string): Promise<string | null>;
  /** Deletes a record; true when it existed. A record already gone is not an error. */
  remove(id: string): Promise<boolean>;
  /** Deletes records whose modification time is older than the retention; returns how many. */
  sweep(): Promise<number>;
}

const SUFFIX = '.sealed';
const TEMP = '.tmp-';

export function createStore(options: StoreOptions): Store {
  const { dir, now, maxRecords, maxBytes, retentionMs } = options;
  const write =
    options.write ??
    (async (file: FileHandle, data: string): Promise<void> => {
      await file.writeFile(data);
      await file.sync();
    });
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // The index: id -> size and modification time. Names sort by age, so the first is the oldest.
  const index = new Map<string, { size: number; mtimeMs: number }>();
  let bytes = 0;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(TEMP)) {
      // A leftover of a crash: this process is the only writer, so it is nobody's record.
      unlinkSync(join(dir, name));
      continue;
    }
    const id = name.endsWith(SUFFIX) ? name.slice(0, -SUFFIX.length) : '';
    if (!ULID.test(id)) continue;
    const stat = statSync(join(dir, name));
    index.set(id, { size: stat.size, mtimeMs: stat.mtimeMs });
    bytes += stat.size;
  }

  const sortedIds = (): string[] => [...index.keys()].sort();
  const path = (id: string): string => join(dir, id + SUFFIX);

  async function drop(id: string): Promise<boolean> {
    const entry = index.get(id);
    if (!entry) return false;
    index.delete(id);
    bytes -= entry.size;
    try {
      await unlink(path(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return true;
  }

  async function putOne(sealed: string): Promise<{ id: string; evicted: number }> {
    const size = Buffer.byteLength(sealed);
    const id = ulid(now());
    const temp = join(dir, TEMP + randomBytes(8).toString('hex'));
    try {
      const file = await open(temp, 'wx', 0o600);
      try {
        await write(file, sealed);
      } finally {
        await file.close();
      }
      await rename(temp, path(id));
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
    index.set(id, { size, mtimeMs: now() });
    bytes += size;
    // Room is made only once the new record is on disk, so a failed write never costs an older one.
    let evicted = 0;
    for (const oldest of sortedIds()) {
      if (index.size <= maxRecords && bytes <= maxBytes) break;
      if (oldest === id) continue;
      await drop(oldest);
      evicted++;
    }
    return { id, evicted };
  }

  // Writes go one at a time, so the ceiling check and the write cannot interleave.
  let queue: Promise<unknown> = Promise.resolve();

  return {
    put(sealed) {
      const result = queue.then(() => putOne(sealed));
      queue = result.catch(() => undefined);
      return result;
    },
    list: () => sortedIds().map((id) => ({ id, size: index.get(id)!.size })),
    async read(id) {
      if (!ULID.test(id) || !index.has(id)) return null;
      try {
        return await readFile(path(id), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    remove: (id) => (ULID.test(id) ? drop(id) : Promise.resolve(false)),
    async sweep() {
      const cutoff = now() - retentionMs;
      let count = 0;
      for (const [id, entry] of [...index]) {
        if (entry.mtimeMs < cutoff && (await drop(id))) count++;
      }
      return count;
    },
  };
}
