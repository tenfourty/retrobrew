// Keeps the facilitator's screen on while they host, where the browser allows it, and asks again when the page
// becomes visible, because the browser releases the lock whenever the page is hidden
// (docs/product/mvp-screens.md, Keeping the facilitator's phone awake).
export interface WakeLockHandle {
  release(): Promise<void>;
  // The browser's sentinel fires 'release' when it lets the lock go (the page was hidden, say).
  addEventListener?(type: 'release', listener: () => void): void;
}

export type RequestWakeLock = () => Promise<WakeLockHandle>;

function browserRequest(): RequestWakeLock | undefined {
  const wakeLock = typeof navigator === 'undefined' ? undefined : navigator.wakeLock;
  return wakeLock ? () => wakeLock.request('screen') : undefined;
}

export class ScreenWakeLock {
  private handle: WakeLockHandle | null = null;
  private wanted = false;

  constructor(private readonly request: RequestWakeLock | undefined = browserRequest()) {}

  get held(): boolean {
    return this.handle !== null;
  }

  // Start keeping the screen on. Resolves false where wake locks don't exist or the browser refuses.
  acquire(): Promise<boolean> {
    this.wanted = true;
    return this.renew();
  }

  // Ask again, after the page becomes visible. Does nothing unless acquire() was called and release() wasn't.
  async renew(): Promise<boolean> {
    if (!this.wanted || !this.request) return false;
    try {
      const handle = await this.request();
      if (!this.wanted) {
        await handle.release();
        return false;
      }
      // A visibilitychange and a pageshow can both renew: give back the lock this one replaces.
      const old = this.handle;
      this.handle = handle;
      // So held says whether the screen is really being kept on: the browser drops the lock whenever the page is hidden.
      handle.addEventListener?.('release', () => { if (this.handle === handle) this.handle = null; });
      if (old && old !== handle) void old.release().catch(() => undefined);
      return true;
    } catch {
      this.handle = null;
      return false;
    }
  }

  release(): void {
    this.wanted = false;
    const handle = this.handle;
    this.handle = null;
    void handle?.release().catch(() => undefined);
  }
}
