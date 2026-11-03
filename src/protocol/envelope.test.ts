import { describe, expect, it } from 'vitest';
import { generateRoomKey, importRoomKey, seal, unseal } from '../crypto/aead';
import { fromUtf8 } from '../crypto/bytes';
import { generateSigningKeys, signerFrom } from '../crypto/sign';
import { MAX_FRAME_BYTES } from '../transport/relay-frame';
import { decodeFrame, decodeWire, encodeWire, openEnvelope, sealEnvelope } from './envelope';

const newSigner = async () => signerFrom(await generateSigningKeys(false));

describe('envelopes', () => {
  it('opens an envelope signed by its own key', async () => {
    const signer = await newSigner();
    const opened = await openEnvelope(await sealEnvelope(signer, { t: 'hello', name: 'Ann' }));
    expect(opened).toEqual({ pub: signer.pub, message: { t: 'hello', name: 'Ann' } });
  });

  it('rejects a changed body or a swapped public key', async () => {
    const signer = await newSigner();
    const env = await sealEnvelope(signer, { n: 1 });
    expect(await openEnvelope({ ...env, body: '{"n":2}' })).toBeNull();
    expect(await openEnvelope({ ...env, pub: (await newSigner()).pub })).toBeNull();
  });

  it('rejects things that are not envelopes', async () => {
    expect(await openEnvelope(null)).toBeNull();
    expect(await openEnvelope('text')).toBeNull();
    expect(await openEnvelope({ v: 2, pub: 'a', body: 'b', sig: 'c' })).toBeNull();
  });
});

describe('wire encoding', () => {
  it('round-trips with the room key and hides the plaintext', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const env = await sealEnvelope(await newSigner(), { secret: 'topic text' });
    const wire = await encodeWire(roomKey, env);
    expect(fromUtf8(wire)).not.toContain('topic text');
    expect(await decodeWire(roomKey, wire)).toEqual(env);
  });

  it('returns null for another room key or garbage', async () => {
    const env = await sealEnvelope(await newSigner(), {});
    const wire = await encodeWire(await importRoomKey(generateRoomKey()), env);
    const other = await importRoomKey(generateRoomKey());
    expect(await decodeWire(other, wire)).toBeNull();
    expect(await decodeWire(other, new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('protocol layouts', () => {
  it('writes protocol 2 as 0x02 followed by deflated JSON', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const env = await sealEnvelope(await newSigner(), { text: 'same words '.repeat(200) });
    const wire = await encodeWire(roomKey, env);
    const plain = await unseal(roomKey, wire);
    expect(plain[0]).toBe(0x02);
    expect(plain.length).toBeLessThan(JSON.stringify(env).length / 4);
    expect(await decodeFrame(roomKey, wire)).toEqual({ kind: 'envelope', pv: 2, env });
    expect(await decodeWire(roomKey, wire)).toEqual(env);
  });

  it('writes protocol 1 as bare JSON, which a host of any version can read', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const env = await sealEnvelope(await newSigner(), { t: 'hello', name: 'Ann' });
    const wire = await encodeWire(roomKey, env, 1);
    const plain = await unseal(roomKey, wire);
    expect(plain[0]).toBe(0x7b);
    expect(JSON.parse(fromUtf8(plain))).toEqual(env);
    expect(await decodeFrame(roomKey, wire)).toEqual({ kind: 'envelope', pv: 1, env });
  });

  it('hands over a 0x03 plaintext as a bundle body', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    expect(await decodeFrame(roomKey, await seal(roomKey, Uint8Array.of(0x03, 7, 8))))
      .toEqual({ kind: 'bundle', body: Uint8Array.of(7, 8) });
    expect(await decodeWire(roomKey, await seal(roomKey, Uint8Array.of(0x03, 7, 8)))).toBeNull();
  });

  it('drops any other first byte, an empty plaintext and a 0x02 frame that does not inflate', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    expect(await decodeFrame(roomKey, await seal(roomKey, Uint8Array.of(0x05, 1)))).toBeNull();
    expect(await decodeFrame(roomKey, await seal(roomKey, new Uint8Array(0)))).toBeNull();
    expect(await decodeFrame(roomKey, await seal(roomKey, Uint8Array.of(0x02, 1, 2, 3)))).toBeNull();
  });
});

describe('the frame cap', () => {
  it('drops a frame over MAX_FRAME_BYTES before unsealing it, on any path', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const env = await sealEnvelope(await newSigner(), { t: 'hello', name: 'x'.repeat(MAX_FRAME_BYTES) });
    const big = await encodeWire(roomKey, env, 1);
    expect(big.length).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(await decodeFrame(roomKey, big)).toBeNull();
    const small = await encodeWire(roomKey, await sealEnvelope(await newSigner(), { t: 'hello', name: 'Ann' }), 1);
    expect(await decodeFrame(roomKey, small)).toMatchObject({ kind: 'envelope', pv: 1 });
  });
});
