// Opening a sealed record. The endpoint never imports this file (it holds no private key); the reader will, and the
// endpoint's tests use it to prove the round trip.
import { aad, hkdfInfo, type SealedRecord } from './seal.ts';

const subtle = globalThis.crypto.subtle;

export class QuarantineError extends Error {}

/** `privateKeys` maps each key id the reader still holds to its private ECDH key. Throws QuarantineError on any failure. */
export async function openRecord(sealed: string, privateKeys: ReadonlyMap<string, CryptoKey>): Promise<Uint8Array> {
  try {
    const record = JSON.parse(sealed) as SealedRecord;
    if (record.v !== 1) throw new QuarantineError('version');
    const privateKey = privateKeys.get(record.kid);
    if (!privateKey) throw new QuarantineError('kid');
    const epk = Buffer.from(record.epk, 'base64url');
    const publicKey = await subtle.importKey('raw', epk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    const hkdf = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const key = await subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: epk, info: hkdfInfo(record.kid) as BufferSource },
      hkdf, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
    );
    const iv = Buffer.from(record.iv, 'base64url');
    const plain = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad(record.v, record.kid, epk) as BufferSource }, key, Buffer.from(record.ct, 'base64url'),
    );
    return new Uint8Array(plain);
  } catch (error) {
    throw error instanceof QuarantineError ? error : new QuarantineError('open');
  }
}
