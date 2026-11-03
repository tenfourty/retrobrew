import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url));

// A PNG's width and height sit in its IHDR chunk, at bytes 16 to 23.
function pngSize(bytes) {
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('the public pages\' images', () => {
  it('has a 1200 × 630 Open Graph image', () => {
    expect(pngSize(publicFile('og.png'))).toEqual({ width: 1200, height: 630 });
  });

  it('has a 32 px favicon and a 180 px touch icon', () => {
    expect(pngSize(publicFile('favicon.png'))).toEqual({ width: 32, height: 32 });
    expect(pngSize(publicFile('apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });

  it('draws the SVG favicon in the Business light tokens', () => {
    const tokens = JSON.parse(readFileSync(new URL('../design/system/tokens.json', import.meta.url), 'utf8'));
    const svg = publicFile('favicon.svg').toString('utf8');
    for (const name of ['primary', 'dot-1', 'dot-2', 'dot-3']) {
      expect(svg).toContain(tokens.color.tokens.find((t) => t.name === name).value['business-light']);
    }
  });
});
