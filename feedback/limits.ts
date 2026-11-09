// Rate limits, all in memory. Global first (so a flood from many addresses cannot grow the client map), then per client.
//
// A client is `HMAC(address, salt)` cut to 8 bytes: an IPv4 address whole, an IPv6 address cut to its /64. The salt is
// random, made at start, replaced every 24 hours and never written anywhere, so a key cannot be turned back into an
// address and a restart forgets everyone. A request refused by a limit is not counted, so hammering does not extend it.
import { createHmac, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export interface LimitOptions {
  globalPerHour: number;
  globalPerDay: number;
  clientPerHour: number;
  clientPerDay: number;
  maxClients: number;
  /** Requests one client may have open at once, counted before the body is read. */
  clientConcurrent: number;
}

export const LIMIT_DEFAULTS: LimitOptions = {
  globalPerHour: 300,
  globalPerDay: 1500,
  clientPerHour: 20,
  clientPerDay: 60,
  maxClients: 10_000,
  clientConcurrent: 4,
};

export type Verdict = { ok: true } | { ok: false; scope: 'global' | 'client'; retryAfterSeconds: number };

/** Expands an IPv6 text address to eight 16-bit groups, or null. IPv4-mapped addresses come back as the IPv4 text. */
function ipv6Groups(text: string): number[] | null {
  let head = text;
  let tail4: number[] = [];
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const o = dotted[2].split('.').map(Number);
    tail4 = [(o[0] << 8) | o[1], (o[2] << 8) | o[3]];
    head = dotted[1] + '0:0';
  }
  const halves = head.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...left, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...right];
  const groups = parts.map((p) => (/^[0-9a-fA-F]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  if (groups.length !== 8 || groups.some(Number.isNaN)) return null;
  if (tail4.length) groups.splice(6, 2, ...tail4);
  return groups;
}

/**
 * What identifies the client in a header value: the IPv4 address, or the /64 of an IPv6 address, or null when the value
 * is not an address (the caller then uses one shared bucket). A list is read from its last entry, the one the trusted
 * ingress added.
 */
export function clientAddress(header: string | undefined): string | null {
  if (!header) return null;
  const last = header.split(',').pop()!.trim();
  const family = isIP(last);
  if (family === 4) return last;
  if (family !== 6) return null;
  const groups = ipv6Groups(last);
  if (!groups) return null;
  const mapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (mapped) return `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
  return groups.slice(0, 4).map((g) => g.toString(16)).join(':') + '::/64';
}

export interface Limiter {
  /** Checks and, if allowed, counts one request. */
  admit(address: string | null): Verdict;
  /** Takes one of the client's open-request slots; null when it holds its share. The release function is safe to call twice. */
  begin(address: string | null): (() => void) | null;
  /** Test hook: the number of client keys held. */
  clientCount(): number;
  /** Test hook: the keys held (salted hashes, or `shared`). */
  clientKeys(): string[];
}

export function createLimiter(now: () => number, options: LimitOptions = LIMIT_DEFAULTS): Limiter {
  let salt = randomBytes(32);
  let saltFrom = now();
  const globalHits: number[] = [];
  // Insertion order is recency order: a touched key is re-inserted at the end.
  const clients = new Map<string, number[]>();

  function prune(hits: number[], t: number): void {
    let drop = 0;
    while (drop < hits.length && t - hits[drop] >= DAY) drop++;
    if (drop) hits.splice(0, drop);
  }

  // The age of the oldest hit inside `window` once `limit` hits are in it: when the next one frees a slot.
  function retryAfter(hits: number[], limit: number, window: number, t: number): number {
    const inWindow = hits.filter((h) => t - h < window);
    return Math.max(1, Math.ceil((inWindow[inWindow.length - limit] + window - t) / 1000));
  }

  function over(hits: number[], perHour: number, perDay: number, t: number): number | null {
    const hour = hits.filter((h) => t - h < HOUR).length;
    if (hour >= perHour) return retryAfter(hits, perHour, HOUR, t);
    if (hits.length >= perDay) return retryAfter(hits, perDay, DAY, t);
    return null;
  }

  const open = new Map<string, number>();

  function rotate(t: number): void {
    if (t - saltFrom >= DAY) {
      salt = randomBytes(32);
      saltFrom = t;
      clients.clear();
    }
  }

  const keyOf = (address: string | null): string =>
    address === null ? 'shared' : createHmac('sha256', salt).update(address).digest().subarray(0, 8).toString('hex');

  return {
    begin(address) {
      rotate(now());
      const key = keyOf(address);
      const count = open.get(key) ?? 0;
      if (count >= options.clientConcurrent) return null;
      open.set(key, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (open.get(key) ?? 1) - 1;
        if (left <= 0) open.delete(key);
        else open.set(key, left);
      };
    },
    admit(address) {
      const t = now();
      rotate(t);
      prune(globalHits, t);
      const globalWait = over(globalHits, options.globalPerHour, options.globalPerDay, t);
      if (globalWait !== null) return { ok: false, scope: 'global', retryAfterSeconds: globalWait };

      const key = keyOf(address);
      const hits = clients.get(key) ?? [];
      prune(hits, t);
      const clientWait = over(hits, options.clientPerHour, options.clientPerDay, t);
      if (clientWait !== null) return { ok: false, scope: 'client', retryAfterSeconds: clientWait };

      hits.push(t);
      globalHits.push(t);
      clients.delete(key);
      clients.set(key, hits);
      while (clients.size > options.maxClients) clients.delete(clients.keys().next().value!);
      return { ok: true };
    },
    clientCount: () => clients.size,
    clientKeys: () => [...clients.keys()],
  };
}
