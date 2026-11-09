// A running service on loopback ports with a fake clock, a temporary inbox and a reader key pair, for the tests.
// Not part of the image.
import { createHash, webcrypto } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from './config.ts';
import { start } from './main.ts';
import { createLogger } from './log.ts';

export const TOKEN = 'reader-test-token';
export const IP_HEADER = 'x-real-ip';
export const KID = 'k1';

export async function makeKeyPair(): Promise<{ publicRaw: Buffer; privateKey: CryptoKey }> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { publicRaw: Buffer.from(await webcrypto.subtle.exportKey('raw', pair.publicKey)), privateKey: pair.privateKey as unknown as CryptoKey };
}

export interface Harness {
  config: Config;
  dir: string;
  lines: string[];
  clock: { t: number };
  privateKey: CryptoKey;
  url: string;
  internalUrl: string;
  post(body: unknown, headers?: Record<string, string>): Promise<Response>;
  internal(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

export async function startHarness(over: Partial<Config> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rb-feedback-'));
  const { publicRaw, privateKey } = await makeKeyPair();
  // Built through loadConfig, so the defaults under test are the defaults the service runs with. Ports are then set to 0
  // (any free port), which the loader itself refuses.
  const config: Config = {
    ...loadConfig({
      FEEDBACK_SEAL_KID: KID,
      FEEDBACK_SEAL_PUBLIC_KEY: publicRaw.toString('base64url'),
      FEEDBACK_PULL_TOKEN_SHA256: createHash('sha256').update(TOKEN).digest('hex'),
      FEEDBACK_INBOX_DIR: join(dir, 'inbox'),
    }),
    port: 0,
    internalPort: 0,
    ...over,
  };
  const clock = { t: Date.UTC(2026, 10, 9, 10, 0, 0) };
  const lines: string[] = [];
  const running = await start(config, createLogger((line) => lines.push(line), () => clock.t), () => clock.t);
  const url = `http://127.0.0.1:${running.ports.public}`;
  const internalUrl = `http://127.0.0.1:${running.ports.internal}`;
  return {
    config, dir, lines, clock, privateKey, url, internalUrl,
    post: (body, headers = {}) =>
      fetch(`${url}/feedback`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    internal: (path, init = {}) =>
      fetch(`${internalUrl}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers as Record<string, string>) } }),
    async stop() {
      await running.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
