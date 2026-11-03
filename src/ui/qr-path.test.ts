import { describe, expect, it } from 'vitest';
import { encode } from 'uqr';
import { qrPath } from './qr-path';

const LINK = 'https://retrobrew.app/app/#b=AAAAAAAAAAAAAAAAAAAAAA&k=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&h=CCCC';

describe('qrPath', () => {
  it('keeps a 4-module quiet zone on every side', () => {
    const { size, d } = qrPath(LINK);
    const { data } = encode(LINK, { ecc: 'M', border: 4 });
    expect(data).toHaveLength(size);
    for (let i = 0; i < size; i++) {
      for (const edge of [0, 1, 2, 3, size - 4, size - 3, size - 2, size - 1]) {
        expect(data[edge][i]).toBe(false);
        expect(data[i][edge]).toBe(false);
      }
    }
    // Nothing is drawn in the quiet zone either.
    for (const [, x, y] of d.matchAll(/M(\d+) (\d+)/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(4);
      expect(Number(y)).toBeGreaterThanOrEqual(4);
      expect(Number(y)).toBeLessThan(size - 4);
    }
  });

  it('draws exactly the dark modules, row by row', () => {
    const { size, d } = qrPath(LINK);
    const { data } = encode(LINK, { ecc: 'M', border: 4 });
    const drawn = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
    for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(w); i++) drawn[Number(y)][Number(x) + i] = true;
    }
    expect(drawn).toEqual(data);
    // The top-left finder pattern starts just inside the quiet zone.
    expect(data[4][4]).toBe(true);
  });
});
