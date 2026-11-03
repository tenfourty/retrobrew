// Every sid that leaves the tab table during one host session (dropped, pruned, or gone with its person), so a
// captured command from it can never be applied again, even once its person has no entry at all
// (docs/product/sync-protocol.md, Pruning). In memory only: a command from an earlier host session carries an
// earlier epoch and is dropped anyway.
//
// A Bloom filter of 2 KiB per person. A false positive refuses a new tab with staleTab, and a reload makes a new
// sid; it never lets an old one through. People beyond MAX_PEOPLE share one larger overflow filter, so the memory is
// bounded and the check still never fails open.
export const FILTER_BYTES = 2048;
export const MAX_PEOPLE = 600;
const OVERFLOW_BYTES = 64 * 1024;
const HASHES = 6;

// FNV-1a over the UTF-16 code units, from two offsets, for double hashing.
function fnv(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function bits(text: string, size: number): number[] {
  const a = fnv(text, 0x811c9dc5);
  const b = fnv(text, 0x050c5d1f) | 1;
  const n = size * 8;
  return Array.from({ length: HASHES }, (_, i) => (a + Math.imul(i, b)) >>> 0).map((h) => h % n);
}

function add(filter: Uint8Array, text: string): void {
  for (const bit of bits(text, filter.length)) filter[bit >> 3] |= 1 << (bit & 7);
}

function has(filter: Uint8Array, text: string): boolean {
  return bits(text, filter.length).every((bit) => (filter[bit >> 3] & (1 << (bit & 7))) !== 0);
}

export class GoneFilter {
  private readonly people = new Map<string, Uint8Array>();
  private overflow: Uint8Array | null = null;

  add(personId: string, sid: string): void {
    let filter = this.people.get(personId);
    if (!filter && this.people.size < MAX_PEOPLE) {
      filter = new Uint8Array(FILTER_BYTES);
      this.people.set(personId, filter);
    }
    if (filter) add(filter, sid);
    else add((this.overflow ??= new Uint8Array(OVERFLOW_BYTES)), `${personId} ${sid}`);
  }

  has(personId: string, sid: string): boolean {
    const filter = this.people.get(personId);
    if (filter && has(filter, sid)) return true;
    return this.overflow !== null && has(this.overflow, `${personId} ${sid}`);
  }

  get size(): number {
    return this.people.size;
  }
}
