// A ULID: 48 bits of millisecond time and 80 random bits in 26 Crockford base32 characters, so names sort by age.
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The only shape of a record id; also what makes a file name and a URL segment safe. */
export const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function ulid(nowMs: number, random: Buffer = randomBytes(10)): string {
  let time = '';
  let t = Math.floor(nowMs);
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  let tail = '';
  for (let i = 0; i < 16; i++) {
    tail = ALPHABET[Number(bits & 31n)] + tail;
    bits >>= 5n;
  }
  return time + tail;
}
