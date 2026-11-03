import { newSid } from '../protocol/sid';

// The freshness fields of a protocol 2 hello (docs/product/sync-protocol.md): a tab of its own, its first count and
// the sender's estimate of the host's clock. For hand-built hellos in tests; `at` defaults to the real clock.
export function fresh(over: { sid?: string; n?: number; at?: number } = {}): { sid: string; n: number; at: number } {
  const at = over.at ?? Date.now();
  return { sid: over.sid ?? newSid(at), n: over.n ?? 1, at };
}
