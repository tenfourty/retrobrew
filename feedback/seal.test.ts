import { describe, expect, it } from 'vitest';
import { makeKeyPair } from './harness.ts';
import { openRecord, QuarantineError } from './open.ts';
import { createSealer, type SealedRecord } from './seal.ts';

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

async function sealed(kid = 'k1') {
  const reader = await makeKeyPair();
  const sealer = await createSealer(kid, reader.publicRaw);
  const record = await sealer.seal(text('{"hello":"world"}'));
  return { reader, record, keys: new Map([[kid, reader.privateKey]]) as ReadonlyMap<string, CryptoKey> };
}

describe('sealing', () => {
  it('round-trips with the reader key and holds no plaintext', async () => {
    const { record, keys } = await sealed();
    expect(record).not.toContain('hello');
    expect(Buffer.from(record).toString('latin1')).not.toContain('world');
    expect(new TextDecoder().decode(await openRecord(record, keys))).toBe('{"hello":"world"}');
  });

  it('does not open without the right private key', async () => {
    const { record } = await sealed();
    const other = await makeKeyPair();
    await expect(openRecord(record, new Map([['k1', other.privateKey]]))).rejects.toBeInstanceOf(QuarantineError);
  });

  it('quarantines a record whose key id the reader does not hold', async () => {
    const { record, reader } = await sealed('k1');
    await expect(openRecord(record, new Map([['k2', reader.privateKey]]))).rejects.toBeInstanceOf(QuarantineError);
  });

  it('cannot be re-labelled to another key id (the id is in the authenticated data)', async () => {
    const { record, reader } = await sealed('k1');
    const forged = JSON.stringify({ ...(JSON.parse(record) as SealedRecord), kid: 'k2' });
    await expect(openRecord(forged, new Map([['k2', reader.privateKey]]))).rejects.toBeInstanceOf(QuarantineError);
  });

  it('fails on a tampered ciphertext, iv or ephemeral key', async () => {
    const { record, keys } = await sealed();
    const parsed = JSON.parse(record) as SealedRecord;
    const flip = (value: string): string => (value[0] === 'A' ? 'B' : 'A') + value.slice(1);
    for (const field of ['ct', 'iv', 'epk'] as const) {
      await expect(openRecord(JSON.stringify({ ...parsed, [field]: flip(parsed[field]) }), keys)).rejects.toBeInstanceOf(QuarantineError);
    }
  });

  it('uses a fresh ephemeral key and iv every time', async () => {
    const reader = await makeKeyPair();
    const sealer = await createSealer('k1', reader.publicRaw);
    const a = JSON.parse(await sealer.seal(text('same'))) as SealedRecord;
    const b = JSON.parse(await sealer.seal(text('same'))) as SealedRecord;
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('rotates: an old record opens with the old key while new ones use the new key id', async () => {
    const oldReader = await makeKeyPair();
    const newReader = await makeKeyPair();
    const oldRecord = await (await createSealer('k1', oldReader.publicRaw)).seal(text('old'));
    const newRecord = await (await createSealer('k2', newReader.publicRaw)).seal(text('new'));
    const keys = new Map([['k1', oldReader.privateKey], ['k2', newReader.privateKey]]);
    expect(new TextDecoder().decode(await openRecord(oldRecord, keys))).toBe('old');
    expect(new TextDecoder().decode(await openRecord(newRecord, keys))).toBe('new');
    keys.delete('k1');
    await expect(openRecord(oldRecord, keys)).rejects.toBeInstanceOf(QuarantineError);
  });

  it('refuses a public key that is not a P-256 point', async () => {
    await expect(createSealer('k1', new Uint8Array(65).fill(4))).rejects.toThrow();
  });
});
