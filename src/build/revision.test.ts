import { describe, expect, it } from 'vitest';
import { buildRevision, shortRevision } from './revision';

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

describe('shortRevision', () => {
  const noGit = () => { throw new Error('not a git checkout'); };

  it('is always the first seven digits of what version.txt says, from the same source', () => {
    for (const [env, git] of [
      [{ REVISION: sha }, noGit],
      [{}, () => `${sha}\n`],
      [{ REVISION: 'unknown' }, () => sha],
      [{ REVISION: '  ' }, () => sha],
    ] as const) {
      expect(shortRevision(env, git)).toBe(buildRevision(env, git).slice(0, 7));
    }
    expect(shortRevision({}, () => sha)).toBe('0123456');
  });

  it('says "unknown" when there is no commit ID to be had, as version.txt does', () => {
    expect(shortRevision({}, noGit)).toBe('unknown');
    expect(shortRevision({ REVISION: '<script>' }, noGit)).toBe('unknown');
    expect(buildRevision({}, noGit)).toBe('unknown');
  });
});
