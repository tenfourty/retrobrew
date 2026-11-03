import { describe, expect, it } from 'vitest';
import { type Bytes, concatBytes as concat, fromUtf8, utf8 } from '../crypto/bytes';
import { deflate, inflate } from './compress';

// The Blob-based pipeline the direct stream writes replaced: the byte-for-byte reference.
async function viaBlob(data: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

// toEqual on megabyte arrays walks them element by element, which is far too slow here.
const same = (a: Bytes, b: Bytes): boolean => Buffer.from(a).equals(Buffer.from(b));

function pseudoRandom(length: number): Bytes {
  const out: Bytes = new Uint8Array(length);
  let x = 123456789;
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}


describe('deflate and inflate', () => {
  it('round-trips and shrinks repetitive text', async () => {
    const text = 'Trunk-based development '.repeat(200);
    const packed = await deflate(utf8(text));
    expect(packed.length).toBeLessThan(text.length / 10);
    expect(fromUtf8(await inflate(packed))).toBe(text);
  });

  it('refuses to inflate past the limit, so a tiny hostile frame cannot exhaust memory', async () => {
    const bomb = await deflate(new Uint8Array(4 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(10_000);
    await expect(inflate(bomb)).rejects.toThrow('Inflated message too large');
  });

  it('rejects bytes that are not deflate data', async () => {
    await expect(inflate(Uint8Array.of(1, 2, 3, 4))).rejects.toThrow();
  });

  describe('is byte-identical to the Blob pipeline', () => {
    const inputs: Array<[string, Bytes]> = [
      ['empty', new Uint8Array(0)],
      ['one byte', Uint8Array.of(7)],
      ['tiny text', utf8('{"hello":"world"}')],
      ['repetitive 100 KB', utf8('Trunk-based development '.repeat(4500))],
      ['incompressible 200 KB', pseudoRandom(200_000)],
      ['zeros 1.5 MB', new Uint8Array(1_500_000)],
      ['mixed 500 KB', concat(pseudoRandom(200_000), new Uint8Array(100_000), pseudoRandom(200_000))],
    ];

    it.each(inputs)('deflate and inflate, %s', async (_name, data) => {
      const expected = await viaBlob(data, new CompressionStream('deflate'));
      const packed = await deflate(data);
      expect(same(packed, expected)).toBe(true);
      expect(same(await inflate(packed, Number.POSITIVE_INFINITY), data)).toBe(true);
      expect(same(await viaBlob(packed, new DecompressionStream('deflate')), data)).toBe(true);
    }, 120_000);

    it('does not detach or alter the caller\'s input', async () => {
      const data = pseudoRandom(1000);
      const copy = data.slice();
      await deflate(data);
      expect(data).toEqual(copy);
    });
  });

  it('fails on truncated and corrupt deflate data without an unhandled rejection', async () => {
    const packed = await deflate(pseudoRandom(5000));
    await expect(inflate(packed.slice(0, packed.length - 10))).rejects.toThrow();
    const corrupt = packed.slice();
    corrupt[corrupt.length >> 1] ^= 0xff;
    await expect(inflate(corrupt)).rejects.toThrow();
  });

  it('honours a custom limit', async () => {
    const packed = await deflate(new Uint8Array(5000));
    await expect(inflate(packed, 4999)).rejects.toThrow('Inflated message too large');
    expect((await inflate(packed, 5000)).length).toBe(5000);
  });
});
