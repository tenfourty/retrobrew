import { describe, expect, it } from 'vitest';
import type { BoardStore, DeviceRecord } from '../store/board-store';
import { getDeviceSigner, rememberName } from './identity';

// Only the device half of the store; each read and write yields first, as IndexedDB does.
function deviceStore(): { store: BoardStore; puts: () => number } {
  let device: DeviceRecord | undefined;
  let puts = 0;
  const store = {
    getDevice: async () => { await Promise.resolve(); return device; },
    putDevice: async (record: DeviceRecord) => { await Promise.resolve(); puts += 1; device = record; },
  } as unknown as BoardStore;
  return { store, puts: () => puts };
}

describe('getDeviceSigner', () => {
  it('creates one key when called twice at once, and both callers sign with it', async () => {
    const { store, puts } = deviceStore();
    const [a, b] = await Promise.all([getDeviceSigner(store), getDeviceSigner(store)]);
    expect(a.signer.pub).toBe(b.signer.pub);
    expect(puts()).toBe(1);
    expect((await getDeviceSigner(store)).signer.pub).toBe(a.signer.pub);
  });

  it('tries again after a failed first attempt', async () => {
    const { store } = deviceStore();
    const put = store.putDevice;
    let failures = 1;
    store.putDevice = async (record) => {
      if (failures-- > 0) throw new Error('quota');
      return put(record);
    };
    await expect(getDeviceSigner(store)).rejects.toThrow('quota');
    await expect(getDeviceSigner(store)).resolves.toHaveProperty('signer.pub');
  });
});

describe('rememberName', () => {
  it('remembers the name in a fresh browser, and keeps the one key, even while that key is still being made', async () => {
    const { store, puts } = deviceStore();
    const loading = getDeviceSigner(store);
    await rememberName(store, 'Ada');
    const { signer } = await loading;
    const after = await getDeviceSigner(store);
    expect(after.name).toBe('Ada');
    expect(after.signer.pub).toBe(signer.pub);
    expect(puts()).toBe(2);
  });
});
