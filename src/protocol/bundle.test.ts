import { describe, expect, it } from 'vitest';
import { generateRoomKey, importRoomKey, unseal } from '../crypto/aead';
import { concatBytes, fromUtf8, toB64url, utf8, type Bytes } from '../crypto/bytes';
import { generateSigningKeys, signerFrom, signText, verifyText, verifyBytes } from '../crypto/sign';
import { encodeBundle, ITEM_OVERHEAD, openBundle, openItem, type BundleFields } from './bundle';
import { deflate, inflate } from './compress';
import { decodeFrame } from './envelope';

const newSigner = async () => signerFrom(await generateSigningKeys(false));
const fields: BundleFields<{ boardName: string }> = {
  epoch: 5, seq: 9, refreshSeq: 9, hostNow: 1000, host: 'peer-h', boardId: 'b1', shared: { boardName: 'Team' },
};
const ann = { t: 'personal', host: 'peer-h', epoch: 5, seq: 9, you: 'ann-person-id', mine: { 1: 2 } };
const bob = { t: 'personal', host: 'peer-h', epoch: 5, seq: 9, you: 'bob-person-id', mine: {} };

async function bodyOf(roomKey: CryptoKey, wire: Bytes): Promise<Bytes> {
  const frame = await decodeFrame(roomKey, wire);
  if (frame?.kind !== 'bundle') throw new Error('not a bundle');
  return frame.body;
}

describe('relay bundles', () => {
  it('round-trips the outer message and gives each person only their own item', async () => {
    const host = await newSigner();
    const roomKey = await importRoomKey(generateRoomKey());
    const opened = await openBundle(await bodyOf(roomKey, await encodeBundle(host, roomKey, fields, [ann, bob])), host.pub);
    expect(opened!.message).toMatchObject({ t: 'bundle', ...fields, items: 2 });
    const forBob = await Promise.all(opened!.items.map((item) => openItem(roomKey, host.pub, item, 'bob-person-id', opened!.message)));
    expect(forBob.filter(Boolean)).toEqual([bob]);
  });

  it('rejects a bundle signed by any key but the host’s', async () => {
    const roomKey = await importRoomKey(generateRoomKey());
    const body = await bodyOf(roomKey, await encodeBundle(await newSigner(), roomKey, fields, [ann]));
    expect(await openBundle(body, (await newSigner()).pub)).toBeNull();
  });

  it('rejects a bundle whose items were swapped, added or dropped', async () => {
    const host = await newSigner();
    const roomKey = await importRoomKey(generateRoomKey());
    const a = await bodyOf(roomKey, await encodeBundle(host, roomKey, fields, [ann]));
    const b = await bodyOf(roomKey, await encodeBundle(host, roomKey, fields, [bob]));
    const outerEnd = (body: Bytes) => 4 + new DataView(body.buffer, body.byteOffset).getUint32(0);
    const swapped = concatBytes(a.slice(0, outerEnd(a)), b.slice(outerEnd(b)));
    const added = concatBytes(a, b.slice(outerEnd(b)));
    const dropped = a.slice(0, outerEnd(a));
    for (const body of [swapped, added, dropped]) expect(await openBundle(body, host.pub)).toBeNull();
    expect(await openBundle(a.slice(0, 3), host.pub)).toBeNull();
  });

  it('opens an item only for its own recipient, and only if the host signed it', async () => {
    const host = await newSigner();
    const forger = await newSigner();
    const roomKey = await importRoomKey(generateRoomKey());
    const forged = (await openBundle(await bodyOf(roomKey, await encodeBundle(forger, roomKey, fields, [ann])), forger.pub))!;
    expect(await openItem(roomKey, host.pub, forged.items[0], 'ann-person-id', forged.message)).toBeNull();
    const real = (await openBundle(await bodyOf(roomKey, await encodeBundle(host, roomKey, fields, [ann])), host.pub))!;
    expect(await openItem(roomKey, host.pub, real.items[0], 'bob-person-id', real.message)).toBeNull();
    expect(await openItem(roomKey, host.pub, real.items[0], 'ann-person-id', real.message)).toEqual(ann);
  });

  it('names no recipient outside the item seals', async () => {
    const host = await newSigner();
    const roomKey = await importRoomKey(generateRoomKey());
    const body = await bodyOf(roomKey, await encodeBundle(host, roomKey, fields, [ann, bob]));
    const outerLength = new DataView(body.buffer, body.byteOffset).getUint32(0);
    const outer = fromUtf8(await inflate(body.slice(4, 4 + outerLength)));
    expect(outer).not.toContain('ann-person-id');
    expect(outer).not.toContain('bob-person-id');
    expect(fromUtf8(body)).not.toContain('person-id');
  });

  it('stores each item as raw bytes: seal overhead, marker, raw signature and deflated body, no base64', async () => {
    const host = await newSigner();
    const roomKey = await importRoomKey(generateRoomKey());
    const opened = (await openBundle(await bodyOf(roomKey, await encodeBundle(host, roomKey, fields, [ann])), host.pub))!;
    const deflated = await deflate(utf8(JSON.stringify(ann)));
    expect(opened.items[0]).toHaveLength(ITEM_OVERHEAD + deflated.length);
    expect((await unseal(roomKey, opened.items[0]))[0]).toBe(0x04);
  });

  it('refuses an item taken from a bundle with a different seq, epoch or host', async () => {
    const host = await newSigner();
    const roomKey = await importRoomKey(generateRoomKey());
    const open = async (f: BundleFields<{ boardName: string }>, p: Array<Record<string, unknown> & { you: string }>) =>
      (await openBundle(await bodyOf(roomKey, await encodeBundle(host, roomKey, f, p)), host.pub))!;
    const old = await open({ ...fields, seq: 8 }, [{ ...ann, seq: 8 }]);
    const current = await open(fields, [ann]);
    expect(await openItem(roomKey, host.pub, old.items[0], 'ann-person-id', current.message)).toBeNull();
    const otherEpoch = await open({ ...fields, epoch: 4 }, [{ ...ann, epoch: 4 }]);
    expect(await openItem(roomKey, host.pub, otherEpoch.items[0], 'ann-person-id', current.message)).toBeNull();
    const otherHost = await open({ ...fields, host: 'peer-x' }, [{ ...ann, host: 'peer-x' }]);
    expect(await openItem(roomKey, host.pub, otherHost.items[0], 'ann-person-id', current.message)).toBeNull();
    expect(await openItem(roomKey, host.pub, current.items[0], 'ann-person-id', current.message)).toEqual(ann);
  });

  it('signs items under a label, so an item signature is not a plain signature over the body', async () => {
    const host = await newSigner();
    const roomKey = await importRoomKey(generateRoomKey());
    const opened = (await openBundle(await bodyOf(roomKey, await encodeBundle(host, roomKey, fields, [ann])), host.pub))!;
    const plain = await unseal(roomKey, opened.items[0]);
    const sig = plain.slice(1, 65);
    const json = JSON.stringify(ann);
    expect(await verifyBytes(host.pub, utf8(json), sig)).toBe(false);
    expect(await verifyBytes(host.pub, utf8(`rb/personal\0${json}`), sig)).toBe(true);
    expect(await verifyText(host.pub, json, toB64url(sig))).toBe(false);
    expect(await signText(host, json)).not.toBe(toB64url(sig));
  });

  it('requires strict non-negative integers in the outer message and a personal tag on items', async () => {
    const host = await newSigner();
    const roomKey = await importRoomKey(generateRoomKey());
    for (const bad of [{ seq: -1 }, { epoch: 1.5 }, { refreshSeq: 2 ** 53 }, { hostNow: Number.NaN }]) {
      const body = await bodyOf(roomKey, await encodeBundle(host, roomKey, { ...fields, ...bad }, [ann]));
      expect(await openBundle(body, host.pub)).toBeNull();
    }
    await expect(encodeBundle(host, roomKey, fields, [{ you: 'x' }])).rejects.toThrow();
    await expect(encodeBundle(host, roomKey, fields, [{ ...ann, t: 'other' } as { you: string }])).rejects.toThrow();
  });
});
