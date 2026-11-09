import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCanary, installErrorCapture, noteError, recentErrors, registerCanary, resetErrors, scrubMessage } from './errors';

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

const withStack = (message: string, stack: string, name = 'Error'): Error => {
  const error = new Error(message);
  error.name = name;
  error.stack = stack;
  return error;
};

describe('scrubMessage', () => {
  it('replaces every quoted run, whatever the quote, and keeps the words around them', () => {
    expect(scrubMessage(`Unexpected token 'h', "hello world" is not valid JSON`)).toBe('Unexpected token "…", "…" is not valid JSON');
    expect(scrubMessage('Cannot read properties of undefined (reading `topicText`)')).toBe('Cannot read properties of undefined (reading "…")');
    expect(scrubMessage('bad “curly secret” and «guillemet secret»')).toBe('bad "…" and "…"');
  });

  it('does not read an apostrophe in a word as a quote, and still removes the quoted word after it', () => {
    const out = scrubMessage(`Can't read property 'secretName' of undefined`);
    expect(out).toBe(`Can't read property "…" of undefined`);
    expect(out).not.toContain('secretName');
  });

  it('drops everything after an opening quote that never closes', () => {
    expect(scrubMessage('bad value "never closed and secret')).toBe('bad value "…"');
    expect(scrubMessage(`it is 'secret and more`)).toBe('it is "…"');
  });

  it('keeps the first line only, hides email addresses and meeting links, strips controls, and cuts at 120', () => {
    expect(scrubMessage('first line\nsecond line with detail')).toBe('first line');
    expect(scrubMessage('failed for ann@example.com today')).toBe('failed for [email] today');
    expect(scrubMessage('bad #b=AbCdEfGh12345678')).toBe('[withheld]');
    expect(scrubMessage('a\u0000b‮c')).toBe('abc');
    expect(scrubMessage('x'.repeat(300))).toHaveLength(120);
  });

  it('removes a quoted run that spans lines', () => {
    expect(scrubMessage('bad "line one\nsecret line two" end')).toBe('bad "…" end');
  });
});

describe('scrubMessage checks the whole line before it cuts', () => {
  const KEY = 'AbCdEfGh12345678';

  it('withholds a link that the length cap would cut in half', () => {
    // 100 characters, then a key parameter: the cut at 120 would leave 14 of its 16 characters, too few to look like a key.
    const raw = `${'x'.repeat(100)} see b=${KEY}`;
    const out = scrubMessage(raw);
    expect(out).toBe('[withheld]');
    expect(out).not.toContain('AbCdEf');
  });

  it('hides an email address that the cap would cut in half', () => {
    const out = scrubMessage(`${'x'.repeat(112)} secret.person@example.com`);
    expect(out).not.toContain('secret');
    expect(out).not.toContain('@');
  });

  it('hides an email address hidden by a control character inside it', () => {
    const out = scrubMessage('failed for ann\u0000@example.com today');
    expect(out).toBe('failed for [email] today');
  });

  it('redacts a b=, k= or h= value of any length, but keeps the words around it', () => {
    for (const raw of ['bad k=abc here', 'bad b=A here', 'bad k=%41%42 here', 'bad h=abc here']) {
      const out = scrubMessage(raw);
      expect(out).not.toMatch(/=\s*(?:abc|A|%41)/);
      expect(out).toContain('bad');
      expect(out).toContain('here');
    }
  });

  it('withholds a link that sits on a later line of the raw message', () => {
    expect(scrubMessage(`boom\nopen https://retrobrew.app/app/#b=${KEY}`)).toBe('[withheld]');
  });
});

describe('noteError', () => {
  it('keeps name, scrubbed message and stack frames of our own scripts, newest first', () => {
    noteError('error', withStack("bad 'secret'", `TypeError: bad\n    at f (${ORIGIN}/assets/index-ab12cd34.js:1:2345)\n    at g (${ORIGIN}/assets/vendor.js:20:7)`, 'TypeError'), { origin: ORIGIN });
    vi.advanceTimersByTime(5000);
    noteError('save', new RangeError('second'), { origin: ORIGIN });
    const [newest, older] = recentErrors();
    expect(newest).toMatchObject({ source: 'save', name: 'RangeError', message: 'second', stack: [], agoSeconds: 0 });
    expect(older).toEqual({ source: 'error', name: 'TypeError', message: 'bad "…"', stack: ['index:1:2345', 'vendor:20:7'], agoSeconds: 5 });
  });

  it('reads the stack in the Firefox and Safari format, and skips frames from another origin', () => {
    const stack = `f@${ORIGIN}/assets/app-0a1b2c3d.js:3:4\ng@https://evil.example/assets/x.js:1:1\nh@chrome-extension://abc/inject.js:1:1`;
    noteError('error', withStack('boom', stack), { origin: ORIGIN });
    expect(recentErrors()[0].stack).toEqual(['app:3:4']);
  });

  it('keeps six frames at most and drops function names', () => {
    const frames = Array.from({ length: 9 }, (_, i) => `    at secretFunction${i} (${ORIGIN}/assets/a.js:${i + 1}:1)`).join('\n');
    noteError('error', withStack('boom', `Error: boom\n${frames}`), { origin: ORIGIN });
    const [error] = recentErrors();
    expect(error.stack).toHaveLength(6);
    expect(JSON.stringify(error)).not.toContain('secretFunction');
  });

  it('maps an unlisted error name to "other" and a thrown non-error to an empty "other"', () => {
    class MyError extends Error { override name = 'MyCustomError'; }
    noteError('error', new MyError('x'));
    noteError('unhandledrejection', 'a string reason with SECRET');
    noteError('unhandledrejection', { message: 'SECRET object' });
    // The two things that were not errors are the same empty "other", so they collapse into one.
    const [empty, first] = recentErrors();
    expect(first).toMatchObject({ name: 'other', message: 'x' });
    expect(empty).toMatchObject({ name: 'other', message: '', stack: [] });
    expect(recentErrors()).toHaveLength(2);
    expect(JSON.stringify(recentErrors())).not.toContain('SECRET');
  });

  it('withholds a message or a stack that holds a registered string, case-folded', () => {
    registerCanary(['Quarterly Budget', 'ab']);
    noteError('error', withStack('could not save quarterly budget now', `Error\n    at f (${ORIGIN}/assets/Quarterly Budget.js:1:1)`), { origin: ORIGIN });
    const [error] = recentErrors();
    expect(error.message).toBe('[withheld]');
    expect(error.stack).toEqual([]);
    // Strings under three characters are ignored: they would match everything.
    noteError('error', new Error('table of abacus'), { origin: ORIGIN });
    expect(recentErrors()[0].message).toBe('table of abacus');
  });

  it('compares the canary in normalised form: case, NFC and control characters do not hide it', () => {
    registerCanary(['Cafe\u0301 Plan', 'sec\u0000ret word']);
    noteError('error', new Error('could not open CAF\u00c9 PLAN today'));
    expect(recentErrors()[0].message).toBe('[withheld]');
    noteError('error', new Error('bad SECRET Word'));
    expect(recentErrors()[0].message).toBe('[withheld]');
    // And the other way: the canary is plain, the raw text carries controls and a decomposed accent.
    clearCanary();
    registerCanary(['Café Plan']);
    noteError('error', new Error('x Cafe\u0301 P\u0001lan'));
    expect(recentErrors()[0].message).toBe('[withheld]');
  });

  it('withholds a message whose scrubbed form holds a registered string the raw text did not', () => {
    registerCanary(['saw [email] twice']);
    noteError('error', new Error('saw ann@example.com twice'));
    expect(recentErrors()[0].message).toBe('[withheld]');
  });

  it('withholds a stack that holds a registered string in another case or form', () => {
    registerCanary(['Budget\u0000File']);
    noteError('error', withStack('boom', `Error\n    at f (${ORIGIN}/assets/BUDGETFILE.js:1:1)`), { origin: ORIGIN });
    expect(recentErrors()[0].stack).toEqual([]);
  });

  it('withholds an error already in the ring when a canary is registered later', () => {
    noteError('error', withStack('could not save Quarterly Budget', `Error\n    at f (${ORIGIN}/assets/BudgetFile.js:1:1)`), { origin: ORIGIN });
    expect(recentErrors()[0].message).toBe('could not save Quarterly Budget');
    registerCanary(['quarterly budget', 'budgetfile']);
    expect(recentErrors()[0]).toMatchObject({ message: '[withheld]', stack: [] });
  });

  it('collapses a repeat of the same error and keeps three errors at most', () => {
    const same = () => noteError('error', withStack('boom', `Error\n    at f (${ORIGIN}/assets/a.js:1:1)`), { origin: ORIGIN });
    same(); vi.advanceTimersByTime(1000); same();
    expect(recentErrors()).toHaveLength(1);
    expect(recentErrors()[0].agoSeconds).toBe(0);
    for (const word of ['one', 'two', 'three', 'four']) { vi.advanceTimersByTime(1000); noteError('error', new Error(word)); }
    expect(recentErrors().map((e) => e.message)).toEqual(['four', 'three', 'two']);
  });

  it('counts at most 20 events a minute, so a render loop cannot flood memory', () => {
    for (let i = 0; i < 100; i++) noteError('error', new Error(`loop ${i}`));
    expect(recentErrors()[0].message).toBe('loop 19');
    vi.advanceTimersByTime(61_000);
    noteError('error', new Error('later'));
    expect(recentErrors()[0].message).toBe('later');
  });

  it('tells the caller whether it kept the error', () => {
    expect(noteError('save', new Error('x'))).toBe(true);
    for (let i = 0; i < 25; i++) noteError('error', new Error(`loop ${i}`));
    expect(noteError('error', new Error('over the cap'))).toBe(false);
  });
});

describe('installErrorCapture', () => {
  const makeTarget = () => {
    const handlers = new Map<string, (event: unknown) => void>();
    return {
      handlers,
      addEventListener: (type: string, fn: (event: unknown) => void) => { handlers.set(type, fn); },
      removeEventListener: (type: string) => { handlers.delete(type); },
    };
  };

  it('records uncaught errors and rejections from our own scripts, and lets go on uninstall', () => {
    const target = makeTarget();
    const noted: string[] = [];
    const uninstall = installErrorCapture({ target, origin: ORIGIN, onError: (source) => noted.push(source) });
    target.handlers.get('error')?.({ message: 'boom', filename: `${ORIGIN}/assets/index-ab12cd34.js`, error: new TypeError('boom') });
    target.handlers.get('unhandledrejection')?.({ reason: new RangeError('later') });
    expect(recentErrors().map((e) => [e.source, e.name])).toEqual([['unhandledrejection', 'RangeError'], ['error', 'TypeError']]);
    expect(noted).toEqual(['error', 'unhandledrejection']);
    uninstall();
    expect(target.handlers.size).toBe(0);
  });

  it('ignores scripts from another origin, ResizeObserver loops, resource errors and a missing file name', () => {
    const target = makeTarget();
    installErrorCapture({ target, origin: ORIGIN });
    const fire = (event: unknown) => target.handlers.get('error')?.(event);
    fire({ message: 'x', filename: 'chrome-extension://abc/inject.js', error: new Error('extension') });
    fire({ message: 'x', filename: 'https://evil.example/a.js', error: new Error('evil') });
    fire({ message: 'ResizeObserver loop completed with undelivered notifications.', filename: `${ORIGIN}/assets/a.js`, error: new Error('ro') });
    fire({ message: 'Script error.', filename: '', error: null });
    fire({ target: {}, message: '' });
    fire({ message: 'x', filename: `${ORIGIN}/assets/a.js` });
    expect(recentErrors()).toEqual([]);
  });

  it('turns a rejection with a non-error reason into an empty "other"', () => {
    const target = makeTarget();
    installErrorCapture({ target, origin: ORIGIN });
    target.handlers.get('unhandledrejection')?.({ reason: 'SECRET text' });
    expect(recentErrors()).toMatchObject([{ source: 'unhandledrejection', name: 'other', message: '', stack: [] }]);
  });

  it('installs once', () => {
    const target = makeTarget();
    const spy = vi.spyOn(target, 'addEventListener');
    installErrorCapture({ target, origin: ORIGIN });
    installErrorCapture({ target, origin: ORIGIN });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
