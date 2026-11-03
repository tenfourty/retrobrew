// Session tests run on a fake clock, but WebCrypto and compression still take real time on worker threads. A fixed
// real-time sleep between fake-clock steps is a guess that a loaded machine loses: the clock runs ahead of a reply
// still being verified, or a test looks for "nothing arrived" before it could have. settle() waits for the work that
// is tracked here instead: every WebCrypto call and every (de)compression stream in flight in this test file's worker,
// plus the promise chains they feed. It does not track timers, network deliveries or other asynchronous work.

let inFlight = 0;
const pending = new Map<number, string>();
let nextId = 1;
let idle: Array<() => void> = [];

function started(label: string): () => void {
  inFlight += 1;
  const id = nextId++;
  pending.set(id, label);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pending.delete(id);
    inFlight -= 1;
    if (inFlight > 0) return;
    const waiting = idle;
    idle = [];
    for (const resolve of waiting) resolve();
  };
}

// RETROBREW_SLOW_CRYPTO=<ms> delays each WebCrypto result by a random real time up to that, as a loaded machine
// does, so a test that guesses how long work takes fails at once rather than one CI run in five.
const slowMs = Number(process.env.RETROBREW_SLOW_CRYPTO ?? 0);
const slow = <T>(result: Promise<T>): Promise<T> => slowMs > 0
  ? result.then((value) => new Promise<T>((resolve) => setTimeout(() => resolve(value), Math.random() * slowMs)))
  : result;

const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
for (const name of ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'importKey', 'exportKey', 'generateKey', 'deriveBits', 'deriveKey', 'wrapKey', 'unwrapKey']) {
  const original = subtle[name];
  if (typeof original !== 'function') continue;
  subtle[name] = function counted(this: unknown, ...args: unknown[]) {
    const done = started(`crypto.subtle.${name}`);
    try {
      return slow(original.apply(this, args)).finally(done);
    } catch (err) {
      done();
      throw err;
    }
  };
}

// The stream counts from construction until its output has closed, failed or been cancelled.
function counting<T extends typeof CompressionStream | typeof DecompressionStream>(Base: T, label: string): T {
  return class extends (Base as typeof CompressionStream) {
    private readonly out: ReadableStream<Uint8Array<ArrayBuffer>>;

    constructor(format: CompressionFormat) {
      super(format);
      const done = started(label);
      const pipe = new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>();
      super.readable.pipeTo(pipe.writable).then(done, done);
      this.out = pipe.readable;
    }

    override get readable(): ReadableStream<Uint8Array<ArrayBuffer>> {
      return this.out;
    }
  } as unknown as T;
}

globalThis.CompressionStream = counting(CompressionStream, 'CompressionStream');
globalThis.DecompressionStream = counting(DecompressionStream, 'DecompressionStream');

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

// settle()'s timeout only names what is still in flight when something hangs; it is not a pass criterion. Tests that
// check hundreds of signatures or mint dozens of signers (CPU-bound, and slower on a loaded CI machine) wait this long.
export const HEAVY_SETTLE_MS = 25_000;

export function inFlightWork(): number {
  return inFlight;
}

// Resolves when no tracked crypto or compression is in flight and the promise chains they fed have run to their next
// wait. A chain that starts new work keeps settle() waiting for that too. If something is still pending after
// timeoutMs of real time, it throws naming what, rather than hanging until the test's own timeout.
export async function settle(timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await turn(); // every microtask queued so far has run
    if (inFlight === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - Date.now())); });
    const outcome = await Promise.race([new Promise<'idle'>((resolve) => idle.push(() => resolve('idle'))), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      const names = [...pending.values()];
      throw new Error(`settle() gave up after ${timeoutMs} ms with ${names.length} still in flight: ${names.join(', ')}`);
    }
  }
}
