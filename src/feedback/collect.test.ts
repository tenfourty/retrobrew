import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mulberry32 } from '../test/mulberry32';
import { buildReport } from './collect';
import { clearCanary, noteError, recentErrors, registerCanary, resetErrors } from './errors';
import {
  buildVersion, cap, int, language, personText, pixelRatio, relayHost, stackFrame, tens, type ErrorInput, type ReportInputs,
} from './inputs';
import {
  CONNECTIONS, ERROR_NAMES, ERROR_SOURCES, KINDS, PAGES, PHASES, ROLES, SCHEMES, THEMES, TROUBLE_SOURCES, validateBody,
  type FeedbackBody,
} from './schema';

const ORIGIN = 'https://retrobrew.app';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  resetErrors();
  clearCanary();
});

const baseInputs = (): ReportInputs => ({
  kind: 'broke',
  message: personText('The timer froze when I pressed Start.'),
  email: null,
  page: 'host',
  role: 'facilitator',
  phase: 'discussing',
  theme: 'party',
  scheme: 'dark',
  buildVersion: buildVersion('0123abc'),
  liveVersion: buildVersion('0123abc'),
  userAgent: cap('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile', 200),
  language: language('en-GB'),
  viewport: { w: tens(362), h: tens(781) },
  pixelRatio: pixelRatio(2.75),
  online: true,
  capabilities: { webrtc: true, wakeLock: true, storagePersisted: null },
  connection: 'connected',
  relays: [{ host: relayHost('wss://relay.primal.net'), connected: true, refused: int(1, 0, 9999), dropped: int(0, 0, 9999), held: int(0, 0, 9999), givenUp: false }],
  directPeers: int(2, 0, 999),
  people: int(4, 0, 999),
  trouble: null,
  uptimeSeconds: int(125, 0, 604_800),
  errors: [],
});

// Every key path in a body with its type: the shape the privacy copy has to describe.
function shapeOf(value: unknown, path = ''): string[] {
  if (value === null) return [`${path}: null`];
  if (Array.isArray(value)) return value.length ? value.flatMap((item) => shapeOf(item, `${path}[]`)) : [`${path}: array`];
  if (typeof value === 'object') return Object.entries(value).flatMap(([key, child]) => shapeOf(child, path ? `${path}.${key}` : key));
  return [`${path}: ${typeof value}`];
}

describe('buildReport', () => {
  it('makes a valid body whose json is what the request carries', () => {
    const built = buildReport(baseInputs());
    if (!built.ok) throw new Error(built.reason);
    expect(built.reportFailed).toBe(false);
    expect(JSON.parse(built.json)).toEqual(built.body);
    expect(validateBody(built.body).ok).toBe(true);
    expect(built.body).toMatchObject({ v: 1, kind: 'broke', contact: null });
    expect(built.body.report).toMatchObject({ viewport: { w: 360, h: 780 }, pixelRatio: 3, buildVersion: '0123abc' });
  });

  it('shows the same body to the person as it sends: the rows come from the parsed json', () => {
    const built = buildReport(baseInputs());
    if (!built.ok) throw new Error();
    expect(built.json).toBe(JSON.stringify(built.body));
  });

  it('puts the optional email beside the report, in its canonical form, and nowhere in it', () => {
    const built = buildReport({ ...baseInputs(), email: personText('  Ann@Example.COM ') });
    if (!built.ok) throw new Error(built.reason);
    expect(built.body.contact).toEqual({ email: 'Ann@example.com' });
    expect(JSON.stringify(built.body.report)).not.toContain('example.com');
  });

  it('refuses a bad email, an empty message and a message that carries a meeting link', () => {
    expect(buildReport({ ...baseInputs(), email: personText('not an email') })).toEqual({ ok: false, reason: 'email' });
    expect(buildReport({ ...baseInputs(), message: personText('   ') })).toEqual({ ok: false, reason: 'empty' });
    expect(buildReport({ ...baseInputs(), message: personText('join https://retrobrew.app/app/#b=AbCdEfGh12345678&k=abc') })).toEqual({ ok: false, reason: 'link' });
  });

  it('refuses a message whose link the 2,000-unit cut would split', () => {
    const message = personText(`${'x'.repeat(1980)} b=AbCdEfGh12345678`);
    expect(buildReport({ ...baseInputs(), message })).toEqual({ ok: false, reason: 'link' });
  });

  it('cleans the message the way the sheet does: NFC, controls dropped, 2,000 at most', () => {
    const built = buildReport({ ...baseInputs(), message: personText(`é\u0000${'x'.repeat(3000)}`) });
    if (!built.ok) throw new Error();
    expect(built.body.message.startsWith('éx')).toBe(true);
    expect(built.body.message).toHaveLength(2000);
  });

  it('sends the message alone, with report null, when the report cannot be prepared', () => {
    const errors: ErrorInput[] = [{ source: 'error', name: 'Error', message: 'see #b=abc' as ErrorInput['message'], stack: [], agoSeconds: int(1, 0, 604_800) }];
    const built = buildReport({ ...baseInputs(), errors });
    if (!built.ok) throw new Error(built.reason);
    expect(built.reportFailed).toBe(true);
    expect(built.body.report).toBeNull();
    expect(built.body.message).toBe('The timer froze when I pressed Start.');
  });

  it('keeps at most four relays, three errors and six frames, even if handed more', () => {
    const relay = baseInputs().relays[0];
    const frame = stackFrame('index', 1, 1)!;
    const error: ErrorInput = { source: 'error', name: 'Error', message: cap('x', 120), stack: Array.from({ length: 9 }, () => frame), agoSeconds: int(1, 0, 604_800) };
    const built = buildReport({ ...baseInputs(), relays: Array.from({ length: 7 }, () => relay), errors: Array.from({ length: 5 }, () => error) });
    if (!built.ok) throw new Error(built.reason);
    expect(built.body.report?.relays).toHaveLength(4);
    expect(built.body.report?.errors).toHaveLength(3);
    expect(built.body.report?.errors[0].stack).toHaveLength(6);
  });
});

describe('the shape of the body (change it only with the privacy copy)', () => {
  it('lists every key path and type', () => {
    const errors: ErrorInput[] = [{ source: 'error', name: 'TypeError', message: cap('x', 120), stack: [stackFrame('index', 1, 2)!], agoSeconds: int(3, 0, 604_800) }];
    const built = buildReport({
      ...baseInputs(),
      email: personText('ann@example.com'),
      trouble: { source: 'save', forSeconds: int(5, 0, 86_400) },
      errors,
    });
    if (!built.ok) throw new Error(built.reason);
    expect(shapeOf(built.body)).toEqual([
      'v: number',
      'kind: string',
      'message: string',
      'report.page: string',
      'report.role: string',
      'report.phase: string',
      'report.theme: string',
      'report.scheme: string',
      'report.buildVersion: string',
      'report.liveVersion: string',
      'report.userAgent: string',
      'report.language: string',
      'report.viewport.w: number',
      'report.viewport.h: number',
      'report.pixelRatio: number',
      'report.online: boolean',
      'report.capabilities.webrtc: boolean',
      'report.capabilities.wakeLock: boolean',
      'report.capabilities.storagePersisted: null',
      'report.connection: string',
      'report.relays[].host: string',
      'report.relays[].connected: boolean',
      'report.relays[].refused: number',
      'report.relays[].dropped: number',
      'report.relays[].held: number',
      'report.relays[].givenUp: boolean',
      'report.directPeers: number',
      'report.people: number',
      'report.trouble.source: string',
      'report.trouble.forSeconds: number',
      'report.uptimeSeconds: number',
      'report.errors[].source: string',
      'report.errors[].name: string',
      'report.errors[].message: string',
      'report.errors[].stack[]: string',
      'report.errors[].agoSeconds: number',
      'contact.email: string',
    ]);
  });
});

// ---- The sentinel test ----------------------------------------------------------------------------------

describe('what must never be in a report', () => {
  const SENTINELS = ['SENTINEL-topic', 'SENTINEL-name', 'SENTINEL-board', 'SENTINEL-meeting', 'SENTINEL-key9Zq'];
  const EMAIL = 'SENTINEL-email@example.invalid';

  // Places a sentinel could ride in on: an error's message, name, cause, stack, and a rejection's reason.
  function hostileError(random: () => number): unknown {
    const pick = () => SENTINELS[Math.floor(random() * SENTINELS.length)];
    const shapes: Array<() => unknown> = [
      () => new Error(`Cannot read ${pick()} of undefined`),
      () => new TypeError(`${pick()} is not a function`),
      () => new SyntaxError(`Unexpected token '${pick()}', "${pick()} tail" is not valid JSON`),
      () => { const e = new Error('plain'); e.name = pick(); return e; },
      () => new Error('with cause', { cause: new Error(pick()) }),
      () => { const e = new Error('stack'); e.stack = `Error: stack\n    at ${pick()} (${ORIGIN}/assets/${pick()}.js:1:1)\n    at f (${ORIGIN}/assets/index-ab12cd34.js:5:6)`; return e; },
      () => { const e = new Error(`line one\n${pick()} on line two`); return e; },
      () => `${pick()} as a string reason`,
      () => ({ message: pick(), name: pick(), stack: pick() }),
      () => new Error(`mail ${EMAIL} and #b=${pick()}${pick()}`),
      () => new Error(`${pick().toLowerCase()} in lower case`),
    ];
    return shapes[Math.floor(random() * shapes.length)]();
  }

  it('holds none of the app\'s strings, whatever the view, role and trouble source, and wherever a sentinel sits', () => {
    const random = mulberry32(20261108);
    registerCanary([...SENTINELS, '#b=SENTINEL-board&k=SENTINEL-key9Zq', EMAIL]);
    let cases = 0;
    for (const page of PAGES) {
      for (const role of ROLES) {
        for (const source of [null, ...TROUBLE_SOURCES]) {
          resetErrors();
          for (let i = 0; i < 6; i++) {
            const thrown = hostileError(random);
            noteError(ERROR_SOURCES[i % ERROR_SOURCES.length], thrown, { origin: ORIGIN });
            // A sentinel behind quotes is removed by the scrub even if the canary never heard of it.
          }
          const inputs: ReportInputs = {
            ...baseInputs(),
            page,
            role,
            trouble: source ? { source, forSeconds: int(9, 0, 86_400) } : null,
            errors: recentErrors(),
            // The message and the email are the person's own, shown to them; the report must hold neither.
            message: personText(`I typed ${SENTINELS[0]} myself`),
            email: personText(EMAIL),
          };
          const built = buildReport(inputs);
          if (!built.ok) throw new Error(`${page}/${role}/${source}: ${built.reason}`);
          const report = JSON.stringify(built.body.report);
          for (const sentinel of [...SENTINELS, 'SENTINEL', EMAIL, 'example.invalid']) {
            expect(report.toLowerCase(), `${page}/${role}/${source}: ${sentinel}`).not.toContain(sentinel.toLowerCase());
          }
          expect(built.body.contact).toEqual({ email: EMAIL });
          cases++;
        }
      }
    }
    expect(cases).toBe(PAGES.length * ROLES.length * (TROUBLE_SOURCES.length + 1));
  });

  it('removes quoted text even when the canary was never told about it', () => {
    noteError('error', new SyntaxError(`Unexpected token 'NEVER-REGISTERED', "NEVER-REGISTERED json" is not valid`), { origin: ORIGIN });
    const built = buildReport({ ...baseInputs(), errors: recentErrors() });
    if (!built.ok) throw new Error();
    expect(JSON.stringify(built.body)).not.toContain('NEVER-REGISTERED');
  });

  it('puts the address fragment, the page title and the referrer nowhere, because it never reads them', () => {
    // collect.ts takes only ReportInputs, so there is nothing to stub: these globals are not reachable from it.
    const hostile = { hash: '#b=SENTINEL-board&k=SENTINEL-key9Zq', title: 'SENTINEL-meeting', referrer: 'https://SENTINEL-name.example/' };
    vi.stubGlobal('location', { hash: hostile.hash, origin: ORIGIN, href: `${ORIGIN}/app/${hostile.hash}` });
    vi.stubGlobal('document', { title: hostile.title, referrer: hostile.referrer });
    try {
      const built = buildReport(baseInputs());
      if (!built.ok) throw new Error();
      expect(built.json).not.toContain('SENTINEL');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---- The validator accepts everything collect.ts can produce --------------------------------------------

describe('every report collect can make passes the shared validator', () => {
  const random = mulberry32(99);
  const one = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const word = (max: number): string => {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._-()/;:,éü中\u{1f600}́\t\n\u0000‮\ud800';
    const chars = Array.from({ length: Math.floor(random() * (max + 40)) }, () => alphabet[Math.floor(random() * alphabet.length)]);
    return chars.join('');
  };
  const randomInputs = (): ReportInputs => ({
    ...baseInputs(),
    kind: one(KINDS),
    message: personText(`msg ${word(2500)}`),
    page: one(PAGES), role: one(ROLES), phase: one(PHASES), theme: one(THEMES), scheme: one(SCHEMES), connection: one(CONNECTIONS),
    buildVersion: buildVersion(one(['dev', 'unknown', '0123abc', 'junk', word(10)])),
    liveVersion: random() < 0.3 ? null : buildVersion(one(['dev', 'abcdef0', word(7)])),
    userAgent: cap(word(300), 200),
    language: language(one(['en', 'en-GB', 'zh-Hans-CN', 'x', word(8), 'EN_gb'])),
    viewport: { w: tens((random() - 0.2) * 20_000), h: tens(random() * 5000) },
    pixelRatio: pixelRatio(random() * 12 - 2),
    online: random() < 0.5,
    capabilities: { webrtc: one([true, false, null]), wakeLock: one([true, false, null]), storagePersisted: one([true, false, null]) },
    relays: Array.from({ length: Math.floor(random() * 7) }, () => ({
      host: relayHost(one(['wss://relay.primal.net', 'wss://nostr.mom', 'ws://localhost:17777', 'wss://evil.example', word(20)])),
      connected: random() < 0.5, refused: int(random() * 20_000, 0, 9999), dropped: int(random() * 100 - 20, 0, 9999),
      held: int(random() * 5, 0, 9999), givenUp: random() < 0.5,
    })),
    directPeers: int(random() * 2000, 0, 999),
    people: int(random() * 2000 - 100, 0, 999),
    trouble: random() < 0.5 ? null : { source: one(TROUBLE_SOURCES), forSeconds: int(random() * 200_000, 0, 86_400) },
    uptimeSeconds: int(random() * 1_000_000, 0, 604_800),
    errors: Array.from({ length: Math.floor(random() * 6) }, () => ({
      source: one(ERROR_SOURCES), name: one(ERROR_NAMES), message: cap(word(200), 120),
      stack: Array.from({ length: Math.floor(random() * 9) }, () => stackFrame(word(5).replace(/[^A-Za-z0-9]/g, 'a') || 'a', Math.floor(random() * 1e6), Math.floor(random() * 1e6)))
        .filter((f): f is NonNullable<typeof f> => f !== null),
      agoSeconds: int(random() * 1e6, 0, 604_800),
    })),
  });

  it('accepts 300 random reports, or falls back to the message alone and says so', () => {
    let full = 0;
    for (let i = 0; i < 300; i++) {
      const built = buildReport(randomInputs());
      if (!built.ok) {
        // A random message may be empty after cleaning or look like a link; nothing else may fail.
        expect(['empty', 'link', 'chars']).toContain(built.reason);
        continue;
      }
      expect(validateBody(JSON.parse(built.json) as FeedbackBody).ok).toBe(true);
      expect(new TextEncoder().encode(built.json).length).toBeLessThanOrEqual(16_384);
      if (!built.reportFailed) full++;
    }
    expect(full).toBeGreaterThan(200);
  });
});
