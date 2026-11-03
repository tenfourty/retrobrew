import { toB64url } from '../crypto/bytes';

// A tab ID, new on every page load: its creation time in base 36, a dot, then 9 random bytes in base64url.
// The host's pruning watermark compares the creation time (docs/product/sync-protocol.md, Pruning).
const SID = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{12})$/;

export function newSid(now: number): string {
  return `${now.toString(36)}.${toB64url(crypto.getRandomValues(new Uint8Array(9)))}`;
}

export function sidCreatedAt(sid: string): number | null {
  const match = SID.exec(sid);
  return match ? parseInt(match[1], 36) : null;
}

export const isSid = (x: unknown): x is string => typeof x === 'string' && sidCreatedAt(x) !== null;
