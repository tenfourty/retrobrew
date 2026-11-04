import { execFileSync } from 'node:child_process';
import { externalRelayUpstream } from './global-setup';
import { podman } from './podman';
import { RELAY_CONTAINER } from './settings';

// Restarts the local relay as a server-side restart does: every socket drops at once.
// - Locally the relay is a rootless podman container.
// - With E2E_RELAY_UPSTREAM (CI) it is a container of the same name that the job started on the runner's Docker daemon,
//   and the job's docker CLI (through the mounted socket) restarts it; the TCP forward on 127.0.0.1:17777 connects afresh for each socket.
// Anything else that goes wrong throws, naming the mode: a restart that silently did nothing would make the test pass for the wrong reason.
export function restartRelay(): void {
  const external = externalRelayUpstream() !== undefined;
  try {
    // --time 0: the image's shell entrypoint ignores SIGTERM, so don't wait for a graceful stop.
    if (external) execFileSync('docker', ['restart', '--time', '0', RELAY_CONTAINER], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    else podman('restart', '--time', '0', RELAY_CONTAINER);
  } catch (error) {
    throw new Error(`Could not restart the relay container ${RELAY_CONTAINER} with ${external ? 'docker (E2E_RELAY_UPSTREAM is set)' : 'podman'}: ${(error as Error).message}`);
  }
}
