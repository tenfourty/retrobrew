import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLiveVersion, sendFeedback, SEND_TIMEOUT_MS } from './send';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const reply = (status: number) => vi.fn(async () => new Response('{}', { status }));

describe('sendFeedback', () => {
  it('posts the exact string it is given, with no credentials, referrer or cache, and no redirect', async () => {
    const fetchMock = reply(202);
    const result = await sendFeedback('{"v":1}', { fetch: fetchMock });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/feedback');
    expect(init).toMatchObject({
      method: 'POST', body: '{"v":1}', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error',
      headers: { 'content-type': 'application/json' },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps statuses to the sheet\'s failure lines', async () => {
    const outcome = async (status: number) => sendFeedback('{}', { fetch: reply(status) });
    expect(await outcome(200)).toEqual({ ok: true });
    expect(await outcome(202)).toEqual({ ok: true });
    expect(await outcome(429)).toEqual({ ok: false, reason: 'rate' });
    expect(await outcome(413)).toEqual({ ok: false, reason: 'rejected' });
    expect(await outcome(400)).toEqual({ ok: false, reason: 'rejected' });
    for (const status of [403, 404, 405, 500, 503]) expect(await outcome(status)).toEqual({ ok: false, reason: 'failed' });
  });

  it('treats a network error or a refused redirect as a failure', async () => {
    const failing = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    expect(await sendFeedback('{}', { fetch: failing })).toEqual({ ok: false, reason: 'failed' });
  });

  it('gives up after 15 seconds', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = sendFeedback('{}', { fetch: hanging });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, reason: 'timeout' });
    expect(SEND_TIMEOUT_MS).toBe(15_000);
  });

  it('leaves no timer behind', async () => {
    await sendFeedback('{}', { fetch: reply(202) });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fetchLiveVersion', () => {
  const text = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));

  it('reads the first seven digits of version.txt, uncached', async () => {
    const fetchMock = text('0123456789abcdef0123456789abcdef01234567\n');
    expect(await fetchLiveVersion({ fetch: fetchMock })).toBe('0123456');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/version.txt');
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  });

  it('says "dev" or "unknown" as written, and null for anything else', async () => {
    expect(await fetchLiveVersion({ fetch: text('unknown\n') })).toBe('unknown');
    expect(await fetchLiveVersion({ fetch: text('dev\n') })).toBe('dev');
    expect(await fetchLiveVersion({ fetch: text('<html>not found</html>') })).toBeNull();
    expect(await fetchLiveVersion({ fetch: text('0123456', 404) })).toBeNull();
    expect(await fetchLiveVersion({ fetch: vi.fn(async () => { throw new TypeError('offline'); }) })).toBeNull();
  });

  it('gives up after 3 seconds', async () => {
    const hanging = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const pending = fetchLiveVersion({ fetch: hanging });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toBeNull();
  });
});
