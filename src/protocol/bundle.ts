import { seal, unseal } from '../crypto/aead';
import { concatBytes, fromUtf8, toB64url, utf8, type Bytes } from '../crypto/bytes';
import { sha256 } from '../crypto/hash';
import { signBytes, verifyBytes, type Signer } from '../crypto/sign';
import { deflate, inflate } from './compress';
import { openEnvelope, sealEnvelope } from './envelope';
import { PLAINTEXT_BUNDLE, PLAINTEXT_ITEM } from './version';

const SIG_BYTES = 64;
// Domain separation: an item's signature covers this label and the body, so it is never also a valid envelope signature.
const ITEM_LABEL = utf8('rb/personal\0');
const MAX_ITEM_BYTES = 0xffff;
// A sealed item's bytes beyond its deflated body: IV, GCM tag, the 0x04 marker and the raw signature.
export const ITEM_OVERHEAD = 12 + 16 + 1 + SIG_BYTES;
// The IV and GCM tag that sealing adds to any plaintext.
export const SEAL_OVERHEAD = 12 + 16;

// The outer, signed message of a relay bundle (docs/product/sync-protocol.md, The relay bundle).
export interface BundleMessage<Shared = unknown> {
  t: 'bundle';
  epoch: number;
  seq: number;
  refreshSeq: number;
  hostNow: number;
  host: string;
  boardId: string;
  shared: Shared;
  items: number;
  itemsHash: string;
}

export type BundleFields<Shared> = Omit<BundleMessage<Shared>, 't' | 'items' | 'itemsHash'>;

const u16 = (n: number): Bytes => Uint8Array.of(n >>> 8, n & 0xff);
const u32 = (n: number): Bytes => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

// The sealed wire bytes of one bundle: 0x03, the outer envelope's length and deflated JSON, then the items.
// itemsHash in the signed outer message covers every item, so nobody can swap, add or drop one.
export async function encodeBundle<Shared>(
  signer: Signer, roomKey: CryptoKey, fields: BundleFields<Shared>, personals: ReadonlyArray<{ you: string }>,
): Promise<Bytes> {
  const items = await Promise.all(personals.map((personal) => sealItem(signer, roomKey, personal)));
  const section = concatBytes(...items.flatMap((item) => [u16(item.length), item]));
  const message: BundleMessage<Shared> = { t: 'bundle', ...fields, items: items.length, itemsHash: toB64url(await sha256(section)) };
  const outer = await deflate(utf8(JSON.stringify(await sealEnvelope(signer, message))));
  return seal(roomKey, concatBytes(Uint8Array.of(PLAINTEXT_BUNDLE), u32(outer.length), outer, section));
}

// The sealed bytes of a bundle, from the deflated length of its outer envelope and of each item's body, without
// building it: the marker, the outer's 4-byte length, the outer, then each item behind its 2-byte length, sealed.
// encodeBundle's real output has exactly this length (size.test.ts checks).
export function bundleWireBytes(outerDeflated: number, itemBodiesDeflated: readonly number[]): number {
  const items = itemBodiesDeflated.reduce((sum, deflated) => sum + 2 + ITEM_OVERHEAD + deflated, 0);
  return SEAL_OVERHEAD + 1 + 4 + outerDeflated + items;
}

async function sealItem(signer: Signer, roomKey: CryptoKey, personal: unknown): Promise<Bytes> {
  if (!isRecord(personal) || personal.t !== 'personal') throw new Error('A bundle item must be a personal message');
  const body = utf8(JSON.stringify(personal));
  const item = await seal(roomKey, concatBytes(Uint8Array.of(PLAINTEXT_ITEM), await signBytes(signer, concatBytes(ITEM_LABEL, body)), await deflate(body)));
  if (item.length > MAX_ITEM_BYTES) throw new Error('A personal entry is too large for a bundle');
  return item;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

function parseBundleMessage(x: unknown): BundleMessage | null {
  if (!isRecord(x) || x.t !== 'bundle') return null;
  const { epoch, seq, refreshSeq, hostNow, host, boardId, shared, items, itemsHash } = x;
  if (!isCount(epoch) || !isCount(seq) || !isCount(refreshSeq) || !isCount(hostNow) || !isCount(items)) return null;
  if (typeof host !== 'string' || typeof boardId !== 'string' || typeof itemsHash !== 'string' || !isRecord(shared)) return null;
  return { t: 'bundle', epoch, seq, refreshSeq, hostNow, host, boardId, shared, items: items as number, itemsHash };
}

function splitItems(section: Bytes): Bytes[] | null {
  const items: Bytes[] = [];
  let at = 0;
  while (at < section.length) {
    if (at + 2 > section.length) return null;
    const length = (section[at] << 8) | section[at + 1];
    at += 2;
    if (at + length > section.length) return null;
    items.push(section.slice(at, at + length));
    at += length;
  }
  return items;
}

// Reads a bundle body (the plaintext after its 0x03 byte). Returns null unless the host signed it and
// itemsHash matches the items exactly.
export async function openBundle(body: Bytes, hostPub: string): Promise<{ message: BundleMessage; items: Bytes[] } | null> {
  try {
    if (body.length < 4) return null;
    const outerEnd = 4 + new DataView(body.buffer, body.byteOffset).getUint32(0);
    if (outerEnd > body.length) return null;
    const opened = await openEnvelope(JSON.parse(fromUtf8(await inflate(body.slice(4, outerEnd)))) as unknown);
    if (!opened || opened.pub !== hostPub) return null;
    const message = parseBundleMessage(opened.message);
    const section = body.slice(outerEnd);
    if (!message || toB64url(await sha256(section)) !== message.itemsHash) return null;
    const items = splitItems(section);
    return items && items.length === message.items ? { message, items } : null;
  } catch {
    return null;
  }
}

// Opens one item. Returns its personal message only if it names `you`, carries the bundle's host, epoch and seq,
// and the host's key signed it. The binding stops a stale item being replayed into a newer bundle.
// Items for other people are skipped before the signature check, so a participant verifies one item per bundle.
export async function openItem(
  roomKey: CryptoKey, hostPub: string, item: Bytes, you: string,
  bundle: { host: string; epoch: number; seq: number },
): Promise<Record<string, unknown> | null> {
  try {
    const plain = await unseal(roomKey, item);
    if (plain[0] !== PLAINTEXT_ITEM || plain.length <= 1 + SIG_BYTES) return null;
    const body = await inflate(plain.slice(1 + SIG_BYTES));
    const message: unknown = JSON.parse(fromUtf8(body));
    if (!isRecord(message) || message.t !== 'personal' || message.you !== you) return null;
    if (message.host !== bundle.host || message.epoch !== bundle.epoch || message.seq !== bundle.seq) return null;
    return (await verifyBytes(hostPub, concatBytes(ITEM_LABEL, body), plain.slice(1, 1 + SIG_BYTES))) ? message : null;
  } catch {
    return null;
  }
}
