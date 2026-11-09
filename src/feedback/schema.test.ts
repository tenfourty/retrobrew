import { describe, expect, it } from 'vitest';
import { sampleBody, sampleReport } from '../test/feedback-fixtures';
import { mulberry32 } from '../test/mulberry32';
import {
  LIMITS,
  looksLikeMeetingLink,
  normaliseEmail,
  normaliseMessage,
  validateBody,
  type FeedbackReport,
} from './schema';

const rejects = (body: unknown, reason?: string) => {
  const result = validateBody(body);
  expect(result.ok).toBe(false);
  if (reason && !result.ok) expect(result.reason).toBe(reason);
};

describe('normaliseEmail', () => {
  it('accepts ordinary, plus-tagged and international addresses, in a canonical form', () => {
    expect(normaliseEmail('ann@example.com')).toBe('ann@example.com');
    expect(normaliseEmail('  ann+retro@Example.COM ')).toBe('ann+retro@example.com');
    expect(normaliseEmail('ann@münchen.de')).toBe('ann@xn--mnchen-3ya.de');
    expect(normaliseEmail('a.b_c-d@sub.example.co.uk')).toBe('a.b_c-d@sub.example.co.uk');
  });

  it('refuses display names, lists, quotes, brackets, whitespace and control characters', () => {
    for (const bad of [
      'Ann <ann@example.com>', 'a@example.com, b@example.com', 'a@b@example.com', '"ann"@example.com', 'ann@example',
      'ann@example.c', 'ann@@example.com', '@example.com', 'ann@', 'ann smith@example.com', 'ann@exa mple.com',
      'ann\u0000@example.com', 'ann\n@example.com', 'ann@exa<mple.com', 'ann@.example.com', 'ann@example..com', '', '   ',
      `${'a'.repeat(65)}@example.com`, `a@${'b'.repeat(250)}.com`, 'ann@example.com‮',
    ]) expect(normaliseEmail(bad), JSON.stringify(bad)).toBeNull();
  });

  it('refuses a decomposed local part, dots at the ends or doubled, and a local part over 64 bytes', () => {
    for (const bad of [
      'cafe\u0301@example.com', '.ann@example.com', 'ann.@example.com', 'a..b@example.com',
      `${'é'.repeat(33)}@example.com`, // 33 units but 66 bytes
    ]) expect(normaliseEmail(bad), JSON.stringify(bad)).toBeNull();
    expect(normaliseEmail(`${'é'.repeat(32)}@example.com`)).toBe(`${'é'.repeat(32)}@example.com`);
    expect(normaliseEmail('café@example.com')).toBe('café@example.com');
  });

  it('allows 254 characters and refuses 255', () => {
    const label = (n: number) => 'd'.repeat(n);
    const at254 = `${'l'.repeat(64)}@${label(63)}.${label(63)}.${label(57)}.com`;
    expect(at254).toHaveLength(254);
    expect(normaliseEmail(at254)).toBe(at254);
    const at255 = `${'l'.repeat(63)}@${label(63)}.${label(63)}.${label(59)}.com`;
    expect(at255).toHaveLength(255);
    expect(normaliseEmail(at255)).toBeNull();
    expect(normaliseEmail(`a@${label(64)}.com`)).toBeNull();
  });
});

describe('normaliseMessage', () => {
  it('normalises to NFC, keeps newlines, drops controls, bidi marks and lone surrogates, and cuts at 2,000', () => {
    expect(normaliseMessage('é')).toBe('é');
    expect(normaliseMessage('a\r\nb\rc')).toBe('a\nb\nc');
    expect(normaliseMessage('a\tb')).toBe('a b');
    expect(normaliseMessage('a\u0000b\u0007c‮d⁦e')).toBe('abcde');
    expect(normaliseMessage('a\ud800b\udc00c')).toBe('abc');
    expect(normaliseMessage('  hello  ')).toBe('hello');
    expect(normaliseMessage('x'.repeat(2500))).toHaveLength(LIMITS.message);
  });

  it('never cuts a surrogate pair in half', () => {
    const cut = normaliseMessage(`${'x'.repeat(LIMITS.message - 1)}\u{1f600}`);
    expect(cut).toHaveLength(LIMITS.message - 1);
  });
});

describe('looksLikeMeetingLink', () => {
  const share = 'https://retrobrew.app/app/#b=AbCdEfGh12345678&k=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MDEyMzQ&h=BPxxxx';

  it('catches a share link, a bare fragment, and the same after URL-encoding', () => {
    expect(looksLikeMeetingLink(share)).toBe(true);
    expect(looksLikeMeetingLink('see #b=AbCdEfGh12345678')).toBe(true);
    expect(looksLikeMeetingLink('#k=abc')).toBe(true);
    expect(looksLikeMeetingLink(encodeURIComponent(share))).toBe(true);
    expect(looksLikeMeetingLink('retrobrew.app%2Fapp%2F%23b%3Dabc')).toBe(true);
    expect(looksLikeMeetingLink('open https://retrobrew.app/app/#start for a rehearsal')).toBe(true);
    expect(looksLikeMeetingLink('RetroBrew.app/app#anything')).toBe(true);
  });

  it('catches a long b= or k= value with no hash', () => {
    expect(looksLikeMeetingLink('b=AbCdEfGh12345678')).toBe(true);
    expect(looksLikeMeetingLink('x?k=Zm9vYmFyYmF6cXV4MTIzNDU2')).toBe(true);
    expect(looksLikeMeetingLink('b=AbCdEfGh1234567')).toBe(false);
  });

  it('lets ordinary text through, including sums', () => {
    for (const ok of [
      'The timer froze at 2:00.', 'Set a = 3 and b=4, then k=5 gives 9.', 'We use sub=1 and web=2', 'Visit retrobrew.app/app for the app',
      'It said 100% done', 'See https://retrobrew.app/lean-coffee/ for the guide', 'Topic #3 was lost', 'abc%zz',
    ]) expect(looksLikeMeetingLink(ok), ok).toBe(false);
  });

  it('catches a link encoded twice or three times', () => {
    const once = (t: string) => encodeURIComponent(t);
    expect(looksLikeMeetingLink(once(once(share)))).toBe(true);
    expect(looksLikeMeetingLink(once(once(once('see #b=abc'))))).toBe(true);
  });

  it('survives text that is not valid percent-encoding', () => {
    expect(looksLikeMeetingLink('100%')).toBe(false);
    expect(looksLikeMeetingLink('%E0%A4%A #b=abc')).toBe(true);
  });
});

describe('invisible characters', () => {
  it('are refused by the validator and dropped from the message', () => {
    for (const ch of ['\u200B', '\u200E', '\u200F', '\u061C', '\u2028', '\u2029', '\uFEFF']) {
      const result = validateBody({ ...sampleBody(), message: `a${ch}b` });
      expect(result, JSON.stringify(ch)).toEqual({ ok: false, reason: 'chars' });
      expect(normaliseMessage(`a${ch}b`)).toBe('ab');
      expect(normaliseEmail(`a${ch}b@example.com`)).toBeNull();
    }
  });
});

describe('validateBody', () => {
  it('requires NFC in the user agent and the error messages, as in the message', () => {
    const report = sampleReport();
    rejects({ ...sampleBody(), report: { ...report, userAgent: 'Mozilla cafe\u0301' } }, 'chars');
    rejects({ ...sampleBody(), report: { ...report, errors: [{ ...report.errors[0], message: 'cafe\u0301 broke' }] } }, 'chars');
    expect(validateBody({ ...sampleBody(), report: { ...report, userAgent: 'Mozilla café' } }).ok).toBe(true);
  });

  it('accepts a full body, one with no report, and one with an email', () => {
    expect(validateBody(sampleBody()).ok).toBe(true);
    expect(validateBody({ ...sampleBody(), report: null }).ok).toBe(true);
    expect(validateBody({ ...sampleBody(), contact: { email: 'ann@example.com' } }).ok).toBe(true);
  });

  it('returns the body it checked, so callers use the validated value', () => {
    const result = validateBody(sampleBody());
    expect(result.ok && result.body).toEqual(sampleBody());
  });

  it('rejects anything that is not an object, and unknown or missing keys at every level', () => {
    for (const bad of [null, undefined, 3, 'x', [], [sampleBody()]]) rejects(bad, 'shape');
    rejects({ ...sampleBody(), extra: 1 }, 'shape');
    const { contact: _contact, ...noContact } = sampleBody();
    rejects(noContact, 'shape');
    rejects({ ...sampleBody(), report: { ...sampleReport(), extra: 1 } }, 'shape');
    rejects({ ...sampleBody(), report: { ...sampleReport(), email: 'a@b.co' } }, 'shape');
    rejects({ ...sampleBody(), contact: { email: 'a@example.com', name: 'x' } }, 'shape');
    rejects({ ...sampleBody(), report: { ...sampleReport(), viewport: { w: 10, h: 10, z: 1 } } }, 'shape');
    const { page: _page, ...noPage } = sampleReport();
    rejects({ ...sampleBody(), report: noPage }, 'shape');
  });

  it('rejects objects with another prototype or symbol keys', () => {
    class Body {}
    const odd = Object.assign(new Body(), sampleBody());
    rejects(odd, 'shape');
    rejects({ ...sampleBody(), [Symbol('x')]: 1 }, 'shape');
  });

  it('checks the version, the kind and the message', () => {
    rejects({ ...sampleBody(), v: 2 });
    rejects({ ...sampleBody(), v: '1' });
    rejects({ ...sampleBody(), kind: 'bug' });
    rejects({ ...sampleBody(), message: '' });
    rejects({ ...sampleBody(), message: '   \n ' });
    rejects({ ...sampleBody(), message: 7 });
    rejects({ ...sampleBody(), message: 'x'.repeat(2001) });
    expect(validateBody({ ...sampleBody(), message: 'x'.repeat(2000) }).ok).toBe(true);
    rejects({ ...sampleBody(), message: 'é' }, 'chars');
  });

  it('refuses control characters, bidi overrides and lone surrogates anywhere, but allows newline and tab in the message', () => {
    for (const bad of ['a\u0000b', 'a\u0007b', 'a‮b', 'a⁩b', 'a\ud800b', 'a\udfffb', 'a\u0085b', 'a\u007fb']) {
      rejects({ ...sampleBody(), message: bad }, 'chars');
      rejects({ ...sampleBody(), report: { ...sampleReport(), userAgent: bad } }, 'chars');
    }
    expect(validateBody({ ...sampleBody(), message: 'a\nb\tc' }).ok).toBe(true);
    expect(validateBody({ ...sampleBody(), message: 'café \u{1f600}' }).ok).toBe(true);
  });

  it('refuses a meeting link in the message, the report or an error text', () => {
    rejects({ ...sampleBody(), message: 'my meeting is https://retrobrew.app/app/#b=AbCdEfGh12345678&k=x' }, 'link');
    const report = sampleReport();
    report.errors[0].message = '#b=abcdefgh';
    rejects({ ...sampleBody(), report }, 'link');
    rejects({ ...sampleBody(), report: { ...sampleReport(), userAgent: 'k=AbCdEfGh12345678AAAA' } }, 'link');
  });

  it('checks the email by the shared rule and keeps it canonical', () => {
    rejects({ ...sampleBody(), contact: { email: 'not an email' } }, 'email');
    rejects({ ...sampleBody(), contact: { email: 'Ann@Example.COM' } }, 'email');
    rejects({ ...sampleBody(), contact: { email: ' ann@example.com' } }, 'email');
    rejects({ ...sampleBody(), contact: { email: 'ann@münchen.de' } }, 'email');
    rejects({ ...sampleBody(), contact: { email: 5 } }, 'shape');
    rejects({ ...sampleBody(), contact: 'ann@example.com' }, 'shape');
    rejects({ ...sampleBody(), contact: {} }, 'shape');
    expect(validateBody({ ...sampleBody(), contact: { email: 'ann@xn--mnchen-3ya.de' } }).ok).toBe(true);
  });

  it('checks each report field against its pattern and range', () => {
    const bad = (patch: Partial<FeedbackReport>) => rejects({ ...sampleBody(), report: { ...sampleReport(), ...patch } });
    bad({ page: 'about' as never });
    bad({ role: 'host' as never });
    bad({ phase: 'x' as never });
    bad({ theme: 'dark' as never });
    bad({ scheme: 'auto' as never });
    bad({ buildVersion: 'ABCDEF1' });
    bad({ buildVersion: '0123abcd' });
    bad({ buildVersion: 'devel' });
    bad({ liveVersion: 'zzzzzzz' });
    bad({ userAgent: 'x'.repeat(201) });
    bad({ language: 'en_GB' });
    bad({ language: 'english' });
    bad({ viewport: { w: 1285, h: 720 } });
    bad({ viewport: { w: 10_000, h: 720 } });
    bad({ viewport: { w: -10, h: 720 } });
    bad({ pixelRatio: 0 });
    bad({ pixelRatio: 8.5 });
    bad({ pixelRatio: 1.3 });
    bad({ pixelRatio: Number.NaN });
    bad({ online: 'yes' as never });
    bad({ capabilities: { webrtc: 1, wakeLock: null, storagePersisted: null } as never });
    bad({ connection: 'offline' as never });
    bad({ directPeers: 1000 });
    bad({ directPeers: 1.5 });
    bad({ people: -1 });
    bad({ uptimeSeconds: 604_801 });
    bad({ trouble: { source: 'other', forSeconds: 1 } as never });
    bad({ trouble: { source: 'save', forSeconds: 86_401 } });
    for (const ok of ['dev', 'unknown', 'abcdef0']) {
      expect(validateBody({ ...sampleBody(), report: { ...sampleReport(), buildVersion: ok } }).ok, ok).toBe(true);
    }
    for (const ok of ['en', 'en-GB', 'fil', 'zh-Hant']) {
      expect(validateBody({ ...sampleBody(), report: { ...sampleReport(), language: ok } }).ok, ok).toBe(true);
    }
  });

  it('checks relays and errors', () => {
    const relay = sampleReport().relays[0];
    const withRelays = (relays: unknown) => ({ ...sampleBody(), report: { ...sampleReport(), relays } });
    expect(validateBody(withRelays([])).ok).toBe(true);
    rejects(withRelays(Array.from({ length: 5 }, () => relay)));
    rejects(withRelays([{ ...relay, host: 'wss://relay.primal.net' }]));
    rejects(withRelays([{ ...relay, host: 'RELAY' }]));
    rejects(withRelays([{ ...relay, refused: 10_000 }]));
    rejects(withRelays([{ ...relay, notices: 3 }]));
    rejects(withRelays([{ ...relay, givenUp: 'no' }]));
    expect(validateBody(withRelays([{ ...relay, host: 'other' }])).ok).toBe(true);

    const error = sampleReport().errors[0];
    const withErrors = (errors: unknown) => ({ ...sampleBody(), report: { ...sampleReport(), errors } });
    rejects(withErrors(Array.from({ length: 4 }, () => error)));
    rejects(withErrors([{ ...error, name: 'MyCustomError' }]));
    rejects(withErrors([{ ...error, source: 'startup2' }]));
    rejects(withErrors([{ ...error, message: 'x'.repeat(121) }]));
    rejects(withErrors([{ ...error, stack: Array.from({ length: 7 }, () => 'index:1:1') }]));
    rejects(withErrors([{ ...error, stack: ['at foo (https://x/y.js:1:2)'] }]));
    rejects(withErrors([{ ...error, stack: ['index:1234567:1'] }]));
    rejects(withErrors([{ ...error, agoSeconds: -1 }]));
    expect(validateBody(withErrors([{ ...error, message: 'x'.repeat(120), stack: ['a-b.c_d:1:1'] }])).ok).toBe(true);
  });

  it('never throws, whatever it is given', () => {
    const random = mulberry32(7);
    const pieces: unknown[] = [null, undefined, 0, -1, 1.5, Number.NaN, Infinity, '', 'x', '\ud800', true, [], {}, [1], { a: 1 }, 1n, () => 1];
    const pick = () => pieces[Math.floor(random() * pieces.length)];
    for (let i = 0; i < 500; i++) {
      const body: Record<string, unknown> = { v: pick(), kind: pick(), message: pick(), report: random() < 0.5 ? pick() : { page: pick(), errors: [pick()] }, contact: pick() };
      expect(() => validateBody(body)).not.toThrow();
      expect(validateBody(body).ok).toBe(false);
    }
  });
});
