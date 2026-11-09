import type { IncomingMessage, ServerResponse } from 'node:http';

export const MODES: readonly ['accept', 'fail', 'slow', 'ratelimit'];

export function createFeedbackStub(options?: { slowMs?: number }): {
  handle: (req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>;
  state: { mode: string; received: string[] };
};
