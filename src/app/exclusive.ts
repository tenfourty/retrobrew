// One task at a time: a call made while another is still running is ignored (resolves undefined). The Start and Import
// controls share one, so a second tap during the browser's storage prompt can't make a second meeting.
export function exclusive(): <T>(task: () => Promise<T>) => Promise<T | undefined> {
  let running = false;
  return async (task) => {
    if (running) return undefined;
    running = true;
    try {
      return await task();
    } finally {
      running = false;
    }
  };
}
