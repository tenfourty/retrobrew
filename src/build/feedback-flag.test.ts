import { describe, expect, it } from 'vitest';
import { feedbackFlag, PRODUCTION_ORIGIN, STUB_ORIGIN } from './feedback-flag';

describe('feedbackFlag', () => {
  it('is off in a production build with nothing set', () => {
    expect(feedbackFlag({ mode: 'production', command: 'build', env: {} })).toEqual({ origin: '', stub: false });
    expect(feedbackFlag({ mode: 'production', command: 'build', env: { FEEDBACK_ORIGIN: '  ' } })).toEqual({ origin: '', stub: false });
  });

  it('is on in a production build for the production origin only', () => {
    expect(feedbackFlag({ mode: 'production', command: 'build', env: { FEEDBACK_ORIGIN: PRODUCTION_ORIGIN } })).toEqual({ origin: PRODUCTION_ORIGIN, stub: false });
    for (const wrong of ['http://retrobrew.app', 'https://retrobrew.app/', 'https://example.com', 'https://retrobrew.app.evil.test', 'retrobrew.app']) {
      expect(() => feedbackFlag({ mode: 'production', command: 'build', env: { FEEDBACK_ORIGIN: wrong } })).toThrow(/FEEDBACK_ORIGIN/);
    }
  });

  it('is on with the stub in dev and in the e2e build', () => {
    expect(feedbackFlag({ mode: 'development', command: 'serve', env: {} })).toEqual({ origin: STUB_ORIGIN, stub: true });
    expect(feedbackFlag({ mode: 'e2e', command: 'build', env: {} })).toEqual({ origin: STUB_ORIGIN, stub: true });
    expect(feedbackFlag({ mode: 'e2e', command: 'serve', env: {} })).toEqual({ origin: STUB_ORIGIN, stub: true });
  });

  it('keeps previews and the public-relay build off, whatever else is set', () => {
    // `vite preview` is command serve in the default production mode: no button, no stub.
    expect(feedbackFlag({ mode: 'production', command: 'serve', env: {} })).toEqual({ origin: '', stub: false });
  });

  it('refuses a FEEDBACK_ORIGIN in a stub build', () => {
    expect(() => feedbackFlag({ mode: 'e2e', command: 'build', env: { FEEDBACK_ORIGIN: PRODUCTION_ORIGIN } })).toThrow(/stub/);
  });
});
