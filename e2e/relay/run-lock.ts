import { randomUUID } from 'node:crypto';
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAY_CONTAINER } from './settings';

// One local-relay battery per machine, because the ports and the container name are fixed. playwright.config.ts takes
// this lock while it loads, before Playwright starts the web server, so a second run stops before it builds or binds a
// port, with a message naming the first.
const LOCK_FILE = join(tmpdir(), 'retrobrew-e2e-relay.lock');

export interface Lock {
  token: string;
  pid: number;
}

// This run's token. The runner creates it when it first loads playwright.config.ts; its workers and its web server
// inherit it through the environment. The relay container carries it as a label.
export function runToken(): string {
  process.env.RETROBREW_E2E_RUN ??= randomUUID();
  return process.env.RETROBREW_E2E_RUN;
}

// Takes the lock for this run. A lock held by this run is fine; one whose runner has exited is stale and replaced.
export function claimRelayLock(): void {
  takeLock(LOCK_FILE, { token: runToken(), pid: process.pid });
}

export function releaseRelayLock(): void {
  releaseLock(LOCK_FILE, runToken());
}

// The lock logic, with the file and the contender passed in so a test can simulate two runs. The exclusive create is
// the only way in. A stale lock is moved aside atomically, checked to hold the stale token that was read, and put back
// if it turns out to be somebody else's fresh lock. After writing, the token is read back, and a contender that finds
// another token backs off.
// `afterReadingStale` is a test seam: it runs between reading a stale lock and replacing it.
export function takeLock(file: string, mine: Lock, afterReadingStale?: () => void): void {
  for (let attempt = 0; attempt < 3; attempt++) {
    let created = false;
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: 'wx' });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (created) {
      if (readLock(file)?.token === mine.token) return;
      throw new Error(`Another e2e run took the lock at ${file} at the same moment. Wait for it to finish, then run again`);
    }
    const held = readLock(file);
    if (held?.token === mine.token) return;
    if (held && isAlive(held.pid)) {
      throw new Error(`Another e2e run (pid ${held.pid}) is using the local relay. Wait for it to finish. If it is stuck, stop it, then run: rm ${file}${process.env.E2E_RELAY_UPSTREAM ? '' : `; podman rm --force ${RELAY_CONTAINER}`}`);
    }
    afterReadingStale?.();
    removeIfStillHolding(file, held?.token);
  }
  throw new Error(`Could not take the e2e relay lock at ${file}`);
}

export function releaseLock(file: string, token: string): void {
  removeIfStillHolding(file, token);
}

// Deletes the lock only if it holds `token` (undefined meaning unreadable). The lock is first renamed aside, which is
// atomic, so what is checked is exactly what is deleted.
function removeIfStillHolding(file: string, token: string | undefined): void {
  const aside = `${file}.${randomUUID()}.removing`;
  try {
    renameSync(file, aside);
  } catch {
    return; // Already gone.
  }
  if (readLock(aside)?.token === token) {
    unlinkSync(aside);
    return;
  }
  // Not what was read: somebody replaced it first. Put it back unless a third run has taken the lock meanwhile.
  try {
    linkSync(aside, file);
  } catch {
    // The lock was retaken; that run's post-write check or release handles it.
  }
  unlinkSync(aside);
}

function readLock(file: string): Lock | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Lock;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
