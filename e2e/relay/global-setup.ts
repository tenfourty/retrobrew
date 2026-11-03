import { copyFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { podman, relayLog, relayOwner, removeRelay } from './podman';
import { startTcpForward } from './tcp-forward';
import { startRateLimitProxy } from './rate-limit-proxy';
import { claimRelayLock, runToken } from './run-lock';
import { rememberRelay } from './running';
import {
  LOCAL_RELAY_PORT, LOCAL_RELAY_URL, OWNER_LABEL, RATE_LIMIT, RATE_LIMITED_RELAY_PORT, RELAY_CONTAINER, RELAY_IMAGE, RELAY_NAME,
} from './settings';

// Starts the local relay (a rootless podman container on 127.0.0.1) and the rate-limited proxy in front of it.
// With E2E_RELAY_UPSTREAM=host:port (CI) the relay already runs elsewhere: nothing is started with podman, and a
// TCP forward makes it answer on 127.0.0.1:17777 (and ::1) as the test build expects. Everything else is the same.
export default async function globalSetup(): Promise<void> {
  const upstream = externalRelayUpstream();
  if (upstream) {
    await setUpExternalRelay(upstream);
    return;
  }
  requireRootlessPodman();
  // playwright.config.ts has already taken the lock for this run; claiming it again is a no-op that makes this setup safe alone.
  claimRelayLock();
  const token = runToken();
  // With the lock held, no other run is using the relay, so any labelled container still here, whoever owned it, was left
  // by a run that crashed. Removing it is correct. Its log was kept until now, so print it first.
  if (relayOwner() !== undefined) {
    console.warn(`Removing a relay container left by an earlier run. Its log:\n${relayLog()}`);
    removeRelay();
  }
  const configDir = mkdtempSync(join(tmpdir(), 'retrobrew-e2e-relay-'));
  try {
    const config = join(configDir, 'config.toml');
    copyFileSync(fileURLToPath(new URL('./nostr-rs-relay.toml', import.meta.url)), config);
    // The relay runs as another user inside the container, so its config must be readable whatever the umask.
    chmodSync(config, 0o644);
    // No --rm: if a run crashes, the container and its log stay for inspection until the next run starts.
    podman(
      'run', '--detach', '--name', RELAY_CONTAINER, '--label', `${OWNER_LABEL}=${token}`,
      '--publish', `127.0.0.1:${LOCAL_RELAY_PORT}:8080`, '--volume', `${config}:/usr/src/app/config.toml:ro,Z`, RELAY_IMAGE,
    );
    await waitForRelay(`http://127.0.0.1:${LOCAL_RELAY_PORT}/`);
    const proxy = await startRateLimitProxy({ port: RATE_LIMITED_RELAY_PORT, upstream: LOCAL_RELAY_URL, limit: RATE_LIMIT });
    rememberRelay({ proxy, configDir });
  } catch (error) {
    if (relayOwner() === token) removeRelay();
    rmSync(configDir, { recursive: true, force: true });
    throw error;
  }
}

// The external relay's address from E2E_RELAY_UPSTREAM ("host:port"), or undefined for the podman relay.
export function externalRelayUpstream(value = process.env.E2E_RELAY_UPSTREAM): { host: string; port: number } | undefined {
  if (!value) return undefined;
  const match = /^([^:\s]+):(\d{1,5})$/.exec(value);
  if (!match) throw new Error(`E2E_RELAY_UPSTREAM must be host:port, not "${value}".`);
  return { host: match[1]!, port: Number(match[2]) };
}

async function setUpExternalRelay(upstream: { host: string; port: number }): Promise<void> {
  claimRelayLock();
  const forward = await startTcpForward({ port: LOCAL_RELAY_PORT, upstream });
  let proxy: Awaited<ReturnType<typeof startRateLimitProxy>> | undefined;
  try {
    await waitForRelay(`http://127.0.0.1:${LOCAL_RELAY_PORT}/`);
    proxy = await startRateLimitProxy({ port: RATE_LIMITED_RELAY_PORT, upstream: LOCAL_RELAY_URL, limit: RATE_LIMIT });
    rememberRelay({ proxy, forward });
  } catch (error) {
    await proxy?.close();
    await forward.close();
    throw error;
  }
}

function requireRootlessPodman(): void {
  let rootless: string;
  try {
    rootless = podman('info', '--format', '{{.Host.Security.Rootless}}');
  } catch {
    throw new Error('The e2e battery starts a local Nostr relay with podman, which is missing or not working. Install podman, or run the public relay smoke run instead (npm run test:e2e:public).');
  }
  if (rootless !== 'true') throw new Error('Run podman rootless: the local relay never needs root.');
}

// The relay answers NIP-11 relay information over plain HTTP once it is listening. The name proves it read our config.
async function waitForRelay(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const info = await relayInfo(url);
    if (info) {
      if (info.name === RELAY_NAME) return;
      throw new Error(`The local relay ignored its config: it calls itself "${String(info.name)}", not "${RELAY_NAME}".${logSuffix()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The local relay did not start within 30 s.${logSuffix()}`);
}

// The podman relay's log; an external relay's log is not ours to read.
function logSuffix(): string {
  return externalRelayUpstream() ? '' : ` Its log:\n${relayLog()}`;
}

async function relayInfo(url: string): Promise<{ name?: unknown } | undefined> {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/nostr+json' } });
    return response.ok ? (await response.json()) as { name?: unknown } : undefined;
  } catch {
    return undefined; // Not listening yet.
  }
}
