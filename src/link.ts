import { fromB64url, toB64url, utf8, type Bytes } from './crypto/bytes';
import { sha256, toHex } from './crypto/hash';

export interface ShareLink {
  boardId: string;
  roomKey: Bytes;
  hostPub: string;
}

const BOARD_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function newBoardId(): string {
  return toB64url(crypto.getRandomValues(new Uint8Array(16)));
}

export function buildShareLink(base: string, link: ShareLink): string {
  const url = new URL(base);
  url.search = '';
  url.hash = new URLSearchParams({ b: link.boardId, k: toB64url(link.roomKey), h: link.hostPub }).toString();
  return url.toString();
}

export function parseShareLink(hash: string): ShareLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const boardId = params.get('b');
  const key = params.get('k');
  const hostPub = params.get('h');
  if (!boardId || !key || !hostPub || !BOARD_ID.test(boardId)) return null;
  try {
    const roomKey = fromB64url(key);
    if (roomKey.length !== 32 || fromB64url(hostPub).length !== 65) return null;
    return { boardId, roomKey, hostPub };
  } catch {
    return null;
  }
}

// The app's own links that open the home page rather than a meeting: #start and #start&….
export function isStartLink(hash: string): boolean {
  return /^#?start(&|$)/.test(hash);
}

// /app/#start&rehearsal creates a rehearsal board, where a timebox minute lasts 10 seconds. Only this link leads there.
export function isRehearsalLink(hash: string): boolean {
  return isStartLink(hash) && hash.replace(/^#/, '').split('&').includes('rehearsal');
}

// Relays and signalling see only this hash, never the key itself.
export async function roomIdFor(roomKey: Bytes, purpose: 'webrtc' | 'relay'): Promise<string> {
  const label = utf8(`retrobrew:${purpose}:`);
  const input = new Uint8Array(label.length + roomKey.length);
  input.set(label);
  input.set(roomKey, label.length);
  return toHex((await sha256(input)).slice(0, 16));
}
