import type { Bytes } from './bytes';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export function generateRoomKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export async function importRoomKey(raw: Bytes): Promise<CryptoKey> {
  if (raw.length !== KEY_BYTES) throw new Error('Room key must be 32 bytes');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(key: CryptoKey, plaintext: Bytes): Promise<Bytes> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const out = new Uint8Array(IV_BYTES + ciphertext.length);
  out.set(iv);
  out.set(ciphertext, IV_BYTES);
  return out;
}

export async function unseal(key: CryptoKey, sealed: Bytes): Promise<Bytes> {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error('Sealed message too short');
  const iv = sealed.slice(0, IV_BYTES);
  const ciphertext = sealed.slice(IV_BYTES);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
}
