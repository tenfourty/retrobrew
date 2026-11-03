import { execFileSync } from 'node:child_process';
import { OWNER_LABEL, RELAY_CONTAINER } from './settings';

export function podman(...args: string[]): string {
  return execFileSync('podman', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The run token of the test run that started the relay container, or undefined when there is no container.
export function relayOwner(): string | undefined {
  const owner = podman('ps', '--all', '--filter', `name=^${RELAY_CONTAINER}$`, '--format', `{{ index .Labels "${OWNER_LABEL}" }}`);
  return owner || undefined;
}

export function removeRelay(): void {
  // The image's shell entrypoint ignores SIGTERM, so don't wait for a graceful stop.
  podman('rm', '--force', '--ignore', '--time', '0', RELAY_CONTAINER);
}

// The end of the relay's log, for error messages. Never throws: it is called when something has already gone wrong.
export function relayLog(): string {
  try {
    return podman('logs', '--tail', '20', RELAY_CONTAINER);
  } catch (error) {
    return `(no log: ${(error as Error).message})`;
  }
}
