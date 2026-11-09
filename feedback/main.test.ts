// Starts the real entry point as the image does (`node feedback/main.ts`, types stripped by Node, no build step), so
// syntax Node cannot strip, in this directory or in src/feedback/schema.ts, fails here and not in the container.
import { spawn } from 'node:child_process';
import { createECDH, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sampleBody } from '../src/test/feedback-fixtures';
import { LOG_LINE } from './log.ts';
import { guardProcess } from './main.ts';

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

describe('guardProcess', () => {
  it('logs a code for a request-scoped error and keeps serving', () => {
    const handlers = new Map<string, () => void>();
    const lines: string[] = [];
    guardProcess({ on: (event, handler) => void handlers.set(event, handler) }, (entry) => lines.push(entry.outcome));
    handlers.get('uncaughtException')!();
    handlers.get('unhandledRejection')!();
    expect(lines).toEqual(['error', 'error']);
  });
});

describe('node feedback/main.ts', () => {
  it('starts from the environment, takes a report, and logs only codes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-main-'));
    const [port, internalPort] = [await freePort(), await freePort()];
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    const child = spawn(process.execPath, ['feedback/main.ts'], {
      cwd: join(__dirname, '..'),
      env: {
        PATH: process.env.PATH,
        FEEDBACK_SEAL_KID: 'k1',
        FEEDBACK_SEAL_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'),
        FEEDBACK_PULL_TOKEN_SHA256: createHash('sha256').update('t').digest('hex'),
        FEEDBACK_INBOX_DIR: join(dir, 'inbox'),
        FEEDBACK_PORT: String(port),
        FEEDBACK_INTERNAL_PORT: String(internalPort),
      },
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
        if (!up) await new Promise((r) => setTimeout(r, 100));
      }
      expect(up, output).toBe(true);
      const res = await fetch(`http://127.0.0.1:${port}/feedback`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sampleBody()),
      });
      expect(res.status).toBe(202);
      expect((await fetch(`http://127.0.0.1:${internalPort}/internal/records`, { headers: { authorization: 'Bearer t' } })).status).toBe(200);
    } finally {
      const exited = new Promise((resolve) => child.on('exit', resolve));
      child.kill('SIGTERM');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
    const lines = output.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) expect(line).toMatch(LOG_LINE);
  }, 30_000);

  it('exits non-zero with a code-only line when the configuration is missing', async () => {
    const child = spawn(process.execPath, ['feedback/main.ts'], { cwd: join(__dirname, '..'), env: { PATH: process.env.PATH } });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    expect(code).toBe(1);
    expect(output.trim()).toMatch(LOG_LINE);
  });
});
