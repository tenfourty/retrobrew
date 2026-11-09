import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore, type Store } from './store.ts';
import { ULID } from './ulid.ts';

const DAY = 24 * 3600_000;
let dir: string;
let clock: { t: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rb-store-'));
  clock = { t: Date.UTC(2026, 10, 9) };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const open = (over: Partial<Parameters<typeof createStore>[0]> = {}): Store =>
  createStore({ dir: join(dir, 'inbox'), now: () => clock.t, maxRecords: 3000, maxBytes: 30 * 1024 * 1024, retentionMs: 30 * DAY, ...over });

describe('store', () => {
  it('writes one 0600 file per record, named by a ULID, and reads it back', async () => {
    const store = open();
    const { id } = await store.put('sealed-1');
    expect(id).toMatch(ULID);
    expect(readdirSync(join(dir, 'inbox'))).toEqual([`${id}.sealed`]);
    expect(statSync(join(dir, 'inbox', `${id}.sealed`)).mode & 0o777).toBe(0o600);
    expect(await store.read(id)).toBe('sealed-1');
    expect(store.list()).toEqual([{ id, size: 8 }]);
  });

  it('lists oldest first, and survives a restart', async () => {
    const store = open();
    const a = await store.put('a');
    clock.t += 1000;
    const b = await store.put('bb');
    expect(store.list().map((r) => r.id)).toEqual([a.id, b.id]);
    expect(open().list().map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('leaves no temporary file behind, and clears a crash leftover at start', async () => {
    const store = open();
    await store.put('x');
    expect(readdirSync(join(dir, 'inbox')).filter((n) => n.startsWith('.tmp-'))).toEqual([]);
    writeFileSync(join(dir, 'inbox', '.tmp-deadbeef'), 'half');
    const reopened = open();
    expect(readdirSync(join(dir, 'inbox'))).toHaveLength(1);
    expect(reopened.list()).toHaveLength(1);
  });

  it('ignores files that are not records and never reads outside the inbox', async () => {
    const store = open();
    writeFileSync(join(dir, 'secret.sealed'), 'outside');
    writeFileSync(join(dir, 'inbox', 'notes.txt'), 'x');
    expect(open().list()).toEqual([]);
    expect(await store.read('../secret')).toBeNull();
    expect(await store.read('../secret.sealed')).toBeNull();
    expect(await store.remove('../secret')).toBe(false);
  });

  it('removes a record, and a second removal is not an error', async () => {
    const store = open();
    const { id } = await store.put('x');
    expect(await store.remove(id)).toBe(true);
    expect(await store.remove(id)).toBe(false);
    expect(await store.read(id)).toBeNull();
    expect(readdirSync(join(dir, 'inbox'))).toEqual([]);
  });

  it('sweeps records past 30 days with no reader running, keeps the rest', async () => {
    const store = open();
    const old = await store.put('old');
    clock.t += 29 * DAY;
    const young = await store.put('young');
    expect(await store.sweep()).toBe(0);
    clock.t += 2 * DAY; // old is 31 days, young is 2
    expect(await store.sweep()).toBe(1);
    expect(store.list().map((r) => r.id)).toEqual([young.id]);
    expect(await store.read(old.id)).toBeNull();
  });

  it('sweeps by file modification time after a restart', async () => {
    const first = open({ now: () => Date.now() });
    const { id } = await first.put('x');
    const past = new Date(Date.now() - 31 * DAY);
    utimesSync(join(dir, 'inbox', `${id}.sealed`), past, past);
    const second = open({ now: () => Date.now() });
    expect(await second.sweep()).toBe(1);
    expect(readdirSync(join(dir, 'inbox'))).toEqual([]);
  });

  it('at the record ceiling deletes the oldest and accepts the new one', async () => {
    const store = open({ maxRecords: 3 });
    const ids: string[] = [];
    for (const text of ['1', '2', '3']) {
      ids.push((await store.put(text)).id);
      clock.t += 1000;
    }
    const result = await store.put('4');
    expect(result.evicted).toBe(1);
    expect(store.list().map((r) => r.id)).toEqual([ids[1], ids[2], result.id]);
    expect(await store.read(ids[0])).toBeNull();
  });

  it('at the byte ceiling deletes as many of the oldest as it takes', async () => {
    const store = open({ maxBytes: 10 });
    await store.put('aaaa');
    clock.t += 1000;
    await store.put('bbbb');
    clock.t += 1000;
    const result = await store.put('cccccccc');
    expect(result.evicted).toBe(2);
    expect(store.list()).toHaveLength(1);
  });

  it('keeps the ceiling under concurrent writes', async () => {
    const store = open({ maxRecords: 5 });
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.put(String(i))));
    expect(store.list()).toHaveLength(5);
    expect(readdirSync(join(dir, 'inbox'))).toHaveLength(5);
  });

  it('leaves no temporary file when a write fails, and keeps the older records', async () => {
    let fail = false;
    const store = open({
      maxRecords: 2,
      write: async (file, data) => {
        if (fail) throw new Error('disk full');
        await file.writeFile(data);
        await file.sync();
      },
    });
    const a = await store.put('a');
    clock.t += 1000;
    const b = await store.put('b');
    clock.t += 1000;
    fail = true;
    await expect(store.put('c')).rejects.toThrow();
    expect(readdirSync(join(dir, 'inbox')).sort()).toEqual([`${a.id}.sealed`, `${b.id}.sealed`]);
    expect(store.list().map((r) => r.id)).toEqual([a.id, b.id]);
    fail = false;
    clock.t += 1000;
    const c = await store.put('c');
    expect(store.list().map((r) => r.id)).toEqual([b.id, c.id]);
  });
});
