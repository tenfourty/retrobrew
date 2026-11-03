import { describe, expect, it, vi } from 'vitest';
import { forced, forcedStartError, parseForced } from './test-hooks';

describe('test hooks', () => {
  it('reads what a browser test forces, and ignores anything else', () => {
    expect(parseForced('{"participant":{"staleTab":true},"hosting":"failed"}')).toEqual({ participant: { staleTab: true }, hosting: 'failed' });
    expect(parseForced(null)).toEqual({});
    expect(parseForced('not json')).toEqual({});
    expect(parseForced('7')).toEqual({});
    expect(parseForced('null')).toEqual({});
  });

  it('forces nothing outside test builds, even when the setting is there', () => {
    expect(import.meta.env.MODE).not.toBe('e2e');
    vi.stubGlobal('window', { sessionStorage: { getItem: () => '{"hosting":"failed"}' } });
    try {
      expect(forced()).toEqual({});
      expect(forcedStartError()).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
