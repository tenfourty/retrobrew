/// <reference types="node" />
import { execFileSync } from 'node:child_process';

// Used only by vite.config.ts at build time, never by the app, so it may use Node's APIs.
const COMMIT = /^[0-9a-f]{7,40}$/;

const gitHead = (): string => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });

// The commit this build comes from: the REVISION build argument (the container build has no .git),
// otherwise the checkout's HEAD, otherwise "unknown".
export function buildRevision(env: Record<string, string | undefined> = process.env, git: () => string = gitHead): string {
  const fromEnv = env.REVISION?.trim();
  if (fromEnv && COMMIT.test(fromEnv)) return fromEnv;
  try {
    const head = git().trim();
    return COMMIT.test(head) ? head : 'unknown';
  } catch {
    return 'unknown';
  }
}

// The seven-character form of the build that the page, the footers and the feedback report carry (__RB_REVISION__).
// Always derived from buildRevision(), so it is the start of what /version.txt says: the commit's first seven digits,
// or "unknown" when no commit ID can be found.
export function shortRevision(env: Record<string, string | undefined> = process.env, git: () => string = gitHead): string {
  return buildRevision(env, git).slice(0, 7);
}
