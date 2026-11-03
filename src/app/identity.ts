import { generateSigningKeys, signerFrom, type Signer } from '../crypto/sign';
import type { BoardStore, DeviceRecord } from '../store/board-store';

// A non-extractable key per device, kept in IndexedDB, so votes survive reloads.
export async function getDeviceSigner(store: BoardStore): Promise<{ signer: Signer; name?: string }> {
  const device = await loadDevice(store);
  return { signer: await signerFrom(device.keys), name: device.name };
}

// Callers that overlap (the join form and start-up, say) share one read, so a fresh browser makes one key, not one each
// with the last write winning. The shared read is forgotten once it settles: a failure can be retried, and a later
// call sees a name remembered since.
const loading = new WeakMap<BoardStore, Promise<DeviceRecord>>();

function loadDevice(store: BoardStore): Promise<DeviceRecord> {
  const inFlight = loading.get(store);
  if (inFlight) return inFlight;
  const load = (async () => {
    const stored = await store.getDevice();
    if (stored) return stored;
    const device: DeviceRecord = { id: 'device', keys: await generateSigningKeys(false) };
    await store.putDevice(device);
    return device;
  })().finally(() => loading.delete(store));
  loading.set(store, load);
  return load;
}

// Through loadDevice, so a name given before a fresh browser's key exists is kept, on that same key.
export async function rememberName(store: BoardStore, name: string): Promise<void> {
  const device = await loadDevice(store);
  await store.putDevice({ ...device, name });
}
