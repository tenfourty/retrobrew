import { describe, expect, it } from 'vitest';
import { fromB64url, fromUtf8, toB64url, utf8 } from './bytes';
import { generateRoomKey, importRoomKey, seal, unseal } from './aead';
import {
  exportKeyPair, fingerprint, generateSigningKeys, importKeyPair, signBytes, signText, signerFrom, verifyBytes, verifyText,
} from './sign';

describe('base64url', () => {
  it('round-trips bytes using only URL-safe characters and no padding', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    const text = toB64url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(fromB64url(text))).toEqual(Array.from(bytes));
  });

  it('rejects characters outside the base64url alphabet', () => {
    expect(() => fromB64url('abc+/')).toThrow();
  });
});

describe('seal and unseal', () => {
  it('round-trips a message', async () => {
    const key = await importRoomKey(generateRoomKey());
    const sealed = await seal(key, utf8('hello'));
    expect(fromUtf8(await unseal(key, sealed))).toBe('hello');
  });

  it('uses a fresh IV for every message', async () => {
    const key = await importRoomKey(generateRoomKey());
    const a = await seal(key, utf8('same'));
    const b = await seal(key, utf8('same'));
    expect(toB64url(a)).not.toBe(toB64url(b));
  });

  it('fails with a different key', async () => {
    const sealed = await seal(await importRoomKey(generateRoomKey()), utf8('secret'));
    await expect(unseal(await importRoomKey(generateRoomKey()), sealed)).rejects.toThrow();
  });

  it('fails when a byte has been tampered with', async () => {
    const key = await importRoomKey(generateRoomKey());
    const sealed = await seal(key, utf8('secret'));
    sealed[sealed.length - 1] ^= 1;
    await expect(unseal(key, sealed)).rejects.toThrow();
  });

  it('refuses a room key that is not 32 bytes', async () => {
    await expect(importRoomKey(new Uint8Array(16))).rejects.toThrow();
  });
});

describe('signatures', () => {
  it('verifies text signed by the matching key', async () => {
    const signer = await signerFrom(await generateSigningKeys(false));
    const sig = await signText(signer, 'body');
    expect(await verifyText(signer.pub, 'body', sig)).toBe(true);
  });

  it('rejects changed text, another key, or a garbage signature or key', async () => {
    const signer = await signerFrom(await generateSigningKeys(false));
    const other = await signerFrom(await generateSigningKeys(false));
    const sig = await signText(signer, 'body');
    expect(await verifyText(signer.pub, 'b0dy', sig)).toBe(false);
    expect(await verifyText(other.pub, 'body', sig)).toBe(false);
    expect(await verifyText(signer.pub, 'body', 'not-a-signature')).toBe(false);
    expect(await verifyText('bm90LWEta2V5', 'body', sig)).toBe(false);
  });

  it('gives each public key a stable 22-character fingerprint', async () => {
    const a = await signerFrom(await generateSigningKeys(false));
    const b = await signerFrom(await generateSigningKeys(false));
    expect(await fingerprint(a.pub)).toBe(await fingerprint(a.pub));
    expect(await fingerprint(a.pub)).toHaveLength(22);
    expect(await fingerprint(a.pub)).not.toBe(await fingerprint(b.pub));
  });

  it('exports and re-imports an extractable key pair', async () => {
    const pair = await generateSigningKeys(true);
    const restored = await signerFrom(await importKeyPair(await exportKeyPair(pair)));
    const original = await signerFrom(pair);
    expect(restored.pub).toBe(original.pub);
    expect(await verifyText(original.pub, 'x', await signText(restored, 'x'))).toBe(true);
  });
});

describe('raw signatures', () => {
  it('signs bytes with a 64-byte signature that only the matching key verifies', async () => {
    const signer = await signerFrom(await generateSigningKeys(false));
    const other = await signerFrom(await generateSigningKeys(false));
    const sig = await signBytes(signer, utf8('body'));
    expect(sig).toHaveLength(64);
    expect(await verifyBytes(signer.pub, utf8('body'), sig)).toBe(true);
    expect(await verifyBytes(signer.pub, utf8('b0dy'), sig)).toBe(false);
    expect(await verifyBytes(other.pub, utf8('body'), sig)).toBe(false);
    expect(await verifyBytes('bm90LWEta2V5', utf8('body'), sig)).toBe(false);
  });
});
