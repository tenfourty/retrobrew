// The feedback endpoint as two request handlers:
// the public one (`POST /feedback`, `GET /healthz`) and the internal pull route the reader calls on the private
// network. No framework, no database, no outbound request. Every outcome is logged as a code, never as text.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { validateBody, LIMITS } from '../src/feedback/schema.ts';
import type { Config } from './config.ts';
import { clientAddress, type Limiter } from './limits.ts';
import { latencyBucket, sizeBucket, type Logger, type Outcome } from './log.ts';
import type { Sealer } from './seal.ts';
import type { Store } from './store.ts';
import { ULID } from './ulid.ts';

export interface Deps {
  config: Config;
  store: Store;
  sealer: Sealer;
  limiter: Limiter;
  now: () => number;
  log: Logger;
}

export interface Service {
  publicHandler(req: IncomingMessage, res: ServerResponse): void;
  internalHandler(req: IncomingMessage, res: ServerResponse): void;
  /** One retention pass: deletes records older than the retention and logs the count. */
  sweep(): Promise<void>;
}

const DAY = 24 * 3600_000;
const MAX_DEDUP = 10_000;
const JSON_TYPE = /^application\/json\s*(?:;|$)/i;

type Headers = Record<string, string | number>;

/** Reads at most `max` bytes. Resolves 'too_large' past it, 'timeout' when the body is too slow, 'aborted' if the client leaves. */
function readBody(req: IncomingMessage, max: number, timeoutMs: number): Promise<Buffer | 'too_large' | 'timeout' | 'aborted'> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: Buffer | 'too_large' | 'timeout' | 'aborted'): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) finish('too_large');
      else chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish('aborted'));
    req.on('close', () => finish('aborted'));
  });
}

export function createService(deps: Deps): Service {
  const { config, store, sealer, limiter, now, log } = deps;
  let inflight = 0;
  // Exact-duplicate drop: hash -> time seen. Insertion order is age order.
  const seen = new Map<string, number>();

  function send(res: ServerResponse, status: number, body: unknown, extra: Headers = {}): void {
    if (res.headersSent) return;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': typeof body === 'string' && extra['content-type'] ? String(extra['content-type']) : 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    });
    res.end(text);
  }

  function isDuplicate(key: string, t: number): boolean {
    for (const [hash, at] of seen) {
      if (t - at < DAY) break;
      seen.delete(hash);
    }
    return seen.has(key);
  }

  function remember(key: string, t: number): void {
    seen.set(key, t);
    while (seen.size > MAX_DEDUP) seen.delete(seen.keys().next().value!);
  }

  async function handleFeedback(req: IncomingMessage, res: ServerResponse): Promise<{ outcome: Outcome; size: number }> {
    const done = (status: number, outcome: Outcome, body: unknown, size = 0, extra: Headers = {}): { outcome: Outcome; size: number } => {
      send(res, status, body, extra);
      return { outcome, size };
    };
    if (req.method !== 'POST') return done(405, 'method', { error: 'method' }, 0, { allow: 'POST' });
    if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return done(415, 'unsupported', { error: 'type' });

    // Not a security boundary (a script can forge both headers): it stops other sites' pages posting through visitors' browsers.
    const site = req.headers['sec-fetch-site'];
    const origin = req.headers.origin;
    if ((site !== undefined && site !== 'same-origin' && site !== 'none') || (origin !== undefined && origin !== config.allowedOrigin)) {
      return done(403, 'forbidden', { error: 'forbidden' });
    }

    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > LIMITS.bodyBytes) {
      return done(413, 'too_large', { error: 'too_large' }, Number(declared) || 0, { connection: 'close' });
    }
    // The limits and the client's open-request cap come before the body is read, so a slow or abandoned body is charged
    // to its address like any other request.
    const address = clientAddress(req.headers[config.clientIpHeader] as string | undefined);
    if (address === null) log({ outcome: 'unattributed' });
    const release = limiter.begin(address);
    if (release === null) return done(429, 'limited_client', { error: 'rate' }, 0, { 'retry-after': 5, connection: 'close' });
    try {
      const verdict = limiter.admit(address);
      if (!verdict.ok) {
        const retry = { 'retry-after': verdict.retryAfterSeconds, connection: 'close' };
        return verdict.scope === 'global' ? done(503, 'limited_global', { error: 'busy' }, 0, retry) : done(429, 'limited_client', { error: 'rate' }, 0, retry);
      }
      const raw = await readBody(req, LIMITS.bodyBytes, config.bodyTimeoutMs);
      if (raw === 'aborted') return { outcome: 'timeout', size: 0 };
      if (raw === 'timeout') return done(408, 'timeout', { error: 'timeout' }, 0, { connection: 'close' });
      if (raw === 'too_large') return done(413, 'too_large', { error: 'too_large' }, LIMITS.bodyBytes + 1, { connection: 'close' });
      return await process(raw, done);
    } finally {
      release();
    }
  }

  async function process(raw: Buffer, done: (status: number, outcome: Outcome, body: unknown, size?: number, extra?: Headers) => { outcome: Outcome; size: number }): Promise<{ outcome: Outcome; size: number }> {
    const t = now();
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    } catch {
      return done(400, 'invalid', { error: 'invalid' }, raw.length);
    }
    const checked = validateBody(parsed);
    if (!checked.ok) {
      return done(400, checked.reason === 'link' ? 'link' : 'invalid', { error: 'invalid' }, raw.length);
    }

    const { body } = checked;
    // The contact is left out of the hash: the same words with another address are still the same report.
    const key = createHash('sha256').update(JSON.stringify([body.kind, body.message, body.report])).digest('hex');
    if (isDuplicate(key, t)) return done(202, 'duplicate', { ok: true }, raw.length);

    // Marked before the awaits, so a second identical request arriving meanwhile is a duplicate; unmarked if storing fails.
    remember(key, t);
    let evicted: number;
    try {
      const sealed = await sealer.seal(new TextEncoder().encode(JSON.stringify(body)));
      ({ evicted } = await store.put(sealed));
    } catch (error) {
      seen.delete(key);
      throw error;
    }
    if (evicted > 0) log({ outcome: 'evicted', n: evicted });
    return done(202, 'accepted', { ok: true }, raw.length);
  }

  async function publicHandlerAsync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    if (inflight >= config.maxConcurrent) {
      send(res, 503, { error: 'busy' }, { 'retry-after': 5, connection: 'close' });
      log({ outcome: 'busy' });
      return;
    }
    inflight++;
    let result: { outcome: Outcome; size: number };
    try {
      if (path !== '/feedback') {
        send(res, 404, { error: 'notfound' });
        result = { outcome: 'notfound', size: 0 };
      } else {
        result = await handleFeedback(req, res);
      }
    } catch {
      // The error's text is dropped on purpose: a parser's message can quote the input.
      send(res, 500, { error: 'server' });
      result = { outcome: 'error', size: 0 };
    } finally {
      inflight--;
    }
    log({ outcome: result.outcome, size: sizeBucket(result.size), latency: latencyBucket(now() - started) });
    if (result.outcome === 'too_large') res.once('finish', () => req.destroy());
  }

  function authorised(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header);
    if (!match) return false;
    const hash = createHash('sha256').update(match[1]).digest();
    return timingSafeEqual(hash, config.pullTokenHash);
  }

  async function internalHandlerAsync(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      send(res, 200, 'ok', { 'content-type': 'text/plain; charset=utf-8' });
      return;
    }
    try {
      if (!authorised(req)) {
        send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
        log({ outcome: 'unauthorized' });
        return;
      }
      if (path === '/internal/records') {
        if (req.method !== 'GET') return send(res, 405, { error: 'method' }, { allow: 'GET' });
        const records = store.list();
        send(res, 200, { records });
        log({ outcome: 'pulled', n: records.length });
        return;
      }
      const id = /^\/internal\/records\/([^/]+)$/.exec(path)?.[1];
      if (id === undefined || !ULID.test(id)) {
        send(res, 404, { error: 'notfound' });
        return;
      }
      if (req.method === 'GET') {
        const sealed = await store.read(id);
        if (sealed === null) return send(res, 404, { error: 'notfound' });
        send(res, 200, sealed);
        log({ outcome: 'pulled', n: 1 });
      } else if (req.method === 'DELETE') {
        // A record already gone answers as done.
        await store.remove(id);
        send(res, 200, { ok: true });
        log({ outcome: 'confirmed', n: 1 });
      } else {
        send(res, 405, { error: 'method' }, { allow: 'GET, DELETE' });
      }
    } catch {
      send(res, 500, { error: 'server' });
      log({ outcome: 'error' });
    }
  }

  return {
    publicHandler: (req, res) => void publicHandlerAsync(req, res),
    internalHandler: (req, res) => void internalHandlerAsync(req, res),
    async sweep() {
      const n = await store.sweep();
      if (n > 0) log({ outcome: 'swept', n });
    },
  };
}
