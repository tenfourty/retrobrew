import { describe, expect, it, vi } from 'vitest';
import { ScreenWakeLock } from './wake-lock';

const handle = () => ({ release: vi.fn(async () => undefined) });

describe('ScreenWakeLock', () => {
  it('requests the lock, asks again on renew, and releases it', async () => {
    const handles = [handle(), handle()];
    const request = vi.fn(async () => handles[request.mock.calls.length - 1]);
    const lock = new ScreenWakeLock(request);
    expect(await lock.acquire()).toBe(true);
    expect(lock.held).toBe(true);
    expect(await lock.renew()).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    lock.release();
    expect(lock.held).toBe(false);
    expect(handles[1].release).toHaveBeenCalledOnce();
  });

  it('does nothing on renew unless it was acquired, and nothing after release', async () => {
    const request = vi.fn(async () => handle());
    const lock = new ScreenWakeLock(request);
    expect(await lock.renew()).toBe(false);
    await lock.acquire();
    lock.release();
    expect(await lock.renew()).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it('resolves false where wake locks don’t exist or the browser refuses', async () => {
    expect(await new ScreenWakeLock(undefined).acquire()).toBe(false);
    const refusing = new ScreenWakeLock(async () => { throw new DOMException('Not allowed', 'NotAllowedError'); });
    expect(await refusing.acquire()).toBe(false);
    expect(refusing.held).toBe(false);
  });

  it('gives back the lock it held when a renew replaces it', async () => {
    const handles = [handle(), handle()];
    const request = vi.fn(async () => handles[request.mock.calls.length - 1]);
    const lock = new ScreenWakeLock(request);
    await lock.acquire();
    await lock.renew();
    expect(handles[0].release).toHaveBeenCalledOnce();
    expect(handles[1].release).not.toHaveBeenCalled();
  });

  it('stops counting a lock as held once the browser releases it, as it does when the page is hidden', async () => {
    const sentinel = Object.assign(new EventTarget(), { release: vi.fn(async () => undefined) });
    const lock = new ScreenWakeLock(async () => sentinel);
    await lock.acquire();
    expect(lock.held).toBe(true);
    sentinel.dispatchEvent(new Event('release'));
    expect(lock.held).toBe(false);
    // Still wanted, so a renew asks again.
    expect(await lock.renew()).toBe(true);
  });

  it('ignores the release of a lock it has already replaced', async () => {
    const sentinels = [0, 1].map(() => Object.assign(new EventTarget(), { release: vi.fn(async () => undefined) }));
    let n = 0;
    const lock = new ScreenWakeLock(async () => sentinels[n++]);
    await lock.acquire();
    await lock.renew();
    sentinels[0].dispatchEvent(new Event('release'));
    expect(lock.held).toBe(true);
  });

  it('gives back a lock that arrives after release', async () => {
    const late = handle();
    let resolve!: (h: typeof late) => void;
    const lock = new ScreenWakeLock(() => new Promise((r) => { resolve = r; }));
    const acquiring = lock.acquire();
    lock.release();
    resolve(late);
    expect(await acquiring).toBe(false);
    expect(late.release).toHaveBeenCalledOnce();
  });
});

describe('ScreenWakeLock.renew', () => {
  it('releases the previous handle when a new one replaces it', async () => {
    const handles = [handle(), handle()];
    const request = vi.fn(async () => handles[request.mock.calls.length - 1]);
    const lock = new ScreenWakeLock(request);
    await lock.acquire();
    await lock.renew();
    expect(handles[0].release).toHaveBeenCalledOnce();
    expect(handles[1].release).not.toHaveBeenCalled();
    lock.release();
    expect(handles[1].release).toHaveBeenCalledOnce();
  });
});
