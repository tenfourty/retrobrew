import { rmSync } from 'node:fs';
import { relayOwner, removeRelay } from './podman';
import { releaseRelayLock, runToken } from './run-lock';
import { forgetRelay } from './running';

// Stops what global-setup.ts started, and only that: another run's relay is left alone. An external relay
// (E2E_RELAY_UPSTREAM) is left running for its owner. A public run started no relay (and may have no podman),
// so it only releases the run lock.
export default async function globalTeardown(): Promise<void> {
  const relay = forgetRelay();
  if (relay) {
    await relay.proxy.close();
    await relay.forward?.close();
    // An external relay has no podman container and its config directory is not ours.
    if (!relay.forward) {
      if (relayOwner() === runToken()) removeRelay();
    }
    if (relay.configDir) rmSync(relay.configDir, { recursive: true, force: true });
  }
  releaseRelayLock();
}
