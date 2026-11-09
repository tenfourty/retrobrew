import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleBody } from '../src/test/feedback-fixtures.ts';
import { createFeedbackStub } from './feedback-stub.mjs';

let server;
let base;

beforeEach(async () => {
  const stub = createFeedbackStub({ slowMs: 50 });
  server = createServer((req, res) => stub.handle(req, res, () => { res.statusCode = 404; res.end('next'); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

const post = (path, body, type = 'application/json') => fetch(base + path, { method: 'POST', headers: { 'content-type': type }, body });
const state = async () => (await fetch(`${base}/__feedback`)).json();
const setMode = (mode) => post('/__feedback/mode', JSON.stringify({ mode }));
const valid = () => JSON.stringify(sampleBody());

describe('feedback stub', () => {
  it('accepts a valid body with 202 and keeps exactly the string it was sent', async () => {
    const res = await post('/feedback', valid());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    expect((await state()).received).toEqual([valid()]);
  });

  it('refuses what the validator refuses, with the same generic 400, and keeps nothing', async () => {
    const res = await post('/feedback', JSON.stringify({ ...sampleBody(), kind: 'nope' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid' });
    expect((await state()).received).toEqual([]);
  });

  it('answers 400 to bad JSON, 415 to the wrong type, 405 to GET and passes other paths on', async () => {
    expect((await post('/feedback', '{')).status).toBe(400);
    expect((await post('/feedback', valid(), 'text/plain')).status).toBe(415);
    const get = await fetch(`${base}/feedback`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('cuts off a body over 16,384 bytes with 413', async () => {
    expect((await post('/feedback', JSON.stringify({ pad: 'x'.repeat(17_000) }))).status).toBe(413);
  });

  it('sets no CORS header and always no-store', async () => {
    const res = await post('/feedback', '{');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('forces 500 in fail, 429 in ratelimit and a delayed 202 in slow, keeping bodies only when it accepts', async () => {
    await setMode('fail');
    expect((await post('/feedback', valid())).status).toBe(500);
    await setMode('ratelimit');
    const limited = await post('/feedback', valid());
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    expect((await state()).received).toEqual([]);
    await setMode('slow');
    const started = Date.now();
    expect((await post('/feedback', valid())).status).toBe(202);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect((await state()).received).toHaveLength(1);
  });

  it('refuses an unknown mode and keeps the old one', async () => {
    expect((await setMode('chaos')).status).toBe(400);
    expect((await state()).mode).toBe('accept');
  });

  it('forgets the bodies and goes back to accept on DELETE', async () => {
    await post('/feedback', valid());
    await setMode('fail');
    await fetch(`${base}/__feedback`, { method: 'DELETE' });
    expect(await state()).toEqual({ mode: 'accept', received: [] });
  });
});
