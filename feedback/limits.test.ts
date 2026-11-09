import { describe, expect, it } from 'vitest';
import { clientAddress, createLimiter, LIMIT_DEFAULTS } from './limits.ts';

const HOUR = 3600_000;

describe('clientAddress', () => {
  it('uses an IPv4 address whole', () => {
    expect(clientAddress('203.0.113.7')).toBe('203.0.113.7');
  });
  it('cuts an IPv6 address to its /64', () => {
    const a = clientAddress('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
    expect(a).toBe(clientAddress('2001:db8:1:2::1'));
    expect(a).not.toBe(clientAddress('2001:db8:1:3::1'));
  });
  it('reads :: and mixed forms', () => {
    expect(clientAddress('::1')).toBe('0:0:0:0::/64');
    expect(clientAddress('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(clientAddress('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
  it('takes the last entry of a list, the one the trusted ingress added', () => {
    expect(clientAddress('198.51.100.1, 203.0.113.7')).toBe('203.0.113.7');
  });
  it.each([undefined, '', 'unknown', 'not an ip', '1.2.3', '2001:db8::1::2', '203.0.113.7:80'])('gives null for %j', (value) => {
    expect(clientAddress(value)).toBeNull();
  });
});

describe('limiter', () => {
  it('limits a client to 20 an hour, then lets it back as the hour passes', () => {
    const clock = { t: 1_000_000 };
    const limiter = createLimiter(() => clock.t);
    for (let i = 0; i < 20; i++) expect(limiter.admit('1.1.1.1').ok).toBe(true);
    const refused = limiter.admit('1.1.1.1');
    expect(refused).toMatchObject({ ok: false, scope: 'client' });
    expect(limiter.admit('2.2.2.2').ok).toBe(true);
    clock.t += HOUR;
    expect(limiter.admit('1.1.1.1').ok).toBe(true);
  });

  it('limits a client to 60 a day', () => {
    const clock = { t: 0 };
    const limiter = createLimiter(() => clock.t);
    for (let i = 0; i < 60; i++) {
      clock.t += 21 * 60_000; // never more than 3 in an hour
      expect(limiter.admit('1.1.1.1').ok).toBe(true);
    }
    // 60 hits over 21 hours: the hour window is clear, the day window is full
    expect(limiter.admit('1.1.1.1')).toMatchObject({ ok: false, scope: 'client' });
  });

  it('does not count refused requests, so hammering does not extend the wait', () => {
    const clock = { t: 0 };
    const limiter = createLimiter(() => clock.t);
    for (let i = 0; i < 20; i++) limiter.admit('1.1.1.1');
    for (let i = 0; i < 100; i++) limiter.admit('1.1.1.1');
    clock.t += HOUR;
    expect(limiter.admit('1.1.1.1').ok).toBe(true);
  });

  it('checks the global limit first: 503 scope global, and the client map is not touched', () => {
    const clock = { t: 0 };
    const limiter = createLimiter(() => clock.t, { ...LIMIT_DEFAULTS, globalPerHour: 5 });
    for (let i = 0; i < 5; i++) expect(limiter.admit(`10.0.0.${i}`).ok).toBe(true);
    expect(limiter.clientCount()).toBe(5);
    for (let i = 0; i < 50; i++) expect(limiter.admit(`10.0.1.${i}`)).toMatchObject({ ok: false, scope: 'global' });
    expect(limiter.clientCount()).toBe(5);
  });

  it('limits everyone to 1,500 a day', () => {
    const clock = { t: 0 };
    const limiter = createLimiter(() => clock.t);
    let admitted = 0;
    for (let i = 0; i < 1600; i++) {
      clock.t += 50_000; // 72 an hour, so the hourly cap never bites
      if (limiter.admit(`10.${i >> 8}.${i & 255}.1`).ok) admitted++;
    }
    expect(admitted).toBeLessThanOrEqual(1500);
    expect(limiter.admit('9.9.9.9')).toMatchObject({ ok: false, scope: 'global' });
  });

  it('puts every request without a usable address in one shared bucket', () => {
    const limiter = createLimiter(() => 0);
    for (let i = 0; i < 20; i++) expect(limiter.admit(null).ok).toBe(true);
    expect(limiter.admit(null)).toMatchObject({ ok: false, scope: 'client' });
  });

  it('keys an IPv6 /64 as one client', () => {
    const limiter = createLimiter(() => 0);
    for (let i = 0; i < 20; i++) expect(limiter.admit(clientAddress(`2001:db8:0:1::${i + 1}`)).ok).toBe(true);
    expect(limiter.admit(clientAddress('2001:db8:0:1:ffff::9'))).toMatchObject({ ok: false, scope: 'client' });
  });

  it('holds at most 10,000 client keys, evicting the least recently seen', () => {
    const limiter = createLimiter(() => 0, { ...LIMIT_DEFAULTS, globalPerHour: 1e9, globalPerDay: 1e9, maxClients: 100 });
    for (let i = 0; i < 100; i++) limiter.admit(`10.0.0.${i}`);
    limiter.admit('10.0.0.0'); // touch the oldest: it is now the newest
    limiter.admit('10.9.9.9');
    expect(limiter.clientCount()).toBe(100);
    // 10.0.0.0 survived with its 2 hits; 10.0.0.1 was evicted and starts again
    for (let i = 0; i < 18; i++) expect(limiter.admit('10.0.0.0').ok).toBe(true);
    expect(limiter.admit('10.0.0.0').ok).toBe(false);
    for (let i = 0; i < 20; i++) expect(limiter.admit('10.0.0.1').ok).toBe(true);
  });

  it('forgets everyone when the salt rotates after 24 hours', () => {
    const clock = { t: 0 };
    const limiter = createLimiter(() => clock.t);
    for (let i = 0; i < 20; i++) limiter.admit('1.1.1.1');
    expect(limiter.admit('1.1.1.1').ok).toBe(false);
    clock.t += 24 * HOUR;
    expect(limiter.admit('1.1.1.1').ok).toBe(true);
    expect(limiter.clientCount()).toBe(1);
  });

  it('reports a Retry-After no shorter than a second', () => {
    const limiter = createLimiter(() => 0);
    for (let i = 0; i < 20; i++) limiter.admit('1.1.1.1');
    const refused = limiter.admit('1.1.1.1');
    expect(refused).toMatchObject({ ok: false, retryAfterSeconds: 3600 });
  });
});

describe('what the limiter holds', () => {
  it('keeps only salted keys, never an address', () => {
    const limiter = createLimiter(() => 0);
    limiter.admit('203.0.113.99');
    limiter.admit('2001:db8:1:2::/64');
    limiter.admit(null);
    const keys = limiter.clientKeys();
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(key).toMatch(/^(?:[0-9a-f]{16}|shared)$/);
  });
});

describe('concurrent requests per client', () => {
  it('allows a few at once per client, and frees a slot on release', () => {
    const limiter = createLimiter(() => 0);
    const releases = [1, 2, 3, 4].map(() => limiter.begin('203.0.113.1'));
    expect(releases.every((r) => r !== null)).toBe(true);
    expect(limiter.begin('203.0.113.1')).toBeNull();
    expect(limiter.begin('203.0.113.2')).not.toBeNull();
    releases[0]!();
    releases[0]!();
    expect(limiter.begin('203.0.113.1')).not.toBeNull();
    expect(limiter.begin('203.0.113.1')).toBeNull();
  });
});
