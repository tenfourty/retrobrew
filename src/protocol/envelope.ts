import { seal, unseal } from '../crypto/aead';
import { concatBytes, fromUtf8, utf8, type Bytes } from '../crypto/bytes';
import { signText, verifyText, type Signer } from '../crypto/sign';
import { MAX_FRAME_BYTES } from '../transport/relay-frame';
import { deflate, inflate } from './compress';
import { PLAINTEXT_BUNDLE, PLAINTEXT_V1, PLAINTEXT_V2 } from './version';

export interface Envelope {
  v: 1;
  pub: string;
  body: string;
  sig: string;
}

// What a sealed frame holds once opened: a signed envelope (protocol 1 or 2), or the body of a relay bundle.
export type Frame =
  | { kind: 'envelope'; pv: 1 | 2; env: Envelope }
  | { kind: 'bundle'; body: Bytes };

function isEnvelope(x: unknown): x is Envelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return e.v === 1 && typeof e.pub === 'string' && typeof e.body === 'string' && typeof e.sig === 'string';
}

// We sign the exact body string we send, so no canonical JSON is needed.
export async function sealEnvelope(signer: Signer, message: unknown): Promise<Envelope> {
  const body = JSON.stringify(message);
  return { v: 1, pub: signer.pub, body, sig: await signText(signer, body) };
}

export async function openEnvelope(x: unknown): Promise<{ pub: string; message: unknown } | null> {
  if (!isEnvelope(x)) return null;
  if (!(await verifyText(x.pub, x.body, x.sig))) return null;
  try {
    return { pub: x.pub, message: JSON.parse(x.body) as unknown };
  } catch {
    return null;
  }
}

// Protocol 2 deflates the envelope behind a 0x02 byte. Protocol 1, used only for hellos and version replies,
// is the bare JSON, so a host or participant of any version can read it.
export async function encodeWire(roomKey: CryptoKey, env: Envelope, pv: 1 | 2 = 2): Promise<Bytes> {
  const json = utf8(JSON.stringify(env));
  if (pv === 1) return seal(roomKey, json);
  return seal(roomKey, concatBytes(Uint8Array.of(PLAINTEXT_V2), await deflate(json)));
}

export async function decodeFrame(roomKey: CryptoKey, data: Uint8Array): Promise<Frame | null> {
  // Checked before unsealing, whatever the path: an oversized frame costs nothing to drop.
  if (data.length > MAX_FRAME_BYTES) return null;
  let plain: Bytes;
  try {
    plain = await unseal(roomKey, new Uint8Array(data));
  } catch {
    return null;
  }
  try {
    switch (plain[0]) {
      case PLAINTEXT_BUNDLE: return { kind: 'bundle', body: plain.slice(1) };
      case PLAINTEXT_V2: return envelopeFrame(fromUtf8(await inflate(plain.slice(1))), 2);
      // Protocol 1 is plain JSON, never inflated, so its plaintext is capped like the frame (deflated protocol 2 is
      // capped by inflate's MAX_INFLATED).
      case PLAINTEXT_V1: return plain.length > MAX_FRAME_BYTES ? null : envelopeFrame(fromUtf8(plain), 1);
      default: return null;
    }
  } catch {
    return null;
  }
}

function envelopeFrame(json: string, pv: 1 | 2): Frame | null {
  const parsed: unknown = JSON.parse(json);
  return isEnvelope(parsed) ? { kind: 'envelope', pv, env: parsed } : null;
}

// The envelope in a frame of either protocol, for callers that don't care which.
export async function decodeWire(roomKey: CryptoKey, data: Uint8Array): Promise<Envelope | null> {
  const frame = await decodeFrame(roomKey, data);
  return frame?.kind === 'envelope' ? frame.env : null;
}
