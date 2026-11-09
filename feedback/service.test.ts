import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleBody } from '../src/test/feedback-fixtures';
import { IP_HEADER, startHarness, type Harness } from './harness.ts';
import { LOG_LINE, OUTCOMES } from './log.ts';
import { openRecord } from './open.ts';

let h: Harness;
const extraDirs: string[] = [];
afterEach(async () => {
  await h?.stop();
  for (const dir of extraDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const records = (): string[] => readdirSync(h.config.inboxDir).filter((n) => n.endsWith('.sealed'));
const ip = (n: number) => ({ [IP_HEADER]: `198.51.100.${n}` });

/** A raw request, for what fetch will not send: a chunked body, a body that never ends. */
function raw(port: number, head: string, body = ''): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(head + body));
    let text = '';
    socket.on('data', (chunk) => { text += chunk.toString(); });
    socket.on('close', () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), text }));
    socket.on('error', reject);
  });
}

describe('accepting a report', () => {
  it('answers 202, stores one sealed record, and the reader can open it', async () => {
    h = await startHarness();
    const res = await h.post(sampleBody());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    const files = records();
    expect(files).toHaveLength(1);
    const sealed = readFileSync(join(h.config.inboxDir, files[0]), 'utf8');
    expect(JSON.parse(new TextDecoder().decode(await openRecord(sealed, new Map([['k1', h.privateKey]]))))).toEqual(sampleBody());
  });

  it('stores nothing readable: the message, the email and the user agent are not in the file', async () => {
    h = await startHarness();
    const body = { ...sampleBody(), message: 'SENTINEL-MESSAGE-xyzzy', contact: { email: 'sentinel-person@example.com' } };
    expect((await h.post(body)).status).toBe(202);
    const file = readFileSync(join(h.config.inboxDir, records()[0]), 'latin1');
    for (const secret of ['SENTINEL-MESSAGE', 'sentinel-person', 'example.com', 'Mozilla']) expect(file).not.toContain(secret);
  });

  it('puts the safe headers on every kind of response and no CORS header on any', async () => {
    h = await startHarness();
    const responses = [
      await h.post(sampleBody()),
      await h.post('{'),
      await fetch(`${h.url}/feedback`),
      await fetch(`${h.url}/nope`),
      await h.post(sampleBody(), { 'content-type': 'text/plain' }),
      await fetch(`${h.url}/feedback`, { method: 'OPTIONS' }),
    ];
    for (const res of responses) {
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-type')).toBe('application/json');
      expect([...res.headers.keys()].filter((k) => k.startsWith('access-control-'))).toEqual([]);
    }
  });

  it('drops an exact duplicate with the same 202, ignoring the contact, and stores it once', async () => {
    h = await startHarness();
    expect((await h.post(sampleBody())).status).toBe(202);
    const again = await h.post({ ...sampleBody(), contact: { email: 'a@b.co' } });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ ok: true });
    expect(records()).toHaveLength(1);
    expect(h.lines.some((l) => l.includes('"duplicate"'))).toBe(true);
    h.clock.t += 24 * 3600_000 + 1;
    expect((await h.post(sampleBody(), ip(5))).status).toBe(202);
    expect(records()).toHaveLength(2);
  });

  it('stores a different report separately', async () => {
    h = await startHarness();
    await h.post(sampleBody());
    await h.post({ ...sampleBody(), message: 'Another thing.' });
    expect(records()).toHaveLength(2);
  });
});

describe('refusing a request', () => {
  it('405 with Allow: POST for another method, 404 for another path', async () => {
    h = await startHarness();
    const get = await fetch(`${h.url}/feedback`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await fetch(`${h.url}/feedback`, { method: 'PUT' })).status).toBe(405);
    expect((await fetch(`${h.url}/feedback/`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${h.url}/`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${h.url}/internal/records`)).status).toBe(404);
  });

  it('415 unless the type is application/json (a charset is fine)', async () => {
    h = await startHarness();
    expect((await h.post(sampleBody(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await h.post(sampleBody(), { 'content-type': 'application/jsonx' })).status).toBe(415);
    expect((await h.post(sampleBody(), { 'content-type': 'application/json; charset=utf-8' })).status).toBe(202);
  });

  it('403 for a foreign Origin or a cross-site fetch; accepts the app origin, same-origin and none', async () => {
    h = await startHarness();
    expect((await h.post(sampleBody(), { origin: 'https://evil.example' })).status).toBe(403);
    expect((await h.post(sampleBody(), { origin: 'https://retrobrew.app.evil.example' })).status).toBe(403);
    expect((await h.post(sampleBody(), { origin: 'null' })).status).toBe(403);
    expect((await h.post(sampleBody(), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await h.post(sampleBody(), { 'sec-fetch-site': 'same-site' })).status).toBe(403);
    expect(records()).toHaveLength(0);
    expect((await h.post(sampleBody(), { origin: 'https://retrobrew.app', 'sec-fetch-site': 'same-origin' })).status).toBe(202);
    expect((await h.post({ ...sampleBody(), message: 'two' }, { 'sec-fetch-site': 'none' })).status).toBe(202);
  });

  it('413 when Content-Length is over 16,384, before reading the body', async () => {
    h = await startHarness();
    const res = await h.post('x'.repeat(16_385));
    expect(res.status).toBe(413);
    expect(records()).toHaveLength(0);
  });

  it('413 when a chunked stream passes 16,384 bytes', async () => {
    h = await startHarness();
    const chunk = 'x'.repeat(4096);
    const body = Array.from({ length: 6 }, () => `${chunk.length.toString(16)}\r\n${chunk}\r\n`).join('') + '0\r\n\r\n';
    const res = await raw(
      Number(new URL(h.url).port),
      'POST /feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
      body,
    );
    expect(res.status).toBe(413);
    expect(records()).toHaveLength(0);
  });

  it('accepts a body of exactly 16,384 bytes up to the validator (which then refuses its shape)', async () => {
    h = await startHarness();
    expect((await h.post('x'.repeat(16_384))).status).toBe(400);
  });

  it('408 for a body that never finishes', async () => {
    h = await startHarness({ bodyTimeoutMs: 150 });
    const res = await raw(
      Number(new URL(h.url).port),
      'POST /feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"v":',
    );
    expect(res.status).toBe(408);
    expect(h.lines.some((l) => l.includes('"timeout"'))).toBe(true);
  });

  it('503 once 64 requests (here 2) are in flight', async () => {
    h = await startHarness({ maxConcurrent: 2, bodyTimeoutMs: 400 });
    const port = Number(new URL(h.url).port);
    const stuck = [1, 2].map(() => raw(port, 'POST /feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{'));
    await new Promise((r) => setTimeout(r, 100));
    const res = await h.post(sampleBody());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect((await fetch(`${h.url}/healthz`)).status).toBe(200);
    await Promise.all(stuck);
  });

  it('gives every invalid body the same 400, naming no rule', async () => {
    h = await startHarness();
    const bad: unknown[] = [
      '{', '[]', 'null', '"x"', '{}',
      { ...sampleBody(), extra: 1 },
      { ...sampleBody(), kind: 'rant' },
      { ...sampleBody(), message: '   ' },
      { ...sampleBody(), message: 'a'.repeat(2001) },
      { ...sampleBody(), message: 'see https://retrobrew.app/app/#b=abcdefghijklmnop&k=abcdefghijklmnopqrstuv' },
      { ...sampleBody(), message: 'bell\u0007' },
      { ...sampleBody(), message: 'flip ‮evil' },
      { ...sampleBody(), message: 'lone \ud800 surrogate' },
      { ...sampleBody(), contact: { email: 'Not An Email' } },
      { ...sampleBody(), report: { ...sampleBody().report, page: 'admin' } },
    ];
    const answers = new Set<string>();
    for (let i = 0; i < bad.length; i++) {
      const res = await h.post(bad[i] as never, ip(i + 1));
      expect(res.status).toBe(400);
      answers.add(await res.text());
    }
    expect([...answers]).toEqual(['{"error":"invalid"}']);
    expect(records()).toHaveLength(0);
  });

  it('400 for bytes that are not UTF-8', async () => {
    h = await startHarness();
    const res = await fetch(`${h.url}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]) });
    expect(res.status).toBe(400);
  });

  it('logs a meeting link as "link" and other rejections as "invalid"', async () => {
    h = await startHarness();
    await h.post({ ...sampleBody(), message: 'try https://retrobrew.app/app/#b=abcdefghijklmnop&k=abcdefghijklmnopqrstuv' });
    await h.post('{');
    expect(h.lines.some((l) => l.includes('"outcome":"link"'))).toBe(true);
    expect(h.lines.some((l) => l.includes('"outcome":"invalid"'))).toBe(true);
  });
});

describe('limits at the endpoint', () => {
  it('429 with Retry-After after 20 an hour from one address, and another address is unaffected', async () => {
    h = await startHarness();
    for (let i = 0; i < 20; i++) expect((await h.post({ ...sampleBody(), message: `m${i}` }, ip(1))).status).toBe(202);
    const refused = await h.post({ ...sampleBody(), message: 'm21' }, ip(1));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await h.post({ ...sampleBody(), message: 'other' }, ip(2))).status).toBe(202);
    expect(records()).toHaveLength(21);
    h.clock.t += 3600_000;
    expect((await h.post({ ...sampleBody(), message: 'm22' }, ip(1))).status).toBe(202);
  });

  it('counts a request even when its body is invalid, and checks the limit before parsing', async () => {
    h = await startHarness();
    for (let i = 0; i < 20; i++) expect((await h.post('{', ip(1))).status).toBe(400);
    expect((await h.post(sampleBody(), ip(1))).status).toBe(429);
  });

  it('503 with Retry-After at the global limit, for any address', async () => {
    h = await startHarness();
    for (let i = 0; i < 300; i++) await h.post('{', { [IP_HEADER]: `10.${i >> 8}.${i & 255}.1` });
    const res = await h.post(sampleBody(), ip(200));
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(h.lines.some((l) => l.includes('"limited_global"'))).toBe(true);
  }, 60_000);

  it('uses one shared bucket when the header is missing or not an address', async () => {
    h = await startHarness();
    for (let i = 0; i < 10; i++) await h.post({ ...sampleBody(), message: `a${i}` });
    for (let i = 0; i < 10; i++) await h.post({ ...sampleBody(), message: `b${i}` }, { [IP_HEADER]: 'garbage' });
    expect((await h.post(sampleBody())).status).toBe(429);
  });

  it('at the inbox ceiling deletes the oldest and still answers 202, logging the eviction', async () => {
    h = await startHarness({ maxRecords: 2 });
    for (let i = 0; i < 3; i++) {
      expect((await h.post({ ...sampleBody(), message: `m${i}` }, ip(i + 1))).status).toBe(202);
      h.clock.t += 1000;
    }
    expect(records()).toHaveLength(2);
    expect(h.lines.some((l) => l.includes('"outcome":"evicted","n":1'))).toBe(true);
  });
});

describe('the sweep', () => {
  it('runs at start and deletes records past 30 days though no reader ever comes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-sweep-'));
    extraDirs.push(dir);
    const inbox = join(dir, 'inbox');
    mkdirSync(inbox);
    const old = join(inbox, '01HZZZZZZZZZZZZZZZZZZZZZZZ.sealed');
    writeFileSync(old, 'x');
    const past = new Date(Date.UTC(2026, 9, 1));
    utimesSync(old, past, past);
    h = await startHarness({ inboxDir: inbox });
    expect(readdirSync(inbox)).toEqual([]);
    expect(h.lines.some((l) => l.includes('"outcome":"swept","n":1'))).toBe(true);
  });
});

describe('the internal pull route', () => {
  it('refuses a missing, malformed or wrong token with 401, and never says why', async () => {
    h = await startHarness();
    const bad: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: 'Basic abc' }, { authorization: 'Bearer ' }, { authorization: `bearer reader-test-token` }];
    for (const headers of bad) {
      const res = await fetch(`${h.internalUrl}/internal/records`, { headers });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    expect(h.lines.filter((l) => l.includes('"unauthorized"'))).toHaveLength(bad.length);
  });

  it('lists, returns one unchanged, and deletes on confirmation; a second confirmation is also done', async () => {
    h = await startHarness();
    await h.post(sampleBody());
    await h.post({ ...sampleBody(), message: 'second' });
    const list = (await (await h.internal('/internal/records')).json()) as { records: { id: string; size: number }[] };
    expect(list.records).toHaveLength(2);
    const [first] = list.records;
    const got = await h.internal(`/internal/records/${first.id}`);
    expect(got.status).toBe(200);
    const sealed = await got.text();
    expect(sealed).toBe(readFileSync(join(h.config.inboxDir, `${first.id}.sealed`), 'utf8'));
    expect(JSON.parse(new TextDecoder().decode(await openRecord(sealed, new Map([['k1', h.privateKey]]))))).toMatchObject({ v: 1 });

    // A record not confirmed is still there.
    expect(records()).toHaveLength(2);
    for (let i = 0; i < 2; i++) {
      const del = await h.internal(`/internal/records/${first.id}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
      expect(await del.json()).toEqual({ ok: true });
    }
    expect(records()).toHaveLength(1);
    expect((await h.internal(`/internal/records/${first.id}`)).status).toBe(404);
    expect(((await (await h.internal('/internal/records')).json()) as { records: unknown[] }).records).toHaveLength(1);
  });

  it('accepts only a ULID in the path', async () => {
    h = await startHarness();
    writeFileSync(join(h.dir, 'outside.sealed'), 'outside');
    for (const path of ['../outside', '..%2Foutside', '01HZ', '01hzzzzzzzzzzzzzzzzzzzzzzz', '01HZZZZZZZZZZZZZZZZZZZZZZI', '%2e%2e']) {
      for (const method of ['GET', 'DELETE']) {
        expect((await h.internal(`/internal/records/${path}`, { method })).status).toBe(404);
      }
    }
    expect(readFileSync(join(h.dir, 'outside.sealed'), 'utf8')).toBe('outside');
  });

  it('405 for a method the route does not take', async () => {
    h = await startHarness();
    expect((await h.internal('/internal/records', { method: 'DELETE' })).status).toBe(405);
    expect((await h.internal('/internal/records/01HZZZZZZZZZZZZZZZZZZZZZZZ', { method: 'POST' })).status).toBe(405);
  });

  it('is a different listener from the public one, which serves none of it', async () => {
    h = await startHarness();
    expect(h.url).not.toBe(h.internalUrl);
    expect((await fetch(`${h.url}/internal/records`, { headers: { authorization: 'Bearer reader-test-token' } })).status).toBe(404);
    expect((await h.internal('/feedback', { method: 'POST' })).status).toBe(404);
  });

  it('answers /healthz with ok on both listeners without a token', async () => {
    h = await startHarness();
    for (const base of [h.url, h.internalUrl]) {
      const res = await fetch(`${base}/healthz`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    }
  });
});

describe('slow bodies and slots', () => {
  const head = (n: number, length = 500): string =>
    `POST /feedback HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n${IP_HEADER}: 198.51.100.${n}\r\n\r\n{`;

  /** Opens a socket that sends a head and then nothing; resolves with the status line once the server answers. */
  function stall(port: number, text: string): { socket: Socket; answer: Promise<number> } {
    const socket = connect(port, '127.0.0.1', () => socket.write(text));
    const answer = new Promise<number>((resolve) => {
      let got = '';
      socket.on('data', (chunk) => { got += chunk.toString(); });
      socket.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(got)?.[1] ?? 0)));
      socket.on('error', () => resolve(0));
    });
    return { socket, answer };
  }
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('one address with many stalled bodies is refused past its own cap and cannot lock out another address', async () => {
    h = await startHarness({ bodyTimeoutMs: 1500 });
    const port = Number(new URL(h.url).port);
    const stuck = [1, 2, 3, 4].map(() => stall(port, head(1)));
    await settle(150);
    const fifth = await raw(port, head(1));
    expect(fifth.status).toBe(429);
    expect((await h.post(sampleBody(), ip(2))).status).toBe(202);
    for (const s of stuck) s.socket.destroy();
  });

  it('charges a timed-out body to the address, so repeating it runs into the limit', async () => {
    h = await startHarness({ bodyTimeoutMs: 100 });
    const port = Number(new URL(h.url).port);
    for (let i = 0; i < 20; i++) expect((await raw(port, head(7))).status).toBe(408);
    expect((await raw(port, head(7))).status).toBe(429);
    expect((await h.post(sampleBody(), ip(8))).status).toBe(202);
  });

  it('closes a connection that does not finish its headers in time', async () => {
    h = await startHarness({ headersTimeoutMs: 1000 });
    const port = Number(new URL(h.url).port);
    const started = Date.now();
    const { answer } = stall(port, 'POST /feedback HTTP/1.1\r\nHost: x\r\n');
    await answer;
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('answers 503 for the 65th request in flight and 200 for health while full', async () => {
    h = await startHarness({ bodyTimeoutMs: 4000 });
    const port = Number(new URL(h.url).port);
    const stuck = Array.from({ length: 64 }, (_, i) => stall(port, head(i + 1)));
    await settle(500);
    const res = await raw(port, head(100));
    expect(res.status).toBe(503);
    expect((await fetch(`${h.url}/healthz`)).status).toBe(200);
    for (const s of stuck) s.socket.destroy();
  });

  it('logs a counted code, and no address, when requests fall in the shared bucket', async () => {
    h = await startHarness();
    await h.post(sampleBody(), { [IP_HEADER]: 'not-an-address' });
    await h.post({ ...sampleBody(), message: 'other' });
    const shared = h.lines.filter((l) => l.includes('"unattributed"'));
    expect(shared).toHaveLength(2);
    for (const line of shared) expect(line).toMatch(LOG_LINE);
    expect(h.lines.join('')).not.toContain('not-an-address');
  });

  it('stores two simultaneous identical reports once', async () => {
    h = await startHarness();
    const body = sampleBody();
    const results = await Promise.all([h.post(body, ip(1)), h.post(body, ip(2))]);
    expect(results.map((r) => r.status)).toEqual([202, 202]);
    expect(records()).toHaveLength(1);
  });
});

describe('logging', () => {
  it('writes only codes and numbers, with no address, body fragment or header value', async () => {
    h = await startHarness();
    const sentinel = 'SENTINEL-9f3c';
    const address = '203.0.113.99';
    const hostile: unknown[] = [
      { ...sampleBody(), message: `${sentinel} fine` },
      { ...sampleBody(), message: `${sentinel} https://retrobrew.app/app/#b=abcdefghijklmnop&k=abcdefghijklmnopqrstuv` },
      { ...sampleBody(), message: `${sentinel}\u0007` },
      { ...sampleBody(), extra: sentinel },
      `{"${sentinel}": `,
      `{"${sentinel}": "\\ud800"}`,
      sentinel.repeat(2000),
    ];
    for (const body of hostile) {
      await h.post(body as never, { [IP_HEADER]: address, 'user-agent': sentinel, referer: `https://${sentinel}.example/` });
    }
    await h.post(sampleBody(), { origin: `https://${sentinel}.example`, [IP_HEADER]: address });
    await fetch(`${h.url}/${sentinel}`, { headers: { [IP_HEADER]: address } });
    await fetch(`${h.internalUrl}/internal/records`, { headers: { authorization: `Bearer ${sentinel}` } });
    await h.internal(`/internal/records/${sentinel}`);

    expect(h.lines.length).toBeGreaterThan(8);
    for (const line of h.lines) {
      expect(line).toMatch(LOG_LINE);
      expect(OUTCOMES).toContain(JSON.parse(line).outcome);
      expect(line).not.toContain(sentinel);
      expect(line).not.toContain(address);
    }
  });

  it('buckets the size and the latency', async () => {
    h = await startHarness();
    await h.post(sampleBody());
    expect(h.lines.find((l) => l.includes('accepted'))).toMatch(/"size":"<[14]k".*"latency":"<\d+m?s"/);
  });
});

describe('the source', () => {
  it('uses the client\'s validator, not a copy, and the endpoint never imports the opener', () => {
    const service = readFileSync(join(__dirname, 'service.ts'), 'utf8');
    expect(service).toContain("from '../src/feedback/schema.ts'");
    for (const file of ['service.ts', 'main.ts', 'store.ts', 'limits.ts', 'seal.ts', 'config.ts', 'log.ts']) {
      expect(readFileSync(join(__dirname, file), 'utf8')).not.toMatch(/from '\.\/open\.ts'/);
    }
  });
});
