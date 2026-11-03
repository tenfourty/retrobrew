import { describe, expect, it, vi } from 'vitest';
import { StartCancelled, Startup } from './startup';

describe('Startup', () => {
  it('passes values through while the view is still there', async () => {
    const startup = new Startup(new AbortController().signal);
    expect(await startup.step(Promise.resolve(42))).toBe(42);
    expect(await startup.step('now')).toBe('now');
  });

  it('closes everything opened so far, newest first, and stops when cancelled during a step', async () => {
    const controller = new AbortController();
    const startup = new Startup(controller.signal);
    const closed: string[] = [];
    startup.opened(() => closed.push('transport'));
    startup.opened(() => { closed.push('session'); throw new Error('already closed'); });
    let finish!: (value: string) => void;
    const pending = startup.step(new Promise<string>((resolve) => { finish = resolve; }));
    controller.abort();
    finish('too late');
    await expect(pending).rejects.toBeInstanceOf(StartCancelled);
    expect(closed).toEqual(['session', 'transport']);
  });

  it('closes each thing once', async () => {
    const controller = new AbortController();
    const startup = new Startup(controller.signal);
    const dispose = vi.fn();
    startup.opened(dispose);
    controller.abort();
    await expect(startup.step(1)).rejects.toBeInstanceOf(StartCancelled);
    await expect(startup.step(2)).rejects.toBeInstanceOf(StartCancelled);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('closes what a step produced if start-up was cancelled while it was being made', async () => {
    const controller = new AbortController();
    const startup = new Startup(controller.signal);
    const transport = { leave: vi.fn() };
    let finish!: (value: typeof transport) => void;
    const pending = startup.step(new Promise<typeof transport>((resolve) => { finish = resolve; }), (t) => t.leave());
    controller.abort();
    finish(transport);
    await expect(pending).rejects.toBeInstanceOf(StartCancelled);
    expect(transport.leave).toHaveBeenCalledOnce();
  });

  it('closes everything opened so far when a step fails, and passes the failure on', async () => {
    const startup = new Startup(new AbortController().signal);
    const closed: string[] = [];
    startup.opened(() => closed.push('first'));
    await startup.step(Promise.resolve('transport'), () => closed.push('transport'));
    const failure = new Error('corrupt key');
    await expect(startup.step(Promise.reject(failure))).rejects.toBe(failure);
    expect(closed).toEqual(['transport', 'first']);
  });

  it('reports a step that fails after the view went away as cancelled, with everything closed', async () => {
    const controller = new AbortController();
    const startup = new Startup(controller.signal);
    const dispose = vi.fn();
    startup.opened(dispose);
    let fail!: (error: Error) => void;
    const pending = startup.step(new Promise<never>((_, reject) => { fail = reject; }));
    controller.abort();
    fail(new Error('too late'));
    await expect(pending).rejects.toBeInstanceOf(StartCancelled);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
