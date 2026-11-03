import { describe, expect, it } from 'vitest';
import { exclusive } from './exclusive';

describe('exclusive', () => {
  it('ignores a call made while another is running, and allows the next once it has finished or failed', async () => {
    const only = exclusive();
    let finish!: () => void;
    let started = 0;
    const first = only(() => { started += 1; return new Promise<string>((resolve) => { finish = () => resolve('a'); }); });
    expect(await only(async () => { started += 1; return 'b'; })).toBeUndefined();
    expect(started).toBe(1);
    finish();
    expect(await first).toBe('a');
    await expect(only(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await only(async () => 'c')).toBe('c');
  });
});
