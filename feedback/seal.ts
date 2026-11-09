// Sealing: a record is encrypted to the reader's public key before it touches disk. The endpoint holds no private key.
//
// ECDH P-256 with a fresh ephemeral key per record, HKDF-SHA256 to an AES-256-GCM key, and the key id, the format
// version and the ephemeral public key bound into the additional authenticated data, so a record cannot be re-labelled
// to another key. A sealed record is JSON with base64url fields: { v, kid, epk, iv, ct }.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export interface SealedRecord {
  v: 1;
  kid: string;
  epk: string;
  iv: string;
  ct: string;
}

export interface Sealer {
  seal(plaintext: Uint8Array): Promise<string>;
}

export function aad(version: number, kid: string, epk: Uint8Array): Uint8Array {
  const head = encoder.encode(`retrobrew-feedback\0v${version}\0${kid}\0`);
  const out = new Uint8Array(head.length + epk.length);
  out.set(head);
  out.set(epk, head.length);
  return out;
}

/** HKDF info; shared with open.ts so the two cannot drift. */
export const hkdfInfo = (kid: string): Uint8Array => encoder.encode(`retrobrew-feedback-v1|${kid}`);

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

export async function createSealer(kid: string, publicKeyRaw: Uint8Array): Promise<Sealer> {
  const readerKey = await subtle.importKey('raw', publicKeyRaw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  return {
    async seal(plaintext) {
      const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
      const epk = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
      const secret = await subtle.deriveBits({ name: 'ECDH', public: readerKey }, ephemeral.privateKey, 256);
      const hkdf = await subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
      const key = await subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: epk as BufferSource, info: hkdfInfo(kid) as BufferSource },
        hkdf, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
      );
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(1, kid, epk) as BufferSource }, key, plaintext as BufferSource));
      const record: SealedRecord = { v: 1, kid, epk: b64(epk), iv: b64(iv), ct: b64(ct) };
      return JSON.stringify(record);
    },
  };
}
