export interface BoardLock {
  release(): void;
}

// One host tab per board. A second tab can steal the lock; the first then learns it lost.
export function acquireBoardLock(boardId: string, opts: { steal?: boolean; onLost: () => void }): Promise<BoardLock | null> {
  if (!('locks' in navigator)) return Promise.resolve({ release() {} });
  return new Promise((resolve) => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    navigator.locks
      .request(`retrobrew-board:${boardId}`, opts.steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        resolve({ release });
        await held;
      })
      .catch(() => opts.onLost());
  });
}

// Whether some tab holds the host lock for this board right now.
export async function boardIsHosted(boardId: string): Promise<boolean> {
  if (!('locks' in navigator)) return false;
  try {
    const { held = [] } = await navigator.locks.query();
    return held.some((lock) => lock.name === `retrobrew-board:${boardId}`);
  } catch {
    return false;
  }
}

// A page restored from the back-forward cache fires both pageshow and visibilitychange: one resume is enough.
export const RESUME_DEBOUNCE_MS = 1000;

// Runs fn when the page comes back: it becomes visible (a phone unlocks, an app switch), or it is restored from the
// back-forward cache (pageshow with persisted; an ordinary load's pageshow is ignored). Not again within
// minGapMs (RESUME_DEBOUNCE_MS unless given) of the last run. Returns a function that stops listening.
export function onPageVisible(
  fn: () => void,
  deps: { doc?: EventTarget & { visibilityState: DocumentVisibilityState }; win?: EventTarget; now?: () => number; minGapMs?: number } = {},
): () => void {
  const doc = deps.doc ?? document;
  const win = deps.win ?? window;
  const now = deps.now ?? Date.now;
  const minGapMs = deps.minGapMs ?? RESUME_DEBOUNCE_MS;
  let lastRun = Number.NEGATIVE_INFINITY;
  const run = () => {
    if (now() - lastRun < minGapMs) return;
    lastRun = now();
    fn();
  };
  const onVisibility = () => { if (doc.visibilityState === 'visible') run(); };
  const onPageShow = (e: Event) => { if ((e as PageTransitionEvent).persisted) run(); };
  doc.addEventListener('visibilitychange', onVisibility);
  win.addEventListener('pageshow', onPageShow);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    win.removeEventListener('pageshow', onPageShow);
  };
}

export function warnBeforeLeaving(): () => void {
  const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', handler);
  return () => window.removeEventListener('beforeunload', handler);
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
