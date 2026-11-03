import { fromB64url, toB64url, utf8, type Bytes } from './bytes';
import { sha256 } from './hash';

const KEY_ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;
const RAW_PUBLIC_KEY_BYTES = 65;

export interface Signer {
  pub: string;
  privateKey: CryptoKey;
}

export interface KeyPairJwk {
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}

export function generateSigningKeys(extractable: boolean): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(KEY_ALG, extractable, ['sign', 'verify']);
}

export async function signerFrom(pair: CryptoKeyPair): Promise<Signer> {
  return { pub: await exportPublicKey(pair.publicKey), privateKey: pair.privateKey };
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<string> {
  return toB64url(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)));
}

export async function importPublicKey(pub: string): Promise<CryptoKey> {
  const raw = fromB64url(pub);
  if (raw.length !== RAW_PUBLIC_KEY_BYTES) throw new Error('Public key must be 65 bytes');
  return crypto.subtle.importKey('raw', raw, KEY_ALG, true, ['verify']);
}

export async function signText(signer: Signer, text: string): Promise<string> {
  return toB64url(new Uint8Array(await crypto.subtle.sign(SIGN_ALG, signer.privateKey, utf8(text))));
}

export async function verifyText(pub: string, text: string, sig: string): Promise<boolean> {
  try {
    const key = await importPublicKey(pub);
    return await crypto.subtle.verify(SIGN_ALG, key, fromB64url(sig), utf8(text));
  } catch {
    return false;
  }
}

// Raw 64-byte P-256 signatures (r then s), for relay bundle items, which carry no base64.
export async function signBytes(signer: Signer, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await crypto.subtle.sign(SIGN_ALG, signer.privateKey, data));
}

export async function verifyBytes(pub: string, data: Bytes, sig: Uint8Array): Promise<boolean> {
  try {
    return await crypto.subtle.verify(SIGN_ALG, await importPublicKey(pub), new Uint8Array(sig), data);
  } catch {
    return false;
  }
}

// Participant IDs are the first 16 bytes of SHA-256 over the raw public key.
export async function fingerprint(pub: string): Promise<string> {
  return toB64url((await sha256(fromB64url(pub))).slice(0, 16));
}

export async function exportKeyPair(pair: CryptoKeyPair): Promise<KeyPairJwk> {
  return {
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}

export async function importKeyPair(jwk: KeyPairJwk): Promise<CryptoKeyPair> {
  return {
    publicKey: await crypto.subtle.importKey('jwk', jwk.publicKey, KEY_ALG, true, ['verify']),
    privateKey: await crypto.subtle.importKey('jwk', jwk.privateKey, KEY_ALG, true, ['sign']),
  };
}
