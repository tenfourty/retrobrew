// Start-up is asynchronous (keys, storage, transports), and the view that started it can go away part way through.
// Every await goes through `step`: if the view has gone by the time it resolves, everything opened so far is closed
// and start-up stops with StartCancelled, so a late session never leaks or runs in the background. A step that fails
// closes everything opened so far as well.
export class StartCancelled extends Error {
  constructor() {
    super('Start-up was cancelled');
    this.name = 'StartCancelled';
  }
}

export class Startup {
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly signal: AbortSignal) {}

  // Something to close if start-up is cancelled from here on.
  opened(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  // Awaits one piece of start-up. `close`, if given, closes what it produced: straight away if start-up was
  // cancelled while it was being made, and otherwise later, if start-up is cancelled or fails after this.
  // A step that fails closes everything opened so far too, so trying again never piles up open connections; it
  // passes its error on, or StartCancelled if the view has gone anyway.
  async step<T>(work: Promise<T> | T, close?: (value: T) => void): Promise<T> {
    let value: T;
    try {
      value = await work;
    } catch (error) {
      this.closeAll();
      if (this.signal.aborted) throw new StartCancelled();
      throw error;
    }
    if (close) this.opened(() => close(value));
    if (this.signal.aborted) {
      this.closeAll();
      throw new StartCancelled();
    }
    return value;
  }

  private closeAll(): void {
    for (const dispose of this.disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // Closing is best effort; carry on closing the rest.
      }
    }
  }
}
