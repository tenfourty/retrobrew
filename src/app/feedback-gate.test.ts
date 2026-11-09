import { describe, expect, it } from 'vitest';
import { feedbackAllowed } from './feedback-gate';

describe('feedbackAllowed', () => {
  it('is off when the build compiled the feature out', () => {
    expect(feedbackAllowed('', 'https://retrobrew.app')).toBe(false);
  });
  it('is on in the production origin only', () => {
    expect(feedbackAllowed('https://retrobrew.app', 'https://retrobrew.app')).toBe(true);
    expect(feedbackAllowed('https://retrobrew.app', 'http://192.168.1.5:8080')).toBe(false);
    expect(feedbackAllowed('https://retrobrew.app', 'https://retrobrew.app.evil.example')).toBe(false);
  });
  it('is on wherever the dev or e2e build runs, since it talks to the stub on its own origin', () => {
    expect(feedbackAllowed('self', 'http://localhost:4180')).toBe(true);
  });
  it('is off for any other define', () => {
    expect(feedbackAllowed('https://elsewhere.example', 'https://elsewhere.example')).toBe(false);
  });
});
