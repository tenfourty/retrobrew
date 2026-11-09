import { describe, expect, it } from 'vitest';
import { LIMITS } from './schema';
import {
  canSend, countAnnouncement, countText, emailState, failureLine, initialKind, messageState, pasteOverflows, troubleLine,
} from './sheet-model';
import { COPY } from './copy';

describe('messageState', () => {
  it('is empty for blank text and counts what is left', () => {
    expect(messageState('  \n ').empty).toBe(true);
    expect(messageState('hello').left).toBe(LIMITS.message - 5);
  });
  it('refuses a share link, and lets a sum with b= or k= through', () => {
    expect(messageState('see https://retrobrew.app/app/#b=abcdefghijklmnop&k=abcdefghijklmnopqrst').link).toBe(true);
    expect(messageState('if k=3 and b=4 then 12').link).toBe(false);
  });
  it('reads the whole text for the link, not only the part a cut keeps', () => {
    const long = `${'x'.repeat(LIMITS.message)} #b=abcdefghijklmnop`;
    expect(messageState(long).link).toBe(true);
  });
});

describe('count line', () => {
  it('shows only from 200 left down', () => {
    expect(countText(201)).toBeNull();
    expect(countText(200)).toBe('200 left');
    expect(countText(0)).toBe('0 left');
  });
  it('speaks only at 100, 50, 20 and 0 left', () => {
    expect(countAnnouncement(100)).toBe('100 left');
    expect(countAnnouncement(50)).toBe('50 left');
    expect(countAnnouncement(20)).toBe('20 left');
    expect(countAnnouncement(0)).toBe('0 left');
    expect(countAnnouncement(99)).toBe('');
    expect(countAnnouncement(150)).toBe('');
  });
});

describe('pasteOverflows', () => {
  it('is true when the paste would take the text past the limit, counting the selection it replaces', () => {
    expect(pasteOverflows('a'.repeat(1990), 1990, 1990, 'b'.repeat(11))).toBe(true);
    expect(pasteOverflows('a'.repeat(1990), 1990, 1990, 'b'.repeat(10))).toBe(false);
    expect(pasteOverflows('a'.repeat(2000), 0, 2000, 'b'.repeat(2000))).toBe(false);
  });
});

describe('emailState', () => {
  it('is empty, ok or invalid', () => {
    expect(emailState('')).toBe('empty');
    expect(emailState('  ')).toBe('empty');
    expect(emailState('ana+tag@example.com')).toBe('ok');
    expect(emailState('Ana <ana@example.com>')).toBe('invalid');
    expect(emailState('a@b')).toBe('invalid');
  });
});

describe('canSend', () => {
  const base = { empty: false, link: false, email: 'empty' as const, sending: false, online: true };
  it('allows a plain message', () => expect(canSend(base)).toBe(true));
  it.each([
    ['empty', { empty: true }], ['link', { link: true }], ['bad email', { email: 'invalid' as const }],
    ['sending', { sending: true }], ['offline', { online: false }],
  ])('blocks when %s', (_name, change) => expect(canSend({ ...base, ...change })).toBe(false));
});

describe('failureLine', () => {
  it('names the rate limit and the rejection, and uses the generic line otherwise', () => {
    expect(failureLine('rate')).toBe(COPY.failedRate);
    expect(failureLine('rejected')).toBe(COPY.failedRejected);
    expect(failureLine('timeout')).toBe(COPY.failed);
    expect(failureLine('failed')).toBe(COPY.failed);
  });
});

describe('trouble', () => {
  it('presets "Something broke" in trouble and "Something else" otherwise', () => {
    expect(initialKind(null)).toBe('other');
    expect(initialKind({ source: 'save', forSeconds: 1 })).toBe('broke');
  });
  it('says why, for each source', () => {
    for (const source of ['startup', 'save', 'connection', 'error'] as const) expect(troubleLine(source)).toMatch(/^The app noticed/);
  });
});
