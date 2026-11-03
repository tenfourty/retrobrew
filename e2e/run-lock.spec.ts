import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { releaseLock, takeLock } from './relay/run-lock';

// A pid that is certainly not running: a child that has already exited.
const deadPid = spawnSync(process.execPath, ['-e', '0']).pid!;

function setup(): { file: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'rb-lock-test-'));
  return { file: join(dir, 'lock'), done: () => rmSync(dir, { recursive: true, force: true }) };
}

const holder = (file: string) => (JSON.parse(readFileSync(file, 'utf8')) as { token: string }).token;

test('a stale lock is replaced', () => {
  const { file, done } = setup();
  try {
    writeFileSync(file, JSON.stringify({ token: 'stale', pid: deadPid }));
    takeLock(file, { token: 'a', pid: process.pid });
    expect(holder(file)).toBe('a');
  } finally {
    done();
  }
});

test('a live lock is refused and left alone', () => {
  const { file, done } = setup();
  try {
    writeFileSync(file, JSON.stringify({ token: 'live', pid: process.pid }));
    expect(() => takeLock(file, { token: 'b', pid: process.pid })).toThrow('Another e2e run');
    expect(holder(file)).toBe('live');
  } finally {
    done();
  }
});

test('two contenders finding the same stale lock: one wins and the other cannot delete its lock', () => {
  const { file, done } = setup();
  try {
    writeFileSync(file, JSON.stringify({ token: 'stale', pid: deadPid }));
    // B has read the stale lock and is about to replace it when A takes over completely.
    expect(() => takeLock(file, { token: 'b', pid: process.pid }, () => {
      takeLock(file, { token: 'a', pid: process.pid });
    })).toThrow('Another e2e run');
    expect(holder(file)).toBe('a');
  } finally {
    done();
  }
});

test('release removes only its own lock', () => {
  const { file, done } = setup();
  try {
    takeLock(file, { token: 'a', pid: process.pid });
    releaseLock(file, 'b');
    expect(holder(file)).toBe('a');
    releaseLock(file, 'a');
    expect(() => readFileSync(file)).toThrow();
  } finally {
    done();
  }
});
