import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';
import { makeKeyPair } from './harness.ts';

async function env(): Promise<Record<string, string>> {
  const { publicRaw } = await makeKeyPair();
  return {
    FEEDBACK_SEAL_KID: 'k1',
    FEEDBACK_SEAL_PUBLIC_KEY: publicRaw.toString('base64url'),
    FEEDBACK_PULL_TOKEN_SHA256: 'ab'.repeat(32),
  };
}

describe('loadConfig', () => {
  it('reads the required values and applies the defaults', async () => {
    const config = loadConfig(await env());
    expect(config).toMatchObject({ kid: 'k1', port: 8080, internalPort: 8081, allowedOrigin: 'https://retrobrew.app', maxRecords: 3000, clientIpHeader: 'x-real-ip' });
    expect(config.publicKey).toHaveLength(65);
    expect(config.pullTokenHash).toHaveLength(32);
  });

  it('reads a value from a mounted file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-cfg-'));
    try {
      const e = await env();
      writeFileSync(join(dir, 'kid'), 'k9\n');
      delete (e as Partial<typeof e>).FEEDBACK_SEAL_KID;
      expect(loadConfig({ ...e, FEEDBACK_SEAL_KID_FILE: join(dir, 'kid') }).kid).toBe('k9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['FEEDBACK_SEAL_KID', 'FEEDBACK_SEAL_PUBLIC_KEY', 'FEEDBACK_PULL_TOKEN_SHA256'])('refuses to start without %s, naming it', async (name) => {
    const e = await env();
    delete (e as Record<string, string | undefined>)[name];
    expect(() => loadConfig(e)).toThrow(name);
  });

  it('refuses malformed values without echoing them', async () => {
    const e = await env();
    for (const [name, bad] of [
      ['FEEDBACK_SEAL_KID', 'has space'],
      ['FEEDBACK_SEAL_PUBLIC_KEY', 'AAAA'],
      ['FEEDBACK_PULL_TOKEN_SHA256', 'not-hex-secret-value'],
      ['FEEDBACK_PORT', '-1'],
    ]) {
      expect(() => loadConfig({ ...e, [name]: bad })).toThrow(new RegExp(`bad ${name}`));
      try { loadConfig({ ...e, [name]: bad }); } catch (error) { expect((error as Error).message).not.toContain(bad); }
    }
  });

  it('refuses the same port for both listeners', async () => {
    const e = await env();
    expect(() => loadConfig({ ...e, FEEDBACK_PORT: '9000', FEEDBACK_INTERNAL_PORT: '9000' })).toThrow('must differ');
  });
});
