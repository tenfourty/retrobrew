import { describe, expect, it } from 'vitest';
import { buildRevision } from './revision';

const sha = '0123456789abcdef0123456789abcdef01234567';

describe('buildRevision', () => {
  it('uses the REVISION build argument when it is set', () => {
    expect(buildRevision({ REVISION: sha }, () => { throw new Error('no git'); })).toBe(sha);
  });

  it('falls back to the checkout’s commit, then to "unknown"', () => {
    expect(buildRevision({}, () => `${sha}\n`)).toBe(sha);
    expect(buildRevision({ REVISION: 'unknown' }, () => sha)).toBe(sha);
    expect(buildRevision({}, () => { throw new Error('not a git checkout'); })).toBe('unknown');
  });

  it('refuses anything that is not a commit ID', () => {
    expect(buildRevision({ REVISION: '<script>' }, () => { throw new Error('no git'); })).toBe('unknown');
  });
});
